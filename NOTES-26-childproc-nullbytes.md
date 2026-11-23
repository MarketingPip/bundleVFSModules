# NOTES-26-childproc-nullbytes — lane L-C (child_process validation order)

Take-back TAKE 2 from `shim-salvage-check.md`: `execSync` called `spawnSyncCore`
directly, so `getShell()` threw plain `Error "no shell configured"` before any
argument validation. Node's `execSync` routes via `spawnSync` →
`normalizeSpawnArguments`, which validates cwd/argv0/shell/env first (TypeError
`ERR_INVALID_ARG_VALUE`).

## Ship

- PR: https://github.com/MarketingPip/bundleVFSModules/pull/552
- Merge SHA (full): 013048f9b5a9e5d6be74d388d2d4fb47286802b3 (squash-merge,
  `merged: true` by direct read, state closed; merge SHA verified ancestor of
  `origin/main`, which now sits at 013048f9)
- Base: `origin/main` 51ada62d (#550) at lane start
- Branch: `takeback-childproc-nullbytes` (deleted after merge, remote ref gone)
- CI line: Parity job `Parity (Node official tests)` completed/success on code
  SHA 8a78c887b2ff4a3fef718178269c78b302e15d93 (round 2, after rebase); build job
  completed/success on the same SHA. New-head (dist-regen) check-runs total 0,
  exactly the brief's predicted state — merge criterion was the CODE run green.
- Flip facts (v24 yardstick only; no node26 child_process entry exists):
  banked 6/112 (measured-rates.json, 2026-10-11, re-confirmed live on 51ada62d:
  fresh base sweep 6 pass / 109 .js + 3 .mjs all failing) → 7/112.
  Flips verified 2x: `test-child-process-reject-null-bytes.js` (isolated 2x
  exit 0 on branch; 1 1 at base, aborting at line 150 with the shell error).
  Regressions: 0 (branch differential toward-pass=1, regressions=0,
  mode-changes=0). New count = 6 + 1 − 0 = 7/112.
- No docs-number changes in this PR (per brief; measured-rates.json untouched).

## Fix (1 file, +11/−1)

- `src/child_process.js` — `execSync` now runs the existing
  `normalizeSpawnArguments(command, [], norm.options)` before `spawnSyncCore`
  and passes the validated options on (reuse, no second validator).
  `spawnSync`/`fork` untouched (already validate). Added literal
  `MIT License.` line to the header (attribution was present, literal text
  was not). No root LICENSE file, no package.json license field (Jared's call).
- `ponytail:` comment in `execSync` names the ceiling: timeout/maxBuffer/
  killSignal/signal are still validated only on the `spawnSync` path — if a
  test ever needs them in `execSync`, route it through `spawnSync` instead.

## Verification (all on the branch)

- Target test isolated 2x: exit 0, 0 (PARITY_TARGET=child_process, absolute
  preload path). Also re-verified 2x after the rebase onto 770d8a2e.
- Negative probe through the parity harness (shim lane, not native): valid
  `execSync`/`spawnSync`/`execFileSync` still throw plain Error
  "no shell configured"; null-byte cwd/argv0/shell/env throw TypeError
  `ERR_INVALID_ARG_VALUE`. (Direct `import` of src/child_process.js under
  plain node hits the file's native bridge and tests real Node, not the shim
  — the harness defines `_RUNTIME_` first, which disables the bridge.)
- Full differential: fast sweep, 109 .js + 3 .mjs isolated; base 6, branch 7.
- Repo jest: `tests/child_process.test.js` +
  `tests/export_surface_child_process.test.js` 95/95 green; footprint
  `tests/ondemand-require.test.js` 29/29 green.
- Oracle first: real Node 26.13.1 and host Node 24.22.1 both throw TypeError
  `ERR_INVALID_ARG_VALUE` for null-byte cwd/argv0/shell in `execSync`; Node 26
  source confirms `execSync` → `spawnSync` → `normalizeSpawnArguments`.

## Method deviations (disclosed)

- `fast-sweep.py --target child_process` cannot work as written: the script
  passes `--target` verbatim as both the filename glob (`test-<target>-*.js`,
  needs hyphen `child-process`) and `PARITY_TARGET` (the harness exact-matches
  `child_process`). Ran a `/tmp` copy with a one-line fix
  (`PARITY_TARGET=target.replace("-", "_")`) — same runner, same CSV format,
  same 10s/30s phases; the shared script was NOT modified. CSVs:
  `hidden_files/fast-sweep/childproc-lc-base-2026-11-23.csv` and
  `childproc-lc-branch-2026-11-23.csv`. The .mjs files (3) fall outside the
  fast-sweep glob and were checked isolated on base (1 1 1) and branch (1 1 1).
- Main moved mid-lane: PR #551 (zlib) merged as 770d8a2e while CI ran; the
  first merge attempt failed 405 (mergeable False — dist/vfs.js conflict with
  #551's regen). Rebasing the single src-only commit onto 770d8a2e applied
  cleanly (new local 84ceb10f); force-pushed after reviewing the divergence
  (remote was my code commit + the stale bot regen commit, both known), new
  remote code SHA 8a78c887. CI re-ran on the new SHA (Parity green, build
  green, fresh regen 95facb94, dist-only); merged on that.
- Round-1 waiter log: `lc-childproc-ci-waiter-552.log` (green on a7d3370d,
  superseded by the rebase). Round-2 log: `lc-childproc-ci-waiter-552-r2.log`
  (green on 8a78c887). Build-watch logs: `lc-childproc-build-watch-552*.log`.
- Worktrees `takeback-childproc-nullbytes` and `takeback-childproc-base`
  removed after merge; `git status` in the main checkout clean before/after.
  All `zz-*.js` probes deleted.
