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

Official suites are Node.js's own `test/parallel/test-<module>*.js` files,
pinned to **v24.20.0** and vendored under `parity/node-test/parallel/`.
"Official" = `node parity/run.mjs <module>` pass/total.
"Repo tests" = hand-written suites in `tests/`.
Every score below was produced (or re-verified) from this repo — no
score is taken on trust.

### Full official parity (100% — strict CI gate)

| Module | Official | Repo tests | PR | Status |
| --- | --- | --- | --- | --- |
| `path` (+`posix`, `win32`) | 17/17 | 36/36 | #22 | merged |
| `punycode` | 1/1 | — | #3 | merged |
| `querystring` | 4/4 | — | #4 | merged |
| `string_decoder` | 3/3 | — | #5 | merged |
| `events` | 9/9 | — | #6 | merged |
| `assert` (+`strict`) | 19/19 | 80/80 | #7 | merged |
| `diagnostics_channel` | 26/26 | — | #11 | merged |
| `os` | 7/7 | — | #12 | merged |
| `url` | 17/17 | — | #13 | merged |
| `console` | 22/22 | — | #14 | merged |
| `timers` (+`promises`) | 45/45 | 15/15 | #15 | merged |
| `sys` | 1/1 | — | #17 | merged |
| `tty` | 5/5 | 117/117 | #25 | merged |
| `perf_hooks` | 15/15 | — | #30 | merged |
| `constants` | 236/236 values | — | #23 | merged |
| `util/types` | 2/2 | — | #26 | merged |
| `v8` | 22/22 | 36/36 | #18 | open — tests land on merge |
| `crypto` | 129/129 | 15/15 | #55 | merged |
| `stream` (+`consumers`, `promises`, `web`, `_stream_*`) | 237/237 | 66/66 | #20 | open — tests land on merge |

Notes:
- `console` was 20/22 on `main` (a `util.types` gap and an inspect
  key-color gap); both fixed here, now 22/22.
- `buffer` is 60/62 on `main`: the two failures need the *native* global
  `Buffer` / real `util.inspect` to see our module's state, which the
  single-target harness cannot do — a harness limitation, not a port bug
  (`SlowBuffer` correctly extends `Buffer` in the port).

### Best-effort browser ports (honest gaps — advisory CI)

These modules cannot reach 100% in a browser (no raw sockets, no OS
processes, no native bindings). They are real, tested implementations with
documented limits — never silent data fabrication.

| Module | Official | Repo tests | PR | Status | Honest gap |
| --- | --- | --- | --- | --- | --- |
| `util` | 30/31 | — | #10 | open | complex `breakLength` grouping |
| `domain` | 43/50 | 43/43 | #27 | merged | deprecated upstream (DEP0097) |
| `readline` (+`promises`) | 21/22 | 64/64 | #29 | merged | 1 terminal edge case |
| `vm` | 40/97 | 46/46 | #31 | merged | `eval`-based; weaker isolation than V8 contexts |
| `zlib` | 31/65 | 38/38 | #59 | merged | brotli has no browser API; CompressionStream covers gzip/deflate |
| `process` | 81/97 | 47/47 | #33 | merged | mirrors `globalThis._RUNTIME_.process`; OS signals unavailable |
| `child_process` | 7/112 | 47/47 | #34 | merged | no OS processes; worker/postMessage emulation |
| `module` | 30/32 | 83/83 | #35 | merged | `runMain`/`_preloadModules` are noops |
| `http` (+`https`, `_http_*`) | 460/743 · 20/67 | 65/65 | #36 | merged | fetch-backed; no raw TCP/TLS servers |
| `dns` (+`promises`) | 10/31 | 93/93 | #37, #58 | merged | DNS-over-HTTPS only; no raw UDP |
| `fs` (+`promises`) | 111/349 | 87/87 | #60 | merged | in-memory FS; no OS file descriptors |
| `net` | 69/156 | 77/77 | #39 | open | virtual in-process transport; no raw TCP |

### Wave C — browser-impossible APIs (in progress)

`dgram`, `tls` (+`_tls_*`), `http2`, `cluster`, `worker_threads`,
`async_hooks`, `inspector` (+`promises`), `repl`, `test` (+`reporters`).
Policy: correct-shaped **noop stubs** (Jared's rule — never throw for
browser-impossible APIs), with each gap documented in the module's PR.
Scores land here as PRs merge.

Merged: `sea` (#40, #57), `wasi` (#41), `trace_events` (#44).

### Runtime

`RUNTIME:NODE_GLOBALS` (`src/node_globals.js`) is loaded at sandbox
startup and is not a Node builtin — it has no official suite.

Target state: every completed module has zero entries in
`parity/expected-failures.json` (currently empty). See
`parity/report.json` for the last full run.

## CI

`.github/workflows/run.yaml` runs parity on push to `main` and on pull
requests, pinned to Node 24.20.0 to match the vendored suite:

- **Strict gate** — every module in the "Full official parity" table
  above whose tests are vendored on `main`. Any new failure fails the job.
- **Advisory** — the best-effort modules run with failures tolerated
  (`|| true`); they report scores but never fail the job. Their honest
  gaps are tracked in the scoreboard, not in `expected-failures.json`.

Note: the full `npm test` suite in the build job is red on `main` for
pre-existing environmental reasons (missing optional npm deps in this
environment); module work is gated by each module's own tests plus the
parity job above, not by the whole-suite run.

## Adding a module

1. Download its tests: `test/parallel/test-<name>*.js` from nodejs/node
   into `parity/node-test/parallel/` (keep the `test/`-style layout so
   `__filename`-based assertions behave).
2. Run `node parity/run.mjs <name>`, triage failures, record genuine
   known gaps in `expected-failures.json` with a reason each.
