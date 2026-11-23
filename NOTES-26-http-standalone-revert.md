# L-H revert — take back the standalone-response trailing empty write (`test-http-server-response-standalone.js`)

Reverts the behavioral change of #554 (merge `80b406d2`): removes the restored
`sock.write(Buffer.alloc(0));` from the standalone finish path of `src/http.js`,
restores the pre-#554 comments, and deletes the `ponytail:` block #554 added.
KEEPS the literal `// MIT License.` line at `src/http.js:2` that #554 added.

## Why (yardstick conflict — the live program is Node 26)

- Node 26 `end()` folds the final chunk into ONE write
  (`maybePrepareFinalChunk`, `lib/_http_outgoing.js:1302` in
  `~/workspace/local/node-26-src/`), and the Node 26 test file expects
  `mustCall(..., 1)`.
- Node v24 `end()` sends a trailing empty chunk
  (`this._send('', 'latin1', finish)`, `lib/_http_outgoing.js:1173` in the
  v24.20.0 source pack), and the v24 test file expects `mustCall(..., 2)`
  with a zero-length second chunk.
- A fixed write count cannot satisfy both yardsticks. The live program is
  Node 26, so the Node 26 behavior wins and the v24 file returns to failing.
  (Upgrade path, unchanged from #554: a harness-declared target version the
  shim could read — no such signal exists today.)

## Oracle probe (real Node first)

- Real Node 26.13.1 binary (`~/workspace/local/node-26/bin/node`) runs its
  own test file
  (`~/workspace/local/node-26-src/test/parallel/test-http-server-response-standalone.js`):
  **exit 0** — native Node 26.13.1 delivers 1 write for this path.
