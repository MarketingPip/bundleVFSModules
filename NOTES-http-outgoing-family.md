# NOTES — http outgoing-message family (fix/http-outgoing-family)

Base: main `6f41fb1e` (PR #283). All changes in `src/http.js` only.

## Target tests (before → after, shim vs real Node v24.22.1)

| test | before | after |
|---|---|---|
| test-http-outgoing-drain-writable-length | 124 | 0 |
| test-http-outgoing-finish | 124 | 0 |
| test-http-outgoing-end-types | 124 | 0 |
| test-http-outgoing-properties | 124 | 0 |
| test-http-outgoing-destroy | 1 | 0 |
| test-http-outgoing-destroyed | 1 (then 124 mid-lane) | 0 |
| test-http-outgoing-proto | 1 | 0 |
| test-http-outgoing-renderHeaders | 1 | 0 |

Bonuses found by the differential (not in the 8, same root causes —
each verified 2× on branch (0) and base (original code)):
- test-http-response-drain-cork: 1 → 0 (socket-driven response HWM, below).
- test-http-client-close-with-default-agent: 1 → 0.
- test-http-client-finished: 124 → 0.
- test-http-client-incomingmessage-destroy: 124 → 0.
- test-http-flush-response-headers: 124 → 0.
- test-http-invalidheaderfield: 1 → 0 (header validation now TypeError).
- test-http-parser-freed-during-execute: 1 → 0.
- test-http-pipeline-assertionerror-finish: 124 → 0.
- test-http-pipeline-outgoing-destroy: 124 → 0.
- test-http-res-write-end-dont-take-array: 124 → 0 (end validation
  before `finished`, same fix as end-types).
- test-http-response-close: 124 → 0.
- test-http-write-head: 124 → 0.
(test-http-outgoing-write-types already passed on base and still passes —
it is a held guard, not a flip.)

## Regression caught by the differential, fixed in-lane
- test-http-res-write-after-end: base 0 → branch 1 (mid-lane). The test
  requires res.write() after res.end() to emit 'error'
  ERR_STREAM_WRITE_AFTER_END and return false. The ported Writable
  routes that error through destroy(), and OutgoingMessage._destroy
  deliberately swallows it (close-only: destroy(err) must not emit
  'error' — destroyed blocks 2/4) — so the 'error' event never fired.
  Fix: `ServerResponse.write` emits the error itself (async, like the
  ported path's onDestroy emission; with no listener it throws, exactly
  as the ported emitErrorNT does) when `finished && !destroyed`; the
  ported path still returns false and calls back with the error, and
  destroy's close-only callback prevents a double emission. Scoped to
  ServerResponse on purpose: ClientRequest._destroy propagates the
  error (its destroy path already emits), and bare messages never
  reach this override. Re-verified 0 on branch (0 on base, unchanged).
  The sweep below ran BEFORE this fix, so its CSV shows
  res-write-after-end as the single regression line; the post-fix
  family re-run (server/response/outgoing/client/res families,
  diffed against the branch sweep CSV) shows exactly one change:
  res-write-after-end 1 → 0, zero other differences.

## Diagnoses (each probed on real Node v24.22.1, never assumed)

### destroy (exit 1): write-after-destroy threw the wrong error
Bare `msg.destroy()` then `msg.write("asd", cb)` must give the callback
`ERR_STREAM_DESTROYED` (plain `Error`), return false, NO 'error' event.
The shim threw `ERR_METHOD_NOT_IMPLEMENTED` from `_implicitHeader()`
because `OutgoingMessage.write()` rendered headers before any destroyed
check. Real Node: destroyed=true sync, closed=false sync, close async
with closed=true; write returns false; callback fires async (after
close) with ERR_STREAM_DESTROYED; no 'error' event. Destroyed-message +
bad chunk still throws synchronously (validation precedes the destroyed
check): number → ERR_INVALID_ARG_TYPE, null → ERR_STREAM_NULL_VALUES,
array → ERR_INVALID_ARG_TYPE.

### destroyed (exit 1 → 124 mid-lane → 0): three stacked gaps
Real Node: bare `destroy(err)` → destroyed=true sync, errored===err
sync, close async, NO 'error' event, no throw. The shim crashed with
unhandled 'error' (ported Writable destroy emits error). Critical
distinction probed: `ClientRequest.destroy(err)` DOES emit 'error' on
the req (its own destroy: socket teardown + socket-error forwarding; at
close, `req.errored` is null). So error suppression applies to
OutgoingMessage + ServerResponse but NOT ClientRequest. Real Node's
OutgoingMessage is NOT a Writable (`instanceof Writable: false`); its
destroy sets destroyed/errored, uncorks a non-empty chunked buffer,
destroys the socket if present else nextTicks the close, and never
emits 'error'. The shim deliberately extends the ported Writable, so
the fix is layered on top of it.
- Block 3 (server res 'close' after client res.destroy()): needed two
  things. (1) Client `IncomingMessage._destroy` now destroys the socket
  for INCOMPLETE messages only (a complete message's socket is already
  detached for agent reuse). (2) The destroy must be ABORTIVE
  (`resetAndDestroy`): the shim's `socket.destroy()` only delivers a
  FIN to the peer, and an allowHalfOpen HTTP server socket never closes
  on FIN — so the server never saw 'close'. Real Node agrees even for
  no-error destroy: the server socket gets an error (Parse Error,
  truncated message) + close with hadError=true. (3) Server socket
  close now destroys the in-flight response (`state.current.res` and
  the `state.lastResponse` stash when unfinished), so its 'close' fires.
- Block 5 (end, destroy, end('asd') must still deliver response end):
  needed two things. (1) `ServerResponse._destroy` no longer kills the
  socket for a finished response with no error (the finish path owns
  the socket lifecycle: keep-alive preserve, else destroy; an explicit
  destroy WITH an error still kills it). (2) The ported Writable
  suppresses 'finish' once destroyed (`needFinish` excludes kDestroyed),
  so end-then-destroy never ran the finish delivery. `_destroy` now
  emits 'finish' manually when finished && !err && delivery hasn't run;
  `_finishSocketResponse` is idempotent (`_finishDelivered` guard), so
  this is safe even if 'finish' somehow fires later.

### proto (exit 1): error classes + missing validation
Real-Node error classes probed: ERR_INVALID_HTTP_TOKEN,
ERR_HTTP_INVALID_HEADER_VALUE, ERR_INVALID_CHAR, ERR_INVALID_ARG_TYPE,
ERR_STREAM_NULL_VALUES are all TypeError; ERR_HTTP_HEADERS_SENT and
ERR_METHOD_NOT_IMPLEMENTED are Error. The shim's `makeError` always made
plain `Error`. Also: `setHeader()` with no args → ERR_INVALID_HTTP_TOKEN
TypeError (was: same code, wrong class); `setHeader('test')` (no value)
→ ERR_HTTP_INVALID_HEADER_VALUE TypeError, message
`Invalid value "undefined" for header "test"`; `setHeader(404)` →
ERR_INVALID_HTTP_TOKEN, `Header name must be a valid HTTP token ["404"]`;
`setHeader.call({_header:'test'})` → ERR_HTTP_HEADERS_SENT Error,
"Cannot set headers after they are sent to the client";
`setHeader('200','あ')` → ERR_INVALID_CHAR TypeError,
`Invalid character in header content ["200"]`; bare `write("")` →
ERR_METHOD_NOT_IMPLEMENTED Error, message now the full
`The _implicitHeader() method is not implemented` (was the bare
`_implicitHeader()` string — the test asserts the full sentence);
`write.call({_header:'test',_hasBody:'test'})` with bad chunks →
ERR_INVALID_ARG_TYPE / ERR_STREAM_NULL_VALUES with Node's exact
`Received ...` suffixes; bare `end(['x'])` → ERR_INVALID_ARG_TYPE;
bare `end(null)` → falls through to ERR_METHOD_NOT_IMPLEMENTED (null =
no chunk in end()). `addTrailers()` with no argument → TypeError
(engine TypeError from Object.keys on undefined — the shim did NO
validation at all); `addTrailers({あ:'value'})` →
ERR_INVALID_HTTP_TOKEN TypeError, `Trailer name must be a valid HTTP
token ["あ"]`; `addTrailers({404:'あ'})` → ERR_INVALID_CHAR TypeError,
`Invalid character in trailer content ["404"]`. The finished-first
order is unchanged (addTrailers after end() is silently ignored, #273).
No http test asserts `name` alongside the three header codes (grep
2026-10-28), so changing those three factories to TypeError is safe on
the grep-visible surface; the differential is the backstop.

### renderHeaders (exit 1): method missing, foreign symbol
`_renderHeaders` did not exist on the shim. The test respawns with
`--expose-internals` and uses real Node's `internal/http` kOutHeaders
symbol — NOT the shim's local symbol (preload.mjs has no internal/http
mapping; `src/internals/http-symbols.js` exports only kUniqueHeaders /
kHighWaterMark). New `_renderHeaders()`: throws ERR_HTTP_HEADERS_SENT
("Cannot render headers after they are sent to the client") if
`this._header`; store null → `{}`; store `{}` → `{}`; store
`{host: ["host","nodejs.org"], origin: ["Origin","localhost"]}` →
`{host: "nodejs.org", Origin: "localhost"}` (first-seen casing as key,
value as-is). When the store is null/undefined it scans own symbol
properties for a foreign symbol with description `"kOutHeaders"` and
uses it; in a real browser no foreign symbol exists, so the shim store
is used untouched.

### end-types (124): throw poisoned `finished`
Under the shim, `res.end(['Throws.'])` DID throw ERR_INVALID_ARG_TYPE
and assert.throws passed. The hang was the RETRY: `ServerResponse.end`
set `this.finished = true` BEFORE `super.write(chunk)` threw, and its
early return `if (this.finished)` made the second `res.end()` a silent
no-op, so no response was ever delivered (zz probe: "end(array) threw",
"res.end() ok", client never got a response). Same bug class in base
`OutgoingMessage.end`. Root cause of the throw itself: the ported
Writable validates chunks and throws synchronously — validation must
happen in the http layer BEFORE any state mutation. The write-types
analog (`res.write(["Throws."])` then writes must succeed) works only
if validation precedes `_implicitHeader` (real Node validates in write_
before rendering headers). Fix: `validateOutgoingChunk()` (null →
ERR_STREAM_NULL_VALUES; non-string/non-Uint8Array →
ERR_INVALID_ARG_TYPE with Node's `Received ...` suffix: undefined →
`undefined`; object → `an instance of <Ctor>`; function → `function
<name|anonymous>`; else `type <typeof> (<String>)`) runs first in
`OutgoingMessage.write/end` and `ClientRequest.write/end` (client
write validates BEFORE `_streamEnsureStarted`; client end validates
before `_ended = true`). The ported Writable's own message ("Buffer,
TypedArray, or DataView") differs from Node's http message, which is
why validation lives in the http layer.

### properties (124): two mismatches, either throws inside the handler
zz probe showed bare blocks pass and req.path/method/host/protocol
pass, but the server block has TWO mismatches (either throws inside
the handler and is swallowed → hang):
(a) `res.writableHighWaterMark` 65536 !==
`req.socket.writableHighWaterMark` 16384 — http `listen()` called
`createNetServer()` with NO options, so accepted sockets got the net
default 16384, while real Node gives http server sockets the server's
highWaterMark (probed: default server → socket HWM 65536 = res HWM
65536; `{highWaterMark: 1024}` → socket 1024 = res 1024). Net Server
already applies its `highWaterMark` to accepted sockets, so the fix is
one line in http `listen()`: `createNetServer({ highWaterMark:
this._highWaterMark })`. (The #274 gap note — "http listen() creates
backing net server without options" — is the same root cause for
noDelay, but noDelay forwarding stays OUT of scope for this lane.)
(b) `res.writableLength` after write("asd") reads 0, expected len+8
where len is after write("") — real Node counts header + framed bytes
(probed: after write("") → 131, after write("asd") → 139, delta
exactly 8 = framed `3\r\nasd\r\n`; at finish → 0). The shim's
`ServerResponse._write` streams via `_pendFrame` and calls back
synchronously, so Writable length drops to 0 immediately. The test
needs only the DELTA (+8) and 0 at finish, not the absolute 131/139.
Fix: framed-pending accounting — `_pendFrame` adds the frame's byte
length to `_framedPending`; every flush site (`_flushPendingFrame`,
`ServerResponse.end`'s flush section, `_finishSocketResponse`'s
streaming branch) subtracts exactly once and calls
`_maybeEmitStreamDrain()`. New `ServerResponse` getters:
`writableLength` returns `_framedPending` when `_headerFlushed` and
the socket is a real (non-FakeSocket) socket, else the ported getter;
`writableNeedDrain` is true when `_streamNeedDrain`, else the ported
getter. The terminator itself is never counted.

### drain-writable-length (124): pipelined socket was live, not null
zz probe (pre-fix) showed the shim does NOT pipeline-queue at all:
step 2's handler ran IMMEDIATELY, `res2.socket` was a live socket, the
write loop ran 102 iterations (always true, length 0), and the client
received ~1.6M bytes at once. So the official test's
`assert.strictEqual(res.socket, null)` threw inside the handler and
was swallowed → hang. Real-Node contract (probed): pipelined step-2
handler sees `res.socket === null`; writes buffer; write loop ends
with `writableNeedDrain === true`, `writableLength` 65725, res HWM
65536; 'drain' fires later with `writableLength === 0`. Shim machinery
that SHOULD have gated this exists but was unimplemented at dispatch:
`parser.pauseBetweenMessages = true`, `_finishSocketResponse` unpauses
and feeds `state.pending`, and `onHttpData`'s comment claims dispatch
happens when the current response finishes — but `onHeadersComplete`
called `_dispatchSocketRequest` unconditionally. Fix (minimal):
at dispatch, while a previous response on this socket is unfinished
(`state.lastResponse && !finished`), the new response gets
`socket = null; connection = null`. Buffered writes then flow through
`ServerResponse._write` → `super._write` (OutgoingMessage._write →
outputData, microtask callback) when socketless; Writable length grows
past HWM → false + needDrain; microtask drain of the internal buffer
fires 'drain' with Writable length 0; the drain handler's `res.end()`
→ finish → `_finishSocketResponse` sends headers + outputData via the
socket PARAMETER (not res.socket). A synchronously finished previous
response (finished=true, finish event still queued) is NOT deferred,
so finish-event FIFO keeps byte order for synchronous-handler
pipelines. Assignment-with-flush on previous-finish was deliberately
NOT implemented: assigning the socket without flushing would reorder
res2's own bytes ahead of older buffered outputData, and flushing at
assignment would duplicate the finish-send path — out of scope.
REGRESSION CAUGHT BY GUARDS, FIXED IN-LANE: the drain test's drain
handler calls `server.close()` while res2 is still in flight (finish
async), and the process hung on two live Socket handles: close()
destroyed only idle-at-close connections, and nothing destroyed the
socket when the response finished. Real Node (probed with the exact
replica): the server destroys its side at finish → client sees close
→ loop drains. Fix: close() flags busy connections
(`state.serverClosing = true`); `_finishSocketResponse`'s keepAlive
branch destroys the socket when the flag is set AND nothing further is
outstanding (`inFlight === 0` after decrement, pending empty,
!busy). The inFlight condition is load-bearing: destroying at the
first finish after close() drops still-outstanding pipelined responses
(test-http-server regressed 0 → 1: close() runs at req3 dispatch while
res1/res2/res3 timers are pending; the early destroy lost /quit).
Never on the half-closed drain path (drainPeerEnded): remaining
in-flight responses must still go out. The close() comment's "NOT
destroyed retroactively" claim is refined: in-flight connections
complete, THEN are destroyed at finish when the server is closing.

### finish (124): synchronous INFINITE LOOP, not an async stall
zz probe (loop capped at 200) showed all milestones fire and the probe
EXITS 0 — the official test's hang is a synchronous infinite loop:
server-res `while (out.write(buf, common.mustSucceed()));` never
terminates because streaming `ServerResponse._write` pends the frame
and calls back synchronously, so Writable length is always 0 and
write() always returns true (probe: server-res loop wrote 202 capped,
writableLength 0, needDrain false; client-req loop correctly wrote 4
then false at 65536 via the buffered path). Real Node terminates
because the socket buffer fills (socket.write returns false at HWM).
The fix must NOT defer `_write` callbacks: that would break #279
coalescing — chunks 2–4 would still sit in Writable's internal buffer
at end() time, end() would flush only chunk 1's frame + terminator in
one write, and chunks 2–4 would flush AFTER the terminator (protocol
corruption). Instead: keep sync callbacks, gate `ServerResponse.write()`'s
return value on the framed-pending counter (`ret && _headerFlushed &&
_framedPending >= HWM` → `_streamNeedDrain = true`, return false),
and emit 'drain' manually when the counter drops below HWM
(`_maybeEmitStreamDrain`). Buffered/corked writes keep the Writable
verdict because their bytes never pend. End/finish ordering was
already correct (probe: server-res endCb then finish, both nextTick
checks pass; client-req endCb then finish, checks pass).

### drain-cork (bonus flip, pre-existing fail on base)
`socket._writableState.highWaterMark = 1000` in the 'connection'
listener must drive `res.write()` backpressure (second write of 1000
bytes after 10 must return false). Mechanism on real Node: the response
takes the socket's live mark at dispatch. Fix: at dispatch, after
creating res, `res._writableState.highWaterMark =
socket.writableHighWaterMark` (guarded to numeric). The server option
already reaches the socket via listen(), so default/option cases are
unchanged — this only picks up later mutations.

## Files changed
- `src/http.js` only (plus this note + the ondemand allowlist entry).
- Explicitly untouched: `parity/preload.mjs`, `parity/run.mjs`, `dist/*`,
  `.github/workflows/run.yaml`, ClientRequest write paths beyond the
  validation-before-start ordering above, chunked framing, trailer
  rendering, parse-error surfacing, connection limits, noDelay wiring.

## Deliberately left alone
- Bare-message drain emission and `writableNeedDrain` shadowing for
  bare messages (#280 gaps): none of the 8 tests hinges on them (the
  drain test's drain comes from the Writable buffer path, not the bare
  path). Still open, still needs a test that hinges on it before
  touching.
- `HPE_STRICT` for bare CR in start line, `HPE_UNEXPECTED_CONTENT_LENGTH`
  for duplicate same-value CL, client-reject-* loopback response
  parsing, `_httpMessage` clearing on normal socket release, upgrade
  follow-ups (upgrade-client2 GET-write flushing, upgrade-server
  delivery timing, upgrade-server-callback Buffer identity), agent-*
  residuals, Lane 11 cross-process reachability (HELD, architectural).

## Verification (branch worktree, before ship)
- `node --check src/http.js`: clean.
- 8 targets + write-types + drain-cork + buffer: all exit 0 (see table).
- Guard battery (at-risk families): close-idle-wait-response,
  connection-list-when-close, consumed-timeout, keep-alive-defaults,
  keep-alive-max-requests, keep-alive-max-requests-null,
  keepalive-req-gc, keep-alive, keep-alive-timeout-custom, chunked,
  chunked-304, set-trailers, connect, connect-req-res, upgrade-client,
  upgrade-agent, upgrade-server2, agent-remove, client-highwatermark,
  nodelay, proxy, server, unconsume-consume, drop-connections-in-cluster,
  delete-parser, multiple-client-error, destroy-socket-on-client-error,
  client-error, outgoing-finished, outgoing-message-write-callback,
  response-drain-cork — all exit 0 after the in-lane regression fix
  (test-http-server regressed 0 → 1 mid-lane via the early closing-server
  destroy; fixed by the inFlight === 0 condition, re-verified 0).
- Full 397-test differential vs pristine main (base `6f41fb1e`):
  base 197 pass / 80 timeout / 120 fail → branch 216 pass / 68 timeout /
  113 fail. Exactly 20 lines differ toward pass (the 8 targets + the 12
  bonuses above) and, after the in-lane res-write-after-end fix, ZERO
  pass→fail regressions (the sweep's single regression line is fixed
  and re-verified; see above). Branch/base CSVs in
  `~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/`
  (`http-sweep-outgoing-branch.csv` / `http-sweep-outgoing-base.csv`).
  Crash codes identical on both sides (one Aborted, one Segfault —
  the pre-existing host parser crashes).
- Repo jest suite + ondemand-require (29/29) + build-vfs green
  (dist restored, never committed).
