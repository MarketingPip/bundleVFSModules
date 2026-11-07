# NOTES — DNS error shape (triage round-2 Lane 18)

Target: `test-http-dns-error` (1 → 0).

## Real Node behavior (grounded in the source pack + controlled probes)

`lib/net.js` v24.20.0: `Socket.prototype.connect` → `lookupAndConnect`
(`:1657`) resolves the host via getaddrinfo inside `net.connect` before
any byte is sent; an unresolvable name fails the connect with the
getaddrinfo error (`ENOTFOUND` / `EAI_NONAME`, `EAI_FAIL`), which reaches
the `ClientRequest` as an `'error'` event via `socketErrorListener`
(`lib/_http_client.js:757`).

Controlled probe on host Node v24.22.1 (`dns.lookup`, not the test's
`http.get` run): the 64-asterisk host fails with `ENOTFOUND`
(`syscall: getaddrinfo`) in 187 ms. The test's own `http.get`/`https.get`
run does NOT reproduce this in this VM — it gives `ECONNRESET` (http)
and `ERR_PROXY_TUNNEL` (https, proxy tunnel timeout) because the sandbox
proxy intercepts real TCP before getaddrinfo matters. That is the known
environment caveat (triage round 2: real Node also fails 6/35 in this
env); the getaddrinfo outcome is what the source + the `dns.lookup`
probe establish, and the shim reproduces exactly that outcome.

## Shim gap

The shim's fetch path (`ClientRequest._performRequest`, `src/http.js`)
dialed the host via undici `fetch`, which rejects with a bare
`TypeError: fetch failed` (`cause: Error: bad port`) that escaped as an
UNCAUGHT exception — the request's `'error'` handler never fired. (Base
run: exit 1, uncaught TypeError at `src/https.js:151` → `_performRequest`
`src/http.js:5250`.)

## Fix (`src/http.js` only, +112)

- `_dnsLookupDefinitiveError(hostname)` (src/http.js:307): a promise of
  the definitive DNS error for a host, or `null` when fetch stays
  authoritative. Malformed names (characters that appear in no DNS name
  and no IP literal: `* /?#@\^|<>\"'` + controls + DEL) answer
  `ENOTFOUND` immediately with no network round trip — getaddrinfo
  reports a malformed name as `EAI_NONAME` without resolving. Deliberately
  narrow: `:` is excluded (IPv6 literals / zone IDs) and so is `%`.
  Otherwise the shim's DoH `dns.lookup` runs: `ENOTFOUND`/`EAI_FAIL`
  pass through, `EFORMERR` (DoH FORMERR for a malformed name) is
  translated to `ENOTFOUND` (getaddrinfo has no FORMERR), and transient
  failures (`EAI_AGAIN`, transport errors) resolve `null` — the browser's
  own resolver may still answer, and the repo's mocked-fetch tests drive
  fetch directly (their DoH lookup fails `EAI_AGAIN` under the mock).
  Identical in-flight lookups are coalesced in `_dnsLookupDecisions`
  (the test fires four requests at one bad host; one DoH walk settles
  in ~7.5 s through this VM's proxy, four concurrent ones never settle
  in 20 s). Only in-flight work is shared — the entry is deleted on
  settle, so a later request re-resolves fresh; no result caching. The
  promise never rejects, so a fetch success that leaves it un-awaited
  cannot become an unhandled rejection.
- The fetch path (src/http.js:5303) starts the lookup IN PARALLEL with
  fetch and consults it only if fetch fails, throwing the definitive
  lookup error instead of the fetch error (src/http.js:5363). Skipped
  for loopback targets (the gates above own them), literal IPs
  (`netIsIP` — Node skips lookup for IPs), empty hostnames, and requests
  with a custom `lookup` option (Lane 8 owns threading those through; a
  default lookup here would pre-empt the custom one).
- ponytail: the lookup runs parallel to fetch, not before it — a
  sequential lookup would add a DoH round trip to every external request
  and would stall the timeout test behind the DoH timeout.

## Scope limits / follow-ups (not this lane)

- Ceiling: if a future test needs `EAI_AGAIN` to surface
  (`test-http-dns-error` retries on it), the decision must also cover
  transport failures — but only with a fetch-error discriminator, or
  `tests/http.test.js` "network failure emits error" (which expects the
  bare fetch TypeError) breaks.
