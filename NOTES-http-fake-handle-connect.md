# NOTES — fake-handle connect (triage round-2 Lane 16)

Target: `test-http-client-immediate-error` (1 → 0).

## Real Node behavior (grounded in the source pack)

`lib/net.js` v24.20.0, `Socket.prototype.connect` (:1514) reuses a
pre-existing `_handle` (no new TCP handle is created when one is set);
`lookupAndConnect` (:1657) → `internalConnect` (:1338) calls
`self._handle.connect(req, address, port)` for IPv4 (`.connect6` for IPv6,
2-arg `.connect(req, address)` for pipes). A non-zero return destroys the
socket synchronously with `new ExceptionWithHostPort(err, 'connect',
address, port)` (:1402-1408), i.e. code = libuv errno name
(`ENETUNREACH` for -101), `syscall: 'connect'`, `errno: -101`,
`address`/`port` attached. The socket `'error'` then reaches the
`ClientRequest` via `socketErrorListener` (`lib/_http_client.js:757`).

Probed on host Node v24.22.1: the fake's `connect` is called with
`(req, '127.0.0.1', 1)`, returns `UV_ENETUNREACH` (-101), and the request
`'error'` carries `{ code: 'ENETUNREACH', errno: -101, syscall:
'connect', address: '127.0.0.1', port: 1, message: 'connect ENETUNREACH
127.0.0.1:1 - Local (undefined:undefined)' }`.

## Shim gap

`Socket.prototype.connect` (`src/net.js:1434`) kept a pre-existing
`_handle` (`if (!this._handle) this._handle = new VirtualHandle()`) but
never called it — `_doConnect` always dialed the virtual loopback, so the
fake's error never fired and the request failed with `ECONNREFUSED`
(port 1 has no virtual listener). The socket→request error plumbing
already worked end to end; only the dial step ignored the handle.

## Fix (`src/net.js` only)

In `_doConnect`, after the blockList check and before the virtual server
lookup (Node's `internalConnect` order: bind → blockList →
`_handle.connect`): if `this._handle` has a `connect` function, call it
with a minimal req (`{ address, port, oncomplete }`) — 3 args for TCP,
2 for pipes. A non-zero libuv return destroys the socket with the mapped
errno error (`_connectFailed`, deferred like every other connect failure
in `_doConnect`). A zero return means the handle owns the connection from
here (async completion via `req.oncomplete`, whose non-zero status also
fails the connect); the code never falls through to the virtual server
lookup, which would be a fake success.

The discriminator is exact: the shim's own `VirtualHandle` has no
`connect` method, and adopted `BoundSocket`s get a `VirtualHandle` by
`_doConnect` time (`BoundSocket` itself has no `connect` either), so the
branch only fires for foreign (e.g. test-faked) handles. The only other
vendored test that fakes `_handle`
(`test-http-agent-uninitialized-with-handle`) has no `connect` and still
passes.

Errno mapping reuses the canonical `os.constants.errno` table (Linux
values) via a lazily-built reverse map — `getSystemErrorName` from
`src/util.js` was deliberately NOT reused: its `systemErrorMap` is
shifted by 7 in the network range (`-101` reads `ESHUTDOWN` there), so it
would report the wrong code for connect errnos. That table bug is
pre-existing and out of scope for this lane; it only affects callers that
pass libuv errnos in the -85..-115 range (no vendored test currently
asserts those names through it).

## Shape check (shim vs real Node, zz- probe)

Shim error: `{ code: 'ENETUNREACH', errno: -101, syscall: 'connect',
address: '127.0.0.1', port: 1, message: 'connect ENETUNREACH
127.0.0.1:1' }` — identical to real Node except the message suffix:
real Node appends ` - Local (undefined:undefined)` in the fake-handle
case (its `_getsockname()` returns a garbage object for the fake handle).
The shim's message matches real Node's normal connect-error shape (a
plain refused connect on real Node has no suffix either) and no vendored
test asserts the message — cosmetic, not pursued.

## Ceiling

A fake handle reporting async success (return 0, later
`oncomplete(0)`) has no transport in the shim, so the socket stays
`connecting` (as in Node, where the handle would own I/O from here). No
vendored test covers that path.

## Verification

- Target 0×2 on branch; 0×2 on merged main (parent).
- Guards 18/18 on branch (http: agent-uninitialized-with-handle,
  server-client-error, server-destroy-socket-on-client-error,
  client-error-rawbytes, #359/#360/#362–#367 flips; net:
  connect-call-socket-connect, connect-nodelay).
- Differential: fast-sweep `http-sweep-fh-{base,branch}.csv` (see handoff).
