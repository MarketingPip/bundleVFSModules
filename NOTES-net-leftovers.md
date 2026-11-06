# Net leftovers: BoundSocket port-0, bind-twice, server-blocklist

Base: `e81523d7` (PR #354 merged). All three targets failed on base (exit 1),
pass on real Node v24.22.1 (exit 0). Fix in `src/net.js` only (+ this file).

## Diagnosis (Node v24.20.0 source first, then probes)

- `BoundSocket` (`lib/net.js:398`, `lib/internal/errors.js:1804`):
  the shim stored `port: 0` literally, so `address().port` was 0; it had no
  `fd()`, no `isPipe`, no adopted-state errors, defaulted host to `"::"`
  (Node: `ipv6Only ? "::" : "0.0.0.0"`), and did DNS-ish fallback for
  `'localhost'` (Node throws `ERR_INVALID_ARG_VALUE` — no DNS is performed).
  Pipe binds returned `{ address: path }` from `address()` (Node returns the
  path string), so `server.listen(boundSocket)` took the TCP branch.
- `test-net-client-bind-twice`: a client binding `localPort` to a listening
  server's port must fail the bind. Probed real Node: async `'error'` with
  `EADDRINUSE`, `syscall: 'bind'`, `errno: -98`,
  `bind EADDRINUSE 127.0.0.1:<port>`. The shim had no listener-collision
  check in the `_doConnect` bind emulation.
- `test-net-server-blocklist`: a blocklisted connection is NOT refused.
  Probed real Node: the client sees `connect` → `end` → `close`
  (`hadError: false`), never `'error'` — the server accepts, then closes
  the accepted handle. The shim called `_connectFailed(_refusedError())`,
  surfacing an unhandled `ECONNREFUSED` on the client.
- Pipe `localAddress` (probed real Node): a plain `net.connect({ path })`
  client has `localAddress === undefined`; an adopted source pipe keeps its
  bound path. The shim's accept path overwrote an adopted client's
  `_sockname` with the destination path.

## Changes (`src/net.js` only)

- `BoundSocket` rewrite (faithful port of `lib/net.js:398`):
  - Port 0 allocates from the shared ephemeral pool (`allocPort()`, same
    pool as `listen(0)`); explicit ports conflicting with a live listener
    throw `EADDRINUSE`/`bind`/`-98` (`_tcpListenerConflicts`: exact match,
    wildcard listener covering the host, wildcard bind vs any listener).
    Role-neutral binds coexist (libuv `SO_REUSEADDR`), so no TCP registry
    is kept — only listening servers conflict.
  - Host validation in Node's order: non-object options and non-string host
    → `ERR_INVALID_ARG_TYPE`; non-IP host string → `ERR_INVALID_ARG_VALUE`
    (`options.host`, "must be a numeric IP address; net.BoundSocket does
    not perform DNS resolution"); non-loopback, non-wildcard IP →
    `EADDRNOTAVAIL`/`bind`/`-99`; privileged port when non-root →
    `EACCES`/`bind`/`-13`.
  - `fd()`: synthetic descriptor from a counter (>= 100, clear of stdio),
    `-1` on Windows. `isPipe` getter on the prototype. `address()` returns
    the path string for pipes. `address()`/`fd()`/`close()` throw
    `ERR_SOCKET_HANDLE_ADOPTED` after adoption or close; `_consume()`
    transfers ownership (called synchronously by `server.listen(bound)` and
    by `new Socket({ handle })`).
  - Pipe binds (`_bindPipe`): path mutually exclusive with the TCP options
    (`ERR_INVALID_ARG_VALUE`); non-string path → `ERR_INVALID_ARG_TYPE`;
    abstract (`\0`) paths rejected off Linux; over-long paths (> 107,
    `sun_path`) → `EINVAL`/`bind`; missing parent directory →
    `EACCES`/`bind` (via `existsSync` on the filesystem this runtime sees
    — real disk in the parity harness, memfs in the browser; see below);
    second bind to the same path → `EADDRINUSE`/`bind` (checked against
    the `_boundPipes` registry and listening pipe servers).
- `node:fs` import (one symbol, `existsSync`): resolves to real fs in the
  parity harness (verified: the preload returns null for `fs` under
  `PARITY_TARGET=net`, so the import is native), and to the memfs-backed
  shim fs in the browser build (esbuild externalizes `node:` builtins —
  same precedent as `src/url.js` importing `node:path`). No other fs API
  is used; the virtual transport never reads real disk.
- `Socket` adoption: the constructor stashes the bound endpoint into
  `_bindLocalAddress`/`_bindLocalPort` (TCP) or `_boundPath` (pipe) and
  consumes the handle; `connect()` preserves the stash on adopted sockets
  (it used to overwrite it with `undefined`) and restores `_sockname`
  synchronously, so `localAddress`/`localPort` resolve in-tick (Node's
  `connect(2)` is synchronous for an adopted handle).
- `_doConnect`: requested `localPort` colliding with a live listener fails
  async with the probed `EADDRINUSE` shape.
- `_acceptConnection`: blockList check moved after the remote-address
  computation (it now checks the real remote address, not hardcoded
  `127.0.0.1`) and uses the new shared `_dropPairedConnection` helper —
  the maxConnections drop pairing extracted verbatim (pair + `connect` +
  `ready`, then destroy the server side; no `'connection'` event, never
  counted). The drop path emits `'drop'` as before; the blockList path
  does not. The caller passes `clientPort` and `bindAddr` in: a `'drop'`
  listener may close the server (nulling `_bindAddress`) before the
  pairing runs, and a second ephemeral allocation would make the drop
  data's remotePort disagree with the paired port.
- Accept/drop pairing for pipes keeps an adopted client's source path as
  its local endpoint (`client._boundPath ?? req.path`); plain pipe clients
  keep the previous stand-in (real Node reports `undefined` there — a
  divergence no vendored test hinges on).
- `server.listen(boundSocket)` with `reusePort`: a second `reusePort`
  server may share the port (first registry entry stays for routing);
  `Server.close()` only releases a registry slot it owns.

## Known divergences (not fixed, no test hinges on them)

- `BoundSocket.fd()` returns a synthetic descriptor, not an OS fd. A test
  comparing it against a real fd (e.g. via `fs.fstat`) cannot pass.
- Non-loopback bindable addresses are limited to loopback + wildcards:
  the virtual layer has no interface enumeration, so binding a machine's
  real LAN IP throws `EADDRNOTAVAIL`.
- A wildcard (`0.0.0.0`/`::`) `BoundSocket` bind conflicts with ANY
  listener on the port, including an `ipv6Only` one (real Node would not
  conflict there).
- With `SO_REUSEPORT`, the second listening server is not in the routing
  registry (the first entry stays); a connection to the shared port
  always reaches the first server.
- Plain (non-adopted) pipe clients report `localAddress` as the destination
  path; real Node reports `undefined`.
- In the browser, the pipe-bind parent-directory check runs against memfs:
  a pipe path whose parent was not created in the virtual FS throws
  `EACCES`, matching real-fs semantics against the visible filesystem.

## Verification

- Targets on branch (each 0, twice): `test-net-boundsocket`,
  `test-net-client-bind-twice`, `test-net-server-blocklist` (all 1 on base,
  0 on real Node).
- Net-suite differential (`net-sweep.sh`, `net-sweep-leftovers-{base,branch}.csv`,
  156 rows each): base 78/72/6 → branch 81/69/5/1×137 — exactly the 3
  targets toward pass, 0 regressions. One mode change, sweep-only flake:
  `test-net-write-fully-async-buffer` 124→137 — it spins forever in the
  `while (conn.write(...))` loop on BOTH sides (no backpressure from the
  virtual transport); isolated runs are 124 on base 3/3 and 124/137/124 on
  branch, i.e. whether the process exits inside the 5 s TERM grace, not a
  behavior change. Its execution path is untouched by this lane (no
  localPort, no blockList, no drop).
- Regression caught + fixed by the differential: `test-net-server-drop-connections`
  0→1 in the first branch sweep — `_dropPairedConnection` re-read
  `this._bindAddress`, but a `'drop'` listener may close the server (nulling
  it) before the pairing runs, and it allocated a second ephemeral port
  (drop data's remotePort ≠ paired port). Fixed: caller passes `clientPort`
  and `bindAddr` in; all four tests 0×2 after.
- Repo test corrected: `tests/net.test.js` "server blockList refuses
  connections" asserted client error `ECONNREFUSED` — contradicts real Node
  (`lib/net.js:2730-2733` closes the accepted handle; probe: connect → end →
  close, no error) and the official test. Updated to the probed shape
  (`["connect", "end", ["close", false]]`, no server `'connection'`).
  Same precedent as #346 (repo fixtures corrected when the fix proved them
  wrong). `tests/` files are excluded from the footprint allowlist.
- HTTP fast-sweep differential (`http-sweep-nl-{base,branch}.csv`): 0 changes
  (359/3/35/1/1 both sides).
- HTTPS sweep (`https-sweep-nl-{base,branch}.csv`): 0 changes (30/31/6 both).
- Guards 18/18 http flips + 2/2 https twins exit 0 on branch.
- Repo jest suite: 3059 passed / 7 failed / 1 skipped (known baseline).
- `tests/ondemand-require.test.js`: 29/29 (non-vacuous).
- Builds: `build-vfs` 0, `build-sandbox --check` 0, `build-runtime --check` 0.
