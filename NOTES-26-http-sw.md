# NOTES-26-http-sw — take-back L-SW: Service Worker / Fetch-API server transport

Lane L-SW of the bundleVFSModules take-back (Jared approved taking the good
parts of his old shims into current main). Restores Gen 0's
`Server._handleFetch` as an opt-in adapter over current
`Server.handleRequest`. Capability restore, NOT a verbatim transplant.

## What was restored

Gen 0 (`a97251d9`, `src/_http_server.js:553-578`, `:634-643`): `listen()`
registered a `globalThis` `fetch` listener in a Service Worker global scope
and `_handleFetch(request)` returned `Promise<Response>` (503 when not
listening, else through Gen 0's `_connectionListener`). The port wave
dropped it with no replacement; 0 hits on current main (salvage TAKE 1,
`shim-before-after-audit-gen0.md` §5-§6 + `salvage-check.md`).

Current main (`b00b6451`, post L-H revert) already has what the adapter
needs — verified at run time, anchors re-checked (the salvage check's line
numbers predate the L-H work):

- `ServerBase.handleRequest(method, url, headers, body)` at
  `src/http.js:11810` — async, promise for
  `{ statusCode, statusMessage, headers, body }` (body is a Buffer;
  headers is the `_renderedHeaders` flat map — `set-cookie` stays an array
  on the direct path).
- Module bridge `handleRequest(port, ...)` at `src/http.js:12900-12997`
  (virtual-socket round trip for listened servers; `_handleFetch` does NOT
  use it — see ponytail ceiling below).
- `src/http.js:2` already carries the literal MIT license line
  (`// MIT License — Joyent, Inc. and other Node contributors.`, kept from
  #554/#555) — verified present on `b00b6451`, NOT duplicated. No root
  LICENSE file, no `package.json` license field (Jared's call, not a lane's).

## The change (branch `takeback-http-sw`, `src/http.js` only, +123/−0)

- `ServerBase._handleFetch(request)` (after `handleRequest`): 503
  `Service Unavailable` when `!this.listening` (Gen 0's contract);
  otherwise `await request.arrayBuffer()` → `this.handleRequest(method,
  request-target, headers, body)` → `new Response(body, { status,
  statusText, headers })`. `request.url` is absolute; the adapter passes
  `pathname + search` (Node handlers see the request-target).
  Multi-value headers append one line each when the rendered headers carry
  an array (incl. `set-cookie` on the direct path); a value already joined
  with `", "` stays joined — flagged, not solved (salvage check).
  Guards so the `Response` constructor cannot throw out of a fetch event:
  null-body statuses (101/204/205/304) get a null body, out-of-range
  statuses degrade to 500, invalid `statusText` is omitted. All three
  guards probed against live Node 26.13.1
  (`~/workspace/local/node-26/bin/node`).
- `listen()`: SW-gated `fetch` listener registration (Gen 0's
  `listen():553-578` shape) — `typeof ServiceWorkerGlobalScope !==
  "undefined" && globalThis instanceof ServiceWorkerGlobalScope`. Normal
  `listen()` untouched.
- `close()`: removes the listener if registered; `_fetchHandler` slot
  initialized to `null` in the constructor.
- The dispatch path is untouched. No existing test observes this
  capability. `ponytail:` comment on `_handleFetch` names the ceiling
  (direct `handleRequest` path — `req.socket` is null, the
  `IncomingMessage` default, not a real connected socket) and the upgrade
  path (route through the bridge's `_socketHttpRoundTrip` when the server
  has a backing net server; no such routing exists today).

## Verification (all on the branch, base `b00b6451`)

- Probe `parity/node-test/parallel/zz-http-handle-fetch.js` (deleted after
  use): **PASS 2x** — not-listening → 503 + `Service Unavailable` body;
  listening + handler → dispatches (handler sees `POST`,
  `/hello?x=1`, body `payload`) and returns a `Response` with status 201,
  statusText `Created`, body `hello-fetch`, both `set-cookie` values via
  `getSetCookie()`; 204 null-body response without throwing; SW listener
  registered by `listen()` in a simulated `ServiceWorkerGlobalScope`,
  `respondWith` delivers the response, `close()` removes the listener.
- Full http differential (`hidden_files/fast-sweep/fast-sweep.py --target
  http --jobs 2`, fresh CSV
  `hidden_files/fast-sweep/http-tb-sw-branch-2026-11-23.csv` vs base
  `http-tb-standalone-revert-2026-11-23.csv`): branch CSV is
  **byte-identical** to the base — 387/397 both, exit distribution
  identical (`0`: 387, `1`: 6, `124`: 2, `134`: 1, `139`: 1). **0
  toward-pass, 0 regressions, 0 mode changes.**
- Repo jest http suite (`NODE_OPTIONS=--experimental-vm-modules npx
  --no-install jest tests/http.test.js tests/http-socket.test.js
  tests/http-close-server.test.js tests/export_surface_http.test.js
  tests/export_surface__http_server.test.js`): **5 suites, 100 tests, all
  pass.** (First invocation without the flag failed all 5 on ESM loading
  — my missing flag, not a repo problem; the `test` script sets it.)
- Footprint `tests/ondemand-require.test.js`: **29/29 pass.**
- Real-Node semantics probed first (node-26.13.1): `Headers` iteration
  yields one entry per `set-cookie` value; `new Response(body,
  {status: 204|304})` throws `TypeError`; invalid `statusText` throws;
  `request.arrayBuffer()` on GET is 0 bytes.

## Counts — 0 flips, no docs-number changes

Banked on live main `b00b6451` (re-read from `parity/measured-rates.json`
before the change): **node26 http 412/422; v24 http 388/397.** The
differential proves 0 flips and 0 regressions, so the counts stand
unchanged. Recorded here as a capability restoration, not as numbers.

## dist/ — NOT regenerated locally (left for the CI dist-regen bot)

- `node src/build-vfs.mjs` exits 1 in this VM: the esm-sh plugin cannot
  fetch `https://esm.sh/acorn?bundle` for `src/specials/bundler.js`
  (network-blocked) — pre-existing, unrelated to this lane.
- The partial rebuild (all http bundles built OK before the failure;
  `dist/http.js` did contain `_handleFetch`, 2 occurrences) also churns
  untouched-source bundles: `dist/zlib.js` differs by **683,054 bytes**
  vs committed dist although the only `src/` changes since #551 are
  `child_process.js` + `http.js` — local rebuild is not reproducible
  against committed `dist/` (esbuild pinned 0.22.0, same version).
  All `dist/` changes were reverted; the commit is `src/http.js` only.
  The CI dist-regen bot is expected to regenerate `dist/` on the PR.

## Ship

- PR: #556 — `feat(http): restore Service Worker / Fetch-API server
  transport — Server._handleFetch (take-back L-SW)`
- Code SHA (remote, API-created): `5c1e58e025913da46c306cffa4b02d39a7667ad7`
  (local commit `863087922ad39552311964f64f73bee61498bac4`)
- Merge SHA: `ee6e2cea7ad27fdc83b4674e043cfa03354923c8` (squash-merge of
  #556; `merged: true` confirmed by direct read; merge SHA is `origin/main`
  tip and an ancestor of main, verified with `git merge-base --is-ancestor`)
- CI: GREEN on code SHA `5c1e58e025913da46c306cffa4b02d39a7667ad7`
  (waiter `26w4-http-sw-ci-waiter-556.py`: Parity + build success, single
  complete run). The dist-regen bot added `chore: regenerate vfs.js`
  (`dce63b9b`) after the code run; the merge criterion was the CODE run
  green on the code SHA, per the dist-regen rule.
- Capability facts: `_handleFetch` restored as an opt-in adapter;
  503-when-not-listening contract; SW-gated `fetch` listener; 0 flips
  (node26 412/422, v24 388/397 unchanged).
