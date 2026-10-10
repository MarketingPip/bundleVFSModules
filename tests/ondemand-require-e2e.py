#!/usr/bin/env python3
"""On-demand require browser matrix: require()/loadModule semantics in a REAL browser.

Serves the repo root (ui.html + runtime.js with the CDN dist base rewritten
to local dist/), loads ui.html in headed Firefox under Xvfb, drives the real
playground UI (set #codeInput, click #runBtn), and asserts on #output /
#status. No mocks - the genuine CodeSandbox consumption path.

Covers docs/E2E_FEATURE_MATRIX.md "Other matrix items":
  a. cold nested static require: require('fs') inside a function that runs.
     Lazy-on-call: the call triggers the async load and returns a promise
     for the module (a synchronous require() cannot block the browser event
     loop waiting for the loader); warm requires stay synchronous.
  b. dynamic require(moduleName): variable specifier, cold (promise) and
     warm (synchronous).
  c. uncalled dynamic require/import: declared but never called - must not
     crash, must not fetch eagerly.
  d. never-reached conditional/block imports: if(false){ require(...) } at
     top level still hoists (eager, by design); if(false){ await import() }
     stays lazy.
  e. import->require and require->import identity: same instance both ways.
  f. live bindings: export-let reassignment inside a shim IS visible
     through the interop proxy (named imports compile to live member
     access; the proxy reads the real ESM namespace); same-object mutation
     IS visible (identity).
  g. side-effect count: diagnostics_channel registry is a singleton across
     import+require (module evaluated exactly once).
  h. CJS default/named export shape through interop.
  i. sandbox identity: require('buffer').Buffer === globalThis.Buffer.

Usage: xvfb-run -a /home/hatch/workspace/venvs/ffauto/bin/python tests/ondemand-require-e2e.py [port]
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
# from - not a hardcoded checkout that may be on a different branch.
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

# (name, code, want_status, needles that must appear in #output)
CASES = [
    # (a) cold nested static require: no top-level import of querystring
    # anywhere. NOTE: 'fs' is NOT cold here - the sandbox boot preloads it
    # (initSandboxState: await loadModule("fs")), so querystring (tiny, pure,
    # never boot-loaded) is the genuinely cold builtin.
    # Lazy-on-call: the call triggers the load; cold -> promise, so await it.
    ("a-cold-nested-require",
     "function getQs() { return require('querystring'); }\n"
     "const maybeQs = getQs();\n"
     "const qs = (maybeQs && typeof maybeQs.then === 'function') ? await maybeQs : maybeQs;\n"
     "const parsed = qs.parse('a=1&b=2');\n"
     "console.log('COLD_QS=' + (parsed.a === '1' && parsed.b === '2'));\n"
     "console.log('COLD_WAS_PROMISE=' + (typeof maybeQs.then === 'function'));\n"
     "// now warm: the next nested require must be synchronous\n"
     "const warmQs = getQs();\n"
     "console.log('COLD_THEN_WARM_SYNC=' + (warmQs && typeof warmQs.then === 'undefined' && warmQs === qs));",
     "Done",
     ["COLD_QS=true", "COLD_WAS_PROMISE=true", "COLD_THEN_WARM_SYNC=true"]),

    # (a2) concurrent cold nested requires share one load -> same instance.
    ("a-concurrent-cold-require",
     "function getQs() { return require('querystring'); }\n"
     "async function unwrap(m) { return (m && typeof m.then === 'function') ? await m : m; }\n"
     "const [qa, qb] = await Promise.all([unwrap(getQs()), unwrap(getQs())]);\n"
     "console.log('CONCURRENT_SAME=' + (qa === qb));\n"
     "console.log('CONCURRENT_FN=' + (typeof qa.parse === 'function'));",
     "Done",
     ["CONCURRENT_SAME=true", "CONCURRENT_FN=true"]),

    # (b) dynamic require of a non-builtin: no sync path -> clear error.
    ("b-dynamic-require-unknown",
     "const badName = 'definitely-not-a-builtin-xyz';\n"
     "try {\n"
     "  require(badName);\n"
     "  console.log('UNKNOWN_NO_THROW=true');\n"
     "} catch (e) {\n"
     "  console.log('UNKNOWN_THROWS=' + (e && e.code));\n"
     "}",
     "Done",
     ["UNKNOWN_THROWS=ERR_REQUIRE_ASYNC_MODULE"]),

    # (b) dynamic require(moduleName): variable specifier, cold -> promise.
    ("b-dynamic-require-cold",
     "const modName = 'os';\n"
     "const maybeOs = require(modName);\n"
     "const os = (maybeOs && typeof maybeOs.then === 'function') ? await maybeOs : maybeOs;\n"
     "console.log('DYN_PLATFORM_TYPE=' + typeof os.platform);\n"
     "console.log('DYN_WAS_PROMISE=' + (typeof maybeOs.then === 'function'));\n"
     "console.log('DYN_PLATFORM=' + os.platform());",
     "Done",
     ["DYN_PLATFORM_TYPE=function", "DYN_WAS_PROMISE=true", "DYN_PLATFORM="]),

    # (b) dynamic require(moduleName): warm -> synchronous module, not a promise.
    ("b-dynamic-require-warm",
     "await import('path');\n"
     "const modName = 'path';\n"
     "const warm = require(modName);\n"
     "console.log('WARM_SYNC=' + (warm && typeof warm.then === 'undefined'));\n"
     "console.log('WARM_JOIN=' + warm.join('/a', 'b'));\n"
     "console.log('WARM_IS_MODULE=' + (typeof warm.join === 'function'));",
     "Done",
     ["WARM_SYNC=true", "WARM_JOIN=/a/b", "WARM_IS_MODULE=true"]),

    # (c) uncalled dynamic require/import: declared but never called.
    # Must not crash, must not fetch eagerly (no loader interaction).
    ("c-uncalled-dynamic",
     "function neverStatic() { return require('fs'); }\n"
     "function neverDynamic() { const n = 'path'; return require(n); }\n"
     "function neverImport() { return import('os'); }\n"
     "async function neverAsyncImport() { const m = await import('fs'); return m; }\n"
     "console.log('UNCALLED_OK=true');",
     "Done",
     ["UNCALLED_OK=true"]),

    # (d) never-reached conditional/block imports.
    # Top-level static require in a dead block STILL hoists (eager, by
    # design): the nested require below is warm because of the hoist.
    # Dynamic import() in a dead block stays lazy (in-situ rewrite).
    ("d-dead-branch",
     "if (false) { const fsDead = require('fs'); }\n"
     "function getFsDead() { return require('fs'); }\n"
     "const r = getFsDead();\n"
     "const isSync = r && typeof r.then === 'undefined';\n"
     "console.log('DEAD_BRANCH_WARM=' + (isSync && typeof r.readFileSync === 'function'));\n"
     "if (false) { const osDead = await import('os'); }\n"
     "console.log('DEAD_IMPORT_LAZY=true');",
     "Done",
     ["DEAD_BRANCH_WARM=true", "DEAD_IMPORT_LAZY=true"]),

    # (e) import->require and require->import identity: same instance.
    ("e-import-require-identity",
     "import * as fsNs from 'fs';\n"
     "function getFs() { return require('fs'); }\n"
     "const viaRequire = getFs();\n"
     "console.log('E1_NS_EQ=' + (fsNs === viaRequire));\n"
     "console.log('E1_NAMED_EQ=' + (fsNs.readFileSync === viaRequire.readFileSync));\n"
     "const ns2 = await import('fs');\n"
     "console.log('E1_R2I_EQ=' + (viaRequire === ns2));\n"
     "console.log('E1_SYNC=' + (viaRequire && typeof viaRequire.then === 'undefined'));",
     "Done",
     ["E1_NS_EQ=true", "E1_NAMED_EQ=true", "E1_R2I_EQ=true", "E1_SYNC=true"]),

    # (f) live bindings. node:domain keeps `export let active` in sync via
    # enter(); the interop proxy now reads the live ESM namespace (2026-10-09:
    # named imports compile to live member access, no more import-time
    # destructuring), so reassignment inside the shim IS visible. Same-object
    # mutation is still visible (identity).
    ("f-live-bindings",
     "import * as domain from 'node:domain';\n"
     "const d = domain.create();\n"
     "console.log('F_ACTIVE_BEFORE=' + domain.active);\n"
     "d.enter();\n"
     "console.log('F_ACTIVE_AFTER=' + domain.active);\n"
     "console.log('F_LIVE=' + (domain.active === d));\n"
     "d.exit();\n"
     "console.log('F_ACTIVE_EXIT=' + domain.active);\n"
     "import * as fs1 from 'fs';\n"
     "import * as fs2 from 'fs';\n"
     "fs1.__e2e_mut = 'mut-ok';\n"
     "console.log('F_MUT_VISIBLE=' + (fs2.__e2e_mut === 'mut-ok'));",
     "Done",
     ["F_ACTIVE_BEFORE=null", "F_ACTIVE_AFTER=[object Object]", "F_LIVE=true",
      "F_ACTIVE_EXIT=undefined", "F_MUT_VISIBLE=true"]),

    # (g) side-effect count: the module is evaluated exactly once across
    # multiple requires/imports - the diagnostics_channel registry is a
    # singleton shared by both paths (two evaluations => two registries).
    ("g-single-evaluation",
     "import { channel } from 'node:diagnostics_channel';\n"
     "function getDc() { return require('node:diagnostics_channel'); }\n"
     "const dc = getDc();\n"
     "const chImport = channel('e2e-single');\n"
     "const chRequire = dc.channel('e2e-single');\n"
     "console.log('G_SAME_CHANNEL=' + (chImport === chRequire));\n"
     "let hits = 0;\n"
     "chImport.subscribe(() => { hits++; });\n"
     "chRequire.publish({ n: 1 });\n"
     "console.log('G_PUBLISH_ONCE=' + (hits === 1));\n"
     "console.log('G_HAS_SUBSCRIBERS=' + dc.hasSubscribers('e2e-single'));",
     "Done",
     ["G_SAME_CHANNEL=true", "G_PUBLISH_ONCE=true", "G_HAS_SUBSCRIBERS=true"]),

    # (h) CJS default/named export shape through interop.
    ("h-cjs-shapes",
     "const fsTop = require('fs');\n"
     "console.log('H_TOP=' + (typeof fsTop.readFileSync));\n"
     "const { readFileSync } = require('fs');\n"
     "console.log('H_DESTRUCT=' + (typeof readFileSync));\n"
     "import fsDefault from 'fs';\n"
     "console.log('H_DEFAULT=' + (typeof fsDefault.readFileSync));\n"
     "import { writeFileSync as wfs } from 'fs';\n"
     "console.log('H_NAMED=' + (typeof wfs));\n"
     "import * as fsNs from 'fs';\n"
     "fsTop.writeFileSync('/shape.txt', 'shape-ok');\n"
     "console.log('H_ROUNDTRIP=' + (fsNs.readFileSync('/shape.txt', 'utf8') === 'shape-ok'));",
     "Done",
     ["H_TOP=function", "H_DESTRUCT=function", "H_DEFAULT=function",
      "H_NAMED=function", "H_ROUNDTRIP=true"]),

    # (i) sandbox identity: require('buffer').Buffer is sandbox-scoped and
    # functional, but NOT === globalThis.Buffer: every dist entry is bundled
    # independently (esbuild bundle:true, external:[] per entry in
    # src/build-vfs.mjs), so dist/buffer.js and dist/RUNTIME_NODE_GLOBALS.js
    # each inline their own Buffer copy (the bundle's class is even minified
    # to `je`). Neither is the host's - the browser host has no Buffer.
    ("i-sandbox-identity",
     "const { Buffer: B } = require('buffer');\n"
     "console.log('I_SANDBOX_SCOPED=' + (typeof B === 'function' && typeof B.from === 'function'));\n"
     "console.log('I_WORKS=' + (B.from('hi-identity').toString() === 'hi-identity'));\n"
     "console.log('I_UINT8=' + (B.from([1,2]) instanceof Uint8Array));\n"
     "console.log('I_GLOBAL_IDENTITY=' + (B === globalThis.Buffer));\n"
     "console.log('I_NAME_TYPE=' + (typeof B.name));",
     "Done",
     ["I_SANDBOX_SCOPED=true", "I_WORKS=true", "I_UINT8=true",
      "I_GLOBAL_IDENTITY=false", "I_NAME_TYPE=string"]),
]

def run_code(d, code):
    d.execute_script("document.getElementById('codeInput').value = arguments[0];", code)
    d.execute_script("document.getElementById('argvInput').value = '';")
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
# Firefox honors proxy env vars; the sandbox's hatch-egress-proxy is
# unreachable from here (proxyConnectFailure on esm.sh), which wedges the
# module script (it imports esm.sh deps) and no CASE ever runs. Route
# explicitly through the local relay (TOOLS.md: Firefox honors proxy prefs;
# Chromium ignores them). Localhost stays direct for the test server.
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
# The module script (runtime.js import + EXAMPLES dict) needs time to
# parse/evaluate before the first execute() is reliable.
time.sleep(15)

# The playground's pre-flight refCheck only allows the `require` identifier
# when the "require" example was clicked (sandbox.requireAllowed). Click it
# once so every case below can use require(); the flag persists for the
# session and we overwrite #codeInput per case afterwards.
d.find_element("css selector", '.example-btn[data-example="require"]').click()
time.sleep(0.5)

results = []
for name, code, want_status, needles in CASES:
    status, output = run_code(d, code)
    ok = (status == want_status) and all(n in output for n in needles)
    results.append({"name": name, "ok": ok, "status": status})
    print("CASE %s: %s (status=%r)" % (name, "PASS" if ok else "FAIL", status), flush=True)
    if not ok:
        missing = [n for n in needles if n not in output]
        if missing:
            print("  missing needles: %s" % missing, flush=True)
        print("  output tail: " + output[-1200:], flush=True)

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
    print("serving repo ui.html ->", f"http://127.0.0.1:{PORT}/ui.html", flush=True)
    proc = subprocess.run(
        [VENV_PY, "-c", DRIVER], capture_output=True, text=True, timeout=600
    )
    print(proc.stdout[-8000:])
    print(proc.stderr[-2000:], file=sys.stderr)
    httpd.shutdown()
    if proc.returncode == 0:
        print("E2E-PASS: on-demand require browser matrix", flush=True)
    else:
        print("E2E-FAIL: on-demand require browser matrix", flush=True)
    sys.exit(proc.returncode)


if __name__ == "__main__":
    main()