- The https half dials a real host in the test; the shim's lookup-first
  step answers it from the malformed-name fast path with no network
  round trip, so no proxy interception is involved.
- Well-formed but unresolvable names are NOT answered by this lane when
  the DoH lookup is slow or the sandbox gateway resolves everything:
  the `.invalid` probe host resolves via the gateway here
  (`198.18.197.116`), so no vendored test covers that path.

## Verification

- Target: base 1 (uncaught `TypeError: fetch failed`, `cause: bad
  port`), branch 0 (both http and https halves; re-confirmed 0 on a
  second isolated branch run).
- Guards (33 tests, branch): 29 pass; 4 fail, all other lanes' targets
  or known flakes — `test-http-client-request-listeners-leak` (1, L11
  target), `test-http-client-readable` (1, L14 target),
  `test-http-client-leaky-with-double-response` (1, L10 target, live-main
  value 1), `test-http-byteswritten` (124 — re-checked isolated 2x on
  branch AND 2x on base: 124 both sides; 0 in the clean post357 sweep,
  so a load/environment flake under current contention, not a
  regression). Timeout/abort/keep-alive families, #322/#338/#364 flips,
  override-global-agent, request-signal, should-keep-alive: all 0.
- `tests/http.test.js` "network failure emits error": passes (1 passed,
  56 skipped) — the bare fetch TypeError is preserved when no
  definitive DNS error exists.
- Ondemand: 29/29 on branch (allowlist updated to this branch's exact
  footprint: `["NOTES-http-dns-error.md", "src/http.js"]`).
- Builds: sandbox 0, runtime 0, build-vfs 1 on branch AND base —
  identical esm.sh `acorn`/`acorn-walk` fetch failure in untouched
  `src/specials/bundler.js` (environmental transient; CI is the arbiter).
  A `dist/zlib.js` churn from the local build-vfs run was reverted
  before committing.
- Jest full suite (branch): 3054 passed / 12 failed / 1 skipped (7
  failed suites). Baseline is 3059/7/1; the 7 known host-skew failures
  (constants, perf_hooks, sys, oracle crypto/util) account for 7 of the
  12. Extras adjudicated: `timers` "interval fires repeatedly" fails
  identically on base (30 s timeout under load); `timers_promises`
  passes 15/15 isolated on branch AND base (full-suite failure was a
  load flake); `headless-parity` 3 failures (real-runtime probes) — base
  comparison: the same suite fails 3/24 on pristine base too (overlapping
  set: (a) _RUNTIME_ real object, require('path') via loadModule on both;
  third failure churns between (b) sandbox markers and static ESM import
  under load — each probe takes 70–85 s). Pre-existing load flake, not
  a regression; this lane touches only the http fetch path.
- CI (code SHA 7e8a6fa6): Parity success, build failure at the "Build
  VFS" step — the known esm.sh acorn/acorn-walk fetch transient
  (identical failure locally on branch AND base; "Run Tests" step
  passed; no log summary via API). Retriggered with this NOTES-only
  commit after esm.sh answered 200 again.
- Differential (fast-sweep, 397 rows each): base 372 pass / 5 timeout /
  20 fail → branch 359 pass / 19 timeout / 19 fail. Exactly 18 changed
  lines: 1 real flip (`test-http-dns-error` 1→0); `pipeline-requests-
  connection-leak` 124→0 is a base-sweep cap flake (0 in post357, 0×2
  isolated on branch — NOT a bonus flip); 14 toward-fail lines are all
  0→124 branch-sweep timeouts under extreme load (branch phase 1: 350
  cap-hits vs base 223; load 43–47) — every one re-runs 0×2 isolated on
  branch (after-connect, agent-abort-controller, agent-close,
  agent-destroyed-socket, agent-error-on-idle, agent-false,
  agent-free-socket-data-guard, agent-getname,
  agent-keep-alive-timeout-buffer, agent-keepalive-delay, agent-keepalive,
  early-hints-invalid-argument, early-hints, end-throw-socket-handling);
  `server-headers-timeout-keepalive` 0→1 is a known flake (branch 1,0,0,0
  over 4 isolated runs; base 0,1 — flaky both sides, live-main value 0);
  1 mode change (`agent-domain-reused-gc` 1→124, still failing — the
  known NO-FIX test, post357=1). Zero regressions.
