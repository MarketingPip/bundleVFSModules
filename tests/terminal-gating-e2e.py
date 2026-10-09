#!/usr/bin/env python3
"""Terminal modes + completion gating E2E for the ui.html playground.

Same driver pattern as tests/ui-playground-e2e.py: serves the worktree root
(ui.html + runtime.js with the CDN dist base rewritten to local dist/), loads
ui.html in headed Firefox under Xvfb, drives the real playground UI, asserts
on #output / #status / the xterm surface. No mocks.

Cases:
  1. dom-basic: console.log run in the default DOM terminal -> Done.
  2. fetch-gate: unawaited fetch('https://httpbin.org/delay/2') (NOT awaited)
     must hold completion: Done arrives only after the fetch settles
     (elapsed >= 2s, the endpoint's server-side delay), and no output
     arrives after Done (gate drained everything).
  3. stdin-hold: code awaiting readline input keeps status at "Running..."
     (sampled twice, seconds apart) until input arrives. The gate is
     event-driven -- runtime.js waits on process.stdin.waitUntilNoListeners()
     (runtime.js ~L7274-7277), released via the 'removeListener' event ->
     _checkResolve() (~L8162, ~L8250); there is no poll loop on that path.
     After answering, rl.close() + process.stdin.end() releases the gate ->
     Done promptly (latency reported).
  4. exit-releases: process.exit(0) with a live stdin listener -> 'kill'
     interop -> success -> Done promptly, "Process Exited" in the logs.
  5. import-process-exit: `import proc from 'node:process'; proc.exit(0)`
     takes the same 'kill' path -> Done.
  6. xterm mode (?xterm=1): xtermToggle label reads "Terminal: xterm", the
     xterm surface attaches inside #output, a basic run routes through
     term.write (no DOM print-divs created -- the DOM fallback path is not
     taken) and status -> Done. The xterm stdin path (sendInput ->
     __stdin__) + process.exit() also releases the gate. NOTE: marker text
     inside .xterm-rows is deliberately NOT asserted -- xterm 5.3.0's DOM
     renderer never paints rows in this headless Firefox (verified via the
     buffer API: writes parse, rAF fires, rows stay empty), an xterm/
     environment quirk orthogonal to completion gating.

Honest-behavior notes (verified against runtime.js, not just asserted):
  * waitUntilNoListeners() resolves immediately when no listeners are
    attached, and on stdin.end()/destroy() via _ended. _checkResolve()
    counts every entry in stdin._events -- including the runtime's own
    internal 'newListener'/'removeListener' bookkeeping listeners -- so
    rl.close() ALONE (listener removal without end()) does not release the
    gate; user code must call process.stdin.end() (as case 3 does) or
    process.exit(). Reported to the parent as a runtime bug with this
    repro; runtime.js is not touched by this test.
  * A raw process.stdin.once('data', ...) one-shot has the same property:
    the once-listener is dropped by emit() without a 'removeListener'
    event, so _checkResolve() never fires for it -- end()/exit() is still
    the release path.

Usage: xvfb-run -a /home/hatch/workspace/venvs/ffauto/bin/python tests/terminal-gating-e2e.py [port]
Exit 0 on E2E-PASS, 1 otherwise.
"""
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8938
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
import sys, time
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

FF = __FF__
GD = __GD__
URL = __URL__

results = []

def case(name, ok, extra=""):
    results.append({"name": name, "ok": bool(ok)})
    print("CASE %s: %s%s" % (name, "PASS" if ok else "FAIL", (" " + extra) if extra else ""), flush=True)

def status_of(d):
    return d.execute_script("return document.getElementById('status').textContent;")

def output_text(d):
    return d.find_element("id", "output").text

def wait_status(d, timeout=90):
    deadline = time.time() + timeout
    s = ""
    while time.time() < deadline:
        s = status_of(d)
        if s in ("Done", "Error"):
            break
        time.sleep(1)
    return s

