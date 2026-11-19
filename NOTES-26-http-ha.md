# NOTES-26-http-ha — Node 26 Wave 1 lane H-A: new exports (pure JS)

- Lane: NOTES-26-triage-http.md §H1 / lane table H-A (2 flips).
- Base: origin/main `d587825d` (PR #506 triage merged). Branch: `fix/26w1-http-ha`.
- Recovery rebase 2026-11-20: onto origin/main `bb6905b5` (dns #507, vm #509,
  module #508, buffer #512 merged); clean rebase, no conflicts; new head
  `f3a1b2bd` (pre-NOTES-amend). First `git fetch` failed transiently
  (HTTP/2 stream CANCEL); retry succeeded.
- Worktree: `~/workspace/worktrees/26w1-http`.
- Node 26 binary (oracle probes): `~/workspace/local/node-26/bin/node` (`v26.13.1`).
- Node 26 tests: `~/workspace/local/node-26-src/test/parallel/`.
- Harness invocation (baseline): `PARITY_TARGET=http timeout 30 node --import
  <worktree>/parity/preload.mjs parity/node-test/parallel/<test>` (Node 26
  tree staged as `parity/drift/run-baseline.mjs` stages it). Neither target
  test carries a `Flags:` header; `test-http-websocket-mask-fast.js` carries
  `Flags: --expose-internals --no-warnings --allow-natives-syntax` and was
  run isolated WITH those flags (see below); the runner does NOT honor
  `Flags:` headers, so its fast-test pass came via the test respawning
  itself with its own flags through `common`.

## Flips (verified 2x isolated each, exit 0 — re-verified on rebased head)

1. `test-http-is-valid-header.js` — NEW in 26. Pre-fix exit 1:
   `TypeError: isValidHeaderName is not a function`.
   `test-http-websocket-mask.js` — NEW in 26.12.0. Pre-fix exit 1:
   `TypeError: websocketMask is not a function`.
   Isolated on rebased head `f3a1b2bd`: both 0, 0 (no `Flags:` headers).

## Change (one file: `src/http.js`, +150/−1)

- `isValidHeaderName(name)` (`src/http.js`, next to `validateHeaderName`):
  Node 26 `lib/_http_outgoing.js` — `typeof name === 'string' &&
  checkIsHttpToken(name)`; the `typeof` guard is load-bearing (the shim's
  `_checkIsHttpToken` would return `true` for a non-string, e.g. a number,
  whose `.length` is `undefined`).
- `isValidHeaderValue(value, options)` (`src/http.js`): Node 26
  `lib/_http_outgoing.js` — options validated first via `validateObject`
  (null / array / non-object → `ERR_INVALID_ARG_TYPE`) and `validateOneOf`
  on `options.httpValidation` (`'strict'` default, `'relaxed'` → Fetch-spec
  leniency; anything else → `ERR_INVALID_ARG_VALUE` with the `validateOneOf`
  message shape, cf. the Agent `scheduling` site); `undefined` or symbol
  values return `false`; otherwise `!_checkInvalidHeaderChar(value, lenient)`.
  No `String()` coercion on the value — `regex.test` coerces exactly as
  Node's `checkInvalidHeaderChar` does.
- `validateHeaderValue(name, value, lenient)` — root-cause fix, same diff:
  dropped the `String(value)` pre-coercion. Node passes `value` straight to
  `checkInvalidHeaderChar`, whose `regex.test()` throws a bare `TypeError`
  ("Cannot convert a Symbol value to a string") for symbols; `String()`
  masked that into `"Symbol(a)"` and succeeded. The test requires the
  boolean validator to agree with the throwing one for every input
  (`test-http-is-valid-header.js:117`), so the throw has to happen here.
  Probed on real Node 26.13.1: `validateHeaderValue('x', Symbol('a'))`
  throws `TypeError`, `isValidHeaderValue(Symbol('a'))` is `false`,
  `validateHeaderValue('x', 1n)` does not throw.
  Adjacent divergence NOT touched (out of lane scope): the `setHeader` /
  `OutgoingMessage` call sites still pre-coerce with `String(value)`, so a
  Symbol header value there succeeds where real Node throws `TypeError`.
- `websocketMask(source, key, output, offset, length)` /
  `websocketUnmask(buffer, key)` (`src/http.js`): Node 26.12.0 `lib/http.js`
  — pure-JS RFC 6455 §5.3 XOR (no C++ `buffer.mask` binding exists in a
  browser). Validation order, error codes, and messages mirror `lib/http.js`:
  views checked with `ArrayBuffer.isView` (`ERR_INVALID_ARG_TYPE`,
  `['Buffer', 'TypedArray', 'DataView']`), key must be 4 bytes
  (`ERR_INVALID_ARG_VALUE`, `'must be 4 bytes long'`), offset/length via
  Node's `validateInteger` (`ERR_INVALID_ARG_TYPE` for non-numbers,
  `ERR_OUT_OF_RANGE` `'an integer'` / `'>= 0 && <= max'`), length must fit
  the output (`ERR_OUT_OF_RANGE`, `<= ${outputLength - offset}`). Nothing
  is written when validation fails. The 4 key bytes are snapshotted up
  front (the key may alias the output) and an overlapping source/output
  is snapshotted too, so the result reads as if the source had been copied
  first. Zero length returns before any view is built, so detached inputs
  (`byteLength` 0) never touch a detached buffer.
- All four added to the default export object (`src/http.js`, §16).

## Bonus flip (same change, verified 2x isolated, exit 0)

- `test-http-websocket-mask-fast.js` — triage listed it NO-FIX (exit 133)
  on the theory that V8 natives syntax / fast-API call counting cannot
  exist in a browser. The actual failure on main was the missing export:
  the test respawns itself with its own `Flags: --expose-internals
  --no-warnings --allow-natives-syntax` (the harness `common` does this;
  the run log shows the child-process NOTE) and then calls
  `%PrepareFunctionForOptimization(websocketMask)` — with `websocketMask`
  `undefined` that is the V8 fatal `Check failed: v8_flags.fuzzing`
  (SIGTRAP, 133). With a real function the intrinsics run and the test
  passes; the `getV8FastApiCallCount('buffer.mask')` assertion only runs
  on debug builds (`common.isDebug`), so it is skipped here. Genuine flip
  of this lane's change, not a harness artifact. Re-verified on rebased
  head: 0, 0 isolated WITH the `Flags:` flags
  (`--expose-internals --no-warnings --allow-natives-syntax`).

## Still NO-FIX (unchanged, verified 2x isolated on rebased head)

- `test-http-websocket-mask-immutable.js` — exit 9 both runs: the harness
  host (`/usr/bin/node` v24.22.1) rejects `--js-immutable-arraybuffer`
  (`node: bad option`). Immutable ArrayBuffers do not exist in browsers.
  Run isolated WITH its `Flags:` (`--js-immutable-arraybuffer
  --allow-natives-syntax`).

## Guard: full Node 26 http suite (rebased head — supersedes the pre-rebase run below)

- `node parity/drift/run-baseline.mjs --node26-src ~/workspace/local/node-26-src
  --worktree ~/workspace/worktrees/26w1-http --out /tmp/node26-http-ha-rebase.jsonc
  --csv-dir /tmp/node26-ha-rebase-csv --modules http --jobs 2 --short 10 --full 30`
  (~29 min wall; 44/422 tests hit the 10 s phase-1 cap and were re-run at 30 s).
  The worktree had lost its `node_modules` symlink in the restart drain;
  restored with `ln -s ~/workspace/bundleVFSModules/node_modules`
  (untracked, ignored by the commit).
- Baseline on main (`parity/drift/node26-baseline.jsonc`): http 390/422 pass.
- Post-fix (rebased): **394/422 pass, 21 fail, 7 timeout**
  (`/tmp/node26-http-ha-rebase.jsonc`,
  CSV `/tmp/node26-ha-rebase-csv/node26-baseline-http.csv`). Only 4 rows
  differ from baseline:
  - `test-http-is-valid-header.js`: 1 → 0 (flip).
  - `test-http-websocket-mask.js`: 1 → 0 (flip).
  - `test-http-websocket-mask-fast.js`: 129 → 0 (bonus flip, see above).
  - `test-http-server-drop-connections-in-cluster.js`: 124 → 0 in the full
    run — **flake, NOT a lane flip, NOT counted**. Isolated 2x on the
    rebased head it times out both runs (124, 124; log tail
    `ECONNREFUSED`, errno -111 — cluster workers fail to connect). No
    mechanism: this diff touches no cluster/server code (only header
    validators + mask fns), and the test is timing-sensitive. It was a
    timeout in the triage baseline too.
  - `test-http-byteswritten.js`: 0 in the rebased full run (was 0 → 124 in
    the pre-rebase run) — isolated 2x on the rebased head: 124, 0. Load
    flake both ways, not a regression. No mechanism (see pre-rebase
    adjudication below).
  - All other 29 baseline failures unchanged; all other 389 baseline
    passes still pass. `test-http-websocket-mask-immutable.js` still 9.
- Net: guard run 394/422; true post-fix count **393/422** (390 + 3 flips)
  — the 394 includes the one-off cluster-test pass, which fails isolated.

## Guard: full Node 26 http suite (pre-rebase, superseded)

- `node parity/drift/run-baseline.mjs --node26-src ~/workspace/local/node-26-src
  --worktree ~/workspace/worktrees/26w1-http --out /tmp/node26-http-ha.jsonc
  --csv-dir /tmp/node26-ha-csv --modules http --jobs 2 --short 10 --full 30`
  (~40 min wall; 5+ sibling lanes ran baselines concurrently, 152/422 tests
  hit the 10 s phase-1 cap under that contention and were re-run at 30 s).
- Baseline on main (`parity/drift/node26-baseline.jsonc`): http 390/422 pass.
- Post-fix: **392/422 pass, 21 fail, 9 timeout** (`/tmp/node26-http-ha.jsonc`,
  CSV `/tmp/node26-ha-csv/node26-baseline-http.csv`). Only 4 rows differ
  from baseline, all in this lane's favour except one adjudicated flake:
  - `test-http-is-valid-header.js`: 1 → 0 (flip).
  - `test-http-websocket-mask.js`: 1 → 0 (flip).
  - `test-http-websocket-mask-fast.js`: 129 → 0 (bonus flip, see above).
  - `test-http-byteswritten.js`: 0 → 124 in the full run — **load flake,
    not a regression**. Adjudication: isolated re-runs with the fix pass
    4/5 (124, 0, 0, 0, 0; the single 124 was the first run, at peak
    contention) and on main 2/2 (0, 0). No mechanism: the test writes
    1.5 MB through the virtual socket and asserts `bytesWritten` timing;
    it never touches a Symbol header value or the new exports, and the
    only behavioural delta in this diff for its path is nil
    (`validateHeaderValue` on plain string headers is byte-identical).
  - All other 29 baseline failures unchanged; all other 389 baseline
    passes still pass. `test-http-websocket-mask-immutable.js` still 9.
- Net: guard run 392/422; true post-fix count **393/422** (390 + 3 flips)
  — the 392 reflects the byteswritten load flake, which passes isolated.
