# NOTES-26-assert-a261 — Lane A-26-1: assert message semantics (Node 26)

Base: origin/main `d587825d` (PR #506 triage merged), rebased onto
`bb6905b5` (buffer #512) — recovery commit `4ebd2fef`, clean rebase,
no conflicts. Worktree:
`~/workspace/worktrees/26w1-assert`, branch `fix/26w1-assert-a261`.
Triage source: `NOTES-26-triage-assert.md` §F1 (lane table: flip 1, `test-assert.js`).

## Result

- **Flip: `test-assert.js` (1 file).** Assert suite on the Node 26 files:
  **12/14 → 13/14** (banked 12 + 1 flip, 0 regressions).
- `test-assert-deep.js` still fails — expected, out of scope (A-26-2, F2b NO-FIX).
  Its 4 failing sub-tests are unchanged: es6 Maps and Sets, Check proxies,
  Crypto, Promises should fail deepEqual (50/54 sub-tests pass).

## What changed (`src/assert.js` only, +331/−97)

Node 26 message resolution, mirroring `lib/internal/assert/utils.js`
(`innerFail`) and `lib/assert.js`:

- `innerFail` moved into `__assertUtilsMod` and rewritten to resolve the
  message as a **tuple array**: `[]` → default message; `[string]` (+ extras)
  → printf-format via a compact `util.format` port (`__formatMessage`:
  `%s/%d/%i/%f/%j/%o/%O/%c/%%` + appended extras, adapted from the vendored
  `src/util.js` port — the assert shim is standalone and cannot import it);
  `[Error]` → thrown as-is, `[Error, ...extra]` → `ERR_AMBIGUOUS_ARGUMENT`;
  `[function]` → called with `(actual, expected)`, non-string result or a
  throw falls back to the default message, `[function, ...extra]` →
  `ERR_AMBIGUOUS_ARGUMENT`; anything else → `ERR_INVALID_ARG_TYPE`
  (`'message'`, `['string', 'function']`). `generatedMessage` propagates
  from the caller, as in Node 26.
- `innerOk` rewritten to Node 26's rest-args shape (`ok`/`strict` pass
  `args.slice(1)` as the message tuple) — this is what makes
  `assert(false, Symbol('foo'))` throw `ERR_INVALID_ARG_TYPE`.
- Rest-args `...message` on the 12 arity-changed functions (arity 3 → 2,
  `fail` 5 → 1, matching the export diff): `equal`, `notEqual`,
  `deepEqual`, `notDeepEqual`, `deepStrictEqual`, `notDeepStrictEqual`,
  `strictEqual`, `notStrictEqual`, `partialDeepStrictEqual`, `match`,
  `doesNotMatch`, `fail`. `match`/`doesNotMatch` go through `internalMatch`
  in the Node 26 shape (`message[0] ||=` default, `generatedMessage =
  message.length === 0`, resolved via `innerFail` with
  `actual` = string, `expected` = regexp).
- `fail()` collapsed to the single-message form (multi-arg removed in
  25.0.0): `fail(message)`; Error → thrown; `undefined` → `'Failed'`
  with `generatedMessage: true`; extra args ignored; DEP0094 warning
  removed.
- Throws-path callers wrap their single message as a 1-tuple, as Node 26
  does (`compareExceptionKey`: `[message]`; `expectsError` /
  `expectsNoError`: `[string]`).
- Error-class `constructor` fix (found during verification, not in the
  triage): Node's `makeNodeErrorWithCode` defines
  `get ['constructor']() { return Base; }` on every code-carrying error
  class, so `err.constructor === TypeError` for `ERR_INVALID_ARG_TYPE`.
  Added the same getter to `__makeError` (covers all five code errors)
  and to `__ERR_AMBIGUOUS_ARGUMENT`. Without it the `:905` Symbol case
  failed only on `constructor` identity (message and code already right).

## Verification (all on live main, host Node v24.22.1)

Oracle probes against `~/workspace/local/node-26/bin/node` (v26.13.1) before
implementing: 22 cases (ok/printf/Symbol/Error/function-message/fail forms/
match null/empty/explicit-undefined). The shim reproduces the oracle output
exactly on all 22 (code, message, `generatedMessage`), and
`assert.equal.length === 2`, `assert.fail.length === 1`.

- BEFORE (`parity/drift/run-baseline.mjs --modules assert --jobs 2`, full
  30 s cap): 11/14 pass, 2 fail (`test-assert.js`, `test-assert-deep.js`),
  1 timeout (`test-assert-typedarray-deepequal.js`, exit 124). The timeout
  is a load artifact: isolated it passes in ~31 s (exit 0), i.e. the
  committed baseline's 12/14 stands.
- AFTER, full guard (`run-baseline.mjs --modules assert --jobs 2 --full 90`):
  **13/14 pass, 1 fail (`test-assert-deep.js`), 0 timeout** — every
  baseline pass held, `test-assert.js` exit 0, `test-assert-typedarray-
  deepequal.js` exit 0.
- `test-assert.js` isolated, 2x: 23/23 sub-tests, exit 0, twice
  (`PARITY_TARGET=assert timeout 60 node --import
  <abs worktree>/parity/preload.mjs parity/node-test/parallel/test-assert.js`,
  Node 26 `test/parallel` + `common` staged; the preload path must be
  absolute — a relative `--import parity/preload.mjs` fails
  `ERR_MODULE_NOT_FOUND`).

## Recovery re-verification (rebased head `4ebd2fef`, on `bb6905b5`)

Original worker was killed by a runtime restart after committing locally;
recovery re-verified everything on the rebased head before pushing:

- Rebase onto current `origin/main` (`bb6905b5`, buffer/dns/vm/module
  merges): clean, no conflicts, no src changes needed.
- Full guard re-run (`run-baseline.mjs --modules assert --jobs 2 --full 90`,
  fresh out `parity/drift/node26-baseline-a261-rebase.jsonc`, fresh CSV
  `parity/drift/csv-a261-rebase/`): **13/14 pass, 1 fail
  (`test-assert-deep.js`), 0 timeout** — all 12 baseline passes held,
  `test-assert.js` exit 0, `test-assert-typedarray-deepequal.js` exit 0.
  (Two preflight notes: `run-baseline.mjs --worktree` must be absolute —
  a relative `.` fails the memfs `createRequire` preflight; and a
  `cp -r` into an existing staging dir nests it — stage with `rm` first,
  as the runner does. Both are harness-invocation issues, not code.)
- `test-assert.js` isolated, 2x on the rebased head: 23/23, exit 0, twice.
- `test-assert-deep.js` isolated on the rebased head: 50/54, exit 1,
  failing sub-tests exactly the triaged F2 set (es6 Maps and Sets, Check
  proxies, Crypto, Promises should fail deepEqual) — no regression.
- Repo tests on the rebased head: 6 suites, 87 tests, all pass.
  (`node --check src/assert.js` clean.)
- Sweep evidence preserved at
  `~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/node26-baseline-a261-rebase.jsonc`
  (+ `csv-a261-rebase/`).

## CI (PR #516) — v24 parity conflicts, fixed via expected-failures

- First CI run on remote head `336a0e33` (run 44647783408): build
  **success**, Parity **failure**. The Parity job runs the vendored v24
  suite (`parity/run.mjs` for path/punycode/querystring/string_decoder/
  events/assert); assert was 17/19 with exactly two NEW failures, both
  genuine v24-vs-Node-26 conflicts — the v24 tests pin behavior Node 26
  deliberately removed, and the shim intentionally implements Node 26,
  so no code change can satisfy both suites:
  - `test-assert.js` (v24 "Additional asserts"): expects
    `assert(false, Symbol('foo'))` → AssertionError `'Symbol(foo)'`;
    Node 26 throws `ERR_INVALID_ARG_TYPE`. Mutually exclusive.
  - `test-assert-fail-deprecation.js`: expects multi-arg `fail()` +
    DEP0094 warning, removed in Node 25.0.0.
  - `test-assert-deep.js` PASSED in CI (Node 24.20.0); its Crypto
    sub-test fails only under local host Node v24.22.1 (native
    KeyObject inspect-tag difference) — a local-version artifact,
    not a CI issue.
- Fix (recovery commit): both files added to
  `parity/expected-failures.shim.json` as `wontfix` with reasons
  (per `docs/PARITY_TESTING.md`: "Not worth fixing — document why,
  move on"; precedent: 301 entries). No code change — the Node 26 flip
  stands, and the v24 files are documented as superseded, not faked.
- Verified with the CI-mirror binary
  (`~/workspace/local/node-24.20.0/bin/node parity/run.mjs assert`):
  exit 0, 17/19, "No new failures. Parity steady. ✔", 303 expected
  (wontfix: 2).
- Dist-regen note: the build job auto-pushed `chore: regenerate vfs.js`
  (`fdd27696`) to the branch. Pushes made with `GITHUB_TOKEN` do NOT
  trigger new workflow runs, so no CI ever ran on that SHA (verified:
  0 runs for `fdd27696`); the fix push (PAT via git-push-api) triggers
  CI on the new head, and the waiter follows it via whole-SHA replace.
- `test-assert-deep.js` isolated: 50/54, exit 1, failing sub-tests exactly
  the triaged F2 set — no regression from this change.
- Repo tests: `NODE_OPTIONS=--experimental-vm-modules npx --no-install jest
  tests/assert*.test.js tests/export_surface_assert*.test.js` — 6 suites,
  87 tests, all pass.
- `node --check src/assert.js` clean; `prettier --check src/assert.js` clean
  (HEAD's copy was clean, so the check covers only this lane's hunks).
- No `// Flags:` header on `test-assert.js` or `test-assert-deep.js`, so
  no flagged-test handling was needed.
- All `zz-*.js` probes deleted after use.

## Notes / limits

- `__formatMessage` ceiling (see `ponytail:` comment in code): default
  inspect options (no `numericSeparator`); `%s` of a Proxy may trip
  `toString` traps where Node avoids them via internals. Upgrade path:
  share the `src/util.js` implementation if the shims ever gain a shared
  internal module.
- `CallTracker` removal and other export-diff cleanups are NOT in this PR
  (triage: cleanup pass, not flips).
- `test-assert-typedarray-deepequal.js` needs >30 s under the shim even
  isolated (~31 s quiet, more under load); the baseline runner's 30 s
  phase-2 cap records it as a timeout on loaded runs. Not a code issue.
