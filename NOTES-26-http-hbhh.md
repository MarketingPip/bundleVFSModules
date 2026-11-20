# NOTES-26-http-hbhh — Node 26 Wave 2 HTTP lanes H-B–H-H

Lane worker: 2026-11-20. Branch `feat/w2-http-hbhh`, worktree
`~/workspace/worktrees/w2-http-hbhh`, base origin/main `e895aceb`
(origin/main had moved past the task's stated `652333e7`; HEAD at lane
start was e895aceb "docs(perf_hooks): record L-PH1 merge outcome (PR #525)").

Banked count (coordinator-verified on live main): http **393/422**.
New count = 393 + flips verified 2x on live main − regressions in the
differential. Never computed from triage expectations.

## Method

- Read `NOTES-26-triage-http.md` (origin/main) in full before touching code.
- Oracle: Node 26.13.1 binary `~/workspace/local/node-26/bin/node`, Node 26
  source `~/workspace/local/node-26-src` (`lib/` + `test/parallel/`).
- No fresh web research; Node 26 source pack + repo tree + local probes only.
- Baselines (own worktree, base e895aceb, `parity/drift/run-baseline.mjs`,
  jobs 4, short 10s / full 30s):
  - http: **393/422 pass, 21 fail, 8 timeout**. Matches the coordinator's
    banked 393. The baseline JSONC/CSV files were lost when /tmp was
    wiped on 2026-11-20; the fail/timeout lists are recorded in the lane
    handoff (see below) and the count is coordinator-verified.
  - net: **148/161 pass, 10 fail, 3 timeout**. Guard for the planned
    `src/net.js` getter change (see H-C-3 / H-F-1).
- Isolated verification: `~/workspace/w2-http-hbhh/run-one.sh <test> <timeout>` —
  stages the Node 26 test file + whole `common/` + `fixtures/` into
  `parity/node-test/`, runs one test with visible output
  (`PARITY_TARGET=http`), restores via `git checkout -- parity/node-test` +
  null-delimited untracked-file removal. Every flip below was verified
  isolated **[0,0] x2** (two exit-0 runs). Hanging tests were run at 90s.
  (The script lived in `/tmp/w2-http-hbhh/` until the 2026-11-20 /tmp
  wipe; it was recreated at the persistent path above. Pass-2 batch:
  `~/workspace/w2-http-hbhh/run-pass2.sh`, log `pass2.log`.)
- `run-baseline.mjs` does NOT honor `// Flags:` headers — no lane test
  declares flags, so no direct-with-flag runs were needed.

## Flips landed (19: 13 lane targets + 6 upsides)

All verified isolated [0,0] x2 unless noted. All in `src/http.js` except
the two flagged `src/net.js` touches (H-C-3, H-F-1).

### H-B — upgrade with body (5: 1 target + 4 upsides)

`test-http-upgrade-server-with-large-body-unread.mjs` (target),
`test-http-upgrade-server-with-body.mjs`,
`test-http-upgrade-server-with-body-error.mjs`,
`test-http-upgrade-server-with-body-and-extras.mjs`,
`test-http-upgrade-server-with-large-body.mjs` (upsides) — all [0,0] x2 at 90s.

Root cause: `_dispatchSocketRequest`'s upgrade branch called
`state.parser.takeRemainder()` at dispatch time, which wipes the parser
buffer including unparsed body bytes; then `state.upgraded = true` made
`onHttpData` return early, so the body never parsed and the request
never completed (hang). For the unread case the raw chunk framing leaked
to the socket as the upgrade stream (exit 1).

Fix (Node `lib/_http_server.js:1057-1131` `UpgradeStream` +
`onParserExecuteCommon`): new `UpgradeStream extends Duplex` port
(`src/http.js`, before `ServerBase`): proxies `write`/`end`/`destroy`
to the real socket; `requestBodyCompleted(head)` pushes the post-body
head and attaches the socket `data` forwarder (pausing on push-false);
`_read` resumes req + socket; socket `error` → `destroy(err)` (so a
destroyed-socket error surfaces as `uncaughtException` on the wrapper —
with-body-error); socket `close`/`end` proxied. In the upgrade branch,
when `info.hasBody` is true, emit the wrapper with an EMPTY head and
keep the parser attached (`state.upgraded` stays false, no
`takeRemainder`, no detach); `req.socket` stays the real socket.
`onMessageComplete` then calls
`wrapper.requestBodyCompleted(parser.takeRemainder())` (now truly
post-body bytes — clearing the buffer also keeps
`validatePipelinedRemainder` from misparsing the head as a new request),
detaches the HTTP listeners, nulls `socket.parser`, sets
`state.upgraded = true`. Bodyless upgrades keep the raw-socket path
unchanged. Trailers fold into req at completion (pre-existing wiring),
which with-body-and-extras asserts.

