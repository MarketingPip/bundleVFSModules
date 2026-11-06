# NOTES-http-should-keep-alive.md

## Test
`parity/node-test/parallel/test-http-should-keep-alive.js` — 6 cases asserting
`req.shouldKeepAlive` in the response callback: HTTP/1.0 default false,
HTTP/1.0 + `Connection: keep-alive` true, HTTP/1.0 + `Connection: close`
false, HTTP/1.1 default true, HTTP/1.1 + keep-alive true, HTTP/1.1 + close
false. Test uses a raw `net` server writing canned responses;
`http.globalAgent.maxSockets = 5`. Exit 1 on base `d9d0c273`, exit 0 on
real Node v24.22.1.

## Node behavior (source: node-src/lib/)
- Client ctor defaults (`lib/_http_client.js:504-507`, `:579`): shouldKeepAlive
  is false only when the agent opts out AND maxSockets is Infinity, else true;
  no agent → false.
- Downgrade at response headers (`lib/_http_client.js:930-934`,
  `parserOnIncomingClient`): `if (req.shouldKeepAlive && !shouldKeepAlive
  && !req.upgradeOrConnect) { req.shouldKeepAlive = false; }` — comment:
  "Server MUST respond with Connection:keep-alive for us to enable it".
  The verdict comes from llhttp via `parserOnHeadersComplete` →
  `parser.onIncoming` (`lib/_http_common.js:77-125`).
- Server side (`lib/_http_server.js:1203`): `res.shouldKeepAlive = keepAlive`.
- Pooling gate (`lib/_http_agent.js:238`, `releaseSocket`): a socket is
  pooled only if the request that used it is keep-alive; otherwise it is
  destroyed. `responseOnEnd` (`lib/_http_client.js:1030`) likewise
  `destroySoon()`s when `!req.shouldKeepAlive`.

## Shim state before the fix
- The parser ALREADY computed the verdict: `src/_http_parser.js:864`
  `info.shouldKeepAlive = info.httpVersionMinor === 1 ? !connClose
  : connKeepAlive` (1.1 default true unless close; 1.0 default false
  unless keep-alive). Server side ALREADY synced it (`src/http.js:8971`
  `res.shouldKeepAlive = info.shouldKeepAlive`).
- Client side was missing: `OutgoingMessage` ctor hardcoded
  `this.shouldKeepAlive = true` (`src/http.js:675`); `ClientRequest` ctor
  computed it from the agent only (`src/http.js:3434-3440`); it was never
  downgraded when the response arrived.
- `upgradeOrConnect` is never set true in the shim (only `= false` at
  `src/http.js:3563`) — out of scope; the guard is kept in the downgrade
  condition for fidelity.

## Fix (src/http.js only)
1. **Parser-verdict downgrade (streaming path).** In
   `_socketHttpRoundTrip`'s `onHeaders` handler, right after
   `if (this._aborted) return;` and before `emit("response")`, apply
   Node's rule: `if (this.shouldKeepAlive && !info.shouldKeepAlive
   && !this.upgradeOrConnect) { this.shouldKeepAlive = false; }`.
   The response callback (where the test asserts) therefore sees the
   downgraded value.
2. **Thread the verdict to the buffered path.** `pendingResult` gains
   `shouldKeepAlive: info.shouldKeepAlive`; the buffered fallback applies
   the same rule before `_attachResponseTimeout`. CONNECT/101 results
   return early (`result.isConnect` / `result.isUpgrade`), so the buffered
   branch only ever sees normal responses carrying the threaded verdict.
   The fetch path is deliberately untouched (no HTTP version is available
   in a fetch Response).
3. **Pooling veto in `AgentBase.keepSocketAlive`.** `const msg =
   socket._httpMessage; if (msg && !msg.shouldKeepAlive) return false;`
   (Node `lib/_http_agent.js:238`). Without it, an HTTP/1.0-default
   response pooled its socket — no veto fired (no explicit
   `Connection: close`, no keep-alive timeout hint, nothing in flight) —
   so the server connection stayed open and `server.close()` never
   completed: the test hung (exit 124) once the assertion was fixed.
   `socket._httpMessage` is set at assignment (`src/http.js:5061`) and
   cleared only on the CONNECT/upgrade paths, so it is still the completed
   request at release time.
4. **Checkout guard in `AgentBase.addRequest`.** The free-socket reuse
   check already skipped `!socket._handle || socket.destroyed`; it now
   also skips `socket.readableEnded || socket.writableEnded`. The
   server's FIN fires 'end' (installing `writeAfterFIN` in
   `src/net.js:onReadableStreamEnd`) a tick before the pooled 'close'
   removes the socket from the pool — a checkout in that window reused a
   dead socket and the request-head write threw EPIPE (request 3 reusing
   request 1's server-ended socket). Neither half-closed state can ever
   serve a new request head.

## Verification
- Target: exit 0, run twice, on the branch.
- Guards: #345 (8×), #347 (4×), #350/#351 (5×), #353 dump-req, #355
  keepalive-free, #357 remove-header pair, keep-alive families — all 0
  (see PR body).
- Full fast differential vs base `d9d0c273`: exactly 1 line toward pass
  (test-http-should-keep-alive 1→0), 0 regressions, 0 mode changes.
- Jest: 3059 passed / 7 failed / 1 skipped (known baseline).
- Ondemand: 29/29, non-vacuous (footprint NOTES + src/http.js).
- Builds: build-vfs / build-sandbox --check / build-runtime --check all 0.

## Follow-ups (NOT this PR)
- Base-probe discrepancy (recorded, not blocking): a `/tmp` probe showed
  `req.shouldKeepAlive=false` for request 0 on the BASE while the test
  failed with `true !== false` on the same case. The test is ground truth
  (exit 1 base, exit 0 real Node); the probe/base difference is
  unexplained — the probe is not evidence the base was already correct.
- The checkout→write race (FIN arriving between pool checkout and the
  request-head write) is the same race real Node has; out of scope.
