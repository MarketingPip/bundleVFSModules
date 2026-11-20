# NOTES-26-worker-threads-w261.md

Node 26 Wave 2 lane W-26-1 — Worker exit listener cleanup. Branch
`feat/w2-worker-threads-w261`, base origin/main `b5f2e94f` (stream L1–L5,
#522; brief named `652333e7`, origin/main had moved by lane start —
coordinator-verified banked count 137/146 was on live main).
Worktree: `~/workspace/worktrees/w2-worker-threads-w261`.
Node 26 binary: `~/workspace/local/node-26/bin/node --version` = `v26.13.1`.
Host Node (harness runtime): `v24.22.1`. Node 26 source:
`~/workspace/local/node-26-src/` (oracle for the mechanism below).

## Triage reference

`NOTES-26-triage-worker_threads.md` § F4: Node 26 removes `message` AND
`messageerror` listeners on Worker exit; host v24.22.1 removes `message`
only. Test `test-worker-messageerror-listener-cleanup.js` fails at `:15`
(the `messageerror` assertion, `1 !== 0`).

## Oracle mechanism (Node 26 source, not a guess)

`lib/internal/worker.js:389-406` (`[kOnExit]`, Node 26.13.1 source pack):

```js
[kOnExit](code, customErr, customErrReason) {
  drainMessagePort(this[kPublicPort]);
  drainMessagePort(this[kPort]);
  destroyMainThreadPort(this.threadId);
  this.removeAllListeners('message');
  this.removeAllListeners('messageerror');
  // …unref ports, dispose, maybe emit 'error'…
  this.emit('exit', code);
  this.removeAllListeners();
}
```

Removal happens before `'exit'` is emitted. The shim mirrors only the
`message`/`messageerror` pre-exit removal (scope of this lane, § F4);
the post-exit `removeAllListeners()` is deliberately NOT mirrored — no
test needs it and it would widen the blast radius.

## Design question: wrapping the native Worker (parent call)

Under the harness `Worker` is the native host Worker
(`src/worker_threads.js:899`, `nativeWt.Worker`). The BrowserWorker
`#finish` fix alone cannot flip the test — so the lane wraps the native
Worker in a thin subclass. The parent coordinator authorized ATTEMPTING
the lane; the wrap was judged workable on these grounds, verified by
probe before any `src/` edit:

