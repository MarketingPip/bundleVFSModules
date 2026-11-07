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

## Ceiling / non-goals

- No real TLS: no handshake bytes, no cert verification, no keylog,
  no renegotiation. agent-create-connection cases 5-6, agent-keylog,
  client-renegotiation-limit stay NO-FIX.
- L13 (session-reuse-different-servername, snicallback-override) composes
  on top of this; set-timeout-server needs L1+L12 (L1 landed, this lane
  supplies the transport half).
