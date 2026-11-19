# NOTES-26-triage-https — Node 26 re-target triage (RE-DISPATCH)

- Worktree: `~/workspace/worktrees/node26-triage-http`, base `3c091022`
  (verified clean at start: `git log --oneline -1` + empty `git status --short`).
- Node 26 binary verified: `~/workspace/local/node-26/bin/node --version` = `v26.13.1`.
  Harness host node = `v24.22.1` (`/usr/bin/node`); Node 26 source pack
  `~/workspace/local/node-26-src/`; v24 source pack in goal `hidden_files/node-src/`.
- Gap list: `hidden_files/node26-triage/gaps-https.json` (parent-verified, not recomputed).
- Method: read every gap test in `node-26-src/test/parallel/`, the Node 26
  `lib/` source for the exercised API, and `src/https.js` / `src/http.js` /
  `src/tls.js` / `src/internals/tls-verify.js`; then isolated re-runs with
  the exact baseline invocation from `parity/drift/run-baseline.mjs`
  (`timeout 30 node --import <worktree>/parity/preload.mjs
  parity/node-test/parallel/<test>`, `PARITY_TARGET=https`), with the Node 26
  test tree staged exactly as `run-baseline.mjs` stages it, restored after
  (`git checkout -- parity/node-test` + deletion of staged-only files;
  verified `git status --porcelain -- parity/node-test` empty).
  Setup note: the worktree had no `node_modules`, so every harness run died
  `ERR_MODULE_NOT_FOUND` until a symlink to
  `~/workspace/bundleVFSModules/node_modules` was added (per
  `run-baseline.mjs` preflight); symlink removed after the runs.
- https context: the shim is a thin wrapper — `src/https.js:1-7` states the
  strategy outright ("TLS is owned by the browser/fetch stack… TLS options
  are accepted and ignored: browsers do not let pages configure TLS…
  no TLS stack exists to hold it"). Anything needing a real handshake,
  real session resumption, or real TLS secrets is NO-FIX by construction;
  the fixable surface is option validation, agent naming, and the
  virtual-handshake checks the shim already emulates
  (`src/internals/tls-verify.js`, `checkServerIdentity` in `src/tls.js`).

## Counts

- Total non-pass: **12** = shim-gap **10** + fails-natively **2** + native-timeout **0**.
- Pre-existing vs new in 26 (vendored `parity/node-test/parallel/` presence):
  **9 vendored / 3 new**. Shim-gap split: **7 vendored / 3 new**.
- Non-gaps (excluded from the 10, listed for completeness):
  - `test-https-autoselectfamily.js` — fails-natively (nativeExit 1).
    Isolated re-run: exit 1, `listen EADDRINUSE :::44068` — the test binds
    the same port on `::1` that its IPv4 server holds on `127.0.0.1`
    (`test-https-autoselectfamily.js:127`); the shim's virtual registry
    keys ports without host. Not a shim gap per the oracle; no lane.
  - `test-https-connect-address-family.js` — fails-natively (nativeExit 1).
    Isolated re-run: exit 124 (hang ≥30 s, empty stderr), reproducing the
    baseline harness result. Not a shim gap per the oracle; no lane.
    (v24 https reference: the lane CSVs under `hidden_files/` are
    lane-scoped, not a full v24 https sweep, so no per-test v24 row exists
    for https — the pre-existing/new split above rests on vendored presence
    + the v24 NOTES files, not on a v24 sweep CSV.)

## Families (shim-gap 10)

### T1. `Agent.getName` re-encoding (Node 26) — 1 test, NEW behaviour

- `test-https-agent-getname.js` (vendored, exit 1): shim returns
  `'localhost::::::::::::::::::::::'` (22 colons), Node 26 expects
  `'localhost::::::::::::::::::::::::::::::'` (30 colons) — 8 new trailing
  fields. Token-diff vs the vendored test: the 26 test rewrites the whole
  expected string and adds cases for `allowPartialTrustChain`,
  `secureContext` (identity), `key: [{pem, passphrase}]`, `ciphers`
  disambiguation, `ALPNProtocols`, `minDHSize`, `pskCallback`, `session`,
  `ca: []`. Reference: Node 26 `lib/https.js:520-551` `getTlsOptionKey`
  (length-prefixed: `s<n>:<str>`, `v<n>:<base64>` for views,
  `a<n>:<len>:<item>` for arrays, `o<id>` for objects via a
  `tlsPolicyObjectIds` WeakMap, `n` for null) + `lib/https.js:554-576`
  `getKeyMaterialAgentKey` + the new trailing fields at `:680-700`
  (`secureContext`, `allowPartialTrustChain`, `ALPNProtocols`,
  `certificateCompression`, `minDHSize`, `pskCallback`, `requestOCSP`,
  `session`). The shim's v24 port (`src/https.js:898`, plain
  `parts.map(_tlsKeyPart).join(':')`, wave-3 L4 per
  `NOTES-https-agent-getname.md`, which records this test PASSING at the
  time) is now stale. Pure-JS port; no TLS needed. Passes as the vendored
  file (isolated re-run exit 0), so this is new-in-26 behaviour.