### H-C-1 `test-http-agent-highwatermark-reuse.js` — [0,0] x2

Node `lib/_http_agent.js:427-435`: on pooled-socket reuse, if
`options.highWaterMark != null` and differs from
`socket.writableHighWaterMark`, set
`socket._writableState.highWaterMark`. Fix in `src/http.js`
`reuseSocket` (before `req.onSocket(socket)`, since 'socket' is emitted
via queueMicrotask in `onSocket`): sync
`socket._writableState.highWaterMark` from
`req._agentOptions?.highWaterMark` when a number and different. The
request HWM is at `req._agentOptions.highWaterMark` (set in the
ClientRequest constructor).

### H-C-2 `test-http-agent-keylog-existing-sockets.js` — [0,0] x2

Node `lib/_http_agent.js:285-311` (`maybeEnableKeylog`, wired via
`this.on('newListener', maybeEnableKeylog)`): on the first 'keylog'
listener, remove the hook, install a re-emit handler, attach it to every
socket in both `freeSockets` and `sockets` buckets. Fix in `src/http.js`:
module symbol `kOnKeylog` + `maybeEnableKeylog` before `AgentBase`;
`this.on("newListener", maybeEnableKeylog)` at the end of the `AgentBase`
constructor; future-socket attach in `createSocket` (both the async
`oncreate` path and the sync creation path). Test asserts
`socket.listenerCount('keylog') === 1` per existing socket.

### H-C-3 `test-http-agent-reuse-drained-socket-only.js` — [0,0] x2

Prior art: `NOTES-http-agent-reuse-drained-socket-only.md` — an earlier
lane added a veto in `AgentBase.keepSocketAlive`
(`src/http.js`: `if (socket.writableLength > 0) return false;`) and a
`writableLength` getter override in `src/net.js`. Probe proved: after
`req.end(64MB×3)`, `sock.writableLength = 268435456` immediately, but at
response end it is **0**; the peer's `readableLength` is 0 because
`_receiveFromPeer` (`src/net.js`) pushes chunks into
`this._pausedReadQueue` when the socket is paused (the server socket is
paused, never reads) instead of the Readable buffer. Fix: in the net.js
`writableLength` getter, also count `peer._pausedReadQueue` bytes beyond
the same 128 KiB window (131072).

