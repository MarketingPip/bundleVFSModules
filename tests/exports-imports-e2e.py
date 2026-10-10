#!/usr/bin/env python3
"""Headed-Firefox E2E for package.json exports/imports resolution (Worker 2).

Real CodeSandbox consumption path: serves this repo at /local-repo
(runtime.js with ONLY _builtinBaseUrl rewritten to the local dist/ — the
repo file is untouched), loads tests/exports-imports-e2e.html in headed
Firefox under Xvfb, waits for the E2E verdict via document.title AND
POST /report (crash-proof), exits 0 on E2E-PASS, 1 otherwise.

Covers: require('#utils') via the nearest `imports` scope,
require('locked-pkg') via the `exports` "." main entry, and
require('locked-pkg/secret.js') throwing ERR_PACKAGE_PATH_NOT_EXPORTED
(encapsulation — the file exists on disk but is not exported).

Usage: xvfb-run -a /home/hatch/workspace/venvs/ffauto/bin/python tests/exports-imports-e2e.py [port]
"""
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8934
REPO = Path(__file__).resolve().parent.parent
CDN_BASE = "https://cdn.jsdelivr.net/gh/MarketingPip/bundleVFSModules@main/dist/"
MIME = {".js": "text/javascript", ".html": "text/html", ".json": "application/json"}

FF = "/home/hatch/workspace/local/firefox/firefox/firefox"
GD = "/home/hatch/workspace/local/bin/geckodriver"
VENV_PY = "/home/hatch/workspace/venvs/ffauto/bin/python"
VERDICT = Path("/tmp/exports-imports-e2e-verdict.jsonl")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, data: bytes, mime: str):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(data)

    def _404(self):
        self.send_response(404)
        self.end_headers()
        self.wfile.write(b"not found")

    def do_POST(self):
        p = unquote(self.path.split("?", 1)[0])
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n > 0 else b""
            if p == "/report":
                with open(VERDICT, "a") as f:
                    f.write(body.decode("utf-8", "replace") + "\n")
                return self._send(b"ok", "text/plain")
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
                return self._send(f.read_bytes(), MIME.get(f.suffix, "application/octet-stream"))
        except (BrokenPipeError, ConnectionResetError):
            return
        return self._404()


DRIVER = r"""
import sys, time
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

opts = Options()
opts.binary_location = __FF__
# Firefox honors proxy env vars (unreachable hatch-egress-proxy here);
# route explicitly through the local relay like ondemand-require-e2e.py.
opts.set_preference("network.proxy.type", 1)
opts.set_preference("network.proxy.http", "127.0.0.1")
opts.set_preference("network.proxy.http_port", 18080)
opts.set_preference("network.proxy.ssl", "127.0.0.1")
opts.set_preference("network.proxy.ssl_port", 18080)
opts.set_preference("network.proxy.share_proxy_settings", True)
opts.set_preference("network.proxy.no_proxies_on", "localhost,127.0.0.1")
svc = Service(executable_path=__GD__)
d = webdriver.Firefox(options=opts, service=svc)
d.set_page_load_timeout(120)
d.get(__URL__)
title = ""
deadline = time.time() + 240
while time.time() < deadline:
    try:
        title = d.title
    except Exception:
        break
    if title.startswith("E2E-PASS") or title.startswith("E2E-FAIL"):
        break
    time.sleep(2)
print("TITLE=" + title, flush=True)
try:
    body = d.find_element("id", "out").text
    print("BODY:\n" + body[-4000:], flush=True)
except Exception as e:
    print("no #out: %s" % e, flush=True)
d.quit()
sys.exit(0 if title.startswith("E2E-PASS") else 1)
"""
DRIVER = (
    DRIVER.replace("__FF__", repr(FF))
    .replace("__GD__", repr(GD))
    .replace("__URL__", repr(f"http://127.0.0.1:{PORT}/local-repo/tests/exports-imports-e2e.html"))
)


def main():
    if VERDICT.exists():
        VERDICT.unlink()
    httpd = HTTPServer(("127.0.0.1", PORT), H)
    import threading

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{PORT}/local-repo/tests/exports-imports-e2e.html"
    print("serving repo ->", url, flush=True)
    proc = subprocess.run(
        [VENV_PY, "-c", DRIVER], capture_output=True, text=True, timeout=300
    )
    print(proc.stdout[-6000:])
    print(proc.stderr[-2000:], file=sys.stderr)
    verdict_ok = None
    if VERDICT.exists():
        print("--- verdict.jsonl (crash-proof channel) ---")
        print(VERDICT.read_text()[-3000:])
        try:
            import json as _json

            last = VERDICT.read_text().strip().splitlines()[-1]
            verdict_ok = _json.loads(last).get("ok") is True
        except Exception:
            verdict_ok = False
    httpd.shutdown()
    rc = proc.returncode
    if verdict_ok is False:
        rc = 1
    if rc == 0:
        print("E2E-PASS: exports/imports resolution through the sandbox", flush=True)
    else:
        print("E2E-FAIL: exports/imports resolution through the sandbox", flush=True)
    sys.exit(rc)


if __name__ == "__main__":
    main()
