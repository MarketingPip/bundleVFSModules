# NOTES — http correct-hostname (kOutHeaders) — PR #359 (triage lane 15)

## Target

`test-http-correct-hostname` (exit 1 → 0). The test requires
`internal/http` (`--expose-internals`) and asserts, for both the `http`
and the `https` module, that `http.request("http://example.com%60x.example.com")`
does not connect and that `req[kOutHeaders].host` deep-equals
`["Host", "example.com`x.example.com"]`.

## Root cause (two halves, one symbol)

1. **http half — symbol identity.** The shim's `OutgoingMessage` stored
   headers under its own module-local `kOutHeaders` (`src/http.js:638`),
   while the test reads `require("internal/http")` — native Node's
   module, whose `kOutHeaders` is a different `Symbol` instance — so
   `req[kOutHeaders]` read `undefined` (test:26).
2. **https half — wrong module.** Under `PARITY_TARGET=http`,
   `require("https")` was NOT redirected, so the test's https request was
   a native `ClientRequest` storing under real Node's symbol — the
   adapter's (shim) symbol could never match it. The http half passing
   while the https half failed at the same line was confirmed with an
   instrumented copy of the test (both halves logged before asserting).

## Fix (3 parts)

1. **Shared symbol** — `kOutHeaders` moved from a module-local const in
   `src/http.js` to `src/internals/http-symbols.js` (same home as
   `kUniqueHeaders`/`kHighWaterMark`), imported by `src/http.js`. No
   behavior change; the symbol now has one source of truth.
2. **`parity/internal-http-adapter.mjs`** (new) — merges real Node's
   `internal/http` with the shim's `kOutHeaders` symbol (same sanctioned
   shape as `parity/http-common-adapter.mjs`, #289): every other member
   (`kNeedDrain`, `kProxyConfig`, proxy helpers, `utcDate`, trace
   functions, `getGlobalAgent`, …) is real Node's. Preload special case
   for `bare === "internal/http"` under the http and https targets.
3. **https extra redirect under the http target** — `isExtraRedirect`
   now returns true for `https` when `target === "http"`, and the
   `https-harness.mjs` branch in `polyfillPath` covers both targets.
   Same precedent as the `net` / `_http_outgoing` / `_http_agent`
   extra redirects (PR #232): the target's tests need the shim's
   module so shared virtual state / symbol identity holds. Only six
   http tests `require("https")` (correct-hostname, default-port,
   dns-error, invalid-urls, request-agent, url.parse-https.request);
   the differential guards the other five.
4. **`_secureEstablished` on https-server sockets** (`src/https.js`,
   `HttpsServerBase`) — the redirect exposed a regression in
   `test-http-url.parse-https.request` (base 0 → branch 1): its handler
   asserts `request.socket._secureEstablished`, which the virtual
   https server never set (no TLS handshake in the browser). Emulated
   handshake: `false` at `connection`, `true` once a request is
   dispatched to the handler (the request listener is wrapped — dispatch
   goes through `emit("request")`, http.js:9739). The `clientError`
   path never dispatches, so its conn stays `false`, matching
   `test-https-timeout-server`'s assertion. That test still fails on
   base for an unrelated reason (real `net.connect` → ECONNREFUSED
   against the virtual port); this change does not touch that path.
   `ponytail:` ceiling — if a real TLS layer ever lands, these become
   the handshake start/completion assignments instead.

## Verification caveat

Real Node ALSO fails this test in this environment (triage 2026-11-06:
the https half hits the VM proxy → `ERR_PROXY_TUNNEL`); the flip was
verified with controlled probes, not the test's real-Node run:
the shim's `req[kOutHeaders]` is byte-identical to real Node's shape
(`{"host":["Host","example.com`x.example.com"]}`, adapter symbol ===
shim symbol) for both halves.

## Guards

All 21 recent flips still 0 (8× #345, 4× #347, 5× #350/#351,
dump-req #353, keepalive-free #355, remove-header pair #357); the
other five `require("https")` http tests: default-port, invalid-urls,
request-agent 0; dns-error still 1 (triage lane 18); https twins
(#354) 0. Full differential: fast-sweep `http-sweep-kh-{base,branch}.csv`
(raw runner diff 6 toward-pass / 0 regressions / 2 mode changes; both
CSVs were recorded under extreme machine load — base 353 pass / 11×124,
branch 359 pass / 5×124 — and every non-target changed line was
adjudicated by direct re-runs: the 5 extra toward-pass rows are
known-passing tests that timed out (124) or failed fast (1) in the base
CSV only and pass 0 in isolation on the branch; the 2 mode changes are
client-leaky-with-double-response 124→1, its true failing state on both
trees 2×2, and server-headers-timeout-keepalive 124→1, flaky 1/0 on
both trees 2×2; client-close-with-default-agent recorded 1 in both
sweeps and passes 0×2 on both trees in isolation). Net: exactly 1 real
flip, 0 regressions, 0 real mode changes. Jest: controlled subset
(headless-parity + oracle + constants + perf_hooks + sys) branch 7
failed = the known baseline exactly; full runs 3054–3057 passed with
the extras all in load-flaky timing suites (headless-parity, timers)
that fail identically on pristine base in the same load window.
Builds: sandbox 0, runtime 0, build-vfs 1 on branch AND base (known
esm.sh acorn fetch transient — environmental).

## Follow-ups (not this PR)

- `test-http-dns-error` (triage lane 18): DNS-lookup-first step in
  `_performRequest`; unchanged by this lane.
- `test-https-timeout-server` (currently 1): real `net.connect` against
  the virtual https port → ECONNREFUSED; needs the net redirect (or a
  virtual-connect path) under the https target — separate lane.
