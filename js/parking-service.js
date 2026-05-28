/**
 * 停車場搜尋服務
 * 串接台北市 + 新北市即時資料 API（免認證）
 * 其他城市透過 TDX API（Cloudflare Worker 代理）
 */
const ParkingService = {
  // 台北市直連 API（免認證）
  TAIPEI_DESC_URL: 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json',
  TAIPEI_AVAIL_URL: 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json',

  // 新北市 API（透過代理，因 data.ntpc.gov.tw 不允許跨域）
  NTPC_DESC_URL: '',
  NTPC_AVAIL_URL: '',

  // TDX API URL（透過合併後的 Worker 代理）
  TDX_API_URL: '',

  // Cloudflare Worker 代理 URL（部署後使用）
  CF_WORKER_URL: 'https://parknow.kiwi-lu1130.workers.dev',

  // 搜尋半徑（公尺）
  SEARCH_RADIUS: 5000,

  // 大台北直連城市（這些城市有獨立免認證 API）
  METRO_CITIES: ['Taipei', 'NewTaipei'],

  /**
   * 初始化：根據環境自動設定 API URL
   */
  init() {
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (isLocal) {
      this.NTPC_DESC_URL = '/api/ntpc/desc';
      this.NTPC_AVAIL_URL = '/api/ntpc/avail';
      this.TDX_API_URL = '/api/parking';
    } else {
      this.NTPC_DESC_URL = this.CF_WORKER_URL + '/api/ntpc/desc';
      this.NTPC_AVAIL_URL = this.CF_WORKER_URL + '/api/ntpc/avail';
      this.TDX_API_URL = this.CF_WORKER_URL + '/api/parking';
    }
    console.log('[ParkingService] 環境:', isLocal ? '本地' : '部署',
      '| NTPC:', this.NTPC_DESC_URL, '| TDX:', this.TDX_API_URL);
  },

  /**
   * 搜尋附近停車場（全台灣 23 縣市）
   * - 台北/新北：直連 API（快速、免認證）+ 平行 TDX 去重
   * - 其他城市：TDX API
   */
  async searchNearby(lat, lng, city) {
    const isMetro = this.METRO_CITIES.includes(city);

    if (isMetro) {
      // 大台北：直連 API 為主
      const [taipeiResults, ntpcResults] = await Promise.all([
        this.searchTaipei(lat, lng).catch(() => []),
        this.searchNTPC(lat, lng).catch(() => [])
      ]);

      let merged = [...taipeiResults, ...ntpcResults];

      // 如果 TDX 可用，也平行搜尋 TDX 補充資料
      if (this.TDX_API_URL) {
        const tdxResults = await this.searchTDX(lat, lng, city).catch(() => []);
        if (tdxResults.length > 0) {
          merged = this._dedup([...merged, ...tdxResults]);
        }
      }

      console.log('[ParkingService] 大台北合併結果:', merged.length);
      merged.sort((a, b) => a.distance - b.distance);
      return merged.slice(0, 30);
    }

    // 非大台北：TDX API
    if (this.TDX_API_URL) {
      const tdxResults = await this.searchTDX(lat, lng, city);
      return tdxResults;
    }

    // TDX 未設定
    console.warn('[ParkingService] 非大台北地區且 TDX 未設定，無法搜尋');
    return [];
  },

  /**
   * 台北市停車場搜尋（直連，免認證）
   */
  async searchTaipei(lat, lng) {
    console.log('[DEBUG] searchTaipei 開始');

    const [descRes, availRes] = await Promise.all([
      fetch(this.TAIPEI_DESC_URL),
      fetch(this.TAIPEI_AVAIL_URL)
    ]);

    const descData = await descRes.json();
    const availData = await availRes.json();

    // 建立即時空位 lookup map
    const availMap = {};
    if (availData.data && availData.data.park) {
      availData.data.park.forEach((item) => {
        availMap[item.id] = parseInt(item.availablecar) || 0;
      });
    }
    console.log('[DEBUG] 台北 availMap:', Object.keys(availMap).length);

    const parks = descData.data && descData.data.park ? descData.data.park : [];
    return this._filterParks(parks, availMap, lat, lng, 'taipei');
  },

  /**
   * 新北市停車場搜尋（直連，免認證）
   */
  async searchNTPC(lat, lng) {
    console.log('[DEBUG] searchNTPC 開始');

    // 新北市 API 有分頁，需取 2 頁（共約 1512 筆）
    const [descP0, descP1, availP0, availP1] = await Promise.all([
      fetch(`${this.NTPC_DESC_URL}?page=0&size=1000`).then(r => r.json()),
      fetch(`${this.NTPC_DESC_URL}?page=1&size=1000`).then(r => r.json()),
      fetch(`${this.NTPC_AVAIL_URL}?page=0&size=1000`).then(r => r.json()),
      fetch(`${this.NTPC_AVAIL_URL}?page=1&size=1000`).then(r => r.json()),
    ]);

    const descParks = [...descP0, ...descP1];
    const availArr = [...availP0, ...availP1];

    // 建立即時空位 lookup map
    const availMap = {};
    availArr.forEach((item) => {
      availMap[item.ID] = parseInt(item.AVAILABLECAR) || 0;
    });
    console.log('[DEBUG] 新北 desc:', descParks.length, ', availMap:', Object.keys(availMap).length);

    // 轉換為統一格式再過濾
    const normalizedParks = descParks.map(p => ({
      id: p.ID,
      name: p.NAME,
      address: p.ADDRESS || '',
      tw97x: p.TW97X,
      tw97y: p.TW97Y,
      totalcar: p.TOTALCAR,
      payex: p.PAYEX || '',
      type: p.TYPE || ''
    }));

    return this._filterParks(normalizedParks, availMap, lat, lng, 'ntpc');
  },

  /**
   * TDX API 搜尋（透過 Cloudflare Worker 代理）
   * Worker 端處理認證、過濾、排序，回傳統一格式
   */
  async searchTDX(lat, lng, city) {
    try {
      const url = `${this.TDX_API_URL}/${city}?lat=${lat}&lng=${lng}&radius=${this.SEARCH_RADIUS}`;
      console.log('[DEBUG] searchTDX:', url);

      const response = await fetch(url);

      if (response.status === 503) {
        console.warn('[ParkingService] TDX credentials 未設定');
        return [];
      }
      if (!response.ok) {
        throw new Error(`TDX API error: ${response.status}`);
      }

      const data = await response.json();
      if (data.error) {
        console.warn('[ParkingService] TDX error:', data.error);
        return [];
      }

      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.error('[ParkingService] TDX API 錯誤:', error);
      return [];
    }
  },

  /**
   * 統一過濾邏輯：座標轉換 → 距離過濾 → 空位過濾
   * @param {Array} parks - 停車場陣列
   * @param {Object} availMap - id → 空位數
   * @param {number} lat - 使用者緯度
   * @param {number} lng - 使用者經度
   * @param {string} source - 'taipei' | 'ntpc'
   */
  _filterParks(parks, availMap, lat, lng, source) {
    const results = [];
    let noCoord = 0, tooFar = 0, noAvail = 0;

    for (const park of parks) {
      let parkLat = 0, parkLng = 0;

      // 台北市：優先 EntranceCoord (WGS84)，否則 TWD97
      if (source === 'taipei') {
        const entrance = park.EntranceCoord?.EntrancecoordInfo;
        if (entrance && entrance.length > 0 && entrance[0].Xcod && entrance[0].Ycod) {
          parkLat = parseFloat(entrance[0].Xcod);
          parkLng = parseFloat(entrance[0].Ycod);
        }
      }

      // TWD97 轉 WGS84（台北 fallback + 新北全部）
      if (!parkLat && park.tw97x && park.tw97y) {
        const tw97x = parseFloat(park.tw97x);
        const tw97y = parseFloat(park.tw97y);
        if (tw97x > 0 && tw97y > 0) {
          const converted = this.twd97ToWgs84(tw97x, tw97y);
          parkLat = converted.lat;
          parkLng = converted.lng;
        }
      }

      if (!parkLat || !parkLng) { noCoord++; continue; }

      const distance = LocationService.calculateDistance(lat, lng, parkLat, parkLng);
      if (distance > this.SEARCH_RADIUS) { tooFar++; continue; }

      // 取得即時空位
      const available = availMap[park.id] || 0;
      if (available <= 0) { noAvail++; continue; }

      results.push({
        id: park.id,
        name: park.name || '停車場',
        address: park.address || '',
        lat: parkLat,
        lng: parkLng,
        distance: distance,
        available: available,
        total: parseInt(park.totalcar) || 0,
        fee: park.payex || '',
        type: park.type || '',
        source: source
      });
    }

    console.log(`[DEBUG] ${source} 過濾: 無座標=${noCoord}, 超出範圍=${tooFar}, 無空位=${noAvail}, 結果=${results.length}`);
    return results;
  },

  /**
   * 去重：以 id 為主鍵，直連 API 優先於 TDX
   * 避免大台北地區同時搜尋直連 + TDX 時出現重複
   */
  _dedup(parks) {
    const seen = new Map();
    for (const park of parks) {
      const key = park.id || `${park.lat}_${park.lng}`;
      if (!seen.has(key)) {
        seen.set(key, park);
      }
      // 已存在則跳過（先加入的直連資料優先）
    }
    return Array.from(seen.values());
  },

  /**
   * TWD97 (TM2) 轉 WGS84 經緯度
   */
  twd97ToWgs84(x, y) {
    const a = 6378137.0;
    const b = 6356752.3142;
    const lng0 = 121 * Math.PI / 180;
    const k0 = 0.9999;
    const dx = 250000;

    const e = Math.sqrt(1 - (b * b) / (a * a));
    const e2 = e * e / (1 - e * e);

    x -= dx;

    const M = y / k0;
    const mu = M / (a * (1 - e * e / 4 - 3 * e * e * e * e / 64 - 5 * e * e * e * e * e * e / 256));
    const e1 = (1 - Math.sqrt(1 - e * e)) / (1 + Math.sqrt(1 - e * e));

    const J1 = 3 * e1 / 2 - 27 * e1 * e1 * e1 / 32;
    const J2 = 21 * e1 * e1 / 16 - 55 * e1 * e1 * e1 * e1 / 32;
    const J3 = 151 * e1 * e1 * e1 / 96;
    const J4 = 1097 * e1 * e1 * e1 * e1 / 512;

    const fp = mu + J1 * Math.sin(2 * mu) + J2 * Math.sin(4 * mu) + J3 * Math.sin(6 * mu) + J4 * Math.sin(8 * mu);

    const C1 = e2 * Math.cos(fp) * Math.cos(fp);
    const T1 = Math.tan(fp) * Math.tan(fp);
    const R1 = a * (1 - e * e) / Math.pow(1 - e * e * Math.sin(fp) * Math.sin(fp), 1.5);
    const N1 = a / Math.sqrt(1 - e * e * Math.sin(fp) * Math.sin(fp));
    const D = x / (N1 * k0);

    const lat = fp - (N1 * Math.tan(fp) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * e2) * D * D * D * D / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * e2 - 3 * C1 * C1) * D * D * D * D * D * D / 720);
    const lng = lng0 + (D - (1 + 2 * T1 + C1) * D * D * D / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * e2 + 24 * T1 * T1) * D * D * D * D * D / 120) / Math.cos(fp);

    return {
      lat: lat * 180 / Math.PI,
      lng: lng * 180 / Math.PI
    };
  },

  getAvailabilityLevel(available) {
    if (available >= 20) return 'high';
    if (available >= 5) return 'medium';
    return 'low';
  },

  getAvailabilityText(available) {
    if (available >= 20) return `${available} 位 (充足)`;
    if (available >= 5) return `${available} 位 (少量)`;
    return `${available} 位 (快滿)`;
  }
};
