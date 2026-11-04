# NOTES — http server lifecycle, PR-A (pure `src/http.js`)

Targets (all verified failing 3/3 on main `44c60370` before work, passing
after — each re-run twice):

- test-http-server-timeouts-validation
- test-http-server-optimize-empty-requests
- test-http-server-response-standalone
- test-http-server-keepalive-end
- test-http-server-capture-rejections

## timeouts-validation

Real Node (probed v24.22.1): headersTimeout / requestTimeout /
keepAliveTimeout must be integers in [0, 2^53-1] when given (null is a
type error, not "missing" — checked via `!== undefined`, not `??`);
headersTimeout must be ≤ requestTimeout unless requestTimeout is 0.
Defaults: requestTimeout 300000, headersTimeout
`min(requestTimeout, 60000)` (so `{requestTimeout: 20000}` reads
headersTimeout 20000, `{requestTimeout: 100000}` keeps 60000).
Implemented as `_validateServerTimeout` just above `class ServerBase`,
using the existing `ERR_INVALID_ARG_TYPE_ARGUMENT` and
`ERR_OUT_OF_RANGE` factories.

## optimize-empty-requests

Constructor stores `this._optimizeEmptyRequests =
options.optimizeEmptyRequests === true`. Dispatch (normal path, after
the drop-check, before `new ServerResponse`) marks requests with neither
Content-Length nor Transfer-Encoding as dumped: `_dumped = true`,
`complete = true`, `_readableState.ended/endEmitted/destroyed = true`.
Header presence, not method/value, decides: POST with CL:0 and HEAD
with CL both stay unoptimized (probed: HEAD with CL:5 → dumped=false;
PUT/OPTIONS without headers → dumped=true).

## response-standalone

Two changes. (1) `assignSocket` guard — probed: only assignSocket
itself arms the guard (a second assignSocket throws; a server-created
response still accepts one assignSocket call, since its socket arrives
via the dispatch path). Implemented as a `_socketAssigned` flag plus
new factory `ERR_HTTP_SOCKET_ASSIGNED` ("Socket already assigned").
(2) Standalone flush — `_deliver()` is a no-op without a resolver, so
a standalone response's `end()` buffered outputData forever. Added a
`once("finish")` handler in the ServerResponse constructor that skips
dispatch-created responses (`_serverReqNo !== undefined`, set by
dispatch before finish can fire) and otherwise writes header block +
concatenated outputData as one chunk + an empty chunk to the assigned
socket (skipping FakeSocket/destroyed sockets; skipping the header
part if `_headerFlushed`).

## keepalive-end

Two changes. (a) Dispatch sets `socket.parser.incoming = req` and
registers `req.once("end", ...)` BEFORE emit (registration order: hook
runs before user 'end' handlers; queued `globalThis.process.nextTick`
nulls `incoming` — with identity check so a pipelined successor isn't
nulled — before any nextTick a user handler schedules; queueMicrotask
fallback only for builds without a process shim). The facade already
had `incoming: null` / `outgoing: null` fields. The nulling run
captures the facade object, not the live `socket.parser` slot: the
socket close nulls the slot, but a test holding the facade (this test
captures it inside 'end') must still see `incoming` nulled on the next
tick even if the close landed between 'end' and that tick. (b) Dump
hook at the top of `_finishSocketResponse` (after the
`_finishDelivered` guard): `if (req && !req.destroyed &&
!req.readableEnded) req.resume()` — real Node drains an unconsumed
request body when its response finishes, so req 'end' fires even with
only an 'end' listener (probed: 'end' fires with res.end, never
without it — writes alone do not dump). (c) Peer half-closed close
deferral: when the peer sent FIN and this response finished but the
request stream has not delivered 'end' yet, the socket destroy is
deferred one nextTick — queued after the 'end' delivery but before the
nextTick a user 'end' handler schedules — so 'end' still sees a live
parser and the post-'end' check still sees null. Narrowly scoped to
`peerEnded + not-yet-ended request`; all other closes stay synchronous.

## capture-rejections

