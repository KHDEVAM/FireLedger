"""Run the Lambda handlers locally for development.

    python api/dev_server.py        # http://127.0.0.1:8787/api/nrt?bbox=-6,34.5,-4.5,35.6&days=7

Reads FIRMS_MAP_KEY from .env (never committed). The Vite dev server proxies
/api/* to this port, mirroring the Amplify rewrite used in production.
"""
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

env = ROOT / ".env"
if env.exists():
    for line in env.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            name, value = line.split("=", 1)
            os.environ.setdefault(name.strip(), value.strip().strip('"'))

from export.app import handler as export_handler  # noqa: E402
from nrt.app import handler as nrt_handler  # noqa: E402
from weather.app import handler as weather_handler  # noqa: E402

ROUTES = {"/api/nrt": nrt_handler, "/api/weather": weather_handler, "/api/export": export_handler}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - http.server naming
        url = urlparse(self.path)
        handler = ROUTES.get(url.path.rstrip("/"))
        if not handler:
            res = {"statusCode": 404, "headers": {"Content-Type": "application/json"}, "body": '{"error": "not found"}'}
        elif url.path.startswith("/api/nrt") and not os.environ.get("FIRMS_MAP_KEY"):
            res = {"statusCode": 503, "headers": {"Content-Type": "application/json"},
                   "body": '{"error": "FIRMS_MAP_KEY is not set in .env"}'}
        else:
            res = handler({"queryStringParameters": dict(parse_qsl(url.query))})
        body = res["body"].encode("utf-8")
        self.send_response(res["statusCode"])
        for name, value in res["headers"].items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # log the path without the query string
        print(self.command, urlparse(self.path).path, args[1] if len(args) > 1 else "")


if __name__ == "__main__":
    port = int(os.environ.get("API_PORT", "8787"))
    print(f"FireLedger API on http://127.0.0.1:{port}  (FIRMS key {'set' if os.environ.get('FIRMS_MAP_KEY') else 'NOT set'})")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
