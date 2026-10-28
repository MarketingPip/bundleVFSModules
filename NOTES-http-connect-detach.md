# NOTES — CONNECT tunnel socket detach (test-http-connect)

## Target

`test-http-connect`: exit 124 → 0. Bonus flip from the same change:
`test-http-agent-remove`: exit 124 → 0 (it asserts `socket._httpMessage
=== req` on the agent path; the shim never set `_httpMessage` at all).

## Diagnosis: the flow worked, the assertions threw

A logging-only replication of the test under the shim completed end to
end (server `connect` → 200 → client `connect` → `Body` → server echo
`HeadBody` → client `end` → closes). The real test hung because its
strict assertions threw inside event handlers, and the throw was swallowed
somewhere in the shim's dispatch path (the known triage pattern: handler
throw → no response → hang). The mismatches, logged at each checkpoint:

| Checkpoint | Test expects | Shim had |
|---|---|---|
| client `socket` event | `socket._httpMessage === req` | `false` (never assigned) |
| server socket at `connect` | close 0, data 0, end 1, error 0, timeout 0 | close 1, data 1, end 2, error 1, timeout 1 |
| client socket at `connect` | end 1, error 0, `_httpMessage === null` | end 1, error 1, `_httpMessage === undefined` |

## Real-Node detach contract (probed v24.22.1, plain node)

- Server socket at `connect`: ONLY `end: [onReadableStreamEnd]` — the
  Socket's own stream-internal half-open handler. Every HTTP-layer
  listener is gone. `allowHalfOpen` is true on accepted sockets.
- Client socket at `connect`: ONLY `end: [onReadableStreamEnd]`,
  `_httpMessage: null`.
- Client socket at `socket` event: full set (close, drain, data, end ×2,
  error, timeout ×2, free, agentRemove, connect), `_httpMessage === req`.
- The tunnel still drains when the client destroys its socket with no
  app `end` handler (unconsume-consume): the process exits even though
  the server socket never fires `close` — the loop goes inactive, it is
  not the `close` event that frees it.

## Fix

`src/http.js` only, except one hook call in `src/net.js`:

1. `_onSocketConnection`: the five anonymous socket handlers (close,
   timeout, data, error, end) became named consts stored on
   `state.httpListeners` (same closures, same order, no behavior change
   for normal requests).
2. `_dispatchSocketRequest` CONNECT branch: before emitting `connect`,
   remove all five HTTP-layer listeners by stored reference (app
   listeners, e.g. from `connection`, survive) and stash the close
   handler as `socket._onHttpSocketClose`. Remaining: exactly
   `onReadableStreamEnd` → end 1, everything else 0. The HTTP `end`
   handler goes too: a CONNECT tunnel's close on peer FIN is the app's
   lifecycle now (this test echoes and ends in its own `end` handler).
   Side benefit: tunnel bytes after detach never reach the parser, so a
   `Body\r\n\r\n`-shaped tunnel frame can no longer trip a parse error.
3. `src/net.js` `Socket._destroy`: invoke `socket._onHttpSocketClose`
   (when set — CONNECT-detached server sockets only) so connection
   tracking, the checker stop, facade `free()`, and parser-callback
   release still run without an EventEmitter `close` listener. This
   mirrors lib/net.js, where the connection count releases from the
   handle close, not an EE listener. Normal sockets are untouched
   (hook property absent → zero behavior change).
4. `ClientRequest.onSocket`: set `socket._httpMessage = this` on
   assignment (real sockets only — the existing FakeSocket guard
   already excludes the placeholder).
5. `_performVirtualRequest` CONNECT branch: before emitting `connect`,
   remove the request-level error forwarder (`onSocketError`) and set
   `socket._httpMessage = null`. The round trip already detached its own
   listeners; the request-level forwarder was the one left.

## Verification

- `test-http-connect`: 124 → 0. `test-http-agent-remove`: 124 → 0.
- Guard battery 31/31 on the branch: connect-req-res,
  unconsume-consume (the drain-path risk from removing the HTTP `end`
  handler — still passes via the peer-destroy → transport-inactive
  path), server, chunked, set-trailers, de-chunked-trailer, nodelay,
  client-highwatermark, multiheaders, multiheaders2,
  client-headers-host-array, headers-distinct-proto, keep-alive-defaults,
  close-idle-wait-response, connection-list-when-close,
  keepalive-req-gc, keep-alive-timeout, request-timeout-delayed-headers,
  headers-timeout-delayed-headers, multiple-client-error,
  destroy-socket-on-client-error, client-error,
  drop-connections-in-cluster, delete-parser, options-highwatermark,
  consumed-timeout, options-incoming-message, blank-header,
  get-pipeline-problem, keep-alive-close-on-header.
- Differential sweep (102 tests: agent/connect/upgrade/net-connect/
  net-server/close/connection/keep-alive families) on branch vs pristine
  base 9f38f688: branch 49 pass / 53 fail, base 47 pass / 55 fail.
  Failure sets: branch is a STRICT SUBSET of base — zero regressions,
  exactly two fixed (agent-remove, connect), and all shared failures
  carry identical exit codes. (`runtime.js --check` fails identically
  exit 1 on branch and base — pre-existing ESM `https:` import error in
  this sandbox, unrelated to this change; `node --check` on both files
  and `build-vfs` are clean, locally regenerated `dist/*` restored.)
- Filename trap, again: `test-http-server-get-pipeline-problem.js` and
  `test-http-server-keep-alive-close-on-header.js` do not exist
  (module-not-found exit 1); the real files are
  `test-http-get-pipeline-problem.js` and
  `test-http-keep-alive-close-on-header.js`, both exit 0.

## Known gaps left (out of scope)

- `upgrade` sockets are NOT detached the same way (their tests assert
  different listener shapes; untouched here).
- `_httpMessage` is still not cleared on normal (non-CONNECT) socket
  release to the agent pool — only the CONNECT detach nulls it. No test
  covers the normal-path clearing yet.
- `server.getConnections()` for a CONNECT tunnel relies on the destroy
  hook rather than the `close` event; equivalent counts, different
  mechanism.
