/**
 * ParkNow - App 主邏輯
 * 流程：輸入目的地 → 搜尋附近停車場 → OSRM 算開車距離 → Top 5 排名 → 一鍵導航
 */
const App = {
  isSearching: false,
  parkingResults: [],
  destination: null,        // { lat, lng, name }
  top5: [],                 // 開車距離最近的 Top 5
  currentPick: 0,           // 目前選中的 Top 5 index (0-4)
  searchTimer: null,
  placesBaseURL: '',        // Google Places API proxy base URL (localhost only)
  isLocal: false,
  // Google Places API key（部署版直接從瀏覽器呼叫，由網站限制保護）
  GOOGLE_PLACES_KEY: 'AIzaSyDmi61a6CcZvl6pBLb9OpCboh0tFcHsR4E',

  async init() {
    ParkingService.init();
    MapController.init('map');

    this.isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

    this.bindEvents();
    this.registerSW();
    this.locateUser();
  },

  bindEvents() {
    const destInput = document.getElementById('destInput');
    const searchClear = document.getElementById('searchClear');

    // 目的地輸入
    destInput.addEventListener('input', () => {
      const val = destInput.value.trim();
      searchClear.classList.toggle('show', val.length > 0);
      clearTimeout(this.searchTimer);
      if (val.length < 2) { this.hideSuggestions(); return; }
      this.searchTimer = setTimeout(() => this.searchAddress(val), 400);
    });

    destInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = destInput.value.trim();
        if (val.length >= 2) this.searchAddress(val);
      }
    });

    searchClear.addEventListener('click', () => {
      destInput.value = '';
      searchClear.classList.remove('show');
      this.hideSuggestions();
      this.destination = null;
    });

    document.getElementById('findBtn').addEventListener('click', () => this.searchParking());
    document.getElementById('locateBtn').addEventListener('click', () => this.locateUser());
    document.getElementById('panelClose').addEventListener('click', () => this.hidePanel());
    document.getElementById('map').addEventListener('click', () => this.hideSuggestions());

    // 推薦橫幅：導航
    document.getElementById('recommendNavBtn').addEventListener('click', () => {
      const lot = this.top5[this.currentPick];
      if (lot) Navigation.navigateTo(lot.lat, lot.lng, lot.name);
    });

    // 推薦橫幅：展開完整列表
    document.getElementById('recommendMore').addEventListener('click', () => this.showPanel());

    // 距離選擇按鈕
    document.querySelectorAll('.radius-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.radius-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        ParkingService.SEARCH_RADIUS = parseInt(btn.dataset.radius);
        if (this.parkingResults.length > 0 || this.destination) {
          this.searchParking();
        }
      });
    });
  },

  // === 目的地搜尋 ===

  async searchAddress(query) {
    try {
      let data;
      if (this.isLocal) {
        // localhost：透過 Python server proxy
        const resp = await fetch(`/api/places/autocomplete?input=${encodeURIComponent(query)}`);
        data = await resp.json();
      } else {
        // 部署版：瀏覽器直接呼叫 Google Places API（帶正確 Referer）
        const resp = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': this.GOOGLE_PLACES_KEY
          },
          body: JSON.stringify({
            input: query,
            includedRegionCodes: ['tw'],
            languageCode: 'zh-TW'
          })
        });
        data = await resp.json();
      }

      if (data.error || data.error_message) {
        console.error('Places API 錯誤:', data.error || data.error_message);
        this.showToast('地址搜尋服務異常', true);
        return;
      }

      const suggestions = data.suggestions || [];
      if (suggestions.length === 0) {
        this.hideSuggestions();
        return;
      }

      const sugDiv = document.getElementById('suggestions');
      sugDiv.innerHTML = suggestions
        .filter(s => s.placePrediction)
        .map((s) => {
          const p = s.placePrediction;
          const name = p.structuredFormat?.mainText?.text || p.text?.text || '';
          const addr = p.structuredFormat?.secondaryText?.text || '';
          const placeId = p.placeId || '';
          return `<div class="suggestion-item" data-place-id="${placeId}" data-name="${name}">
            <div class="suggestion-name">${name}</div>
            <div class="suggestion-addr">${addr}</div>
          </div>`;
        }).join('');
      sugDiv.classList.add('show');

      sugDiv.querySelectorAll('.suggestion-item').forEach(item => {
        item.addEventListener('click', () => this.onSuggestionClick(item));
      });
    } catch (e) {
      console.error('地址搜尋錯誤:', e);
    }
  },

  async onSuggestionClick(item) {
    const placeId = item.dataset.placeId;
    const name = item.dataset.name;
    try {
      let data;
      if (this.isLocal) {
        const resp = await fetch(`/api/places/details?place_id=${encodeURIComponent(placeId)}`);
        data = await resp.json();
      } else {
        const resp = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
          headers: {
            'X-Goog-Api-Key': this.GOOGLE_PLACES_KEY,
            'X-Goog-FieldMask': 'displayName,formattedAddress,location'
          }
        });
        data = await resp.json();
      }

      if (data.location) {
        this.selectDestination(data.location.latitude, data.location.longitude, data.displayName?.text || name);
      }
    } catch (e) {
      console.error('取得地點詳情錯誤:', e);
    }
  },

  selectDestination(lat, lng, name) {
    this.destination = { lat, lng, name };
    document.getElementById('destInput').value = name;
    document.getElementById('searchClear').classList.add('show');
    this.hideSuggestions();
    MapController.setDestination(lat, lng, name);
    this.searchParking();
  },

  hideSuggestions() {
    document.getElementById('suggestions').classList.remove('show');
  },

  // === 定位 ===

  async locateUser() {
    this.updateStatus('定位中...');
    try {
      const pos = await LocationService.getCurrentPosition();
      MapController.setUserLocation(pos.lat, pos.lng);
      this.updateStatus('已定位');
      LocationService.reverseGeocode(pos.lat, pos.lng);
    } catch (error) {
      this.showToast(error.message, true);
      this.updateStatus('定位失敗');
    }
  },

  // === 搜尋停車場 ===

  async searchParking() {
    if (this.isSearching) return;

    let searchLat, searchLng;
    if (this.destination) {
      searchLat = this.destination.lat;
      searchLng = this.destination.lng;
    } else {
      if (!LocationService.currentPosition) {
        try { await this.locateUser(); } catch (e) { return; }
      }
      const pos = LocationService.currentPosition;
      if (!pos) { this.showToast('請先允許定位權限', true); return; }
      searchLat = pos.lat;
      searchLng = pos.lng;
    }

    this.isSearching = true;
    this.showLoading('搜尋停車場中...');
    document.getElementById('findBtn').classList.add('loading');

    try {
      const city = await LocationService.reverseGeocode(searchLat, searchLng);
      console.log('[DEBUG] 搜尋參數:', searchLat, searchLng, city);

      const results = await ParkingService.searchNearby(searchLat, searchLng, city);
      console.log('[DEBUG] 直線距離篩選結果:', results.length);

      this.parkingResults = results;

      if (results.length === 0) {
        this.showToast('附近沒有空位的停車場', false);
        this.hideRecommend();
        this.hideLoading();
        this.isSearching = false;
        document.getElementById('findBtn').classList.remove('loading');
        return;
      }

      // 地圖標記
      MapController.showParkingMarkers(results, (lot) => this.highlightCard(lot.id));

      // 用 OSRM 算實際開車距離，取 Top 5
      this.showLoading('計算開車路線中...');
      await this.rankByDriving(results, searchLat, searchLng);

      // 列表（全部結果，但 Top 5 標記排名）
      this.renderParkingList(results);

      this.showToast(`找到 ${results.length} 個停車場`);
    } catch (error) {
      this.showToast(error.message, true);
    } finally {
      this.hideLoading();
      this.isSearching = false;
      document.getElementById('findBtn').classList.remove('loading');
    }
  },

  // === OSRM 開車距離排名 ===

  async rankByDriving(lots, destLat, destLng) {
    // 取直線距離最近的 15 個候選，送 OSRM 計算
    const candidates = lots.slice(0, 15);

    try {
      // OSRM Table API：第一個點是目的地，後面是停車場
      const coords = [`${destLng},${destLat}`, ...candidates.map(l => `${l.lng},${l.lat}`)].join(';');
      const url = `https://router.project-osrm.org/table/v1/driving/${coords}?sources=0&annotations=duration,distance`;

      const resp = await fetch(url);
      const data = await resp.json();

      if (data.code === 'Ok' && data.durations && data.distances) {
        const durations = data.durations[0]; // 從目的地到各停車場的秒數
        const distances = data.distances[0]; // 從目的地到各停車場的公尺

        // 附加開車距離到候選
        candidates.forEach((lot, i) => {
          lot.driveDist = distances[i + 1];    // index 0 是目的地自己
          lot.driveTime = durations[i + 1];
        });

        // 按開車距離排序
        candidates.sort((a, b) => (a.driveDist || Infinity) - (b.driveDist || Infinity));

        console.log('[DEBUG] === OSRM 開車距離 Top 5 ===');
        candidates.slice(0, 5).forEach((c, i) => {
          const min = Math.round((c.driveTime || 0) / 60);
          const km = ((c.driveDist || 0) / 1000).toFixed(1);
          console.log(`[DEBUG] #${i + 1} ${c.name} | 開車 ${km}km / ${min}分 | 空位 ${c.available}`);
        });

        this.top5 = candidates.slice(0, 5);
      } else {
        console.warn('[DEBUG] OSRM 回傳異常，降級用直線距離');
        this.top5 = candidates.slice(0, 5);
      }
    } catch (e) {
      console.warn('[DEBUG] OSRM 呼叫失敗，降級用直線距離:', e);
      this.top5 = candidates.slice(0, 5);
    }

    // 預設選 #1，先顯示面板，再背景取步行資料
    this.currentPick = 0;
    this.showRecommendPanel();
    this.fetchWalkingData(this.top5, destLat, destLng);
  },

  // === OSRM 步行距離（停車場 → 目的地）===

  async fetchWalkingData(top5, destLat, destLng) {
    if (!top5 || top5.length === 0) return;
    try {
      const coords = [`${destLng},${destLat}`, ...top5.map(l => `${l.lng},${l.lat}`)].join(';');
      const url = `https://router.project-osrm.org/table/v1/foot/${coords}?sources=0&annotations=duration,distance`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (data.code === 'Ok' && data.durations && data.distances) {
        const durations = data.durations[0];
        const distances = data.distances[0];
        top5.forEach((lot, i) => {
          lot.walkDist = distances[i + 1];
          lot.walkTime = durations[i + 1];
        });
        console.log('[DEBUG] === OSRM 步行距離 Top 5 ===');
        top5.forEach((c, i) => {
          const min = Math.round((c.walkTime || 0) / 60);
          const m = Math.round(c.walkDist || 0);
          console.log(`[DEBUG] #${i + 1} ${c.name} | 步行 ${m}m / ${min}分`);
        });
        // 更新面板顯示
        this.showRecommendPanel();
        this.renderParkingList(this._lastLots || this.top5);
      }
    } catch (e) {
      console.warn('[DEBUG] OSRM 步行資料取得失敗:', e);
    }
  },

  // === 推薦 Top 5 面板 ===

  showRecommendPanel() {
    const banner = document.getElementById('recommendBanner');
    const lot = this.top5[this.currentPick];
    if (!lot) return;

    // 更新推薦資訊
    const driveMin = lot.driveTime ? Math.max(1, Math.round(lot.driveTime / 60)) : '?';
    const driveDist = lot.driveDist ? (lot.driveDist / 1000).toFixed(1) + 'km' : LocationService.formatDistance(lot.distance);
    const walkMin = lot.walkTime ? Math.max(1, Math.round(lot.walkTime / 60)) : null;
    const walkDist = lot.walkDist ? (lot.walkDist < 1000 ? Math.round(lot.walkDist) + 'm' : (lot.walkDist / 1000).toFixed(1) + 'km') : null;
    const walkInfo = walkMin ? ` | 步行 ${walkDist} / ${walkMin}分` : '';

    document.getElementById('recommendName').textContent = lot.name;
    document.getElementById('recommendInfo').textContent =
      `開車 ${driveDist} / ${driveMin}分鐘${walkInfo} | 空位 ${lot.available} 個`;

    // Top 5 快速切換按鈕
    const switchDiv = document.getElementById('top5Switch');
    switchDiv.innerHTML = this.top5.map((t, i) => {
      const active = i === this.currentPick ? 'active' : '';
      const drKm = t.driveDist ? (t.driveDist / 1000).toFixed(1) + 'km' : '?';
      const drMin = t.driveTime ? Math.max(1, Math.round(t.driveTime / 60)) : '?';
      const wkDist = t.walkDist ? (t.walkDist < 1000 ? Math.round(t.walkDist) + 'm' : (t.walkDist / 1000).toFixed(1) + 'km') : null;
      const wkMin = t.walkTime ? Math.max(1, Math.round(t.walkTime / 60)) : null;
      return `<button class="top5-btn ${active}" data-idx="${i}">
        <span class="top5-rank">#${i + 1}</span>
        <span class="top5-drive">🚗 ${drKm}/${drMin}分</span>
        ${wkMin ? `<span class="top5-walk">🚶 ${wkDist}/${wkMin}分</span>` : '<span class="top5-walk">🚶 --</span>'}
        <span class="top5-avail">${t.available}位</span>
      </button>`;
    }).join('');

    // 綁定切換事件
    switchDiv.querySelectorAll('.top5-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentPick = parseInt(btn.dataset.idx);
        this.showRecommendPanel();
        const picked = this.top5[this.currentPick];
        MapController.flyTo(picked.lat, picked.lng, 16);
      });
    });

    banner.classList.add('show');
    MapController.flyTo(lot.lat, lot.lng, 16);
  },

  hideRecommend() {
    document.getElementById('recommendBanner').classList.remove('show');
    this.top5 = [];
    this.currentPick = 0;
  },

  // === 列表 ===

  renderParkingList(lots) {
    this._lastLots = lots;
    const list = document.getElementById('parkingList');

    list.innerHTML = lots.map((lot) => {
      const level = ParkingService.getAvailabilityLevel(lot.available);
      const availText = ParkingService.getAvailabilityText(lot.available);
      const safeName = lot.name.replace(/'/g, "\\'");

      // 開車距離顯示
      let distDisplay;
      if (lot.driveDist) {
        const km = (lot.driveDist / 1000).toFixed(1);
        const min = Math.max(1, Math.round(lot.driveTime / 60));
        distDisplay = `🚗 ${km}km/${min}分`;
      } else {
        distDisplay = LocationService.formatDistance(lot.distance);
      }

      // 步行距離顯示（Top 5 才有）
      let walkDisplay = '';
      if (lot.walkDist != null) {
        const wm = lot.walkDist < 1000 ? Math.round(lot.walkDist) + 'm' : (lot.walkDist / 1000).toFixed(1) + 'km';
        const wMin = Math.max(1, Math.round(lot.walkTime / 60));
        walkDisplay = `<span class="walk-info">🚶 ${wm}/${wMin}分</span>`;
      }

      const rank = this.top5.findIndex(t => t.id === lot.id);
      const isTop = rank >= 0;
      const rankLabel = isTop ? `#${rank + 1} ` : '';

      return `
        <div class="parking-card ${isTop ? 'recommended' : ''}" data-id="${lot.id}" onclick="App.onCardClick(${lot.lat}, ${lot.lng})">
          <div class="card-top">
            <span class="name">${rankLabel}${lot.name}</span>
            <span class="distance">${distDisplay}</span>
          </div>
          <div class="address">${lot.address}</div>
          ${walkDisplay ? `<div class="card-walk">${walkDisplay}</div>` : ''}
          <div class="card-bottom">
            <span class="availability ${level}">${availText}</span>
            <button class="nav-btn" onclick="event.stopPropagation(); Navigation.navigateTo(${lot.lat}, ${lot.lng}, '${safeName}')">
              導航
            </button>
          </div>
        </div>`;
    }).join('');

    document.getElementById('resultCount').textContent = `${lots.length} 個停車場`;
  },

  onCardClick(lat, lng) { MapController.flyTo(lat, lng); },

  highlightCard(id) {
    const card = document.querySelector(`.parking-card[data-id="${id}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  // === UI ===

  showPanel() { document.getElementById('bottomPanel').classList.add('show'); },
  hidePanel() { document.getElementById('bottomPanel').classList.remove('show'); },

  showLoading(text) {
    const o = document.getElementById('loadingOverlay');
    o.querySelector('p').textContent = text || '載入中...';
    o.classList.add('show');
  },

  hideLoading() { document.getElementById('loadingOverlay').classList.remove('show'); },
  updateStatus(text) { document.getElementById('statusBadge').textContent = text; },

  showToast(message, isError = false) {
    const t = document.getElementById('toast');
    t.textContent = message;
    t.className = 'toast show' + (isError ? ' error' : '');
    setTimeout(() => t.classList.remove('show'), 3000);
  },

  registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
