# NOTES-http-09.md — HTTP/0.9 responses (triage round-2 Lane 12)

Target: `test-http-response-no-headers` (1 -> 0).

## Real Node behavior (probed v24.22.1)

The client parser accepts exactly `{0.9, 1.0, 1.1, 2.0}` as a version
token, on both the request and the response side; anything else is
`HPE_INVALID_VERSION` ("Parse Error: Invalid HTTP version"). Probed
versions: 0.9/1.0/1.1/2.0 accept; 1.2, 2.1, 3.0, 0.8, 0.10, 9.9 reject
(1.10/2.00 fail differently — "Expected space after version" — because
llhttp's version grammar allows a single minor digit; the shim's regex
still rejects them with the same HPE_INVALID_VERSION code, only the
reason text differs, and no official test covers it).

For a 0.9 response (`HTTP/0.9 200 OK\r\n\r\nI AM THE WALRUS`):
`res.httpVersion` is `"0.9"`, major 0, minor 9, statusCode 200,
statusMessage `"OK"`, headers `{}`, rawHeaders `[]`; the body runs to
EOF and `res.complete` is true. `res.shouldKeepAlive` is `undefined`
on real Node — `parserOnIncomingClient` (`lib/_http_client.js:877`)
never sets it; it only downgrades `req.shouldKeepAlive`.

## Root cause

`src/_http_parser.js` `_parseStartLine` rejected every version except
1.0/1.1 with `HPE_INVALID_VERSION`, in both the request and the response
branch. The 0.9 failure surfaced on the client socket's parser facade
(`Socket.onData` -> `HTTPParser.execute` -> `_parseStartLine`).

## Fix (`src/_http_parser.js` only)

Both branches now accept exactly `{0.9, 1.0, 1.1, 2.0}` and record the
real major/minor (`httpVersionMajor: Number(m[1])`, etc.) instead of
hardcoding major 1. The two branches carry the same rule and must stay
in sync (commented as such).

No other change was needed: the response framing already routes a
headerless, unframed response to `body-eof` (body runs to EOF,
`parser.end()` -> `_finishMessage`), and `info.shouldKeepAlive`
(`minor === 1 ? !connClose : connKeepAlive`) is false for 0.9 without
a `Connection: keep-alive` header, so the socket is not pooled and
`'end'` fires. The downstream 1.1-only gates (100-continue auto-ack,
`requireHostHeader` 400) correctly evaluate false for 0.9/2.0.

## Scope limits / follow-ups (not this lane)

- The client round trip hardcodes `msg.httpVersion = "1.1"` at its
  message-creation sites (`src/http.js`, streaming `onHeaders`,
  CONNECT, buffered completion, ...). That predates this lane — even a
  1.0 response reports 1.1 today — so a 0.9 response also reports 1.1
  on the shim while real Node reports "0.9". No official test asserts
  `res.httpVersion` for 0.9 (or 1.0), so threading `info.httpVersion`
  through the round trip is a separate fidelity lane, not this fix.
- `res.shouldKeepAlive` on the shim is `false` for 0.9 (from
  `info.shouldKeepAlive`); real Node leaves it `undefined`. Untested
  either way; same follow-up bucket as above.

## Fixture correction (`tests/http-socket.test.js`)

The repo fixture "bad version -> HPE_INVALID_VERSION" sent
`GET /x HTTP/2.0` — but real Node ACCEPTS 2.0 on both sides (probed
v24.22.1: request `HTTP/2.0` reaches the handler with version 2.0;
response `HTTP/2.0 200 OK` parses with version 2.0) and REJECTS 1.2
on both sides (`clientError: HPE_INVALID_VERSION` request-side,
request `'error': HPE_INVALID_VERSION` response-side). The fixture
encoded the old shim-only rule (1.0/1.1 only). It now sends
`HTTP/1.2`, keeping the test's intent. Precedent: PR #346 also
corrected `tests/http-socket.test.js` fixtures to the probed real-Node
shape; tests/ files are excluded from the footprint allowlist.

## Evidence

- Target 0x2 on branch (base 1 with the exact `HPE_INVALID_VERSION`
  at `src/_http_parser.js:534`); real-Node probe confirms the 0.9
  response shape (`httpVersion "0.9"`, major 0, minor 9, headers {},
  rawHeaders [], body to EOF, complete true, shouldKeepAlive undefined).
- Guards re-verified 26/26 on the branch (parser families,
  TE/smuggling, header families, #336/#344/#346 flips) all 0.
- Jest full suite on branch: 15 failed / 3008 passed. 7 are the known
  host-skew baseline (constants x3, perf_hooks, sys, oracle util +
  crypto); 1 was the bad-version fixture above (fixed, http-socket
  then passes isolated); the rest are load flakes under 11-lane
  contention — timers interval (count 1 instead of 3 in 50ms; the test
  imports only timers, no http path; 16/16 on base), headless-parity
  (2 isolated, both `execution timeout after 30000ms` in the probe
  channel), domain (jest worker SIGKILLed), ws-import-no-hang — all
  pass isolated except the timers interval, which is event-loop
  starvation (3 concurrent fast-sweeps + 2 build-vfs observed).
- Builds on branch: build-vfs 1, sandbox 0, runtime 0. The build-vfs 1
  is the known esm.sh acorn fetch transient, PROVEN with output:
  branch build-vfs fails in untouched `src/specials/bundler.js`
  because esm-sh-plugin cannot fetch `https://esm.sh/acorn?bundle`
  and `acorn-walk?bundle` after retries (log
  `build-vfs-h09-branch2.log`); base build-vfs exited 0 in the same
  window (fetch succeeded then). Intermittent network, not the
  change (which touches only `_http_parser.js` + one test fixture).
  CI build is the real gate.
- Differential: fast-sweep `http-sweep-h09-{base,branch}.csv`:
  branch 369 pass / 7 timeout / 21 fail / 1x134 / 1x139 (2108s, 346
  phase-1 cap-hits under 11-lane contention). Exactly 1 flip
  (response-no-headers 1 -> 0). The 3 extra toward-pass lines
  (server-request-timeout-keepalive, zero-length-write,
  zerolengthbuffer) are base-sweep 124 flakes (post357 = 0, branch = 0)
  — NOT bonus flips. The 4 flagged regressions are all flakes:
  agent-reuse-drained-socket-only 0x2 live main + 0x2 branch,
  same-map 0x2 + 0x2, server-headers-timeout-keepalive 0x2 + 0x2,
  server-headers-timeout-pipelining flaky BOTH sides (branch 0,1,0,0,0;
  live main 0,0,1,0). Zero real regressions, zero mode changes.
