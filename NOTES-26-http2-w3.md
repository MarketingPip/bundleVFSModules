# Node 26 Wave 3 — HTTP2 lane W3: H2-26-WR + H2-26-W1 + H2-26-C1 (NOTES-26-http2-w3.md)

Branch `fix/http2-26-w3`, base origin/main `10bdfcaa`.
Banked count (coordinator-confirmed on live main): **http2 88/289**.
New count = 88 + flips verified 2× on live main − regressions in the
differential = **94/289** (6 flips, 0 regressions — see § Verification).

## Method

- Oracle: Node 26.13.1 binary (`~/workspace/local/node-26/bin/node`) +
  Node 26 src (`~/workspace/local/node-26-src`, lib/ + test/parallel/).
  No fresh web research; source pack + repo tree + local probes only.
- Baseline differential on pristine base first
  (`parity/drift/run-baseline.mjs --modules http2 --jobs 2 --short 10
  --full 30`, out `/tmp/w3-http2/node26-baseline-http2.jsonc`):
  **88/289 pass, 198 fail, 3 timeout** (triage said 199 fail / 2
  timeout — one test straddles fail/timeout across runs; pass count
  matches exactly).
- Isolated runs: Node 26 test files copied into
  `parity/node-test/parallel/`, run as `PARITY_TARGET=http2 timeout 30
  node --import <absolute preload> parity/node-test/parallel/<test>.js`,
  tree restored afterwards (`git checkout -- parity/node-test` +
  deleting staged new-in-26 files). No test declares `// Flags:` among
  the lane targets.
- Full guard: same run-baseline invocation, twice, fresh output
  filenames (`/tmp/w3-http2/node26-after-http2-w3.jsonc`,
  `/tmp/w3-http2/node26-after2-http2-w3.jsonc`).

## Flips (6)

| # | Test | Lane | Root cause |
|---|------|------|------------|
| 1 | test-http2-async-local-storage.js | WR | server `write()` in dispatch handler routed to request body |
| 2 | test-http2-write-callbacks.js | WR | same; server never calls `respond()`, so `_responseStarted` routing cannot fix it |
| 3 | test-http2-client-data-end.js | WR | same + push-stream `write()` misrouted (see § Triage corrections) |
| 4 | test-http2-connection-window-size-option.js | W1 | `connectionWindowSize` never accepted; `state.remoteWindowSize` hardcoded 65535; `stream.session` was the client session; `respond()` ignored `endStream` |
| 5 | test-http2-compat-get-headers.js | C1 | plain-object header store (`__proto__` sets prototype), plain-object `getHeaders()` copy, no `flushHeaders()`, no `:status` in store on send |
| 6 | test-http2-status-code.js | W1-adjacent | `respond(..., { endStream: true })` never delivered (same `respond()` gap W1 needed) |

All 6 verified 2× isolated on final code (rounds 2 + 3, exit 0) and
in both full differentials (fail → pass, no other status change).

## H2-26-WR — `Http2Stream.write()` side-routing (`src/http2.js`)

### Triage correction: route-by-`_responseStarted` alone REGRESSES

The triage's "fix shape: route `write()` by `_responseStarted` like
`end()` does" is wrong as literally stated, for two probe-proven
reasons:

1. `test-http2-zero-length-write` (guard, in the 88-pass set) pipes the
   client upload AFTER the server responded. Routing by
   `_responseStarted` sends those chunks to `_responseChunks`, the
   request body arrives as 0 bytes, the server sees `'' !==
   'asdffoobar'`. This is the H2-V1 case the old comment records.
2. `test-http2-write-callbacks`' server never calls `respond()`, so
   `_responseStarted` is false for its whole run — routing by it
   changes nothing there.

### Fix: dispatch-synchrony flag

