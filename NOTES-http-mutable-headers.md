# NOTES — http mutable-headers + set-cookies (header PR 4)

Fixes `test-http-mutable-headers` and `test-http-set-cookies`, plus two
bonus flips (`test-http-client-check-http-token`,
`test-http-hostname-typechecking`) that share the same root cause:
`ERR_INVALID_ARG_TYPE` messages did not match Node's shapes.

## Root causes (all `src/http.js` unless noted)

### 1. `set-cookie` is always an array — `IncomingMessage._applyRawHeaders`

Node `lib/_http_incoming.js` `_addHeaderLine`, flag 1 branch: set-cookie is
the one array header — first occurrence sets `[value]`, later ones push.
The shim collapsed a single value to a bare string
(`arr.length === 1 ? arr[0] : arr`), so a client reading a response with
one `set-cookie` saw `'A'` instead of `['A']`
(test-http-set-cookies; also the `response.headers["set-cookie"]` assertion
in test-http-mutable-headers). Fix: first occurrence keeps the array.
Same bug in `_applyRawTrailers` (Node folds trailers through the same
`_addHeaderLine`): first set-cookie trailer was also collapsed to a string.

### 2. `ERR_INVALID_ARG_TYPE` factory did not implement Node's shape

Node `lib/internal/errors.js:1390+` renders the error from one factory:
noun is `"property"` when the name contains a dot (`options.*`), else
`"argument"`; `expected` is bare type names (or an array) joined by the
type/instance/other rules (`of type X`, `one of type X or Y`,
`an instance of X or Y`, `one of A, B, or C`); the suffix is
`invalidArgTypeHelper` (`Received undefined` / `Received null` /
`Received type string ('x')` / `Received an instance of Object` /
`Received function <name>`). The shim's factory hardcoded `"argument"`,
took a pre-rendered `expected` string, used the plain `Error`
constructor (name `Error`, tests want `TypeError`), and rendered
`Received type <typeof> (<String(value)>)` (wrong for undefined/null/
strings/objects). The two paper-over factories
(`ERR_INVALID_ARG_TYPE_PROPERTY` / `_ARGUMENT`) are deleted; all six of
their call sites now go through the single factory with bare types like
Node passes (`boolean`, `number`, `["Headers", "Map"]`,
`["Agent-like Object", "undefined", "false"]`).

Call-site corrections that fell out of the same grounding (all probed on
real Node v24.22.1, all in `ClientRequest`/`ServerBase` construction):
- `validateString` now passes `"string"` (was `"of type string"`), so
  `getHeader()`/`hasHeader()`/`removeHeader()` throw
  `The "name" argument must be of type string. Received undefined`, and
  `options.method` throws the property form.
- Host validation split per Node `lib/_http_client.js:131-135,401-402`
  (`validateHost(hostname)` then `validateHost(host)`, each with its own
  `options.*` name and `['string','undefined','null']` expected) — the
  shim merged them into one `"options.host"` check.
- `options.headers.host` array check renamed to `"options.headers.host"`
  (Node `lib/_http_agent.js:483` `validateString(hostHeader,
  'options.headers.host')`).
- `Server` options check now passes `'object'` (Node
  `lib/_http_server.js:641` `validateObject(options, 'options')`).

## Verification

- Targets exit 0 (×2 each): mutable-headers, set-cookies,
  client-check-http-token, hostname-typechecking.
- Guards: all 12 recent flips (8× PR #345 + 4× PR #347) still 0;
  header families (multiple-headers, host-headers, client-headers-array,
  headers-distinct-proto, request-join-authorization-headers,
  request-host-header, max-headers-count, max-headers-count-overflow,
  server-multiheaders, server-multiheaders2, server-client-error,
  client-error-rawbytes, transfer-encoding-smuggling, chunked) still 0;
  agent keep-alive spot checks still 0.
- Differential (fast runner, base 5387fe4b → branch): see
  `http-sweep-mh-{base,branch}.csv`.
- Full jest: 3059 passed / 7 failed / 1 skipped (known baseline).
- `tests/ondemand-require.test.js` 29/29; builds 0/0/0; dist/ restored.

## Known divergences (not this lane)

- `_invalidArgTypeSuffix` (the `invalidArgTypeHelper` port) truncates
  the inspected form at 28 chars; Node's `determineSpecificType`
  truncates the raw string value first and uses `JSON.stringify` when
  the value contains a single quote, and spells out `-0`/`NaN`/`±Infinity`
  for numbers. No test in this lane (or the suite, as far as the
  differential shows) hits those shapes.
- `writeHead` nested-array form: the set-cookies server path works
  (headers serialize and arrive); no separate nested-array merge gap
  was found beyond the set-cookie folding fixed above.