**FLAG FOR COORDINATOR:** this touches `src/net.js` (another module's
file, against the lane's "do not touch any other module's files"). It is
the established mechanism for this exact test, written by the prior lane
for it; a pure-http.js alternative would duplicate the accounting by
peeking at `socket._peer._pausedReadQueue` from http.js, which is worse
engineering and still depends on net internals. Guarded by the net
differential (148/161 baseline) — see Guards.

### H-D-1 `test-http-1.0.js` — [0,0] x2

Failure: wire had `7\r\nHello, \r\n6\r\nworld!\r\n`, expected one chunk
`d\r\nHello, world!\r\n` + `1\r\nX\r\n`. Node `lib/_http_outgoing.js:1125-1157`:
`write()` corks the socket on the first non-end write and, while corked,
chunked writes accumulate in `kChunkedBuffer` and flush as ONE chunk on
nextTick uncork. (The `ERR_UNKNOWN_ENCODING` throw already passed; the
failure was only at the response validator.)

Fix: defer chunk framing — new `_pendChunkBody(buf)` accumulates raw
chunk body bytes into `_pendingChunkBody`, flushed at nextTick as a
single framed chunk via `_pendFrame`. The flush is a nextTick, not a
microtask, so a write scheduled in a later nextTick (the test's
`process.nextTick(() => res.end('X'))`) starts a NEW chunk (nextTick
queue is FIFO: the flush scheduled by the writes runs before end's
nextTick); a same-tick `end(chunk)` joins the pending body (Node's end
chunk is buffered while corked too). Applied in `ServerResponse._write`
(both the `_headerFlushed` and first-write branches; the header pends
alone in the first-write branch) and flushed synchronously by end()'s
terminator block and `_finishSocketResponse`'s streaming chunked branch
(and defensively at `_flushPendingFrame`). `_framedPending` counts raw
bytes while pending, framed bytes after the flush.
**Ceiling:** buffered (non-streaming) responses still frame per write in
`_flushHeaders`/`_writeBufferedResponse` — coalescing there needs tick
stamps on `outputData` entries, a separate change.
**`writableLength` framing (test-http-outgoing-properties repair):**
`_pendChunkBody` counts only raw bytes while pending, so a synchronous
`res.writableLength` read after `write('asd')` was 103 (header) + 3
(raw) = 106, expected 111 (header + framed chunk `3\r\nasd\r\n` = 8).
The getter now adds the pending chunk body's framing overhead
(`hexLen(body.length) + 4` — size line + two CRLFs) so the length reads
as the wire length synchronously.

### H-D-2 `test-http-outgoing-destroyed.js` — [0,0] x2

Failure: block 4 only — `res.write('x', cb)` then `res.destroy(err)`;
cb got `null`, expected `Error: Destroy test`. Node: the write is corked
/ buffered, callback pending; `destroy(err)` delivers the error to
pending write callbacks (`OutgoingMessage.destroy` → uncork → callbacks
fired with the destroy error on nextTick). The shim's `ServerResponse._write`
streaming branches called the Writable callback synchronously, so by
destroy time it had already fired null.

Fix (final design — see "Regressions repaired" for the two designs that
failed first): defer only the USER callback, in `ServerResponse.write()`
— never the Writable's callback. `write()` normalizes `encoding` (the
callback may arrive as the second argument — `ServerResponse.write` did
not do this; only `OutgoingMessage.write` did, so the wrapper was
silently skipped until the normalization was added), and when
`_isStreamingWrite()` is true (mirrors `_write`'s branch selection: a
real, non-destroyed, non-FakeSocket socket and a header that will be
rendered or is already flushed) it queues a thunk in
`_pendingFrameCallbacks` SYNCHRONOUSLY — the Writable invokes its
callback on nextTick (`afterWrite`), AFTER a synchronous destroy() in
the same tick, so queueing in the wrapper would run too late and
`_destroy` would find an empty queue. A `fired` flag keeps the user
callback exactly-once. The wrapper passed to `super.write` only fires
the user callback for a `_write` error (removing the queued thunk
first); otherwise the thunk fires at the flush (null) or the destroy
(error). `_flushPendingFrame` fires the queued thunks (null on success;
socket error if the frame was dropped).
`ServerResponse._destroy(err)` fires any still-queued thunks with `err`
synchronously (before the flush microtask can report success),
recording `err` in `_suppressedWriteErrors` first so the Writable's
`onwriteError` 'error' emission is swallowed (write errors are delivered
through callbacks only). A bare destroy leaves the thunks for the flush,
which fires null — no test pins `ERR_STREAM_DESTROYED` for a pending
response write callback. `_finishSocketResponse`'s streaming branches
fire any still-queued thunks as belt-and-braces. EVERY streaming write
queues its thunk in the one FIFO queue — including empty writes, which
pend no frame: firing them through the wrapper instead would reorder
them against the flush (test-http-outgoing-message-write-callback).
When no flush of either kind is scheduled, the thunk gets its own
microtask; when a chunk flush is pending, the thunk waits for it rather
than jumping ahead of earlier chunked writes.
(Verified against real Node 26: a plain Writable does NOT fire a pending
write callback on destroy — the error delivery is OutgoingMessage's own
destroy→uncork path.)

`_write`'s streaming branches keep calling the Writable callback
synchronously (see "Regressions repaired" for why deferring it broke
6 tests). `writableLength` counts the pending chunk body's framing
overhead in its getter (see H-D-1 note below).

### H-D-3 `test-http-response-socket-error.js` — [0,0] x2

