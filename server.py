"""Local dev server for the StreamBIM widget.

Serves ./public on http://localhost:3000/ (the URL StreamBIM's "localhost" widget loads).
Standard library only. Binds to 127.0.0.1 so the widget is not reachable from the network.

    python server.py
"""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = 3000
PUBLIC_DIR = Path(__file__).resolve().parent / "public"

# Only StreamBIM may embed the widget (opened directly, it runs on mock data).
# Scripts come from this server and the pinned penpal build.
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; "
        "script-src 'self' https://cdn.jsdelivr.net; "
        "style-src 'self'; "
        "img-src 'self' data:; "
        "frame-ancestors https://streambim.com https://*.streambim.com"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


class WidgetHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        super().end_headers()

    def list_directory(self, path):
        # No directory listings.
        self.send_error(404)
        return None


def main():
    handler = partial(WidgetHandler, directory=str(PUBLIC_DIR))
    with ThreadingHTTPServer((HOST, PORT), handler) as httpd:
        print(f"Widget served on http://localhost:{PORT}/  (Ctrl+C to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
