# Connection: close socket reuse — follow-up to PR #346

Base: main `4f663d64` (PR #362). Target: none — this lane closes the
follow-up, not by flipping a test but by removing the paper-over PR #346
left behind once the underlying reuse was fixed by PR #362. No official
test changes value; the differential must show zero changes.

## The arc (probed, not assumed)

1. **PR #346 observed reuse.** Round 2 of `test-http-max-headers-count`
   arrived on round 0's connection (no new parser creation logged), even
   though every response carried `Connection: close`. The fix papered
   over it: the server parser's pair budget is refreshed per message in
   `onMessageStart`, so a mutated `server.maxHeadersCount` still takes
   effect on the reused connection.
2. **Why the socket was pooled (root cause, #346 base).** Two vetoes
   existed in `keepSocketAlive`, and both missed this shape:
   - `socket._responseConnectionClose` was false: the client truncates
     delivered response headers at `req.maxHeadersCount` (20 in round
     0), and `Connection: close` is the 102nd pair — truncated out of
     `msg.headers` before `isConnectionClose` reads it.
   - `socket._httpMessage.shouldKeepAlive` was hardcoded `true` — no
     downgrade from the response's keep-alive verdict existed yet.
   Instrumented agent probe (zz-ccr-probe.js, `keepSocketAlive` +
   `releaseSocket` wrapped from userland) on the #346 base
   (`06ddb727`): `msgShouldKeepAlive=true connClose=false -> POOL`,
   `free=1 destroyed=false`; round 2 reused round 0's socket
   (`client round 2: socket id=1`, `server round: parserSocket id=1`).
3. **PR #362 fixed the reuse.** It computes `shouldKeepAlive` from the
   response's version + Connection header (parser verdict, full header
   list — not the truncated delivered headers) and vetoes pooling when
   it is false (`lib/_http_agent.js:238` shape). Same instrumented
   probe on current main: `msgShouldKeepAlive=false -> DESTROY`,
   `free=0 destroyed=true`; fresh client socket AND fresh server
   connection every round, identical to real Node. The exact
   max-headers-count shape (zz-ccr3.js) matches real Node line for
   line on current main.
4. **The refresh itself diverged (this lane's demonstrated defect).**
   Node reads `parser.maxHeaderPairs` ONCE per connection
   (`lib/_http_server.js:804-805`; the only other write is
   `cleanParser` resetting it to `MAX_HEADER_PAIRS` when the parser
   is freed). On a keep-alive connection, a mid-connection
   `server.maxHeadersCount` mutation must NOT affect the live parser.
   Probed (zz-ccr9.js: keep-alive server, limit 100 → 1 between two
   requests on the same connection, second request 4 header pairs):
   real Node 200 (same socket reused), shim 431 before this change.
   The refresh was the divergence, not a fidelity feature.

## Changes

- `src/http.js` only (comment + deletion, net −13 lines): the
  per-message `parser.maxHeaderPairs` refresh in `onMessageStart` is
  removed; the budget is read once at connection time (unchanged).
  The connection-time comment is corrected to state the rule and cite
  the #362 veto + the 200-vs-431 probe. The client-side per-assignment
  refresh is untouched — it matches Node
  (`lib/_http_client.js:1098-1099`, `tickOnSocket` sets it per
  request), and the client parser is pooled per socket by design.

## Results

- Probe zz-ccr9.js after the fix: shim 200, same socket reused —
  matches real Node.
- Targets: `test-http-max-headers-count` 0, `test-http-max-headers-count-overflow`
  0, `test-http-request-host-header` 0 (all 0 before the change too).
- Guards: agent pool / keep-alive / max-headers families + the
  #359/#360/#362–#367 flips — all 0 (see handoff for the list).
- Differential (fast-sweep, fresh CSVs `http-sweep-ccr-{base,branch}.csv`,
  base `4f663d64` 362 pass / 16 timeout / 19 fail vs branch 367 pass /
  7 timeout / 23 fail, 397 rows each): 17 changed lines, **zero real
  changes**. 10 lines base=124 -> branch=0 are known-passing client
  tests that hit the short cap on the loaded base sweep (all 0,0
  isolated on base). 2 lines base=124 -> branch=1 are the still-failing
  lane-16 / lane-10 targets (`test-http-client-immediate-error`,
  `test-http-client-leaky-with-double-response`, both 1,1 isolated on
  base and branch). 5 lines base=0 -> branch=124/1
  (`test-http-client-timeout-on-connect`, `test-http-outgoing-end-cork`,
  `test-http-pipeline-requests-connection-leak`,
  `test-http-server-headers-timeout-keepalive`,
  `test-http-server-request-timeout-keepalive`) were adjudicated with
  isolated re-runs (2x each side, plus 3x each side for the three
  timeout-flaky names): every one flakes on base too
  (pipeline-requests-connection-leak base 124,0 then 124,124,124;
  server-headers-timeout-keepalive base 0,1 then 1,124,0;
  server-request-timeout-keepalive base 0,0 then 124,124,0) — sweep
  load noise under a ~35-min run, not regressions. Full adjudication
  log: `ccr-adjudication.log` in the goal hidden_files.

## Incidents / lessons

- **The preload redirect only applies under `parity/node-test/`.**
  Probes run from `/tmp` load NATIVE `http` — four early probes
  "proved" fresh sockets on both bases while testing real Node
  against itself. The giveaway: `Agent.prototype` lacked
  `releaseSocket` (native Agent has no such method; the shim's
  `AgentBase` does). Debug probes belong in
  `parity/node-test/parallel/zz-*.js` (deleted after use), never
  `/tmp`, when they must exercise the shim.
- The #346 NOTES' "no new parser creation" observation was real but
  its mechanism was misattributed to the agent/loopback layer in
  general; the precise mechanism is the two missed vetoes above
  (truncation hole + hardcoded `shouldKeepAlive`), both closed by #362.
