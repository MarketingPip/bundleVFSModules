# Parity harness

Runs **Node.js's own official test suite** against this repo's polyfills to
measure real API parity — instead of only hand-written unit tests.

## How it works

1. `parity/node-test/` mirrors the layout of [`nodejs/node/test/`](https://github.com/nodejs/node/tree/main/test)
   (`parallel/`, `common/`). Test files are downloaded from the Node repo, not
   vendored by hand. They are pinned to the **v24.20.0** tag
   (commit `71b8b174857e25106d39b61a9e6f30d927da8b01`, fetched 2026-09-22 —
   the tag matching the Node runtime used here). Refresh or re-pin with:
   `node parity/fetch-node-tests.mjs [ref]` (defaults to v24.20.0).
   Note: `test/common/bench.js` does not exist at v24.20.0 and is not vendored;
   `parity/node-test/package.json` is ours (forces CJS for the vendored tests),
   not from the Node repo.
2. `parity/preload.mjs` (used via `node --import`) patches CJS
   `Module._load` and registers `parity/hooks.mjs` for ESM, so that
   `require('path')` / `import 'node:path'` **inside the Node test files**
   resolves to `src/path.js` (etc.) instead of the real builtin.
   Only the module named in `PARITY_TARGET` is redirected, and only for
   importers under `parity/node-test/parallel/` — `test/common` keeps using
   real Node builtins.
3. `parity/run.mjs [module]` spawns each `test-<module>*.js` in a child
   process, collects pass/fail, and diffs against
   `parity/expected-failures.json`. It exits non-zero only on **new**
   failures (or newly-fixed tests), so it gates CI on parity regressions.

## Usage

```sh
npm run parity -- path        # or: node parity/run.mjs path
```

Current scoreboard for `path`: **5/17** Node test files pass.
See `parity/expected-failures.json` for the categorized known failures and
`parity/report.json` for the last full run.

## Adding a module

1. Download its tests: `test/parallel/test-<name>*.js` from nodejs/node
   into `parity/node-test/parallel/` (keep the `test/`-style layout so
   `__filename`-based assertions behave).
2. Run `node parity/run.mjs <name>`, triage failures, record genuine
   known gaps in `expected-failures.json` with a reason each.