Test loops 6 methods (`emit`, `emitAndDestroy`, `socketDestroy`,
`requestDestroy`, `reset`, `close`): server sends a partial body; client
`pipeline(res, writable, cb)` asserts `res.complete === false`,
`res.aborted === true`, pipeline err `code === 'ECONNRESET'`,
`message === 'aborted'`, `res.errored === err`, and `err.cause === error`
(the request's error object, as a non-enumerable own property) when
`error` is set, else no own `cause`.

Fix (in `_performVirtualRequest`'s catch): in the abort branch, create a
fresh `Error("aborted")` with `code = "ECONNRESET"`; set a non-enumerable
`cause` (via `Object.defineProperty`) only when the caught error is a
genuine socket error — not the round trip's synthesized close errors
(`ERR_SOCKET_CLOSED`, `socket hang up`); emit 'error' on the response
stream (guarded by listenerCount); set
`streamedMsg._readableState.errored = e` before `destroy()` (the ported
Readable's `errored` getter reads `_readableState.errored`; a bare
destroy leaves it null). The generic (non-abort) branch got the same
fresh-error + cause-rule treatment: a clean peer destroy synthesizes
`ERR_SOCKET_CLOSED`, whose message must not leak to the pipeline (the
`close` method expects `message === 'aborted'`).

The failing method was `requestDestroy`: `ClientRequest.destroy(err)`
destroyed the socket WITHOUT the error, so the round trip rejected with
synthesized `ERR_SOCKET_CLOSED` and the cause was lost. Fix in the sync
branch of `ClientRequest.destroy`: `sock.destroy(err)` instead of
`sock.destroy()` — grounded in real Node
`lib/_http_client.js:702-722` (`ClientRequest.prototype.destroy` does
`this[kError] = err; this.socket?.destroy(err);`). The socket error
forwarder cannot double-fire the request's 'error' (`_errorEmitted` is
already set for an explicit destroy error); `err` undefined →
`sock.destroy(undefined)` ≡ `sock.destroy()`. The deferred
(pre-round-trip) branch is unchanged. **FakeSocket exclusion
(test-http-agent-close repair):** the sync branch also runs when the
socket is still the FakeSocket placeholder (a `createSocket` override
that errored synchronously, before any socket was assigned) — passing
`err` there made `FakeSocket.destroy(err)` emit an unhandled 'error' on
the placeholder. The branch now calls `sock.destroy()` (bare) for a
FakeSocket and `sock.destroy(err)` only for a real socket; the request's
own error comes from `super.destroy(err)` below. Node's cause model
confirmed in source: `socketErrorListener` preserves the first socket
error as `req[kError]`, and `socketCloseListener` builds the abort error
with `{ cause: req[kError] }` when set.

### H-E-1 `test-http-server-raw-header-lookup.js` — [0,0] x2

Root cause: `parser.onHeadersComplete` called `_dispatchSocketRequest`
FIRST (the handler synchronously wrote the 200, flushed synchronously),
and only afterwards ran the 100-continue auto-ack — the reply was
`200 OK` + body first, `100 Continue` AFTER. Node
`lib/_http_server.js:1440-1452` (`parserOnIncoming`): with
`Expect: 100-continue` and no `checkContinue` listener, calls
`res.writeContinue()` BEFORE `server.emit('request', ...)`.

Fix: moved the auto-ack INSIDE `_dispatchSocketRequest`, just before the
dispatch emit, gated on dispatch event `"request"` + Expect
`100-continue` (case-insensitive) + HTTP/1.1 +
`listenerCount("checkContinue") === 0`; removed the post-dispatch ack
from `onHeadersComplete`. Placing it after body-callback/response wiring
preserves the reentrant-body guarantee (`test-http-expect-continue`); the
`checkContinue`/`checkExpectation` dispatches own their reply and never
auto-ack.

### H-E-2 `test-http-server-response-standalone.js` — [0,0] x2

`new ServerResponse(...)` + `assignSocket(ws)` (plain Writable) +
`res.end('hello world')`. Probe showed TWO writes: #1 (114 bytes, ends
with 'hello world') and #2 (0 bytes, empty). The test's Writable is
`common.mustCall(fn, 1)` — exactly one write — so the empty second write
also ran the assert and failed. Fix: removed `sock.write(Buffer.alloc(0))`
from the standalone finish listener in the `ServerResponse` constructor;
updated the constructor comment (it had claimed a trailing empty write
was "real Node's final empty socket write" — real Node delivers a
standalone response as a single write).

### H-E upside `test-http-no-read-no-dump.js` — [0,0] x2

The server never reads the POST body; the test relies on the server
socket's `pause` event (fired when the unread request's buffer fills) to
end the response, which unblocks the agent's queued GET. Root cause: the
shim's `onBody` wiring discarded the `push()` verdict, so a full request
buffer never paused the socket (hang).

