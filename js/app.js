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

  async init() {
    ParkingService.init();
    MapController.init('map');
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
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=tw&limit=5&accept-language=zh-TW`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'ParkNow-PWA/1.0' } });
      const results = await resp.json();

      if (results.length === 0) { this.hideSuggestions(); return; }

      const sugDiv = document.getElementById('suggestions');
      sugDiv.innerHTML = results.map((r) => {
        const name = r.display_name.split(',')[0];
        const addr = r.display_name.split(',').slice(1, 3).join(',');
        return `<div class="suggestion-item" data-lat="${r.lat}" data-lng="${r.lon}" data-name="${name}">
          <div class="suggestion-name">${name}</div>
          <div class="suggestion-addr">${addr}</div>
        </div>`;
      }).join('');
      sugDiv.classList.add('show');

      sugDiv.querySelectorAll('.suggestion-item').forEach(item => {
        item.addEventListener('click', () => {
          this.selectDestination(
            parseFloat(item.dataset.lat),
            parseFloat(item.dataset.lng),
            item.dataset.name
          );
        });
      });
    } catch (e) {
      console.error('地址搜尋錯誤:', e);
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

    // 預設選 #1
    this.currentPick = 0;
    this.showRecommendPanel();
  },

  // === 推薦 Top 5 面板 ===

  showRecommendPanel() {
    const banner = document.getElementById('recommendBanner');
    const lot = this.top5[this.currentPick];
    if (!lot) return;

    // 更新推薦資訊
    const driveMin = lot.driveTime ? Math.max(1, Math.round(lot.driveTime / 60)) : '?';
    const driveDist = lot.driveDist ? (lot.driveDist / 1000).toFixed(1) + 'km' : LocationService.formatDistance(lot.distance);

    document.getElementById('recommendName').textContent = lot.name;
    document.getElementById('recommendInfo').textContent =
      `開車 ${driveDist} / ${driveMin}分鐘 | 空位 ${lot.available} 個`;

    // Top 5 快速切換按鈕
    const switchDiv = document.getElementById('top5Switch');
    switchDiv.innerHTML = this.top5.map((t, i) => {
      const active = i === this.currentPick ? 'active' : '';
      const min = t.driveTime ? Math.max(1, Math.round(t.driveTime / 60)) : '?';
      return `<button class="top5-btn ${active}" data-idx="${i}">
        <span class="top5-rank">#${i + 1}</span>
        <span class="top5-time">${min}分</span>
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
    const top5Ids = new Set(this.top5.map(t => t.id));
    const list = document.getElementById('parkingList');

    list.innerHTML = lots.map((lot) => {
      const level = ParkingService.getAvailabilityLevel(lot.available);
      const availText = ParkingService.getAvailabilityText(lot.available);
      const safeName = lot.name.replace(/'/g, "\\'");

      // 距離顯示：有開車距離就顯示開車距離
      let distDisplay;
      if (lot.driveDist) {
        const km = (lot.driveDist / 1000).toFixed(1);
        const min = Math.max(1, Math.round(lot.driveTime / 60));
        distDisplay = `${km}km / ${min}分`;
      } else {
        distDisplay = LocationService.formatDistance(lot.distance);
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
