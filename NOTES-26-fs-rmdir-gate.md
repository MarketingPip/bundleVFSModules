# NOTES-26-fs-rmdir-gate — gate the fs rmdir cluster behind TARGET_NODE (step 3)

Step 3 of the version-support strategy (`~/workspace/goals/
node-parity-sweep-bundlevfsmodules-runtime/hidden_files/
version-support-strategy.md` §5 step 3): one behaviour change, 7 files —
`rmdir(path, {recursive:true})` works + `DEP0147` under `TARGET_NODE=24`,
throws `ERR_INVALID_ARG_VALUE` under `26` (the Node 26 replacement file
`test-fs-rmdir-recursive-error.js` keeps passing). One PR, no
docs-number changes (measured-rates / HITLIST banking follows as a
separate docs sync after merge).

## Gate mechanism

`src/version-gate.js` / `src/version-table.js` already exist (step 1,
PR #558); this lane only flips the `fs-rmdir-recursive` table entry
`pending` → `gated` and adds the branch in `src/fs.js`:

- `isTarget24` (imported from `./version-gate.js`, same as net/util):
  the branch is source, reviewed, tested both ways — real code, not a
  fake (rule 7). Under 24 the tree is REALLY removed via the existing
  wrapped `fs.rm` / `fs.rmSync` machinery; the warning fires only on
  that path.
- `emitRecursiveRmdirWarning()` — mirrors `maybeWarnShakeDefault` in
  `src/crypto/hashes.js` (step-1 proven pattern): module-level warned
  flag (exactly one warning per process, matching Node 24's
  `emitRecursiveRmdirWarning` in lib/internal/fs/utils.js:867-882),
  `process.emitWarning(msg, {type:'DeprecationWarning', code:'DEP0147'})`
  in try/catch, `process.noDeprecation` honoured. Message byte-identical
  to Node 24's.
- `validateRmdirOptionsShim(options)` — Node 24
  lib/internal/fs/utils.js `validateRmdirOptions` (defaults retryDelay
  100, maxRetries 0, recursive false), same shape as the faithful port
  in `parity/internal-fs-utils-adapter.mjs` (strict object check —
  null/arrays throw; explicit `recursive: undefined` throws via the
  spread). Only on the 24 path.
- `rmdirRecursiveStat(ps)` — Node 24 `validateRmOptionsSync(..., force:
  false, expectDir=true)` lstat step: directory → stats; file/symlink
  → null (caller falls through to plain rmdir, which raises ENOTDIR —
  memfs agrees with real Node here, probed on 24.20.0 for files AND
  symlinks-to-directories); missing → lstat ENOENT (syscall 'lstat' via
  the sticky `_syscallOverride`, mirroring `checkRm`).
- Sync/async/promises: `fs.promises.rmdir` delegates to the callback
  form (`definePromise("rmdir")` in src/fs.js), so the callback gate
  covers all three forms. Async 24 order matches Node 24 lib/fs.js
  (callback/path validation first, then warn; option validation errors
  surface via the callback on the recursive path, sync throw on the
  plain path). Async 26 order unchanged (recursive error throws before
  makeCallback/path validation).
- `src/build-fs-only.mjs` gains the `TARGET_NODE` define (step-1 NOTES
  anticipated this: a lane gating fs must add it there too) —
  `src/build-vfs.mjs` already bakes it for full builds.

Residual divergences (noted, not hidden):

- Retry semantics (`maxRetries` / `retryDelay`) are validated but not
  executed: memfs `rm` ignores them, and no v24 test exercises
  retries. A busy/locked tree under 24 would not retry the way real
  Node does.
- Recursive-removal errors raised mid-walk carry the shim's `rm`
  syscall surface (enrichErr canonicalisation), where real Node's
  rimraf/binding path reports `rm`/`lstat` per step. Only codes are
  asserted by the 7 files (ENOENT/ENOTDIR), so this is unobserved
  there.

## The 7 files (set rows 20–26)

| # | File | Asserts under 24 |
|---|------|------------------|
| 1 | test-fs-rmdir-recursive.js | recursive rmdir works (async+sync+promises, incl. symlinks), DEP0147 once, ENOENT on re-remove, `validateRmdirOptions` exact shape (already ported in the internal/fs/utils adapter — passes on main today in isolation) |
| 2 | test-fs-rmdir-recursive-warns-not-found.js | async rmdir nonexistent + recursive → DEP0147 + callback (ENOENT) |
| 3 | test-fs-rmdir-recursive-warns-on-file.js | async rmdir on file + recursive → DEP0147 + callback (ENOTDIR) |
| 4 | test-fs-rmdir-recursive-sync-warns-not-found.js | rmdirSync nonexistent + recursive → DEP0147 + throws ENOENT |
| 5 | test-fs-rmdir-recursive-sync-warns-on-file.js | rmdirSync on file + recursive → DEP0147 + throws ENOTDIR |
| 6 | test-fs-rmdir-recursive-throws-not-found.js | sync/async/promises rmdir nonexistent + recursive → ENOENT (no expectWarning — warnings are tolerated there because common installs its handler only via expectWarning) |
| 7 | test-fs-rmdir-recursive-throws-on-file.js | sync/async/promises rmdir on file + recursive → ENOTDIR |
| — | test-fs-rmdir-recursive-error.js (Node 26 replacement) | recursive rmdir throws ERR_INVALID_ARG_VALUE on all three forms under 26 |

## Files (5)

- `src/fs.js` (the gate: import + DEP0147 emitter + option validator + lstat step + rmdir/rmdirSync branches)
- `src/version-table.js` (`fs-rmdir-recursive` pending → gated, PR ref)
- `src/build-fs-only.mjs` (TARGET_NODE define for the fs one-off rebuild)
- `NOTES-26-fs-rmdir-gate.md` (this file)

Not in this PR: `dist/` (CI bot regens), `parity/measured-rates.json`,
`parity/HITLIST.md` (docs sync follows separately), `parity/preload.mjs` /
`parity/run.mjs` (untouched).

## Verification

Base (banked, `parity/measured-rates.json` @ `0a6c9f19`, read from main
before starting): v24 fs **333/349**, node26 fs **365/385**; program
v24 **2,311/3,206**, node26 **2,373/2,814**.

Worktrees: branch `~/workspace/worktrees/gate-fs-rmdir` @ `0a6c9f19`;
base `~/workspace/worktrees/gate-fs-rmdir-base` @ `0a6c9f19`.
CSVs + drivers under `~/workspace/goals/
node-parity-sweep-bundlevfsmodules-runtime/hidden_files/gate-fs-rmdir/`.

### Baseline isolated (base worktree, pristine main)

- All 7 v24 files exit 1 under BOTH targets (24 and 26) —
  `base-isolated.log`. The gate does not exist yet, so target 24
  behaves as 26.
- Node 26 replacement `test-fs-rmdir-recursive-error.js` exits 0 under
  target 26 on base.

### Differentials

All sweeps `--jobs 2`, fresh CSVs, one driver at a time. Base worktree
pristine main `0a6c9f19`; branch worktree same tip + this gate.

**v24 fs** (`PARITY_TARGET_NODE=24`):

| leg | base | branch |
|-----|------|--------|
| `test-fs-*.js` (fast-sweep, 260) | 245/260 (`base-v24-fs.csv`) | 249/260 (`branch-v24-fs.csv`) |
| `test-fs-*.mjs` (sweep-mjs, 89) | 87/89 (`base-v24-fs-mjs.csv`) | 87/89 (`branch-v24-fs-mjs.csv`, byte-identical diff: none) |
| in-sweep total | 332/349 | 336/349 |
| effective (isolated-adjudicated, see below) | **333/349 = banked** | **340/349 = banked + 7** |

Per-file `.js` diff base→branch: exactly the 7 flips (1→0) + 4
apparent regressions (append-file, stat, realpath 0→1;
write-reuse-callback 0→124) + 1 artifact (readFile 124→0, base
timeout proven load — see Adjudications). `.mjs` diff: none.

**node26 fs** (Node 26 files + common + fixtures staged, default
target 26):

| leg | base | branch |
|-----|------|--------|
| exact n26 list (sweep-mjs, 385) | 348/385 in-sweep (`base-n26-fs.csv`: 19 fail + 18 timeout) | 342/385 in-sweep (`branch-n26-fs.csv`: 18 fail + 24 timeout + 1×137) |
| effective (isolated-adjudicated) | **365/385 = banked** (17 of the 18 timeouts pass 0,0 isolated; test-fs-glob.mjs fails 1,1 isolated — a genuine non-pass) | **365/385 = banked, zero regressions** (22 of the 25 branch timeouts pass 0,0 isolated; the 3 that fail 1,1 failed 1 on base too; test-fs-truncate.js passes 0,0 isolated on branch — its sweep 1 was a flake; effective fail sets identical, 20 files each) |

### Isolated flip verification (branch, 2×)

`iso-branch-verify.log`, 2026-11-25 01:44–01:46 UTC. All 7 files
under target 24: **0,0**. The Node 26 replacement
`test-fs-rmdir-recursive-error.js` on branch under target 26: **0**
(in the suite and isolated).

### Mutual-exclusivity checks

Same log: all 7 v24 files under target 26 on branch: **exit 1**
each. The Node 26 replacement under target 24 on branch: **exit 1**.
The gate selects exactly one side per target, both ways.

### Adjudications

- **Base v24 `test-fs-promises-file-handle-readFile.js` (124 in the
  base sweep):** isolated 2× on base, target 24: **0,0** — sweep load
  artifact, not a base fail. Base effective 332 + 1 = 333 = banked.
  (The banked 333 already counts the two known flakes
  test-fs-mkdir-mode-mask.js + test-fs-realpath.js as passes; both
  passed in the base sweep this time.)
- **Branch v24 apparent regressions (4):**
  test-fs-promises-file-handle-append-file.js,
  test-fs-promises-file-handle-stat.js, test-fs-realpath.js,
  test-fs-write-reuse-callback.js — isolated 2× on branch, target 24:
  **0,0 all four** (`iso-branch-verify.log`); isolated 2× on base,
  target 24: **0,0 all four** (`iso-base-regress.log`). Sweep flakes
  on both sides (shared-`.tmp.0` collision family), NOT branch
  regressions. Branch effective 336 + 4 = 340 = 333 + 7, exactly the
  7 flips.
- **Base n26 18 timeouts:** isolated 2× on base with n26 staging
  (`iso-n26-timeouts-base.log`): 17 pass **0,0**; only
  test-fs-glob.mjs fails **1,1** (genuine non-pass — it exits 1
  isolated, so the sweep 124 was slowness on top of a real fail).
  Base n26 effective 348 + 17 = 365 = banked.
- **Branch n26 diffs (all adjudicated, zero regressions):**
  in-sweep branch 342 vs base 348 (−6) is entirely timeout/OOM churn:
  the 17 base-timeouts that pass isolated also pass in the branch
  sweep; the branch sweep's 25 timeouts (24×124 + 1×137) adjudicate
  22× **0,0** isolated on branch (`iso-n26-branch-timeouts.log`),
  including test-fs-readfile.js (the 137 — the sweep session recorded
  oomKills:1, a load/OOM artifact, not a code effect: under target 26
  the rmdir wrappers take the unchanged `throwRmdirRecursive` path).
  The 3 that fail 1,1 isolated — test-fs-realpath-stale-stat-values.js
  (ENOENT stat on `.tmp.0/fifo`), test-fs-rmSync-special-char-
  additional-error.js (ENOENT chmod on `.tmp.0/速_dir`),
  test-fs-syncwritestream.js (EBADF spawn) — failed **1** on the base
  sweep too: genuine pre-existing fails, identical on both sides.
  test-fs-truncate.js (branch sweep 1, base sweep 0): **0,0** isolated
  on branch — flake, not a regression. Effective fail sets identical
  (20 files each side).
- **Interrupted adjudication run (runtime restart):** the first
  `iso-n26-branch-timeouts.sh` run was killed by a runtime restart
  after 5 files (all 0,0, kept in the log). The branch worktree was
  left mid-staging (679 paths in parity/node-test/); restored
  exactly via the script's restore steps (per-file git restore/rm +
  mv backups back) and verified clean (only the 3 src modifications
  + NOTES + node_modules symlink) before the full re-run. No
  user data involved — worktree-local test staging only.

### Jest / checks

- `node --check` clean on all 3 touched src files (fs.js,
  version-table.js, build-fs-only.mjs).
- Jest (NODE_OPTIONS=--experimental-vm-modules, --runInBand):
  `tests/ondemand-require.test.js` **29/29**; plus
  export_surface_fs, export_surface_fs_promises, fs.test.js,
  fs_promises.test.js — **5 suites, 118 tests, all passed**.
- Dist-bake check via `src/build-fs-only.mjs` (both targets, dist/
  restored afterwards): 24 bundle 769,730 bytes carries the DEP0147
  message (1×) and one fewer "is no longer supported" string (4× vs
  5× — the 26-only throw site is dead-code-eliminated in the 24
  build); 26 bundle 768,251 bytes has no DEP0147 (0×).
  `PARITY_TARGET_NODE` absent from both bundles (0×) — no runtime
  switcher (rule 11). Bundles differ, as expected.
- No zz-*.js probes were created in the worktree (probes lived in
  /tmp); nothing to delete before commit.

## Ship

(TODO — filled after merge: branch, code SHA, PR number, merge SHA.)
