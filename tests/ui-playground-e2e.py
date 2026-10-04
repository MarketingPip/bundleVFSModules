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
  4. example buttons load snippets into #codeInput (all 20)
  5. stdin: cli example + Send button delivers input, status -> Done
  6. repeated runs: run twice back-to-back, both reach Done (no realm leak)
  7. fs example writes + reads back a file in the virtual FS

Usage: xvfb-run -a /home/hatch/workspace/venvs/ffauto/bin/python tests/ui-playground-e2e.py [port]
Exit 0 on E2E-PASS, 1 otherwise.
"""
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8937
# REPO defaults to the enclosing repo so the driver tests the tree it's run
# from — not a hardcoded checkout that may be on a different branch.
# Override with REPO=/path/to/repo to test another tree explicitly.
REPO = Path(os.environ.get("REPO", Path(__file__).resolve().parent.parent))
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

EXAMPLE_KEYS = ["basic", "async", "sleep", "imports", "require", "process_kill",
    "interop", "top_level", "typescript", "relative", "tests", "cli",
    "cli_menu", "inquirer", "repl", "repl2", "fs", "child_process",
    "http", "express"]

def run_code(d, code, argv=""):
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
    return status, output

opts = Options()
opts.binary_location = FF
svc = Service(executable_path=GD)
d = webdriver.Firefox(options=opts, service=svc)
d.set_page_load_timeout(120)
d.get(URL)
# The module script (runtime.js import + EXAMPLES dict) needs time to
# parse/evaluate before the first execute() is reliable. 5s was flaky
# with the wired examples; 15s is solid.
time.sleep(15)

results = []
for name, code, argv, want_status, want_in_output in CASES:
    status, output = run_code(d, code, argv)
    ok = (status == want_status) and all(s in output for s in want_in_output)
    results.append({"name": name, "ok": ok, "status": status,
                    "output": output[-800:]})
    print("CASE %s: %s (status=%r)" % (name, "PASS" if ok else "FAIL", status), flush=True)
    if not ok:
        print("  output tail: " + output[-800:], flush=True)

# Case 4: every example button loads its snippet into #codeInput
n_examples_ok = 0
for key in EXAMPLE_KEYS:
    btns = d.find_elements("css selector", '.example-btn[data-example="%s"]' % key)
    if not btns:
        print("CASE example-%s: FAIL (button missing)" % key, flush=True)
        results.append({"name": "example-" + key, "ok": False})
        continue
    d.execute_script("document.getElementById('codeInput').value = '';")
    btns[0].click()
    time.sleep(0.3)
    val = d.execute_script("return document.getElementById('codeInput').value;")
    ok = len(val) > 50  # a real snippet landed, not empty/placeholder
    if ok:
        n_examples_ok += 1
    else:
        print("CASE example-%s: FAIL (codeInput len=%d)" % (key, len(val)), flush=True)
    results.append({"name": "example-" + key, "ok": ok})
print("CASE examples: %d/%d buttons load snippets" % (n_examples_ok, len(EXAMPLE_KEYS)), flush=True)

# Case 5: stdin — load the cli example, run it, Send input, expect echo + Done
d.execute_script("document.getElementById('codeInput').value = '';")
d.find_element("css selector", '.example-btn[data-example="cli"]').click()
time.sleep(0.3)
d.execute_script("document.getElementById('argvInput').value = '';")
d.find_element("id", "runBtn").click()
# Wait until the sandbox is actually listening (prompt in output),
# not a fixed sleep — boot time varies.
prompt_seen = False
deadline = time.time() + 60
while time.time() < deadline:
    output = d.find_element("id", "output").text
    if "Waiting for your input" in output:
        prompt_seen = True
        break
    status = d.execute_script("return document.getElementById('status').textContent;")
    if status in ("Done", "Error"):
        break
    time.sleep(1)
if prompt_seen:
    d.execute_script("document.getElementById('stdinInput').value = 'hello-stdin';")
    d.find_element("id", "sendInput").click()
status = ""
deadline = time.time() + 60
while time.time() < deadline:
    status = d.execute_script("return document.getElementById('status').textContent;")
    if status in ("Done", "Error"):
        break
    time.sleep(1)
output = d.find_element("id", "output").text
ok = (status == "Done") and ("hello-stdin" in output) and ("HELLO-STDIN" in output)
results.append({"name": "stdin", "ok": ok, "status": status})
print("CASE stdin: %s (status=%r, prompt_seen=%r)" % ("PASS" if ok else "FAIL", status, prompt_seen), flush=True)
if not ok:
    print("  output tail: " + output[-800:], flush=True)

# Case 6: repeated runs — same code twice, both must reach Done
r1_status, _ = run_code(d, "console.log('run-one');", "")
r2_status, r2_output = run_code(d, "console.log('run-two');", "")
ok = (r1_status == "Done") and (r2_status == "Done") and ("run-two" in r2_output)
results.append({"name": "repeated-runs", "ok": ok})
print("CASE repeated-runs: %s (%r, %r)" % ("PASS" if ok else "FAIL", r1_status, r2_status), flush=True)

# Case 7: fs example — write + read back in the virtual FS
d.execute_script("document.getElementById('codeInput').value = '';")
d.find_element("css selector", '.example-btn[data-example="fs"]').click()
time.sleep(0.3)
status, output = run_code(d, d.execute_script("return document.getElementById('codeInput').value;"), "")
ok = (status == "Done") and ("Hello, virtual FS!" in output) and ("Read back:" in output)
results.append({"name": "fs-example", "ok": ok, "status": status})
print("CASE fs-example: %s (status=%r)" % ("PASS" if ok else "FAIL", status), flush=True)
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
