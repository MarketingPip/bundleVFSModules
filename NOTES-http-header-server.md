# Header follow-up PR 2 — server requireHostHeader + maxHeadersCount

Base: main `58e1b5eb` (PR #340). Targets failed on base (×3):
`test-http-request-host-header` 124, `test-http-max-headers-count` 124,
`test-http-max-headers-count-overflow` 1.

## Diagnosis (probed real Node v24.22.1 + Node v24.20.0 source)

1. **requireHostHeader — no such option existed in the shim.** Node
   (`lib/_http_server.js:581-587`) validates the boolean option and
   defaults true; the check sits in `parserOnIncoming` (`:1249`): after
   res creation + finish wiring, for HTTP/1.1, `if
   (server.requireHostHeader && req.headers.host === undefined) {
   res.writeHead(400, ['Connection', 'close']); res.end(); return 0; }`
   — BEFORE the maxRequestsPerSocket check and BEFORE Expect routing.
   The test asserts the 400 + `connection: close`, the handler never
   called, and `requireHostHeader: false` → 200.
2. **maxHeadersCount — no pair budget existed anywhere in the shim.**
   Node: `lib/_http_common.js:53` `MAX_HEADER_PAIRS = 2000`, reset in
   `cleanParser` (`:292`); server `lib/_http_server.js:804-805` sets
   `parser.maxHeaderPairs = server.maxHeadersCount << 1` at connection
   time when the property is a number; client `lib/_http_client.js:1098`
   does the same from `req.maxHeadersCount` in `tickOnSocket`. C++
   (`src/node_http_parser.cc` `TrackHeaderPair`) errors
   `HPE_HEADER_OVERFLOW` past the cap, request side only;
   `parserOnHeadersComplete` (`lib/_http_common.js:110-112`) caps the
   delivered headers at `maxHeaderPairs` (client-side truncation).
   The test never exceeds the server limit — it truncates CLIENT-side:
   response of 102 pairs, `req.maxHeadersCount = 20` → 20 keys.
3. **Overflow — no pair limit, so no error to map.** Node's
   `socketOnError` (`lib/_http_server.js:990-1016`): no clientError
   listener + `HPE_HEADER_OVERFLOW` → writes `HTTP/1.1 431 Request
   Header Fields Too Large\r\nConnection: close\r\n\r\n`, then destroys;
   with a listener the handler owns the socket (the test's handler
   writes the 431 itself).

## Probe findings that shaped the fix

- `req.maxHeadersCount = 20` is assigned AFTER `http.request()`
  returns, but the shim's onSocket refresh runs DURING `http.request()`
  (synchronous socket assignment) — the pooled parser still read 2000
  at round-trip time. The limit must be applied at round-trip time,
  not at socket assignment.
- Round 2 of max-headers-count (`server.maxHeadersCount = 0`) arrives
  on round 0's CONNECTION in the shim (no new parser creation logged),
  even though the response carried `Connection: close` — a separate
  agent/loopback divergence (socket reused after a close response;
  real Node would have a new connection and a fresh parser with limit
  0). The server parser's budget is therefore refreshed per message
  in `onMessageStart`; this matches Node's observable behavior in
  every case Node actually creates a new connection for. The only
  divergence is a mid-connection mutation on a keep-alive connection,
  which no official test exercises. Fixing the reuse itself is a
  separate lane (agent/net territory).
- `0 << 1 === 0`, and `maxHeaderPairs <= 0` means no limit on both
  sides (Node `:110-112`, llhttp `TrackHeaderPair`).

## Changes

- `src/_http_parser.js`: export `MAX_HEADER_PAIRS = 2000`; parser
  default `maxHeaderPairs`; request-side throw `HPE_HEADER_OVERFLOW`
  ("Header overflow") in `_parseHeaders` when `maxHeaderPairs > 0`
  and the raw pair count exceeds it; `_finishHeaders` caps the
  DELIVERED headers (`rawHeaders`/`headers`/`headersDistinct`) at the
  cap while CL/TE/connection framing still reads the full list.
- `src/http.js`: import `MAX_HEADER_PAIRS`; `ClientRequest`
  `this.maxHeadersCount = null` (plain property, NOT an option, like
  Node); onSocket pooled-parser refresh + `_socketHttpRoundTrip`
  refresh (threaded `maxHeadersCount` from `_performVirtualRequest`)
  so the client limit applies at send time; server parser budget at
  connection time + per-message refresh in `onMessageStart`;
  `ServerBase` `requireHostHeader` option (non-boolean throws
  `ERR_INVALID_ARG_TYPE`, default true); host-check 400 branch in
  `_dispatchSocketRequest` between the upgrade branch and the
  maxRequestsPerSocket drop branch (Node order), shaped like the 417
  branch; `HPE_HEADER_OVERFLOW` → 431 bytes in the no-listener
  `parser.onError` path.

## Results

- Targets: request-host-header 0×3, max-headers-count 0×3,
  max-headers-count-overflow 0×3 (all 124/124/1 on base).
- Guards green: the 5 PR #340 flips, host-headers, server-keep-alive
  family, server-capture-rejections, parser family, TE family,
  multiheaders (server- forms), client-error family (server- forms),
  agent keep-alive spot checks, server lifecycle, unix pair,
  content-length family, raw-headers.
- Differential (fast-sweep, fresh CSVs `http-sweep-hs-{base,branch}.csv`):
  base 337 pass / 19 timeout / 41 fail (incl. 1×134, 1×139) →
  branch 340 / 17 / 40. Exactly 3 toward pass (the 3 targets above),
  0 regressions, 0 mode changes.
- Post-rebase re-sweep (onto main `811cfb45`, PR #344 joinDuplicateHeaders,
  fresh CSV `http-sweep-hs-branch2.csv` vs the same 337 base): branch
  341 / 16 / 40 — exactly 4 toward pass (the 3 above + #344's
  `test-http-request-join-authorization-headers`), 0 regressions,
  0 mode changes. Targets re-verified 0×3 post-rebase; ondemand +
  http-socket jest 65/65.

## Repo-test fixture fix (same commit)

`tests/http-socket.test.js`: 8 round-trip tests sent Host-less
HTTP/1.1 raw requests and asserted handler behavior — real Node 400s
those (see above), so the fixtures now carry `Host: localhost`.
Intent of each test is untouched (body streaming, 100-continue,
closeAll/closeIdle, maxRequestsPerSocket, HEAD, chunked framing).
The two Host-less requests that still pass without it (`'connection'`
event, `getConnections` — neither asserts handler behavior) were left
alone. `tests/` entries are excluded from the ondemand footprint, so
the allowlist is unchanged.

## Follow-ups (not this PR)

- Connection reuse after a `Connection: close` response (agent/net):
  round 2 of max-headers-count reuses round 0's socket; real Node
  opens a new connection. Worth its own lane — it may explain other
  hangs, and the per-message refresh above papers over it for this
  family only.
- PR 3 joinDuplicateHeaders (`request-join-authorization-headers`);
  PR 4 mutable-headers + set-cookies; PR 5 header-badrequest.