### T2. Real-TLS NO-FIX — 5 tests

1. `test-https-agent-keylog.js` (vendored, exit 1): `mustCallAtLeast`
   keylog listener expected ≥1, actual 0 (then exactly 10, actual 0).
   The test requires TLS keylog lines from a real handshake; the virtual
   TLS layer has no TLS secrets to log. No browser equivalent.
2. `test-https-agent-tls-policy-reuse.js` (NEW, exit 1):
   `Error: unable to verify the first certificate`
   (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `src/internals/tls-verify.js:288`)
   on the first request — and the test's core assertions are
   `res.socket.isSessionReused()` across TLS-policy changes
   (`ca: []`, alternate `secureContext`, `allowPartialTrustChain`), i.e.
   real session resumption + real chain verification. The `getName`
   half (same policy ⇒ same name, incl. `ca: []` distinguishing) is
   lane T-A's encoding; the session-reuse behaviour cannot be emulated
   without a real handshake. NO-FIX as a test.
3. `test-https-client-renegotiation-limit.js` (vendored, exit 1):
   `TypeError: client.renegotiate is not a function` at `:106` — and the
   test then requires the server to error `TLS session renegotiation
   attack` after `tls.CLIENT_RENEG_LIMIT` (3, `src/tls.js:141`) spam
   renegotiations. Real renegotiation-handshake counting; a stub
   `renegotiate` (which exists on the shim's `TLSSocket`,
   `src/tls.js:542`, reporting success) cannot produce the server-side
   attack error, and `res.socket` here is not a `TLSSocket` anyway.
   NO-FIX.
4. `test-https-empty-write-nested-parser-execute.js` (NEW, exit 1):
   `RangeError: Port should be >= 0 and < 65536. Received undefined`
   at `TLSSocket.connect` (`src/tls.js:320`) from
   `tls.connect({socket: batch, …})` (`:79`). The test is about TLS-record
   re-entrancy: a zero-length write synchronously reads the next TLS
   record while the HTTP parser is inside `on_body`, corrupting request
   2's body. There are no TLS records in the virtual layer, so the
   premise cannot be reproduced. NO-FIX (the `RangeError` is only the
   first visible symptom).
5. `test-https-resume-after-renew.js` (vendored, exit 1):
   `TypeError: Cannot read properties of undefined (reading 'context')`
   at `:23` — `server._sharedCreds.context.enableTicketKeyCallback()`.
   `_sharedCreds` is Node's internal TLS shared-credentials object; the
   shim has no TLS stack to hold one. NO-FIX.

### T3. TLS-agent / virtual-server gaps — 4 tests

- `test-https-selfsigned-no-keycertsign-no-crash.js` (vendored, exit 1):
  real shim bug, not inherent. The client connects to `127.0.0.1` with
  `ca: <self-signed cert>` and must succeed (nativeExit 0). The shim
  failed it with `ERR_TLS_CERT_ALTNAME_INVALID` (`src/tls.js:1036`) and
  a parsed cert of `subjectaltname: ''`. But the fixture cert DOES have
  SANs — `openssl x509 -ext subjectAltName` on
  `test/fixtures/keys/selfsigned-no-keycertsign/cert.pem`:
  `DNS:127.0.0.1, DNS:localhost, IP Address:127.0.0.1`. So the shim's
  DER parser (`parseCertificate`, `src/internals/tls-verify.js:219-260`)
  drops the SAN extension for this cert (its keyUsage lacks keyCertSign,
  which is the point of the test — the parser must not choke on it).
  Lane: fix SAN extraction in `parseCertificate`. Control probe on real
  Node 26.13.1: `tls.checkServerIdentity('localhost', {CN:'localhost',
  subjectaltname:''})` → `undefined` (pass); `'127.0.0.1'` → error —
  confirming the shim's failure is the missing SANs, not the hostname.
