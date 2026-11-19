# Node 26 re-target triage — module `stream`

- Base SHA: `3c091022` (worktree `~/workspace/worktrees/node26-triage-stream`, detached HEAD).
- Node 26 binary verified: `~/workspace/local/node-26/bin/node --version` = `v26.13.1`.
- Harness host node: `v24.22.1` (`node --version` on PATH — this matters, see § Baseline corrections).
- Banked numbers (parent-verified, not recomputed): stream total non-pass **52**, shim-gap **52**,
  fails-natively 0, native-timeout 0. Baseline file: `parity/drift/node26-baseline.jsonc`
  stream = 232 total / 180 pass / 52 fail / 0 timeout.
- Export diff (`parity/drift/node26-export-diff.md`): `stream` row is all zeros — **no
  export-surface change** for `stream` itself. All 52 gaps are behaviour / test changes.
- Shim: `src/stream.js` (198 lines) + `src/stream/*` — a full Node v24.20.0 `lib/stream.js`
  port. v24 context: stream closed **237/237** on v24.20.0 (commit `8d22f4cb`).

## Method

1. Read `gaps-stream.json` (52 tests, all `harnessExit: 1`, `nativeExit: 0`).
2. Read `parity/drift/run-baseline.mjs` (exact invocation: `timeout N node --import
   <abs preload> parity/node-test/parallel/<test>`, `PARITY_TARGET=stream`, cwd = worktree;
   phase 1 short timeout, phase 2 full timeout only for 124s).
3. Isolated re-runs, take 2 (take 1 died in a VM restart that wiped `/tmp`; uptime was 1 min
   when noticed — see § Baseline corrections): staged the Node 26 test tree
   (`test/parallel` + `test/common` + `test/fixtures`) into the worktree, ran all 52 plain
   (baseline replication) + the 3 `finished` tests with `--expose-internals` + 3 native
   spot checks with the Node 26 binary, then restored `parity/node-test/` via
   `git checkout --` + deletion of staged-only files (7,560 removed; tree verified clean).
   - Script: `~/workspace/tmp-stream-triage/run2.sh`, log: `~/workspace/tmp-stream-triage/run2.log`
   - Per-test logs: `~/workspace/tmp-stream-triage/logs/<test>.plain.log` (52),
     `<test>.flagged.log` (3 finished), `<test>.native.log` (3 spot checks).
   - **Result: all 52 plain re-runs reproduce exit 1; flagged finished ×3 also exit 1
     (identical failure mode); native spot checks (iter-namespace, finished, compose)
     exit 0.** No sweep flakes found; no baseline exit code was wrong.
4. Static grounding per test: token-normalised diff of vendored v24 test file
   (`git show HEAD:parity/node-test/parallel/<test>`) vs Node 26 test file; per-file
   `diff` of Node v24.20.0 `lib/` (node-src pack, lib-only) vs Node 26.13.1 `lib/`;
   probes of host Node v24.22.1 vs Node 26.13.1 `stream/iter` exports.

## Gap total: 52

