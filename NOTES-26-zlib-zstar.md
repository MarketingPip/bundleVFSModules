# NOTES-26-zlib-zstar — lane L-Z: top-level `Z_*` on zlib, CJS default-export slice only

Lane: take-back TAKE 2 from the Gen 0 salvage shortlist
(`shim-before-after-audit-gen0.md` §5–§6, `shim-before-after-gen0/salvage-check.md` §2).
Base: `51ada62d`. Worktree: `~/workspace/worktrees/takeback-zlib-zstar`
(removed after merge). Branch: `takeback-zlib-zstar`. One file changed:
`src/zlib.js`, +20 lines, 0 deletions.

## What changed

- `src/zlib.js` — after the `zlibDefaultExport` literal, a loop defines every
  non-`BROTLI` entry of the in-tree `constants` object as a non-enumerable,
  non-writable, non-configurable property on `zlibDefaultExport`, before the
  existing `Object.freeze`. Values are reused from `constants` (`:66-234`,
  already verbatim Node data) — nothing retyped. A `ponytail:` comment names
  the ceiling (CJS-shape parity only) and the upgrade path.
- `src/zlib.js:2` — added the literal `// MIT License.` line (the file had no
  license header; the salvage recommendation). No root `LICENSE` file, no
  `package.json` license field — those are Jared's call, not a lane's.
- No named ESM exports added, deliberately: real Node ESM has no `Z_OK`
  export (`import { Z_OK }` is a SyntaxError on real Node itself).

## Count correction — the brief said 24, the live probes say 36 / 107

The brief (from the salvage report) said "the 24 Node `Z_*` names". No
verifiable set has 24 members. Live probes on real Node v24.22.1 AND
v26.13.1 (`zz-realnode-cjs.cjs`, kept in `/tmp/zz-lane/`):

- 107 non-enumerable top-level names on `require('node:zlib')` — exactly the
  non-`BROTLI` entries of `constants`, values identical to `constants[name]`
  (`node-src/lib/zlib.js:1083-1092` is the loop; `configurable: false`,
  `writable: false`, `enumerable: false` on every one).
- Strict `Z_*` (prefix `Z_`): **36**, not 24.
- ESM namespace: `Z_OK === undefined`, `'Z_OK' in z === false`.

So the lane implements Node's actual rule (the loop, 107 names — a strict
superset of any `Z_*`-only reading, including all 36 `Z_*`) instead of an
arbitrary 24-subset, which would have left probe-verifiable gaps
(e.g. `Z_MIN_CHUNK` undefined on CJS require). The `ponytail:` comment in
the code states the 107 / 36 numbers. If the coordinator wants the slice
narrowed to `Z_*`-only (36), that is a one-line change to the loop guard.

## Real flow traced (ponytail)

- CJS: the parity preload (`parity/preload.mjs:427-456`) returns
  `ns.default ?? ns` for `require('node:zlib')` — i.e. `zlibDefaultExport`.
  Defining the props on that object is exactly what CJS consumers see.
- ESM: `import * as z from 'node:zlib'` resolves via `parity/hooks.mjs` to
  `src/zlib.js`; the namespace object is separate from the default export,
  so ESM still sees no `Z_*` — matching real Node.
- The export-surface test (`tests/export_surface_zlib.test.js`) asserts
  `Object.keys(shim)` — unchanged, since no named export was added.

## Verification (all on the branch, before shipping)

- Real-Node probes first: `zz-realnode-cjs.cjs` + `zz-realnode-esm.mjs`
  PASS on v26.13.1 and v24.22.1 (CJS 107 non-enum / 36 `Z_`; ESM `Z_OK`
  undefined). Probe files deleted after use with the lane cleanup; the
  assertions are recorded here.
