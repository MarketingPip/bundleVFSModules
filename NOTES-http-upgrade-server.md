# NOTES: test-http-upgrade-server (ponytail lane)

## The failure (base main e78c870b, exit 1)

`test-http-upgrade-server` asserts, in the client socket's first `data`
handler, that the server's `upgrade` handler already recorded the upgrade
head (`request_upgradeHead.toString()`). It was `null`: the server handler
writes the 101 response and *then* assigns the head, but the shim delivered
the 101 bytes to the client synchronously inside `socket.write()`, so the
client handler ran before the assignment line executed.

Real Node (probed v24.22.1, `/tmp/probe-upgrade-order.js`): the client data
handler sees the head SET — writes never deliver synchronously on a real
network. A deliberate throw in a data handler surfaces as
`uncaughtException` on real Node.

## The fix (2 files, +30/-2)

- `src/http.js` (`_dispatchSocketRequest`, server upgrade emit only):
  set `socket._upgradeDispatch = true` around the `emit("upgrade", ...)`
  call, restored in a `finally` (a throwing handler, as in
  `test-http-upgrade-server2`, cannot leave later writes on this socket
  async).
- `src/net.js` (`_deliverToPeer` only): while that flag is set, deliver
  via the existing `nextTick` helper with the write callback in the
  delivery microtask (a peer that died before its delivery runs drops the
  bytes with a successful callback — the write was accepted while the
  peer was alive). Everything else keeps the base synchronous path
  verbatim, including its throw-propagation comment.

## Why scoped this narrowly (the ponytail ladder, with evidence)

Three rungs were tried, in order, each measured by the full 397
differential against pristine base e78c870b:

1. **Global async delivery** (all sockets): fixed the target but broke
   11 passing tests plus 1 pass-to-timeout. The microtask shift
   reordered writes against destroys and unmasked synchronous
   throw-propagation the round-trip machinery depends on: the
   double-content-length clientError assertion throw (only swallowed on
   base because the shim emits the wrong HPE code — see below),
   outgoing-destroyed frame-error timing, pipeline/keep-alive
   write-vs-destroy order, and invented "Socket is not connected"
   errors for writes accepted before a peer destroy. Too big: rejected.
2. **Server-side-only async delivery** (writer `socket.server` marker):
   fixed 10 of the 11, but broke `test-http-server-unconsume`: the
   client's `end("hello world")` after the response landed after the
   server's destroy-at-finish, so the write failed with "Socket is not
   connected" instead of reaching the server's data listener. The
   server's destroy-at-finish is load-bearing for close-idle tests and
   was not touched. Too big: rejected.
3. **Upgrade-handoff-only async delivery** (this fix): target fixed,
   zero regressions in the full differential. The upgrade handoff is the
   one shape where user code writes and then records state the peer
   asserts synchronously; every other path keeps base behavior exactly.

## Verification (target: 1 -> 0, twice; guards below all exit 0)

Target + neighbors on branch: upgrade-server 0 (x2), upgrade-server2 0,
server-unconsume 0, outgoing-destroyed 0, double-content-length 0,
hex-write 0, highwatermark 0, server-keep-alive-max-requests-null 0,
client-spurious-aborted 0, keep-alive-pipeline-max-requests 0,
pipeline-socket-parser-typeerror 0, request-large-payload 0,
many-ended-pipelines 0, agent-keepalive 0, keep-alive-defaults 0,
upgrade-client 0, upgrade-agent 0, upgrade-advertise 0, upgrade-binary 0,
upgrade-reconsume-stream 0, connect 0, close-idle 0, agent 0,
client-reject-chunked 0, multi-line-headers 0,
parser-freed-before-upgrade 0.
Pre-existing timeouts unchanged on branch and base (124 on both):
catch-uncaughtexception, uncaught-from-request-callback, exceptions,
upgrade-server-callback (the parallel lane's target), upgrade-client2.
Full 397 differential branch vs pristine base e78c870b: base
242/58/95 (+1 crash code each 134/139) → branch 243/58/94 — exactly 1
line differs toward pass (upgrade-server 1→0), zero pass-to-fail
regressions, timeouts identical. Sweep CSVs:
http-sweep-upgrade-branch.csv / http-sweep-upgrade-base.csv.

## Deliberately left alone

- `test-http-upgrade-server-callback` (124 on base and branch) is the
  parallel worker's lane; untouched here. This lane touches the server
  upgrade emit at http.js:5737 (flag set/clear) and `_deliverToPeer` in
  net.js; the parent reconciles at merge.
- The parser's HPE code-name gap (`HPE_INVALID_CONTENT_LENGTH` vs the
  `HPE_UNEXPECTED_CONTENT_LENGTH` double-content-length asserts) is
  real but unmasked only by the rejected global-async variant; on the
  shipped path the test passes via the base throw-swallow, so the code
  name was NOT changed here. It remains a follow-up candidate.
- Real Node's `ServerResponse.destroy(err)` destroys the server socket
  *with* the error; the shim's `ServerResponse._destroy` still destroys
  it gracefully (`sock.destroy()`). No test asserts the socket error
  itself, so this divergence stands.
- No docs-number changes (batched syncs own HITLIST/measured-rates).
