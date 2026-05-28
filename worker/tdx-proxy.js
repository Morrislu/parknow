/**
 * Cloudflare Worker - ParkNow 統一代理
 * 合併 NTPC 代理 + TDX 全台灣停車場 API
 *
 * 路由：
 *   /api/ntpc/desc  → 代理新北市停車場靜態資訊
 *   /api/ntpc/avail → 代理新北市即時空位
 *   /api/parking/{City}?lat=&lng=&radius= → TDX 停車場搜尋
 *
 * 環境變數（TDX 功能需要）：
 *   TDX_CLIENT_ID     - TDX 平台 client_id
 *   TDX_CLIENT_SECRET  - TDX 平台 client_secret
 *
 * 部署方式：
 * 1. https://dash.cloudflare.com/ → Workers & Pages
 * 2. 建立 Worker，命名 parknow-proxy
 * 3. 貼上此程式碼，設定環境變數後部署
 * 4. URL 填入 parking-service.js 的 CF_WORKER_URL
 */

// ── NTPC 新北市 API ──
const NTPC_DESC_URL = 'https://data.ntpc.gov.tw/api/datasets/b1464ef0-9c7c-4a6f-abf7-6bdf32847e68/json';
const NTPC_AVAIL_URL = 'https://data.ntpc.gov.tw/api/datasets/e09b35a5-a738-48cc-b0f5-570b67ad9c78/json';

// ── TDX API ──
const TDX_AUTH_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';
const TDX_API_BASE = 'https://tdx.transportdata.tw/api/basic/v1';

let tokenCache = { token: null, expiresAt: 0 };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // ── NTPC 代理路由 ──
    if (url.pathname === '/api/ntpc/desc') {
      return proxyNTPC(NTPC_DESC_URL, url.search);
    }
    if (url.pathname === '/api/ntpc/avail') {
      return proxyNTPC(NTPC_AVAIL_URL, url.search);
    }

    // ── TDX 停車場路由: /api/parking/{City} ──
    const tdxMatch = url.pathname.match(/^\/api\/parking\/([A-Za-z]+)$/);
    if (tdxMatch) {
      const city = tdxMatch[1];
      const lat = parseFloat(url.searchParams.get('lat'));
      const lng = parseFloat(url.searchParams.get('lng'));
      const radius = parseInt(url.searchParams.get('radius')) || 2000;

      if (!env.TDX_CLIENT_ID || !env.TDX_CLIENT_SECRET) {
        return jsonResponse({ error: 'TDX credentials not configured' }, 503);
      }
      return handleTDXParking(env, city, lat, lng, radius);
    }

    return new Response('ParkNow Proxy - OK', {
      headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain' }
    });
  }
};

// ── NTPC 代理 ──
async function proxyNTPC(baseUrl, queryString) {
  try {
    const targetUrl = queryString ? `${baseUrl}${queryString}` : baseUrl;
    const resp = await fetch(targetUrl, {
      headers: { 'User-Agent': 'ParkNow-Proxy/1.0' }
    });
    const data = await resp.text();

    return new Response(data, {
      status: resp.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=60'
      }
    });
  } catch (error) {
    return jsonResponse({ error: error.message }, 502);
  }
}

// ── TDX Token ──
async function getAccessToken(env) {
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

// ── TDX 停車場搜尋 ──
async function handleTDXParking(env, city, lat, lng, radius) {
  try {
    const token = await getAccessToken(env);
    const headers = { Authorization: `Bearer ${token}` };

    const [descRes, availRes] = await Promise.all([
      fetch(`${TDX_API_BASE}/Parking/OffStreet/CarPark/City/${city}?$format=JSON`, { headers }),
      fetch(`${TDX_API_BASE}/Parking/OffStreet/ParkingAvailability/City/${city}?$format=JSON`, { headers })
    ]);

    if (!descRes.ok) {
      return jsonResponse({ error: `TDX desc API error: ${descRes.status}` }, descRes.status);
    }

    const descRaw = await descRes.json();
    const availRaw = availRes.ok ? await availRes.json() : [];

    // TDX 回傳可能是陣列或物件，統一處理
    const descData = Array.isArray(descRaw) ? descRaw : (descRaw.CarParks || descRaw.carParks || []);
    const availData = Array.isArray(availRaw) ? availRaw : (availRaw.ParkingAvailabilities || availRaw.parkingAvailabilities || []);

    // 建立空位 lookup
    const availMap = {};
    availData.forEach(item => {
      // TDX 空位可能在頂層或 Availabilities 子陣列
      let available = 0, total = 0;
      if (item.AvailableSpaces != null) {
        available = item.AvailableSpaces;
        total = item.TotalSpaces || 0;
      } else if (item.Availabilities && item.Availabilities.length > 0) {
        const a = item.Availabilities[0];
        available = a.AvailableSpaces || 0;
        total = a.NumberOfSpaces || 0;
      }
      availMap[item.CarParkID] = { available, total };
    });

    // 過濾並排序
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
        fee: park.FareDescription || '',
        source: 'tdx'
      });
    });

    results.sort((a, b) => a.distance - b.distance);

    return jsonResponse(results.slice(0, 30));
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

// ── 工具函數 ──
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
