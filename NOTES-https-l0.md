# NOTES — https client vs plain-http server (L0 prerequisite for wave-3 L1)

Base: origin/main 2079bca0. Branch: fix/https-client-plain-http-error.

## Problem

After the L1 harness redirect (http as extra redirect under
PARITY_TARGET=https), `https.get` to a plain-http server gets delivered
to that server instead of erroring: the shared virtual registry
(`_httpShared().registry`, port -> server) carries no protocol marker,
so the shim https client routes via it and the request reaches the http
handler, where test-https-connecting-to-http's mustNotCall fires
(0 -> 1 regression; see hidden_files/https-l1-blocked-2026-11-07.md).
Real Node fails the TLS handshake instead (probed v24.22.1: `EPROTO`,
`write EPROTO ...:SSL routines:tls_validate_record_header:wrong
version number`).

## Fix (2 files, no harness change)

- `src/https.js` — `HttpsServerBase` constructor sets
  `this._isHttpsServer = true`. The registry value can now tell an
  https server from a plain-http one. http.js cannot import https.js
  (circular), so the marker lives on the server.
- `src/http.js` — top of `ClientRequest._performVirtualRequest` (the
  single funnel for registry-server round trips: the buffered virtual
  gate and the streaming `_streamEnsureStarted` path): if `server` is
  non-null, `this.protocol === "https:"`, and `!server._isHttpsServer`,
  throw `makeError("EPROTO", "write EPROTO: wrong version number")`
  before any socket wait. The rejection reaches end()'s handler (or
  the streaming round-trip catch) and surfaces as a single request
  'error'. Factory / raw-net / pipe paths pass `server === null`, so
  they are untouched; the http-client-to-https-server direction is
  unchanged (out of scope).

## Proof

- zz-probe (deleted after use, under parity/node-test/parallel/):
  shim https client -> shim plain-http server (direct src/http.js
  import, same module instance/registry): branch exits 0 with
  `error code=EPROTO message=write EPROTO: wrong version number
  handlerCalled=false`; base exits 124 (request delivered, handler
  never responds, client hangs).
- Positive control: shim https client -> shim HTTPS server still
  delivers (200 ok) on branch.
- Target test isolated on branch:
  test-https-connecting-to-http.js exits 0.
- Full https differential (fast-sweep.py --target https --force,
  fresh filenames): base 27 pass / 6 timeout / 34 fail; branch
  identical — 0 changed lines (connecting-to-http stays 0).
  CSVs: hidden_files/fast-sweep/https-l0-base-2026-11-07.csv,
  https-l0-branch-2026-11-07.csv.

## Flips

0 by design — this lane keeps connecting-to-http at 0 so L1 can ship
on top (+2 flips, 0 regressions). set-timeout-server stays 1 here;
it moves to joint L1+L12 (needs raw TLS transport).
