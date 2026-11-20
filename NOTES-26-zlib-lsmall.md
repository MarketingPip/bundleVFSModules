# NOTES-26-zlib-lsmall — L-SMALL (Node 26 Wave 1)

Base: origin/main `d587825d` (PR #506 triage merged). Branch:
`fix/26w1-zlib-lsmall`. Scope: NOTES-26-triage-zlib.md §F5 + §L-SMALL only —
three one-line-class fixes in `src/zlib.js`, no other files. L-ZIP, L-RESET,
and F4 untouched.

## Result

**3/3 flips, verified 2x each** (two full 89-test `run-baseline.mjs` sweeps
plus 2x direct probes). New count: **48 + 3 = 51/89** on the Node 26 suite.
Zero regressions in either sweep. Repo jest: `tests/zlib.test.js`,
`tests/zlib-native-compat.test.js`, `tests/export_surface_zlib.test.js` —
3 suites, 40/40 pass.

None of the three tests carries a `// Flags:` header, so all runs are the
plain harness invocation (`PARITY_TARGET=zlib node --import
parity/preload.mjs <test>`).

| test | first failure (before) | fix |
|---|---|---|
| `test-zlib-zstd-dictionary.js` | `:51` `Missing expected exception (TypeError)` — `createZstdCompress({dictionary: null})` did not throw | `normalizeZstdDictionary` (`src/zlib.js:1426`): only `undefined` means "no dictionary"; `null` now falls through to the existing `ERR_INVALID_ARG_TYPE` throw, matching `normalizeZlibOptions` and native (throws for all six values in the test loop) |
| `test-zlib-zstd-pledged-src-size.js` | `:156` deep-equal `Buffer(2) [195, 169]` vs `Buffer(1) [233]` — async `zstdCompress('é', {defaultEncoding:'latin1'})` encoded as UTF-8 | `normalizeBufferArgs` (`src/zlib.js:2946`): async convenience methods now encode string input with `options.defaultEncoding` when it is a valid encoding (`Buffer.isEncoding` guard), matching native `zlibBuffer` → `stream.end(string)` → Writable `defaultEncoding` |
| `test-zlib-params.js` | `:46` `mustCall` callback never fires | destroy path + `params()` error forwarding (see Bisect below): `MiniTransform.destroy()` (`src/zlib.js:2127`) now fails pending `_wqueue` callbacks with `err ?? ERR_STREAM_DESTROYED` (microtask, like write-after-destroy); `ZlibBase.params()` (`src/zlib.js:2682`) now mirrors native `paramsAfterFlushCallback` (`lib/zlib.js:738`) and forwards the flush error instead of calling back clean |

## Bisect — test-zlib-params.js (triage correction, read this first)

Triage (§F5) said the test is "byte-identical to the v24 vendored file modulo
quotes" and the failure is "either a shim regression since the 52/65
verification or node-26 `common/` drift". **Both halves are wrong; the
mechanism is now proven:**

1. **The Node 26 file is NOT the v24 file.** Vendored v24:
   `parity/node-test/parallel/test-zlib-params.js` is 40 lines and has no
   destroy block. Node 26 (`~/workspace/local/node-26-src/test/parallel/
   test-zlib-params.js`) is 50 lines — it **adds lines 41–50**, the
   `{ createDeflate(); write('x'); params(9, …, mustCall(ERR_STREAM_DESTROYED));
   destroy(); }` block. Normalized diff confirms the 10-line addition.
2. **No shim regression.** `git diff d8bba974..d587825d -- src/zlib.js` is
   empty — the shim is byte-identical between the 52/65 close (#468) and this
   base. The only `parity/` change in range is `parity/preload.mjs`
   (module-parent null fix + worker_threads register gate), neither of which
   can affect zlib write/destroy timing.
3. **The v24 test still passes on the current shim + harness.**
   `PARITY_TARGET=zlib node --import parity/preload.mjs
   parity/node-test/parallel/test-zlib-params.js` exits 0, and the wave-end
   sweep CSV (`goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/
   fast-sweep/zlib-sweep-2026-11-18-wave-end.csv:43`) records
   `test-zlib-params.js,0`. The 52/65 close's remaining-13 list does not
   contain this test.
4. **No `common/` drift.** `fixtures/person.jpg` is byte-identical between
   trees (md5 `25abf31dd780fbf5ef60e50809103bfd`); the failure is the new
   block, not `mustCall` semantics.

**Verdict: new assertion block in the Node 26 test exercising
destroy-during-pending-flush behaviour the shim never implemented — not a
regression, not common drift.** The fix is in the **destroy path** (plus the
`params()` error-forwarding that the destroyed branch needs to be useful):

- Trace: `write('x')` queues a chunk; `params(9, …)` takes the flush path
  (`PakoDeflateEngine.setParams` exists, level −1 → 9) and `flush()` queues
  the flush-buffer write with the params callback; `destroy()` runs before
  the pump microtask and `MiniTransform.destroy()` did `this._wqueue = []`,
  silently dropping the queued flush callback. The `params()` destroyed
  branch was unreachable — the flush callback itself was the stranded write
  callback — and even if reached it called back with no error.
- Native: pending write callbacks on destroy get
  `state.errored ?? ERR_STREAM_DESTROYED('write')`
  (`lib/internal/streams/writable.js:772`); `paramsAfterFlushCallback`
  forwards that error (`lib/zlib.js:738-741`). Oracle probe on
  `~/workspace/local/node-26/bin/node` confirms the callback fires with
  `err.code === 'ERR_STREAM_DESTROYED'`.

## Fix 2 correction (sync latin1)

Triage said "the sync path handles latin1 correctly". **It does not, and
neither does native.** Probe (2x): shim `zstdCompressSync('é',
{defaultEncoding:'latin1'})` decompresses to `[195, 169]`, and native
`lib/zlib.js:181-183` (`zlibBufferSync`) does `Buffer.from(buffer)` — UTF-8,
no encoding. The test never asserts sync latin1 (`:135/:142` compare
async-vs-sync for `utf8`/`utf-8` only; `:156` is async-only). The fix is
therefore **async-only by design**, matching native exactly. Sync behaviour
is unchanged on purpose.

## Guard — full 26-suite zlib pass set

Guard is the full 89-test suite from `parity/drift/node26-baseline.jsonc`
(48 pass / 40 fail / 1 timeout), not the flip list. Two full
`run-baseline.mjs --modules zlib --jobs 2` sweeps on the branch:

- Run 1: **50/89** (37 fail, 2 timeout). Flips: all 3 pass. No hard
  regressions. `test-zlib-zstd.js` pass → timeout.
- Run 2: **51/89** (37 fail, 1 timeout). Flips: all 3 pass. **Zero
  regressions.** Only timeout is the baseline `test-zlib-brotli-16GB.js`.

`test-zlib-zstd.js` run-1 timeout is a **load artifact, not a regression**
(proven, not assumed): the test loops 22× `zstdCompressSync` of
`pss-vectors.json` at levels 1–22 and touches none of the changed paths (no
`destroy()`, no string input, no `dictionary`). Isolated with the Node 26
test + common + fixture staged: **exit 0 in 23.5 s** wall (1.8 s user) with
the fix, **exit 0 in 21.6 s** with the fix stashed (baseline `src/zlib.js`) —
same behaviour, ~23 s test against a 30 s phase-2 cap under parallel load.
It passes in run 2.

## Recovery + rebase (2026-11-19, recovery worker)

Original commit `e1401ca0` (base `d587825d`) survived a runtime restart drain
unpushed. Recovery verified the commit in full first: `git show --stat` +
full diff — scope clean (`src/zlib.js` +48/−6, `NOTES-26-zlib-lsmall.md`
only, no stray files, worktree clean apart from the `node_modules` symlink).

Rebased onto current origin/main `bb6905b5` (dns #?/L1, vm #509, module
#508, buffer #512 — 4 merges past the triage base). Rebase clean, zero
conflicts; new head `3960d22c`. `git diff d587825d..3960d22c` confirms
`src/zlib.js` is the only lane file changed (main's merges touch
`src/{buffer,dns,module,vm}.js` + `dist/*` only, no `src/zlib.js` overlap).

Re-verified on the rebased head (fresh out/CSV dirs):

- Full differential `run-baseline.mjs --modules zlib --jobs 2`, **2x**:
  run 1 + run 2 both **51/89** (37 fail, 1 timeout), CSVs byte-identical.
  New passes vs the banked 48-pass baseline are exactly the 3 flips;
  **zero regressions** in either run. Only timeout is the baseline
  `test-zlib-brotli-16GB.js` (also the baseline's sole timeout).

**Correction — branch WAS pushed, PR exists:** the recovery brief said
"NOT pushed, no PR" — wrong. `git ls-remote` showed
`refs/heads/fix/26w1-zlib-lsmall` at `1a8d1d21`: `ca905085` is
byte-identical to the original `e1401ca0` (`git diff` empty), and
`1a8d1d21` is a `github-actions[bot]` `chore: regenerate vfs.js` commit
(`dist/vfs.js` + `dist/zlib.js`, 2 lines each) on top. **PR #511 is open**
("fix(zlib): dictionary null, async latin1, params-after-destroy", not
draft, head `1a8d1d21`, base `main`). No new PR is created; this recovery
force-pushes the rebased branch to the same PR and lets CI regen dist.

**Second rebase (main moved again):** origin/main advanced `bb6905b5` →
`cac4c22d` (https #515, `src/https.js` + `src/internals/tls-verify.js` +
`dist/*`, no zlib overlap). Rebased clean, zero conflicts; new head
`d8da2d08`. `git diff cac4c22d..d8da2d08` is the lane commit only
(`src/zlib.js` + this file). Re-verified on the `cac4c22d` head:

- Full differential, **1x more** (`/tmp/zlib-lsmall-rebased-3`): **51/89**
  (37 fail, 1 timeout), CSV byte-identical to runs 1–2, zero regressions,
  only baseline timeout `test-zlib-brotli-16GB.js`.
- Each flip **2x isolated** on this head (same staging method): all exit 0
  both runs. Repo jest not re-run on this head — the only delta vs the
  `bb6905b5` head is the https merge, which touches no zlib path; jest
  40/40 stands from the `bb6905b5` head.

**Third rebase (main moved twice more — the mergeable fix):** origin/main
advanced `cac4c22d` → `0f30d17c` (#516 assert) → `9c0edeea` (#519 http).
PR #511 went `mergeable: False`, `mergeable_state: dirty`, which is why
no Build VFS run fired for any push after the code push (see Force
finding, corrected above). Rebased clean onto `9c0edeea` except the bot
regen commit `31155e90`, which conflicted on `dist/vfs.js` — skipped it
per the dist rule (take main's dist, CI regens); the empty retrigger
commit survived the rebase as a no-op. New head `06be293e` (after amending
in this section). `git diff 9c0edeea..HEAD` is the lane commit only
(`src/zlib.js` + this file); `src/zlib.js` byte-identical to `a3d27e0d`.
Re-verified on the `9c0edeea` head:

- Full differential, **1x more** (`/tmp/zlib-lsmall-rebased-4`): **51/89**
  (37 fail, 1 timeout), zero regressions, new passes exactly the 3 flips,
  only baseline timeout `test-zlib-brotli-16GB.js`. (The `/tmp` sweep
  CSVs from runs 1–3 were lost in a runtime restart that wiped `/tmp`;
  the counts and fail/timeout sets match run for run.)
- Each flip **2x isolated** on this head: all exit 0 both runs.
- Repo jest on this head: **40/40 pass**.

**Fourth rebase — merge blocked by new main (2026-11-20 ~02:24 UTC):**
the steer from the events lane (PR #517, merged `de79b5b2`) confirmed:
fast-forward API pushes trigger NO `pull_request` runs (proven on events
`4ef2b726`, 0 runs in 30+ min); FORCE-PUSH DOES trigger CI (confirmed
2×); a bot regen head's run goes `action_required` with 0 jobs and can
never go green — merge on the code SHA's green run when the head differs
by dist-only, do not wait out a regen head. I followed it: code SHA
`244da5b2` green (run #44658883294) + head `751ad045` differing by
dist+notes only — but the merge itself failed `405 "Pull Request has
merge conflicts"`: main had moved to `de79b5b2` (events #517) while I
waited, and the PR was dirty again. Rebased onto `de79b5b2`, skipping the
bot regen commit again (`dist/vfs.js` conflict, main's dist kept). New
head below; this branch is now **dist-clean** (`git diff de79b5b2..HEAD`
is `src/zlib.js` + this file only), so future main moves should not dirty
it on dist. `src/zlib.js` byte-identical to `244da5b2`. Re-verified on
the `de79b5b2` head:

- Full differential, **1x more** (`/tmp/zlib-lsmall-rebased-5`): **51/89**
  (37 fail, 1 timeout), zero regressions, new passes exactly the 3 flips,
  only baseline timeout `test-zlib-brotli-16GB.js`.
- Each flip **2x isolated** on this head: all exit 0 both runs.
- Repo jest on this head: **40/40 pass**.
- Push plan (steer): single remote commit, parent `de79b5b2`, force:true
  ref update to trigger CI; merge on that code SHA's green run when the
  head differs by dist-only — do not wait out a regen head.

**Fifth rebase — the regen head itself went dirty (2026-11-20 ~02:40 UTC):**
the plan above worked halfway: code SHA `eebdf6b9` (parent `de79b5b2`)
got Build VFS run #44661506810 **completed success**, and the bot pushed
regen `338ca7f6` (dist-only, verified). But the PR was
`mergeable: False`, `dirty` again — main had moved to `6929cffe` (repl
#518) before the bot regened, so the bot's `dist/vfs.js` (regenerated
from the `de79b5b2` base) conflicts with main's `dist/vfs.js` (repl
regen). Local `git merge-tree 6929cffe 338ca7f6` confirms the ONLY
conflict is `dist/vfs.js`. Lesson: a regen head is mergeable only while
main stays at the code commit's base. Local regeneration is NOT the
escape: `node src/build-vfs.mjs` here took ~170 s, printed an esbuild
Go-stack panic trace, and wrote only `dist/zlib.js` (2 lines, differing
from the bot's build) — `dist/vfs.js` untouched. Reverted (`git checkout
-- dist/`); dist regeneration stays CI's job. The real fix is
rebase-onto-current-main + push dist-clean + merge promptly on the code
run before main moves again. Rebased onto `6929cffe` (clean, no
overlap — repl touches neither `src/zlib.js` nor this file). New head
below; `src/zlib.js` byte-identical to `eebdf6b9`. Re-verified on the
`6929cffe` head:

- Full differential, **1x more** (`/tmp/zlib-lsmall-rebased-6`): **51/89**
  (37 fail, 1 timeout), zero regressions, new passes exactly the 3 flips,
  only baseline timeout `test-zlib-brotli-16GB.js` (phase 2 re-ran 2
  files that hit the 10 s cap; both passed at 30 s).
- Each flip **2x isolated** on this head: all exit 0 both runs.
- Repo jest on this head: **40/40 pass**.
- Push plan: single remote commit, parent `6929cffe`, force:true ref
  update; merge on that code SHA's green run, promptly, before main
  moves again.
- Each flip **2x isolated** (Node 26 test files staged into
  `parity/node-test/parallel/`, absolute preload path —
  `PARITY_TARGET=zlib node --import $PWD/parity/preload.mjs …`): all exit 0
  both runs. Note: a relative `--import parity/preload.mjs` fails with
  `ERR_MODULE_NOT_FOUND: Cannot find package 'parity'` — the harness uses an
  absolute preload path; same for `npx jest` without
  `NODE_OPTIONS=--experimental-vm-modules` (ESM suite error, not a code
  failure). Worktree restored clean after staging (`git checkout --
  parity/node-test`).
- Repo jest: `tests/zlib.test.js`, `tests/zlib-native-compat.test.js`,
  `tests/export_surface_zlib.test.js` — **40/40 pass** on the rebased head.

**Final count: 48 + 3 = 51/89, 0 regressions, bisect confirmed** (see Bisect
below — new Node 26 assertion block, not a regression).

**CI retrigger (2026-11-20 ~01:31 UTC):** the bot's dist-regen head
`31155e90` started no Build VFS run in 11 min (bot GITHUB_TOKEN pushes
don't trigger it), and the empty retrigger commit `f7260b85` (same tree)
also started none — same finding as PR #510 (`c6c950c4`: "the minimal-API
retrigger push 96f561fa started no run"). This notes-only commit is the
real-change retrigger, same precedent. Code SHA `a3d27e0d` already has a
completed-success Build VFS run (#44651923275); this commit changes no
code, only this file.

**CI adjudication (2026-11-20 ~02:13 UTC):** the rebased code head
`244da5b2` got a `pull_request` Build VFS run (#44658883294) that
completed **success**. The bot regen head `f39ef526` got run #44659182663
with conclusion `action_required`, **0 jobs**, created and completed in
the same second, actor `github-actions[bot]` — a no-op artifact, not a
test failure (the bot's GITHUB_TOKEN push doesn't produce a real run;
same reason PR #515 needed a human retrigger commit). This notes-only
commit is that retrigger: the next run on a human-authored head is the
merge gate, per the #515 precedent. No code change.

**Force finding — CORRECTED (2026-11-20 ~02:00 UTC):** the notes-only
retrigger `96e087d1` ALSO started no run in 9 min — but the code push
`a3d27e0d` got a `pull_request` run in ~2 min. The first suspect was the
ref-update flag: `a3d27e0d`'s ref update used `force:true` (like
`git-push-api.py`, which always PATCHes with `force:true`); the two
retrigger ref updates used `force:false`. A same-SHA `force:true`
re-assert also started nothing (no value change, no event). **That
theory is now dead:** the next notes-only commit `22660a98`, pushed with
a `force:true` ref update to a NEW SHA, also started no run in 6 min.
**Real cause (proven by direct read):** PR #511 was `mergeable: False`,
`mergeable_state: dirty` — main had moved past the branch base
(`0f30d17c` #516, then `9c0edeea` #519) and the branch conflicted, so
GitHub creates no `pull_request` runs for it. The `a3d27e0d` run fired
while the branch was still mergeable (based on main HEAD at the time).
Other lanes' mergeable PRs got runs within minutes all evening. Fix:
rebase onto current main (`9c0edeea`), taking main's `dist/*` and letting
CI regen — the bot regen commit was skipped in the rebase for exactly
that conflict. If the rebased head still starts no run, the trigger is
flaky, not the flag.

## Diff

`src/zlib.js` only: +48/−6 across 4 hunks (dictionary null check,
`normalizeBufferArgs` encoding, `destroy()` pending-callback failure,
`params()` error forwarding). Each hunk carries a `ponytail:` comment naming
its ceiling and upgrade path. No shared files, no `dist/*`, no docs-number
changes.

## Ship

- PR: #511
- Merge SHA: `11d8db2d0500ebf004376e54c23f6cae44de7322` (squash-merge of PR #511)
- Final count: **zlib 51/89** (48 banked + 3 flips, 0 regressions)
