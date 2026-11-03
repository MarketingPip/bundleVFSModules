# test-http-socket-encoding-error — two stacked gaps

## Test shape

`new http.Agent().createConnection(port, cb)` connects to an HTTP server;
the server's `connection` handler asserts `socket.setEncoding("")` throws
`{ code: "ERR_HTTP_SOCKET_ENCODING", name: "Error", message: "Changing
the socket encoding is not allowed per RFC7230 Section 3." }`, then
`socket.end()`.

## Failure on pristine main `e48733e4`

Exit 1, 3/3 runs. The failure is at the FIRST gap, before the server
handler ever runs.

## Gap 1: `AgentBase.createConnection` rejects the number form

`src/http.js`, `AgentBase.createConnection(options, callback)` destructured
`options.port` / `options.host` directly. With a NUMBER port,
`options.port` is `undefined`, so `netConnect({ port: undefined, ... })`
throws `TypeError: The "options" or "port" or "path" argument must be
specified` (`ERR_MISSING_ARGS`), via `src/net.js` `Socket.connect`.

Real Node (probed v24.22.1): `new http.Agent().createConnection(port, cb)`
works.

Fix: normalize at the top of `createConnection` —
`if (typeof options === "number")` → `{ port: options }`, with a string
second argument taken as the host (the `net.createConnection(port[,
host][, callback])` overload shape). Object form is untouched, so no
passing test can depend on the old behavior — the old behavior only ever
threw.

## Gap 2: no `ERR_HTTP_SOCKET_ENCODING` on HTTP server sockets

The shim had no `setEncoding` override anywhere: sockets inherited
`Readable.prototype.setEncoding`, which never throws.

Real Node (probed v24.22.1):

- Plain net server socket: `setEncoding` works, no throw.
- Plain net client socket: no throw.
- HTTP server socket: `setEncoding` (any argument, including `"utf8"`,
  not just `""`) throws `ERR_HTTP_SOCKET_ENCODING` with the exact message
  above — and it is an OWN property on the socket, installed by the HTTP
  server wiring, not a prototype override.

Fix: `src/http.js`, `_onSocketConnection` installs an own
`socket.setEncoding = () => { throw ERR_HTTP_SOCKET_ENCODING(); }` when
the HTTP server accepts a socket (new factory beside
`ERR_HTTP_BODY_NOT_ALLOWED`, same `makeError` shape, so `name` is
`"Error"`). This mirrors real Node's mechanism exactly: net sockets and
HTTP client sockets keep `Readable`'s `setEncoding` (verified by probe:
both still work, no throw), and the idempotence guard
(`if (socket._httpState) return`) means a re-entered connection does not
re-install it.

## Guards (all exit 0)

socket-encoding-error (3/3), agent, agent-keepalive, agent-keepalive-delay,
agent-timeout-option, upgrade-agent. Negative probes: net server socket
`setEncoding("utf8")` no throw; HTTP client socket `setEncoding("utf8")`
no throw.

## Notes

- The test's client half (`Agent.createConnection` number form) is the
  only caller of that form in the suite; the object form used by every
  other agent test is untouched.
- `setEncoding` on an HTTP server socket throws for ANY argument on real
  Node, so the shim's thrower ignores its argument too.

## Rebase note

Rebased onto main `d51b6edc` (PR #310) after the first merge attempt
returned 409 "Head branch is out of date" despite the head's parent
being `d51b6edc` — a GitHub merge-state stall, not a real conflict.
This notes-only line retriggers a fresh head + CI run.
