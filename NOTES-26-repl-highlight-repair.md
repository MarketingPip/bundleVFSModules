# NOTES — Node 26 Wave 3 REPL lane: highlight repair (1 flip)

- Base: `10bdfcaa` (origin/main). Node 26.13.1 verified
  (`~/workspace/local/node-26/bin/node --version` → `v26.13.1`).
  Harness host is v24.22.1. Branch: `fix/repl-26-highlight-repair`.
- Banked (coordinator-confirmed on live main, not recomputed): repl
  **99/108** (8 fail, 1 timeout), util **36/36**.
  New count = 99 + flips verified 2x on live main − regressions in the
  differential. Never computed from triage expectations.
- Method: Node 26 test tree staged into `parity/node-test/` (parallel +
  common + fixtures, as `parity/drift/run-baseline.mjs` stages it). Flip
  re-run isolated as
  `PARITY_TARGET=repl timeout 30 node --import <worktree>/parity/preload.mjs
  parity/node-test/parallel/<test>` (flagged test run directly WITH its
  flag; see § Flags). Full differential via
  `parity/drift/run-baseline.mjs --modules repl,util --jobs 2`.
  Tree restored afterwards by the runner
  (`restore: parity/node-test/ clean`); `zz-*.js` probes deleted after use.

## Flip (1, isolated [0,0] x2 with flag AND [0,0] x2 without)

### `test-repl-highlight.js` [0,0] x2 (`--expose-internals`) + [0,0] x2 (no flag)

- Root cause (proven by one-step bisection in Wave 2, re-confirmed here):
  the test passes exit 0 on `067a8700` and fails exit 1 on live main —
  Wave 1 util #513 U3 set `inspect.styles.regexp = highlightRegExp` (a
  FUNCTION, `src/util.js:1100`) and the repl-highlight port's local
  `stylizeWithColor` (`src/internals/repl-highlight.js:30-37`) assumed
  style values are color-name strings — `inspect.colors[function]` is
  `undefined`, so `highlight('/regexp/u')` returned unstylized and
  test:35 (`assert.notStrictEqual(highlight(source), source)` for
  `'/regexp/u'`) failed.
- Base failure re-confirmed on pristine `10bdfcaa` in this worktree,
  both with and without `--expose-internals`: exit 1,
  `AssertionError [ERR_ASSERTION]: Expected "actual" to be strictly
  unequal to: '/regexp/u'` at test:35.
- Fix (oracle fix from Wave 2, re-applied — it was written, verified,
  then REVERTED out of PR #526 so this lane could land it; it applied
  cleanly to the same function): mirror Node 26
  `lib/internal/util/inspect.js:850-862` in the port's local
  `stylizeWithColor` — if `inspect.colors[style]` is `undefined` AND
  `typeof style === 'function'`, return `style(str)`.
  `src/util.js` NOT touched.
- Oracle check (Node 26 binary, `--expose-internals`,
  `require('internal/repl/highlight')`, re-probed 2026-11-20):
  `highlight('/regexp/u')` =
  `"\u001b[32m/\u001b[39m\u001b[33mr\u001b[39m\u001b[33me\u001b[39m\u001b[33mg\u001b[39m\u001b[33me\u001b[39m\u001b[33mx\u001b[39m\u001b[33mp\u001b[39m\u001b[32m/\u001b[39m\u001b[31mu\u001b[39m"`;
  `highlight('const value = "text"')` =
  `"\u001b[36mconst\u001b[39m value = \u001b[32m\"text\"\u001b[39m"`.
  Probe `zz-highlight-oracle.js` (deleted after use) asserted the shim's
  `highlight()` byte-identical to both oracle strings plus
  `highlight('undefined')` and `highlight('')`: all pass, exit 0.
- With the fix: test passes isolated [0,0] x2 WITH `--expose-internals`
  and [0,0] x2 WITHOUT it (all exit 0).

## Flags

- `test-repl-highlight.js` declares `// Flags: --expose-internals`.
  `run-baseline.mjs` does NOT honor `// Flags:` headers — the sweep runs
  it flag-less (it passes flag-less too, verified 2x above, because the
  preload adapter intercepts `require('internal/repl/highlight')`
  before the flag matters). Flagged runs were done directly and are
  recorded here, per the W2 lane's caution.

## Guards held

- Full differential post-fix
  (`parity/drift/w3-repl-highlight/baseline.jsonc`,
  CSVs in `parity/drift/w3-repl-highlight/csv/`):
  **repl 99/108 pass, 8 fail, 1 timeout (flag-less)**;
  **util 36/36 pass, 0 fail, 0 timeout**. No regressions.
- Repl flag-less 99 = banked flag-less 97 + highlight flip +
  `test-repl-history-navigation.js` passing in this sweep (known load
  flake per W2: fails in sweeps, passes isolated — this sweep it landed
  on its passing side; not a regression, not counted as a flip).
- Flag-aware count: 99 flag-less +
  `test-repl-reverse-search.js` (passes [0,0] x2 WITH `--expose-internals`
  post-fix, re-verified isolated in this worktree; flag-less failure is
  a `// Flags:` artifact of the runner) = **100/108**.
  New count vs banked: **99 → 100** (1 flip, 0 regressions).
- Repl non-pass set post-fix (unchanged from banked minus highlight):
  `test-repl-envvars.js` (124 timeout, NO-FIX per triage),
  `test-repl-history-init-fail-leak.js` (L3),
  `test-repl-mode.js`, `test-repl-tab-complete-import.js`,
  `test-repl-tab-complete-require.js` (R5-gate-blocked family A, PARKED),
  `test-repl-preview.js` (NO-FIX), `test-repl-tab-complete-nested-repls.js`
  (host artifact), `test-repl-user-error-handler.js` (0 flips),
  `test-repl-reverse-search.js` (flag-less only; passes with flag).
- Repo tests:
  `NODE_OPTIONS=--experimental-vm-modules npx --no-install jest
  tests/repl.test.js tests/export_surface_repl.test.js
  tests/export_surface_util.test.js` — 3/3 pass;
  `tests/export_surface_util_types.test.js
  tests/util-inspect-duplicates.test.js tests/util-inspect-grouping.test.js
  tests/util_named_exports.test.js` — 25/25 pass.
  (Bare `npx jest tests/export_surface_util.test.js` without the
  NODE_OPTIONS fails identically at base — pre-existing ESM-loading
  invocation issue, not a regression; AGENTS.md prescribes the
  NODE_OPTIONS form for assert suites.)
- `node --check src/internals/repl-highlight.js` clean.

## Ceilings (ponytail, also in code comments)

- A style that is neither a known color name nor a function still falls
  through unstylized, matching Node. If a future util style becomes an
  object (e.g. a `{open,close}` pair), the matching case belongs here in
  the port, not in `src/util.js`.
- `src/internals/repl-highlight.js` has NO dist representation: no file
  in src/ imports it (the browser repl never loads
  `internal/repl/highlight`; the fix is exercised via the parity
  harness preload redirect only). Nothing to regenerate for it.
- The shim's REPLServer still does not wire highlight in as its readline
  `colorize` (pre-existing ceiling, see the file header).

## Files changed

- `src/internals/repl-highlight.js` — function-style branch in
  `stylizeWithColor` only (shortest diff; `src/util.js` untouched).
- `NOTES-26-repl-highlight-repair.md` (this file).
- NOT committed: `parity/drift/w3-repl-highlight/` (differential scratch:
  `baseline.jsonc` + `csv/node26-baseline-{repl,util}.csv`).

## Ship

- PR: (fill on open)
- Merge SHA: (fill on merge)
