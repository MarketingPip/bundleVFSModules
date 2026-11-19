# NOTES — Node 26 re-target triage, module http2 — 2026-11-19

Base main: `3c091022`. Worktree `node26-triage-http2` (detached HEAD, docs only —
no src/ changes). Host Node v24.22.1; Node 26 binary
`~/workspace/local/node-26/bin/node` verified `--version` = `v26.13.1` before
any probe. Node 26 source: `~/workspace/local/node-26-src/`. Node 24.20.0
source pack: `~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/node-src/`.

## Counts — 201 gaps, reconciled exactly

| | count |
|---|---|
| Baseline `test-http2-*` files run (node26-baseline.jsonc, `parity/drift/`) | 289 |
| Pass | 88 |
| Fail (exit 1) | 198 |
| Timeout (124) | 3 |
| **Non-pass = gap total** | **201** |
| Oracle class (`gaps-http2.json`) | 201 shim-gap / 0 fails-natively / 0 native-timeout |

Export diff (`parity/drift/node26-export-diff.md`): http2 has **no**
export-surface change (0 added / 0 removed / 0 changed). Changelog
cross-check (`~/workspace/research_notes/node-24-to-26-drift-20261119-1722/cross-check-changelog-2026-11-19.md`,
`http2` row): no listed-module change in 25/26.0.0, security fixes only.
The gaps are therefore behaviour / test changes, not new APIs.

## Baseline verification — isolated re-run WITH flags reproduces 201/201

The baseline runner (`parity/drift/run-baseline.mjs`, `runOne`) runs
`timeout N node --import <preload> parity/node-test/parallel/<test>` with
`PARITY_TARGET=http2` and does **not** pass the tests' `// Flags:` headers,
while the oracle (`run-oracle.mjs`, `flagsFor`) does. 29 gap tests carry
flags (23 `--expose-internals`, 5 `--expose-gc`, 1 `--no-warnings`), so a
flag artifact was possible. Adjudication: staged the Node 26 test tree into
the worktree (`parallel` + `common` + `fixtures`, as `run-baseline.mjs`
`stage()` does) and re-ran all 201 **with** their flags, 15 s cap, 4 workers
(script + raw results:
`~/workspace/worktrees/node26-triage-http2/.scratch/rerun.py`,
`.scratch/rerun.jsonl`).

Result: **198× exit 1, 3× exit 124, 0 pass with flags** — identical to the
baseline, including the same 3 timeouts. The flag hypothesis is dead: no gap
is a missing-flags artifact. Worktree restored clean after every run
(`git status --porcelain -- parity/node-test` empty; staged-only files
removed).

## v24 → 26 reconciliation — the wave held, exactly 2 deltas, both test rewrites

| | v24 (wave H2, 2026-11-18) | Node 26 (shared 277 files) |
|---|---|---|
| Files | 277 (276 `.js` + 1 `.mjs`) | 277 shared, 0 removed |
| Pass | 87 | 85 |
| Gap | 190 | 192 |

- **All 190 v24 gaps are still gaps in 26** (verified by set intersection of
  the v24 wave-end CSV pass set against the 26 baseline: 190/190).
- **All 20 v24 lane-target checks still pass in 26**, including the ones the
  v24 triage predicted would NOT flip (`pipe-named-pipe`,
  `server-setLocalWindowSize` — both pass via H2-V1/V4 side effects).
  Lane targets verified passing: H2-F1 (3), H2-V2 (1), H2-V3 (2), H2-V1 (3),
  H2-V5 (1), H2-V6 (2), plus the V4/V4b side-effect flips.
- **New files in 26: 12, 0 removed.** 3 pass outright
  (`max-session-memory-stalled-data`, `respond-with-file-cancelled-crash`,
  `session-destroy-stream-handler`); 9 gap (see § New-in-26).
- **The 2 lost passes are test rewrites, not shim regressions:**
  - `test-http2-async-local-storage.js` — Node 26 rewrote the test (diff
    vendored vs `node-26-src/test/parallel/`): a second `runTest` scenario
    was added (response with trailers, gRPC-style: `respond(..., 
    { waitForTrailers: true })` + `wantTrailers` + `sendTrailers` +
    `stream.write('data'); stream.end()`). The no-trailers half still passes
    under the shim. The trailers half exposes a real shim bug — see lane
    H2-26-WR. **Not** a V4b re-regression.
  - `test-http2-util-update-options-buffer.js` — Node 26 added the
    `connectionWindowSize` option to the internal options buffer
    (`lib/internal/http2/util.js:234-235,305-308`: new index 13,
    `IDX_OPTIONS_FLAGS` 13→14). The test reads the **host** Node's internal
    buffer (`require('internal/http2/util')` + `internalBinding('http2')`
    are not redirected by `parity/preload.mjs` for the http2 target), and the
    harness runs on host v24.22.1, whose buffer has no such slot. See
    § Baseline corrections — this one is a host-version artifact, not a shim
    gap.

