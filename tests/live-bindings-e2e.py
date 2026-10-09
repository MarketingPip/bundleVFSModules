#!/usr/bin/env python3
"""Live-bindings browser E2E: REAL ESM live bindings in a REAL browser.

Serves the repo root (runtime.js with the CDN dist base rewritten to local
dist/), loads tests/live-bindings-e2e.html in headed Firefox under Xvfb.
The harness drives the genuine CodeSandbox consumption path: VFS modules
seeded via config.fs, entry executed with static named/default/namespace
imports plus a re-export chain.

Cases (needles in #output):
  LB_STATIC_1=1 / LB_STATIC_2=2  - static `import { count }` sees bump()s
  LB_NS=2                        - namespace import is live
  LB_READER=2                    - cross-module liveness (reader module)
  LB_REEXPORT=2                  - `export { count } from` chain is live
  LB_DEFAULT=42                  - live default binding
  LB_STATIC_TICK=3               - read after a later-tick mutation

The OLD snapshot behavior (`const { count } = __lm` at import time + the
proxy reading its load-time copy) prints 0 for every LB_STATIC_* needle,
so these needles assert the snapshot behavior is GONE.

Usage: xvfb-run -a /home/hatch/workspace/venvs/ffauto/bin/python tests/live-bindings-e2e.py [port]
Exit 0 on E2E-PASS, 1 otherwise.
"""
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8939
# REPO defaults to the enclosing repo so the driver tests the tree it's run
# from - not a hardcoded checkout that may be on a different branch.
# Override with REPO=/path/to/repo to test another tree explicitly.
REPO = Path(os.environ.get("REPO", Path(__file__).resolve().parent.parent))
CDN_BASE = "https://cdn.jsdelivr.net/gh/MarketingPip/bundleVFSModules@main/dist/"
MIME = {".js": "text/javascript", ".html": "text/html", ".json": "application/json"}

FF = "/home/hatch/workspace/local/firefox/firefox/firefox"
GD = "/home/hatch/workspace/local/bin/geckodriver"
VENV_PY = "/home/hatch/workspace/venvs/ffauto/bin/python"

NEEDLES = [
    "LB_STATIC_1=1",
    "LB_STATIC_2=2",
    "LB_NS=2",
    "LB_READER=2",
    "LB_REEXPORT=2",
    "LB_DEFAULT=42",
    "LB_STATIC_TICK=3",
]


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, data: bytes, mime: str):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _404(self):
        self.send_response(404)
        self.end_headers()
        self.wfile.write(b"not found")

    def do_GET(self):
        p = unquote(self.path.split("?", 1)[0])
        try:
            if p == "/runtime.js":
                src = (REPO / "runtime.js").read_text()
                assert CDN_BASE in src, "CDN base string moved in runtime.js"
                local = f"http://127.0.0.1:{PORT}/dist/"
                src = src.replace(CDN_BASE, local)
                return self._send(src.encode(), MIME[".js"])
            rel = p.lstrip("/")
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

FF = __FF__
GD = __GD__
URL = __URL__
NEEDLES = __NEEDLES__

opts = Options()
opts.binary_location = FF
# Firefox honors proxy env vars; the sandbox's hatch-egress-proxy is
# unreachable from here, which would wedge module loading. Route explicitly
# through the local relay; localhost stays direct for the test server.
opts.set_preference("network.proxy.type", 1)
opts.set_preference("network.proxy.http", "127.0.0.1")
opts.set_preference("network.proxy.http_port", 18080)
opts.set_preference("network.proxy.ssl", "127.0.0.1")
opts.set_preference("network.proxy.ssl_port", 18080)
opts.set_preference("network.proxy.share_proxy_settings", True)
opts.set_preference("network.proxy.no_proxies_on", "localhost,127.0.0.1")
svc = Service(executable_path=GD)
d = webdriver.Firefox(options=opts, service=svc)
d.set_page_load_timeout(120)
d.get(URL)
# runtime.js is large; the module script needs time to parse/evaluate and
# the sandbox entry needs time to run (two awaits + a 50ms timer).
time.sleep(20)

status = ""
deadline = time.time() + 120
while time.time() < deadline:
    status = d.execute_script("return document.getElementById('status').textContent;")
    if status in ("Done", "Error"):
        break
    time.sleep(2)
output = d.execute_script("return document.getElementById('output').textContent;")
d.quit()

missing = [n for n in NEEDLES if n not in output]
ok = (status == "Done") and not missing
print("STATUS=%r" % status, flush=True)
print("OUTPUT:\n" + output[-3000:], flush=True)
if missing:
    print("MISSING NEEDLES: %s" % missing, flush=True)
print("E2E %s" % ("PASS" if ok else "FAIL"), flush=True)
sys.exit(0 if ok else 1)
"""
DRIVER = (
    DRIVER.replace("__FF__", repr(FF))
    .replace("__GD__", repr(GD))
    .replace("__URL__", repr(f"http://127.0.0.1:{PORT}/tests/live-bindings-e2e.html"))
    .replace("__NEEDLES__", repr(NEEDLES))
)


def main():
    httpd = HTTPServer(("127.0.0.1", PORT), H)
    import threading

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print("serving live-bindings harness ->", f"http://127.0.0.1:{PORT}/tests/live-bindings-e2e.html", flush=True)
    proc = subprocess.run(
        [VENV_PY, "-c", DRIVER], capture_output=True, text=True, timeout=600
    )
    print(proc.stdout[-8000:])
    print(proc.stderr[-2000:], file=sys.stderr)
    httpd.shutdown()
    if proc.returncode == 0:
        print("E2E-PASS: live bindings browser matrix", flush=True)
    else:
        print("E2E-FAIL: live bindings browser matrix", flush=True)
    sys.exit(proc.returncode)


if __name__ == "__main__":
    main()
