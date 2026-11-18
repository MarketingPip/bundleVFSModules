# NOTES — http2 `connect()` authority normalization (H2-V5)

## Problem

`connect()` did `new URL(authority)` with no normalization
(`src/http2.js:1766` pre-fix). A `URL` instance or a string worked, but a
`url.parse()` result or a plain `{ port[, hostname] }` options object threw
synchronously:

```
Error: Invalid URL: [object Object]   (code ERR_INVALID_URL)
```

`test-http2-create-client-connect` uses all five authority forms in one
test (string, `URL`, `url.parse()` result, `{port}` + options,
`{port, hostname}` + options) and failed first on the `url.parse()` form.

## Oracle

Node `lib/internal/http2/core.js:3634-3704` (`connect`):

- `typeof authority === 'string'` → `new URL(authority)`; then
  `assertIsObject(authority, 'authority', ['string', 'Object', 'URL'])`.
- `protocol = authority.protocol || options.protocol || 'https:'`.
- `port = '' + (authority.port !== '' ? authority.port :
  (authority.protocol === 'http:' ? 80 : 443))`.
- `host`: `authority.hostname` (brackets stripped) else `authority.host`,
  else `'localhost'`.
- `http:` → `net.connect`, `https:` → `tls.connect`, else
  `ERR_HTTP2_UNSUPPORTED_PROTOCOL`.

## Probes (native vs shim, `zz-h2v5-probe.js`, deleted after use)

Native (host v24.22.1), plain server on an ephemeral port:

- string / `URL` / `url.parse()` / `{port}` + `{protocol:'http:'}` /
  `{port, hostname:'127.0.0.1'}` + `{protocol:'http:'}` → all `connect`.
- `{port, protocol:'https:'}` against the plain server → `error
  code=ECONNRESET msg=read ECONNRESET`, then `close`.

Shim pre-fix: `url.parse()`, `{port}` + opts, `{port, hostname}` + opts,
and the mismatch form all threw synchronously
`ERR_INVALID_URL: Invalid URL: [object Object]`; string and `URL`
connected.

Shim post-fix (probe re-run): all six forms behave exactly like native —
five `connect` + `close`, mismatch `error code=ECONNRESET` + `close`.

### No-port edge (probe-proven, `zz-h2v5-edge.js`, deleted)

The oracle's port line is literal and observable: a `url.parse()` result
with no port yields the string `"null"`, a plain object with no port
yields `"undefined"`, and `net.connect` rejects synchronously:

```
url.parse("http://localhost")  → SYNC THROW ERR_SOCKET_BAD_PORT,
  "Port should be >= 0 and < 65536. Received type string ('null')."
{hostname:'localhost'} + {protocol:'http:'} → SYNC THROW
  ERR_SOCKET_BAD_PORT, "... Received type string ('undefined')."
{port: 1} (no protocol) → protocol defaults to 'https:' → async
  ECONNREFUSED + close.
```

The shim mirrors the throw (same code + message shape).

## Fix (`src/http2.js` only)

- `normalizeConnectAuthority(authority, options)` (new, before
  `connect()`): string/`URL` → `new URL(...)`; object → build
  `protocol//host:port` from the fields (`protocol` from
  `authority.protocol || options.protocol || 'https:'`; non-`http:`/`https:`
  protocol throws `ERR_HTTP2_UNSUPPORTED_PROTOCOL`, mirroring the oracle's
  switch; port `''` → default by `authority.protocol`, present port used
  as-is, missing port throws `ERR_SOCKET_BAD_PORT` as above; hostname from
  `authority.hostname` (brackets stripped) else `authority.host` split
  into hostname + port, else `'localhost'`; IPv6 hostnames re-bracketed).
- `connect()` uses it, then the existing protocol check / session setup
  is unchanged.
- TLS/plain mismatch: the `queueMicrotask` that emits `'connect'` now
  first checks the exactly-registered server for the port
  (`serverRegistry.has`, NOT `lookupServer` — the first-server fallback
  must not misfire): if the server's secure-ness differs from the
  session's `encrypted` flag, `session.destroy()` with
  `ECONNRESET / "read ECONNRESET"` (errno -104, syscall "read") —
  emits `'error'` then `'close'`, matching native. If no server is
  registered for the port, behavior is unchanged (emits `'connect'`).

## Differential (branch vs pristine base `c7cc2bb5`, isolated 2×)

- Flip: `test-http2-create-client-connect` — branch [0,0] / base [1,1].
- `test-http2-window-size` moves past the throw as the triage predicted
  (now fails on a `mustCall` at test:118, live-state family B) — NOT
  counted as a flip.
- Guards, all 0 on branch AND base (44 tests): the 35 triage pass-set
  tests + the 9 prior-lane flips (F1 ×3, V2 ×1, V3 ×2, V1 ×3).
- Footprint: 29/29. Repo jest http2 suites: 67/67
  (`tests/http2.test.js` + `tests/export_surface_http2.test.js`).
- New count: **44 + 1 − 0 = 45/277**.

## Untested edges (noted, not lanes)

- Non-numeric `authority.port` (e.g. `'abc'`) in an object authority:
  native throws `ERR_SOCKET_BAD_PORT`; the shim routes it through the
  virtual port as `NaN` and the request later fails `ECONNREFUSED`.
  No vendored test covers it.
- `options.createConnection` / `maxOriginSetSize` / `remoteCustomSettings`
  validation in the oracle's `connect()` are ignored by the shim, as
  before; the `.mjs` `maxOriginSetSize` half belongs to lane H2-V4.

## Ship

- PR #___
- Merge SHA: ___
