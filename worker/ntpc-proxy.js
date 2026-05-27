/**
 * Cloudflare Worker - 新北市停車場 API 代理
 * 解決 data.ntpc.gov.tw CORS 限制
 *
 * 部署方式：
 * 1. 前往 https://dash.cloudflare.com/ → Workers & Pages
 * 2. 建立新 Worker，命名為 parknow-proxy
 * 3. 貼上此程式碼並部署
 * 4. 部署後 URL 例如: https://parknow-proxy.YOUR_SUBDOMAIN.workers.dev
 * 5. 將 URL 填入 parking-service.js 的 CF_WORKER_URL
 *
 * 免費方案限制：10 萬次/天，足夠個人使用
 */

const NTPC_DESC_URL = 'https://data.ntpc.gov.tw/api/datasets/b1464ef0-9c7c-4a6f-abf7-6bdf32847e68/json';
const NTPC_AVAIL_URL = 'https://data.ntpc.gov.tw/api/datasets/e09b35a5-a738-48cc-b0f5-570b67ad9c78/json';

export default {
  async fetch(request) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // /api/ntpc/desc → 代理停車場靜態資訊
    if (url.pathname === '/api/ntpc/desc') {
      return proxyNTPC(NTPC_DESC_URL, url.search, corsHeaders);
    }

    // /api/ntpc/avail → 代理即時空位
    if (url.pathname === '/api/ntpc/avail') {
      return proxyNTPC(NTPC_AVAIL_URL, url.search, corsHeaders);
    }

    return new Response('ParkNow NTPC Proxy - OK', {
      headers: { ...corsHeaders, 'Content-Type': 'text/plain' }
    });
  }
};

async function proxyNTPC(baseUrl, queryString, corsHeaders) {
  try {
    const targetUrl = queryString ? `${baseUrl}${queryString}` : baseUrl;
    const resp = await fetch(targetUrl, {
      headers: { 'User-Agent': 'ParkNow-Proxy/1.0' }
    });
    const data = await resp.text();

    return new Response(data, {
      status: resp.status,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=60'
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
