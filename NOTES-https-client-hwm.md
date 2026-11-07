# NOTES-https-client-hwm.md — wave 3 lane L10

Target: `test-https-hwm` (1 flip). Base `2079bca0`, rebased onto
`7a82db0e` (PR #383, L2 merged) before shipping.

## Failure (base)

`128000 !== 65536` — `https.request({ highWaterMark: 128000 })` drops
the option; `res.readableHighWaterMark` stays the 64K default. (The
test's other two cases: HWM 0 expects 0, unset expects 65536.)

## Root cause (Node source oracle)

Real Node threads the option through the socket
(`lib/_http_client.js:353-358` stores it on the request;
`lib/net.js` Socket takes `readableHighWaterMark` from
`options.highWaterMark`; `lib/_http_incoming.js:63` builds the
response with `highWaterMark: socket.readableHighWaterMark`).
Probed real Node v24.22.1: request HWM 128000 → socket
readableHWM 128000 → res readableHWM 128000; default 65536
throughout.

The shim already had the second half: `IncomingMessage` ctor syncs
`socket.readableHighWaterMark` (`src/http.js`, `test-http-incoming-
message-options`), and every client response site constructs with
`this.socket`. The missing half was the first: `AgentBase.
createSocket` built its connect options without `highWaterMark`,
so the client socket kept the default 64K.

## Fix (src/http.js only)

Thread the request's `highWaterMark` to the socket, following the
existing "forwarded only when present" rule (same as lookup /
socketPath / localAddress / localPort / family):

- ClientRequest ctor: stash `options.highWaterMark` in
  `_agentOptions` when defined.
- `AgentBase.createSocket`: forward `options.highWaterMark` into
  `createOptions` when present.
- `AgentBase.createConnection`: forward into `connectOptions` when
  present (keeps `test-http-agent-keepalive-delay`'s exact-options
  shape — it asserts only keepAlive/keepAliveInitialDelay fields).
- `ClientRequest._invokeFactory`: forward into `factoryOptions`
  when present (same root cause for factory-created sockets).

Shim socket already honors the option (`new net.Socket(
{ highWaterMark })` → readableHighWaterMark, probed via zz-probe:
default 65536, 128000 → 128000, 0 → 0), so no net.js change.
Pooled-socket reuse keeps the first request's HWM, like real Node
(socket HWM is fixed at creation).

## Verification

- `test-https-hwm`: 1 → 0 (all three cases: 128000 / 0 / 65536).
- Guards, all 0: `test-http-client-highwatermark`,
  `test-http-agent-keepalive-delay`, `test-http-createConnection`,
  `test-http-incoming-message-options`.
- Full https sweep differential (fast-sweep.py --target https
  --force, fresh CSVs): see PR body.

## Leftover (not this lane)

None. The factory path is covered by this fix, not left open.
