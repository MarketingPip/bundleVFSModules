# NOTES-26-module-m261.md

Lane M-26-1 — `_load` parent-dir read / relative resolve cache.
Worktree: `~/workspace/worktrees/26w1-module`, base origin/main `d587825d`
(PR #506 triage merged). Branch: `fix/26w1-module-m261`.

## Flip (1)

- `test-module-relative-resolve-cache.js`: **1 → 0** (verified 2x isolated,
  `PARITY_TARGET=module timeout 30 node --import <worktree>/parity/preload.mjs
  parity/node-test/parallel/test-module-relative-resolve-cache.js`,
  exit 0, 0; pre-fix exit 1 both in the baseline run and per triage).
- Module count: **32/37 → 33/37** on the Node 26 suite (banked 32 + 1 flip,
  0 regressions).

## Root cause

Node 26 `Module._load` reads `parent.path` exactly once per call, before
anything else (`~/workspace/local/node-26-src/lib/internal/modules/cjs/loader.js:1349`,
`relativeResolveCache.get(parentPath)`), to key its per-directory relative
resolve cache — in every path: builtins, throwing resolutions, first loads,
and cache hits. The bucket is created only once a filename is resolved
(`loader.js:1469-1475`), so builtins/throws leave no bucket, and the entry
is deleted if `module.load` throws.

The shim (`src/module.js:1522` pre-fix) read `parent.path` **0 times** in
every path: the builtin early-return (`:1519-1523`) fires before
`_resolveFilename` ever sees the parent, and `_resolveFilename` /
`_resolveLookupPaths` / `trySelfParentPath` use `parent.filename` /
`parent.paths`, never `parent.path`. Return values and the
`MODULE_NOT_FOUND` throw code were already correct; only the read count
was wrong (first failing assertion: builtin block, `:39`, `0 !== 1`).

## Fix (`src/module.js`, +45 lines, 1 file)

- Module-level `Map` `_relativeResolveCache` (`:650`), keyed by parent dir
  then request → resolved filename. A `Map`, not Node's plain object, so a
  `__proto__` request cannot pollute the bucket.
- `_load` top block: if `parent`, read `parent.path` exactly once, look up
  the bucket, and on a hit return `_cache[filename].exports` (after
  `updateChildren`, mirroring the existing cache-hit path). A stale entry
  (filename no longer in `_cache`) is deleted and resolution falls through.
  The read sits before the builtin early-return, so builtins count 1.
- Store after `_resolveFilename` returns and the `_cache` check misses
  (i.e. only when a new module is about to be created), mirroring Node's
  store-before-load; bucket created lazily so builtins and throwing
  resolutions leave none behind.
- On load failure the rel-cache entry is deleted alongside `_cache[filename]`,
  mirroring Node's `finally` cleanup (`loader.js:1486-1487`).
- `ponytail:` comments name the ceiling (read-count + fast-path mirror only;
  resolution still goes through `_resolveFilename`/`_findPath`) and the
  upgrade path (none needed unless `_resolveFilename` is bypassed).

## Guards (full 26-suite module pass set, not a narrow flip list)

- Pre-fix baseline run (runner, `--jobs 2 --modules module`):
  **32/37 pass, 5 fail, 0 timeout** — identical to
  `parity/drift/node26-baseline.jsonc` (same 5 fails).
- Post-fix run 1 (same command): **32/37 pass, 4 fail, 1 timeout** —
  `test-module-print-timing.mjs` exit 124. Investigated, not a regression:
  the test spawns host-`node` children and never loads the shim; the run
  took 347 s vs 109 s pre-fix with 5 tests hitting the 10 s phase-1 cap
  (vs 1 pre-fix) under load average 23.07. The fix adds one property read
  + one `Map.get` per `_load` — no mechanism for a 20 s+ slowdown.
- Post-fix run 2 (`--short 30 --full 60`): **33/37 pass, 4 fail,
  0 timeout**. CSV diff vs pre-fix is exactly one line:
  `test-module-relative-resolve-cache.js 1 → 0`.
- Remaining 4 fails are the triaged NO-FIX set, unchanged:
  `builtin-experimental`, `builtin-policies`, `create-require`,
  `strip-types` (NOTES-26-triage-module.md §F1/F2).
- Repo jest: `NODE_OPTIONS=--experimental-vm-modules npx --no-install jest
  tests/module.test.js` — **89/89 pass**.
- `node --check src/module.js` clean. No `zz-*.js` probes left in the tree
  (one transient staging copy was removed; `parity/node-test/` restored
  clean after every runner invocation, verified by `git status`).

## Notes

- The test has no `// Flags:` header; no flag variant needed.
- No docs-number changes; no shared files touched (`parity/preload.mjs`,
  `parity/run.mjs`, `dist/*`, `.github/workflows/run.yaml`,
  `package.json` untouched).
