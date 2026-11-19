# NOTES-26-triage-module.md

Node 26.13.1 re-target triage — `module`. DOCS ONLY, no `src/` change.
Worktree: `~/workspace/worktrees/node26-triage-misc-small`, base `3c091022`.
Node 26 binary verified before probing: `~/workspace/local/node-26/bin/node --version` = `v26.13.1`.
Host Node (harness runtime): `v24.22.1`. Node 26 source: `~/workspace/local/node-26-src/`.

## Counts

- Baseline (28-module): module 37 total, 32 pass, 5 fail, 0 timeout.
- Oracle: 5 shim-gap, 0 fails-natively, 0 native-timeout.
- **Gap stays 5.**
- v24 ceiling: 30/32, remaining 2 all NO-FIX (create-require pinned
  divergence, strip-types needs amaro).
- Export diff: module REMOVED `_debug`, nothing added/changed.
  Changelog: 25.0.0 `Module._debug` removed; 26.0.0 `module.register()`
  RUNTIME-deprecated (DEP0205, migrate to `registerHooks()`);
  extensionless-CJS exception removed for `type: module` packages.

## Gap list (all 5, harnessExit / nativeExit from gaps-module.json)

| test | harness | native | vendored in v24? |
| --- | --- | --- | --- |
| test-module-builtin-experimental.js | 1 | 0 | **no — NEW in 26** |
| test-module-builtin-policies.js | 1 | 0 | **no — NEW in 26** |
| test-module-create-require.js | 1 | 0 | yes |
| test-module-relative-resolve-cache.js | 1 | 0 | **no — NEW in 26** |
| test-module-strip-types.js | 1 | 0 | yes |

Isolated re-runs (staged Node 26 `test/parallel + common + fixtures`,
`timeout 30 node --import <abs preload> parity/node-test/parallel/<test>`,
`PARITY_TARGET=module`, per `parity/drift/run-baseline.mjs`): all 5 exits
reproduced exactly (all 1). Flag variant: builtin-policies WITH
`--expose-internals` still 1. Probe logs: `~/workspace/node26-misc-probes/`.

## New-in-26 vs pre-existing

- **NEW in 26 (3):** builtin-experimental, builtin-policies,
  relative-resolve-cache. None is in the vendored v24 tree.
- **Pre-existing (2):** create-require (formatting-only diff vs v24),
  strip-types (the Node 26 file is a SUBSET of the vendored file — the
  vendored copy has extra `transform`-mode source-map tests using
  `vm.Script` and a `namespace MathUtil` fixture that Node 26 removed;
  the core strip/explicit tests are the same and still fail).

## Families

### F1 — Flag/internal-gated builtins (2 tests) — NO-FIX

- test-module-builtin-experimental.js, test-module-builtin-policies.js.
- Classification: fixture/validation gap in the harness sense — both
  tests measure the **host binary**, not the shim.
- Evidence:
  - builtin-experimental: every assertion runs in a spawned child
    (`spawnSyncAndAssert(process.execPath, …)`). Harness stderr:
    `process terminated with status 9, expected 0`,
    `command: "/usr/bin/node --experimental-bench -e …"`. Host
    v24.22.1 has no `--experimental-bench` (and no `node:bench` /
    `node:vfs` without their flags); the flags do not exist on the host
    at all. Probe on Node 26: the flags exist and gate the builtins as
    the test expects. No shim change can add CLI flags to `/usr/bin/node`.
  - builtin-policies: `require('internal/test/binding')` →
    `TypeError: getBuiltinModulePolicies is not a function` (harness
    stderr, `:28`), with AND without `--expose-internals`. Probe:
    Node 26 → `function`, 12 policies; host → `undefined`. The API is
    a Node 26 internal test binding; there is no browser equivalent and
    no shim surface that could provide it.
- No lane.

### F2 — Pinned divergence + amaro (2 tests) — NO-FIX, pre-existing

- test-module-create-require.js, test-module-strip-types.js.
- v24 NO-FIX verdicts stand; the 26 files change nothing material.
- create-require: `createRequire('https://github.com/nodejs/node/pull/27405/')`
  does not throw under the harness (actual `undefined`, expected
  `{ code: 'ERR_INVALID_ARG_VALUE' }`). The shim deliberately accepts
  http(s) bases (`src/module.js:1606-1611` — vite 7 `chunk.js` does
  `createRequire(import.meta.url)` with a non-`file:` base), and the
  repo's own `tests/module.test.js` pins the opposite of the vendored
  test. No signal distinguishes parity-harness from jest repo test from
  browser (v24 adjudication, unchanged).
