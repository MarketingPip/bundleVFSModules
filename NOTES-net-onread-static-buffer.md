# NOTES: net `onread` static buffer (triage lane 23)

## Target

`test-net-onread-static-buffer` — 6 sub-tests. Before: exit 1,
`mustNotCall('data')` fired with `<Buffer 68 65 6c 6c 6f 20 77 6f 72 6c 64>`
("hello world"). After: exit 0, 3x isolated.

## Mechanism (Node source, `lib/net.js:674-684`, `lib/internal/stream_base_commons.js:166+`)

The Socket ctor stashes `kBuffer` (the user buffer, or `true` + `kBufferGen`
when `buffer` is a function) and `kBufferCb` when `onread` is an object with
a Uint8Array-or-function `buffer` and a function `callback` (invalid shapes
are silently ignored). `onStreamRead` then calls the callback as
`kBufferCb(nread, userBuf)` with `this` = the socket; if it returns `false`,
the handle stops reading (`readStop()`); if a generator exists, it is called
for the next buffer after each read. `nread === 0` returns early; EOF pushes
null and never calls the callback. `pause()` stops the handle when a user
buffer is set; `resume()`/`read()` restart it (`lib/net.js:1046-1073`).

## Shim before

The ctor ignored `options.onread` entirely; `_receiveFromPeer` always
`push()`ed, so the bytes surfaced as `'data'`.

## Fix (`src/net.js` only)

- Ctor: validates `options.onread` per Node (`buffer instanceof Uint8Array`
  or function, `typeof callback === 'function'`); stashes
  `_onreadCallback`, `_onreadReading = true`, `_onreadPending = []`,
  `_onreadEofPending = false`, `_onreadBufferGen`, `_onreadBuffer`
  (static buffer, or the generator's first result if a Uint8Array).
- `_onreadDeliver(buf)`: splits the chunk to the current user buffer's
  length, copies via `userBuf.set(...)`, calls
  `this._onreadCallback.call(this, n, userBuf)`; fetches the next buffer
  from the generator after each call (keeps the old one if the generator
  did not return a Uint8Array); stops and queues the remainder when the
  callback returns `false` or `pause()` ran mid-chunk; a zero-length user
  buffer tries the generator once, else queues and stops.
- `_onreadDrain()`: drains `_onreadPending` in order while reading, then
  delivers a held EOF.
- `_receiveFromPeer`: with onread active, drains queued bytes first (when
  reading), then delivers into the user buffer instead of `push()`.
  `_bytesRead` increment and `_refreshTimeout()` unchanged.
- `_receiveEOF`: while delivery is stopped, holds EOF (`_onreadEofPending`)
  until `resume()` drains; while reading, drains queued bytes first, then
  delivers EOF. `_deliverEof` now guards against a double EOF.
- `pause()`/`resume()` overrides: pause sets `_onreadReading = false`;
  resume sets it true and drains, then delegates to Duplex. (Mirrors
  Node `lib/net.js:1046-1073`.)

## Ordering trap (why `read()` is NOT overridden)

The virtual transport delivers data synchronously during the handshake,
*before* the client's `'connect'` event fires — an ordering real Node's
kernel RTT never produces. The stream machinery therefore calls `read()`
from `flow()` / `resume_` / the post-connect `read(0)` *after* a
callback-induced stop (callback returned `false`, or `pause()` ran inside
a callback — test 6's implicit pause at line 170 asserts the callback is
not re-entered while its `paused` flag is set). An earlier version of this
lane overrode `read()` to resume + drain synchronously; that delivered the
queued remainder inside those internal reads and failed test 6
deterministically. The fix drains only on explicit `resume()` and on
new-data / EOF arrival — never inside `read()` / `_read`.

## Ceiling (`ponytail:`)

- If a buffer generator's first buffer is not a Uint8Array, onread is
  dropped and the socket falls back to `'data'` (no vendored test covers it).
- An explicit user `read()` while delivery is stopped does not restart
  delivery (Node's `Socket.prototype.read` does); no vendored test covers it.

## Regression caught in-lane (2026-11-15)

An earlier version of this lane guarded `_deliverEof` with
`if (this.destroyed || this._eofReceived) return;` to prevent a double
EOF delivery. That hung `test-net-boundsocket`, `test-net-bytes-stats`,
`test-net-reconnect` and `test-net-socket-local-address` (all 124 in the
sweep and 8/8 in isolated re-runs, while base passed all 4 in <2s): the
transport legitimately calls `_receiveEOF` twice on the same socket in
some flows (FIN then destroy, `src/net.js:3137,3141`), and the repeat
`_deliverEof` (`push(null)` + `read(0)` + `_maybeReleaseLoop()`) is
load-bearing. The guard was removed; `_deliverEof` keeps the original
repeat behavior, and the onread double-delivery is prevented instead by
`_onreadDrain` returning true when it delivers a held EOF, with
`_receiveEOF` returning early in that case.

## Rebase composition with N2-17 (2026-11-15, #416 pause-on-connect)

N2-17 landed while this lane was in flight and added a paused-read queue
(`_pausedReadQueue`, `_drainPausedReads`, a `resume()` override) in the
same `_receiveFromPeer` region. Composition, resolved at rebase onto
`e676a302`: both method sets kept; ONE `resume()` (onread drain before
the super call, paused-queue drain after); and `_receiveFromPeer` checks
onread BEFORE the paused-queue check — onread owns the socket's read
path, so a chunk arriving on a paused onread socket stays in
`_onreadPending` instead of being pushed later as `'data'`.

## Verification

- Target 3x isolated, exit 0 (was exit 1 on base `b2657677`).
- Differential: fast-sweep `--target net --force`, base vs branch
  (CSVs in goal hidden_files; see PR body).
- Guards: related passing net tests re-run (see PR body).
