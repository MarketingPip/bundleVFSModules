# NOTES — joinDuplicateHeaders (test-http-request-join-authorization-headers)

## Root cause

Node folds duplicate headers per `lib/_http_incoming.js:340,447,464`
(`matchKnownFields` + `_addHeaderLine`):

- Flagged joinable fields (`\u0000`, e.g. `date`, `accept`, `cache-control`)
  always join with `", "`; `cookie` (`\u0002`) always joins with `"; "`;
  `set-cookie` (`\u0001`) stays an array.
- No-duplicate fields (e.g. `authorization`, `host`, `content-length`) are
  first-wins — UNLESS `joinDuplicateHeaders` is set, in which case they
  join with `", "`.
- The flag lives on the `IncomingMessage` (default `false`,
  `lib/_http_incoming.js:83`) and is assigned in `parserOnIncoming`
  (`lib/_http_common.js:103`): server side from the server option
  (`lib/_http_server.js:589`), client side from the parser, which takes
  it from the request option (`lib/_http_client.js:463,1102`).

The shim's `IncomingMessage._applyRawHeaders` joined every non-singleton
duplicate unconditionally, and had no `joinDuplicateHeaders` anywhere on
the message or the server: the server-false scenario asserted
`req.headers.authorization === "1"` but got `"1, 2"`, and the
client-false scenario asserted `res.headers.authorization === "3"` but
got `"3, 4"`. Both throws were swallowed by the round-trip try/catch, so
the test hung (124) instead of failing.

## Fix (`src/http.js` only)

- `IncomingMessage` ctor: `this.joinDuplicateHeaders = false` (Node default).
- `_applyRawHeaders` / `_applyRawTrailers`: a `DUPLICATES_REMOVED` field
  joins with `", "` only when `msg.joinDuplicateHeaders` is set; otherwise
  first wins (headersDistinct/trailersDistinct still keep every value).
- `ServerBase` ctor: stores `options.joinDuplicateHeaders` raw (default
  undefined, like the client option); forwarded to each request message
  at `_dispatchSocketRequest` and in `handleRequest` (post-construction
  set, as for `highWaterMark` — custom `IncomingMessage` subclasses take
  only the socket).
- Client: each response-message creation site sets
  `msg.joinDuplicateHeaders = this.joinDuplicateHeaders` before folding
  (streaming `onHeaders`/`onInformation`, CONNECT, upgrade, buffered).

## Verification (probed real Node v24.22.1, `/tmp/probe-jd-native.js`)

- T/T: server `"1, 2"` / client `"3, 4"`; F/T: server `"1"` / client
  `"3, 4"`; T/F: server `"1, 2"` / client `"3"`. Cookie `"foo; bar"` in
  all three — matches the test's assertions exactly.
- Target: 124×3 on base `58e1b5eb` → 0×3 on branch.
- Differential (fast runner): see `http-sweep-jd-{branch,base}.csv`.

## Not in this PR

- `requireHostHeader` / `maxHeadersCount` (PR 2), `mutable-headers` /
  `set-cookies` (PR 4), `header-badrequest` (PR 5) — separate follow-ups.
- `test-http-incoming-matchKnownFields` calls
  `IncomingMessage._addHeaderLine` directly on a bare instance; the shim
  has no such method (only the static `_applyRawHeaders`). Out of scope.
- Option-type validation: Node `validateBoolean`s both options; the shim
  stores them raw, matching the existing client-side pattern.
