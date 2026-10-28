# NOTES — http server `highWaterMark` option plumbing

## Test

`test-http-server-options-highwatermark` (Flags: `--expose-internals`):
server created with `highWaterMark: getDefaultHighWaterMark() * 2` must
deliver `req._readableState.highWaterMark` and `res[kHighWaterMark]` equal
to that value; a default server must deliver `getDefaultHighWaterMark()`
(65536) for both.

## What was actually wrong (two findings, one root cause)

**Finding 1 — the server option was never stored or forwarded (the fix).**
`ServerBase` never read `options.highWaterMark`. `IncomingMessage` was
constructed with no options (Readable default 65536 regardless of the
server option), and `ServerResponse` called `OutgoingMessage` with no
options, which stored `kHighWaterMark = undefined`. Before: custom server
reported req 65536 / res `undefined`; default server reported req 65536 /
res `undefined`. After: custom (131072) reports req 131072 / res 131072 /
writable 131072; default reports 65536 everywhere.

**Finding 2 — the triage's "layer 1" does not exist when the test runs as
designed (correction of record).** The triage reported
`require("internal/streams/state")` as unresolvable. That probe ran
WITHOUT `--expose-internals`; the real test re-execs itself with that flag
(common prints the NOTE line), and under the flag the native internal
module loads fine through the preload's fallthrough to `Module._load`.
No module-map change is needed: the test uses the NATIVE
`getDefaultHighWaterMark()` (65536) and compares it against the SHIM's
req/res values. The shim's own `src/stream/state.js` already ports
`getDefaultHighWaterMark` for the runtime side.

**Finding 3 — a second, real barrier: symbol identity (the harness line).**
Even with the values fixed, the test still read `res[kHighWaterMark]` as
`undefined`, because the test's `require("_http_outgoing")` resolved to
REAL Node's module, whose `kHighWaterMark` is a different Symbol instance
than the shim's (both are local Symbols, not `Symbol.for`). Proven by
`Object.getOwnPropertySymbols(res)`: the shim symbol WAS set, the real
symbol read `undefined`. Fix: `parity/preload.mjs` redirects
`_http_outgoing` to `src/_http_outgoing.js` for the http target (one line
in `isExtraRedirect`, mirroring PR #232's net redirect). Blast radius is
exactly the two http tests that require `_http_outgoing` (this one and
`test-http-client-highwatermark`); the shim module exports the same keys
the real one does. This is a targeted harness enablement, not a bulk
shared-file change, and it is called out in the PR body.

## Real-Node semantics probed (v24.22.1, before implementing)

- Default: req HWM, req `readableHighWaterMark`, res `kHighWaterMark`,
  res `writableHighWaterMark` all 65536.
- Custom 131072: all four 131072.
- `highWaterMark: 0`: all four 0 (no throw).
- Negative integer: all four fall back to 65536.
- String / null: `createServer` throws `ERR_INVALID_ARG_TYPE`
  synchronously.
- Float: crashes at connection time with `ERR_INVALID_ARG_VALUE`.
- Custom `IncomingMessage` subclass on a custom-HWM server still reads
  the server value (131072) — hence the post-construction set in dispatch
  (subclass constructors take exactly one argument, the socket, per the
  PR #256 contract).

## Fix (`src/http.js` + 1 preload line)

- `ServerBase`: validate the option (non-number →
  `ERR_INVALID_ARG_TYPE` at createServer; non-integer number →
  `ERR_INVALID_ARG_VALUE` at createServer — fail-fast at setup rather
  than a mid-dispatch throw, which would be swallowed into a hang) and
  store the resolved value in `this._highWaterMark` (undefined or
  negative → `getDefaultHighWaterMark(false)`).
- `_dispatchSocketRequest`: post-construction
  `req._readableState.highWaterMark = this._highWaterMark` (uniform across
  default and custom message classes), and
  `new ServerResponse(req, { highWaterMark: this._highWaterMark })`.
- `ServerResponse`: new optional second `options` argument, passed to
  `OutgoingMessage` (sets both the Writable state and the symbol).
- `OutgoingMessage`: `kHighWaterMark` now defaults to
  `getDefaultHighWaterMark(false)` when no option is given (probed real
  Node: client requests also read 65536 by default, so this also fixes
  the client symbol default; no test asserted `undefined`).
- The bridge path (`handleRequest`) keeps `new ServerResponse(req)`; its
  symbol now reads the 65536 default instead of `undefined`, matching
  real Node.

## Results (PARITY_TARGET=http)

- `test-http-server-options-highwatermark`: 124 → **0**.
- `test-http-client-highwatermark`: was exit 1 at Test 1 (symbol assert);
  now passes Tests 1–2 and fails Test 3 only: a 2KB `write()` with
  `highWaterMark: 512` returns `true` instead of `false` (client
  pre-connect write backpressure ignores the threshold). That is a
  SEPARATE root cause in the ClientRequest write path — deliberately out
  of scope here (that region belongs to the concurrent headers-array
  lane) and queued as its own follow-up lane. Not claimed.
- Guards: see PR body (server/agent/keep-alive/chunked/blank-header/
  pipelined/timeout-flip families + `tests/ondemand-require.test.js`
  29/29). Differential on pristine main for the target test: 124.
