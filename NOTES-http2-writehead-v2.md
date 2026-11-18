# NOTES — http2 writeHead headers-sent throw (H2-V2)

## Ship

- PR #494
- Merge SHA: b60a5401

## Problem

`Http2ServerResponse.writeHead` (`src/http2.js:1372-1395`) set
`_headersSent = true` but never threw on a second call, so
`test-http2-compat-serverresponse-writehead` failed under the shim
while passing natively. The flag was tracked and read
(`:1398/:1402/:1418`) but never guarded inside `writeHead` itself.

## Oracle

Node `lib/internal/http2/compat.js:714-720`:

```js
writeHead(statusCode, statusMessage, headers) {
  const state = this[kState];
  if (state.closed || this.stream.destroyed || this.stream.closed)
    return this;
  if (this[kStream].headersSent)
    throw new ERR_HTTP2_HEADERS_SENT();
```

Error shape from `lib/internal/errors.js:1250`:
`ERR_HTTP2_HEADERS_SENT`, `'Response has already been initiated.'`,
kind `Error`. The oracle checks closed/destroyed (noop, return `this`)
before the headers-sent throw, and the throw precedes all other
`writeHead` work (including status-code handling — the oracle assigns
`state.statusCode` directly with no range check in `writeHead`).

## Fix

`src/http2.js` `writeHead`, one guarded throw at the top of the method,
before the status-message normalization and range validation (matching
the oracle order):

```js
if (
  this._headersSent &&
  !this.stream._closed &&
  !this.stream._destroyed
) {
  throw http2Error(
    "ERR_HTTP2_HEADERS_SENT",
    "Response has already been initiated.",
  );
}
```

The gate matters: the test's final check calls `writeHead(300)` again
after `finish` and asserts it does NOT throw — by then `_deliverResponse`
has set `stream._closed = true` (`src/http2.js:1205`), so the throw is
suppressed. `respond()` is a pure local record and never throws, so the
post-finish call completes harmlessly and returns `this`, as in Node.
Internal callers `write()` / `end()` only call `writeHead` when
`!_headersSent`, so the throw cannot fire from them.

## Probes (pre-fix, worktree `h2-v2`, deleted after use)

`zz-h2v2-probe.js` (parity `writeHead(418)` → second `writeHead(300)` →
post-`finish` `writeHead(300)`):

- Native: `second writeHead threw: ERR_HTTP2_HEADERS_SENT |
  Response has already been initiated.`; post-finish: NO THROW.
- Shim pre-fix: second writeHead: NO THROW (the bug); post-finish:
  NO THROW.
- Shim post-fix: identical to native on all three lines.

## Differential (branch vs pristine main `cb7e82aa`, isolated 2×)

- Target `test-http2-compat-serverresponse-writehead`: branch [0,0] /
  base [1,1] — FLIPPED.
- Guards (0 on branch + base): `test-http2-large-write-multiple-requests`,
  `test-http2-client-upload-reject`,
  `test-http2-compat-client-upload-reject` (H2-F1 flips),
  `test-http2-async-local-storage`, `test-http2-binding`.
- Exactly 1 flip, 0 regressions. Footprint 29/29.

## Count

http2 38 → **39/277**.
