# Net lane N2-17 — pause-on-connect (1 flip)

## Target
- `test-net-server-pause-on-connect` 1 → 0 (isolated 2× on branch).

## Mechanism (proven)
Real Node creates the accepted socket paused (`pauseOnCreate:
self.pauseOnConnect`, node-src `lib/net.js:2738`) and only counts bytes in
`onStreamRead` — while paused the libuv read is stopped, so `bytesRead`
stays 0 until `resume()`. The shim's `_receiveFromPeer` counted + pushed
unconditionally, so a `pauseOnConnect: true` server socket read `bytesRead`
4 the moment the client wrote `'test'`. Baseline: shim exit 1
(`AssertionError: 4 !== 0` at `test-net-server-pause-on-connect.js:53`),
native exit 0.

## Fix (`src/net.js` only)
- Ctor: `this._pausedReadQueue = []`, `this._pausedEOF = false`.
- `_receiveFromPeer`: while the readable side is EXPLICITLY paused
  (`this._readableState.paused`), hold the chunk in `_pausedReadQueue`
  uncounted (no `bytesRead` increment, no timeout refresh, no `push`).
- `Socket.prototype.resume` (new override): calls
  `Duplex.prototype.resume`, then `_drainPausedReads()`, which counts +
  pushes each held chunk in arrival order, then delivers a deferred EOF.
  Drain is resume-only: a bare `read()` on a paused socket must NOT drain
  (real Node leaves kernel data unread until the read watcher restarts).
- `_receiveEOF`: if explicitly paused with queued data, defer
  (`_pausedEOF = true`) instead of `push(null)` now — otherwise the
  stream would end before the held chunks flow. Paused with an empty
  queue keeps the old behavior (`push(null)` + `read(0)` so `'end'`
  still emits while paused).

## The isPaused() trap (caught by the differential, fixed in-lane)
The first version keyed the queue on `isPaused()`. That is WRONG:
`isPaused()` is also true for any paused-mode socket — e.g. one with
only a `'readable'` listener (`readable.js` `on('readable')` sets
`kHasFlowing` without `kFlowing`) — and those keep reading + counting
in real Node; only an EXPLICIT `pause()` stops the libuv read. The
`isPaused()` version hung `test-net-buffersize` and
`test-net-socket-close-after-end` (124, 124 isolated on branch; 0, 0 on
base). The fix keys on `_readableState.paused` (the `kPaused` bit, set
only by `pause()`, cleared by `resume()` — `readable.js:1634`). After
the correction: target 0, 0; buffersize 0, 0; socket-close-after-end
0, 0 (branch, isolated 2×); base 0, 0 for both.

## Corners probed (zz probe, deleted after use; passed shim 2× and native)
- EOF arriving while paused with queued data: resume → `'data'` then
  `'end'`, in order, `bytesRead` 5 at both.
- Bare `read()` on a paused socket returns `null`, `bytesRead` stays 0;
  `resume()` then flows the data.

## Guards (all 0 on branch unless noted)
- `test-net-connect-paused-connection`, `test-net-pause-resume-connecting`,
  `test-net-bytes-stats`, `test-net-socket-byteswritten`,
  `test-net-connect-buffer`, `test-net-connect-buffer2`,
  `test-net-after-close`, `test-net-pingpong`, `test-net-server-reset`,
  `test-http-agent-free-socket-data-guard`, `test-http-pause`,
  `test-http-pause-no-dump`, `test-http-pause-resume-one-end` — 0.
- `test-net-stream` (lane 25 target) and `test-net-end-close` (lane 24
  target) exit 1 on branch AND on pristine base with identical failure
  text — pre-existing, not regressions.

## Differential
- Base: `hidden_files/fast-sweep/net-n2-pause-base-2026-11-15.csv`
  (fresh full sweep on main `b2657677`; 121 pass / 16 timeout / 19 fail).
- Branch: `hidden_files/fast-sweep/net-n2-pause-branch-2026-11-15.csv`
  (123 pass / 12 timeout / 21 fail — run on the pre-correction tree).
- Changed-value lines (11, sorted): after-close 124→0, autoselectfamily-
  attempt-timeout-cli-option 124→0, buffersize 0→124, listen-handle-in-
  cluster-2 124→0, normalize-args 124→0, persistent-nodelay 124→1,
  persistent-ref-unref 124→1, server-listen-handle 124→1,
  server-pause-on-connect 1→0 (the flip), socket-close-after-end 0→124,
  socket-constructor 0→124.
- Adjudication (isolated, branch + base): the 124→0 lines (after-close,
  autoselectfamily-cli-option, listen-handle-in-cluster-2, normalize-args)
  are 0, 0 on branch — base-124 load flakes. socket-constructor 0, 0 on
  branch — load flake. persistent-nodelay / persistent-ref-unref /
  server-listen-handle 124→1 are NO-FIX tests, still non-pass both sides
  (mode change only). buffersize + socket-close-after-end 0→124 were a
  REAL regression from the first (isPaused-keyed) version — see the trap
  section above; fixed by keying on `_readableState.paused`, re-verified
  0, 0 on branch and base. Net differential after correction: exactly
  the 1 claimed flip, 0 regressions.

## Ceiling
- The paused queue is unbounded, like the kernel receive buffer it stands
  in for; the virtual transport has no backpressure to push back on the
  peer with.
