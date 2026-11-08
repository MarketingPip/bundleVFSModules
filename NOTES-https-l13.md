# NOTES — wave 3 L13: joint session+SNI+transport (LAST https lane)

## Outcome

+2 flips, 0 regressions, 0 mode changes. https 57/67 → **59/67 — wave-3
ceiling reached** (57 old ceiling + 2 from L12's timeout-server pair
correction; the 8 remaining non-pass are all triage NO-FIX rows).

- `test-https-session-reuse-different-servername.js` 1 → 0
- `test-https-snicallback-override.js` 1 → 0

Differential (fast-sweep.py --target https --force, 67 rows):
base `https-sweep-l12-branch-final-2026-11-07.csv` (a3d98f95: 57 pass /
2 timeout / 8 fail) → branch `https-sweep-l13-branch-2026-11-07.csv`
(59 pass / 2 timeout / 6 fail). Only the 2 target lines changed.
Remaining non-pass: agent-create-connection (124), agent-keylog,
agent-unref-socket, autoselectfamily, client-renegotiation-limit,
connect-address-family (124), resume-after-renew,
selfsigned-no-keycertsign-no-crash — all NO-FIX per triage.

## What was missing (composition, no new mechanism)

Both tests needed L6 (session surface) + L7 (servername threading) +
L12 (raw transport) wired together. The one missing wire: the server
never invoked its `SNICallback`, so the presented peer cert was always
the server's default cert.

- T1 request 2 (servername agent3 + session issued for agent1): the
  server presented agent1's cert, chain verified OK vs ca1, hostname
  check failed → `ERR_TLS_CERT_ALTNAME_INVALID`. Real Node runs the
  SNICallback, presents agent3's cert (issuer ca2), chain vs ca1 fails →
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
- T2: `response.socket.getPeerX509Certificate` did not exist on the
  client (net) socket at all (`TypeError: ... is not a function`).

## Fix (3 files)

- `src/http.js` — `_verifyHttpsPeer` is now `async` (sole call site
  awaited): before picking the peer cert it resolves the SNI-selected
  context via new module helper `_selectSniCert` (port of Node
  `lib/internal/tls/wrap.js:292-315 loadSNI` — no servername / no
  callback means default context; callback error/throw aborts the
  handshake with `sock.destroy(err)`; callback invoked method-style on
  the server; first resolution wins). The selected context's cert comes
  from `context.options?.cert ?? context.cert` (shim `SecureContext`
  keeps the options in `.options`). The presented cert's fingerprint is
  stashed on the socket (`sock._tlsPeerX509Certificate`) regardless of
  the verify outcome — `rejectUnauthorized: false` still delivers a
  response whose socket must report the peer it saw. New helper
  `_tlsFingerprint256` (SHA-256 of the DER, colon-separated uppercase
  hex — format probed on real Node v24.22.1; a Buffer may hold PEM text
  or raw DER, sniffed like `tls-verify.js _pemToDer`).
- `src/net.js` — `Socket.prototype.getPeerX509Certificate()` returns
  `this._tlsPeerX509Certificate ?? undefined`, mirroring the existing
  `getSession`/`getPeerCertificate`/`isSessionReused` surface. The value
  is a plain `{ fingerprint256 }` object — the real fingerprint of the
  real presented bytes, not a fabricated X509Certificate (the shim's
  `crypto.js` X509Certificate is a `makeUnsupported` stub).
- `tests/ondemand-require.test.js` — footprint allowlist: this branch's
  own files only.

## Probes / evidence

- Node source oracle: `wrap.js:294-299` (loadSNI call convention +
  error-destroys-socket), `wrap.js:1272-1275` (getPeerX509Certificate
  returns undefined with no peer cert), fixture issuers (agent3 ← ca2,
  agent1 ← ca1 — confirms the T1 chain-failure expectation).
- Real-Node probe: fingerprint256 == SHA-256(DER) colon-separated
  uppercase hex for agent1-cert.pem and ca5-cert.pem (both match).
- First T2 run after the SNI fix failed on a real bug in my own helper:
  the fingerprint hashed the PEM *text* bytes (`9D:FC:...`) instead of
  the DER — `fixtures.readKey` returns a Buffer of PEM text, and the
  Uint8Array branch assumed raw DER. Fixed with the PEM sniff.
- Guards isolated on the final tree (all 0): set-timeout-server,
  timeout-server, timeout-server-2, strict, pfx, agent-getname,
  client-override-global-agent, agent-session-reuse.
- `tests/ondemand-require.test.js` 29/29; build-sandbox/runtime
  `--check` clean (see ship log below for build-vfs).

## Leftovers (not this lane)

- `TLSSocket.getPeerX509Certificate()` in `src/tls.js` still returns
  `undefined`: a raw `tls.connect` never runs the https peer verifier,
  so no peer cert is plumbed there. No test requires it.
- An `SNICallback` that never calls back hangs the verify await (real
  Node hangs the handshake the same way); no vendored test does this.
- The explicit `options.session` in T1 request 2 is ignored by the
  virtual path (as before): the agent cache (`_peekSession`, keyed by
  servername) is the only resumption route, and with `agent: false`
  there is no cache hit — the full handshake runs, which is exactly
  what the test needs (server can't resume a ticket issued under a
  different servername).

## CI retrigger (notes-only)

- First CI run on 390713bf: Parity success, build failure — sole
  failure was `tests/timers.test.js` "interval fires repeatedly until
  cleared" (10 ms interval fired once, not 3 times, in the 50 ms
  window — load starvation under the CI runner; the `expect` throw
  then also tripped the 30 s `done()` timeout). Untouched module
  (this lane changes http.js/net.js only) and the test passes locally
  in the serial run with the same flags. Transient flake; retriggered
  with this notes-only commit.
