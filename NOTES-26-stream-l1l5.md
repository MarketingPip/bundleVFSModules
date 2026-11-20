# Node 26 Wave 2 — stream lane L1–L5

- Base: origin/main `652333e7`. Branch: `feat/w2-stream-l1l5`.
- Banked count (coordinator-verified on live main, this run): stream **180/232**.
- New count: **180 + 17 flips − 0 regressions = 197/232** (guard differential
  below; full 232-test suite re-run, pass set compared against the banked 180).
- Node 26 oracle: binary `~/workspace/local/node-26/bin/node` (v26.13.1),
  source `~/workspace/local/node-26-src`; Node 24.20.0 source pack
  `~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/node-src/`.
- Differential method: stage the Node 26 test tree (`test/parallel` +
  `test/common` + `test/fixtures`) into the worktree's `parity/node-test/`,
  run `timeout 30 env PARITY_TARGET=stream node --import <abs preload>
  parity/node-test/parallel/<test>` (same invocation as
  `parity/drift/run-baseline.mjs`), restore via `git checkout --` + deletion
  of staged-only files. Runner: `~/workspace/tmp-stream-l1l5/run.sh`;
  per-test logs: `~/workspace/tmp-stream-l1l5/logs/<test>.<tag>.log`.
- `run-baseline.mjs` does NOT honor `// Flags:` headers: the three
  `finished` tests were run directly WITH `--expose-internals` (tag
  `base-fin` / `t1` / `take2`); all other flip tests were run plain.
- No fresh web research; Node 26 source pack + repo tree + local probes only.

## Baseline (live main, before any change)

All 17 target tests exit 1 (tags `base0`, `base-fin`):

- L1 (11): readable-one, push-strings, emittedReadable, typedarray,
  uint8array, compose, unobserved-eof-readable, destroy,
  pipe-multiple-destinations-error, pipeline, readable-infinite-read.
- L2 (2): finished-async-local-storage, finished-bindAsyncResource-path.
- L2b (1): finished (`:109` mustCall 0/1 — sync-callback symbol identity).
- L3 (1): readable-to-web-termination. L4 (1): duplex. L5 (1): duplex-from.

## Flips — all verified [0,0] x2 (isolated re-runs, take 1 + take 2)

### L1 — port Node 26 `readable.js` / `writable.js` (11 flips, incl. the 3 least-certain)

`src/stream/readable.js`, `src/stream/writable.js`, `src/stream/destroy.js`,
`src/stream/promises.js`:

- One-buffer `howMuchToRead` fast path (`readable.js`, mirroring Node 26
  `lib/internal/streams/readable.js`): with no decoder and buffered data, a
  no-arg `read()` returns `state.buffer[state.bufferIndex].length` — one
  buffer at a time, no merge allocation.
- `fastChunk` / `flowSync()` + `pipeOnData` single-destination fast path
  (`kFastPush`, `kEndScheduled`, `kEofReadablePending` bits;
  `materializeFastChunk()`; `deliverFlowChunk()` using
  `Writable.writeKnownBuffer`): `push()` parks one Buffer on `fastChunk`
  while `flowSync()` is inside `_read()`; `flow()` tries `flowSync()` first.
- `writeKnownBuffer` (`writable.js`, incl. `Writable.writeKnownBuffer`
  static) + `clearBuffer` threshold tweak (`i > 256 && i * 2 >=
  buffered.length`).