- strip-types: the shim is a documented passthrough
  (`src/module.js:2132-2196` — "no TypeScript transformation is
  performed in the browser"). Harness result: 3/6 sub-tests fail —
  `stripTypeScriptTypes`, `stripTypeScriptTypes explicit` (returns the
  input unchanged, expected whitespace-erased output), and
  `sourceUrl throws when mode is strip`. Strip mode needs
  whitespace-preserving erasure, transform mode needs exact amaro VLQ
  mappings; the installed `typescript` dep is probe-proven different on
  both (v24 adjudication). Future path is a WASM swc per repo rule 8,
  blocked by sync-API vs async WASM init.
  - Freebie inside any future strip lane (does NOT flip the file
    alone): the `sourceUrl`-in-`strip`-mode case — Node 26 throws
    `ERR_INVALID_ARG_VALUE`, the shim accepts it and appends a
    `//# sourceURL=` comment (`src/module.js:2175-2179`). A 3-line
    validation fix; the file still fails on the two transform cases.

### F3 — `_load` observable: relative resolve cache (1 test) — LANE, flip 1

- test-module-relative-resolve-cache.js.
- Node 26's `Module._load` reads `parent.path` exactly once per call
  (to key its per-directory relative resolve cache): builtins 1,
  throwing resolutions 1, first successful load 1, cache hit 2
  (cumulative). The shim reads it **0 times in every path** — direct
  probe of the shim's `Module._load` (`relcache-shim.mjs`, imports
  `src/module.js` directly): block1 `0 (want 1)`, block2 `0 (want 1)`,
  block3 `0 (want 1)` then `0 (want 2)`. All return values and the
  `MODULE_NOT_FOUND` throw code are already correct; only the read
  count is wrong. First failing assertion is the builtin one at `:39`
  (`0 !== 1`).
- **Lane M-26-1 — `_load` parent-dir read / relative resolve cache.
  Estimated flip: 1** (relative-resolve-cache). Work: read `parent.path`
  exactly once per `_load` call in every path — including the builtin
  early-return (`src/module.js:1519-1523`, which returns before
  `_resolveFilename` ever sees the parent) and the cache-hit return
  (`:1526-1529`) — mirroring Node's `relResolveCacheIdentifier`
  computation, and optionally keep the cache itself (a per-directory
  `Map`). The probe proves the later blocks already produce the right
  values, so matching the counter flips the whole file.

## Lane candidates (conservative)

| lane | tests flipped | estimate |
| --- | --- | --- |
| M-26-1 `_load` parent-dir read / relative resolve cache | test-module-relative-resolve-cache.js | **1** |

## NO-FIX list (4)

1. test-module-builtin-experimental.js — spawned children are host
   `/usr/bin/node`, which lacks the `--experimental-*` flags entirely
   (exit 9, bad option); the test measures the host binary.
2. test-module-builtin-policies.js — needs the Node 26 internal test
   binding `getBuiltinModulePolicies` (host: `undefined`, Node 26:
   function/12 policies); no browser equivalent.
3. test-module-create-require.js — pinned divergence conflict (vendored
   test wants `https://` bases to throw; repo jest pins them accepted
   for vite 7 `chunk.js`); v24 NO-FIX.
4. test-module-strip-types.js — needs amaro (exact strip whitespace +
   transform VLQ mappings); v24 NO-FIX. The `sourceUrl`-in-strip-mode
   validation is a freebie for a future strip lane, not a flip.

## Non-flipping 26 notes (no lane — no gap test covers them)

- `Module._debug` is still exported by the shim (`src/module.js:2197`,
  `:2266`, `:2291`) but was REMOVED in Node 26 (25.0.0). One-line
  removal candidate for a future cleanup lane; no test flips.
- `register()` does not emit the Node 26 runtime DEP0205 deprecation
  warning (`src/module.js:2011-2025`, returns `undefined` silently).
  A warning could be added, but no gap test checks it.
- The shim's `builtinModules` list (`src/module.js:447+`) is the pinned
  v24.20.0 list — no `bench`/`vfs`/`ffi`/`quic`/`sqlite` entries. The
  gap test spawns host children, so list changes flip nothing; flag
  gating of new builtins is a separate (unmeasured) surface.

## Baseline corrections

- None for module: all 5 isolated re-runs reproduce the baseline exits
  exactly (all 1), including the `--expose-internals` variant for
  builtin-policies.
- One measurement note: the baseline harnessExit for
  builtin-experimental (1) hides an inner exit 9 — the spawned child
  dies with "bad option". The 1 is the parent test's exit after
  `spawnSyncAndAssert` throws; the root cause is the host binary, not
  the shim (see F1).
