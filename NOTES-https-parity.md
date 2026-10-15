# https parity working notes

Branch: `feat/https-parity` (from main @ c4166b61, post http #223 + http2 #222 merges)
Baseline: 1/67 (1.5%) per HITLIST.md

## 2026-10-14 23:45 EDT — setup
- Claimed https-parity lane in LOCKS.md
- Created feat/https-parity from origin/main
- https is a thin wrapper over tls + http in Node. In a browser sandbox there's
  no real TLS, so most failures are expected to be inherent.
- First: look at src/https.js to see what the shim does, then run the 67 tests
  with exact matching to get a real baseline.

## Hypotheses
1. Most https tests need real TLS handshakes (certificates, ALPN, SNI) — inherent.
2. The 1 passing test is probably an API-shape test (exports exist).
3. There may be a few fixable gaps: option validation, error codes, agent behavior
   that delegates to http.Agent.

## 2026-10-14 23:50 EDT — baseline running, first findings

Baseline `node parity/run.mjs https` running in background (30s/test timeout).
Early output: test-https-abortcontroller.js FAIL, test-https-agent-abort-controller.js FAIL.

**Finding 1: `options.signal` not wired (PRODUCT BUG, in http.js)**
- test-https-abortcontroller.js:32 expects `listenerCount(ac.signal, "abort") === 1`
  after https.request({signal}), but gets 0.
- `grep -c "options.signal" src/http.js` → 0. ClientRequest never reads options.signal.
- This is an http.js gap that affects https too. Real Node wires the signal to
  abort the request. Fixable: add signal listener in ClientRequest constructor
  that calls this.destroy() with AbortError.
- Note: http module may have the same failing tests (test-http-abortcontroller?).
  If so, fix belongs in http.js and benefits both.

**Strategy shaping up:**
- https.js is 101 lines, thin wrapper over http. Most test failures will be
  TLS-inherent (certs, SNI, ALPN, cipher suites, session resumption).
- Fixable surface: option validation, Agent behavior, signal handling,
  error codes — anything that doesn't need a real TLS handshake.
- Will classify each failure after baseline completes.

## 2026-10-15 00:30 EDT — fixes in progress

**Fixed:**
1. ✅ `options.signal` wired in http.js ClientRequest (+ `_onAbortSignal` method).
   test-https-abortcontroller.js now PASSES.
2. ✅ Created parity/https-harness.mjs (timer-globals restore), wired into
   preload.mjs + hooks.mjs.

**Known gap (not fixing):** Agent.createConnection({signal}) — test-https-agent-abort-controller.js
expects the Agent to wire abort signals on created sockets. This is Agent-level,
not https-level, and most agent tests are TLS-inherent anyway. Document as gap.

**Next:** ALPNProtocols storage in https.js Server.
