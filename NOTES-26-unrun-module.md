# Wave 4 triage — MODULE-DIAGNOSTICS (4 files)

Worktree: `~/workspace/worktrees/w4-module`, detached HEAD `6e4e6370`.
Oracle: native Node 26.13.1 (`~/workspace/local/node-26/bin/node`), no preload, 60 s timeout.
Baseline: host Node v24.22.1, `--import <worktree>/parity/preload.mjs`, `PARITY_TARGET=module`,
staged Node 26 `test/common/` + the 4 test files under `parity/node-test/`.
No `// Flags:` headers in any of the 4 files (grep: no match). No fixture use.
No code changes; worktree left clean (`git status` shows only `?? node_modules`).

## Per-file table

| File | Oracle (Node 26.13.1) | Baseline (shim, PARITY_TARGET=module) | Classification + reason |
|---|---|---|---|
| test-diagnostics-channel-module-import-error.js | PASS, exit 0 | PASS, exit 0 | NOT-A-GAP — never touches the shim (see evidence) |
| test-diagnostics-channel-module-import.js | PASS, exit 0 | PASS, exit 0 | NOT-A-GAP — never touches the shim (see evidence) |
| test-diagnostics-channel-module-require-error.js | PASS, exit 0 | PASS, exit 0 | NOT-A-GAP — never touches the shim (see evidence) |
| test-diagnostics-channel-module-require.js | PASS, exit 0 | PASS, exit 0 | NOT-A-GAP — never touches the shim (see evidence) |

## Group totals (of 4)

- PASS already: 0
- FLIPPABLE: 0
- NO-FIX: 0
- NOT-A-GAP: 4

## Evidence — why these never touch the shim

- Test specifiers (all 4 files read in full, 226 lines): `../common`, `assert`,
  `diagnostics_channel`, `url`, `http` (`require('http')` / `import('http')` /
  `import('does-not-exist')`). None requires/imports `module`. Neither do the
  tests nor Node 26 `test/common/index.js` require `module` (grep: no match).
- Harness gate: `parity/preload.mjs` `Module._load` wrapper redirects only when
  the parent is under `parity/node-test/parallel/` AND the specifier base is
  `PARITY_TARGET` (`module`) or an extra redirect; `isExtraRedirect()` has no
  entry for target `module`. `parity/hooks.mjs` `polyfillURL()` has the identical
  gate for ESM (`parts[0] !== target → return null`), so `import('http')` is
  not redirected either. `diagnostics_channel` therefore resolves to the real
  Node builtin, as does `http`.
- Publisher is the internal loader, not any shim: Node source pack
  `hidden_files/node-src/lib/internal/modules/cjs/loader.js:230`
  (`tracingChannel('module.require')`) and
  `lib/internal/modules/esm/loader.js:70` (`tracingChannel('module.import')`).
  `src/module.js` contains zero `tracingChannel` references, and
  `src/diagnostics_channel.js` is a standalone pub/sub — nothing in the shim
  publishes `module.require` / `module.import` events.
- Probe (temporary `parity/node-test/parallel/zz-module-dc-probe.js`, deleted
  after use), run under the same preload + `PARITY_TARGET=module`:
  `{"events":["http","module"],"shimInCacheBefore":false,"requireModuleIsShim":true,"shimInCacheAfter":true,"httpLoaded":true}`.
  The `module.require` event for `require('http')` fired while
  `shimInCacheBefore` was `false` — i.e. from the native loader with
  `src/module.js` never loaded. (`"module"` fired only because the probe
  itself then called `require('module')`; `requireModuleIsShim: true` proves
  the redirect does engage when `module` is actually requested, and
  `shimInCacheAfter: true` proves the shim entered the cache only at that
  point.)
- Baseline passes are therefore pure-native executions on host Node v24.22.1,
  not shim passes — the tests pass, but they measure nothing about the shim.

## Note for the parent

No harness target can make these tests exercise the shim as publisher: the
events are published inside Node's internal CJS/ESM loaders. Even under
`PARITY_TARGET=diagnostics_channel` the test's subscriber would attach to the
shim `dc` registry while the native loader publishes to the native registry,
so the events would never arrive — a harness-identity split, not a shim bug.
These 4 tests are loader-integration tests; they belong outside the parity
gap count, not in any shim lane.

## Cleanup verification

- Staged test files removed; `parity/node-test/common/` restored from
  `/tmp/w4-module-common-v24` (byte copy of the pre-staging v24 tree);
  probe deleted. `git status --short` → only `?? node_modules` (pre-existing
  symlink, untouched).
