# NOTES — wave-3 lane L7: SNI / servername threading

Target: `test-https-agent-sni` (1 flip). Base: main `2079bca0`; rebased onto
`222fdfa1` (PRs #383 L2, #388 L9, #389 L10) before ship — the rebase
conflicts were the allowlist line and the `_agentOptions` threading
block (L10's `highWaterMark` vs this lane's `servername`, both kept).

## What the test does

Five parallel `https.get` calls through one `https.Agent({maxSockets: 1})`
with servernames `sni.0`…`sni.3` and `""`; the handler sets `x-sni` from
`req.socket.servername` (4th handler calls `server.close()`). All five
responses must arrive; the `""` case must see `servername === false`.

## Four mechanisms (one flip needed all four)

1. **SNI threading (`src/http.js`)** — the lane's named mechanism.
   `ClientRequest` stashes the raw option (`this._servername`); module-level
   `_effectiveServername(req)` ports Node's `normalizeServerName` /
   `calculateServerName` (`lib/_http_agent.js:474-504`): explicit value wins
   (including `""` = send no SNI), else Host-header host, else request host;
   IP literals → `""`. `_performVirtualRequest` passes it (https only) into
   `_socketHttpRoundTrip`, which queues it on `sock._pendingServernames`
   (a queue, not a field — the agent may reuse one socket for requests
   with different servernames). `_dispatchSocketRequest` shifts one value
   off the peer's queue when `this._tlsOptions !== undefined` (the
   https-server marker) and sets `socket.servername` to the string or
   `false`. Plain http servers never set it. SNICallback is NOT invoked
   here — that is L13's composition work.
2. **Pool separation by servername (`src/https.js`, `src/http.js`)** —
   minimal form of L4's mechanism, not the full L4 port. Node's
   `maxSockets` is per pool, and its https `getName` appends servername
   (`lib/https.js:547-548`). Without this, all five requests share one
   pool slot, serialize, and the 5th socket does not exist until after
   the 4th handler's `close()` (lookup then fails ECONNREFUSED).
   `HttpsAgentBase.getName` appends `:${servername}` when truthy;
   `ClientRequest` threads `servername` into `_agentOptions` (same
   field-by-field pattern as `lookup`/`family`). Truthy only: Node joins
   an absent/empty servername as an empty field, so `""` and `undefined`
   pool together. The full 20-field `getName` port (exact string + pfx
   hashing, `test-https-agent-getname`) is still L4's lane — this
   override is in exactly the place L4 rewrites.
3. **Accept batching (`src/net.js`)** — `queueAccept` drains pending
   virtual accepts as one batch. Real Node's kernel completes a burst of
   handshakes in parallel, so all of the burst's connections are accepted
   before any request handler runs. A per-socket defer interleaved a full
   round trip (microtask drain) between accepts, so the Nth connect of a
   burst could land after the server's `close()` in an earlier handler.
   Batching keeps the one-extra-turn handshake (the drain still runs on a
   macrotask) and the per-client destroyed/connecting guard, evaluated at
   drain time. Refusal semantics unchanged: `_acceptConnection` still
   refuses when the server stopped listening (probed real Node: a
   connection whose handshake completed in-kernel but whose JS accept had
   not fired when `close()` ran is still refused — the accept backlog is
   discarded).
4. **Fresh connections are not idle (`src/http.js`, `ServerBase.close`)**
   — the close predicate gains `&& !state.fresh`. Probed real Node:
   `close()` leaves a just-accepted connection alone — even one with no
   bytes yet, and one whose request bytes are still in flight — because
   `closeIdleConnections` destroys only the `kConnections.idle()` list
   and a connection that never served a request is not on it.
   `state.fresh` (cleared at the first byte in `onMessageStart`) already
   existed for the keep-alive idle clock; this reuses it. A pipelined
   second request on a served connection is still destroyed (served,
   not busy, not receiving) — matching Node.

## What was tried and rejected

- **Relaxing the accept-time refusal** (accept in-flight connects after
  `close()`): refuted by probe — real Node refuses even a
  handshake-complete connection whose JS accept had not fired
  (`zz-close-backlog-real.js`, ECONNREFUSED).
