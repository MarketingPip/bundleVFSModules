# NOTES-26-triage-http — Node 26 re-target triage (RE-DISPATCH)

- Worktree: `~/workspace/worktrees/node26-triage-http`, base `3c091022`
  (verified clean at start: `git log --oneline -1` + empty `git status --short`).
- Node 26 binary verified: `~/workspace/local/node-26/bin/node --version` = `v26.13.1`.
  Harness host node = `v24.22.1` (`/usr/bin/node`); Node 26 source pack
  `~/workspace/local/node-26-src/`; v24 source pack in goal `hidden_files/node-src/`.
- Gap list: `hidden_files/node26-triage/gaps-http.json` (parent-verified, not recomputed).
- Method: read every gap test in `node-26-src/test/parallel/`, the Node 26
  `lib/` source for the exercised API, and `src/http.js`; then isolated
  re-runs with the exact baseline invocation from
  `parity/drift/run-baseline.mjs` (`timeout 30 node --import <worktree>/parity/preload.mjs
  parity/node-test/parallel/<test>`, `PARITY_TARGET=http`), with the Node 26
  test tree staged exactly as `run-baseline.mjs` stages it, restored after
  (`git checkout -- parity/node-test` + deletion of staged-only files;
  verified `git status --porcelain -- parity/node-test` empty).
  Setup note: the worktree had no `node_modules`, so every harness run died
  `ERR_MODULE_NOT_FOUND` (`als-browser` from `src/async_hooks.js`) until a
  symlink to `~/workspace/bundleVFSModules/node_modules` was added
  (per `run-baseline.mjs` preflight); symlink removed after the runs.

## Counts

- Total non-pass: **32** = shim-gap **30** + fails-natively **1** + native-timeout **1**.
- Pre-existing vs new in 26 (vendored `parity/node-test/parallel/` presence):
  **16 vendored / 16 new**. Shim-gap split: **14 vendored / 16 new**.
- Non-gaps (excluded from the 30, listed for completeness):
  - `test-http-parser-lazy-loaded.js` — fails-natively (nativeExit -1).
    Isolated re-run: exit 134 (SIGABRT, C++ `node_http_parser.cc:695`
    `args[0]->IsInt32()` assertion; see NO-FIX).
  - `test-http-autoselectfamily.js` — native-timeout (nativeExit 124).
    Isolated re-run: exit 1, `listen EADDRINUSE :::17153` — the test binds
    the same port on `::1` that its IPv4 server holds on `127.0.0.1`
    (`test-http-autoselectfamily.js:109-112`); the shim's virtual registry
    keys ports without host. Not a shim gap per the oracle; no lane.

## Families (shim-gap 30)

### H1. New Node 26 exports — 4 tests (2 real work, 2 NO-FIX)

- `test-http-is-valid-header.js` (NEW, exit 1):
  `TypeError: isValidHeaderName is not a function`. The export diff
  (`parity/drift/node26-export-diff.md`) lists `isValidHeaderName`,
  `isValidHeaderValue` as ADDED in 26; `src/http.js` has only the throwing
  `validateHeaderName`/`validateHeaderValue` (`src/http.js:618,625`).
  The test requires the boolean validators to agree with the throwing ones
  for every input incl. non-strings. Pure-JS lane.
- `test-http-websocket-mask.js` (NEW, exit 1):
  `TypeError: websocketMask is not a function`. `websocketMask`/
  `websocketUnmask` ADDED in 26.12.0; no trace in `src/http.js`. The test
  is a pure RFC 6455 §5.3 reference check (sizes 0–80, 125–65537,
  1 MiB+3; every alignment; in-place; offset/length args). Pure-JS lane.
- `test-http-websocket-mask-fast.js` (NEW, exit 133) — NO-FIX, see below.
- `test-http-websocket-mask-immutable.js` (NEW, exit 9) — NO-FIX, see below.

### H2. Upgrade-with-body (Node 26.0.0 fix) — 5 tests, all NEW

