# NOTES: test-http-response-multi-content-length (fix/http-response-multi-cl)

## Target

`test-http-response-multi-content-length` failed with exit 1 on main
`72f81c74`: the client error code was `HPE_INVALID_CONTENT_LENGTH` where
the test requires `HPE_UNEXPECTED_CONTENT_LENGTH`. The response callback
must never run. Two server shapes are covered: `setHeader("content-length",
[2, 1])` and `writeHead(200, { "content-length": [1, 2] })`.

## Diagnosis (traced, not assumed)

- Rendering was already correct: `pushLine` in `OutgoingMessage._storeHeader`
  emits one wire line per array element, so `[2, 1]` renders as two
  `content-length` lines — exactly what real Node sends (probed below).
- The client parser saw both lines and threw from the conflicting-CL branch
  of `HTTPParser._finishHeaders` in `src/_http_parser.js` — but with the
  wrong code name. The error reached the request's `'error'` event with the
  right `Parse Error` prefix and the wrong code.
- The sibling test `test-http-double-content-length` (server receiving
  conflicting CL from a client) passed only via throw-swallow: its
  `clientError` handler asserted the same wrong code, threw, and the throw
  was swallowed by shim dispatch before `socket.destroy()` ran. The client
  still got its error and the server still closed, so the test passed
  despite the wrong code. That mechanism is now replaced by a clean handler
  run (see below).

## Real-Node probes (v24.22.1, plain script /tmp/probe-multicl-real.js)

- Wire bytes: `setHeader` array and `writeHead` array both render as two
  separate `content-length` lines. Matches the shim.
- Conflicting CL, client and server sides: `HPE_UNEXPECTED_CONTENT_LENGTH`,
  `Parse Error: Duplicate Content-Length`.
- Non-numeric CL (`"abc"`), both sides: `HPE_INVALID_CONTENT_LENGTH`,
  `Parse Error: Invalid character in Content-Length`.
- Same-value duplicate CL (`[1, 1]`), both sides: **also**
  `HPE_UNEXPECTED_CONTENT_LENGTH`. llhttp rejects ANY duplicate
  Content-Length, not just conflicting ones. The shim's old
  `contentLength !== null && contentLength !== value` condition was
  therefore the wrong shape as well as the wrong code.

## Fix (one shared place, src/_http_parser.js only)

In `_finishHeaders`, the duplicate-CL branch now throws
`HPE_UNEXPECTED_CONTENT_LENGTH` / `"Duplicate Content-Length"` whenever a
second `content-length` header is seen, regardless of value equality. This
is simpler than the old condition (one clause deleted) and matches llhttp
exactly, client and server sides at once. The non-numeric branch keeps
`HPE_INVALID_CONTENT_LENGTH` (probed correct).

## Verification

- Target: 1 → 0, three runs.
- Repo test update (required by the fix, not a weakening):
  `tests/http-socket.test.js` had a case literally named
  "conflicting content-lengths -> HPE_INVALID_CONTENT_LENGTH" asserting
  the old wrong code for `Content-Length: 5` + `Content-Length: 6`.
  It now asserts `HPE_UNEXPECTED_CONTENT_LENGTH`, matching the official
  tests and llhttp. Without this update the repo suite reads 3058/8
  instead of the 3059/7 baseline; with it, the suite is back at baseline.
- Allowlist lesson (caught by the rebase, not the first runs): the
  footprint test diffs `origin/main...HEAD` and filters out `tests/`
  files, so `tests/http-socket.test.js` must NOT be in the allowlist —
  the correct set is just the parser + NOTES. The pre-commit ondemand
  passes were vacuous: with HEAD == origin/main the diff was empty and
  the test returns early. The first REAL footprint check ran after the
  rebase commit existed, and it failed until the allowlist dropped the
  tests/ entry. Always re-run ondemand after committing, not just on a
  dirty tree.
- `test-http-double-content-length`: still 0, now via the clean path — the
  handler's assertion passes, `socket.destroy()` runs, the client still gets
  its error, the server still closes. Re-checked, not assumed.
- Same-value duplicate (`[1, 1]`, zz probe, deleted after use): shim now
  reports `HPE_UNEXPECTED_CONTENT_LENGTH`, `Parse Error: Duplicate
  Content-Length` — byte-identical to real Node's error shape.
- Neighbors: server-reject-chunked-with-content-length, invalid-te,
  close-idle, client-reject-chunked, client-reject-cr-no-lf,
  multi-line-headers, client-insecure-http-parser-error, parser,
  parser-bad-ref, common — all 0.
- Full 397 differential, branch vs pristine base `72f81c74`: base
  246/55/96 → branch 247/55/95 — exactly 1 line differs toward pass
  (response-multi-content-length 1→0), zero pass-to-fail, timeouts
  identical. (Absolute base counts vary run to run by sweep-load flakes;
  the matched diff is what matters.)
- Repo jest: 3059 passed / 7 failed / 1 skipped — exactly the host
  baseline. `tests/ondemand-require.test.js` 29/29. `build-vfs` exit 0.
  `dist/` restored, never committed.

## Deliberately left alone

- The non-numeric reason text (`invalid Content-Length: <value>`) still
  diverges from real Node's `Invalid character in Content-Length`. The
  code matches and no test checks the reason text; changing it is a
  separate cosmetic lane, not this fix.
- No rendering change: array CL rendering already matched real Node.
- No docs-number changes (batched syncs own HITLIST/measured-rates).
- This closes the queued `HPE_UNEXPECTED_CONTENT_LENGTH` duplicate-CL
  follow-up item (it was test-covered after all — both tests assert the
  code; the earlier coverage question is answered: covered, and now fixed).
