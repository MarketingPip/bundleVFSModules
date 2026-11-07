# NOTES — wave 3 lane L9: TLS socket auth surface (test-https-pfx)

## Fix
- `src/https.js`: new `_setSocketAuthSurface(server, socket)`, called from the
  `HttpsServerBase` wrapped request listener alongside the existing
  `_secureEstablished = true` assignment. Port of Node
  `lib/internal/tls/wrap.js` `onServerSocketSecure` + TLSSocket ctor
  (:651-652): `authorized` starts `false`, `authorizationError` starts
  `null`; only when the server requested a client cert (`requestCert`)
  is the presented cert verified — presented self-signed cert fails
  `DEPTH_ZERO_SELF_SIGNED_CERT`, no presented cert fails
  `UNABLE_TO_GET_ISSUER_CERT`. The virtual world has no CA to verify
  against, so a presented cert can never verify (`authorized` stays
  `false`).
- `src/http.js`: `ClientRequest` records `this._tlsClientCertPresented =
  !!(options.cert || options.pfx)` at construction; the server reads it
  off the loopback peer socket's `_httpMessage` at dispatch. No peer /
  no message means no presented cert (e.g. external `handleRequest`
  traffic).

## Evidence
- Real-Node probe (`/tmp/probe-pfx-real.js`, v24.22.1): requestCert+pfx
  → `false / DEPTH_ZERO_SELF_SIGNED_CERT`; requestCert+no cert →
  `false / UNABLE_TO_GET_ISSUER_CERT`; requestCert:false → `false / null`.
- Shim zz-probe (`zz-pfx-cases.cjs`, deleted after use): all three
  non-test cases match real Node exactly.
- Base: test-https-pfx exit 1 (`undefined !== false` at :47). Branch: exit 0.
- Full https differential (fast-sweep, fresh files, base main `7a82db0e`
  incl. L2/PR #383): base `https-sweep-l9-base.csv` 29 pass / 6 timeout /
  32 fail → branch `https-sweep-l9-branch.csv` 30 / 6 / 31 — exactly 1
  flip (test-https-pfx), 0 regressions, identical timeout set both sides.
- test-https-strict evaluated for this lane and NOT covered (see below):
  still exit 1 both sides (client-side `res.connection.authorizationError`
  undefined vs `'UNABLE_TO_VERIFY_LEAF_SIGNATURE'` at test line 155).

## test-https-strict verdict: NO-FIX (needs real X.509 chain verification)
- The test asserts 16 per-request CLIENT-side `authorizationError` values
  that are a function of (server cert chain: self-signed vs CA-signed +
  which CA) x (client `ca` list) x (hostname/SAN match): e.g.
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (CA-signed, issuer CA not trusted),
  `DEPTH_ZERO_SELF_SIGNED_CERT` (self-signed), `ERR_TLS_CERT_ALTNAME_INVALID`
  (chain verifies, hostname mismatches SAN), `null` (chain + hostname OK).
- Computing those codes honestly requires parsing the server cert and the
  client CA certs and verifying the chain + SANs. The shim has no such
  primitive: `src/crypto.js` `X509Certificate` is an unsupported stub
  (`makeUnsupported`). Any per-fixture shortcut would be hardcoded
  test-targeted fakery (AGENTS.md rules 6-7), not a platform fix.
- This lane's surface is server-side only (server socket, dispatch time);
  the strict values live on the CLIENT socket and need the opposite
  information flow (server cert → client) plus chain math. Not an
  extension of this surface. Strict stays NO-FIX; wave-3 https ceiling
  is 56/67, not 57/67.

## Scope
- No `parity/preload.mjs` / `parity/hooks.mjs` change (L1 territory).
- No real TLS transport (L12). Ceiling: if a real TLS layer ever lands,
  `_setSocketAuthSurface` becomes the handshake verify-result assignment.
