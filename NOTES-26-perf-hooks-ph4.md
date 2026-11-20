# NOTES — Node 26 Wave 1, lane L-PH4: ResourceTiming 26 attributes (F6)

Base SHA `d587825d` (PR #506 triage merged). Branch
`fix/26w1-perfhooks-ph4`.

## Recovery (2026-11-19, runtime-restart drain)

Original worker committed `a2c99fe0` locally and was killed before push.
Recovery worker verified the commit first: `git show --stat` = exactly
`NOTES-26-perf-hooks-ph4.md` + `src/perf_hooks.js` (+60/−3) +
`tests/perf_hooks.test.js` (+8/−0); diff matches lane scope L-PH4 only,
no stray files; worktree clean apart from the `node_modules` symlink.

- Fetch + rebase onto current origin/main `bb6905b5` (buffer #512,
  module #508, vm #509 over the `1a1b89a2` dns base): **clean, no
  conflicts**; new head `4ab3e525`. The rebase diff vs `a2c99fe0` is
  exactly those three merged lanes (dist 1-line bumps + src/buffer.js,
  src/module.js, src/vm.js + their notes/tests) — no PH4 content change.
- Re-run differential on the rebased head
  (`run-baseline.mjs --modules perf_hooks --jobs 2`,
  out `/tmp/ph4/node26-perfhooks-ph4-rebased.jsonc`,
  csv `/tmp/ph4/csv-ph4-rebased/node26-baseline-perf_hooks.csv`):
  **19/31 pass, 12 fail, 0 timeout**. Per-test diff vs baseline =
  exactly the 2 flips (`resourcetiming-attributes`, `resourcetiming`);
  all 17 guards still pass; regressions = 0. New count confirmed
  17 + 2 − 0 = **19/31**.
- Isolated 2x per flip on the rebased head (26 test + 26 `common` +
  `fixtures` staged, `PARITY_TARGET=perf_hooks`, restored after;
  `parity/node-test/` verified clean, 7560 staged-only files removed):
  attributes exit 0, 0; resourcetiming exit 0, 0.
- `// Flags:` audit: neither flip test has a flags header (checked).
  The 5 flagged tests in the suite were run directly WITH their flags
  (`--expose-internals --no-warnings [--allow-natives-syntax]`):
  histogram-analysis exit 0, monitor-event-loop-delay-fast-calls exit 0,
  histogram-fast-calls / histogram-stats / sliding-window-histogram-
  fast-calls exit 1 — identical to the flag-less differential and to
  baseline, so flags change no verdict.
- Repo suite on rebased head: 39/40 (same single pre-existing failure
  as before, "exports match Node v24.20.0").
- CI: code SHA `caa68880` run 44647759998 completed **success**. CI's
  dist-regen bot then pushed `6b3a023f` ("chore: regenerate vfs.js",
  `dist/perf_hooks.js` + `dist/vfs.js` only); no workflow run ever
  started for it (0 check-runs after 30+ min). Not the usual
  GITHUB_TOKEN-push suppression: a sibling bot regen (`ccaca43a`,
  fix/26w1-https-tab) got its pull_request run 9 s after its push, so
  this head's event was lost. Retrigger: this notes-only commit,
  re-pinning the waiter to the new head.
- Retrigger 2: the minimal-API push (`96f561fa`, PATCH ref on top of the
  bot regen) ALSO started no run after 8+ min — while both pushes made
  via `git-push-api.py` on this branch (original `6bd6172a`, rebase
  `caa68880`) got their runs within ~1 min. Re-retriggering through
  `git-push-api.py` (this commit).
- Rebase 2 + dirty PR (2026-11-20 ~01:30 UTC): PR showed
  `mergeable: False / dirty` and the last three heads (`6b3a023f`,
  `96f561fa`, `463adb40`) started no runs. Root cause of dirty: main had
  moved on (https #515, crypto #514, assert #516, head `0f30d17c`), each
  squash-merge regenerating `dist/*`; the bot regen computed against
  `bb6905b5` now conflicts with main's newer `dist/vfs.js`. Fix: clean
  rebase onto `0f30d17c` (no conflicts; local tree never carried the
  stale regen), differential re-run on the rebased head:
  `/tmp/ph4/node26-perfhooks-ph4-rebased2.jsonc` → **19/31, 12 fail,
  0 timeout**, flip set vs baseline exactly the 2 targets, code
  byte-identical to `ac5b60a9`. Rebased head is 3 commits (code + 2
  notes, this paragraph amended into the top one); force-push
  re-triggers CI, which regenerates dist against the new base.
- Green on the rebased head: replay-push (`/tmp/ph4/replay-push.py`,
  small base_tree posts + `force:true` ref update — `git-push-api.py`
  kept dying on its big recursive tree POST) landed remote head
  `4e4549a9`; run 44655121224 **completed success** (build + parity
  jobs both success). CI then pushed bot regen `44382c02`
  (`dist/perf_hooks.js` + `dist/vfs.js` only); its run 44655448996 is
  `action_required` with **0 jobs** — the GITHUB_TOKEN loop-prevention
  non-run, not a test result. Precedent checked: the https-tab bot
  regen run 44646359472 ("failure") also had 0 jobs. Bot-regen runs
  never execute here, so the merge gate is the code SHA's green.
  Convergence: this notes-only retrigger (head now green-verified code
  + current dist, so the next run regenerates identical dist and pushes
  nothing) → merge on the new head's green. NOTE: this paragraph was
  written before the push method was settled — the commit goes on top
  of the remote bot-regen head `44382c02` via the minimal API push
  (small base_tree post + `force:true` ref update, the combination that
  triggered runs), NOT as a rebase that would drop the regen.

## Score

- Banked (baseline on main, `parity/drift/node26-baseline.jsonc`):
  perf_hooks **17/31** (14 fail, 0 timeout).
- Pre-fix re-run in this worktree (run-baseline.mjs, `--modules perf_hooks`,
  `--jobs 2`): **17/31**, fail set identical to baseline.
- Post-fix run 1: **18/31 pass, 12 fail, 1 timeout** — the timeout is
  `test-perf-hooks-histogram-qrde-worker.js` (exit 124, a baseline pass
  unrelated to this lane: it touches no ResourceTiming code). Isolated
  re-run of that test: **exit 0** (~28 s wall — the test itself is slow,
  and 7 tests hit the 10 s phase-1 cap in that run vs 1 pre-fix, i.e.
  transient VM load; phase 2's 30 s cap was not enough under 2-job
  parallel load). Load artefact, not a regression.
- Post-fix run 2: **19/31 pass, 12 fail, 0 timeout** — both flips pass,
  all 17 guards pass, `histogram-qrde-worker.js` passes (run-1 timeout
  confirmed load artefact).
- New count = 17 + 2 flips − 0 regressions = **19/31**.

## Flips (2, each verified 2x isolated + 2x full-module)

1. `test-perf-hooks-resourcetiming-attributes.js` — was exit 1
   (`undefined !== 0` for `finalResponseHeadersStart`); now exit 0.
   Isolated baseline-exact runs (26 test + 26 `common` staged, then
   restored): exit 0, exit 0. Full-module runs: pass, pass.
2. `test-perf-hooks-resourcetiming.js` — was exit 1 (deep-equal diff:
   actual lacked `contentEncoding` etc.); now exit 0. Same 2x isolated
   (exit 0, exit 0) + 2x full-module.

## Guard

Full 26-suite pass set held in both post-fix runs: all 17 baseline
passes still pass (eventlooputilization, histogram-analysis,
histogram-qrde-oracle/worker/qrde, histogram, monitor-event-loop-delay-
fast-calls, timerify-basic/constructor/error/histogram-async/
histogram-sync/invalid-args/multiple-wrapping/return-value, usertiming,
worker-timeorigin). The other 12 baseline failures are untouched
(F1–F5, F7 lanes) — in particular `test-perf-hooks-resourcetiming-fetch.mjs`
still fails (L-PH5, spike-conditional, not this lane).

## Change (one shim file + one repo-test expectation)

`src/perf_hooks.js` (+60/−3) — mirror of Node 26
`lib/internal/perf/resource_timing.js`:

- `kBodyInfo` symbol (`:108`); `createPerformanceResourceTiming` stores the
  `body` argument on it, and `markResourceTiming` (`:1801`) now passes
  `body` through instead of dropping it (contentType/contentEncoding source).
- 5 getters on `PerformanceResourceTiming`:
  - `finalResponseHeadersStart` ← `finalNetworkResponseStartTime ?? 0`
  - `firstInterimResponseStart` ← `firstInterimNetworkResponseStartTime ?? 0`
  - `responseStart` ← `firstInterimNetworkResponseStartTime ||
    finalNetworkResponseStartTime` (non-zero interim wins)
  - `renderBlockingStatus` ← `renderBlocking === true ? 'blocking' :
    'non-blocking'`
  - `contentType` / `contentEncoding` ← `kBodyInfo?.<field> ?? ''`
- `toJSON` + `[kInspect]` gain the 5 keys in Node's order (final/first
  after `requestStart`; renderBlocking/contentType/contentEncoding at the
  end) — the 26 test asserts both the deep-equal `toJSON` and the exact
  `util.inspect` strings.
- All 5 getters made enumerable via `makeMethodsEnumerable`
  (class getters are non-enumerable by default); brand checks come from
  the existing `validateThisInternalField(this, kTimingInfo, …)` → throws
  `ERR_INVALID_THIS` on a bare `{}` (test asserts this per getter).
- No other `markResourceTiming` callers exist in `src/`; the `Performance`
  facade exposes the function unwrapped, so no facade change was needed.

`tests/perf_hooks.test.js` — the repo test "toJSON key order matches Node"
pinned the v24 key order; updated to the Node 26 order (same root cause:
26 adds the 5 keys). Repo suite: 39/40 before and after this lane; the
single remaining failure ("exports match Node v24.20.0") fails identically
on unmodified main (verified via `git stash`: 39/40, same test) — host
v24.22.1 surface artefact, documented in triage §F1, not this lane.

## Non-goals (explicitly not touched)

- L-PH5 fetch resource timing (`resourcetiming-fetch.mjs` still fails).
- L-PH1–L-PH3 (Wave 2: histograms, record(0), ELD options).
- No `// Flags:` headers on either flip test (checked) — run-baseline's
  no-flags invocation is verdict-faithful here.
- No docs-number changes; no shared files touched.

## Verification log

- `node --check src/perf_hooks.js` — OK.
- Pre-fix baseline: `node parity/drift/run-baseline.mjs --node26-src
  ~/workspace/local/node-26-src --worktree <this> --out /tmp/ph4-pre.jsonc
  --csv-dir /tmp/ph4-pre-csv --jobs 2 --modules perf_hooks` → 17/31.
- Isolated 2x per flip (staged 26 tests + 26 `common`, restored after;
  `parity/node-test/` verified clean, only `src/perf_hooks.js` modified):
  attributes exit 0, 0; resourcetiming exit 0, 0; logs empty, no errors.
- Post-fix full-module run 1 → `/tmp/ph4-post1.jsonc`: 18/31 pass, 12 fail,
  1 timeout (`histogram-qrde-worker.js`, exit 124; isolated re-run exit 0 —
  slow test + transient load, §Score).
- Post-fix full-module run 2 → `/tmp/ph4-post2.jsonc`: 19/31 pass, 12 fail,
  0 timeout. Fail set = the 12 non-lane baseline failures (fetch included);
  flip set vs baseline = exactly the 2 targets; regressions = none.
- Repo suite: `NODE_OPTIONS=--experimental-vm-modules npx --no-install
  jest tests/perf_hooks.test.js` → 39/40 (1 pre-existing failure, above).

## Ship

- PR: #510
- Merge SHA: `70a70a2e60991e4a4a22cd702c4999cccde15a9c` (squash-merge of PR #510)
- Final count: **perf_hooks 19/31** (17 banked + 2 flips, 0 regressions)