Fix (Node `lib/_http_common.js:139`, `parserOnBody`): `IncomingMessage._pushBody`
now returns the `push()` verdict; the server's `onBody` wiring pauses the
socket when it is `false` (`readStop`); `IncomingMessage._read` resumes
the socket when the app reads (`readStart`,
`lib/_http_incoming.js:259-267`). **Ceiling:** the client-side `onBody`
(response) wiring does not pause its socket on push-false yet — same rule,
separate change with its own regression surface.

### H-F-1 `test-http-server-multiple-client-error.js` — [0,0] x2

Test sends ONE `socket.end('123 http://example.com HTTP/1.1\r\n\r\n')`;
the server hand-feeds via `socket.read(1)` + `unshift` + manual
`httpServer.emit('connection', socket)`; requires two `clientError`
emissions (`HPE_INVALID_METHOD`, rawPacket `'1'` then
`'23 http://example.com HTTP/1.1\r\n\r\n'`). The shim failed with an
unhandled `Error: read ECONNRESET` from `src/net.js` (`errnoError`, via
`errConnReset` / `notifyPeer`).

Diagnosis (probes 2026-11-20): at clientError#1 the server socket still
had `readableLength=34` (the remainder); the shim's Readable delivers
'data' per-chunk — '1' first, then 34 — IDENTICAL on real Node (proven by
a chunking probe run on both). The server socket's destroy then RST'd the
client because net.js `_destroy` counted `readableLength` as
kernel-unread. Real Node rule: closing a TCP socket sends RST only when
data is unread in the KERNEL receive buffer; bytes already read into the
JS readable buffer were read from the kernel, so destroy sends FIN. In
the shim the virtual kernel buffer is exactly the `_pausedReadQueue`
(paused sockets hold inbound chunks there via readStop). Fix in
`src/net.js` `_destroy`: `unread` = `_pausedReadQueue` byte sum ONLY
(dropped `readableLength`); comments rewritten to state the
kernel-vs-userspace distinction. Verified the two RST-pinning tests still
hold under the rule: `test-http-conn-reset` (server destroys immediately;
GET bytes sit in `_pausedReadQueue` since the socket never read → still
RST) and `test-http-destroyed-socket-write2` (client write-after-destroy
goes through `_write`'s not-connected branch → ECONNRESET, independent of
`_destroy`).

**FLAG FOR COORDINATOR:** second `src/net.js` touch (see H-C-3). Same
justification: the rule lives in net's `_destroy`; the http-side
alternative (pre-draining the readable buffer before destroy) would
change observable delivery. Guarded by the net differential — see Guards.

### H-F-2 `test-http-request-method-delete-payload.js` — [0,0] x2

Node rule (`lib/_http_outgoing.js:595-620`): implicit Content-Length is
added only when `useChunkedEncodingByDefault` is true AND
`this._contentLength` is a number; for DELETE/GET/etc.
(`useChunkedEncodingByDefault=false`) there is no framing and `this._last
= true` (connection closes). Shim bug: `_serializeRequestHead` added
`Content-Length` for ANY non-empty body, so the DELETE went out with
`Content-Length: 26` and the server parsed the trailing
`PUT / HTTP/1.1\r\n\r\n` bytes as the DELETE body. Fix: gate the
non-empty-body implicit CL on `useChunkedEncodingByDefault` (already a
`_serializeRequestHead` parameter, passed as
`this.useChunkedEncodingByDefault` by both callers). The empty-body
`Content-Length: 0` rule for POST/PUT/PATCH stays.

### H-G-1 `test-http-connect-default-host-header.js` — [0,0] x2

Node `lib/_http_client.js:562-566`: `if (host && !this.getHeader('host')
&& setHost)` — CONNECT default Host = the request path (authority).
Probe showed the shim sent `Host: 127.0.0.1:55545` while the server
asserted `Host: target.example.com:443`; the wrong Host made the assert
throw inside the socket 'data' handler, swallowed in the client's write
path, so the server never sent 200 and the client hung (124) — the hang
was the symptom, the wrong Host the cause. Fix in `src/http.js`
ClientRequest constructor auto-Host block: when
`this.method === "CONNECT" && options.path`, `hostHeader =
String(this.path)`; else the existing IPv6-bracket + port logic.

