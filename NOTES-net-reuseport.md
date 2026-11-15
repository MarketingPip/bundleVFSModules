# NOTES — net lane N2-15: reusePort (1 flip)

## Target
- `test-net-reuseport` 1 → 0 (isolated 2× on branch; 1 on base).

## Mechanism
`server2.listen({ port, reusePort: true, host })` failed `EADDRINUSE`
from `Server._bindTCP`: `listen()` never recorded `options.reusePort`,
and the sharing check in `_bindTCP` only honored the
BoundSocket-adopted slot (`_reusePortAdopted`). Node sets
`UV_TCP_REUSEPORT` on the bind when `options.reusePort === true`
(node-src `lib/net.js:189-191`, `getFlags`) and `listen()` forces
`options.exclusive = true` in that case (`:2549`) — the kernel shares
the port instead of the cluster master.

## Fix (`src/net.js` only, 16 insertions / 3 deletions)
1. `Server.prototype.listen` TCP branch: record
   `this._reusePort = options.reusePort === true` per listen() call,
   and clear `this._reusePortAdopted = false` — a fresh TCP listen
   supersedes any earlier BoundSocket adoption, so the adopted slot
   must not go stale across a close + re-listen.
2. `_bindTCP` sharing check: sharing allowed only when BOTH ends asked
   for it — `(this._reusePortAdopted || this._reusePort) &&
   (existing._reusePortAdopted || existing._reusePort)`. The kernel
   requires every socket on the shared addr:port to carry the flag; a
   plain second listen still gets `EADDRINUSE` (guarded by
   `test-net-listen-error`).
   The first registry entry stays for routing, as in the adopted case.

## Ceiling / ponytail
- No boolean validation of `options.reusePort` in `listen()` — Node
  doesn't validate it there either (only `=== true`); BoundSocket
  already validates its own. Nothing else added.

## Guards (isolated, branch)
- `test-net-listen-error` 0 (plain second listen still EADDRINUSE),
  `test-net-server-listen-options` 0, `test-net-listen-invalid-port` 0,
  `test-net-server-listen-path` 0, `test-net-server-keepalive` 0,
  `test-net-server-nodelay` 0, `test-net-connect-immediate-destroy` 0.
- Pre-existing on base (verified by stash + isolated re-run, and the
  triage base CSV): `test-net-listen-twice` 124 (lane 14's target),
  `test-net-listen-exclusive-random-ports` 1 (lane 19's target),
  `test-net-boundsocket` 0.

## Differential
- Branch CSV: `hidden_files/fast-sweep/net-n2-reuseport-branch-2026-11-15.csv`
  (124 pass / 13 timeout / 19 fail).
- Base CSV: `hidden_files/fast-sweep/net-n2-reuseport-base-2026-11-15.csv`
  (fresh fast-sweep on origin/main `453d2976`, scratch worktree;
  120 pass / 15 timeout / 21 fail).
- Matched changed-value lines (sorted, deduped):
  - `test-net-reuseport.js`: base=1 branch=0 — THE flip.
  - `test-net-autoselectfamily-attempt-timeout-cli-option.js`: base=124 branch=0
  - `test-net-normalize-args.js`: base=124 branch=0
  - `test-net-socket-constructor.js`: base=124 branch=0
  - `test-net-end-close.js`: base=1 branch=124
- Adjudication (isolated 2× each, branch AND base): the three 124→0 lines
  are 0/0 on both sides (sweep contention noise — 134 files hit the 10s
  cap in the branch sweep phase 1 under 14-lane contention); end-close
  is 1/1 on both sides (branch sweep 124 was the same noise). Exactly
  1 flip, 0 regressions. (Base sweep pass 120 < recorded 127 is the same
  contention noise; the recorded count stands on isolated verification.)

## Ship
- Branch: `fix/net-reuseport`. PR: (filled in at ship time).