- `test-http-upgrade-server-with-body.mjs`, `-with-body-error.mjs`,
  `-with-body-and-extras.mjs`, `-with-large-body.mjs` — all exit **124**
  (hang ≥30 s, empty stderr: the `upgrade`/`end` the test waits on never fires).
- `test-http-upgrade-server-with-large-body-unread.mjs` — exit 1, grounded:
  socket data was `'3\r\nbye\r\n0\r\n\r\nupgrade head\npost-upgrade message'`,
  expected `'upgrade head\npost-upgrade message'` — the shim leaked the
  chunked body framing (`3\r\nbye\r\n0\r\n\r\n`) into the upgrade stream
  instead of consuming the body first. Node 26 `lib/_http_server.js:1086`
  (`requestBodyCompleted`) / `:1171` (`UpgradeStream`) is the reference
  behaviour. Real shim work; the 4 hangs are the same area, mechanism
  unproven (lane must debug where each stalls).

### H3. Agent socket lifecycle — 5 tests

- `test-http-agent-highwatermark-reuse.js` (NEW, exit 1): `1048576 !== 10240`
  at `:51` — a pooled socket's `writableHighWaterMark` (1 MiB, request A)
  was not synced to request B's `highWaterMark` (10 KiB). Node issue
  nodejs/node#64680, cited in the test header. Pure-JS agent fix.
- `test-http-agent-keylog-existing-sockets.js` (NEW, exit 1): `0 !== 1` at
  `:62` — after `agent.on('keylog', …)`, each existing socket in
  `freeSockets`/`sockets` must have a `keylog` listener (count 1). The shim
  has zero `keylog` wiring (`grep -rn keylog src/` empty). Reference:
  Node 26 `lib/_http_agent.js:291` `maybeEnableKeylog` (walks both maps'
  buckets — the test's own comment names the `buckets-as-sockets`
  TypeError). Pure-JS agent fix; the listener itself never fires for plain
  http, the test only asserts `listenerCount`.
- `test-http-agent-reuse-drained-socket-only.js` (vendored, exit 1):
  `assert.notStrictEqual(sock.localPort, fstReqCliPort)` failed — request 2
  reused request 1's undrained socket (same localPort 50831). Full prior
  art: `NOTES-http-agent-reuse-drained-socket-only.md` (socket-at-assignment,
  GET+body, drained accounting). The drained-only veto exists in the shim
  (`src/http.js:11959`) but does not bite on this path — lane must debug why.
  Fails on the vendored file too, so the v24-sweep PASS
  (`http-sweep-2026-11-04.csv`) was a flake, not a 26 regression.
- `test-http-agent-domain-reused-gc.js` (vendored, exit 1) — NO-FIX, see below.
- `test-http-agent-free-socket-pending-read.js` (NEW, exit 1) — NO-FIX, see below.

### H4. Cross-process virtual-server reachability — HELD (lane 11), 4 tests

Do NOT re-open as a fix lane. All four spawn a real child process (real
Node, no `--import` preload) that must reach the parent's virtual-only
server — the exact lane-11 hold (NOTES-http-transfer-encoding.md:124
already holds `pipeline-flood` in this class).

- `test-http-chunk-problem.js` (vendored, exit 1): child `http.get` →
  `AggregateError [ECONNREFUSED] ::1:41012 / 127.0.0.1:41012`
  (real `node:_http_client` in the stack).
- `test-http-pipeline-flood.js` (vendored, exit 1): spawned child
  `net.connect` → `ECONNREFUSED ::1:6141` (real `node:net` in the stack).
- `test-http-server-stale-close.js` (vendored, exit 1): forked child
  `http.request` → `connect ECONNREFUSED 127.0.0.1:24227`.
- `test-http-server-drop-connections-in-cluster.js` (vendored, exit 124):
  worker `http.get` → `ECONNREFUSED` from `src/net.js:307` (then hang).
  v24 sweep said PASS; isolated vendored re-run also times out (124), so
  the v24 PASS was a flake.

### H5. OutgoingMessage / response lifecycle — 3 tests