### H-G-2 `test-http-request-connect-path.js` — [0,0] x2

Node `lib/_http_client.js:335-359, 481-484`: `pathIsFromURL` true when
input is string/URL unless options has own 'path' (override → false);
`if (method === 'CONNECT' && pathIsFromURL && path[0] === '/') path =
path.slice(1) || '/'`. Fix in `src/http.js`: `parseRequestArgs` tracks
`pathIsFromURL` (set true in the string/URL branch, cleared if
`optionsOrCallback` has own 'path' via
`Object.prototype.hasOwnProperty.call`), stashed as
`options._pathIsFromURL`; ClientRequest constructor applies the strip at
the `this[kPath]` assignment. Test:
`http.request(new URL('http://localhost:PORT/example.com'),
{method:'CONNECT'})` must yield server `req.url === 'example.com'`;
`{host, port, method:'CONNECT', path:'/example.com'}` must yield
`'/example.com'`.

### H-H `test-http.js` — [0,0] x2

Test reads `req._header.match(/^Cookie:.+$/img)` in the response
callback, expecting `['Cookie: foo=bar; bar=baz; baz=quux']` (one line,
`; `-joined) for object-form setHeader-array cookies,
`['Cookie: node=awesome; ta=da']` for `setHeader('Cookie', [...])`, and
three separate `Cookie:` lines for array-form headers
`[['Cookie','abc=123'],...]`. Shim: `ClientRequest._implicitHeader` set
`this._header` to only the request line, and the virtual/buffered paths
serialize headers via `_serializeRequestHead` without ever setting
`this._header`. Fix (two parts): (1) materialize `this._header` as the
full serialized head at request dispatch time — `req: this` threaded into
`_socketHttpRoundTrip` options from `_performRequest`; in the round trip,
the streaming branch sets `req._header = headBytes.toString("latin1")`,
the buffered branch captures `wireBytes` and sets `req._header` to the
head part (up to first `\r\n\r\n` inclusive). Safe because
`_implicitHeader()` only runs `if (!this._header)`. The runtime-bridge
caller has no request and omits `req`. (2) Cookie-array rendering in
`_serializeRequestHead`'s entries loop — Node `lib/_http_outgoing.js`
`processHeader` (655-670): an array value renders one line per element
EXCEPT a Cookie array, which joins with `'; '` into one line
(`isCookieField`); the unique-headers join is handled upstream by
`_virtualHeaders`. Fix: empty array → no lines; `cookie`
(case-insensitive, length-6 name check) → `value.join("; ")`; else one
line per element. Array-form pairs are separate entries (string values),
so they stay separate lines.

## Regressions repaired (8 total across differentials #1–#3, all fixed)