- `_emitVirtualStream` sets `stream._inServerDispatch = true` around
  the synchronous `emit("stream")` / `emit("request"/"checkContinue")`
  (try/finally). `write()` routes to `_writeResponse` when
  `_requestEnded || _inServerDispatch || _isPush`, else to
  `_requestChunks`. The client can never write inside that window:
  dispatch runs one microtask after `request()`, and client writes
  happen in user code before/after it.
- `_deliverResponse` clears the flag while emitting `response` /
  `data` / `trailers` / `end` / `close` to client listeners
  (save/restore), so a client write from a `response` handler — nested
  inside a server `end()` inside the dispatch handler — still routes
  to the request body.
- Push streams (`_isPush`) are server→client only; no request body
  exists to write. Without this, `push.write('pushed by server ')`
  lands in `_requestChunks` and `end()` misclassifies the server's
  `end('data')` as the client's end (`_requestChunks.length > 0`),
  so the push response is held forever (`_responsePending`).
- Remaining known limit (comment in code): an async server write that
  lands before the client ends (timer/microtask after dispatch) still
  routes by `_requestEnded` into the request body. No test in the
  94-pass set hits it.

## H2-26-W1 — `connectionWindowSize` + session state + validation

- Validation mirrors Node 26 `lib/internal/http2/core.js`
  `validateSessionOptions` (`validateInt32(...,
  kMinConnectionWindowSize = 1, kMaxInitialWindowSize = 2**31 - 1)`),
  via the shim's `validateInteger(..., 1, 2147483647)`: non-number →
  `ERR_INVALID_ARG_TYPE`; non-integer / out of range →
  `ERR_OUT_OF_RANGE`. Validated in the `Http2Server` constructor
  (covers `createServer` + `createSecureServer`, which calls
  `super(options, ...)`) and in `connect()` before session creation.
- Seeding: client in `connect()` (effective = option; local =
  high-water mark over 65535, as in `setLocalWindowSize`); server
  session in `_getServerSession()` from
  `server._connectionWindowSize`.
- `Http2Session` gains `_remoteWindowSize` (default 65535);
  `state.remoteWindowSize` reads it instead of a constant.