- `test-http-1.0.js` (vendored, exit 1): Node 26 test change (token-diff vs
  vendored): the 1.1 block now expects `res.write('ignored','invalid')` to
  throw `ERR_UNKNOWN_ENCODING` and the chunked body coalesced to a single
  `d\r\nHello, world!\r\n` chunk + `1\r\nX\r\n`. The shim emitted three
  chunks (`7 Hello, / 6 world! / 1 X`). Passes as the vendored file
  (isolated re-run exit 0), so this is new-in-26 behaviour, not a shim
  regression. Lane: chunk coalescing in `OutgoingMessage` writes.
- `test-http-outgoing-destroyed.js` (vendored, exit 1): Node 26 test change
  (token-diff): block 4 now does `res.write('x', cb)` after
  `res.destroy(err)` and requires `cb` to receive the destroy error.
  Observed: callback got `null`, expected `Error: Destroy test`.
  Passes as the vendored file (exit 0). Lane: destroyed-`OutgoingMessage`
  write-callback error.
- `test-http-response-socket-error.js` (NEW, exit 1): pipeline callback got
  `res.errored === null`, expected the `ECONNRESET` `aborted` error with
  `cause` chain (test `:33`). Lane: `IncomingMessage.errored`/`aborted`
  propagation on socket error (joint with https `response-tls-error`, H-D
  below counts the http half).

### H6. Server request handling — 4 tests

- `test-http-server-raw-header-lookup.js` (NEW, exit 1): test sends
  `Expect: 100-continue` and requires the reply to start
  `HTTP/1.1 100 Continue`. Observed: shim sent `200 OK` + body first and
  the `100 Continue` AFTER the body. Lane: interim-response ordering
  (the test's premise — `optimizeEmptyRequests` lazy header lookup —
  is a second, unprobed concern for the lane).
- `test-http-server-response-standalone.js` (vendored, exit 1):
  `new ServerResponse({method, httpVersionMajor: 1, httpVersionMinor: 1})`
  + `assignSocket(ws)` + `res.end('hello world')` — the Writable's single
  expected chunk did not end with `'hello world'`
  (`assert(chunk.toString().endsWith('hello world'))`, `:20`). Lane:
  standalone `ServerResponse` serialization over an assigned socket.
- `test-http-server-multiple-client-error.js` (vendored, exit 1):
  unhandled `Error: read ECONNRESET` from `src/net.js`. The test hand-feeds
  a raw socket (`socket.read(1)` + `unshift` + manual
  `httpServer.emit('connection', socket)`) and requires two `clientError`
  emissions (`HPE_INVALID_METHOD`, `rawPacket` `'1'` then
  `'23 http://example.com HTTP/1.1\r\n\r\n'`). The shim never emits
  `clientError` on this path. Fails on the vendored file too (v24 PASS was
  a flake). Lane: manual-connection handoff + `clientError` emission.
- `test-http-request-method-delete-payload.js` (vendored, exit 1):
  client writes `'PUT / HTTP/1.1\r\n\r\n'` as a DELETE body; server-side
  `req.on('data', mustNotCall)` fired with that buffer. Lane: parser must
  not deliver body bytes for a method with no body framing (or treat the
  trailing bytes as a pipelined request, per Node).
- `test-http-no-read-no-dump.js` (vendored, exit 124): hang ≥30 s, empty
  stderr — pause/backpressure path (`req.connection.on('pause')` /
  64 KiB post). Mechanism unproven; lane H-E upside only (diagnose first).

### H7. CONNECT method — 2 tests, both hang (124), mechanism TBD

- `test-http-connect-default-host-header.js` (NEW): `CONNECT target:443`
  must carry a default `Host: target.example.com:443` header; the shim
  never emits `connect` (or never reaches the raw `net` server).
- `test-http-request-connect-path.js` (NEW): `CONNECT` via `new URL(...)`
  vs `path: '/example.com'` — `req.url` must be `'example.com'` /
  `'/example.com'` respectively on the server `connect` handler.
- Both hang with empty stderr at 30 s. One lane (CONNECT dispatch), but
  the lane must first run a debug pass to find where each stalls.