| Family | Tests | Classification |
|---|---|---|
| A. `stream/iter` pure-native drift (no `require('stream')`) | 28 | Host-drift artifact as measured; real shim work underneath (unimplemented surface) — see L6 |
| B. `stream/iter` interop, mixed shim `stream` + native iter | 7 | 1 proven shim-side (readable-interop); 6 host-drift on first evidence, re-measure on Node 26 host — see L6 |
| C. `finished()` / end-of-stream ALS | 3 | Real shim work |
| D. `Readable.read()` one-buffer + readable flow rework | 11 | Real shim work |
| E. `toWeb` cancel race (#54205) | 1 | Real shim work |
| F. `Duplex.toWeb` `options.type` DEP0201 | 1 | Real shim work |
| G. `Duplex.from` unconsumed async fn (#55077) | 1 | Real shim work |
| **Total** | **52** | |

No family is a fixture-only gap except the `finished.js:109` symbol-identity point inside
family C (harness-adapter lane L2b). No family is a validation gap in the
`common`-helper sense: `test/common` helpers used by these tests
(`getArrayBufferViews`, `getBufferSources`) already exist in the vendored common.

## Family A — `stream/iter`, pure native-iter drift (28)

Tests (all `// Flags: --experimental-stream-iter`, none `require('stream')`):

- `test-stream-iter-broadcast-backpressure.js`, `test-stream-iter-broadcast-basic.js`,
  `test-stream-iter-broadcast-from.js`, `test-stream-iter-broadcast-waiter-cleanup.js`
- `test-stream-iter-consumers-bytes.js`, `test-stream-iter-consumers-dump.mjs`,
  `test-stream-iter-consumers-merge.js`, `test-stream-iter-consumers-tap.js`,
  `test-stream-iter-consumers-text.js`
- `test-stream-iter-duplex.js`, `test-stream-iter-factory-signal.js`,
  `test-stream-iter-from-async.js`, `test-stream-iter-from-sync.js`,
  `test-stream-iter-namespace.js`, `test-stream-iter-pipeto-edge.js`,
  `test-stream-iter-pull-async.js`, `test-stream-iter-push-backpressure.js`,
  `test-stream-iter-push-writer.js`, `test-stream-iter-reason-propagation.js`,
  `test-stream-iter-resizable-buffers.js`
- `test-stream-iter-share-async.js`, `test-stream-iter-share-coverage.js`,
  `test-stream-iter-share-sync.js`
- `test-stream-iter-transform-buffering.js`, `test-stream-iter-transform-coverage.js`,
  `test-stream-iter-transform-output.js`
- `test-stream-iter-writable-from.js`, `test-stream-iter-writer-reentrancy.js`
(`test-stream-iter-validation.js` requires `stream`, so it is in family B, not here;
list verified against `gaps-stream.json`.)

Mechanism (proven, not asserted):

- `parity/preload.mjs:210` (`polyfillPath`) redirects **only exact** `name === "stream"`;
  `stream/iter` is never redirected, so it loads the **host's native** implementation.
  `parity/hooks.mjs:92` is the same exact-match rule for ESM.
- Node's `test/common` self-respawns any `// Flags:` test as a child with those flags
  (log line: `NOTE: The test started as a child_process using these flags:
  [ '--experimental-stream-iter' ]`), inheriting `--import preload` + `PARITY_TARGET`
  via `execArgv`/env. So the test body runs with native `stream/iter` available —
  the **host v24.22.1** one, not the shim and not Node 26.
- The host's native iter differs from Node 26's: probe —
  host v24.22.1 `require('stream/iter')` keys lack `dump`/`dumpSync`;
  Node 26.13.1 has them (top-level and on `Stream`).
  `lib/stream/iter.js` v24→26 diff is exactly `dump` + `dumpSync` at the entry point,
  but every `lib/internal/streams/iter/*.js` file changed heavily
  (broadcast 457, classic 853, consumers 285, duplex 132, from 375, pull 591,
  push 321, share 401, transform 107, utils 264 diff-lines; only `ringbuffer.js`
  and `types.js` identical; `webidl.js` is new in 26).
- Failure evidence (isolated re-run logs, `~/workspace/tmp-stream-triage/logs/`):
  - namespace:46 — `Stream.dump` is `undefined`, expected `function`
    (`actual: 'undefined'`).
  - broadcast-basic:322 — `dump is not a function` where the test expects rejection
    with message `'fail!'`.
  - share-async:330 — same `dump is not a function` vs expected `'share source boom'`.
  - push-writer:287 — `TypeError: dump is not a function`.
  - broadcast-from:188 — protocol object is reference-unequal (`BroadcastImpl`
    with different symbols).
  - broadcast-backpressure:62 — drop-policy capacity `true !== false`.
  - push-backpressure:155 — `options.budget` must be `>= 16384` on host v24;
    Node 26 test passes budget `4` (minimum relaxed in 26).
  - pipeto-edge:20 — `Missing expected exception` (`ERR_INVALID_STATE` for
    `endSync() === -1` with `preventFail` is new in 26).
  - share-sync:143 — `Missing expected exception` (unbounded `shareSync` rejection
    is new in 26).
  - transform-output:238 — invalid transform return type
    yields a bare `Comparison {}` on host v24 vs `ERR_INVALID_ARG_TYPE` in 26.
  - webidl:24 — `push()` with `null` transform throws `ERR_INVALID_ARG_TYPE` on
    host v24 (`node:internal/streams/iter/utils:356`); 26 WebIDL conversion accepts it.
  - writable-from:698 — `writableHighWaterMark < Number.MAX_SAFE_INTEGER` fails:
    26 `toWritable()` bounds the HWM, host v24 does not.
  - waiter-cleanup:28 — `Detached Broadcast waiters retained 16023832 bytes`
    (GC-retention assertion on native broadcast internals).
  - consumers-dump.mjs — ESM link-time failure before any test code runs:
    `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:stream/iter`
    (host v24, no flag at link time; `test/common` respawn cannot help an ESM
    static import). This is the one test whose baseline failure mode is a
    harness/flag artifact rather than host drift; underneath it also needs `dump`.
  - consumers-bytes:124 — protocol precedence `'iterator'` vs `'protocol'`
    (26 prefers `toAsyncStreamable` over `asyncIterator`).
  - reason-propagation:250, share-coverage:110, transform-coverage:60,
    transform-buffering:26, resizable-buffers:59, factory-signal:50,
    from-async:145, from-sync:186, consumers-merge:102, consumers-tap:88,
    consumers-text:154, duplex:207, pull-async:77 — all fail inside
    `node:internal/streams/iter/*` frames (native host code), never in `src/`.
- Classification: **as measured, host-drift artifact** (the tests never execute shim
  code); **underneath, real unimplemented surface** — the shim has no `stream/iter`
  at all (no `src/stream/iter.js`; `src/fs.js:467` only notes iter batch helpers for
  `FileHandle`). The v24 237/237 included 40 vendored iter tests that passed the
  same vacuous way (native host v24 iter, via `run.mjs` flag passing). Lane L6.

## Family B — `stream/iter` interop, mixed (7)

Tests: `test-stream-iter-from-writable-lifecycle.js`,
`test-stream-iter-property-access.js`, `test-stream-iter-readable-interop.js`,
`test-stream-iter-to-readable.js`, `test-stream-iter-validation.js`,
`test-stream-iter-webidl.js`, `test-stream-iter-writable-interop.js`.
Each requires both `stream` (→ shim) and `stream/iter` (→ native host v24).

- `readable-interop:124` — **proven shim-side.** The shim's own code throws:
  `ERR_STREAM_ITER_MISSING_FLAG` at `src/stream/readable.js:1867`, inside
  `Readable.prototype[SymbolFor("Stream.toAsyncStreamable")]`
  (`src/stream/readable.js:1859-1876`). The method is a deliberate stub: it checks
  `getOptionValue("--experimental-stream-iter")` and then throws unconditionally
  in both branches (`:1867` and `:1872`, comment: "The experimental stream/iter
  helpers are not ported and the flag is never set here"). The protocol symbol
  itself is shared correctly via `SymbolFor` (Node 26 uses the same global key,
  `lib/internal/streams/readable.js:2226`), so presence checks pass — only the
  call throws. Flips only with lane L6.
- The other six fail inside native host iter frames, on first evidence host drift:
  - from-writable-lifecycle:85 — sync write error escapes from
    `node:internal/streams/iter/classic:605` (26 delivers it async).
  - property-access:40 — `Error: protocol method read twice`, thrown from
    `node:internal/streams/iter/from:604` (26 snapshots protocol methods; v24 re-reads).
  - to-readable:178 — `TypeError: Method Promise.prototype.then called on
    incompatible receiver` at `node:internal/streams/iter/classic:303`
    (`Readable.destroy [as _destroy]`).
  - validation:25 — error-code change: host gives `ERR_INVALID_ARG_TYPE`,
    26 expects `ERR_OUT_OF_RANGE`.
  - webidl — see family A entry (same `utils:356` frame class; this file also
    requires `stream`).
  - writable-interop:854 — `testWritevInvalidChunkUncorks`, `1 !== 0`. The only
    mixed failure whose frames are test-side + shim `Writable` (writev/cork
    accounting) rather than native iter internals — **shim-suspect, not proven**.
    L6 must re-measure it first on a Node 26 host before assuming native drift.
- Classification: real shim work for readable-interop (inside L6); the other six
  are host-drift on current evidence with one shim-suspect (writable-interop).

## Family C — `finished()` / end-of-stream ALS (3)

Tests: `test-stream-finished.js`, `test-stream-finished-async-local-storage.js`,
`test-stream-finished-bindAsyncResource-path.js` (all `// Flags: --expose-internals`,
all NEW-IN-26 — not in the vendored v24 set).

- finished-async-local-storage:19 — `als.getStore()` is `undefined`, expected
  `'test-context-1'`: the `finished()` callback does not run in the ALS context.
- finished-bindAsyncResource-path:31 — `contextMap.get(executionAsyncId())` is
  `undefined`, expected `'abc-123'`: same context-loss, via an enabled async hook
  tracking `STREAM_END_OF_STREAM` resources.
- Root cause (file-grounded): Node 26 `lib/internal/streams/end-of-stream.js`
  binds the callback only when needed —
  `if (AsyncContextFrame.current() || enabledHooksExist()) { callback =
  bindAsyncResource(...) }` (added imports at `:49-51`, guard at `:205-209` and
  `:341-347`; changelog row: "stream now preserves AsyncLocalStorage on
  'finished' only when needed"). The shim binds **unconditionally** at
  `src/stream/end-of-stream.js:208` and `:356`, and its `bindAsyncResource`
  (`:49`) does not propagate the `als-browser` ALS frame — hence context loss.
- finished.js:109 — `Mismatched ... Expected exactly 1, actual 0`: with a
  pre-aborted signal and `[kEosNodeSynchronousCallback]: true`, the callback must
  fire **synchronously inside `finished()`** (before `cleanup2` is assigned;
  the test then calls `cleanup2()` immediately). The shim has the sync path
  (`src/stream/end-of-stream.js:197`, mirroring Node 26 `:200`) but keys it on
  **its own** `Symbol("kEosNodeSynchronousCallback")` (`:104`), while the test
  imports the symbol from Node's native `internal/streams/end-of-stream`
  (`test-stream-finished.js:19`) — different symbol identities, so the shim
  never sees the option, defers to `nextTick`, and the test's immediate
  `cleanup2()` cancels it (`callback = nop`). This sub-gap needs a harness
  adapter (preload redirect of `internal/streams/end-of-stream` to the shim's
  symbol) or an equivalent — lane L2b, not a shim-code change alone.
- Re-run note: flagged re-runs (`--expose-internals`) give byte-identical failure
  modes — no baseline flag artifact here; `test/common` already respawns with flags.
- Classification: real shim work (L2 + L2b).

## Family D — `Readable.read()` one-buffer + readable flow rework (11)

Tests: `test-stream-compose.js`, `test-stream-destroy.js`,
`test-stream-duplex-from.js`, `test-stream-pipeline.js`,
`test-stream-push-strings.js`, `test-stream-readable-emittedReadable.js`,
`test-stream-readable-infinite-read.js`, `test-stream-readable-readable-one.js`,
`test-stream-typedarray.js`, `test-stream-uint8array.js`,
`test-stream-readable-unobserved-eof-readable.js`.
(All except `readable-one`, `unobserved-eof`, `typedarray`, `uint8array` are
changed-vs-vendored; those four are NEW-IN-26.)

### D1. One-buffer `read()` (6 tests)

Node 26 behaviour (changelog: "`Readable.read()` now returns ONE buffer at a
time"): `lib/internal/streams/readable.js` `howMuchToRead` gained the fast path —
"Fast path for buffers. `if ((state[kState] & kDecoder) === 0 && state.length)
return state.buffer[state.bufferIndex].length;`" (previously a no-arg `read()`
returned `state.length`, i.e. all buffered bytes, and `fromList` concatenated
them). The shim is the v24 code: `src/stream/readable.js:669` `read()` +
`:775` `fromList` merge.

- readable-one (NEW; the direct test of the change, comment: "Read one buffer
  at a time and don't waste cycles allocating and copying into a new larger
  buffer"): `read()` returns merged `Buffer(15)` vs expected `Buffer(5)`
  (`assert.strictEqual(r.read(), buf)` — identity, not just bytes).
- uint8array:87 — Readable block: `push(DEF); unshift(ABC); read()` returns
  `ABCDEF` (6 bytes) vs expected `ABC` (3).
- typedarray:90 — Readable block: `push(views[1]); push(views[2]);
  unshift(views[0])`; first `read()` returns the merged views instead of
  `views[0]` alone (`[...buf]` deep-equal fails with duplicated bytes).
- push-strings — expected `['first chunk', 'second to last chunk', 'last chunk']`,
  actual `['first chunksecond to last chunk', 'last chunk']` (merged).
  (Token diff vs vendored confirms the expectation itself changed: v24 expected
  the merged `'firstchunksecondtolastchunk'`.)
- emittedReadable:17 — expected sequence `[Buffer('foo'), Buffer('bar'),
  Buffer('quo'), null]` via successive `read()`s; shim returns merged `Buffer(6)`.
- compose:493 — `newStream.toArray()` returns `[Buffer(24)]` (`'Steve Rogers' +
  'On your left'` merged) vs expected `[Buffer(12), Buffer(12)]`.

### D2. Readable flow / pipe / drain rework (3 tests)

Node 26 `lib/internal/streams/readable.js` diff is 486 lines: `fastChunk` /
`flowSync()` fast path (`kFastPush`, `kEndScheduled`, `kEofReadablePending`),
`pipeOnData` single-destination fast path, plus `Writable.writeKnownBuffer`
(`lib/internal/streams/writable.js:589-625`) and a `clearBuffer` threshold tweak
(`i > 256 && i * 2 >= buffered.length`).

- pipe-multiple-destinations-error (NEW, regression test for
  nodejs/node#53185): `finished(healthy, mustSucceed)` at `:43` never fires —
  when one `pipe()` destination errors synchronously in `_write`, the errored
  destination stays in the source's `awaitDrainWriters` set, the source never
  resumes, and the healthy destination receives only the first chunk.
  (`lib/stream.js`, `pipeline.js`, `from.js`, `duplex.js`, `transform.js`,
  `compose.js` are all 0-diff v24→26, so the divergence is in readable/writable.)
- pipeline:1672-1673 (NEW block; `Array.from({ length: 100 })` occurs 0 times in
  the vendored file): `pipelinep(...streams())` and `pipelinep(streams())` with
  `[Readable.from(100 numbers), async function* passThrough]` never resolve
  (`mustCall` 0/1 twice). Same readable-flow area as pipe-multiple (pipeline.js
  itself is unchanged v24→26).
- readable-infinite-read:24 (changed: `_read` mustCall count 31 → 12):
  `readable.read().length` is `16384` vs expected `8192` — with one-buffer
  reads each `read()` returns exactly one 8192-byte push and `_read` runs 12
  times; the shim merges and re-reads.

### D3. Unobserved EOF + destroyed no-ops (2 tests, same file area)

- readable-unobserved-eof-readable (NEW): Node 26 gates `emitReadable` at EOF —
  "Nobody is observing the stream: do not schedule the 'readable' emission at
  all" with `kEofReadablePending` redeemed by a later listener
  (`readable.js:815+`). Shim lacks it: `:38` `readableEmitted` is `false` when
  `'end'` fires after a late `'readable'` listener (expected `true`).
- destroy:127 (changed): "resume() and pause() should be no-ops on destroyed
  streams" — shim `pause()` emits `'pause'` on a destroyed stream
  (`src/stream/readable.js:1309`, via `emit` at `src/events.js:699`);
  `common.mustNotCall` at `:127` fires.

Classification: real shim work — port the Node 26 `readable.js`/`writable.js`
changes (one-buffer rule + flowSync/fastChunk + EOF gating + destroy guards).
Lane L1.

## Family E — `toWeb` cancel race, nodejs/node#54205 (1)

`test-stream-readable-to-web-termination.js` (changed: new block citing #54205).
Reproduces exactly on the shim: cancelling a web `ReadableStream` while the
underlying `Readable` is producing data throws `ERR_INVALID_STATE: Controller
is already closed` at `src/stream/web-adapters.js:501` (`onData` →
`controller.enqueue()`), via `src/stream/readable.js:801` (`read`) → `:1318`
(`flow`). Node 26 `lib/internal/webstreams/adapters.js` (263 diff-lines)
checks `wasCanceled` before `enqueue()` (`:598-609`); the shim has the
`wasCanceled` variable (`web-adapters.js:427`) but the `onData` path at `:501`
does not check it before enqueueing. Small targeted fix. Lane L3, est. flip 1.

## Family F — `Duplex.toWeb` `options.type` DEP0201 (1)

`test-stream-duplex.js:160` — `common.expectWarning('DeprecationWarning',
[/Passing 'options\.type' to Duplex\.toWeb\(\) is deprecated/, 'DEP0201'])`
never fires (`mustCall` 0/1). The shim accepts the legacy `options.type` alias
for `options.readableType` (`src/stream/duplex.js:204`) but never emits the
deprecation warning Node 26 added. Small targeted fix. Lane L4, est. flip 1.

## Family G — `Duplex.from` unconsumed async fn, nodejs/node#55077 (1)

`test-stream-duplex-from.js:432` — `pipeline(r, Duplex.from(async function() {
  /* intentionally does not consume its async iterable input */ }),
  mustCall(() => assert.strictEqual(r.destroyed, true)))` never fires:
`pipeline()` never completes and the upstream is never destroyed. Real shim gap
in `Duplex.from` / `src/stream/from.js`. Lane L5, est. flip 1.

## Lane candidates (conservative flip estimates)

| Lane | Work | Tests it would flip (named) | Est. flips |
|---|---|---|---|
| L1 | Port Node 26 `readable.js`/`writable.js` changes into `src/stream/`: one-buffer `howMuchToRead` rule, `fastChunk`/`flowSync` + `pipeOnData` fast paths, `awaitDrainWriters` handling, `kEofReadablePending` EOF gating, destroyed pause/resume no-op guards | readable-one, push-strings, emittedReadable, typedarray, uint8array, compose, unobserved-eof-readable, destroy, pipe-multiple-destinations-error, pipeline, readable-infinite-read (11) | **8** (the 6 D1 + unobserved-eof + destroy are the solid ones; infinite-read, pipe-multiple, pipeline need the full flowSync rework and are the 3 least certain) |
| L2 | `end-of-stream`: conditional `bindAsyncResource` (only when `AsyncContextFrame.current() \|\| enabledHooksExist()`, mirroring Node 26) + ALS-context propagation through the shim's bind | finished-async-local-storage, finished-bindAsyncResource-path | **2** |
| L2b | Fixture/harness adapter: preload-redirect `require('internal/streams/end-of-stream')` to the shim's `kEosNodeSynchronousCallback` symbol so the sync-callback path is reachable (shim symbol vs native symbol identity, § Family C) | finished | **1** (only with the adapter; 0 from shim code alone) |
| L3 | `web-adapters.js`: check `wasCanceled` before `controller.enqueue()` in `onData` (#54205) | readable-to-web-termination | **1** |
| L4 | `Duplex.toWeb`: emit DEP0201 `DeprecationWarning` when legacy `options.type` is passed | duplex | **1** |
| L5 | `Duplex.from`: unconsumed async-function input must still let `pipeline()` complete and destroy the upstream (#55077) | duplex-from | **1** |
| L6 | Port `stream/iter` (`lib/stream/iter.js` + `lib/internal/streams/iter/*`, ~9,000 lines) to `src/stream/iter*`, add preload redirect for `stream/iter` (CJS `preload.mjs` + ESM `hooks.mjs`), re-measure on a Node 26 host (current failures are host-v24 drift, so a shim port can only be scored once the host is 26 or the redirect is in place) | all 35 iter tests: the 28 in family A + the 7 in family B | **25** (least certain: waiter-cleanup GC-bytes assertion, transform-buffering memory bound, writable-interop cork accounting, share-coverage completed-consumer error shape, webidl conversions) |
| — | **Conservative total** | | **38 / 52** |

Notes on L6 scope: the port is large but not blocked on native code. The only
native touchpoints in Node 26's iter implementation are
`internalBinding('util').markPromiseAsHandled` (trivially replaceable) and
`lib/internal/streams/iter/transform.js:49-51` (`internalBinding('zlib')` for
bare native zlib handles, used by the `compressGzip`/`decompressGzip` transform
helpers — reimplementable on the shim's zlib). `classic.js:129,136` lazily
requires the classic `Readable`/`Writable` — in a port those are the shim classes.
`readable-interop` is the one iter test already proven shim-side
(`src/stream/readable.js:1867` deliberate throw); `writable-interop:854` is the
one shim-suspect mixed test and must be re-measured first on a Node 26 host.

## NO-FIX list

**Count: 0.**

No gap was proven to need something impossible in a browser, so nothing is
classified NO-FIX:

- The 28 pure-iter tests look unfixable only because they test the host's native
  `stream/iter` — but the surface itself is ~9,000 lines of pure JS (see L6
  native-touchpoint audit above), so a port is possible in principle. The honest
  classification is "unimplemented + unmeasurable on this host", not "impossible".
- `consumers-dump.mjs` fails at ESM link time on this host, but that is a
  flag/harness artifact (baseline does not pass `// Flags:`; `run.mjs` does),
  not a browser impossibility.
- The `finished.js:109` symbol-identity point is addressable with a harness
  adapter (L2b), not a browser impossibility.
- The ALS tests are addressable by correct context propagation (L2), not by
  anything browser-impossible.

## New-in-26 vs pre-existing split

Token-normalised comparison (whitespace + quote style stripped) of each gap test
against the vendored v24 file (`git show HEAD:parity/node-test/parallel/<test>`):

- **20 entirely new test files** (not in the vendored v24 set): the 3 finished
  tests; iter: broadcast-waiter-cleanup, consumers-dump.mjs, factory-signal,
  from-writable-lifecycle, property-access, readable-interop, reason-propagation,
  resizable-buffers, to-readable, transform-buffering, webidl, writer-reentrancy;
  pipe-multiple-destinations-error, readable-readable-one,
  readable-unobserved-eof-readable, typedarray, uint8array.
- **32 changed test files** (present in vendored v24, with new assertions/coverage
  in the Node 26 version — `dump` imports, new blocks for #53185/#54205/#55077,
  one-buffer expectations, `mustCall` count changes, new error codes):
  compose, destroy, duplex-from, duplex, pipeline, push-strings,
  emittedReadable, infinite-read, to-web-termination, and 23 iter tests.
- **0 unchanged**: no gap test is byte/token-identical to its v24 vendored
  version. There is therefore no "pre-existing regression" in the strict sense —
  every one of the 52 traces to a Node 26 test change and/or a Node 26 lib change
  (`readable.js` 486 lines, `adapters.js` 263, `end-of-stream.js` 25,
  `writable.js` 39, `destroy.js` 1; `lib/stream.js` and `pipeline.js`/`compose.js`/
  `duplex.js`/`transform.js`/`from.js` are 0-diff). The v24 237/237 is not
  contradicted for the classic surface: the 26 baseline passes 180/232, and the
  52 failures sit exactly on changed/new coverage.

## Baseline corrections

1. **run-baseline.mjs drops per-test `// Flags:`** (`run-baseline.mjs` `runOne`
   runs `node --import preload <test>` with no flags), while the canonical runner
   `parity/run.mjs:64-75` (`extractFlags`) parses and passes them, and `fast-sweep.py`
   also has no flag handling (grep: no `Flags` match). Impact is limited because
   Node's `test/common` self-respawns flagged CJS tests with their flags (log
   NOTE lines; flagged re-runs of the 3 finished tests give identical exit 1 and
   identical errors). The **one** test where the omission changes the failure
   mode is `test-stream-iter-consumers-dump.mjs` (ESM static import of
   `node:stream/iter` fails at link time with `ERR_UNKNOWN_BUILTIN_MODULE`
   before `common` can respawn). Fix: pass `extractFlags` in the drift runner;
   flips 0 by itself.
2. **Baseline host is Node v24.22.1, tests are Node 26.13.1.** Any test that
   exercises native modules through the non-redirected path measures host drift,
   not the shim. That is all 35 iter tests (`require('stream/iter')` is never
   redirected by `preload.mjs`/`hooks.mjs`) and, secondarily, the finished
   tests' `require('internal/...')` (native internals — though those tests do
   genuinely exercise the shim via `require('stream')`). A Node 26 host (or a
   `stream/iter` redirect) is required to score L6.
3. **The v24 237/237 included vacuous iter passes.** The 40 vendored
   `test-stream-iter-*` files passed on v24 because they ran against native host
   v24 `stream/iter` (flag passed by `run.mjs`, no preload redirect), not the
   shim. The shim never implemented `stream/iter`; the Node 26 baseline newly
   exposes that because the 26 tests assert 26-only API (`dump`/`dumpSync`,
   proven absent from host v24 by direct probe) and changed native behaviour.
   This is a measurement correction, not a shim regression.
4. **No individual baseline exit code was wrong.** Isolated re-runs reproduce
   52/52 `harnessExit: 1` and the 3 native spot checks exit 0, matching the
   oracle (`nativeExit: 0` for all 52). No sweep flakes found.
5. **Take-1 rig loss (process note, not a baseline error):** the first isolated
   re-run batch died in a VM/runtime restart that wiped `/tmp` (uptime 1 min
   when observed; `~/workspace/tmp-stream-triage/` was used for take 2 so the
   logs survive restarts). Also observed during the runs: many sibling triage
   workers staging/running concurrently (load average ~11), which made each
   isolated run take ~10–45 s; no run hit its 30 s `timeout` cap.
