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

`run.mjs` matches `test-<module>*.js` (and `*.mjs`) files; `_` in the module
name maps to `-` in test file names, so `node parity/run.mjs string_decoder`
picks up `test-string-decoder*.js`.

## Scoreboard

| Module | Official tests (Node v24.20.0) | Repo tests | Differential vs real Node builtin |
| --- | --- | --- | --- |
| `path` | 17/17 | 36/36 | 264/264 checks |
| `punycode` | 1/1 | — | 174/174 checks |
| `querystring` | 4/4 | — | 338/338 checks |
| `string_decoder` | 3/3 | — | 16,880 checks, 0 failures |
| `events` | 9/9 | — | 19/19 checks |
| `assert` | 19/19 | 80/80 | 35-op battery, 0 failures |

Target state: every completed module has zero entries in
`parity/expected-failures.json` (currently empty). See
`parity/report.json` for the last full run.

## CI

`.github/workflows/run.yaml` runs the parity suites for every completed
module (`path`, `punycode`, `querystring`, `string_decoder`, `events`,
`assert`) on push to `main` and on pull requests, pinned to Node 24.20.0
to match the vendored suite. Any new failure fails the job.

## Adding a module

1. Download its tests: `test/parallel/test-<name>*.js` from nodejs/node
   into `parity/node-test/parallel/` (keep the `test/`-style layout so
   `__filename`-based assertions behave).
2. Run `node parity/run.mjs <name>`, triage failures, record genuine
   known gaps in `expected-failures.json` with a reason each.