### H8. Umbrella test — 1 test

- `test-http.js` (vendored, exit 1): `test-http.js:76`
  `req._header.match(/^Cookie: .+$/img)` — `req._header` is `null` at
  response time. Lane: `ClientRequest._header` materialization (client
  header assembly). Note: `test-http.js` has no row in
  `http-sweep-2026-11-04.csv`, so there is no v24 baseline to compare —
  pre-existing vendored, unadjudicated in v24.

## Lane candidates (conservative flips)

| Lane | Tests | Est. flips |
|---|---|---|
| H-A New-26 exports (pure JS) | `test-http-is-valid-header.js`, `test-http-websocket-mask.js` | **2** |
| H-B Upgrade-with-body (26.0.0) | `test-http-upgrade-server-with-large-body-unread.mjs` (grounded); upside: the other 4 upgrade `.mjs` tests once the hang is found | **1** (upside 5) |
| H-C Agent socket lifecycle | `test-http-agent-highwatermark-reuse.js`, `test-http-agent-keylog-existing-sockets.js`, `test-http-agent-reuse-drained-socket-only.js` | **3** |
| H-D Outgoing/response lifecycle | `test-http-1.0.js`, `test-http-outgoing-destroyed.js`, `test-http-response-socket-error.js` (+ https `test-https-response-tls-error.js` as upside, same error-propagation area) | **3** (upside 4) |
| H-E Server interim + standalone | `test-http-server-raw-header-lookup.js`, `test-http-server-response-standalone.js` (+ `test-http-no-read-no-dump.js` upside, diagnose first) | **2** (upside 3) |
| H-F Parser + clientError | `test-http-server-multiple-client-error.js`, `test-http-request-method-delete-payload.js` | **2** |
| H-G CONNECT dispatch | `test-http-connect-default-host-header.js`, `test-http-request-connect-path.js` (both hang; debug first) | **1** (upside 2) |
| H-H Client `_header` | `test-http.js` | **1** |
| **Total conservative** | | **15** (+6 upside, +5 NO-FIX, +4 HELD = 30) |

## NO-FIX (probe evidence only) — 5 tests

1. `test-http-agent-domain-reused-gc.js` — needs `internal/js_stream_socket`,
   the `domain` module, `ReusedHandle` and async_hooks GC hooks. Already
   adjudicated v24: `NOTES-http-fast-failures.md:194` ("Cannot be emulated
   in browser"). Isolated re-run: `mustCall` mismatches (`noop`/`asyncReset`,
   expected ≥1, actual 0) — the GC/async_hooks hooks never fire. No browser
   equivalent exists for C++ stream handles + GC-driven reuse.
2. `test-http-agent-free-socket-pending-read.js` — the test's own gate is
   `socket._handle.hasPendingRead()` (`:24`); under the shim
   `socket._handle` is `null` → `TypeError: Cannot read properties of null
   (reading 'hasPendingRead')`. The pending-read guard it exercises lives
   in libuv's TCP handle; there is no handle in the browser.
3. `test-http-parser-timeout-reset.js` — `require('internal/test/binding')`
   + `internalBinding('http_parser')` (`HTTPParser`, `kOnTimeout`).
   Isolated re-run (with and without `--expose-internals`, identical):
   exit 139 (SIGSEGV) in the host Node's C++ parser binding. Node internal
   C++ binding; no browser equivalent. (Baseline recorded 129 — see
   Baseline corrections.)
4. `test-http-websocket-mask-fast.js` — needs `--allow-natives-syntax`
   (`%PrepareFunctionForOptimization` / `%OptimizeFunctionOnNextCall`) and,
   on debug builds, `getV8FastApiCallCount('buffer.mask')` from
   `internal/test/binding`. Isolated re-run: V8 fatal
   `Check failed: v8_flags.fuzzing` (trace/breakpoint trap, exit 133),
   identical with flags. V8 natives syntax + fast-API call counting cannot
   exist in a browser. The underlying `websocketMask` function itself is
   lane H-A; only this *test* is NO-FIX.