Constructor stores `this._captureRejections =
EventEmitter.captureRejections === true` (the static reads in both
builds: native events under the harness, the shim's mirrored static in
`src/events.js`; verified native instances do NOT expose a
`captureRejections` property — it is internal symbol state — so the
static is the only read path; verified the global-at-construction
snapshot semantics: setting an own property after creation does NOT
enable the path, probed crash). Dispatch: when `_captureRejections`
is true, `_emitRequestCaptured` invokes `rawListeners("request")`
directly (fallback `listeners`) with `fn.call(this, req, res)`,
attaching `.catch` handlers; sync throws still propagate to the
existing catch (clientError + socket.destroy).
`_onRequestListenerRejection`: finished/destroyed response → ignore
(probed: throw-after-end leaves the client with a clean 200); headers
not sent → clear `kOutHeaders` + `_renderedHeaders`,
`writeHead(500)`, `end("Internal Server Error")` (real Node's 500
carries only Date/Connection/Keep-Alive/Content-Length: 21, user
headers dropped); headers sent → `res.destroy(err)`.

Two client-side fixes this target exposed (both in the round-trip
catch's streamedMsg branch): (1) the request itself must close when
its socket dies mid-response (probed: req 'close' fires, no req
'error' — the error went to the response stream);
`ClientRequest.destroy()` synthesizes ECONNRESET only before a
response arrives, and `_responseReceived` is set for a streamed
response, so `this.destroy()` there stays error-free. (2) The res
'error' emission is guarded by `listenerCount("error") > 0`: emitting
an unlistened 'error' throws inside the catch, skipping the stream
destroy and the request close below (and the throw is then swallowed
upstream, so the request just never closes — block 2, whose client
attaches no res 'error' listener, hung on its req 'close' mustCall
exactly this way).

## Probes (all v24.22.1 unless noted)

- Timeout validation edges: `{requestTimeout: 20000}` → headers 20000;
  `{requestTimeout: 100000}` → headers 60000; `{requestTimeout: 0}` →
  headers 0; `{headersTimeout: 0}` → headers 0, request 300000;
  negative → ERR_OUT_OF_RANGE ">= 0 && <= 9007199254740991";
  non-integer (1.5) → ERR_OUT_OF_RANGE "must be an integer";
  string/null → ERR_INVALID_ARG_TYPE "argument must be of type
  number" (null → "Received null"); `{headersTimeout: 10000,
  requestTimeout: 5000 or 9999}` → ERR_OUT_OF_RANGE "must be <=
  requestTimeout"; `{headersTimeout: 10000, requestTimeout: 0}` → OK.
- optimizeEmptyRequests: HEAD with CL:5 → NOT optimized; PUT/OPTIONS
  without headers → optimized; rule is purely header-presence.
- assignSocket: server-created response accepts one assignSocket call
  (replaces socket, no throw); standalone second assignSocket throws
  ERR_HTTP_SOCKET_ASSIGNED.
- captureRejections gating: global false → async listener throw
  crashes via unhandled rejection (UNCAUGHT, not a server 'error'
  event); global true → 500-before-headers / destroy-after-headers;
  sync throw crashes EVEN with global true (shim's existing
  sync-throw → clientError + destroy path is a different shape, but
  no test covers sync throw for capture-rejections — the test uses
  only async listeners); throw-after-end ignored by client (clean
  200).
- captureRejections destroy shapes: partial-write-then-throw → client
  sees response 200, data "{", res 'aborted', req 'close', res
  'error' ECONNRESET, res 'close' (NO req 'error');
  writeHead-only-then-throw → client req 'error' ECONNRESET + req
  'close', NO 'response' event (headers never hit the wire — destroy
  cancels the queued write).
- Request-body dump trigger: req 'end' fires with res.end (even with
  only an 'end' listener, no 'data' listener); does NOT fire with
  writeHead+write or write-only and no end; no-listeners + res.end →
  req.complete = true.
- `EventEmitter.captureRejections` static: exists natively (default
  false, true after setting the global); instance read is undefined;
  `e.constructor.captureRejections` reads the static.
- Shim internals verified: `readableEnded` getter returns
  `_readableState.endEmitted`; `destroyed` getter returns
  `_readableState.destroyed`; bitmap descriptors in
  `src/stream/readable.js` have setters; `globalThis.process.nextTick`
  is a function under the harness and `process ===
  globalThis.process`; `src/http.js` must NOT import `./process.js`
  (trips the harness leak detector — use `globalThis.process` reads
  instead); `src/http.js` imports bare `"events"` (native under the
  harness — ServerBase.emit traces to node:events) while Socket uses
  `src/events.js`.
