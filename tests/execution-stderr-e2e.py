#!/usr/bin/env python3
"""execution:stderr alias proof: the derived stderr event fires for
console.error/console.warn only, while execution:stdout keeps firing
for every console.* call (backward compatible).

Serves the bvm-stderr-alias worktree root (runtime.js with the CDN dist
base rewritten to local dist/), loads tests/execution-stderr-e2e.html
in headed Firefox under Xvfb, and asserts on the recorded events.
No mocks — the genuine CodeSandbox consumption path.

Usage: xvfb-run -a /home/hatch/workspace/venvs/ffauto/bin/python tests/execution-stderr-e2e.py [port]
Exit 0 on E2E-PASS, 1 otherwise.
"""
import subprocess
import sys
import time
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8945
REPO = Path("/home/hatch/workspace/worktrees/bvm-stderr-alias")
CDN_BASE = "https://cdn.jsdelivr.net/gh/MarketingPip/bundleVFSModules@main/dist/"
MIME = {".js": "text/javascript", ".html": "text/html", ".json": "application/json"}

FF = "/home/hatch/workspace/local/firefox/firefox/firefox"
GD = "/home/hatch/workspace/local/bin/geckodriver"
VENV_PY = "/home/hatch/workspace/venvs/ffauto/bin/python"


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
import sys, time, json
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

FF = __FF__
GD = __GD__
URL = __URL__

opts = Options()
opts.binary_location = FF
svc = Service(executable_path=GD)
d = webdriver.Firefox(options=opts, service=svc)
d.set_page_load_timeout(120)
d.get(URL)

# Wait for the page to finish the sandbox run.
deadline = time.time() + 120
while time.time() < deadline:
    if d.execute_script("return document.title;") == "E2E-DONE":
        break
    time.sleep(1)

raw = d.execute_script("return document.getElementById('result').textContent;")
d.quit()
seen = json.loads(raw)
print("SEEN: " + json.dumps(seen)[:2000], flush=True)

def types(evts):
    return [(e.get("type"), e.get("args")) for e in evts]

stdout_types = [t for t, _ in types(seen.get("stdout", []))]
stderr_types = [t for t, _ in types(seen.get("stderr", []))]

checks = []
def check(name, cond):
    checks.append((name, cond))
    print(("PASS " if cond else "FAIL ") + name, flush=True)

# 1. execution:stdout still fires for every console.* call (backward compat)
for m in ["log", "error", "warn", "info", "debug"]:
    check("stdout fires for console.%s" % m, m in stdout_types)

# 2. execution:stderr fires ONLY for error and warn (Node fd-2 semantics)
check("stderr fires for console.error", "error" in stderr_types)
check("stderr fires for console.warn", "warn" in stderr_types)
check("stderr does NOT fire for console.log", "log" not in stderr_types)
check("stderr does NOT fire for console.info", "info" not in stderr_types)
check("stderr does NOT fire for console.debug", "debug" not in stderr_types)

# 3. payload shape mirrors stdout: {type, args}
def payload_ok(evts, want_type, want_marker):
    for e in evts:
        if e.get("type") == want_type and want_marker in str(e.get("args")):
            return True
    return False
check("stderr error payload carries args", payload_ok(seen.get("stderr", []), "error", "ERROR-MARKER"))
check("stderr warn payload carries args", payload_ok(seen.get("stderr", []), "warn", "WARN-MARKER"))
check("stdout log payload carries args", payload_ok(seen.get("stdout", []), "log", "LOG-MARKER"))

n_fail = sum(1 for _, ok in checks if not ok)
print("RESULT: %d/%d checks passed" % (len(checks) - n_fail, len(checks)), flush=True)
sys.exit(0 if n_fail == 0 else 1)
"""
DRIVER = DRIVER.replace("__FF__", repr(FF)).replace("__GD__", repr(GD)).replace(
    "__URL__", repr(f"http://127.0.0.1:{PORT}/tests/execution-stderr-e2e.html"))


def main():
    httpd = HTTPServer(("127.0.0.1", PORT), H)
    import threading

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print("serving worktree ->", f"http://127.0.0.1:{PORT}/tests/execution-stderr-e2e.html", flush=True)
    proc = subprocess.run(
        [VENV_PY, "-c", DRIVER], capture_output=True, text=True, timeout=420
    )
    print(proc.stdout[-6000:])
    print(proc.stderr[-2000:], file=sys.stderr)
    httpd.shutdown()
    if proc.returncode == 0:
        print("E2E-PASS: execution:stderr alias", flush=True)
    else:
        print("E2E-FAIL: execution:stderr alias", flush=True)
    sys.exit(proc.returncode)


if __name__ == "__main__":
    main()