5. `test-http-websocket-mask-immutable.js` — needs
   `--js-immutable-arraybuffer` + `ArrayBuffer.prototype.transferToImmutable`.
   Probe on real Node 26.13.1: `typeof ArrayBuffer.prototype.transferToImmutable`
   is `undefined` without the flag, and the harness host (`/usr/bin/node`
   v24.22.1) rejects the flag outright: `node: bad option:
   --js-immutable-arraybuffer` (exit 9, identical with flags). Immutable
   ArrayBuffers do not exist in browsers. Only this *test* is NO-FIX;
   `websocketMask` itself is lane H-A.

## HELD — lane 11 (design decision, not a fix lane) — 4 tests

`test-http-chunk-problem.js`, `test-http-pipeline-flood.js`,
`test-http-server-stale-close.js`,
`test-http-server-drop-connections-in-cluster.js` (H4 above). All need a
real child/worker process to reach the virtual server registry.

## Latent drift (no gap test, flag for coordinator — no lane)

- `writeHeader()` was REMOVED in Node 26.0.0 (changelog) — the Node 26 lib
  has zero `writeHeader` references, but the shim still defines it
  (`src/http.js:3081`). No gap test references `writeHeader` (grep over the
  32 gap tests: no hits), so nothing flips; removal is a drift-cleanup
  decision, not triage work.
- Already present, no action: `IncomingMessage.signal` (`src/http.js:2076`,
  26.1.0 `req.signal`) and `ServerResponse.writeInformation`
  (`src/http.js:3167`, 26.2.0) — no gap test exercises either.

## Baseline corrections

1. **Zero flips on isolated re-run.** All 44 gap-test outcomes (32 http +
   12 https) reproduce exactly at 30 s with the baseline invocation
   (modulo the signal-code note below). In particular the nine http
   baseline `124`s all hang again in isolation — they are real shim hangs,
   not sweep-load flakes. (An early read of empty logs looked like passes;
   the exit codes prove otherwise: empty log + exit 124 = hang, not pass.)
2. **Exit-code precision: baseline `129` is lossy.** `run-baseline.mjs`
   `runOne` maps *any* signal death to `128 + 1` (`res(signal ? 128 + 1
   : -1)`). True signals from isolated runs: `test-http-parser-lazy-loaded.js`
   134 (SIGABRT), `test-http-parser-timeout-reset.js` 139 (SIGSEGV),
   `test-http-websocket-mask-fast.js` 133 (SIGTRAP). Cosmetic only.
3. **Flags not passed by the baseline.** `run-baseline.mjs` never passes a
   test's `Flags:` header. Flagged re-runs of the 5 flag-bearing tests
   (`--expose-gc --expose-internals`, `--expose-internals`,
   `--expose-internals --no-warnings --allow-natives-syntax`,
   `--js-immutable-arraybuffer --allow-natives-syntax`) give identical
   outcomes — no hidden flips. (Caveat: the self-spawning tests re-exec
   via `process.execPath` = host `/usr/bin/node` v24.22.1, which is also
   why `websocket-mask-immutable` fails with `bad option`.)
4. **Vendored-vs-26 adjudication** (token-diff after quote/whitespace
   normalization + isolated vendored re-runs at 30 s):
   - Pass vendored, fail as Node 26 files (real test changes, new-in-26):
     `test-http-1.0.js` (exit 0 vendored), `test-http-outgoing-destroyed.js`
     (exit 0 vendored), `test-https-agent-getname.js` (exit 0 vendored;
     see https doc).
   - Fail on vendored files too (v24-sweep PASS was flake/stale, not a 26
     regression): `test-http-agent-reuse-drained-socket-only.js` (exit 1),
     `test-http-server-multiple-client-error.js` (exit 1),
     `test-http-server-drop-connections-in-cluster.js` (exit 124),
     `test-https-agent-unref-socket.js` (exit 1; see https doc).
5. `test-http.js` has no v24 sweep row (absent from
   `http-sweep-2026-11-04.csv`, 396 rows) — no v24 baseline to compare.
