/**
 * GPS 定位模組
 * 封裝 Geolocation API，提供定位與反向地理編碼功能
 */
const LocationService = {
  currentPosition: null,
  currentCity: null,

  /**
   * 取得目前 GPS 位置
   * @returns {Promise<{lat: number, lng: number}>}
   */
  getCurrentPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('此裝置不支援定位功能'));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          this.currentPosition = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy
          };
          resolve(this.currentPosition);
        },
        (error) => {
          switch (error.code) {
            case error.PERMISSION_DENIED:
              reject(new Error('請允許定位權限以使用找車位功能'));
              break;
            case error.POSITION_UNAVAILABLE:
              reject(new Error('無法取得位置資訊'));
              break;
            case error.TIMEOUT:
              reject(new Error('定位逾時，請重試'));
              break;
            default:
              reject(new Error('定位失敗'));
          }
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 30000
        }
      );
    });
  },

  /**
   * 反向地理編碼：經緯度 → 縣市名稱
   * 使用 Nominatim (OpenStreetMap) 免費 API
   * @param {number} lat
   * @param {number} lng
   * @returns {Promise<string>} 縣市名稱
   */
  async reverseGeocode(lat, lng) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=zh-TW`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'ParkNow-PWA/1.0' }
      });
      const data = await response.json();

      // 取得縣市名稱
      const address = data.address;
      const city = address.city || address.county || address.state || '';

      // 對應到 TDX API 城市代碼
      this.currentCity = this.mapToTDXCity(city);
      return this.currentCity;
    } catch (e) {
      // 預設台北
      this.currentCity = 'Taipei';
      return this.currentCity;
    }
  },

  /**
   * 將中文縣市名稱對應到 TDX 城市代碼
   */
  mapToTDXCity(cityName) {
    const cityMap = {
      '台北': 'Taipei',
      '臺北': 'Taipei',
      '新北': 'NewTaipei',
      '桃園': 'Taoyuan',
      '台中': 'Taichung',
      '臺中': 'Taichung',
      '台南': 'Tainan',
      '臺南': 'Tainan',
      '高雄': 'Kaohsiung',
      '基隆': 'Keelung',
      '新竹市': 'Hsinchu',
      '新竹縣': 'HsinchuCounty',
      '苗栗': 'MiaoliCounty',
      '彰化': 'ChanghuaCounty',
      '南投': 'NantouCounty',
      '雲林': 'YunlinCounty',
      '嘉義市': 'Chiayi',
      '嘉義縣': 'ChiayiCounty',
      '屏東': 'PingtungCounty',
      '宜蘭': 'YilanCounty',
      '花蓮': 'HualienCounty',
      '台東': 'TaitungCounty',
      '臺東': 'TaitungCounty',
      '澎湖': 'PenghuCounty',
      '金門': 'KinmenCounty',
      '連江': 'LienchiangCounty'
    };

    for (const [key, value] of Object.entries(cityMap)) {
      if (cityName.includes(key)) return value;
    }
    return 'Taipei'; // 預設
  },

  /**
   * 計算兩點距離 (Haversine formula)
   * @returns {number} 距離（公尺）
   */
  calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000; // 地球半徑（公尺）
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  },

  /**
   * 格式化距離顯示
   */
  formatDistance(meters) {
    if (meters < 1000) {
      return `${Math.round(meters)}m`;
    }
    return `${(meters / 1000).toFixed(1)}km`;
  }
};