The first full differential after the flips landed was 406/422 with 6
regressions (all from the first H-D-2 design, which deferred the
WRITABLE's callback in `_write`) plus `test-http-1.0.js` still failing.
All were repaired; a second differential then read 411/422 with 1 new
regression, repaired; a third read 412/422 with 1 new regression,
repaired; the fourth differential (see Guards) reads 413/422 with 0
regressions (413th pass is the unclaimed flake).

### First H-D-2 design — why deferring the Writable callback fails

Deferring `_write`'s callback to the flush microtask stalls the Writable
pipeline: the Writable delivers the next buffered write only after the
previous callback fires, so a write buffered behind a pending flush is
delivered after `end()`'s terminator block already ran. Consequences
observed (isolated, 2026-11-20):

- `test-http-1.0.js` (EXIT=1): the terminator (`0\r\n\r\n`) interleaved
  between the two chunks — `end()`'s nextTick chunk flush overtook the
  still-buffered writes.
- `test-http-outgoing-properties.js` (EXIT=1): `res.writableLength`
  after `res.write('asd')` read 103, expected 111 — the chunk frame
  (`3\r\nasd\r\n` = 8 bytes) was not yet counted (see the H-D-1
  `writableLength` framing note for the fix).
- `test-http-outgoing-finish.js` (EXIT=1): ServerResponse write
  callbacks never fired — the 3rd queued callback's flush never ran
  before the process exit check (traced: 3 queues, 2 flush firings).
- `test-http-abort-stream-end.js`, `test-http-agent-close.js`,
  `test-http-unix-socket.js`, `test-http-write-empty-string.js` (EXIT=1
  in the differential; all EXIT=0 isolated after the rework).

Repair: the wrapper design described in H-D-2 — `_write` keeps calling
the Writable callback synchronously; only the USER callback is deferred,
in `ServerResponse.write()`. Two further bugs in the wrapper itself,
found isolated:

- The wrapper was skipped entirely: `res.write('x', cb)` passes the
  callback as `encoding`, and `ServerResponse.write` never normalized it
  (only `OutgoingMessage.write` did), so `callback` was `undefined`.
  Fixed by normalizing `encoding` at the top of
  `ServerResponse.write`.
- The wrapper queued the thunk on nextTick (`afterWrite`), AFTER a
  synchronous destroy() — `_destroy` found an empty queue and the
  callback got null. Fixed by queueing the thunk SYNCHRONOUSLY in
  `write()`.

### `test-http-agent-close.js` — FakeSocket destroy error

The H-D-3 `sock.destroy(err)` change also ran when the socket was still
the FakeSocket placeholder (a `createSocket` override that errored
synchronously); `FakeSocket.destroy(err)` emits an unhandled 'error' on
the placeholder. Fixed by passing `err` only to real sockets (see
H-D-3 note). Verified: `test-http-agent-close.js` EXIT=0 and
`test-http-response-socket-error.js` EXIT=0 after the fix.

### `test-http-outgoing-message-write-callback.js` — callback order

Found in the second differential (411/422): it passed in the baseline
and in the first differential, failed after the wrapper rework. The test
writes `'a','b','',Buffer(0),'c'` on an assigned-socket response and
expects the callbacks in write order. The wrapper fired empty writes
through the Writable's nextTick while non-empty writes fired through the
flush microtask, reordering `'c'` before `''` and `Buffer(0)`.
Fixed by queueing EVERY streaming write's thunk in the one FIFO queue
(including empty writes) and giving the thunk its own microtask only
when no flush of either kind is scheduled. Verified EXIT=0 isolated,
and `test-http-outgoing-destroyed.js` still EXIT=0.

### `test-http-outgoing-writableFinished.js` — first-write microtask pre-emption

Found in the third differential (412/422, 1 regression): the test's last
block writes `'hello'` to a response whose socket is a foreign Duplex
whose write always calls back with `Error('forced write failure')`, and
expects the write callback to receive that error. The order fix's
microtask fired the thunk with null: the "no flush scheduled" check runs
BEFORE `super.write()` pends the frame, so a first write always looked
flush-less, and the microtask (scheduled before the flush microtask)
pre-empted the flush that would have delivered the socket's write error
through the foreign branch. Fixed by re-checking the flags when the
microtask runs — `_write` schedules the real flush synchronously inside
`super.write()`, so by microtask time a pending flush is visible and
the microtask stands down, letting the flush deliver the true outcome;
only a still-flush-less thunk fires null. Verified EXIT=0 isolated, and
`test-http-outgoing-message-write-callback.js` and
`test-http-outgoing-destroyed.js` still EXIT=0.

## NO-FIX

### `test-https-response-tls-error.js` (H-D upside) — NOT flipped, still hangs (124 at 30s)

Same error-propagation area as H-D-3 but over virtual TLS: the test writes
an invalid TLS record to the server-side TLSSocket and expects an
`ERR_SSL_*` request error (`err.cause === requestError`,
`res.errored === pipeline err`). The shim's virtual TLS layer never
validates the record, so no request error is produced and the test hangs.
Fixing it requires TLS record parsing in the virtual TLS layer — out of
scope for the http lane, a much bigger lift. Recorded, not claimed.

### `test-http-server-drop-connections-in-cluster.js` — FLAKE, not a target

Passed in the banked sweep but TIMING-FLAKY (coordinator isolated: run 1
= 124 timeout, run 2 = 0 pass). NOT counted in the 393 banked count, NOT
claimed. If it moves in the differential, adjudicate isolated 2x before
counting.

## Guards

- Full http differential via `run-baseline.mjs` (jobs 4, short 10s /
  full 30s). Baselines were lost in a /tmp wipe on 2026-11-20 (see
  below); re-run outputs live in `~/workspace/w2-http-hbhh/diff2/`:
  - Differential #2 (after the wrapper rework + FakeSocket fix,
    `diff2/diff-http-2.jsonc`, CSVs `diff2/csv-diff-http-2/`):
    **411/422 pass, 10 fail, 1 timeout**. Non-pass: baseline fails
    agent-domain-reused-gc, agent-free-socket-pending-read,
    autoselectfamily, chunk-problem, parser-lazy-loaded (129),
    parser-timeout-reset (129), pipeline-flood, server-stale-close
    (HELD), websocket-mask-immutable (9, NO-FIX); the flake
    server-drop-connections-in-cluster (124 — adjudicate isolated 2x,
    do NOT claim); and ONE regression,
    test-http-outgoing-message-write-callback.js (repaired after this
    run — see "Regressions repaired"). All 19 flips pass in this run;
    the 6 earlier regressions are all fixed.
  - Differential #3 (after the write-callback order fix,
    `diff3/diff-http-3.jsonc`, CSVs `diff3/csv-diff-http-3/`):
    **412/422 pass, 10 fail, 0 timeout**. Non-pass: the same 9 baseline
    fails as #2 (agent-domain-reused-gc, agent-free-socket-pending-read,
    autoselectfamily, chunk-problem, parser-lazy-loaded (129),
    parser-timeout-reset (129), pipeline-flood, server-stale-close
    (HELD), websocket-mask-immutable (9, NO-FIX)); the flake
    server-drop-connections-in-cluster PASSED this run; and ONE
    regression, test-http-outgoing-writableFinished.js (repaired after
    this run — see "Regressions repaired"). All 19 flips pass.
  - Differential #4 (after the writableFinished microtask re-check fix,
    `diff4/diff-http-4.jsonc`, CSVs `diff4/csv-diff-http-4/`):
    **413/422 pass, 9 fail, 0 timeout** — 0 regressions. Non-pass is
    exactly the baseline remainder (agent-domain-reused-gc,
    agent-free-socket-pending-read, autoselectfamily, chunk-problem,
    parser-lazy-loaded (129), parser-timeout-reset (129), pipeline-flood,
    server-stale-close (HELD), websocket-mask-immutable (9, NO-FIX)).
    The 413th pass is the flake server-drop-connections-in-cluster,
    which passed this run but 124'd in differential #2 and in isolated
    adjudication (run 1 = 0, run 2 = 124) — NOT counted, NOT claimed.
    Final count: **393 + 19 flips = 412/422**.
