#!/usr/bin/env python3
"""Clang-WASI browser proof driver (v1 gate #4).

Serves the worktree at /local-repo (runtime.js with ONLY _builtinBaseUrl
rewritten to the local worktree dist/ — the repo file is untouched), loads
tests/clang-wasi-e2e.html in headed Firefox under Xvfb, waits for the
E2E verdict via document.title AND POST /report (crash-proof), exits 0 on
E2E-PASS, 1 otherwise.

Proves: a REAL Clang-produced WASI binary (tests/fixtures/hello-wasi.wasm)
-> node:wasi in _build_file -> executed in sandbox -> program stdout
arrives via result.logs. Real browser, no mocks.

Usage: xvfb-run -a /home/hatch/workspace/venvs/ffauto/bin/python tests/clang-wasi-e2e.py [port]
"""
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8934
# REPO defaults to the enclosing repo so the driver tests the tree it's run
# from — not a hardcoded checkout that may be on a different branch.
# Override with REPO=/path/to/repo to test another tree explicitly.
REPO = Path(os.environ.get("REPO", Path(__file__).resolve().parent.parent))
CDN_BASE = "https://cdn.jsdelivr.net/gh/MarketingPip/bundleVFSModules@main/dist/"
MIME = {".js": "text/javascript", ".html": "text/html", ".json": "application/json",
        ".wasm": "application/wasm"}

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

    def do_POST(self):
        p = unquote(self.path.split("?", 1)[0])
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n > 0 else b""
            if p == "/report":
                with open("/tmp/clang-wasi-e2e-verdict.jsonl", "a") as f:
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
                ext = f.suffix
                return self._send(f.read_bytes(), MIME.get(ext, "application/octet-stream"))
        except (BrokenPipeError, ConnectionResetError):
            return
        return self._404()


def main():
    httpd = HTTPServer(("127.0.0.1", PORT), H)
    import threading

    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{PORT}/local-repo/tests/clang-wasi-e2e.html"
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
        "    print('BODY:\\\\n' + body[-4000:], flush=True)\n"
        "except Exception as e:\n"
        "    print('no #out: %%s' %% e, flush=True)\n"
        "d.quit()\n"
        "sys.exit(0 if title.startswith('E2E-PASS') else 1)\n"
    ) % (FF, GD, url)

    proc = subprocess.run(
        [VENV_PY, "-c", driver_script], capture_output=True, text=True, timeout=300
    )
    print(proc.stdout[-6000:])
    print(proc.stderr[-2000:], file=sys.stderr)
    vf = Path("/tmp/clang-wasi-e2e-verdict.jsonl")
    verdict_ok = None
    if vf.exists():
        print("--- verdict.jsonl (crash-proof channel) ---")
        print(vf.read_text()[-3000:])
        # Crash-proof verdict: the last line is authoritative. The driver
        # title check can miss failures (e.g. watchdog report() doesn't set
        # document.title), so a non-ok verdict forces a non-zero exit.
        try:
            import json as _json
            last = vf.read_text().strip().splitlines()[-1]
            verdict_ok = _json.loads(last).get("ok") is True
        except Exception:
            verdict_ok = False
    httpd.shutdown()
    # Exit 0 only if BOTH the title check passed AND the crash-proof verdict
    # (if any) is ok. A missing verdict file is not a failure by itself.
    rc = proc.returncode
    if verdict_ok is False:
        rc = 1
    sys.exit(rc)


if __name__ == "__main__":
    main()