## Families (201 — grouped by first-failure signature from the isolated re-run)

| Family | n | Classification |
|---|---|---|
| A. Awaited callback never fires | 78 | NO-FIX except `async-local-storage` (lane WR) |
| B. Assertion diffs (live state / deep-equal) | 61 | Mixed: NO-FIX 56, lane 4, host artifact 1 |
| F/G. ECONNREFUSED / native-client rejection | 24 | NO-FIX |
| C. Read of undefined (`.socket`, settings) | 17 | NO-FIX |
| C-null. Read of null | 5 | NO-FIX |
| L. Set properties of undefined | 2 | NO-FIX |
| E. Missing expected exception | 3 | Validation residue (flips TBD, no lane claimed) |
| T. Timeout (124) | 3 | NO-FIX |
| Q. Singles / unhandled rejections | 8 | NO-FIX |
| **Total** | **201** | |

### A. Awaited callback never fires — 78 — NO-FIX except 1 (lane WR)

`Mismatched <anonymous>/noop function calls. Expected exactly N, actual 0`
— an event the test awaits never fires. Sub-groups:

- **A-lifecycle (63):** close-after-cancel/RST, GOAWAY, session timeout/
  close, trailers-after-end, flow-control window updates, priority events,
  stream-destroy ordering, server-close/timeout callbacks. All lifecycle
  transitions only real nghttp2 state produces. Representatives (v24
  triage, re-confirmed by identical 26 signatures):
  `cancel-while-client-reading`, `server-rst-stream`,
  `goaway-delayed-request`, `goaway-opaquedata`, `server-timeout`,
  `timeouts`, `session-unref`, `dont-lose-data`, `close-while-writing`.
- **A-respond-file (11):** `respond-file-304`, `respond-file-404`,
  `respond-file-compat`, `respond-file-error-dir`, `respond-file-fd-invalid`,
  `respond-file-fd-range`, `respond-file-fd`, `respond-file-push`,
  `respond-file-range`, `respond-file`, `respond-with-file-connection-abort`.
  `respondWithFile`/`respondWithFD` are documented noops in the shim
  (`src/http2.js` header); the streams never complete, so the awaited
  callbacks never fire. Needs real fds.
- **A-priority (4):** `client-priority-before-connect`,
  `client-set-priority`, `priority-cycle-`, `priority-event`. No priority
  tree exists in the virtual loop.
- **Lane member (1, inside A-lifecycle by signature):**
  `async-local-storage` — see H2-26-WR. Its no-trailers half passes; only
  the new trailers half fails, on a `data` mustCall, not a lifecycle event.

### B. Assertion diffs — 61 — NO-FIX 56, lane 4, host artifact 1

- **B-live-state (39):** strictly-equal / deep-equal diffs on live nghttp2
  state: `buffersize` (`0 !== 30`, no real buffering/flow-control),
  `create-client-session` (`undefined !== 'h2c'`, no ALPN on the session),
  `client-proxy-over-http2` (`204 !== 200`), `server-rfc-9113-*` (frame-level
  RFC 9113 compliance), `cookies` (`'object' !== 'string'`, set-cookie
  shape), `perf_hooks` (`0 !== 5`, no `http2` perf entries — no public API),
  `max-invalid-frames` (nghttp2 invalid-frame counting),
  `empty-frame-without-eof` (invalid-frames error code vs ECONNREFUSED),
  `session-stream-state`, `stream-client` (state string fails `/state:/` —
  `stream.state` is a static plausible value), `multiheaders`,
  `zero-length-header`, `util-headers-list`, `response-splitting`,
  `server-push-stream*` (push), `reset-buffered-read` (RST_STREAM buffered
  reads — new in 26, needs real RST state), `graceful-close` ×2 (GOAWAY +
  drain), `ping`, `res-corked`, `endafterheaders`, `compat-expect-continue*`
  (`false !== true`, 100-continue flag never set), `server-startup`,
  `options-server-request`, `too-many-settings`, `info-headers`,
  `connect-method`, `server-push-stream-errors` (shim's honest
  `ERR_HTTP2_PUSH_DISABLED` vs expected `ERR_HTTP2_OUT_OF_STREAMS`),
  `unbound-socket-proxy` (expected `ERR_HTTP2_SOCKET_UNBOUND`, no socket),
  `server-stream-session-destroy`, `compat-serverresponse-flushheaders`,
  `compat-serverresponse-headers`, `compat-serverresponse-write`,
  `compat-serverresponse-writehead-array`, `compat-serverresponse`,
  `compat-write-information`, `client-http1-server`, `client-promisify-connect-error`.
