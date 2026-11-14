# Net socket-option methods — lane N1-12

Targets: `test-net-keepalive-interval-count`, `test-net-socket-tos`
(PARITY_TARGET=net). Base main `3199bb5d`, recorded net 87/156.

## keepalive-interval-count (1 → 0)

`Socket.prototype.setKeepAlive` ported verbatim from Node `lib/net.js:844-882`:

- Object form: `setKeepAlive({enable, initialDelay, interval, count})`
  unpacks to the positional form.
- Milliseconds → whole seconds for delay AND interval
  (`~~(ms / 1000)`; omitted interval stays `undefined`), forwarded as
  4 args `(enable, delay, interval, count)` to `_handle.setKeepAlive`.
- Cached slots now hold seconds (`_keepAliveInitialDelay`,
  `_keepAliveInterval`, `_keepAliveCount`), matching Node's
  `kSetKeepAlive*` slots; the dedupe (call the handle only when the
  effective values changed) is part of the port.
- Ctor seeds the cache from `options.keepAlive` / `options.keepAliveInitialDelay`
  (Node `lib/net.js:687-689`); `connect()` options still clamp a negative
  delay to 0, and the connect-time apply site (`emitClientConnect`, mirroring
  Node's `afterConnect`) now forwards all four cached values instead of
  converting ms→s itself. The server accept path is unchanged — it passes
  `keepAliveInitialDelay * 1000` (ms) into `setKeepAlive`, which converts.
- `VirtualHandle.setKeepAlive` accepts/stores all four values.

The dedupe is observable, not cosmetic: `test-net-server-keepalive` (lane 9)
expects the accept-time apply to swallow a repeat `setKeepAlive(true, 1000)`
so only the 2000/3000 calls reach the handle — with the old forward-everything
shape that test could never pass once lane 9 lands `_handle.onconnection`.

## socket-tos (1 → 0)

`setTypeOfService` / `getTypeOfService` ported from Node `lib/net.js:889-940`:

- Validation first: NaN → `ERR_INVALID_ARG_TYPE`; non-number →
  `ERR_INVALID_ARG_TYPE` (via `validateInt32`); outside 0–255 →
  `ERR_OUT_OF_RANGE`.
- Value cached in a module-level `kSetTOS` symbol slot (Node `lib/net.js:374`)
  when there is no handle, and applied to the handle at connect (Node
  `afterConnect`, `:1993`). `getTypeOfService` returns the cached value or 0
  when there is no handle / the handle has no getter, else the handle's value.
- `VirtualHandle` stores TOS (`setTypeOfService` returns 0 = success,
  `getTypeOfService` returns the stored value or 0). No real `setsockopt`
  exists in the browser — cached-value semantics is the ceiling; a test
  asserting OS-level DSCP bits on the wire cannot pass through this transport.

## Differential

- Base CSV: `hidden_files/fast-sweep/net-n1-base-2026-11-14.csv`
- Branch CSV: `hidden_files/fast-sweep/net-n1-branch-2026-11-14.csv`
- Claimed flips (isolated 2× each on the branch): keepalive-interval-count
  1→0, socket-tos 1→0. No other changed-value lines.
- Guards re-run 0: connect-keepalive, keepalive, persistent-keepalive,
  after-close.
- Still failing exactly as on base (other lanes' regions, untouched):
  server-keepalive + server-nodelay (lane 9: `server._handle.onconnection`
  undefined), socket-setnodelay (lane 16: plain-object handle ignored,
  mustCall 3 actual 0).

## Files

- `src/net.js` (only)
- `NOTES-net-socket-options.md` (this file)
