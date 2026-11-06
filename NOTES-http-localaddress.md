# localAddress / Host header lane (triage rank 10)

Fixes the three remaining localAddress/host timeouts plus one bonus:

- `test-http-localaddress` (124 → 0): the server saw `127.0.0.1` as the
  remote address instead of the bound `127.0.0.2` — the handler assert
  threw, was swallowed by dispatch, and the test hung.
- `test-http-localaddress-bind-error` (1 → 0): a request bound to an
  unbindable source address (`1.2.3.4`) never surfaced the bind error.
- `test-http-host-header-ipv6-fail` (1 → 0): the Host header lacked IPv6
  brackets and the `:80` suffix.
- Bonus `test-http-addrequest-localaddress` (1 → 0): the legacy 4-arg
  `addRequest(req, host, port, localAddress)` form was not implemented.
- Bonus `test-net-localerror` (1 → 0): `net.connect` with a non-IP
  `localAddress` / non-number `localPort` did not throw synchronously.
- Bonus `test-https-localaddress`, `test-https-localaddress-bind-error`
  (124 → 0 each): the https twins share this path.

## Node source (v24.20.0, grounded oracle)

- `lib/_http_client.js:395-400`: `defaultPort = options.defaultPort ||
  (this.agent?.defaultPort)` — no `|| 80`. `port = options.port ||
  defaultPort || 80`.
- `lib/_http_client.js:512-520`: Host header brackets — if the host
  contains a second `:` and does not start with `[`, wrap in brackets;
  then append `:port` only for non-default ports.
- `lib/_http_agent.js:325-334`: `getName` is
  `host:port:localAddress[:family|:socketPath]`; `:356-367`: legacy
  `addRequest(req, options, port, localAddress)` rewrites a string host
  to `{ host, port, localAddress }`.
- `lib/net.js:1338-1363` (`internalConnect`/`checkBindError`): when
  `localAddress || localPort`, the socket binds first; a failed bind
  destroys the socket with
  `ExceptionWithHostPort(err, 'bind', localAddress, localPort)`.
- `lib/net.js:1657-1676` (`lookupAndConnect`): adopted bound socket +
  localAddress/localPort throws `ERR_INVALID_ARG_VALUE` first; a non-IP
  `localAddress` throws `ERR_INVALID_IP_ADDRESS` synchronously.

## Real-Node probes (host v24.22.1)

- Bind error for `localAddress: '1.2.3.4'`: `EINVAL | bind EINVAL
  1.2.3.4 | address: 1.2.3.4 | port: undefined | errno: -22`.
- `localAddress: '0.0.0.0'` also fails `EINVAL`. Bindable set in the
  virtual layer is loopback only (`127.0.0.0/8`, `::1`).
- Non-IP `localAddress` via `http.request`: sync throw
  `ERR_INVALID_IP_ADDRESS | Invalid IP address: not-an-ip`.
- Real Node sends Host `"foo:1234:80"` and `"[::1]:80"` for the ipv6
  test's two requests (defaultPort undefined when `createConnection`
  is a request-level function, so `:80` is appended).

## What changed

`src/http.js`

- `ClientRequest` constructor: `defaultPort` drops the trailing
  `|| 80` (matches Node); Host header build adds the IPv6 bracket step
  before the port append.
- `localAddress`/`localPort` thread through `_agentOptions` →
  `AgentBase.createSocket` (with a `req._agentOptions` fallback for
  queued/drained re-creations) → `AgentBase.createConnection`
  (`connectOptions`), forwarded only when present (same rule as
  `socketPath`; `test-http-agent-keepalive-delay` asserts exact
  connect options).
- `AgentBase.addRequest` gains the legacy 4-arg overload: a string
  host rewrites to `{ host, port, localAddress }` before naming.

`src/net.js`

- New `ERR_INVALID_IP_ADDRESS` factory (TypeError,
  `Invalid IP address: <value>`).
- `Socket.prototype.connect` validates synchronously, in Node's order:
  adopted BoundSocket + localAddress/localPort → `ERR_INVALID_ARG_VALUE`;
  non-IP localAddress → `ERR_INVALID_IP_ADDRESS`; non-number localPort →
  `ERR_INVALID_ARG_TYPE`. Stashes `_bindLocalAddress`/`_bindLocalPort`.
- `Socket` constructor remembers adoption (`_adoptedHandle`) — `connect`
  resets `_sockname`, so the flag must be captured at construction.
- `_doConnect` bind emulation (after the `connectionAttempt` emit,
  before the server lookup, mirroring Node's bind-before-connect):
  a non-loopback `localAddress` fails async with the probed shape
  (`EINVAL`, syscall `bind`, `errno: -22`).
- `Server.prototype._acceptConnection` (accept path AND drop path):
  the client's bound address/port is the pairing — `client._sockname`
  and `serverSocket._peername` use it (family via `isIP`), and the
  drop data's `remoteAddress`/`remoteFamily` too. A requested
  `localPort` replaces the ephemeral allocation.
- New `isLoopbackAddress` helper (`127.0.0.0/8`, `::1`).

## Known divergences (not fixed, no test hinges on them)

- Real Node throws `ERR_INVALID_IP_ADDRESS` synchronously from
  `http.request()`; in the shim the net throw is caught by the agent's
  `createSocket` try/catch and surfaces as an async request `error`
  event instead. No http test distinguishes; the constructor's
  swallow-catch was deliberately not reworked for this.
- `isLoopbackAddress` recognizes `::1` literally only — the expanded
  `0:0:0:0:0:0:0:1` form is treated as unbindable.
- A localAddress whose family mismatches the target (e.g. `::1` to an
  IPv4 server) binds in the virtual layer; real Node fails the bind.
  Untested.
- `test-net-boundsocket` still fails (line 20: `BoundSocket` with
  `port: 0` does not allocate a port — a separate BoundSocket root
  cause; the adopted-check block at lines 175-186 is never reached).
- `test-net-client-bind-twice` still fails (bind-collision / port
  reuse semantics when a client binds `localPort` to a listening
  server's port — separate root cause).
- `test-net-server-blocklist` still fails exactly as on base
  (pre-existing, unrelated to this lane).
