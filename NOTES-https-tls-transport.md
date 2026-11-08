# NOTES — wave 3 L12: raw TLS transport (https)

Base: origin/main `319317ca` (https 47/67). Targets (7): server-close-all
(124), server-close-idle (124), keep-alive-drop-requests, eof-for-eom,
client-resume, insecure-parse-per-stream, max-header-size-per-stream.

## Diagnosis (parent-verified on base)

- `tls.connect` is NATIVE under PARITY_TARGET=https (no redirect) → dials
  virtual ports over real TCP → ECONNREFUSED (keep-alive-drop-requests,
  client-resume logs). `tls.Server.listen` is a fake microtask — nothing
  registers anywhere, so even the shim https client ECONNREFUSEDs against
  it (eof-for-eom: ClientRequest ECONNREFUSED via src/net.js:1807).
- Per-stream tests 1/2/5 ALREADY PASS: zz-probe1 (duplexPair) shows the
  client threads `insecureHTTPParser`/`maxHeaderSize` to the response
  parser (onSocket pooled-parser refresh, src/http.js:6031-6053; round-trip
  params, :6655-6662). The file failures are tests 3-4 only (native tls
  never delivers the request: insecure-parse line 78 = test-3 handler
  mustCall, line 117 = test-4 clientError mustCall; max-header line 82 =
  test-3 handler, line 125 = test-4 clientError). So there is NO
  client-threading sub-task left — only the transport + redirects.
- http twins of both per-stream files pass (0); no http eof-for-eom twin
  exists, so EOF-terminated response bodies through the round-trip parser
  are unproven — eof-for-eom itself is the proof.

## Design (ponytail: smallest transport that makes the bytes flow)

- TLSSocket wraps a real net.Socket (composition, NOT extends: the
  EventEmitter-based TLSSocket surface + its passing tls tests stay
  untouched). `connect()` dials via net.connect → the virtual registry
  pairs it with the server-side socket; write/end/destroy/setTimeout/
  setEncoding/resume/pause/ref/unref/address + remote*/local* delegate to
  the underlying socket; its data/end/close/error/timeout re-emit.
  Session (Node lib/internal/tls/wrap.js:1238-1253, :1806-1811): a provided
  `options.session` resumes (`isSessionReused() === true`); otherwise a
  synthetic session is issued and 'session' fires after 'secureConnect'.
- tls.Server gets a backing net.Server on listen() (ServerBase shape):
  registers in the net TCP registry, wraps each accepted socket in a
  TLSSocket, emits 'secureConnection'. `address()`/`close()`/
  `getConnections()` delegate to the backing server.
- https.get → tls.Server (eof-for-eom) needs NO http.js change: the
  tls.Server is absent from the http registry, so the EPROTO gate and
  _verifyHttpsPeer both skip, and `_hasRawNetServer()` (netHasTcpServer)
  routes the request over an agent socket paired with the backing server
  — the handler's raw response bytes are parsed by the round-trip parser.
- Redirects (#232 shape, L1 precedent): `tls` + `net` as extra redirects
  under PARITY_TARGET=https in parity/preload.mjs + parity/hooks.mjs, via
  a new parity/tls-harness.mjs (timer restore, mirrors net-harness) and
  the existing net-harness for `net`. `socket instanceof net.Socket`
  (keep-alive-drop-requests dropRequest) needs the net redirect.

## 2026-11-07 — follow-up: two 1→124 mode changes from the redirect

The first differential showed 8 flips + 2 mode changes (both 1→124):
`test-https-timeout-server` and `test-https-timeout-server-2`. Both are
lane-11 NO-FIX in the triage — but the mode change is deterministic and
caused by this lane (connections now reach the server instead of failing
fast), so they are fixed here rather than left hanging:

- `test-https-timeout-server`: raw `net.connect` (no ClientHello) to an
  https server with `handshakeTimeout: 50`. Oracle `wrap.js:1057-1058`:
  the server-side socket gets `setTimeout(handshakeTimeout,
  _handleTimeout)`; `_handleTimeout` emits `ERR_TLS_HANDSHAKE_TIMEOUT`
  (`wrap.js:1152-1153`); dispatch clears it (`wrap.js:1201-1202`).
  Ported in `src/https.js` HttpsServerBase 'connection' listener (default
  120s per `wrap.js:1491`; the net idle timer is unref'd, so the default
  cannot hold the loop) + clear in the wrapped request listener.
- `test-https-timeout-server-2`: `tls.connect` to an https server; expects
  'secureConnection' with a `tls.TLSSocket` (asserts instanceof). Real
  Node: https.Server inherits tls.Server, which emits 'secureConnection'
  per connection. Ported: the 'connection' listener wraps the accepted
  net socket in a `TLSSocket` (shares the socket with the http dispatch,
  re-emits only) and emits 'secureConnection'. Only this test listens
  for it among the https suite.
- Both flip 1→0. L12 total: 10 flips (7 targets + set-timeout-server
  + these 2). https 47→57/67 — the wave-3 ceiling.

## 2026-11-07 — repo test contract change (tests/tls.test.js)

`connect()` no longer fakes success: it dials the virtual network, so
the old connect() tests (example.com:443 always "connects", 192.0.2.1:9
never errors) pinned the retired black-hole contract and failed (7
tests). Rewritten to a local fixture tls.Server: connect/secureConnect
order, callback, the three call forms, servername, encrypted=true on
direct construction — plus a new test asserting ECONNREFUSED for an
unlistened virtual port (AGENTS.md rule 7: honest error, never fake
success). Session synthesis is Buffer-free (Uint8Array/DataView) so the
browser-fallback lane (globalThis.Buffer = undefined) still passes.
Full jest after the change: 3059 passed / 7 failed / 1 skipped = the
local baseline exactly (constants, perf_hooks, sys, oracle-export-surface
— pre-existing host skew). build-vfs exit 1 twice on the branch was the
known esm.sh acorn/acorn-walk fetch transient (direct curl 200; third
run exit 0; base also 0); dist/* regenerated by those runs was restored
uncommitted.

## Ceiling / non-goals

- No real TLS: no handshake bytes, no cert verification, no keylog,
  no renegotiation. agent-create-connection cases 5-6, agent-keylog,
  client-renegotiation-limit stay NO-FIX.
- L13 (session-reuse-different-servername, snicallback-override) composes
  on top of this; set-timeout-server needs L1+L12 (L1 landed, this lane
  supplies the transport half).
