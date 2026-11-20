# NOTES-26-https-tab — Node 26 Wave 1 lane T-A + T-B

- Base: origin/main `d587825d` at lane start (PR #506 triage merged);
  rebased clean onto origin/main `bb6905b5` before merge (no file overlap;
  dist conflict was the CI-regenerated `dist/*` on the branch, dropped by
  the rebase — CI regenerates it on the new head). Branch: `fix/26w1-https-tab`.
- Banked https count on the Node 26 suite: **58/70**. Post-lane: **60/70**
  (58 + 2 flips, 0 regressions).
- Scope: `NOTES-26-triage-https.md` §T1 + §T3, lanes T-A and T-B only.
  T-C, `test-https-agent-create-connection.js`, and the HELD lane-11 test
  untouched.

## T-A — `test-https-agent-getname.js` (1 flip)

Port of the Node 26 `Agent.getName` encoding (`lib/https.js:520-576`,
`:584-708`) into `src/https.js`:

- `_getTlsOptionKey` — length-prefixed encoding: `s<n>:<str>`,
  `v<n>:<base64>` for ArrayBuffer views, `a<n>:<len>:<item>` for arrays,
  `o<id>` for objects/functions via a module `WeakMap` (ids from 1),
  `n` for null, `''` for undefined. Replaces the stale v24 plain
  `String(value)` join.
- `_getKeyMaterialAgentKey` — `key` (`pem`, strict `!== undefined`) and
  `pfx` (`buf`, truthy) material keys, per-item `:<len>:<item>`.
- `getName` now emits the eight trailing fields added in 26, in Node's
  order: `secureContext`, `allowPartialTrustChain`, `ALPNProtocols`,
  `certificateCompression`, `minDHSize`, `pskCallback`, `requestOCSP`,
  `session` — so `{}` yields `localhost` + 30 colons (was 22).
- Deleted the now-unused module-local `getPfxAgentKey` (only the old
  `getName` called it). `_httpsSessionKey` / `_pfxAgentKey` / `_tlsKeyPart`
  untouched — the session cache keeps its own keying.
- Verified against the Node 26 expected string field-by-field before
  running the test (full-options string reproduces exactly, incl. the
  `a3:7:v1:Yw==:7:v1:cg==:7:v1:bA==` crl encoding).

## T-B — `test-https-selfsigned-no-keycertsign-no-crash.js` (1 flip)

Root cause in `src/internals/tls-verify.js:164` (`_derSubjectAltNames`):
the SAN-extension OID constant was `2.5.5.17` — no such OID; the real
subjectAltName OID is **`2.5.29.17`**. Every extension was skipped, so
`parseCertificate` returned `subjectaltname: ''` for every cert and
`checkServerIdentity('127.0.0.1', …)` failed `ERR_TLS_CERT_ALTNAME_INVALID`.
Fixed the constant and its doc comment (2 lines). The fixture cert does
carry `DNS:127.0.0.1, DNS:localhost, IP Address:127.0.0.1` (verified with
`openssl x509 -ext subjectAltName` + `asn1parse`); unit probe of
`parseCertificate` now returns exactly that string for both string and
Buffer input. The keyUsage-without-keyCertSign shape of the cert is
irrelevant to the parser — the OID typo dropped SANs for all certs; no
other test asserted `subjectaltname`, which is why it went unnoticed.

## Verification

- Flips, 2x isolated each, exact baseline invocation
  (`timeout 30 node --import <worktree>/parity/preload.mjs
  parity/node-test/parallel/<test>`, `PARITY_TARGET=https`, Node 26 test
  tree staged as `run-baseline.mjs` stages it, restored clean after):
  - `test-https-agent-getname.js`: exit 0, exit 0
  - `test-https-selfsigned-no-keycertsign-no-crash.js`: exit 0, exit 0
- Full-module guard via `parity/drift/run-baseline.mjs --modules https
  --jobs 2 --short 10 --full 30` (`/tmp/https-post-csv/node26-baseline-https.csv`,
  `/tmp/https-post.jsonc`): **60/70 pass, 7 fail, 3 timeout**.
  Pass set vs `parity/drift/node26-baseline.jsonc` (58): lost **none**,
  gained exactly the 2 lane tests. Remaining fail/timeout are the
  expected non-lane set: `agent-keylog`, `agent-tls-policy-reuse`,
  `agent-unref-socket` (HELD lane 11), `autoselectfamily`,
  `client-renegotiation-limit`, `empty-write-nested-parser-execute`,
  `resume-after-renew` (fail); `agent-create-connection`,
  `connect-address-family`, `response-tls-error` (timeout).
  - Load note: phase 1 showed 65/70 hitting the 10 s cap (VM load
    average ~17 with other lanes sweeping concurrently); phase 2 at 30 s
    resolved them to the exact baseline outcomes. The 65 phase-1 caps
    are a load artifact, not a regression signal — no test changed
    status vs baseline except the 2 flips.
- Repo suites (host node, `NODE_OPTIONS=--experimental-vm-modules jest
  --roots tests`): `tests/https.test.js` + `tests/tls.test.js` 44/44;
  `tests/http.test.js` + `export_surface_https/tls/__tls_common` 60/60.
  (Bare `jest` without `--roots tests` fails on the vendored Node
  fixtures' intentionally-unparseable `package.json` — pre-existing tree
  quirk, unrelated to this change.)
- `node --check` clean on both edited files. No `// Flags:` header on
  either lane test (checked) — plain baseline invocation applies.

## Files changed

- `src/https.js` (116+/21−): Node 26 `getName` port.
- `src/internals/tls-verify.js` (2 lines): SAN OID `2.5.5.17` → `2.5.29.17`.
- `NOTES-26-https-tab.md` (this file).
