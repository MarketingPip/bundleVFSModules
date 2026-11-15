# NOTES — net lane N2-25: destroy-with-unread-data RST (test-net-stream)

## Target (1 flip)
- `test-net-stream`: 1 → 0. Server writes 10×2 MB then `end()`; client pauses
  after the first chunk and `destroy()`s 20 ms later with ~18 MB unread. Real
  Node delivers `ECONNRESET` to the server socket (`'error'` mustCall); the
  shim delivered a graceful EOF, so the server's `'error'` handler never fired.

## Fix (`src/net.js` only, `_destroy` notifyPeer)
- Kernel RST rule: closing a TCP socket with unread data in its receive
  buffer sends RST, not FIN. Node `lib/net.js:1095` `_destroy` just closes
  the handle; the kernel decides. The shim now captures
  `this.readableLength` at `_destroy` time and, in the deferred peer
  notification, destroys the peer with `errConnReset()` when unread > 0,
  otherwise delivers EOF as before (`peer._receiveEOF()`).
- Probed on real Node v24.22.1 (zz-probes, deleted after use):
  - Read-everything-then-destroy → server `["end","close:false"]` (clean).
  - Unread-data destroy, no server `end()` → server
    `["error:ECONNRESET","close:true"]`.
  - Both shapes match exactly under the shim after the fix.
- Deliberately NO `peer.writableEnded` carve-out: test-net-stream's server
  had already `end()`ed and still errors on real Node. (The
  `resetAndDestroy` carve-out is specific to explicit resets; it was not
  touched.)
- `ponytail:` no new state — reuses `readableLength` (`_readableState.length`,
  the buffered unread byte count); nothing can add to the buffer after
  destroy, so the captured count is stable.

## Differential
- Branch sweep: `hidden_files/fast-sweep/net-n2-destroy-rst-branch-2026-11-14.csv`
  (124 pass / 12 timeout / 20 fail; heavy contention — 150 files hit the 10 s
  cap and re-ran at 30 s).
- Base sweep: `hidden_files/fast-sweep/net-n2-destroy-rst-base-2026-11-14.csv`
  (scratch worktree at main 327f9a62): 128 pass / 6 timeout / 22 fail.
  Branch: 124 pass / 12 timeout / 20 fail (heavier contention).
- Changed lines (matched, sorted): toward-pass exactly
  `test-net-stream.js` 1 → 0. Zero regressions. Adjudicated isolated 2×
  on the rebased branch: connect-memleak, listen-handle-in-cluster-2,
  normalize-args, socket-constructor, pipe-connect-errors all 0, 0 (sweep
  124s are load noise; pipe-connect-errors 0→1 in the CSV is an artifact —
  the branch sweep predated #415's merge into main, and the rebased branch
  passes it); end-close 1, 1 and listen-exclusive-random-ports 1, 1
  (lanes 24 / 19 targets, matching base).
- Target re-run isolated 2× on branch: 0, 0. Base isolated: 1.
- Rebased twice after the sweeps (main moved: #415, then #419 + #421);
  final base f3fe19cf. src/net.js auto-merged each time; target re-run
  0, 0 and guards (write-after-close, destroy-twice, connect-reset) 0 on
  the final rebased tree; footprint 29/29.
- Rebase onto c971cef0 (#414/#416/#417) REGRESSED the target (exit 1):
  #416 queues inbound chunks in `_pausedReadQueue` while explicitly
  paused — uncounted and unpushed — so `readableLength` alone read ~0
  while ~18MB sat in the queue. Fix: the unread count now sums
  `readableLength` + the queue's byte length. Target 0, 0 again;
  pause-on-connect, write-after-close, connect-reset, destroy-twice all
  0; clean-destroy discriminator re-probed on the rebased tree
  (shim == native `["end","close:false"]`); footprint 29/29.
- STASH LESSON (this lane): `git stash` is repo-global across worktrees —
  a `stash push` on a clean committed tree saves nothing, and the following
  `stash pop` applied a STRANGER's leftover stash (a NOTES-net-pipe-bind.md
  edit from another lane) into this worktree. Never stash in this shared
  repo; use a scratch worktree at origin/main for base measurements. The
  first "base" CSV was invalid (ran with the fix committed) and is being
  overwritten by the scratch-worktree run.

## Guards (all 0 on branch unless noted)
- net: connect-reset, socket-reset-twice, socket-destroy-twice,
  connect-immediate-destroy, connect-buffer, server-close, allow-half-open,
  socket-byteswritten, stream (target).
- http (PARITY_TARGET=http): conn-reset, destroyed-socket-write2,
  outgoing-destroyed, client-abort.
- `test-net-end-close` exit 1 on base AND branch (lane 24 target).
- Footprint test 29/29; `node --check`, sandbox/runtime checks, local
  build-vfs all exit 0.

## Ship
- PR: (fill in) — squash-merged (fill in SHA).
- Pre-existing quirk (not this lane): a probe shaped like probe-B lingers
  past its 5 s timer under the shim (exit 124) on base AND branch; the
  target test itself exits promptly. Not chased.