def wait_output_contains(d, needle, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if needle in output_text(d):
            return True
        if status_of(d) in ("Done", "Error"):
            return needle in output_text(d)
        time.sleep(1)
    return needle in output_text(d)

def run_code(d, code):
    d.execute_script("document.getElementById('codeInput').value = arguments[0];", code)
    d.execute_script("document.getElementById('argvInput').value = '';")
    t0 = time.time()
    d.find_element("id", "runBtn").click()
    s = wait_status(d)
    return s, output_text(d), time.time() - t0

def send_stdin(d, text):
    d.execute_script("document.getElementById('stdinInput').value = arguments[0];", text)
    d.find_element("id", "sendInput").click()

def make_driver():
    opts = Options()
    opts.binary_location = FF
    # Same proxy discipline as tests/ui-playground-e2e.py: Firefox honors
    # proxy prefs; the sandbox's hatch-egress-proxy env is unreachable, so
    # route explicitly through the local relay. Localhost stays direct.
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
    return d

# ---------- session 1: DOM terminal (default) ----------
d = make_driver()
d.get(URL)
time.sleep(15)  # module script (runtime.js + examples) needs parse/eval time

# Case 1: dom-basic
s, out, _ = run_code(d, "console.log('hello-term');\nconsole.log(6 * 7);")
case("dom-basic", s == "Done" and "hello-term" in out and "42" in out,
     "(status=%r)" % s)

# Case 2: fetch-gate -- fetch fired WITHOUT await; the patched fetch
# registers in pendingFetches at call time, so waitForAllFetches() holds
# completion until it settles. httpbin /delay/2 guarantees >= 2s
# server-side; without the gate Done would land in ~0.2s (100ms drain).
t0 = time.time()
d.execute_script("document.getElementById('codeInput').value = arguments[0];",
    "fetch('https://httpbin.org/delay/2')"
    ".then(r => console.log('FETCH-SETTLED:' + r.status))"
    ".catch(e => console.log('FETCH-SETTLED:ERR'));"
    "console.log('SYNC-PART-DONE');")
d.execute_script("document.getElementById('argvInput').value = '';")
d.find_element("id", "runBtn").click()
s = wait_status(d, timeout=120)
elapsed = time.time() - t0
# The .then log races the function_results postMessage; poll briefly.
deadline = time.time() + 15
while "FETCH-SETTLED:" not in output_text(d) and time.time() < deadline:
    time.sleep(0.5)
out_at_done = output_text(d)
time.sleep(3)
out_later = output_text(d)
ok = (s == "Done" and elapsed >= 2.0 and "FETCH-SETTLED:200" in out_at_done
      and out_at_done == out_later)
case("fetch-gate", ok,
     "(status=%r elapsed=%.1fs settled=%r stable=%r)" % (
         s, elapsed, "FETCH-SETTLED:200" in out_at_done,
         out_at_done == out_later))
if not ok:
    print("  output tail: " + out_later[-600:], flush=True)

# Case 3: stdin-hold + release -- readline question with NO early exit.
# While the stdin listener is attached the status must stay out of Done;
# answering then ending stdin releases the gate promptly.
d.execute_script("document.getElementById('codeInput').value = arguments[0];",
    "import readline from 'node:readline';\n"
    "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });\n"
    "console.log('ASK-NAME');\n"
    "const ans = await new Promise((res) => rl.question('What is your name? ', res));\n"
    "rl.close();\n"
    "process.stdin.end();\n"
    "console.log('GOT:' + ans);")
d.execute_script("document.getElementById('argvInput').value = '';")
d.find_element("id", "runBtn").click()
prompt_ok = wait_output_contains(d, "ASK-NAME", timeout=60)
time.sleep(3)
s1 = status_of(d)
time.sleep(3)
s2 = status_of(d)
hold_ok = prompt_ok and s1 == "Running\u2026" and s2 == "Running\u2026"
t_in = time.time()
send_stdin(d, "Jared")
s = wait_status(d, timeout=30)
release_latency = time.time() - t_in
out = output_text(d)
release_ok = (s == "Done" and "GOT:Jared" in out and release_latency < 15)
case("stdin-hold", hold_ok,
     "(prompt=%r s@+3s=%r s@+6s=%r)" % (prompt_ok, s1, s2))
case("stdin-release", release_ok,
     "(status=%r latency=%.1fs got=%r)" % (s, release_latency, "GOT:Jared" in out))
if not (hold_ok and release_ok):
    print("  output tail: " + out[-600:], flush=True)

# Case 3b: listener-removal release (regression for the _checkResolve bug
# fixed 2026-10-09): readline close() WITHOUT process.stdin.end() must
# release the stdin gate. Previously the gate never released via listener
# removal because _checkResolve counted the runtime's own internal
# newListener/removeListener bookkeeping listeners.
d.execute_script("document.getElementById('codeInput').value = arguments[0];",
    "import readline from 'node:readline';\n"
    "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });\n"
    "console.log('ASK-NOEND');\n"
    "const ans = await new Promise((res) => rl.question('Name? ', res));\n"
    "rl.close();\n"
    "console.log('CLOSED:' + ans);")
d.execute_script("document.getElementById('argvInput').value = '';")
d.find_element("id", "runBtn").click()
prompt_ok = wait_output_contains(d, "ASK-NOEND", timeout=60)
send_stdin(d, "NoEnd")
s = wait_status(d, timeout=30)
out = output_text(d)
case("stdin-close-releases",
     prompt_ok and s == "Done" and "CLOSED:NoEnd" in out,
     "(status=%r)" % s)
if s != "Done":
    print("  output tail: " + out[-600:], flush=True)

# Case 3c: once-listener auto-drop release (regression for the emit()
# silent-drop bug): a one-shot 'data' listener must not hold completion
# after it fires. Previously emit() dropped once-listeners without firing
# 'removeListener', so the gate stayed stuck until stdin.end().
d.execute_script("document.getElementById('codeInput').value = arguments[0];",
    "console.log('ONCE-ARMED');\n"
    "await new Promise((res) => process.stdin.once('data', () => { console.log('ONCE-GOT'); res(); }));\n"
    "console.log('ONCE-DONE');")
d.execute_script("document.getElementById('argvInput').value = '';")
d.find_element("id", "runBtn").click()
armed_ok = wait_output_contains(d, "ONCE-ARMED", timeout=60)
send_stdin(d, "ping")
s = wait_status(d, timeout=30)
out = output_text(d)
case("stdin-once-releases",
     armed_ok and s == "Done" and "ONCE-GOT" in out and "ONCE-DONE" in out,
     "(status=%r)" % s)
if s != "Done":
    print("  output tail: " + out[-600:], flush=True)

# Case 4: exit-releases -- a live stdin listener + process.exit(0) must
# still finish promptly via the 'kill' interop path (bypasses the gates).
s, out, elapsed = run_code(d,
    "process.stdin.once('data', () => {});\n"
    "console.log('EXIT-ARMED');\n"
    "setTimeout(() => { console.log('EXITING'); process.exit(0); }, 800);")
case("exit-releases",
     s == "Done" and "Process Exited" in out and elapsed < 15,
     "(status=%r elapsed=%.1fs)" % (s, elapsed))

# Case 5: import-process-exit -- node:process exit posts 'kill' too.
s, out, elapsed = run_code(d,
    "import proc from 'node:process';\n"
    "console.log('IMPORT-EXIT-ARMED');\n"
    "proc.exit(0);")
case("import-process-exit",
     s == "Done" and "Process Exited" in out,
     "(status=%r elapsed=%.1fs)" % (s, elapsed))
d.quit()

# ---------- session 2: xterm terminal (?xterm=1) ----------
d = make_driver()
d.get(URL + "?xterm=1")
time.sleep(15)

# Case 6a: the toggle button reflects the mode.
label = d.find_element("id", "xtermToggle").text
case("xterm-toggle-label", label == "Terminal: xterm", "(label=%r)" % label)

# The xterm.js module loads async from esm.sh; wait for its surface.
# (No canvas assertion: xterm 5.3.0's only renderer is its DOM renderer --
# the canvas renderer was removed in 5.0 -- and it does not paint in this
# headless Firefox. Surface attachment is the deterministic signal.)
deadline = time.time() + 90
xterm_n = 0
while time.time() < deadline:
    xterm_n = d.execute_script(
        "return document.querySelectorAll('#output .xterm').length;")
    if xterm_n:
        break
    time.sleep(1)
case("xterm-surface", xterm_n >= 1, "(xterm_n=%d)" % xterm_n)

# Case 6b: basic run goes through term.write into the xterm surface and
# status -> Done. Deterministic contract (measured 2026-10-09):
# - #output .xterm is attached (initXtermTerminal succeeded; on CDN
#   failure the playground falls back to DOM mode and no .xterm exists).
# - print() takes the `if (term)` branch, so NO DOM print-divs are created:
#   #output's only non-.xterm child stays the initial placeholder div
#   (term.clear() does not remove it). dom_divs == 1 proves the output did
#   NOT go through the DOM fallback path.
# - NOT asserted: marker text inside .xterm-rows. xterm 5.3.0's DOM
#   renderer (its only renderer; the canvas renderer was removed in 5.0)
#   never paints rows in this headless Firefox: rAF fires (~44/s, page
#   visible) and term.buffer parses writes correctly (verified via the
#   buffer API in probes), but .xterm-rows stays empty -- an xterm/
#   headless-Firefox environment quirk, orthogonal to the runtime's
#   completion gating. Asserting on it would be flaky by construction.
s, _, elapsed = run_code(d, "console.log('hello-xterm');\nconsole.log(6 * 7);")
xterm_n = d.execute_script(
    "return document.querySelectorAll('#output .xterm').length;")
dom_divs = d.execute_script(
    "return document.querySelectorAll('#output > div:not(.xterm)').length;")
ok = (s == "Done" and xterm_n >= 1 and dom_divs == 1)
case("xterm-basic", ok,
     "(status=%r xterm_n=%d dom_divs=%d elapsed=%.1fs)" % (
         s, xterm_n, dom_divs, elapsed))
if not ok:
    print("  output html head: " + d.execute_script(
        "return document.getElementById('output').innerHTML.slice(0,300);"),
        flush=True)

# Case 6c: xterm stdin path (sendInput -> __stdin__) + process.exit()
# releases the gate -> Done. No prompt-text wait: the xterm renderer does
# not paint here, so we sleep past sandbox boot (~8-13s measured) and rely
# on the runtime's early-input buffering (_pendingStdin flushes on the
# first 'data' listener). Done proves input was delivered, the once
# handler ran, and process.exit(0) took the 'kill' path.
d.execute_script("document.getElementById('codeInput').value = arguments[0];",
    "console.log('XTERM-ASK');\n"
    "process.stdin.once('data', (c) => { console.log('XTERM-GOT:' + c.toString().trim()); process.exit(0); });")
d.execute_script("document.getElementById('argvInput').value = '';")
d.find_element("id", "runBtn").click()
time.sleep(15)  # sandbox boot; must stay well under the 30s run timeout
send_stdin(d, "xterm-input")
s = wait_status(d, timeout=40)
case("xterm-stdin-exit", s == "Done", "(status=%r)" % s)
if s != "Done":
    print("  status text: %r" % status_of(d), flush=True)

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
        [VENV_PY, "-c", DRIVER], capture_output=True, text=True, timeout=600
    )
    print(proc.stdout[-8000:])
    print(proc.stderr[-2000:], file=sys.stderr)
    httpd.shutdown()
    if proc.returncode == 0:
        print("E2E-PASS: terminal modes + completion gating", flush=True)
    else:
        print("E2E-FAIL: terminal modes + completion gating", flush=True)
    sys.exit(proc.returncode)


if __name__ == "__main__":
    main()
