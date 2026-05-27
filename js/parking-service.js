/**
 * 停車場搜尋服務
 * 串接台北市 + 新北市即時資料 API（免認證）
 * 其他城市可透過 TDX API（Cloudflare Worker 代理）
 */
const ParkingService = {
  // TDX API proxy URL (Cloudflare Worker) - Phase 2 再啟用
  TDX_PROXY_URL: '',

  // 台北市直連 API（免認證）
  TAIPEI_DESC_URL: 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json',
  TAIPEI_AVAIL_URL: 'https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_allavailable.json',

  // 新北市 API（透過代理，因 data.ntpc.gov.tw 不允許跨域）
  // 自動判斷：localhost 用本地代理，部署後用 Cloudflare Worker
  NTPC_PROXY_BASE: '',  // 初始化時設定
  NTPC_DESC_URL: '',
  NTPC_AVAIL_URL: '',

  // Cloudflare Worker 代理 URL（部署後使用）
  CF_WORKER_URL: 'https://parknow-proxy.morrislu.workers.dev',

  // 搜尋半徑（公尺）
  SEARCH_RADIUS: 5000,

  /**
   * 初始化：根據環境自動設定 API URL
   */
  init() {
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (isLocal) {
      this.NTPC_DESC_URL = '/api/ntpc/desc';
      this.NTPC_AVAIL_URL = '/api/ntpc/avail';
    } else {
      this.NTPC_DESC_URL = this.CF_WORKER_URL + '/api/ntpc/desc';
      this.NTPC_AVAIL_URL = this.CF_WORKER_URL + '/api/ntpc/avail';
    }
    console.log('[DEBUG] ParkingService 環境:', isLocal ? '本地' : '部署', '| NTPC URL:', this.NTPC_DESC_URL);
  },

  /**
   * 搜尋附近停車場（台北+新北同時搜尋）
   */
  async searchNearby(lat, lng, city) {
    if (city === 'Taipei' || city === 'NewTaipei') {
      // 雙北地區：同時搜尋台北市 + 新北市
      const [taipeiResults, ntpcResults] = await Promise.all([
        this.searchTaipei(lat, lng).catch(() => []),
        this.searchNTPC(lat, lng).catch(() => [])
      ]);

      console.log('[DEBUG] 台北結果:', taipeiResults.length, ', 新北結果:', ntpcResults.length);

      // 合併、去重、排序
      const merged = [...taipeiResults, ...ntpcResults];
      merged.sort((a, b) => a.distance - b.distance);
      return merged.slice(0, 30);
    }

    // 其他城市嘗試 TDX API
    if (this.TDX_PROXY_URL) {
      return this.searchTDX(lat, lng, city);
    }

    // 沒有設定 TDX proxy 時，使用雙北 API 作為 demo
    const [taipeiResults, ntpcResults] = await Promise.all([
      this.searchTaipei(lat, lng).catch(() => []),
      this.searchNTPC(lat, lng).catch(() => [])
    ]);
    const merged = [...taipeiResults, ...ntpcResults];
    merged.sort((a, b) => a.distance - b.distance);
    return merged.slice(0, 30);
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

  /**
   * TDX API 搜尋（需 Cloudflare Worker 代理）- Phase 2
   */
  async searchTDX(lat, lng, city) {
    try {
      const response = await fetch(`${this.TDX_PROXY_URL}/parking/${city}?lat=${lat}&lng=${lng}&radius=${this.SEARCH_RADIUS}`);
      if (!response.ok) throw new Error('TDX API 錯誤');
      return response.json();
    } catch (error) {
      console.error('TDX API 錯誤:', error);
      return [];
    }
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
