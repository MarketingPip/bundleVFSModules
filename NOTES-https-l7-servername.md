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
   discarded). **Split (fix for the CI failure below): only the
   server-side accept batches.** The client-side `connect` tail
   (`connecting = false`, pending-write flush, timeout refresh, handle
   options, `connect` + `ready`, read start, loop keeper) is extracted
   as `emitClientConnect` inside `_acceptConnection` and deferred one
   macrotask per client for every batch item after the first (the first
   connects synchronously in the drain, so single-connect timing is
   unchanged). A microtask can therefore run between two clients'
   `connect` events — a listener registered while awaiting the first
   must not miss the second. The drop path keeps its synchronous
   connect-then-destroy (atomic by design).
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

- **Naive batching (all client `connect`s in one macrotask)**: tried
  first, then split (mechanism 3 above). It collapsed both `connect`
  events of a burst into one callback, so a test awaiting c1's connect
  before listening for c2's missed c2's event and hung 30s
  (`tests/net.test.js` "getConnections counts live connections" — the
  only extra failure in the full local jest suite vs the 7 known
  version-skew failures). Real Node drains microtasks between the two
  connect callbacks, so the await interleaves there.
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
- CI round 1 (head `e698fa64`) and round 2 (head `03be23dd`): Parity
  success, build failure with no log summary via API. The build job's
  "Run Tests" step (full jest suite) was the failing step — NOT the
  esm.sh transient: the only extra local failure was
  `tests/net.test.js` "getConnections counts live connections" (30s
  timeout), fixed by the connect-tail split above.
- Rebased tree (main `222fdfa1`, CSVs `*-2026-11-07-l7b.csv`):
  https base 31/67 (6 timeout, 30 fail) → branch 32/67 (6 timeout,
  29 fail), changed lines exactly 1 — `agent-sni` 1→0. http base
  388/397 (2 timeout, 7 fail, 134:1, 139:1) → branch 387/397
  (2 timeout, 8 fail, same crashes), changed line exactly 1 —
  `test-http-server-unconsume` 0→1. net base 87/156 (6 timeout,
  63 fail) → branch 86/156 (7 timeout, 63 fail), changed line
  exactly 1 — `test-net-connect-options-allowhalfopen` 0→124.
  Both flags were REAL regressions from the connect-tail split,
  both fixed in `src/net.js` (see below); a third flag
  (`test-http-abort-stream-end`) appeared in the re-sweep and was
  fixed in `src/http.js` (see below).

## Adjudication of the l7b regressions (both real, both fixed)

- **Regression 1 — `test-http-server-unconsume` (0→1).** Isolated
  branch 1×2, base 0×2; pre-split commit 0×3, post-split 1×3.
  Root cause: the three servers are created up front, so their
  connects burst into one accept batch; items 1–2 get deferred
  connect tails. For a deferred client the response arrives while
  its ReadableState `sync` flag is still true (its first `read()`
  never ran), so `addChunk` buffers instead of emitting `'data'`
  synchronously, and the serverClosing destroy lands before the
  client's data handler — the client's hello-world write then hits
  a destroyed peer (ECONNRESET). Fix: `emitClientConnect` calls
  `client.read(0)` instead of just setting `_readStarted` — the
  first `read()` clears the sync guard, matching real Node (whose
  read watcher is active at `'connect'`). Verified 0×3.
- **Regression 2 — `test-net-connect-options-allowhalfopen`
  (0→124).** Isolated branch 124×2, base 0×2; presplit 0. Root
  cause: the server's FIN is delivered via `_final`/`_destroy`
  `nextTick(() => peer._receiveEOF())`, which runs BEFORE the
  deferred setImmediate connect tail — the client's `'end'` fires
  before its connect callback attaches the listener, and the event
  is lost. Real Node cannot do this: nothing from the server can
  arrive before the client's `'connect'`. Fix: in `_final` and in
  `_destroy`'s peer-EOF notification, if `peer.connecting`, defer
  the EOF until the peer's `'connect'` (`peer.once("connect",...)`,
  guarded by `!peer.destroyed`). Data deliveries deliberately NOT
  deferred (buffered, not losable). Verified 0×3.