- `test-https-response-tls-error.js` (NEW, exit 124): hang ≥30 s, empty
  stderr. The test writes a partial body, then injects an invalid TLS
  record and requires error propagation to the response/client
  (TLSv1.2 + TLSv1.3 loops). No TLS record layer exists to inject into,
  so the mechanism is unproven — lane H-D (http `response-socket-error`)
  upside only; diagnose first.
- `test-https-agent-create-connection.js` (vendored, exit 124): hang
  ≥30 s, empty stderr. Uses a custom `agent.createConnection` factory
  writing raw `GET / HTTP/1.1` bytes over the created socket. Mechanism
  unproven — diagnose-first, no lane yet.
- `test-https-agent-unref-socket.js` (vendored, exit 1) — HELD (lane 11):
  the parent forks a real child (`fork(__filename, ['localhost', port])`)
  which does a real `https.get` against the parent's shim `net` server →
  `ECONNREFUSED` from `src/net.js:307` (real child cannot see the virtual
  registry). Same class as http H4. Fails on the vendored file too, so
  the v24-era PASS (`NOTES-https-parity.md` lists `agent-unref-socket`
  among the 20 passing) is stale, not a 26 regression.

## Lane candidates (conservative flips)

| Lane | Tests | Est. flips |
|---|---|---|
| T-A Port Node 26 `getName` encoding | `test-https-agent-getname.js` | **1** |
| T-B Fix SAN extraction in `parseCertificate` | `test-https-selfsigned-no-keycertsign-no-crash.js` | **1** |
| T-C (joint with http H-D) Response error propagation | `test-https-response-tls-error.js` (upside; hang, diagnose first) | **0** (upside 1) |
| Diagnose-first, no lane yet | `test-https-agent-create-connection.js` (hang, mechanism TBD) | — |
| **Total conservative** | | **2** (+1 upside, +5 NO-FIX, +1 HELD, +1 diagnose-first = 10) |

## NO-FIX (probe evidence only) — 5 tests

`test-https-agent-keylog.js`, `test-https-agent-tls-policy-reuse.js`,
`test-https-client-renegotiation-limit.js`,
`test-https-empty-write-nested-parser-execute.js`,
`test-https-resume-after-renew.js` (T2 above, one line each: no TLS
secrets / no real session resumption or chain verification / no real
renegotiation handshake / no TLS record layer / no internal `_sharedCreds`).

## HELD — lane 11 (design decision, not a fix lane) — 1 test

`test-https-agent-unref-socket.js` (T3 above).

## Baseline corrections

1. **Zero flips on isolated re-run.** All 12 https gap-test outcomes
   reproduce exactly at 30 s with the baseline invocation. The three
   baseline `124`s (`agent-create-connection`, `connect-address-family`,
   `response-tls-error`) all hang again in isolation — real shim hangs,
   not sweep-load flakes. (Empty log + exit 124 = hang, not pass.)
2. **Vendored-vs-26 adjudication:** `test-https-agent-getname.js` passes
   as the vendored file (exit 0) and fails as the Node 26 file — real
   test change (token-diff), new-in-26 behaviour. `test-https-agent-unref-socket.js`
   fails on the vendored file too — its v24-era PASS is stale.
3. **No per-test v24 https sweep CSV exists** (the `hidden_files/`
   `https-sweep-*.csv` files are lane-scoped base/branch pairs, e.g.
   `https-sweep-nl-base.csv`, 66 rows, none of the 12 gap tests in it),
   so the https pre-existing/new split cannot be grounded in a v24 sweep
   the way http's can (`http-sweep-2026-11-04.csv`); it rests on vendored
   presence + the v24 NOTES files. The coordinator may want a v24 https
   reference sweep if exact v24-vs-26 per-test deltas are needed.
4. **No export-surface change for https** (`parity/drift/node26-export-diff.md`:
   https has NO added/removed exports), consistent with the finding that
   the https gaps are behaviour/internals, not missing exports — unlike
   http, where 4 of 30 gaps are the 4 new exports.