- **D-must-not-call fired (13):** the shim dispatches a request the real
  stack would reject at the connection/frame level — no frame-level
  admission control in the virtual loop. `client-onconnect-errors`,
  `client-unescaped-path`, `compat-expect-handling`,
  `compat-method-connect`, `compat-serverresponse-destroy`,
  `compat-write-head-destroyed`, `compat-short-stream-client-server`,
  `max-concurrent-streams`, `options-max-headers-block-length`,
  `options-max-headers-exceeds-nghttp2`, `server-shutdown-before-respond`,
  `short-stream-client-server`, `too-many-headers`.
- **I-socket asserts (4):** `compat-serverrequest`,
  `compat-serverresponse-finished`, `compat-socket`, `socket-proxy` — all
  `assert.ok(request.socket instanceof net.Socket)` / falsy socket checks.
  The shim has no socket object; the tests then use it for real I/O.
- **Lane members (4):** `compat-get-headers` (H2-26-C1),
  `connection-window-size-option` (H2-26-W1), `client-data-end` (moves on
  under H2-26-WR — push blocks the flip), `write-callbacks` (H2-26-WR).
- **Host artifact (1):** `util-update-options-buffer` — see § Baseline
  corrections.

### F/G. ECONNREFUSED / native-client rejection — 24 — NO-FIX

