/**
 * Cloudflare Worker - TDX API 代理
 * 處理 TDX API 認證，避免前端暴露 client_secret
 *
 * 部署方式：
 * 1. 前往 https://dash.cloudflare.com/ → Workers
 * 2. 建立新 Worker，貼上此程式碼
 * 3. 設定環境變數：TDX_CLIENT_ID, TDX_CLIENT_SECRET
 * 4. 部署後取得 Worker URL，填入 parking-service.js 的 TDX_PROXY_URL
 */

const TDX_AUTH_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const TDX_API_BASE = 'https://tdx.transportdata.tw/api/basic/v1';

let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken(env) {
  // 檢查快取
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const response = await fetch(TDX_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${env.TDX_CLIENT_ID}&client_secret=${env.TDX_CLIENT_SECRET}`
  });

  const data = await response.json();
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000
  };

  return data.access_token;
}

export default {
  async fetch(request, env) {
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter(Boolean);

    // Route: /parking/{City}?lat=&lng=&radius=
    if (pathParts[0] === 'parking' && pathParts[1]) {
      const city = pathParts[1];
      const lat = parseFloat(url.searchParams.get('lat'));
      const lng = parseFloat(url.searchParams.get('lng'));
      const radius = parseInt(url.searchParams.get('radius')) || 2000;

      try {
        const token = await getAccessToken(env);
        const headers = { Authorization: `Bearer ${token}` };

        // 取得停車場靜態資料 + 即時空位
        const [descRes, availRes] = await Promise.all([
          fetch(`${TDX_API_BASE}/Parking/OffStreet/CarPark/City/${city}?$format=JSON`, { headers }),
          fetch(`${TDX_API_BASE}/Parking/OffStreet/ParkingAvailability/City/${city}?$format=JSON`, { headers })
        ]);

        const descData = await descRes.json();
        const availData = await availRes.json();

        // 建立空位 lookup
        const availMap = {};
        (availData || []).forEach(item => {
          availMap[item.CarParkID] = {
            available: item.AvailableSpaces || 0,
            total: item.TotalSpaces || 0
          };
        });

        // 處理並過濾
        const results = [];
        (descData || []).forEach(park => {
          const parkLat = park.CarParkPosition?.PositionLat;
          const parkLng = park.CarParkPosition?.PositionLon;
          if (!parkLat || !parkLng) return;

          const distance = haversine(lat, lng, parkLat, parkLng);
          if (distance > radius) return;

          const avail = availMap[park.CarParkID] || { available: 0, total: 0 };
          if (avail.available <= 0) return;

          results.push({
            id: park.CarParkID,
            name: park.CarParkName?.Zh_tw || '停車場',
            address: park.Address || '',
            lat: parkLat,
            lng: parkLng,
            distance,
            available: avail.available,
            total: avail.total,
            fee: park.FareDescription || ''
          });
        });

        results.sort((a, b) => a.distance - b.distance);

        return new Response(JSON.stringify(results.slice(0, 30)), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('ParkNow TDX Proxy - OK', { headers: corsHeaders });
  }
};

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
