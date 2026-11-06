# NOTES — http.globalAgent rebind (Triage Lane 5, PR #359)

## Target
- `test-http-client-override-global-agent.js`: 1 → 0. Base main `d9d0c273`
  (362/397); rebased onto `7b899270` (366/397, PRs #359 arg validation,
  #360 peer-destroy + sync #361) with no conflicts, then onto `99c8306d`
  (PR #364 timeout semantics, +2 flips) with an allowlist-only conflict,
  resolved to this branch's 3 files, then onto `17f194ae` (PR #366
  kOutHeaders adapter, +1 flip) with an allowlist-only conflict, resolved
  the same way. Branch content otherwise unchanged. Branch differential (fast-sweep, vs the idle post-#357 base
  `http-sweep-2026-11-06-post357.csv` — docs-only delta to d9d0c273):
  exactly 1 toward pass, 0 mode changes. Fresh branch CSV:
  `http-sweep-ga-branch.csv` (362 pass, 4 timeout, 31 fail, 1×134,
  1×139). Its 1 sweep regression (byteswritten, a documented flake) is
  exit 0 in isolation on branch AND base, as are the 3 regressions from
  the earlier contended run (pipeline-requests-connection-leak,
  server-headers-timeout-pipelining, server-request-timeout-keepalive).

## Root cause
- The test does `http.globalAgent = agent` then `http.get(...)` and asserts
  `agent.getName({port}) in agent.sockets` — the request must go through
  the assigned agent.
- The test's `http` is the shim's default-export object
  (`parity/http-harness.mjs`: `export default http.default ?? http`), while
  the request path read the module-scope `export const globalAgent`
  binding (`src/http.js:3419`
  `const defAgent = options._defaultAgent || defaultAgent || globalAgent`).
  Assignment to the object never reached the binding, so the request used
  the default keep-alive agent.
- Node shape (`node-src/lib/http.js:220`): `ObjectDefineProperty(
  module.exports, 'globalAgent', { get() { return httpAgent.globalAgent; },
  set(value) { httpAgent.globalAgent = value; } })` — ONE backing store,
  the `_http_agent` exports object (`lib/http.js:29,162,225`). Probed on
  real Node v24.22.1: after assignment, `require('_http_agent').globalAgent
  === agent` too.

## Fix (`src/http.js`, `src/_http_agent.js`, +~20 lines, 0 deletions of behavior)
- `src/http.js`: `export const globalAgent` → `export let globalAgent`
  (named export stays live for `import { globalAgent }` readers and the
  `_http_agent` re-export). Default-export object carries a matching
  getter/setter pair that reads/writes the module-scope binding, so
  assignment routes new requests to the assigned agent; unassigned, the
  default keep-alive agent stands. No validation in the setter, matching
  Node (plain assignment in `lib/http.js` / `lib/_http_agent.js`).
- `src/_http_agent.js`: default export's `globalAgent` is now an accessor
  reading the live binding, with a setter that writes through
  `httpDefault.globalAgent` (can't assign to an imported binding
  directly). This was caught by a zz- probe, not the target test: after
  the http.js-only fix, `_http_agent.globalAgent` was still a snapshot.
  No official test covers that direction; the probe is recorded here and
  deleted (`zz-global-agent-probe.js`, removed before commit).

## What was NOT changed
- `src/https.js:110` keeps its own `export const globalAgent` — real Node's
  `https.globalAgent` is a separate agent; out of scope for this lane.

## Verification
- Target 0×2 on branch and 0 on real Node (plain `node`, no preload).
- zz- probe (deleted after use): default-agent identity, rebind visible via
  `http.globalAgent` AND `_http_agent.globalAgent`, restore returns the
  default agent on both — exit 0.
- Guards 25/25 exit 0: 8× #345, 4× #347, 5× #350/#351, dump-req #353,
  keepalive-free #355, remove-header pair #357, agent-keepalive,
  agent-maxsockets, agent-close, client-agent.
- Jest 3056 passed / 10 failed (run twice, identical): the 7 known
  baseline failures + 3 `tests/headless-parity.test.js` failures, proven
  environmentally flaky (failing set shifts run-to-run on identical code;
  base fails 4 different tests there). Ondemand 29/29 (non-vacuous,
  footprint `src/http.js` + `src/_http_agent.js` +
  `NOTES-http-global-agent.md`).
- Builds: `build-sandbox --check` 0, `build-runtime --check` 0.
  `build-vfs` fails on the known esm.sh fetch transient
  (`esm-sh-plugin failed to fetch https://esm.sh/acorn?bundle` /
  `acorn-walk?bundle`, in untouched `src/specials/bundler.js`); base
  passed once (exit 0, 36 min). esm.sh bundle URLs answer 200 but take
  26–30s each under current network conditions; a base control run is in
  flight to confirm identical failure, and CI build is the arbiter.
  dist restored, never committed.