`dispatchVirtualRequest` throws ECONNREFUSED when no server is registered
for the port (`src/http2.js:3119`, correct per the shim's design), but these
tests connect to a REAL server (an http/1 server, a TLS server, a server on
a real port) or use real ALPN negotiation (`autoselect-protocol`, `alpn`,
`perform-server-handshake`, `https-fallback-http-server-options`,
`server-unknown-protocol`). No real sockets exist to connect to. Members:
`allow-http1`, `alpn`, `autoselect-protocol`, `backpressure`,
`client-connection-tunnelling`, `connect-tls-with-delay`, `connect`,
`generic-streams`, `generic-streams-sendfile`, `invalid-last-stream-id`,
`misbehaving-flow-control`, `misbehaving-flow-control-paused`,
`padding-aligned`, `perform-server-handshake`, `premature-close`,
`sensitive-headers`, `session-cleanup-on-nghttp2-goaway`,
`session-cleanup-on-nghttp2-goaway-after-peer-goaway` (new in 26),
`settings-unsolicited-ack`, `window-update-overflow`,
`write-finishes-after-stream-destroy`, `file-reset-pending-write` (new in 26).

### C. Read of undefined / null (22) + L. Set of undefined (2) — 24 — NO-FIX

Dominant shape is `.socket`: `res.socket.on(...)`
(`byteswritten-server`), `client.socket.listenerCount(...)`
(`create-client-secure-session`, socket is null),
`request.socket instanceof net.Socket` (`compat-serverrequest` family),
`client.socket.remoteAddress` (`connect-options`),
`res.socket.writableHighWaterMark` (`res-writable-properties`). The shim
has no socket object to expose, and the tests then use it for real I/O
(destroy, bytesWritten, listeners) — a fake socket would need a whole
transport behind it. Remainder are live SETTINGS/state reads
(`session-settings`, `update-settings`) — no real SETTINGS exchange ever
populates remote settings. L: `compat-serverresponse-drain`,
`compat-socket-set` — socket properties again.

### E. Missing expected exception — 3 — validation residue, flips TBD

`altsvc` (test:59 — `ERR_INVALID_CHAR` for alt-svc values `'\u0001'`,
`'h2="\uff20"'`, `'👀'`; the H2-V4 validation covers the earlier throws in
this test, this residue is the character check),
`origin` (test:41), `origin-set-max-size.mjs` (test:44 — `connect()` with a
bad `maxOriginSetSize` must throw `ERR_INVALID_ARG_TYPE`). All three are
pure-JS validations the shim does not perform, but each test then needs
real framing/origin exchange over TLS, so **no flip is counted** — a lane
implements the throws and re-verifies each test isolated 2×, banking only
what passes. Not NO-FIX (the throw half is real shim work); not a counted
lane (the rest is inherent).

### T. Timeout (124) — 3 — NO-FIX

`respond-file-error-pipe-offset`, `respond-file-with-pipe`,
`socket-close`. Reproduced [124,124] in the isolated re-run as well as the
baseline (v24 triage also proved [124,124] isolated / 0 native for all
three). `respondWithFile`/`respondWithFD` are documented noops, so the
streams never complete; the socket-close path never completes the session
(no real socket close to observe). Genuine, not flakes.

### Q. Singles / unhandled rejections — 8 — NO-FIX

- `allow-http1-upgrade-ws`, `client-promisify-connect` — unhandled promise
  rejection (`ERR_UNHANDLED_REJECTION`, reason `#<_ErrorEvent>` /
  `#<ClientHttp2Session>`): the WebSocket upgrade / promisified connect
  rejects because the virtual session cannot establish a real connection.
  Real HTTP/1 upgrade handshake / real socket required.
- `capture-rejection` (`Error: kaboom` — async error propagation across
  the virtual loop), `client-stream-destroy-before-connect` (`Error: test`),
  `compat-serverresponse-end` (`RangeError: Maximum call stack size
  exceeded` in `util.inspect` — response inspection shape),
  `onping` (`Error: The session has been destroyed` — ping after destroy,
  real session-teardown ordering), `respond-file-fd-leak`
  (`":method" is an invalid pseudoheader` — the test needs real file
  serving, the shim's validation throws first),
  `respond-file-filehandle` (`The "fd" argument must be of type number or
  an instance of FileHandle. Received an instance of FileHandle` — the shim
  rejects `FileHandle` in `respondWithFD`; fixing the type check alone
  cannot flip it, the test then needs real fd serving).

## Lane candidates (conservative estimated flips: 4)

### H2-26-WR — `Http2Stream.write()` side-routing (PROBABLE, 2 flips)

Root cause (probe-proven, read at `src/http2.js:2276-2291`): `write()`
routes by `this._requestEnded` — if the client request has not ended yet,
the chunk goes to `_requestChunks` (request body). The server handler runs
at dispatch time, before the client ends, so a server-side `write()` lands
in the request body instead of the response. `end(data)` already routes by
`_responseStarted` (`src/http2.js:2311-2316`, fixed in H2-V4 with a comment
citing this very test); `write()` has the same bug `end()` had. Fix shape:
route `write()` by `_responseStarted` like `end()` does.

Evidence — instrumented copy of the real test run from inside
`parity/node-test/parallel/` (so the preload redirect applies; probes run
from outside that directory load **native** http2 and prove nothing — see
§ Method trap), `.scratch/zz-als-probe.js`, output `.scratch/zz-als-out.txt`:

```
STREAM no-trailers / RESP 200 / DATA id= 1 / END id= 1
STREAM no-trailers / RESP 200 / DATA id= 2 / END id= 2
STREAM trailers    / RESP 200 / END id= 1        <- DATA never fires
STREAM trailers    / RESP 200 / END id= 2        <- DATA never fires
Mismatched <anonymous> function calls. Expected exactly 1, actual 0.
  at doReq (.../test-http2-async-local-storage.js:33:29)   # the 'data' mustCall
```

The trailers server handler does `stream.write('data'); stream.end()` with
`waitForTrailers: true`; the write is swallowed into `_requestChunks` and
`_deliverResponse` reads the empty `_responseChunks`. Natively (same probe
under `node-26.13.1`, `.scratch/zz-als-native.cjs`) DATA fires in both
scenarios. Second instance, signature-consistent: `write-callbacks` fails
`'abcabcxyz'` vs expected `'abcxyz'` — the server's `write('abc')` was
delivered to the server's own request-body consumer (misrouted), plus the
client's `write('abc')` + `end('xyz')`.

- Probable flips (2): `test-http2-async-local-storage.js`,
  `test-http2-write-callbacks.js`.
- Moves on (0 flips): `test-http2-client-data-end.js` — same write-routing
  first failure (`'st' !== 'test'`: server `write('te')` lost, `end('st')`
  delivered), but the test also requires `pushStream`, which the shim
  honestly rejects with `ERR_HTTP2_PUSH_DISABLED` (inherent). WR moves it
  past the first failure; push blocks the flip.
- Guard set: the 88-test pass set, especially `zero-length-write`
  (V4b — its fix depends on the shared-stream end routing) and all
  `compat-serverresponse-*` tests. The lane re-runs each candidate isolated
  2× and banks only what passes.

### H2-26-W1 — `connectionWindowSize` option + session state + validation (PROBABLE, 1 flip)

New-in-26 test `test-http2-connection-window-size-option.js`. First failure
(`:33`): `65535 !== 2097152` — `client.state.effectiveLocalWindowSize`
after `connect(..., { connectionWindowSize: 2**21 })`. The shim never
accepts the option: session `state` (`src/http2.js:1231-1244`) reports
`effectiveLocalWindowSize`/`localWindowSize` from fields seeded to 65535
(`:1182-1183`, only `setLocalWindowSize` updates them, `:1419-1421`) and
`remoteWindowSize` is hardcoded `65535`. The test then asserts the peer
views (`session.state.effectiveLocalWindowSize` / `remoteWindowSize` per
side), validation throws (`ERR_OUT_OF_RANGE` for `-1, 0, 2**31, 1.5`;
`ERR_INVALID_ARG_TYPE` for `'1024', null, {}` on `createServer` /
`createSecureServer` / `connect`), and a 16 KiB-window + 256 KiB-payload
upload that must still complete (the shim's H2-V1 lazy body delivery
already moves whole bodies, so the payload half is plausibly compatible).
Native 26.13.1 probe (`.scratch/probe-native26.cjs`): client
`effectiveLocalWindowSize = 2097152`, server session
`effectiveLocalWindowSize = 1048576`, `remoteWindowSize = 2097152` — the
option is reflected in live state natively. Fix shape (pure JS): accept +
validate `connectionWindowSize` in `createServer`/`createSecureServer`/
`connect`, seed the session window fields, propagate the peer's value to
`remoteWindowSize` at dispatch. Overlaps the internal-options-buffer layout
work only in name — `util-update-options-buffer` is a host artifact (§
Baseline corrections), not part of this lane.

- Probable flip (1): `test-http2-connection-window-size-option.js`.

### H2-26-C1 — compat `getHeaders()` null-prototype store + `:status` after `flushHeaders` (PROBABLE, 1 flip)

New-in-26 test `test-http2-compat-get-headers.js`. First failure: deep-equal
on `response.getHeaders()`. The shim (`src/http2.js:2797-2846`) stores
headers in a plain object (`this._headers[lowered] = value`) and returns a
spread copy. Two pure-JS defects vs Node
(`lib/internal/http2/compat.js`): (1) `setHeader('__proto__', 'proto')`
assigns to a plain object, so it sets the prototype instead of storing an
own key — the store must be null-prototype; (2) `getHeaders()` must return
a null-prototype object (the test asserts
`Object.getPrototypeOf(empty) === null` and deep-equals against a
null-prototype literal, with integer-like keys `'2'`, `'10'` ordered before
string keys). The test's later half also asserts that after
`setHeader('X-Sent', 'value')` + `flushHeaders()`, `getHeaders()` equals
`{ '__proto__': null, 'x-sent': 'value', ':status': 200 }` — so the lane
must also surface `:status` in the store once headers are sent. Set-Cookie
array identity (`headers['set-cookie']` is the same array; pushing to it
shows in `getHeader`) already works via the spread copy sharing the array
reference. Fix shape: null-prototype header store + null-prototype
`getHeaders()` copies + `:status` recorded on send.

- Probable flip (1): `test-http2-compat-get-headers.js`.

## NO-FIX — 193

201 − 4 counted lane flips − 1 host artifact − 3 validation-residue = **193**.
Every family above marked NO-FIX, by mechanism, not by name:

- Needs real HTTP/2 framing / HPACK / SETTINGS exchange / flow control /
  multiplexing over a socket (families A, B-live-state, D, F/G, T): the
  virtual loop has no frames, no HPACK, no window accounting, no RST_STREAM
  / GOAWAY propagation, no priority tree. A real nghttp2 engine cannot exist
  in a browser; the WASM-nghttp2 path is a whole-subsystem design, not a
  lane (v24 triage § Future paths — unchanged).
- Needs real sockets / TLS / ALPN (families C, L, I, F/G): the shim exposes
  no socket; tests use it for real I/O (`destroy`, `bytesWritten`,
  `listenerCount`, `remoteAddress`, `instanceof net.Socket`).
- Needs real server push (K, `server-push-stream*`, `client-data-end`'s
  second half): the shim's honest `ERR_HTTP2_PUSH_DISABLED` is documented
  design.
- Needs real fds / file serving (`respond-file*`, `respond-with-fd*`,
  `generic-streams*`): `respondWithFile`/`respondWithFD` are documented
  noops; `respond-file-fd-leak` / `respond-file-filehandle` additionally
  trip the shim's validation first, but fixing the validation cannot flip
  them without real serving.

Native 26.13.1 evidence for the NO-FIX mechanism (probe
`.scratch/probe-native26.cjs`, run under `~/workspace/local/node-26/bin/node`,
v26.13.1 — the behaviour the shim would have to reproduce):

```
client.state.effectiveLocalWindowSize = 2097152
client.state.remoteWindowSize = 65535
client.socket instanceof net.Socket = true
client.socket.remoteAddress = ::1
client.alpnProtocol = h2c | client.encrypted = false
serverStream === clientStream? false
server stream.session.state.effectiveLocalWindowSize = 1048576
server stream.session.state.remoteWindowSize = 2097152
```

Server and client streams are distinct objects per side natively (the
shim shares one object — v24 probe: `serverStream === clientStream: true`),
sessions carry live window sizes from real SETTINGS exchange, and every
session has a real socket with ALPN. None of that exists in the virtual
loop, and no pure-JS shim change can conjure it.

## Baseline corrections

1. **`test-http2-util-update-options-buffer.js` is a host-version artifact,
   not a shim gap (1 test).** The test asserts the Node 26 internal options
   buffer layout (`IDX_OPTIONS_CONNECTION_WINDOW_SIZE = 13`,
   `IDX_OPTIONS_FLAGS = 14`, `lib/internal/http2/util.js:234-235`). Under
   the harness it reads the **host** Node v24.22.1 internals
   (`require('internal/http2/util')` / `internalBinding('http2')` are not
   redirected by `parity/preload.mjs` for target `http2`). Probe
   (`.scratch/probe-internal.cjs`, `--expose-internals`):
   harness/host v24.22.1 — `updateOptionsBuffer` source has
   `connectionWindowSize: false`, `optionsBuffer length: 14`,
   `buf[13] = 1` (the FLAGS word) after update; native v26.13.1 —
   `connectionWindowSize: true`, `length: 15`, `buf[13] = 13`,
   `buf[14] = 8193`. The staged failure `8191 !== 13` is the v24 FLAGS word
   (bits 0–12 set) sitting at the slot the 26 test expects the window size
   in. No shim change can flip this while the harness runs on host v24 —
   the test reads host internals directly. It becomes measurable only if the
   harness runs on a Node 26 host (or the preload redirects
   `internal/http2/util` to a 26-layout shim — a harness decision, not an
   http2-shim lane). Count it as a baseline correction, not a gap the http2
   lanes own.
2. **`test-http2-async-local-storage.js` is not a V4b re-regression.** The
   v24 test passed; the Node 26 test is a rewrite adding the trailers
   scenario, which exposes the H2-26-WR write-routing bug. The no-trailers
   half still passes under the shim (probe-proven).
3. **Scope gap (not counted anywhere): 18 diagnostics-channel http2 tests
   exist in Node 26 (`test-diagnostics-channel-http2-*.js` in
   `node-26-src/test/parallel/`) and were never run by the baseline — the
   runner's prefix is `test-http2-`, and no module target covers
   `diagnostics-channel`. They are outside the 289-file denominator and
   outside this triage's 201. A follow-up baseline needs a target (or prefix)
   for them.

## New-in-26 vs pre-existing split

- **Pre-existing (192):** all 190 v24 gaps (still gap, 190/190) + the 2
  lost passes above. Of these, lane flips claimed: 2 (WR:
  `async-local-storage`, `write-callbacks`); validation residue: 3
  (`altsvc`, `origin`, `origin-set-max-size.mjs`); host artifact: 1
  (`util-update-options-buffer`); NO-FIX: 186.
- **New in 26 (9 gaps of 12 new files):**
  - Lane flips claimed: 2 (`compat-get-headers` → C1,
    `connection-window-size-option` → W1).
  - NO-FIX (7): `bidirectional-write-deadlock` (A — flow-control deadlock
    needs real window accounting), `file-reset-pending-write` (F/G —
    RST + real socket), `removed-stream-headers-outlive-session` (A —
    stream headers must outlive session teardown, needs real session
    lifecycle), `reset-buffered-read` (B — RST_STREAM buffered reads,
    needs real RST state), `reset-pending-write` (A — RST while a write is
    pending), `session-cleanup-on-nghttp2-goaway-after-peer-goaway` (F/G —
    GOAWAY exchange over a real connection),
    `stream-backpressure-unread-peer` (A — unread-peer backpressure needs
    real flow control).
  - The other 3 new files pass outright (not gaps):
    `max-session-memory-stalled-data`, `respond-with-file-cancelled-crash`,
    `session-destroy-stream-handler`.

## Ceiling

- **Counted lane flips: 4** → **92/289** (88 + 4), all probable, none
  certain — each lane re-verifies its candidates isolated 2× and banks only
  what passes.
- **Validation residue (3):** flips TBD after implementation; not counted.
- **NO-FIX: 193. Host artifact: 1.** The v24 verdict's attribution holds
  for them: no real HTTP/2 framing, HPACK, TLS/ALPN, flow control,
  multiplexing, sockets, or nghttp2 state in a browser.

## Method trap (recorded so the next worker does not repeat it)

Probes run from outside `parity/node-test/parallel/` load **native**
http2: `parity/preload.mjs` (`polyfillPath`, header line 9) redirects
`require('http2')` only for importers under `parity/node-test/parallel/`.
Three early probes (`.scratch/probe-als.cjs`, `probe-als2.cjs`,
`probe-als4.cjs`) "passed" against native Node and proved nothing about the
shim; the real mechanism was only established once the instrumented test
was run from inside `parallel/` (`.scratch/zz-als-probe.js` staged as
`test-zz-als-probe.js`). Any future http2 probe that needs the shim must
live under `parity/node-test/parallel/` (staged, then removed by restore)
or it is testing native Node.

## Appendix — full test lists per family

Counts sum: 78 + 61 + 24 + 17 + 5 + 2 + 3 + 3 + 8 = 201. Lists are taken
from `.scratch/rerun.jsonl` (isolated re-run, first-failure signatures) and
`.scratch/families.txt`.

### A. Awaited callback never fires (78)

`async-local-storage`, `bidirectional-write-deadlock` (new),
`cancel-while-client-reading`, `client-port-80`,
`client-priority-before-connect`, `client-set-priority`,
`close-while-writing`, `compat-aborted`, `compat-errors`,
`compat-serverrequest-end`, `compat-serverrequest-settimeout`,
`compat-serverrequest-trailers`, `compat-serverresponse-close`,
`compat-serverresponse-headers-after-destroy`,
`compat-serverresponse-settimeout`,
`compat-write-early-hints-invalid-argument-value`,
`compat-write-early-hints`, `connect-method-extended-cant-turn-off`,
`connect-method-extended`, `destroy-after-write`, `dont-lose-data`,
`error-order`, `exceeds-server-trailer-size`, `forget-closed-streams`,
`goaway-delayed-request`, `goaway-opaquedata`, `head-request`,
`info-headers-errors`, `malformed-altsvc`, `many-writes-and-destroy`,
`max-session-memory-stalled-headers`, `max-settings`,
`misbehaving-multiplex`, `multistream-destroy-on-read-tls`,
`no-more-streams`, `options-max-reserved-streams`, `pack-end-stream-flag`,
`ping-settings-heapdump`, `ping-unsolicited-ack`, `priority-cycle-`,
`priority-event`, `propagate-session-destroy-code`,
`removed-stream-headers-outlive-session` (new), `reset-pending-write` (new),
`respond-file-304`, `respond-file-404`, `respond-file-compat`,
`respond-file-error-dir`, `respond-file-fd-invalid`, `respond-file-fd-range`,
`respond-file-fd`, `respond-file-push`, `respond-file-range`, `respond-file`,
`respond-nghttperrors`, `respond-no-data`, `respond-with-fd-errors`,
`respond-with-file-connection-abort`, `rst-stream-reentrancy`,
`sent-headers`, `server-close-callback`, `server-close-idle-connection`,
`server-errors`, `server-http1-client`, `server-rst-stream`,
`server-sessionerror`, `server-set-header`, `server-shutdown-redundant`,
`server-timeout`, `session-gc-while-write-scheduled`, `session-unref`,
`status-code`, `stream-backpressure-unread-peer` (new),
`stream-destroy-event-order`, `stream-removelisteners-after-close`,
`timeouts`, `too-large-headers`, `too-many-streams`.

### B. Assertion diffs (61)

`buffersize`, `client-data-end`, `client-http1-server`,
`client-onconnect-errors`, `client-promisify-connect-error`,
`client-proxy-over-http2`, `client-unescaped-path`,
`compat-expect-continue-check`, `compat-expect-continue`,
`compat-expect-handling`, `compat-get-headers` (new),
`compat-method-connect`, `compat-serverrequest`,
`compat-serverresponse-destroy`, `compat-serverresponse-finished`,
`compat-serverresponse-flushheaders`, `compat-serverresponse-headers`,
`compat-serverresponse-write`, `compat-serverresponse-writehead-array`,
`compat-serverresponse`, `compat-short-stream-client-server`,
`compat-socket`, `compat-write-head-destroyed`, `compat-write-information`,
`connect-method`, `connection-window-size-option` (new), `cookies`,
`create-client-session`, `empty-frame-without-eof`, `endafterheaders`,
`graceful-close`, `info-headers`, `max-concurrent-streams`,
`max-invalid-frames`, `multiheaders`,
`options-max-headers-block-length`, `options-max-headers-exceeds-nghttp2`,
`options-server-request`, `perf_hooks`, `ping`, `res-corked`,
`reset-buffered-read` (new), `response-splitting`,
`server-push-stream-errors`, `server-push-stream`, `server-rfc-9113-client`,
`server-rfc-9113-server`, `server-shutdown-before-respond`,
`server-startup`, `server-stream-session-destroy`, `session-stream-state`,
`short-stream-client-server`, `socket-proxy`, `stream-client`,
`too-many-headers`, `too-many-settings`, `unbound-socket-proxy`,
`util-headers-list`, `util-update-options-buffer`, `write-callbacks`,
`zero-length-header`.

### F/G. ECONNREFUSED / native-client rejection (24)

`allow-http1`, `alpn`, `autoselect-protocol`, `backpressure`,
`client-connection-tunnelling`, `connect-tls-with-delay`, `connect`,
`file-reset-pending-write` (new), `generic-streams-sendfile`,
`generic-streams`, `https-fallback-http-server-options`,
`invalid-last-stream-id`, `misbehaving-flow-control-paused`,
`misbehaving-flow-control`, `padding-aligned`,
`perform-server-handshake`, `premature-close`, `sensitive-headers`,
`server-unknown-protocol`, `session-cleanup-on-nghttp2-goaway-after-peer-goaway`
(new), `session-cleanup-on-nghttp2-goaway`, `settings-unsolicited-ack`,
`window-update-overflow`, `write-finishes-after-stream-destroy`.

### C. Read of undefined (17) / null (5); L. Set of undefined (2)

Undefined: `byteswritten-server`, `client-destroy`,
`client-jsstream-destroy`, `client-session-close-before-stream-close`,
`client-socket-destroy`, `compat-socket-destroy-delayed`,
`connect-options`, `createwritereq`, `ip-address-host`,
`res-writable-properties`, `server-push-stream-head`,
`server-socket-destroy`, `session-graceful-close`, `session-settings`,
`socket-proxy-handler-for-has`, `update-settings`, `write-empty-string`.
Null: `create-client-secure-session`, `https-fallback`,
`session-reuse-different-authority`, `socket-proxy-destroy`,
`trailers-after-session-close`.
Set-undefined: `compat-serverresponse-drain`, `compat-socket-set`.

### E. Missing expected exception (3)

`altsvc`, `origin`, `origin-set-max-size.mjs`.

### T. Timeout (3)

`respond-file-error-pipe-offset`, `respond-file-with-pipe`, `socket-close`.

### Q. Singles / unhandled rejections (8)

`allow-http1-upgrade-ws`, `capture-rejection`, `client-promisify-connect`,
`client-stream-destroy-before-connect`, `compat-serverresponse-end`,
`onping`, `respond-file-fd-leak`, `respond-file-filehandle`.
