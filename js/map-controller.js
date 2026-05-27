/**
 * 地圖控制模組
 * 使用 Leaflet.js + OpenStreetMap
 */
const MapController = {
  map: null,
  userMarker: null,
  destMarker: null,
  parkingMarkers: [],
  userCircle: null,

  /**
   * 初始化地圖
   * @param {string} containerId - 地圖容器 DOM ID
   */
  init(containerId) {
    this.map = L.map(containerId, {
      zoomControl: true,
      attributionControl: true
    }).setView([25.033, 121.565], 15);

    // 標準 OpenStreetMap 圖磚（類似 Google Maps 亮色風格）
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }).addTo(this.map);
  },

  /**
   * 設定使用者位置標記
   */
  setUserLocation(lat, lng) {
    if (this.userMarker) {
      this.userMarker.setLatLng([lat, lng]);
      this.userCircle.setLatLng([lat, lng]);
    } else {
      // 藍色使用者位置點
      this.userMarker = L.circleMarker([lat, lng], {
        radius: 8,
        fillColor: '#4A90D9',
        fillOpacity: 1,
        color: '#fff',
        weight: 3
      }).addTo(this.map);

      // 精確度圈
      this.userCircle = L.circle([lat, lng], {
        radius: 50,
        fillColor: '#4A90D9',
        fillOpacity: 0.1,
        color: '#4A90D9',
        weight: 1
      }).addTo(this.map);
    }

    this.map.setView([lat, lng], 15);
  },

  /**
   * 顯示停車場標記
   * @param {Array} parkingLots - 停車場列表
   * @param {Function} onClickCallback - 點擊標記時的回調
   */
  showParkingMarkers(parkingLots, onClickCallback) {
    // 清除舊標記
    this.clearParkingMarkers();

    parkingLots.forEach((lot) => {
      const level = ParkingService.getAvailabilityLevel(lot.available);
      const marker = L.marker([lot.lat, lot.lng], {
        icon: this.createParkingIcon(lot.available, level)
      }).addTo(this.map);

      // 點擊 popup
      const popupContent = `
        <div class="popup-name">${lot.name}</div>
        <div class="popup-info">
          ${lot.address}<br>
          空位：${lot.available} / ${lot.total}<br>
          距離：${LocationService.formatDistance(lot.distance)}
          ${lot.fee ? '<br>費率：' + lot.fee : ''}
        </div>
        <button class="popup-nav-btn" onclick="Navigation.navigateTo(${lot.lat}, ${lot.lng}, '${lot.name.replace(/'/g, "\\'")}')">
          導航前往
        </button>
      `;

      marker.bindPopup(popupContent, {
        closeButton: false,
        maxWidth: 250
      });

      marker.on('click', () => {
        if (onClickCallback) onClickCallback(lot);
      });

      this.parkingMarkers.push(marker);
    });

    // 調整地圖視野包含所有標記
    if (parkingLots.length > 0 && this.userMarker) {
      const bounds = L.latLngBounds(
        parkingLots.map(lot => [lot.lat, lot.lng])
      );
      bounds.extend(this.userMarker.getLatLng());
      this.map.fitBounds(bounds, { padding: [50, 50] });
    }
  },

  /**
   * 建立停車場圖示
   */
  createParkingIcon(available, level) {
    const html = `<div class="parking-marker ${level}">${available > 99 ? '99+' : available}</div>`;
    return L.divIcon({
      html: html,
      className: '',
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });
  },

  /**
   * 清除所有停車場標記
   */
  clearParkingMarkers() {
    this.parkingMarkers.forEach(marker => marker.remove());
    this.parkingMarkers = [];
  },

  /**
   * 設定目的地標記（紅色）
   */
  setDestination(lat, lng, name) {
    if (this.destMarker) {
      this.destMarker.setLatLng([lat, lng]);
    } else {
      const icon = L.divIcon({
        html: '<div class="dest-marker">&#9679;</div>',
        className: '',
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      });
      this.destMarker = L.marker([lat, lng], { icon }).addTo(this.map);
    }
    this.destMarker.bindPopup(`<b>${name}</b><br>目的地`).openPopup();
    this.map.setView([lat, lng], 15);
  },

  /**
   * 將地圖移動到指定位置
   */
  flyTo(lat, lng, zoom = 16) {
    this.map.flyTo([lat, lng], zoom, { duration: 0.5 });
  }
};
