#!/usr/bin/env python3
"""Headed-Firefox E2E for esbuild-wasm through the runtime interception.

Serves the repo over localhost HTTP, loads tests/esbuild-wasm-e2e.html in
headed Firefox under Xvfb, waits for the E2E to report via document.title,
and exits 0 on E2E-PASS, 1 otherwise.

Usage: xvfb-run -a python3 tests/esbuild-wasm-e2e.py
Requires: ~/workspace/local/firefox/firefox/firefox,
          ~/workspace/local/bin/geckodriver,
          ~/workspace/venvs/ffauto (selenium).
"""
import functools
import http.server
import os
import socketserver
import sys
import threading

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FF = os.path.expanduser("~/workspace/local/firefox/firefox/firefox")
GECKO = os.path.expanduser("~/workspace/local/bin/geckodriver")
VENV_PY = os.path.expanduser("~/workspace/venvs/ffauto/bin/python")


def main():
    # Serve the repo root so /runtime.js, /src/*, /node_modules/* resolve.
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=REPO
    )
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/tests/esbuild-wasm-e2e.html" % port
    print("serving %s -> %s" % (REPO, url), flush=True)

    # Drive headed Firefox via the ffauto venv's selenium.
    driver_script = (
        "import sys, time\n"
        "from selenium import webdriver\n"
        "from selenium.webdriver.firefox.options import Options\n"
        "from selenium.webdriver.firefox.service import Service\n"
        "opts = Options()\n"
        "opts.binary_location = %r\n"
        "svc = Service(executable_path=%r)\n"
        "d = webdriver.Firefox(options=opts, service=svc)\n"
        "d.get(%r)\n"
        "title = ''\n"
        "for _ in range(120):\n"
        "    title = d.title\n"
        "    if title.startswith('E2E-'):\n"
        "        break\n"
        "    time.sleep(1)\n"
        "print('TITLE:' + title)\n"
        "try:\n"
        "    print('OUT:' + d.find_element('id', 'out').text[:2000])\n"
        "except Exception as e:\n"
        "    print('OUT-ERR:' + str(e))\n"
        "d.quit()\n"
        "sys.exit(0 if title == 'E2E-PASS' else 1)\n"
        % (FF, GECKO, url)
    )
    import subprocess
    r = subprocess.run([VENV_PY, "-c", driver_script], capture_output=True, text=True, timeout=180)
    print(r.stdout)
    print(r.stderr, file=sys.stderr)
    sys.exit(r.returncode)


if __name__ == "__main__":
    main()