- **Precedent in the same file, by design:** `src/worker_threads.js`
  already delegates to native under Node (`getNativeWorkerThreads()`,
  `nativeWt ? nativeWt.Worker : BrowserWorker`, native passthroughs for
  `MessageChannel`/`MessagePort`/`BroadcastChannel`/`locks`/etc., and
  `export default nativeWt ?? _defaultExport`). The subclass extends
  that delegation by one behaviour (26's exit cleanup); it adds no new
  delegation and changes no browser-path behaviour — the subclass exists
  only when `nativeWt` is present, and `BrowserWorker` gets the same
  cleanup in `#finish`.
- **AGENTS.md rule 1 (browser-first) is not violated:** the browser
  fallback lane still runs the pure `BrowserWorker` implementation with
  zero native delegation; the subclass is inert without native Node.
  The wrap does not make the browser path depend on native anything.
- **Fidelity probes (plain host node, `/tmp/wt-subclass-probe.mjs`,
  before the fix):** subclass `Worker extends NativeWorker` with a
  constructor-registered `once('exit')` cleanup → exit handler observes
  `message 0, messageerror 0`; `instanceof Worker` and `instanceof
  NativeWorker` both true; `threadId` correct; `terminate()` returns a
  promise; `Worker.name === 'Worker'`; `Worker.length === 2` with
  `(filename, options)` — matched to native `1` by declaring
  `constructor(filename, options = {})` (native is
  `constructor(filename, options = kEmptyObject)`).
- **No masking:** `maskAsNative` was NOT applied — probe shows the real
  `Worker.toString()` is class source
  (`"class Worker extends EventEmitter {\n  constructor(filename, …"`),
  not `[native code]`; the subclass's `toString()` is class source too,
  so masking would diverge from native.
- **CJS require path (the subtle part):** the flip test is CJS
  (`require('node:worker_threads')`), and the preload returns the
  default export (`parity/preload.mjs`: `ns.default ?? ns`). Probe
  (`zz-probe-require.cjs`, since removed) proved
  `require('node:worker_threads') === process.getBuiltinModule(
  'worker_threads')` under the harness — i.e. the test held the native
  host Worker, and changing only the named `Worker` export would NOT
  flip it. So the default export is a descriptor-preserving copy of the
  native module with only `Worker` swapped (probe-proven on host
  v24.22.1: 21 own string keys, 0 symbols, all plain writable/
  enumerable/configurable data props, `Object.prototype` prototype).
  Every other binding keeps its native value and identity.

## Fix (`src/worker_threads.js`, +52/−2, one file)

1. `BrowserWorker.#finish` — `removeAllListeners('message')` +
   `removeAllListeners('messageerror')` before `emit('exit', code)`.
2. Native path — `const Worker = nativeWt ? class Worker extends
   nativeWt.Worker { constructor(filename, options = {}) {
   super(filename, options); this.once('exit', () => {
   this.removeAllListeners('message');
   this.removeAllListeners('messageerror'); }); } } : BrowserWorker;`
   Constructor-registered `once('exit')` runs before any user `'exit'`
   handler added after construction (EventEmitter registration order).
3. Default export — `_nativeDefault` descriptor copy (see above);
   `export default _nativeDefault ?? _defaultExport;`

## Flip evidence (isolated, harness, staged Node 26 files)

Baseline (pre-fix, `PARITY_TARGET=worker_threads timeout 30 node
--import <abs preload> parity/node-test/parallel/<test>`):
- harness: exit **1**, `AssertionError [ERR_ASSERTION]` at
  `test-worker-messageerror-listener-cleanup.js:15:10`, `1 !== 0`
  (`.lane-probes/msgerr-harness-base.err`).
- native Node 26.13.1 (no preload): exit **0**.
- native host v24.22.1 (no preload): exit **1**, same `:15`, `1 !== 0`.

Post-fix, same harness invocation, **2× exit 0**
(`.lane-probes/msgerr-harness-fix-1.out/.err`,
`msgerr-harness-fix-2.out/.err` — both empty stderr, exit 0).
Probe logs: `~/workspace/node26-misc-probes/` (copies) and worktree
`.lane-probes/` (scratch, not committed).

## Differential (full 26-suite guard)

Runner: `node parity/drift/run-baseline.mjs --node26-src
~/workspace/local/node-26-src --worktree <worktree> --out
.lane-probes/w261-baseline.jsonc --csv-dir .lane-probes/csv-w261
--modules worker_threads --jobs 2` (stages Node 26 `test/parallel +
common + fixtures`, restores afterwards — `parity/node-test/` verified
clean after the run).

- **Result: 138/146 pass, 7 fail, 1 timeout** (baseline
  `parity/drift/node26-baseline.jsonc`, worktree `6e3a1889`, host
  v24.22.1: 137/146, 8 fail, 1 timeout).
- **Flipped (1):** `test-worker-messageerror-listener-cleanup.js`
  (exit 1 → 0). Only exit-code change in the whole suite.
- **Regressions: none.** All other 145 exits identical to baseline,
  including the 8 remaining non-pass with identical codes:
  cpu-profile 1, debug 124, heap-profile 129, heap-statistics 1,
  message-port-inspect 1, fd0 1, process-env 1, spec-differences 9.
- **Phase-2 pattern (adjudicated, not a regression):** 7 tests hit the
  10 s phase-1 cap and re-ran at 30 s; 6 passed there, only
  `test-worker-debug.js` stayed 124 — identical to its baseline 124.
- Full per-test CSV: `.lane-probes/csv-w261/
  node26-baseline-worker_threads.csv` (scratch, not committed);
  aggregate JSON: `.lane-probes/w261-baseline.jsonc`.

## Count

**138/146** (banked 137 + 1 flip, 0 regressions).
New count = 137 + 1 verified flip − 0 regressions = **138**.

## Files in the PR

- `src/worker_threads.js` (only `src/` file touched)
- `NOTES-26-worker-threads-w261.md` (this file)
- No docs-number changes.

## Ship

- PR: #523
- Merge SHA: `bf42753be3435f884c8f025bed10c4f75c66342a` (squash-merge of PR #523)
- Final count: **worker_threads 138/146** (137 banked + 1 flips, 0 regressions)
