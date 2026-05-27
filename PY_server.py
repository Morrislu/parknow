#!/usr/bin/env python3
"""
ParkNow 開發用伺服器
- 靜態檔案伺服
- 代理新北市停車場 API（解決 CORS 問題）

使用方式：
  python3 PY_server.py
  python3 PY_server.py --help
  python3 PY_server.py --port 8080

瀏覽器開啟 http://localhost:8080
"""
import sys
import os
import json
import argparse
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.request import urlopen, Request
from urllib.parse import urlparse, parse_qs

# 新北市 API
NTPC_DESC_URL = 'https://data.ntpc.gov.tw/api/datasets/b1464ef0-9c7c-4a6f-abf7-6bdf32847e68/json'
NTPC_AVAIL_URL = 'https://data.ntpc.gov.tw/api/datasets/e09b35a5-a738-48cc-b0f5-570b67ad9c78/json'


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
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

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


def main():
    if '--help' in sys.argv or '-h' in sys.argv or 'help' in sys.argv:
        show_help()
        sys.exit(0)

    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--port', type=int, default=8080)
    args, _ = parser.parse_known_args()

    # 切換到專案目錄
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    server = HTTPServer(('0.0.0.0', args.port), ParkNowHandler)
    print(f'ParkNow 伺服器已啟動')
    print(f'  http://localhost:{args.port}')
    print(f'  按 Ctrl+C 停止')
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n伺服器已停止')
        server.server_close()


if __name__ == '__main__':
    main()