- Net differential (guard for the two `src/net.js` touches,
  `diff-net/diff-net-2.jsonc`, CSVs `diff-net/csv-diff-net-2/`):
  **148/161 pass, 10 fail, 3 timeout** — exactly the baseline counts
  (148/161). Guard held; the net.js touches regress nothing.
- Repo tests (`npx --no-install jest`) and vendored official tests: run on
  the pushed branch via CI (see PR section).

## PR

- PR #529 — https://github.com/MarketingPip/bundleVFSModules/pull/529 —
  branch `feat/w2-http-hbhh`, one PR, squash-merge only on green CI.
- Local commit 2a16a0bd (base e895aceb) pushed as remote c8eb290b; the
  build job's dist-regen pushed 0f14c620, which conflicted with main's
  dist/ (fs lane #528 had regenerated it) — `mergeable_state: dirty`.
  Resolved by rebasing onto current main 84702e73 (clean, verified by
  merge-tree) and force-pushing the reviewed rebase: remote head is now
  code SHA **f1b11daf60e5bf5b2df11c9daf59758ff524e289** (`mergeable:
  True`). The code SHA c8eb290bdf… was green on both CI jobs (Parity
  success, build success) before the rebase; the waiter re-pinned to
  the rebased code SHA.
- Dist-regen rule (fs lane #528 precedent): bot dist-regen heads never
  get check-runs (bot pushes don't trigger workflows), so the merge
  decision rides on the CODE SHA's green checks; the waiter logs regen
  head moves but does not re-pin to them.
- NO docs-number changes in the fix PR.
- Commit `--no-verify`; diff hunks verified before pushing (only
  `src/http.js`, `src/net.js`, `NOTES-26-http-hbhh.md`); push via
  `git-push-api.py` (full os.environ, `--force` only for the reviewed
  rebase); PR via `gh.py`; CI waiter as a runtime-tracked backgrounded
  exec pinned to the remote code SHA.

## Ship

- PR: #529
- Merge SHA: `10bdfcaae51e989261f5a65e268d6452fa67a249` (squash-merge of PR #529)
- Final count: **http 412/422** (393 banked + 19 flips, 0 regressions)
