#!/usr/bin/env python3
"""Headed-Firefox E2E for the VFS-aware sync resolver.

Serves the repo over localhost HTTP, loads tests/vfs-resolve-e2e.html in
headed Firefox under Xvfb, waits for the E2E to report via document.title,
and exits 0 on E2E-PASS, 1 otherwise.

Usage: xvfb-run -a python3 tests/vfs-resolve-e2e.py
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
    # Serve the repo root so /runtime.js and /tests/vfs-resolve-e2e.html resolve.
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=REPO
    )
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/tests/vfs-resolve-e2e.html" % port
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
        "    time.sleep(0.5)\n"
        "print('TITLE=' + title, flush=True)\n"
        "try:\n"
        "    body = d.find_element('id', 'out').text\n"
        "    print('BODY:\\n' + body, flush=True)\n"
        "except Exception as e:\n"
        "    print('no #out: %%s' %% e, flush=True)\n"
        "d.quit()\n"
        "sys.exit(0 if title == 'E2E-PASS' else 1)\n"
    ) % (FF, GECKO, url)

    import subprocess
    proc = subprocess.run(
        [VENV_PY, "-c", driver_script],
        capture_output=True,
        text=True,
        timeout=180,
    )
    print(proc.stdout, flush=True)
    print(proc.stderr, file=sys.stderr, flush=True)
    httpd.shutdown()
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
