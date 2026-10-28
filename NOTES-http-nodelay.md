# NOTES — http server.noDelay + client connect noDelay (test-http-nodelay)

## Target

`test-http-nodelay` exited 1 on main `a3fdbd8d`; exits 0 after this change.

## Real-Node semantics probed (v24.22.1, plain node)

- `http.createServer().noDelay` defaults to `true`. `createServer({ noDelay })`
  honors the option, Boolean-coerced at construction: `0` -> `false`,
  `'x'` -> `true`, `null` -> `true`. Later assignment stores verbatim
  (plain property, no setter: `s.noDelay = 'weird'` reads back `'weird'`).
- `net.createServer().noDelay` defaults to `false` — different from http.
  The http default is not inherited from net.
- Client connect options: `http.request` to a server connects with
  `noDelay: true`. `http.request({ noDelay: false })` STILL connects with
  `noDelay: true` (request-level noDelay is ignored — not a request
  option). `new http.Agent({ noDelay: false })` + a request through it
  connects with `noDelay: false` (the agent option propagates). Agent
  exposes no `noDelay` property (`new Agent().noDelay` is `undefined`).
- `Socket.prototype.connect` in the http-agent path receives ONE argument:
  the normalized tuple `[options, callback, Symbol(normalizedArgs)]`
  (real Node's `net.createConnection` passes the normalized array
  straight through). That is why the test's monkeypatch reads
  `args[0].noDelay` — `args` is the tuple, `args[0]` the options object.
- Server side: no JS-level `setNoDelay` call on accepted sockets was
  observed on real Node in any configuration (default true, false at
  create, false via option, false after listen) — a global
  `Socket.prototype.setNoDelay` wrapper with per-socket id correlation
  logged zero calls. So `server.noDelay`'s observable contract here is
  the property itself; the shim's net-level accept-time
  `serverSocket.setNoDelay(netServer.noDelay)` is left untouched.

## Root causes (three stacked gaps)

1. `ServerBase` never defined `noDelay` — the test's
   `assert.strictEqual(server.noDelay, true)` failed with `undefined`.
2. `AgentBase.createSocket` called `netConnect({ port, host })` with no
   `noDelay`, so the connect options the test's monkeypatch inspects
   had no `noDelay` at all.
3. The shim's `net.createConnection` helper called
   `socket.connect(options, cb)` (two args), while real Node calls
   `socket.connect(normalizedTuple)` (one array arg). Under the test's
   monkeypatch `function (args)`, the shim's shape made `args` the
   options object, so `args[0]` was `undefined` and the assertion could
   never pass even with `noDelay` present.
4. Unmasked by fixing 1–3 (previously the test died at the listen
   callback before any request): client `IncomingMessage` objects never
   got `.req`, so the test's `res.req.socket.end()` threw
   `TypeError: Cannot read properties of undefined`. Real Node sets
   client `res.req` to the `ClientRequest`.

## Fix

- `src/http.js` `ServerBase` constructor: `this.noDelay =
  options.noDelay == null ? true : Boolean(options.noDelay)`.
- `src/http.js` `AgentBase.createSocket`: `netConnect({ port, host,
  noDelay: this.options.noDelay ?? true })` — agent option wins,
  request-level noDelay ignored, matching the probes.
- `src/net.js` `connect()` helper: `return socket.connect(normalized)`
  instead of `socket.connect(normalized[0], normalized[1])`, matching
  real Node's internal call shape.
- `src/net.js` `normalizeArgs`: unpack a single already-normalized
  array argument (`args.length === 1 && Array.isArray(args[0]) &&
  args[0][normalizedArgsSymbol]`) instead of re-normalizing it (which
  would spread the tuple into `{ 0: options, 1: cb }` garbage).
- `src/http.js` client response emit sites (streaming `onHeaders`,
  fetch path, virtual round-trip path): `msg.req = this`, so client
  `res.req` is the `ClientRequest` as on real Node. The WebSocket
  upgrade emit site is untouched (different flow, no test covers it).

## Results

- `test-http-nodelay`: 1 -> 0.
- Guard battery (51 tests, stdin from /dev/null): 47 pass on branch.
  The 4 failures fail identically on pristine base `a3fdbd8d`
  (differential run): `test-net-server-nodelay` 1,
  `test-net-socket-setnodelay` 1, `test-net-persistent-nodelay` 1,
  `test-http-agent` 1 — pre-existing, not regressions. The net
  connect-shape guards pass on both:
  `test-net-connect-call-socket-connect` 0,
  `test-net-connect-nodelay` 0.
- `tests/ondemand-require.test.js`: 29/29 (allowlist set to this
  branch's file set).

## Known gaps left (out of scope)

- `net.Server` noDelay forwarding for http servers: http `listen()`
  creates its backing net server without options, so accepted server
  sockets still get `setNoDelay(false)` from the net layer. No test
  covers http server-side socket noDelay, and real Node shows no
  JS-level setNoDelay call to mimic — left alone.
- `server.noDelay` reassignment after listen does not propagate to
  the backing net server (same reason, same non-observation).
- Client request trailers / server `req.trailers` (from the #273 lane)
  remain open.
