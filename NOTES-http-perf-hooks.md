# NOTES — perf_hooks `http` entries (triage round-2 lane 17)

Target: `test-http-perf_hooks` (1 → 0).

## Node behavior (grounded in the source pack)

- Client: `ClientRequest.prototype._finish` (`lib/_http_client.js:638-639`)
  calls `startPerf(this, kClientRequestStatistics, { type: 'http', name:
  'HttpClient', detail: { req: { method, url: protocol//authority+path,
  headers: getHeaders() } } })` when `hasObserver('http')`. The matching
  `stopPerf` runs in `parserOnIncomingClient` (`:937-945`) when the final
  response headers arrive (1xx returns early before it; CONNECT/upgrade
  return early too), with `detail.res = { statusCode, statusMessage,
  headers }`.
- Server: `ServerResponse` constructor (`lib/_http_server.js:219-230`)
  calls `startPerf(this, kServerResponseStatistics, { type: 'http', name:
  'HttpRequest', detail: { req: { method: req.method, url: req.url,
  headers: req.headers } } })`; `ServerResponse.prototype._finish`
  (`:248`) calls `stopPerf` with the response detail.
- `startPerf`/`stopPerf`/`hasObserver` live in `lib/internal/perf/observe.js`
  (`:579-608`): start stores `{...context, startTime: now()}` on the target
  under a symbol key; stop builds a `PerformanceNodeEntry` with
  `{...ctx.detail, ...context.detail}` and `enqueue`s it.

## Shim shape

- `src/internals/perf-observe.js` (new): the `perfObserveBridge` holder
  `{ hasObserver, startPerf, stopPerf }`. It exists because the trio cannot
  be named ESM exports of `src/perf_hooks.js` — its export surface is pinned
  to real Node's by `tests/export_surface_perf_hooks.test.js` (exact
  equality). Follows the `src/internals/http-symbols.js` precedent (shared
  truth without leaking it as a named export of a public module).
- `src/perf_hooks.js`: adds the trio as module-internal functions (ports of
  `lib/internal/perf/observe.js`) plus the bridge wiring at import time.
  One deliberate deviation from Node's internal `stopPerf`: the shim deletes
  the stats slot after stopping, so a second headers-complete (a 1xx interim
  then the final response, or a double response) cannot emit a duplicate
  entry. Node's internal keeps the slot but its call sites guarantee a
  single stop; the observable behavior — exactly one entry per
  request/response — is the same.
- `src/http.js`: `_httpPerfStart`/`_httpPerfStop` helpers mirroring Node's
  call-site gating (start only when an `http` observer exists now; stop only
  when a start context exists and an observer still exists). When
  `perf_hooks.js` was never loaded the bridge is empty and both are no-ops.
  - Client start: top of `_performRequest()` — `end()` is its only caller,
    so this is the `_finish` point for both the buffered and the streaming
    paths. `req.url` uses the existing `_buildURL()` (full URL incl. port).
  - Client stop: `_performVirtualRequest`'s `onHeaders` (headers time,
    guarded `statusCode >= 200`); the buffered fallback message creation
    (when `onHeaders` never fired); the fetch path after
    `IncomingMessage.fromFetchResponse` (fetch never resolves with a 1xx).
  - Server start: `ServerResponse` constructor (covers both the socket
    dispatch and the `handleRequest` emulated-inbound path).
  - Server stop: `ServerResponse.end()`'s `done` callback (the Writable
    finish point; guarded once by `_endCallbackFired`).

## The harness redirect (why `parity/preload.mjs` changed)

With `PARITY_TARGET=http` only the target module (plus the `isExtraRedirect`
list) is redirected; `require("perf_hooks")` in the test otherwise resolves
to **native** Node perf_hooks, whose observer can never see shim entries —
the first cut of this lane failed exactly that way (observer callback never
fired, `mustCallAtLeast` 0). Added `perf_hooks` to `isExtraRedirect` for
the http target (one line, PR #232 precedent — same shape as the net/https/
`_http_agent`/`_http_outgoing` redirects). Only `test-http-perf_hooks`
requires `perf_hooks` under the http target, so no other http test is
affected; the differential guards the rest.

## Verification

- Target 0x2 on branch; differential (fast sweep vs clean post-#357 base):
  exactly 1 line toward pass, 0 regressions, 0 mode changes.
- Guards: repo `tests/perf_hooks.test.js` + export-surface tests, the http
  client families, the 1xx family, and the #359/#360/#362-#367 flips — all 0.
- Builds: sandbox/runtime `--check` 0; `build-vfs` 0 (retry on the esm.sh
  fetch transient if it appears — environmental, identical on base).

## Ceiling / not done

- `http2` performance entries are out of scope (separate module, no test
  hinges on them here).
- Entries are only emitted when an `http` observer is registered at both
  start and stop time, matching Node's `hasObserver` gating; a request that
  starts unobserved and gains an observer mid-flight gets no entry.
