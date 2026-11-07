# NOTES-https-agent-getname.md — wave 3 lane L4

## What
Ported Node `Agent.prototype.getName` (`lib/https.js:515-594` + `getPfxAgentKey`
`:491`) onto `HttpsAgentBase` (`src/https.js`). The https agent now appends
the 20 TLS option fields (ca/cert/clientCertEngine/ciphers/key/pfx/
rejectUnauthorized/servername/minVersion/maxVersion/secureProtocol/crl/
honorCipherOrder/ecdhCurve/dhparam/secureOptions/sessionIdContext/sigalgs/
privateKeyIdentifier/privateKeyEngine) after the http base name, in Node's
exact order, plus the per-request `checkServerIdentity` symbol tail
(`lib/https.js:52`, module-local — nothing sets it yet; L8 owns that
threading).

## Proof
- Target `test-https-agent-getname`: base 1 (`'localhost::'` vs
  `'localhost::::::::::::::::::::::'`) → branch 0. Real Node: 0.
- Full https differential (fast-sweep, fresh base + branch CSVs,
  `https-sweep-2026-11-07-l4-{base,branch}.csv`): exactly 1 changed line,
  the target. Base 27/67 → branch 28/67. No regressions.

## For L5 (depends on this lane)
`AgentBase.addRequest` keys `freeSockets`/`sockets` by `getName()`, so https
agents now pool under TLS-suffixed names — free-socket reuse keys must match
these names, not the bare http ones.