- Peer exchange at dispatch (`_dispatchVirtualStream`): server
  session remote = client's effective local; client session remote =
  server session's effective local. Guarded by `instanceof
  Http2Session` — the host bridge passes a bare `{_virtualPort}`.
- `stream.session` swap: at dispatch the stream's `.session` becomes
  the server session (Node: each side's stream belongs to its own
  session); the client session is kept as `stream._clientSession`
  (set in the constructor and at dispatch). This is REQUIRED for W1:
  the test asserts `stream.session.state.remoteWindowSize ===
  clientWindow` in the server handler and `client.state.
  remoteWindowSize === serverWindow` in the client close handler —
  different values from what must be different objects. Consequences,
  all handled:
  - `pushStream()` uses `_clientSession` for the push stream's
    session, its `'stream'` emit target, and the `:authority` /
    `:scheme` defaults (before this fix the `:authority` resolved to
    `localhost:80` from the server session).
  - `Http2Stream._destroy()` also drops the stream from
    `_clientSession._streams`.
  - `ServerHttp2Session.destroy()` now closes the peer client
    sessions behind its streams (Node: the peer sees `'close'` when
    the socket dies). Without this,
    `test-http2-session-destroy-stream-handler` (88-pass guard) would
    hang: it calls `stream.session.destroy()` in the handler and
    advances rounds on the *client* session's `'close'`.
  - `_getServerSession()` recreates the server session when the
    existing one is destroyed (Node: each connection gets a fresh
    server session); without this, later rounds of that test dispatch
    on a dead session and stall.
- `respond()` honors `options.endStream` (mirrors `request()`):
  trailers-then-`_responseEnded = true` + `_deliverResponse()`.
  W1's `check()` server does `respond({':status': 200}, {endStream:
  true})` and never calls `end()`; without this the response never
  delivers and `req 'close'` never fires. Same gap flipped
  `test-http2-status-code.js` (bonus flip #6).

## H2-26-C1 — compat `getHeaders()` null-prototype store

Per Node 26 `lib/internal/http2/compat.js`:

- Store is null-prototype (`this._headers = { __proto__: null }`),
  so `setHeader('__proto__', 'proto')` stores an own key instead of
  setting the prototype.
- `getHeaders()` returns a fresh null-prototype copy
  (`Object.assign({ __proto__: null }, this._headers)`) — key order
  (integer-likes first) and value identity (shared `set-cookie`
  array) preserved.
- Added `flushHeaders()`: sends with the current status code unless
  already sent (`writeHead()` itself is the closed-stream noop).
- `writeHead()` records `':status'` in the store on send
  (`[kBeginSend]`), so `getHeaders()` after `flushHeaders()` is
  `{ '__proto__': null, 'x-sent': 'value', ':status': 200 }`.

## Triage corrections (evidence over expectation)

- `test-http2-client-data-end.js` DOES flip. The triage/task claim
  ("pushStream honestly rejects with `ERR_HTTP2_PUSH_DISABLED`") is
  wrong for this flow: `enablePush` defaults `true`
  (`getDefaultSettings`), so `pushAllowed` is true and `pushStream`
  proceeds; the push half failed only on write routing (`_isPush`)
  and the `:authority` default. Verified exit 0, 2× isolated + 2×
  differential.
- `util-update-options-buffer` stays untouched (host artifact, per
  task).

## Verification

- Baseline (pristine `10bdfcaa`): 88/289 pass, 198 fail, 3 timeout.
- After, differential run 1: 94/289 pass, 194 fail, 1 timeout.
- After, differential run 2: 94/289 pass, 192 fail, 3 timeout.
  Per-test diff vs base (both runs): exactly the 6 flips above,
  fail → pass; **zero pass → fail**.
- `respond-file-error-pipe-offset` / `respond-file-with-pipe` read
  timeout → fail in run 1 but timeout in run 2 and in isolated and
  concurrent-pair runs on the branch (124). Root cause is a test-side
  race, not this lane: both tests share tmpdir `.tmp.0`
  (`test/common/tmpdir.js`: `.tmp.<TEST_SERIAL_ID || TEST_THREAD_ID
  || '0'>`, unset under the sweep) and `refresh()` does `rm -rf` on
  it, so one test can delete the other's `pipe` fifo mid-run. Both
  are documented NO-FIX (respondWithFile noop) either way.
- Guards re-run isolated 2× on final code, exit 0:
  `zero-length-write`, `server-push-stream-errors-args`,
  `session-destroy-stream-handler`, `server-shutdown-options-errors`,
  `pipe`, `client-upload`.
- Repo jest: `NODE_OPTIONS=--experimental-vm-modules npx --no-install
  jest tests/http2.test.js tests/export_surface_http2.test.js
  tests/ondemand-require.test.js` → 3 suites, **96/96 pass**
  (footprint green; files changed: `src/http2.js` + this note only).

## Ship

- Branch: `fix/http2-26-w3`
- PR: #532
- Merge SHA: `4fffd61e8e269bbd296bbfce3f998803b964b8d5` (squash-merge of PR #532)
- CI waiter: 5 polls x ~40s, pinned to code SHA f89f02d3 — Parity (Node official tests): success, build: success.

## Ship (write-callbacks flip)

- PR: #548
- Merge SHA: `3d52ca2ba766d16f71bee4e5a23e912a6eeb5fb2` (squash-merge of PR #548)
- CI: both jobs completed/success on code SHA e2b08671, single run (poll 4).
- Flip: `test-http2-write-callbacks.js` passing on current main — it was failing at the Nov 18 wave end and was never banked. Surfaced by the http2 engine design study's every-5th sample of the failing set; re-verified isolated 2x on main `f89551e7` (oracle exit 0 2x, shim exit 0 2x). No code change: http2 94/307 → **95/307 (30.9%)**, program 2,373/2,814 → **2,374/2,814 (84.4%)**.
