# NOTES — wave-3 lane L8: checkServerIdentity enforcement (2026-11-07)

Targets (4 flips, verified by full https differential base 27/67 -> branch
31/67, exactly 4 changed lines, 0 regressions) — plus a 5th flip found
after the rebase onto main 222fdfa1 (L2/L9/L10 merged): test-https-strict
now passes too (see below), branch 32/67, exactly 5 changed lines.
- test-https-client-checkServerIdentity, test-https-client-reject,
  test-https-simple, test-https-agent-session-injection, test-https-strict.

## What changed

- `src/http.js`: ClientRequest stashes TLS options (`ca`,
  `rejectUnauthorized`, `checkServerIdentity`, `servername`); new
  `_verifyHttpsPeer(server, sock)` runs inside `_performVirtualRequest`
  after socket assignment, before any request bytes reach the server.
  Port of Node `lib/internal/tls/wrap.js` `onConnectSecure`: chain first,
  then identity; failure destroys the socket with the verify error
  (socketErrorListener forwards it to the request); `rejectUnauthorized:
  false` delivers with `socket.authorized === false`. Also ports
  `getAllowUnauthorized` (`NODE_TLS_REJECT_UNAUTHORIZED=0` default +
  once-per-process warning) — required by test-https-client-get-url,
  which regressed without it (0 -> 1) and passes with it.
- `src/tls.js`: `checkServerIdentity` rewritten as a faithful port of
  Node `lib/tls.js` (check() wildcards, splitEscapedAltNames,
  ERR_TLS_CERT_ALTNAME_INVALID with .code/.reason/.host/.cert, exact
  reason strings). Old version had wrong CN-fallback / no-name / IP
  messages and no error code.
- `src/internals/tls-verify.js` (new): minimal X.509 DER parser
  (subject/issuer/SANs) + name-based chain trust
  (`verifyPeerCertificate`: leaf issuer must match a supplied CA
  subject; no CA -> UNABLE_TO_VERIFY_LEAF_SIGNATURE, or
  DEPTH_ZERO_SELF_SIGNED_CERT for a self-signed leaf). Lives in
  internals because the node:tls export surface is pinned exact
  (tests/export_surface_tls.test.js) — new named exports there would
  fail it.

## Design notes / ceilings

- Trust is name-based, not cryptographic: the virtual transport has no
  handshake to verify signatures against. Documented in the code.
- No cert presented (plain http server) skips the check — the existing
  round-trip failure owns that case (test-https-connecting-to-http).
- IPv6 canonicalization is same-form on both sides, not full
  normalization (embedded-IPv4 spellings not normalized).
- Bugs caught by probes, not by guessing: the DER parser's first
  version decoded the ATV SEQUENCE instead of its OID child (empty
  subjects, chain checks passed vacuously); a Buffer holding PEM text
  was treated as raw DER (parse returned null, check skipped).
- Post-rebase bonus (main 222fdfa1): test-https-strict flipped 1 -> 0.
  L2 fixed the wrapper, but strict also exercises verification
  semantics — its remaining failure was this lane's: (a) the identity
  hostname comes from the Host header, not the connect host (port of
  Node lib/_http_agent.js calculateServerName — Host: agent1 means
  check "agent1"; an IP is never a servername); (b) a verified peer
  must read authorizationError === null, not undefined (Node
  lib/internal/tls/wrap.js:652 initializes it to null). Both fixed in
  _verifyHttpsPeer / _calculateTlsServerName; strict is the 5th flip.
- test-https-client-override-global-agent still fails: L3
  (globalAgent rebind) — not this lane.
