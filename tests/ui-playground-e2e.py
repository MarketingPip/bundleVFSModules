#!/usr/bin/env python3
"""ui.html playground proof: the landing-page playground wired to the v1 runtime.

Serves the worktree root (ui.html + runtime.js with the CDN dist base
rewritten to local dist/), loads ui.html in headed Firefox under Xvfb,
drives the real playground UI (set #codeInput, click #runBtn), and asserts
on #output / #status. No mocks — the genuine CodeSandbox consumption path.

Cases:
  1. basic console.log output renders, status -> Done
  2. thrown error renders, status -> Error
  3. argv input is parsed and visible as process.argv.slice(2)

Usage: xvfb-run -a /home/hatch/workspace/venvs/ffauto/bin/python tests/ui-playground-e2e.py [port]
Exit 0 on E2E-PASS, 1 otherwise.
"""
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8937
REPO = Path("/home/hatch/workspace/bundleVFSModules-vite7")
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
            if p in ("/", "/ui.html"):
                return self._send((REPO / "ui.html").read_bytes(), MIME[".html"])
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

CASES = [
    ("basic",
     "console.log('hello ui');\nconsole.log(40 + 2);",
     "",
     "Done",
     ["hello ui", "42"]),
    ("error",
     "throw new Error('boom-test');",
     "",
     "Error",
     ["boom-test"]),
    ("argv",
     "console.log(JSON.stringify(process.argv.slice(2)));",
     "--name John --age 22",
     "Done",
     ['"--name"', '"John"', '"--age"', '"22"']),
]

opts = Options()
opts.binary_location = FF
svc = Service(executable_path=GD)
d = webdriver.Firefox(options=opts, service=svc)
d.set_page_load_timeout(120)
d.get(URL)
time.sleep(3)  # let the module script import runtime.js and wire buttons

results = []
for name, code, argv, want_status, want_in_output in CASES:
    d.execute_script("document.getElementById('codeInput').value = arguments[0];", code)
    d.execute_script("document.getElementById('argvInput').value = arguments[0];", argv)
    d.find_element("id", "runBtn").click()
    status = ""
    deadline = time.time() + 90
    while time.time() < deadline:
        status = d.execute_script("return document.getElementById('status').textContent;")
        if status in ("Done", "Error"):
            break
        time.sleep(1)
    output = d.find_element("id", "output").text
    ok = (status == want_status) and all(s in output for s in want_in_output)
    results.append({"name": name, "ok": ok, "status": status,
                    "output": output[-800:]})
    print("CASE %s: %s (status=%r)" % (name, "PASS" if ok else "FAIL", status), flush=True)
    if not ok:
        print("  output tail: " + output[-800:], flush=True)

d.quit()
n_fail = sum(1 for r in results if not r["ok"])
print("RESULT: %d/%d cases passed" % (len(results) - n_fail, len(results)), flush=True)
sys.exit(0 if n_fail == 0 else 1)
"""
DRIVER = DRIVER.replace("__FF__", repr(FF)).replace("__GD__", repr(GD)).replace(
    "__URL__", repr(f"http://127.0.0.1:{PORT}/ui.html"))


def main():
    httpd = HTTPServer(("127.0.0.1", PORT), H)
    import threading

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print("serving worktree ui.html ->", f"http://127.0.0.1:{PORT}/ui.html", flush=True)
    proc = subprocess.run(
        [VENV_PY, "-c", DRIVER], capture_output=True, text=True, timeout=420
    )
    print(proc.stdout[-6000:])
    print(proc.stderr[-2000:], file=sys.stderr)
    httpd.shutdown()
    if proc.returncode == 0:
        print("E2E-PASS: ui.html playground wired to v1 runtime", flush=True)
    else:
        print("E2E-FAIL: ui.html playground", flush=True)
    sys.exit(proc.returncode)


if __name__ == "__main__":
    main()
