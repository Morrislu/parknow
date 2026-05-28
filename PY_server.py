#!/usr/bin/env python3
"""
ParkNow 開發用伺服器
- 靜態檔案伺服
- 代理新北市停車場 API（解決 CORS 問題）
- 代理 TDX API（本地開發用，需環境變數 TDX_CLIENT_ID / TDX_CLIENT_SECRET）

使用方式：
  python3 PY_server.py
  python3 PY_server.py --help
  python3 PY_server.py --port 8080

瀏覽器開啟 http://localhost:8080
"""
import sys
import os
import json
import time
import re
import argparse
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.request import urlopen, Request
from urllib.parse import urlparse, parse_qs, urlencode
import math


def load_dotenv():
    """載入 .env 檔（不依賴第三方套件）"""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if not os.path.exists(env_path):
        return
    with open(env_path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                key, value = line.split('=', 1)
                key, value = key.strip(), value.strip()
                if key and value:
                    os.environ.setdefault(key, value)


load_dotenv()

# 新北市 API
NTPC_DESC_URL = 'https://data.ntpc.gov.tw/api/datasets/b1464ef0-9c7c-4a6f-abf7-6bdf32847e68/json'
NTPC_AVAIL_URL = 'https://data.ntpc.gov.tw/api/datasets/e09b35a5-a738-48cc-b0f5-570b67ad9c78/json'

# TDX API
TDX_AUTH_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token'
TDX_API_BASE = 'https://tdx.transportdata.tw/api/basic/v1'

# TDX Token cache
_tdx_token = {'token': None, 'expires_at': 0}


def get_tdx_token():
    """取得 TDX access token（含快取）"""
    client_id = os.environ.get('TDX_CLIENT_ID', '')
    client_secret = os.environ.get('TDX_CLIENT_SECRET', '')
    if not client_id or not client_secret:
        return None

    if _tdx_token['token'] and time.time() < _tdx_token['expires_at']:
        return _tdx_token['token']

    body = urlencode({
        'grant_type': 'client_credentials',
        'client_id': client_id,
        'client_secret': client_secret
    }).encode()

    req = Request(TDX_AUTH_URL, data=body, headers={
        'Content-Type': 'application/x-www-form-urlencoded'
    })
    with urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())

    _tdx_token['token'] = data['access_token']
    _tdx_token['expires_at'] = time.time() + data.get('expires_in', 3600) - 60
    return data['access_token']


