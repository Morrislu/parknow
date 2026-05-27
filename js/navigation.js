/**
 * 導航模組
 * 自動偵測裝置，開啟 Apple Maps 或 Google Maps
 */
const Navigation = {
  /**
   * 導航到指定座標
   * @param {number} lat - 緯度
   * @param {number} lng - 經度
   * @param {string} name - 停車場名稱
   */
  navigateTo(lat, lng, name) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const encodedName = encodeURIComponent(name);

    if (isIOS) {
      // iOS: Apple Maps 優先
      window.location.href = `maps://?daddr=${lat},${lng}&dirflg=d&q=${encodedName}`;

      // 如果 Apple Maps 沒有回應，備援 Web 版
      setTimeout(() => {
        window.open(`https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d&q=${encodedName}`);
      }, 500);
    } else {
      // Android / 其他: Google Maps
      window.open(
        `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&destination_place_id=&travelmode=driving`,
        '_blank'
      );
    }
  },

  /**
   * 開啟選擇導航 App 的選項
   */
  showNavOptions(lat, lng, name) {
    const encodedName = encodeURIComponent(name);
    const options = [
      {
        name: 'Apple Maps',
        url: `maps://?daddr=${lat},${lng}&dirflg=d&q=${encodedName}`,
        webUrl: `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d&q=${encodedName}`
      },
      {
        name: 'Google Maps',
        url: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`,
        webUrl: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`
      }
    ];
    return options;
  }
};
