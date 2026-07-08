"""1680 Mission room-map GUI — portable, standard library only.

Run with any Python 3.8+:  python server.py
Then open http://localhost:8177  (LAN: http://<this-machine-ip>:8177)

Layout (all relative to this file):
  static/     frontend
  partition/  F#.geojson floor geometry
  data/       overlay JSON files (created on use; backups/ inside)
"""
import base64
import csv
import hmac
import io
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
PARTITION = ROOT / "partition"
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

import os

# As of 2026-07-05 partition files are named by PHYSICAL story; the
# historical F2/F3 drawing swap is resolved at the geometry layer.
STORY_SOURCES = {1: "F1", 2: "F2", 3: "F3", 4: "F4"}
PORT = int(os.environ.get("MAPGUI_PORT", "8177"))
BIND = os.environ.get("MAPGUI_BIND", "0.0.0.0")  # behind a proxy use 127.0.0.1
MAX_PUT_BYTES = 20_000_000

# Shared password: put it (one line) in password.txt next to this file.
# If the file is absent or empty, the server runs open (LAN-only mode).
_pw_file = ROOT / "password.txt"
PASSWORD = _pw_file.read_text(encoding="utf-8").strip() if _pw_file.exists() else ""
_lock = threading.Lock()

MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png"}


def data_path(key):
    if not key.replace("_", "").isalnum():
        raise ValueError("bad data key")
    return DATA / f"{key}.json"


def load_json(path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _authorized(self):
        if not PASSWORD:
            return True
        h = self.headers.get("Authorization", "")
        if h.startswith("Basic "):
            try:
                supplied = base64.b64decode(h[6:]).decode("utf-8").split(":", 1)[-1]
                if hmac.compare_digest(supplied, PASSWORD):
                    return True
                time.sleep(0.5)   # slow down guessing
                return False
            except Exception:
                return False
        return False

    def _deny(self):
        body = b"password required"
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="1680 Mission room map"')
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send(self, code, body, ctype="application/json", extra=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self._authorized():
            return self._deny()
        p = self.path.split("?")[0]
        try:
            if p == "/api/floors":
                out = {}
                for story, src in STORY_SOURCES.items():
                    gj = json.loads((PARTITION / f"{src}.geojson").read_text(encoding="utf-8"))
                    out[str(story)] = {"source": src, "geojson": gj}
                return self._send(200, out)
            if p.startswith("/api/data/"):
                return self._send(200, load_json(data_path(p.rsplit("/", 1)[1]), {}))
            if p.startswith("/api/export/") and p.endswith(".csv"):
                key = p[len("/api/export/"):-4]
                data = load_json(data_path(key), {})
                names = load_json(data_path("names"), {})
                markers = data.pop("_markers", {})
                fields = sorted(
                    {f for v in data.values() if isinstance(v, dict) for f in v} |
                    {f for m in markers.values() for f in m.get("fields", {})})
                buf = io.StringIO()
                w = csv.writer(buf)
                w.writerow(["room_id", "name", "point_x_in", "point_y_in"] + fields)
                for rid in sorted(data):
                    v = data[rid]
                    w.writerow([rid, names.get(rid, ""), "", ""] +
                               [v.get(f, "") if isinstance(v, dict) else v for f in fields])
                for mid in sorted(markers):
                    m = markers[mid]
                    rid = m.get("room") or ""
                    w.writerow([rid, names.get(rid, ""),
                                m.get("xy", ["", ""])[0], m.get("xy", ["", ""])[1]] +
                               [m.get("fields", {}).get(f, "") for f in fields])
                return self._send(200, buf.getvalue().encode(), "text/csv",
                                  {"Content-Disposition": f"attachment; filename={key}.csv"})
            if p == "/api/backup.zip":
                import zipfile
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                    for f in DATA.rglob("*"):
                        if f.is_file():
                            z.write(f, f.relative_to(DATA.parent))
                return self._send(200, buf.getvalue(), "application/zip",
                                  {"Content-Disposition":
                                   f"attachment; filename=map-data-{time.strftime('%Y%m%d')}.zip"})
            # static files
            rel = "index.html" if p == "/" else p.lstrip("/")
            f = (STATIC / rel).resolve()
            if STATIC.resolve() in f.parents and f.is_file():
                return self._send(200, f.read_bytes(), MIME.get(f.suffix, "application/octet-stream"))
            return self._send(404, {"error": "not found"})
        except Exception as e:
            return self._send(500, {"error": str(e)})

    def do_PUT(self):
        if not self._authorized():
            return self._deny()
        p = self.path.split("?")[0]
        try:
            if p.startswith("/api/data/"):
                n = int(self.headers.get("Content-Length", 0))
                if n > MAX_PUT_BYTES:
                    return self._send(413, {"error": "payload too large"})
                payload = json.loads(self.rfile.read(n).decode("utf-8"))
                key = p.rsplit("/", 1)[1]
                with _lock:
                    fp = data_path(key)
                    if fp.exists():
                        bak = DATA / "backups"
                        bak.mkdir(exist_ok=True)
                        (bak / f"{key}.{time.strftime('%Y%m%d_%H%M%S')}.json").write_text(
                            fp.read_text(encoding="utf-8"), encoding="utf-8")
                    fp.write_text(json.dumps(payload, indent=1), encoding="utf-8")
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "not found"})
        except Exception as e:
            return self._send(500, {"error": str(e)})


if __name__ == "__main__":
    try:
        ip = socket.gethostbyname(socket.gethostname())
    except Exception:
        ip = "?"
    print(f"Room map GUI:  http://localhost:{PORT}   (LAN: http://{ip}:{PORT})")
    print("Password protection:", "ON" if PASSWORD else "OFF (create password.txt to enable)")
    print("Ctrl+C to stop.")
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