- **Regression 3 — `test-http-abort-stream-end` (0→1).** Isolated
  branch 1×3, base 0×3. The `read(0)` warmup fixes regression 1
  but causes this one: without `read(0)` it passes 0×2 while
  unconsume fails 1×2; with `read(0)` it fails 1×3 while unconsume
  passes 0×3. Root cause, proven by instrumented probes: with a
  flowing socket the whole 1024-chunk body parses synchronously
  before the user's first `'data'` event, and the round-trip's
  streamed-complete branch destroys the request at parse-complete
  (`Writable.prototype.destroy.call(this)`, `src/http.js` ~6955) —
  so `abort()` mid-body finds `destroyed` already true,
  `destroy()` early-returns, `_dump()` never runs, and the
  buffered chunks keep firing `'data'` ("got data after abort").
  Probed real Node v24.22.1: `writableFinished=true` but
  `destroyed=false` at response time, and abort still runs
  destroy + `_dump` (listeners 1→0). Fix (two parts):
  (a) `OutgoingMessage` super-call gains `autoDestroy: false` —
  real Node's OutgoingMessage is NOT a stream.Writable
  (`lib/_http_outgoing.js`; `ClientRequest` uses
  `OutgoingMessage.call(this)`), so it has no generic
  finish→autoDestroy. (b) `ClientRequest.destroy()` dumps the
  in-flight response BEFORE the `if (this.destroyed) return`
  guard — `_dump()` is re-entry-guarded, so this is safe on a
  second destroy; only the dump moves, the socket teardown below
  still early-returns. The parse-complete destroy timing itself
  (request destroyed before the user consumes the body) is a
  separate pre-existing divergence — it exists on base too for
  small synchronously-delivered responses — and stays for a
  follow-up lane. Verified: abort-stream-end 0×3, unconsume 0×3,
  sni 0×3, keepalive-free 0×3, allowhalfopen 0×2.
- Rebase onto main `4f98f142` (PRs #386, #387, #392 L8, #385 L4
  landed): conflicts in `src/http.js` (kept both L8's
  `_tlsOptions` stash and L7's `_servername` stash), `src/https.js`
  (took HEAD's full L4 `getName` — it supersedes L7's minimal
  servername-suffix override with identical pool-separation
  semantics — so `src/https.js` drops out of the branch diff and
  out of the footprint allowlist), and the allowlist itself.
  Rebased HEAD `8962b311`; sni/agent-getname/abort-stream-end/
  unconsume/keepalive-free all 0×3 and allowhalfopen 0×2 on the
  rebased tree; footprint 29/29; build-sandbox/runtime 0,
  build-vfs 1 (esm.sh transient only).
- l7d differential vs new main `4f98f142` (CSVs `*-2026-11-07-l7d.csv`):
  https base 38/67 (6 timeout, 23 fail) → branch 39/67 (6 timeout,
  22 fail), changed lines exactly 1 — `agent-sni` 1→0. net base
  87/156 (5 timeout, 64 fail) → branch 87/156, changed lines
  exactly 0. http base 388/397 (2 timeout, 7 fail, 134:1, 139:1)
  → branch 383/397 (3 timeout, 11 fail), changed lines exactly 5,
  ALL toward-fail and ALL in the write-after-end/finish family:
  `outgoing-finished` 0→1, `req-res-close` 0→1,
  `res-write-after-end` 0→124, `server-write-after-end` 0→1,
  `server-write-end-after-end` 0→1.
- **l7d adjudication — the 5 http flags were REAL regressions
  from fix part (a) (`autoDestroy: false`).** All 5 fail 3/3
  isolated on the branch and pass 3/3 on base. Bisect: reverting
  (a) alone (keeping (b)) restores all 5 to 0×2 AND keeps
  abort-stream-end at 0×2 — so (b) alone is the abort fix and (a)
  is DROPPED from this lane. The shim's `ServerResponse.write`
  error/return path depends on the finish→autoDestroy lifecycle
  (write-after-end must return false + emit
  `ERR_STREAM_WRITE_AFTER_END`); disabling autoDestroy on the
  shared `OutgoingMessage` base broke it for server responses.
  The real-Node probe (finished but not destroyed) stays a
  recorded divergence for a follow-up lane scoped to the client
  request only — NOT as a shared-base change. Re-verify: fresh
  l7e sweeps on the final tree (see below).
- Final tree (CSVs `*-2026-11-07-l7c.csv`): https 32/67 (6 timeout,
  29 fail), diff vs l7b base exactly 1 line (`agent-sni` 1→0).
  http 387/397 (2 timeout, 8 fail, 134:1, 139:1) — same totals as
  the l7b branch; diff vs l7b base exactly 1 line, which is the
  l7c net sweep's result to confirm (net l7c running at write
  time; allowhalfopen verified 0×2 isolated). CONFIRMED: net l7c
  87/156 (6 timeout, 63 fail) — diff vs l7b base exactly 0
  changed lines (157 rows each, same row set).

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
