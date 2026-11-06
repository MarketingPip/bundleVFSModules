# Unix-socket pair — test-http-unix-socket, test-http-unix-socket-keep-alive

Base: main `00de1571` (PR #334). Both targets failed fast (exit 1, ×3) on base;
guard `test-http-client-abort-unix-socket` passed (0×3) on base.

## Diagnosis (probed real Node v24.22.1 + Node v24.20.0 source)

The shim's net layer already virtualizes unix pipes (`src/net.js`
`_pipeServers`, `_doListenPipe`, `_doConnect` pipe branch — proven by a
standalone net listen/connect probe passing under the harness). The gap
was entirely http-layer wiring, in four places:

1. **Agent dropped `socketPath`.** `ClientRequest._agentOptions` carried
   only `{host, hostname, port}`, so `AgentBase.createSocket` built
   `{port: 80, host: "localhost"}` and dialed TCP localhost:80 → bare
   `ECONNREFUSED`. Real Node (`lib/_http_agent.js:370,430`,
   `lib/_http_client.js:577`): `options.path = options.socketPath`
   before `net.createConnection`.
2. **`Server.listen(path)` bound a random TCP port.** `listen()` did
   `port = Number(path)` → `NaN` → the ephemeral-port branch. The pipe
   was never listened on. Real Node (`lib/net.js:2474→2565`):
   `options.path && isPipeName(options.path)` → pipe listen.
3. **No pipe route in `_performRequest`.** Even with a connected pipe
   socket, a socketPath request fell through to the assigned-socket
   branch (`await new Promise(() => {})`) and hung forever. The
   virtual-server gate cannot serve it (registry keyed by port; a
   socketPath request carries default port 80).
4. **`Server.close()` on a non-listening server called back with no
   error.** `test-http-unix-socket` asserts the second `close()` gets
   `ERR_SERVER_NOT_RUNNING`. Real Node: http `Server.close` delegates
   to `net.Server.close` (`lib/_http_server.js:674`), which calls back
   with `ERR_SERVER_NOT_RUNNING` when not running (probed: never-listened
   and already-closed alike).

A fifth defect surfaced while fixing (3): the request-level
`createConnection` branch sat *after* the virtual/raw gates, so a
factory request naming the server's port crashed in
`_performVirtualRequest` on the undefined agent (`TypeError: Cannot
read properties of undefined (reading 'addRequest')` — probed with a
minimal factory-TCP case on base). The factory replaces the agent
entirely (real Node `lib/_http_client.js:361`: agent stays `undefined`
when `createConnection` is set), so the branch now runs before the
gates. This is also what unblocks
`test-http-client-with-create-connection`'s TCP half.

Timing subtlety found by instrumentation: the backing net server binds
on a later turn than the http `'listening'` callback, so a request made
inside that callback misses the net pipe registry. The pipe gate
therefore consults both the net registry (covers raw net pipe servers)
and the http pipe registry, which `listen()` writes synchronously.

## Fix (`src/http.js`, `src/net.js`)

- `src/net.js`: new internal export `hasPipeServer(path)` (mirrors
  `hasTcpServer`; not a Node API, stays out of the default export).
- `src/http.js`:
  - `ClientRequest`: `socketPath` threaded into `_agentOptions`.
  - `AgentBase.createSocket` / `createConnection`: `socketPath` →
    net `path` (only when present, so TCP callers see exactly the
    options they passed).
  - `Server.listen`: string-path / `{path}` binds the backing net
    server to the pipe; pipe registry (`_httpShared().pipeRegistry`)
    with the same EADDRINUSE guard as TCP; `address()` returns the
    path string for pipe servers; `close()` unregisters the pipe.
  - `Server.close`: non-listening callback gets
    `ERR_SERVER_NOT_RUNNING` ("Server is not running.").
  - `_performRequest`: factory branch moved before the virtual/raw
    gates; new pipe gate (net registry OR http pipe registry) routes
    socketPath requests to `_performVirtualRequest(null, …)` over the
    agent socket.

## Verification

- Targets on branch (×3 each): `test-http-unix-socket` 0,
  `test-http-unix-socket-keep-alive` 0 (base: 1×3 both).
- Bonuses (same root cause, verified ×3 on branch vs base 1):
  `test-http-client-pipe-end` 0, `test-http-client-with-create-connection`
  0. The latter also needed the factory-branch reorder.
- Observed, NOT claimed (parallel abort lane's target):
  `test-http-client-abort-keep-alive-queued-unix-socket` 0×3 on branch
  (base 1×3) — same socketPath pool-key/dial root cause.
- Guard `test-http-client-abort-unix-socket` 0×3 on branch and base.
- Guards (agent, keep-alive, client-timeout-option, server-lifecycle,
  interim-response, server-close-idle families): all 0 on branch.
- Full 397 differential: see `http-sweep-us-{branch,base}.csv`.

## Deliberately not done

- `req.port` stays the defaulted 80 for socketPath requests (real Node:
  `undefined`). No test asserts it; changing it would move the
  `_parseTarget` gates for every request.
- `req.socket.remoteAddress/localAddress` stay the virtual values (real
  Node: `undefined` for unix sockets). No test asserts them.
- https unix-socket twin already passes on base; untouched.