- Shim probes, 2x each on the branch, via the parity preload
  (`PARITY_TARGET=zlib`): `zz-zlib-zstar-cjs.cjs` PASS 2x
  (`nonEnum=107 Z_=36`, descriptor `{value:0,writable:false,
  enumerable:false,configurable:false}`, destructuring works,
  `Object.keys` / spread blind) and `zz-zlib-zstar-esm.mjs` PASS 2x
  (namespace `Z_OK` undefined, `default.Z_OK === 0` non-enumerable).
  Pre-change control on pristine main: CJS probe fails at `z.Z_OK`
  (`undefined !== 0`); ESM probe fails at `z.default.Z_OK`. Probes deleted
  after use; `git status` clean apart from `src/zlib.js`.
- Repo jest: `tests/zlib.test.js` + `tests/export_surface_zlib.test.js` +
  `tests/zlib-native-compat.test.js` — 3 suites, 40 tests, all pass.
  Footprint: `tests/ondemand-require.test.js` — 29/29 pass.
- `node --check src/zlib.js` clean.
- Full zlib differential (fast-sweep.py `--target zlib --jobs 2`):
  - Baseline on pristine `51ada62d` (`zlib-zstar-base-2026-11-23.csv`):
    52/64 pass, 1 timeout, 11 fail — byte-identical to the banked wave-end
    CSV; plus `test-zlib.js` (outside the sweep glob) exit 1, so the full
    v24 set is **52/65**, matching the banked count.
  - Branch run 1 (`zlib-zstar-branch-2026-11-23.csv`): 52/64,
    toward-pass 0, regressions 0, mode-changes 0.
  - Branch run 2 (`zlib-zstar-branch2-2026-11-23.csv`): 52/64, same
    0/0/0 diff; run 1 == run 2 byte-identical. **0 flips, verified 2x.**
  - Node-26-host check (same v24 64-file set, `node` =
    `~/workspace/local/node-26/bin/node`): pristine baseline
    (`zlib-zstar-base-node26host-2026-11-23.csv`) 52/64, byte-identical
    to the v24 baseline; branch
    (`zlib-zstar-branch-node26host-2026-11-23.csv`) 52/64, 0/0/0 diff.
  - The parent-banked node26 count (69/89) was not re-run by this lane:
    no 89-file node26 test tree is present in the repo/goal dir; the
    node26-host run above covers the v24 file set under the node26 binary.
- New count: banked v24 52/65 + 0 flips − 0 regressions = **52/65**.
  Banked node26 69/89 + 0 − 0 = **69/89** (parent-banked, not re-measured
  here). **No docs-number changes in this PR** — 0 flips, so
  `parity/measured-rates.json` and HITLIST are untouched; the change is
  recorded here as an API-surface addition, not as numbers.

## Ship

- PR: [#551](https://github.com/MarketingPip/bundleVFSModules/pull/551)
  (`feat(zlib): expose Z_* constants as non-enumerable CJS properties
  (take-back TAKE 2)`), branch `takeback-zlib-zstar` (deleted after merge).
- Merge SHA: `770d8a2e77722996045007e832cf3fdc503ed8c3` (squash-merge,
  `merged: true` confirmed by direct read; merge SHA verified an ancestor
  of `origin/main`, which now sits at `770d8a2e`).
- CI: GREEN on the code SHA `63c698d37382ac498d18c50489bcf3d155575b18`
  (direct read: `build` completed/success, `Parity (Node official
  tests)` completed/success — single complete run). The dist-regen bot
  moved the PR head to `c0148974029ee328cf8319bd4fdc64826d78db36`
  (`chore: regenerate vfs.js`, parent = code SHA) with zero check-runs;
  per the dist-regen rule the code-SHA green is the merge criterion.
  Waiter: `hidden_files/26w4-zlib-zstar-ci-waiter-551.py` (log alongside).
- API-change facts: `require('node:zlib').Z_OK === 0` (and all 107
  non-`BROTLI` constants) now present, non-enumerable, on the CJS default
  export; ESM namespace unchanged (`Z_OK === undefined`); no new named
  exports; `constants` / `codes` values untouched; MIT license line added
  to `src/zlib.js`.
- Flips: **0** (verified 2x on live main, plus a node26-host differential).