- **Removing the `serverClosing` destroy-at-finish branch**: a genuine
  Node divergence (probed: real Node reuses a keep-alive socket after
  `close()`; `resOnFinish` has no closing branch,
  `lib/_http_server.js:1096-1150`), but IRRELEVANT to this flip — the
  test's agent is not keep-alive, so its sockets die via the normal
  not-keep-alive path. REVERTED. Filed as a follow-up lane below; the
  probe is `zz-close-reuse-real.js` (kept in the triage evidence, not
  in the repo).

## Probes (all `zz-*.js` under `parity/node-test/parallel/`, deleted before ship)

- `zz-sni-dbg{,2,3,4,5}.js` — shim SNI threading, shared vs separate
  agents, socket/pool logging. Final shape: 5 parallel client sockets,
  5 batched server connections, handlers `sni.0…sni.3, false`.
- `zz-sni-real.js`, `zz-close-race-real.js`, `zz-close-reuse-real.js`,
  `zz-close-backlog-real.js`, `zz-close-idle-real.js` — real-Node probes
  (no preload): 5 distinct connections before close; synchronous
  close refuses; keep-alive reuse after close works; handshake-complete
  but unaccepted connections are refused; fresh connections survive
  close (P1: no bytes, P2: request in flight — both served/left alone).

## Guards verified on the branch

`test-http-server`, `test-http-outgoing-drain-writable-length`,
`test-http-server-close-idle`, `test-http-server-close-all`,
`test-http-server-close-idle-wait-response`, `test-http-agent-getname`,
`test-http-agent-maxsockets-respected`,
`test-http-server-keep-alive-max-requests-null`,
`test-http-server-keep-alive-defaults` (all 0 under http);
`test-https-server-close-destroy-timeout`,
`test-https-server-async-dispose` (0 under https);
`test-https-agent-getname` still 1 (L4's target, unchanged shape).
Target `test-https-agent-sni`: 0 (×3 runs).

## Differential (CSVs in `hidden_files/fast-sweep/`)

- Base (main `7a82db0e`, incl. PR #383): https-base-2026-11-07-l7.csv,
  http-base-2026-11-07-l7.csv, net-base-2026-11-07-l7.csv
- Branch (on `2079bca0` + this lane): https-branch-2026-11-07-l7.csv,
  http-branch-2026-11-07-l7.csv, net-branch-2026-11-07-l7.csv
- https: base 29/67 (6 timeout, 32 fail) → branch 28/67 (6 timeout,
  33 fail). Changed lines: exactly 3 — `agent-sni` 1→0 (THE flip);
  `argument-of-creating` 0→1 and `host-headers` 0→1 are stale-base
  artifacts (my branch predates PR #383 L2, which flipped them on
  main); recovered by the rebase onto `222fdfa1`. True differential
  after rebase: +1, zero regressions. (`strict` still 1 on both —
  L2's third target did not flip in this sweep; not this lane.)
- http: base 388/397 → branch 388/397, ZERO changed lines (397 rows).
- net: base 87/156 (5 timeout, 64 fail) → branch 87/156 (6 timeout,
  63 fail). Changed lines: exactly 1 — `write-fully-async-buffer`
  137→124, adjudicated NOT a regression: isolated re-run is 137 on
  BOTH base and branch (the documented pre-existing spinner; the
  kill code varies with load).
- Guards: `test-http-server`, drain-writable-length, close-idle family,
  agent-getname, maxsockets-respected, keep-alive defaults/max-null
  (http, all 0); `test-https-server-close-destroy-timeout`,
  `test-https-server-async-dispose` (https, 0); `test-https-agent-getname`
  still 1 (L4's target, unchanged shape). Target 0 ×3.
- Repo checks: `tests/ondemand-require.test.js` 29/29; build-vfs,
  build-sandbox --check, build-runtime --check all 0.

## Follow-up lanes (not this PR)

- **Close-semantics lane**: remove the `serverClosing` destroy-at-finish
  branch (`src/http.js`, `_finishSocketResponse`) — real Node has no
  finish-time destroy on closing servers; the prompt idle timer
  (`keepAliveTimeout`) is the closer. Evidence: `zz-close-reuse-real.js`
  (one agent, one servername, close during 4th handler — all 5 succeed
  on one server connection). Re-verify the drain test + close-idle
  family there; the branch was written and reverted in this lane.
- **L4** (full `getName` port) and **L13** (SNICallback invocation) are
  unchanged by this lane.
