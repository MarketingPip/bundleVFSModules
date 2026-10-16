# Net Parity Notes

## Baseline (2026-10-16)

**Official tests:** 156 `test-net-*.js` files vendored from nodejs/node v24.20.0
(they were never fetched before).

**With harness:** 69/156 pass (44%)
- 80 fail
- 7 timeout

**Without harness:** 1/156 pass (all fail on timer global-leak check)

## Harness

Created `parity/net-harness.mjs` (timer restoration, mirrors http-harness.mjs).
Wired into:
- `parity/preload.mjs` (CJS): `if (target === "net" && name === "net")`
- `parity/hooks.mjs` (ESM): same condition

Note: `preload.mjs` is a shared file per AGENTS.md, but the change follows the
exact established pattern (one 6-line block per module) and is required for
any net parity measurement.

## Fixes

### 1. VirtualHandle (test-net-connect-keepalive, test-net-connect-nodelay)

**Problem:** `socket._handle` was always `null`. Tests mock
`_handle.setKeepAlive`/`setNoDelay` to verify socket options are applied.

**Fix:**
- Added `VirtualHandle` class with `setKeepAlive`, `setNoDelay`, `ref`,
  `unref`, `close` methods
- `Socket.connect()` creates `this._handle = new VirtualHandle()` (so tests
  can mock it immediately after `net.connect()` returns)
- `Socket.prototype.setKeepAlive`/`setNoDelay` delegate to `_handle` when present
- `_acceptConnection` applies `keepAlive`/`noDelay` options to the handle on
  connect, with ms→s conversion for keepAlive delay (Node's C++ TCPWrap takes
  seconds; JS API takes milliseconds)
- `Socket._destroy` sets `_handle = null` (preserves "tests assert
  `socket._handle === null`" for closed sockets)
- Server-side accepted sockets also get a VirtualHandle

### 2. blockList on Socket.connect (test-net-blocklist)

**Problem:** `net.connect({ blockList })` never stored the blockList on the
socket, so `_doConnect`'s blockList check (`if (this.blockList)`) never fired.
Tests expecting `ERR_IP_BLOCKED` got `ECONNREFUSED` instead.

**Fix:** `Socket.connect()` now sets `this.blockList = options.blockList`.

## Triage Categories

### Inherent (don't chase)
- **autoselectfamily (8 tests):** Test Node CLI flags
  (`--network-family-autoselection-attempt-timeout`) and real DNS behavior.
  No DNS resolver in browser shim by design.
- **internal bindings (1 test):** `internal/test/binding` — Node internals.
- **Worker threads (2 tests):** `DataCloneError` in transferList — worker
  integration, not net shim.

### Harness limitations
- Tests requiring `internal/js_stream_socket` or other Node internals.

### Needs investigation
- 15 module-load errors (need to check each)
- 23 assertion failures (need to categorize)
- 7 timeouts

## http Integration

The http shim's `Server.listen()` creates a net server via
`createNetServer()` from `./net.js`, binding in the shared virtual registry
(`RT.__netSharedState`). This means `net.createConnection(port)` CAN connect
to an http server's port — they share the registry.

**Blocker for http tests:** The parity harness only redirects `PARITY_TARGET`.
When running http tests (`PARITY_TARGET=http`), `require('net')` gets the
REAL Node net, which can't see the virtual registry. Fixing this requires
harness changes (redirect both `http` and `net`), which is a cross-module
concern beyond the net lane.

## Repo tests

`tests/net.test.js`: 78/78 pass (no regressions).
