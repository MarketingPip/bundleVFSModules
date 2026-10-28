# NOTES — server half-close drain for pipelined responses

## Problem

`test-http-server` (and the server-* timeout cluster) hung: a client that
pipelines several requests and then half-closes (FIN) never received
responses 2..N, so its `close` never fired and the test process never
exited (30 s timeout, exit 124).

## Root cause (two halves of one bug, both in `src/http.js`)

The virtual server closes a half-closed socket too eagerly, in two places
that each assume "the first finished response is the last":

1. **`_finishSocketResponse`**: `keepAlive` required `!state.peerEnded`,
   so the first response to finish on a half-closed socket took the
   `else` branch and destroyed the socket — discarding responses for
   requests that were already parsed and dispatched.
2. **The socket `end` handler**: it closed the socket whenever
   `!state.busy`, but `busy` is already false after the first response
   finishes, even while later pipelined responses are still pending. A
   FIN queued behind pipelined requests therefore closed the connection
   before those responses were written.

Proven with a debug repro (since deleted) mirroring `test-http-server`:
before the fix the client received only response 0 (149 bytes) and then
EOF; after the fix it receives all four responses (516 bytes) and the
process exits naturally.

## Fix

Count outstanding responses per connection (`state.inFlight`,
incremented at dispatch, decremented when a response finishes):

- The `end` handler closes immediately only when `inFlight === 0`
  (after unpausing the parser, so a request still buffered there is
  counted rather than dropped).
- `_finishSocketResponse` takes the keep-alive-style drain path while
  `peerEnded && inFlight > 0` — but only when the response would
  otherwise have kept the connection alive (same `shouldKeepAlive`,
  `maxRequestsPerSocket`, framing, and no-body-with-TE conditions), so
  `Connection: close` and malformed-framing behavior is unchanged. The
  last outstanding response takes the normal close path.

## Measured effect (30 s each, `PARITY_TARGET=http`)

Server-* timeouts from the 2026-10-20 sweep, re-run on this branch:

- `test-http-server`: 124 → **0 (pass)**. This needed both halves
  below: the drain fix alone still timed out (the handler threw on
  `res.req` before any response was written), and the `res.req` fix
  alone would still time out (responses 2..N were dropped on the
  half-close).
- `test-http-server-non-utf8-header`: 124 → 0 — but this flip belongs
  to PR #250, not this PR: it already passes on pristine main
  (`f0fc91fd`), verified in a scratch worktree.
- The other 17 server-* timeouts remain 124 (all were 124 before, none
  regressed).

## Second defect fixed in this PR: `ServerResponse.req` was never set

`test-http-server` asserts `res.req === req`, but the
`ServerResponse` constructor never assigned `this.req` (it set
`socket`, `connection`, `statusCode`, … only). The assertion threw
inside the request handler, dispatch caught it and destroyed the
socket, and the client never received any response — so the test hung
before the drain bug was even reached. Fix: `this.req = req` in the
constructor. Only two vendored http tests reference `res.req`
(`test-http-server`, `test-http-nodelay`); `test-http-nodelay` still
fails (exit 1, identical on pristine main) on an unrelated gap —
`server.noDelay` is undefined — which is out of scope here.

## Other timeout-cluster families (assessment, not this PR)

- `server.headersTimeout` / `requestTimeout` families
  (`*-headers-timeout-*`, `*-request-timeout-*`, `consumed-timeout`,
  `keep-alive-timeout`): these wait for a server timeout feature that
  does not exist yet in the shim — a feature gap, not a hang bug.
- `keep-alive-defaults`, `keep-alive-max-requests-null`,
  `multiheaders(2)`, `stale-close`, `connection-list-when-close`,
  `options-*`, `unconsume-consume`, `de-chunked-trailer`,
  `delete-parser`, `destroy-socket-on-client-error`,
  `drop-connections-in-cluster`, `multiple-client-error`: still 124 on
  this branch; each needs its own repro before any shared-cause claim.
  None of them regressed (all were 124 before, all are 124 now).

## Guards

The known passing server/client guards (agent-*, keep-alive-*,
chunked, blank-header, get-pipeline-problem,
keep-alive-close-on-header, client-keep-alive-hint,
agent-keep-alive-timeout-buffer) were re-run on this branch before
shipping; see the PR's Testing section.