- Node 26 source oracle: `maybePrepareFinalChunk` at
  `~/workspace/local/node-26-src/lib/_http_outgoing.js:1165`, called from
  `end()` at `:1302` ("If just one final write is required, with nothing to
  follow, we attach finish to the write to avoid a separate send() & tick
  step later on").
- v24 source oracle (goal node-src pack, v24.20.0):
  `this._send('', 'latin1', finish)` at `lib/_http_outgoing.js:1173`.
- Note: the goal-workspace node-src pack is the **v24.20.0** source
  (`node-v24.20.0.tar.gz`); the Node 26 source oracle is
  `~/workspace/local/node-26-src/`.

## Banked counts (re-read on live main `80b406d2` before the change)

- `parity/measured-rates.json`: node26 http **412/422**, v24 http **388/397**.
  (#554 did not change the recorded numbers — no docs-number changes were
  in that PR; its commit message claimed v24 389/397, which is the
  post-merge actual, not the banked figure.)
- After this revert the counts return to the banked values: node26 412/422,
  v24 388/397. New count = banked + flips verified 2x on LIVE main −
  regressions; never computed from expectations.

## The change (`src/http.js` only)

- Diff vs `80b406d2^` (pre-#554 `src/http.js`): ONLY the kept MIT license
  line at `:2` plus a 5-line comment at the revert site stating why the
  empty write is absent (Node 26 delivers 1 write; the v24 file's
  `mustCall(..., 2)` is mutually exclusive). No other lines differ.
- `node --check src/http.js`: OK.
- `dist/` is NOT regenerated in this PR: CI's "Commit generated file" step
  (`node src/build-vfs.mjs` + `git add -f dist/*.js`) regenerates it after
  the tests pass.

## Isolated verification (PARITY_TARGET=http, absolute preload path)

Worktree `~/workspace/worktrees/takeback-http-standalone-revert` at
`80b406d2` + this change; `node_modules` symlinked from the main checkout.

- v24 target test
  (`parity/node-test/parallel/test-http-server-response-standalone.js`):
  **[1, 1]** — "Mismatched <anonymous> function calls. Expected exactly 2,
  actual 1." Back to the pre-#554 state, as intended.
- node26 target test (isolated staging recipe — Node 26 test file copied
  from `~/workspace/local/node-26-src/test/parallel/` into the worktree's
  `parity/node-test/parallel/` AND `parity/node-test/common/` replaced with
  the Node 26 `test/common/`, v24 `common/` backed up first; restored with
  `git restore` + re-copy, `git status` verified clean afterwards — the
  tracked v24 file was never deleted): **[0, 0]** — flip verified 2x.

## v24 differential (fast-sweep.py, `--target http`, `--jobs 2`)

- Branch CSV:
  `hidden_files/fast-sweep/http-tb-standalone-revert-2026-11-23.csv`
  (base: `hidden_files/fast-sweep/http-tb-standalone-2026-11-23.csv`, the
  #554 branch state = live main behavior).
- Result: **397 rows, 387 pass, 2 timeout, 8 fail, crashes {134: 1, 139: 1}**,
  elapsed 347 s.
- Diff vs #554 branch base: **toward-pass=1** (`test-http-unix-socket.js` —
  sweep flake: 0 in the banked base, 1 in the #554 branch sweep, 0 again
  here), **regressions=1** (`test-http-server-response-standalone.js` — the
  intended return-to-fail), **mode-changes=0**.
- Diff vs the banked base (`hidden_files/shim-before-after/main/http.csv`,
  399 rows incl. 2 files outside the sweep set —
  `test-http-keep-alive-empty-line.mjs`, `test-http.js`): **zero diffs on
  all 397 shared files** (standalone=1, unix-socket=0,
  drop-connections-in-cluster=124, stale-close=124 — all as banked). The
  branch returns exactly to the banked v24 state.
- **New v24 count: 388 + 0 flips − 0 regressions = 388/397.**

## node26 differential (`parity/drift/run-baseline.mjs --modules http`)

- Branch JSONC/CSV:
  `hidden_files/takeback-http-standalone-revert/node26-http-branch.jsonc`,
  `hidden_files/takeback-http-standalone-revert/csv-http/`.
- Result: **412/422 pass, 9 fail, 1 timeout**.
- Fail set: exactly the 9 banked wave-end non-pass
  (`test-http-agent-domain-reused-gc.js`,
  `test-http-agent-free-socket-pending-read.js`,
  `test-http-autoselectfamily.js`, `test-http-chunk-problem.js`,
  `test-http-parser-lazy-loaded.js` (134),
  `test-http-parser-timeout-reset.js` (139),
  `test-http-pipeline-flood.js`, `test-http-server-stale-close.js`,
  `test-http-websocket-mask-immutable.js` (9)) — standalone is **0**.
  Timeout: `test-http-server-drop-connections-in-cluster.js` (the banked
  flake, same as wave-end).
- **New node26 count: 412 + 1 flip (standalone, verified 2x isolated) −
  0 regressions = 412/422.**

## Repo tests

- Jest http suite (local, `NODE_OPTIONS=--experimental-vm-modules
  npx --no-install jest tests/http.test.js tests/http-socket.test.js
  tests/http-close-server.test.js tests/export_surface_http.test.js
  tests/export_surface__http_server.test.js
  tests/export_surface__http_client.test.js
  tests/export_surface__http_common.test.js
  tests/export_surface__http_incoming.test.js
  tests/export_surface__http_outgoing.test.js
  tests/export_surface__http_agent.test.js
  tests/ondemand-require.test.js`): **11 suites passed, 134 tests passed.**
- Footprint test (`tests/ondemand-require.test.js`): green (in the 11 above).
- `node --check src/http.js`: OK.
- `git status` clean before/after (except the `node_modules` symlink,
  untracked, same as sibling lanes; explicit file lists only — never
  committed).

## Ship

- PR: TBD.
- Merge SHA: TBD.
- CI: TBD.
- Yardstick-conflict reason: see "Why" above — Node 26 (live program)
  delivers 1 write; v24 file expects 2; one fixed count cannot satisfy
  both, so Node 26 wins and the v24 file returns to failing (388/397).