- `awaitDrainWriters` (#53185): `pipe()` cleanup calls `ondrain()`
  unconditionally when a drain waiter exists (no `needDrain` guard), so a
  synchronously-errored destination no longer starves the others.
- `kEofReadablePending` EOF gating: `onEofChunk` skips scheduling the
  `'readable'` emission when nobody observes the stream; a later
  `'readable'` listener redeems it in `Readable.prototype.on`.
- Destroyed pause/resume no-op guards; `endReadable`/`endReadableNT`
  `kEndScheduled` dedup; `readableBuffer` getter is `fastChunk`-aware;
  `setEncoding`/`read()` materialize `fastChunk`; `undestroy()` clears
  `fastChunk` (`destroy.js`).
- `stream/promises` pipeline resume (Node 26 `lib/stream/promises.js`,
  NEW in 26 vs v24 — the root cause of the `pipeline` stall, found by
  probe, not by guessing): when the last stream is a function and the
  returned stream is readable, `stream.resume()` — otherwise the
  PassThrough proxy nobody consumes never drains and `pipeline()` never
  completes. Probe evidence: native Node 26 `pipelinep` resolves with
  `pt._read` called 49× and `pt.resume()` called once from
  `node:stream/promises:46`; the shim's identical `pumpToNode` deadlocked
  without the resume (probe scripts in `~/workspace/tmp-stream-l1l5/
  probe-pipeline*.mjs`, `probe4-*.mjs`, `probe5/6/7-native.mjs`).
  The async-iterator rework in Node 26 `readable.js` was NOT ported: the
  stall was proven to be the missing resume, not the iterator (manual
  replication of the pipeline steps with the v24 iterator completes).
- Stage evidence: after Stage A (everything above except `flowSync` and
  the promises resume) 10/11 L1 tests flipped (tag `tA`); `pipeline`
  still exit 1. After Stage B (`flowSync`) still exit 1 (tag `tB`) —
  `flowSync` alone did not fix it. After the promises-resume fix,
  `pipeline` exit 0 (tag `tC`).

Flipped (take 1 tags `tA`/`tB`/`tC`, take 2 tag `take2b`, all exit 0 twice):

- test-stream-readable-readable-one.js, test-stream-push-strings.js,
  test-stream-readable-emittedReadable.js, test-stream-typedarray.js,
  test-stream-uint8array.js, test-stream-compose.js,
  test-stream-readable-unobserved-eof-readable.js, test-stream-destroy.js,
  test-stream-pipe-multiple-destinations-error.js,
  test-stream-readable-infinite-read.js, test-stream-pipeline.js.

### L2 — `finished()` ALS / async-hook context (2 flips)

`src/stream/async-resource.js` (only file): the stub `AsyncResource`
(identity `runInAsyncScope`) is replaced by a re-export of the real
`AsyncResource` from `src/async_hooks.js` — under real Node that delegates
to the native builtin (true ALS/hook semantics, same module instance the
tests' `require('async_hooks')` gets); in the browser it is the honest
stub with the same shape. `end-of-stream.js` itself is untouched; its
`bindAsyncResource` now binds through the real resource, so the
`finished()` callback runs in the context where `finished()` was called
and the `STREAM_END_OF_STREAM` `init` hook fires with the right trigger
async id.

- test-stream-finished-async-local-storage.js, test-stream-finished-bindAsyncResource-path.js
  (tags `t1` / `take2`, run with `--expose-internals`, exit 0 twice).

Deliberate deviation from the task brief, with proof: Node 26 binds only
when `AsyncContextFrame.current() || enabledHooksExist()`. That condition
is not observable from shim code — probe-proven:
`process.getBuiltinModule('internal/async_context_frame')` returns
`undefined` on both the v24 host and the Node 26 binary, and
`enabledHooksExist()` is internal-only. So the bind stays unconditional
(the Node 24 shape), now through the real resource. The conditional is
perf-only; correctness is what the two Node 26 tests assert, and both
pass. `ponytail:` comment in `async-resource.js` records the ceiling.

### L2b — harness adapter, `kEosNodeSynchronousCallback` symbol identity (1 flip)

`parity/internal-eos-adapter.mjs` (new) + `parity/preload.mjs` (one
target-scoped redirect, `target === "stream" &&
bare === "internal/streams/end-of-stream"`). The adapter re-exports real
Node's internal module with `kEosNodeSynchronousCallback` replaced by the
shim's symbol (`src/stream/end-of-stream.js`), so the test's
`[kEosNodeSynchronousCallback]: true` option reaches the shim's sync
path. No `src/` change; 0 flips from shim code alone, as triaged.

- test-stream-finished.js (tags `t1` / `take2`, run with
  `--expose-internals`, exit 0 twice).

### L3 — `toWeb` cancel race, #54205 (1 flip)

`src/stream/web-adapters.js`: `onData` returns early when `wasCanceled`
before `controller.enqueue()` (Node 26
`lib/internal/webstreams/adapters.js:598-609`).

- test-stream-readable-to-web-termination.js (tags `t1b` / `take2b`).

### L4 — `Duplex.toWeb` `options.type` DEP0201 (1 flip)

`src/stream/web-adapters.js`: `newReadableWritablePairFromDuplex` emits a
once-per-process `DeprecationWarning` (`DEP0201`, message verbatim from
Node 26) via guarded `process.emitWarning` when legacy `options.type` is
passed without `options.readableType` (mirrors Node 26's
`getDeprecationWarningEmitter`).

- test-stream-duplex.js (tags `t1b` / `take2b`).

### L5 — `Duplex.from` unconsumed async fn, #55077 (1 flip)

`src/stream/duplexify.js`: port of the Node 26 `duplexify.js` fix
verbatim — a `finalized` flag; when the async function's promise fulfils
before writable `final()` started, `destroyer(d)` so `pipeline()`
propagates destruction upstream.

- test-stream-duplex-from.js (tags `t2` / `take2b`).

## NOT ported (out of scope / no evidence it is needed)

- Node 26 `readable.js` async-iterator rework (queued `next`/`return`/
  `throw`, `FixedQueue`): the `pipeline` stall was proven to be the
  missing promises-pipeline resume, and manual replication with the v24
  iterator completes — no evidence any target test needs the rework.
- `stream/iter` port (L6, Wave 3, gated): untouched; iter tests not counted.
- `removeAllListeners` `ReflectApply` and other cosmetic Node 26 diff
  lines: not ported (no behavioural effect).

## Guards held

- Full 232-test Node 26 stream differential (`parity/drift/run-baseline.mjs
  --modules stream --jobs 2 --short 10 --full 30`, fresh output
  `~/workspace/tmp-stream-l1l5/guard/node26-stream-after.jsonc`,
  CSV `~/workspace/tmp-stream-l1l5/guard/node26-baseline-stream.csv`):
  **197/232 pass, 35 fail, 0 timeout**. Pass-set diff vs the banked
  `parity/drift/node26-baseline.jsonc` (180/232): **0 regressions** (all
  180 banked passes still pass), flips exactly the 17 named above, and
  the 35 remaining fails are all `test-stream-iter-*` (L6, Wave 3).
- Repo jest stream tests (with `NODE_OPTIONS=--experimental-vm-modules`,
  per AGENTS.md): 12 suites, 67 tests, all pass
  (`tests/stream_promises.test.js`, `tests/stream_web.test.js`,
  `tests/export_surface_stream*.test.js`,
  `tests/export_surface__stream_*.test.js`). Without the flag jest fails
  to load the ESM suites (`createRequireEsmError`) — pre-existing harness
  behaviour, not a code failure.
- No other module's files touched. Changed files (8 modified + 2 new):
  `src/stream/{readable,writable,destroy,duplexify,promises,async-resource,
  web-adapters}.js`, `parity/preload.mjs`,
  `parity/internal-eos-adapter.mjs` (new), `NOTES-26-stream-l1l5.md` (new).
  No docs-number changes.
- No `stream/iter` files touched; no iter tests counted as flips.

## NO-FIX

None. All 17 target tests flipped with the ports above.

## Ship

- PR: #522
- Merge SHA: `b5f2e94f265ff99a591306efef31f5c535c13920` (squash-merge of PR #522)
- Final count: **stream 197/232** (180 banked + 17 flips, 0 regressions)
