#!/usr/bin/env python3
"""Fetch DEEP audit driver (browser lane: native browser fetch).

Serves the worktree at /local-repo plus the audit endpoints (/echo,
/redirect, /done, /cookies, /slow, /gzip, /form), loads
tests/fetch-audit-deep-e2e.html in headed Firefox under Xvfb, waits for the
verdict via document.title AND POST /report (crash-proof), exits 0 on
E2E-PASS, 1 otherwise. The JSON verdict is also saved to
/tmp/fetch-deep-browser.json for diffing against the Node lane.

Usage: xvfb-run -a /home/hatch/workspace/venvs/ffauto/bin/python tests/fetch-audit-deep-e2e.py [port]
"""
import gzip
import json
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8942
REPO = Path(os.environ.get("REPO", Path(__file__).resolve().parent.parent))
CDN_BASE = "https://cdn.jsdelivr.net/gh/MarketingPip/bundleVFSModules@main/dist/"
MIME = {".js": "text/javascript", ".html": "text/html", ".json": "application/json"}
VERDICT_FILE = "/tmp/fetch-audit-deep-e2e-verdict.jsonl"
BROWSER_JSON = "/tmp/fetch-deep-browser.json"

FF = "/home/hatch/workspace/local/firefox/firefox/firefox"
GD = "/home/hatch/workspace/local/bin/geckodriver"
VENV_PY = "/home/hatch/workspace/venvs/ffauto/bin/python"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, data: bytes, mime: str, extra=()):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _404(self):
        self.send_response(404)
        self.end_headers()
        self.wfile.write(b"not found")

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        return self.rfile.read(n) if n > 0 else b""

    def do_POST(self):
        p = unquote(self.path.split("?", 1)[0])
        try:
            body = self._read_body()
            if p == "/report":
                with open(VERDICT_FILE, "a") as f:
                    f.write(body.decode("utf-8", "replace") + "\n")
                return self._send(b"ok", "text/plain")
            if p == "/echo":
                payload = {
                    "method": "POST",
                    "url": self.path,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "body": body.decode("utf-8", "replace"),
                }
                return self._send(json.dumps(payload).encode(), "application/json")
            if p == "/form":
                payload = {
                    "raw": body.decode("latin-1", "replace"),
                    "contentType": self.headers.get("Content-Type"),
                }
                return self._send(json.dumps(payload).encode(), "application/json")
        except (BrokenPipeError, ConnectionResetError):
            return
        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        p = unquote(self.path.split("?", 1)[0])
        try:
            if p == "/local-repo/runtime.js":
                src = (REPO / "runtime.js").read_text()
                assert CDN_BASE in src, "CDN base string moved in runtime.js"
                local = f"http://127.0.0.1:{PORT}/local-repo/dist/"
                src = src.replace(CDN_BASE, local)
                return self._send(src.encode(), MIME[".js"])
            if p.startswith("/local-repo/"):
                rel = p[len("/local-repo/"):]
                f = REPO / rel
                if ".." in rel or not f.is_file():
                    return self._404()
                ext = f.suffix
                return self._send(f.read_bytes(), MIME.get(ext, "application/octet-stream"))
            if p == "/echo":
                payload = {
                    "method": "GET",
                    "url": self.path,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "body": "",
                }
                return self._send(json.dumps(payload).encode(), "application/json")
            if p == "/redirect":
                self.send_response(302)
                self.send_header("Location", "/done")
                self.send_header("X-Mark", "yes")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                return
            if p == "/done":
                return self._send(b"final", "text/plain")
            if p == "/cookies":
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("Set-Cookie", "k1=v1; Path=/")
                self.send_header("Set-Cookie", "k2=v2; Path=/")
                self.send_header("Access-Control-Allow-Origin", "*")
                body = b"ck"
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if p == "/slow":
                time.sleep(5)
                return self._send(b"slow-done", "text/plain")
            if p == "/gzip":
                data = gzip.compress(b"gzip-ok")
                return self._send(data, "text/plain", [("Content-Encoding", "gzip")])
        except (BrokenPipeError, ConnectionResetError):
            return
        return self._404()

    def do_HEAD(self):
        p = unquote(self.path.split("?", 1)[0])
        if p == "/echo":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()


def main():
    vf = Path(VERDICT_FILE)
    if vf.exists():
        vf.unlink()
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), H)
    import threading

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{PORT}/local-repo/tests/fetch-audit-deep-e2e.html"
    print("serving worktree ->", url, flush=True)

    driver_script = (
        "import sys, time, json\n"
        "from selenium import webdriver\n"
        "from selenium.webdriver.firefox.options import Options\n"
        "from selenium.webdriver.firefox.service import Service\n"
        "opts = Options()\n"
        "opts.binary_location = %r\n"
        "svc = Service(executable_path=%r)\n"
        "d = webdriver.Firefox(options=opts, service=svc)\n"
        "d.set_page_load_timeout(120)\n"
        "d.get(%r)\n"
        "title = ''\n"
        "deadline = time.time() + 240\n"
        "while time.time() < deadline:\n"
        "    try:\n"
        "        title = d.title\n"
        "    except Exception:\n"
        "        break\n"
        "    if title.startswith('E2E-PASS') or title.startswith('E2E-FAIL'):\n"
        "        break\n"
        "    time.sleep(2)\n"
        "print('TITLE=' + title, flush=True)\n"
        "try:\n"
        "    body = d.find_element('id', 'out').text\n"
        "    print('BODY:\\n' + body[-3000:], flush=True)\n"
        "except Exception as e:\n"
        "    print('no #out: %%s' %% e, flush=True)\n"
        "d.quit()\n"
        "sys.exit(0 if title.startswith('E2E-PASS') else 1)\n"
    ) % (FF, GD, url)

    proc = subprocess.run(
        [VENV_PY, "-c", driver_script], capture_output=True, text=True, timeout=300
    )
    print(proc.stdout[-4000:])
    print(proc.stderr[-2000:], file=sys.stderr)
    verdict_ok = None
    if vf.exists():
        lines = vf.read_text().strip().splitlines()
        print("--- verdict.jsonl (%d lines, last shown) ---" % len(lines))
        print(lines[-1][:3000])
        try:
            last = json.loads(lines[-1])
            verdict_ok = last.get("lane") == "browser-native"
            with open(BROWSER_JSON, "w") as f:
                json.dump(last, f, indent=1)
            print("wrote", BROWSER_JSON)
        except Exception as e:
            print("verdict parse failed:", e)
            verdict_ok = False
    httpd.shutdown()
    rc = proc.returncode
    if verdict_ok is False:
        rc = 1
    sys.exit(rc)


if __name__ == "__main__":
    main()
