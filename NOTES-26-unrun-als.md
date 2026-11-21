# Wave 4 triage — ASYNC-LOCAL-STORAGE (12 files)

- Worktree: `~/workspace/worktrees/w4-als`, detached HEAD `6e4e6370`
- Oracle host: native Node v26.13.1 (`~/workspace/local/node-26/bin/node`), no preload
- Baseline host: Node v24.22.1 with `--import <worktree>/parity/preload.mjs`, `PARITY_TARGET=async_hooks`
- Staging: Node 26 `test/common/` swapped in for the run, v24 `common/` backed up to `/tmp/w4-als-common-v24` and restored afterwards; 12 staged test files removed afterwards
- Flags honored: only `test-async-local-storage-http-parser-leak.js` and `test-async-local-storage-weak-asyncwrap-leak.js` declare `// Flags: --expose-gc`; both runs used it. No other file declares flags.
- Runs sequential, 60 s timeout each. Baseline run twice (two isolated passes, both rc=0) — no flakes.
- Worktree left clean: `git status` shows only `?? node_modules` (the symlink).

## Why they pass — mechanism (verified, not assumed)

- `parity/preload.mjs:244-246` routes `node:async_hooks` → `parity/async-hooks-harness.mjs` when `PARITY_TARGET=async_hooks`.
- `src/async_hooks.js:540-541`: `const AsyncLocalStorage = native !== undefined ? native.AsyncLocalStorage : BrowserALS;` — under a Node host the shim delegates ALS (and `AsyncResource`, `createHook`, `executionAsyncId`, `triggerAsyncId`, `executionAsyncResource`, `asyncWrapProviders`, lines 542-555) to the native implementation by design. The browser fallback (`BrowserALS` from `als-browser`, `StubAsyncLocalStorage` at line 322) is not exercised on the Node host.
- Probe (`zz-als-probe.js`, deleted after use): `AsyncLocalStorage.toString()` identical with/without preload (native class source); `executionAsyncId()` differed (0 with preload vs 1 native), confirming the preload path was engaged and its own async-resource creation shifts ids — the known +10 mechanism from the main program. None of these 12 tests assert absolute async ids, so the shift is harmless here.
- All 12 files reference `async_hooks` (7 directly `require('async_hooks')`; the rest via `common`/http helpers that use ALS internally).

## Per-file table

| File | Oracle (Node 26.13.1) | Baseline (shim, pass 1 / pass 2) | Classification |
|---|---|---|---|
| test-async-local-storage-bind.js | rc=0 | rc=0 / rc=0 | PASS already |
| test-async-local-storage-contexts.js | rc=0 | rc=0 / rc=0 | PASS already |
| test-async-local-storage-deep-stack.js | rc=0 | rc=0 / rc=0 | PASS already |
| test-async-local-storage-enter-with.js | rc=0 | rc=0 / rc=0 | PASS already |
| test-async-local-storage-exit-does-not-leak.js | rc=0 | rc=0 / rc=0 | PASS already |
| test-async-local-storage-http-agent.js | rc=0 | rc=0 / rc=0 | PASS already |
| test-async-local-storage-http-multiclients.js | rc=0 | rc=0 / rc=0 | PASS already |
| test-async-local-storage-http-parser-leak.js | rc=0 (`--expose-gc`) | rc=0 / rc=0 (`--expose-gc`) | PASS already |
| test-async-local-storage-isolation.js | rc=0 | rc=0 / rc=0 | PASS already |
| test-async-local-storage-run-scope.js | rc=0 | rc=0 / rc=0 | PASS already |
| test-async-local-storage-snapshot.js | rc=0 | rc=0 / rc=0 | PASS already |
| test-async-local-storage-weak-asyncwrap-leak.js | rc=0 (`--expose-gc`) | rc=0 / rc=0 (`--expose-gc`) | PASS already |

## Group totals (of 12)

- PASS already: **12**
- FLIPPABLE: **0**
- NO-FIX: **0**
- NOT-A-GAP: **0**

## Notes / caveats

- No failures, so no Node-source-pack diagnosis was needed and no re-runs for gaps were required.
- Scope limit (stated, not a gap): these parity runs exercise the shim's native-delegation path under a Node host. The browser fallback (`BrowserALS`/`StubAsyncLocalStorage`) is not covered by this harness invocation; that is the standing design of the async_hooks shim (AGENTS.md rule 1 notwithstanding, the parity harness is Node-hosted).
- No code changes, commits, pushes, or PRs made. No fresh web research used.
