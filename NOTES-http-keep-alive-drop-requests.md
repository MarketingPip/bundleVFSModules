# NOTES — test-http-keep-alive-drop-requests (maxRequestsPerSocket drop)

## Target

`test-http-keep-alive-drop-requests` failed with exit 124 (30 s timeout, no
output) on pristine main `bca114aa` — verified 3/3 isolated runs, so this
is a genuine gap, not a stale queue record (unlike the sibling
keep-alive-timeout lane, which already passed on main).

## What the test does

- Server with `maxRequestsPerSocket = 1`. A raw socket sends TWO pipelined
  GETs on one connection.
- Request 1 must reach the `request` handler (mustCall once) and get
  `res.end("ok")`.
- Request 2, beyond the limit, must NOT reach the handler. The server must
  emit `dropRequest` with `(request, socket)` — asserted
  `instanceof http.IncomingMessage` / `instanceof net.Socket` — and the
  handler calls `server.close()`.
- The client socket must then close (mustCall), and the process must exit.

## Real-Node behavior probed (v24.22.1, plain scripts under /tmp)

- Request 1 → handler → `200 OK`, `Connection: close`,
  `Content-Length: 2`, body `ok`.
- Request 2 → `dropRequest` fires with `(IncomingMessage, Socket)`,
  `socket.destroyed === false` at emit time, and the client receives
  `HTTP/1.1 503 Service Unavailable`, `Date`, `Connection: close`,
  `Transfer-Encoding: chunked`, empty body (`0\r\n\r\n`).
- The client socket closes ~6 s later (server idle timeout + the
  `server.close()` from the drop handler completing); `hadError === false`.
- The native test passes in ~6 s. (The shim closes promptly instead of
  after the idle timeout; the test asserts close, not its timing.)

## Shim diagnosis (zz probes, deleted after use)

- Before the fix, the shim dispatched BOTH requests to the handler
  (mustCall(1) violated), sent only the first response, never emitted
  `dropRequest` (the string appears nowhere in `src/`), and the test hung
  because `server.close()` was never called.
- `src/http.js` already enforced the limit on the RESPONSE side only:
  `_finishSocketResponse` computes `maxOk` (`reqNo < max`) and closes the
  connection after the limit response. Nothing checked the limit at
  DISPATCH time.

## Fix (src/http.js only, _dispatchSocketRequest + _finishSocketResponse)

1. Dispatch-time drop check, placed AFTER the CONNECT/upgrade
   early-returns so those paths are untouched — only normal `request`
   dispatches are subject to dropping. When the served count on the
   socket has reached a numeric limit > 0 (`state.reqCount >= max`;
   null/undefined/0 mean unlimited, per
   test-http-server-keep-alive-max-requests-null):
   - `this.emit("dropRequest", req, socket)` with the fully-built request.
   - A 503 response is synthesized through the normal finish machinery
     (not a direct socket write) so finish FIFO keeps byte order:
     `ServerResponse`, `shouldKeepAlive = false`, server framing inputs
     mirrored from normal dispatch, `writeHead(503)` (explicit, not a
     bare `end()` — see below), `inFlight++`, `state.dropResponse` set.
     The dropped request does NOT increment the served count.
2. Explicit `writeHead(503)`: the finish framing rules send an
   explicit-headers response with no length framing as chunked, which is
   exactly real Node's drop shape (Date, Connection: close,
   Transfer-Encoding: chunked, empty body). A bare `end()` would instead
   take the implicit-headers branch and frame `Content-Length: 0`.
3. Destroy deferral (`_finishSocketResponse` else branch): while a drop
   response is still outstanding, an earlier response's finish skips the
   socket destroy; the drop response's own finish owns the close. Without
   this, the earlier response's finish destroys the socket and the 503
   bytes are lost.
4. End deferral (drop path): if the previous pipelined response's stream
   finish is still pending (`!writableFinished && !destroyed`), the drop
   response ends from that response's `finish` listener instead of
   immediately. A zero-body finish fires on nextTick and would otherwise
   jump ahead of the previous response's microtask-delayed write callback
   (OutgoingMessage._write defers its callback via queueMicrotask), so
   the earlier response's bytes would be lost to the socket close. When
   the previous response is already finished or destroyed, the drop ends
   immediately. Both mechanisms together are required: guard without
   deferral loses the earlier response; deferral without guard loses
   the 503.
5. `state.dropResponse` is cleared when the drop response finishes (next
   to the `lastResponse` release); the guard also checks `!finished` so a
   stale flag can never block a later close.

## Verified wire behavior (shim, zz probe)

- Handler called exactly once; `dropRequest` fires with both instanceof
  checks true; client receives `200 OK` + `ok` first, then the 503 with
  Date / Connection: close / chunked / empty body, in that order; client
  closes. (Real Node coalesces both responses into one `data` event; the
  shim sends two. The test only requires `mustCallAtLeast` on data.)
- Target 4/4 exit 0 on the branch (plus the pre-fix 3/3 exit 124 on base).

## Guards (all exit 0 on the branch)

keep-alive-drop-requests (target), keep-alive, keep-alive-timeout,
keep-alive-max-requests, server-keep-alive-max-requests-null,
server-keep-alive-timeout, keep-alive-timeout-buffer/custom/race-condition,
server-keep-alive-defaults, upgrade-client2/client/server/server2/agent/
binary, connect, server-close-idle, double-content-length,
response-multi-content-length, parser, server, keep-alive-close-on-header,
server-close-idle-wait-response.

## Not a regression: test-https-keep-alive-drop-requests

- Under `PARITY_TARGET=http` it fails exit 1 IDENTICALLY on branch and
  base (same line 36 instanceof assertion): `https` is not redirected
  for the http target, so the test runs against native https while
  asserting shim classes — a harness artifact, not a shim gap.
- Under `PARITY_TARGET=https` it fails exit 1 IDENTICALLY on branch and
  base with `ECONNREFUSED`: the https shim server cannot accept the
  test's real TLS connection in this harness (TLS is owned by the
  browser/fetch stack). Pre-existing harness limitation, out of scope.

## Deliberately left alone

- The ~5 s idle-timeout delay before real Node closes the dropped
  socket: the shim closes promptly at the 503's finish. The test asserts
  close, not timing, and `Connection: close` justifies prompt close.
- Multiple excess pipelined requests: each excess dispatch emits
  `dropRequest` + synthesizes a 503 (same as real Node's per-request
  drop); the flag always points at the latest drop response, so the last
  503's finish owns the close. No test covers this; the mechanism falls
  out of the single-drop design, not a separate path.
- Non-upgrade, non-CONNECT requests only: CONNECT tunnels and upgrades
  bypass the drop check via their early-returns (no test covers
  maxRequestsPerSocket + upgrade interaction).