def haversine(lat1, lng1, lat2, lng2):
    """Haversine 距離（公尺）"""
    R = 6371000
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = (math.sin(d_lat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(d_lng / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


class ParkNowHandler(SimpleHTTPRequestHandler):
    """自訂 HTTP handler，處理 API 代理請求"""

    def do_GET(self):
        parsed = urlparse(self.path)

        # 代理新北市停車場靜態資訊
        if parsed.path == '/api/ntpc/desc':
            self._proxy_ntpc(NTPC_DESC_URL, parsed.query)
            return

        # 代理新北市停車場即時空位
        if parsed.path == '/api/ntpc/avail':
            self._proxy_ntpc(NTPC_AVAIL_URL, parsed.query)
            return

        # TDX 停車場 API: /api/parking/{City}
        m = re.match(r'^/api/parking/([A-Za-z]+)$', parsed.path)
        if m:
            self._proxy_tdx(m.group(1), parsed.query)
            return

        # 其他請求走正常靜態檔案
        super().do_GET()

    def _proxy_ntpc(self, base_url, query_string):
        """代理新北市 API 請求"""
        try:
            url = f'{base_url}?{query_string}' if query_string else base_url
            req = Request(url, headers={'User-Agent': 'ParkNow-Proxy/1.0'})
            with urlopen(req, timeout=15) as resp:
                data = resp.read()

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'max-age=60')
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._send_json_error(502, str(e))

    def _proxy_tdx(self, city, query_string):
        """代理 TDX API 請求"""
        token = get_tdx_token()
        if not token:
            self._send_json_error(503, 'TDX credentials not configured. Set TDX_CLIENT_ID and TDX_CLIENT_SECRET env vars.')
            return

        params = parse_qs(query_string)
        lat = float(params.get('lat', [0])[0])
        lng = float(params.get('lng', [0])[0])
        radius = int(params.get('radius', [2000])[0])

        try:
            headers = {
                'Authorization': f'Bearer {token}',
                'User-Agent': 'ParkNow-Proxy/1.0'
            }

            # 取得靜態資料
            desc_url = f'{TDX_API_BASE}/Parking/OffStreet/CarPark/City/{city}?$format=JSON'
            desc_req = Request(desc_url, headers=headers)
            with urlopen(desc_req, timeout=15) as resp:
                desc_data = json.loads(resp.read())

            # 取得即時空位
            avail_url = f'{TDX_API_BASE}/Parking/OffStreet/ParkingAvailability/City/{city}?$format=JSON'
            avail_req = Request(avail_url, headers=headers)
            try:
                with urlopen(avail_req, timeout=15) as resp:
                    avail_data = json.loads(resp.read())
            except Exception:
                avail_data = []

            # TDX 回傳可能是陣列或物件，統一處理
            if isinstance(desc_data, dict):
                desc_data = desc_data.get('CarParks', desc_data.get('carParks', []))
            if isinstance(avail_data, dict):
                avail_data = avail_data.get('ParkingAvailabilities', avail_data.get('parkingAvailabilities', []))

            # 建立空位 lookup
            avail_map = {}
            for item in (avail_data or []):
                available, total = 0, 0
                if item.get('AvailableSpaces') is not None:
                    available = item.get('AvailableSpaces', 0)
                    total = item.get('TotalSpaces', 0)
                elif item.get('Availabilities'):
                    a = item['Availabilities'][0]
                    available = a.get('AvailableSpaces', 0)
                    total = a.get('NumberOfSpaces', 0)
                avail_map[item.get('CarParkID', '')] = {
                    'available': available,
                    'total': total
                }

            # 過濾排序
            results = []
            for park in (desc_data or []):
                pos = park.get('CarParkPosition', {})
                park_lat = pos.get('PositionLat')
                park_lng = pos.get('PositionLon')
                if not park_lat or not park_lng:
                    continue

                distance = haversine(lat, lng, park_lat, park_lng)
                if distance > radius:
                    continue

                avail = avail_map.get(park.get('CarParkID', ''), {'available': 0, 'total': 0})
                if avail['available'] <= 0:
                    continue

                name_obj = park.get('CarParkName', {})
                results.append({
                    'id': park.get('CarParkID', ''),
                    'name': name_obj.get('Zh_tw', '停車場') if isinstance(name_obj, dict) else str(name_obj),
                    'address': park.get('Address', ''),
                    'lat': park_lat,
                    'lng': park_lng,
                    'distance': round(distance),
                    'available': avail['available'],
                    'total': avail['total'],
                    'fee': park.get('FareDescription', ''),
                    'source': 'tdx'
                })

            results.sort(key=lambda x: x['distance'])
            results = results[:30]

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(results).encode())

        except Exception as e:
            self._send_json_error(500, str(e))

    def _send_json_error(self, status, message):
        """送出 JSON 錯誤回應"""
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps({'error': message}).encode())

    def log_message(self, format, *args):
        """簡化 log，只顯示 API 請求"""
        path = args[0].split(' ')[1] if args else ''
        if '/api/' in path:
            print(f'  [PROXY] {path}')
        elif not path.startswith('/js/') and not path.startswith('/css/') and path != '/favicon.ico':
            super().log_message(format, *args)


def show_help():
    print("程式說明：ParkNow PWA 開發用伺服器")
    print()
    print("語法：")
    print("  python3 PY_server.py [--port PORT]")
    print("  python3 PY_server.py --help")
    print()
    print("參數說明：")
    print("  --port    伺服器埠號 (預設: 8080)")
    print("  --help    顯示此說明訊息")
    print()
    print("使用範例：")
    print("  python3 PY_server.py")
    print("  python3 PY_server.py --port 3000")
    print()
    print("功能：")
    print("  1. 靜態檔案伺服 (index.html, JS, CSS)")
    print("  2. 代理新北市停車場 API (解決 CORS)")
    print("     /api/ntpc/desc  → 停車場靜態資訊")
    print("     /api/ntpc/avail → 即時空位資訊")
    print("  3. 代理 TDX API (全台灣停車場)")
    print("     /api/parking/{City} → TDX 停車場搜尋")
    print("     需設定環境變數: TDX_CLIENT_ID, TDX_CLIENT_SECRET")


def main():
    if '--help' in sys.argv or '-h' in sys.argv or 'help' in sys.argv:
        show_help()
        sys.exit(0)

    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--port', type=int, default=8080)
    args, _ = parser.parse_known_args()

    # 切換到專案目錄
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    # 檢查 TDX 環境變數
    tdx_id = os.environ.get('TDX_CLIENT_ID', '')
    tdx_ok = bool(tdx_id and os.environ.get('TDX_CLIENT_SECRET', ''))

    server = HTTPServer(('0.0.0.0', args.port), ParkNowHandler)
    print(f'ParkNow 伺服器已啟動')
    print(f'  http://localhost:{args.port}')
    print(f'  TDX API: {"已設定 (" + tdx_id[:8] + "...)" if tdx_ok else "未設定 (僅台北+新北)"}')
    print(f'  按 Ctrl+C 停止')
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n伺服器已停止')
        server.server_close()


if __name__ == '__main__':
    main()
