# NOTES: test-https-options-boolean-check (wave 3, lane L11)

Base: origin/main `2079bca0`. Target: 1 flip
(`test-https-options-boolean-check`, 1 -> 0).

## Root cause

`https.createServer({ key, cert })` never validated key/cert/ca types.
Node validates them in `createSecureContext` ->
`configSecureContext` (`lib/internal/tls/secure-context.js:129-213`,
reached from the TLS Server constructor,
`lib/internal/tls/wrap.js:1626`): ca first, then cert, then key;
falsy values skipped (`false` means "none"); arrays unwrapped element-wise;
key-array entries unwrap a `{ pem }` object. Each element goes through
`validateKeyOrCertOption` (`secure-context.js:73-84`): must be a string or
an ArrayBufferView (Buffer / TypedArray / DataView), else
`ERR_INVALID_ARG_TYPE` with Node's exact message.

## Fix (3 files)

- `src/_tls_common.js`: port of `validateKeyOrCertOption` + the
  ca/cert/key walk (validation only), wired into `createSecureContext`
  (the shared path — `tls.createSecureContext` validates too). Error
  suffix rules mirror `src/http.js`'s `ERR_INVALID_ARG_TYPE` factory;
  the compact local renderer is scoped to this call shape (the
  `_tls_common` module stays dependency-free — it cannot import the
  http.js factory).
- `src/https.js`: `HttpsServerBase` constructor calls
  `createSecureContext(this._tlsOptions)` (result discarded — no TLS
  stack exists to hold it); `setSecureContext` validates the same way.
- `src/tls.js`: `Server` constructor calls
  `createSecureContext(this._options)` (Node's tls.Server validates at
  construction, `wrap.js:1626`).

Not ported (no vendored test hinges on it): dhparam/crl/passphrase
validation in the same Node function.

## Verification

- Real-Node probe (`/tmp/probe-l11.js`): exact messages confirmed for
  key=true, cert=1, ca={}, key={pem}, key=[buf,true]; valid + valid-false
  do not throw.
- Target: 1 -> 0 on the branch.
- Differential: fresh full https sweep, base vs branch (see PR).
