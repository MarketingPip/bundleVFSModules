# NOTES — http2 lane H2-F1: missing fixtures (2026-11-18)

Base main: `b938f3c8`. Banked count: 35/277 (parent-verified).

## Gap

Two fixtures the vendored test tree references were absent from
`parity/node-test/fixtures/` while present in the Node v24.20.0 tarball:

- `parity/node-test/fixtures/person-large.jpg` — 139,837 bytes
- `parity/node-test/fixtures/emptyframe.http2` — 4,233 bytes

Five tests fail FIRST on `ENOENT` for one of them, and three upload tests
fail first on a falsy assertion caused by the same missing file
(triage family J, `triage-http2-2026-11-18.md`).

## Fix

Vendored both files verbatim from the Node v24.20.0 tarball
(`hidden_files/node-src/node-v24.20.0.tar.gz`, `test/fixtures/`),
`cmp`-verified byte-identical against the tarball copies:

- `person-large.jpg`: 139,837 bytes, `cmp` OK
- `emptyframe.http2`: 4,233 bytes, `cmp` OK

No `src/` change. No other files vendored — the 11 TLS cert/key files the
triage checked are NOT missing (`readKey` resolves to `fixtures/keys/`,
all vendored there; zero failure logs mention a missing cert).

## Flips (expected 3, verified 2× isolated on branch vs base)

- `test-http2-large-write-multiple-requests`
- `test-http2-client-upload-reject`
- `test-http2-compat-client-upload-reject`

`emptyframe.http2` alone flips 0 — it unmasks
`test-http2-empty-frame-without-eof`'s real failure
(`ERR_HTTP2_TOO_MANY_INVALID_FRAMES` vs ECONNREFUSED, inherent); vendored
in the same lane so the test is measurable.

## Guards

3 passing http2 tests from the triage sweep, run isolated on branch + base:

- `test-http2-async-local-storage.js`
- `test-http2-binding.js`
- `test-http2-clean-output.js`

## Ship

- PR #___
- Merge SHA: ___
