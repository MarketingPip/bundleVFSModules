# NOTES — net lane N2-21: pipe-connect-errors (1 flip)

## Target
`test-net-pipe-connect-errors` 1 → 0. Base (main `b2657677`, fresh
fast-sweep): 127/156 pass. Branch: 128/156, exactly the 1 target toward-pass,
0 regressions (see differential below).

## Mechanism
`Socket._doConnect` pipe branch and `Socket._refusedError` both report a
missing pipe via `errConnRefusedPipe`, which always built `ENOENT` — even
when the path exists and is not a socket. Real libuv/Node distinguishes:
probed real Node v24.22.1: connect to an existing plain file →
`ECONNREFUSED` (-111, `connect ECONNREFUSED <path>`); connect to a missing
path → `ENOENT` (-2). (A socket with no listener refuses the same way, so no
`isSocket()` split is needed.) The test accepts `ENOTSOCK` or
`ECONNREFUSED`, so either would satisfy it; the fix emits the probed
real-Node shape.

## Fix (`src/net.js` only, `errConnRefusedPipe`)
`fsExistsSync(path)` (already imported for pipe-bind) gates the error:
exists → `ECONNREFUSED` (-111, `connect ECONNREFUSED <path>`, with `path`);
missing → `ENOENT` (-2) as before.

ponytail: one conditional inside the existing factory; no new factory, no
call-site changes — both call sites (`_doConnect` pipe-miss, `_refusedError`)
share the factory, so both get the distinction. Ceiling: the EACCES
sub-case (chmod 0 pipe) is out of scope — the test skips it as root, and the
shim has no permission model for pipe files.

## Differential
- Base: `hidden_files/fast-sweep/net-n2-pipe-base-2026-11-14.csv`
  (127 pass / 6 timeout / 23 fail, fresh fast-sweep on main `b2657677`).
- Branch: `hidden_files/fast-sweep/net-n2-pipe-branch-2026-11-14.csv`
  (125 pass / 12 timeout / 19 fail). Matched changed-value lines:
  `test-net-pipe-connect-errors.js,1→0` (the claimed flip) and six
  `→124` lines, all adjudicated as sweep-timeout noise, not regressions:
  the branch sweep ran under 14-lane contention (83 files hit the 10s
  phase-1 cap vs 6 in the base run). Isolated 2× on the branch, all exit 0:
  autoselectfamily-commandline-option, listen-handle-in-cluster-2,
  socket-constructor (all 0 in base). The other three 124s were already
  failing (1) in base — mode changes only: listen-exclusive-random-ports
  (lane 19's probabilistic target), persistent-ref-unref and
  server-listen-handle (both triage NO-FIX).
- Target isolated 2× on branch: exit 0, 0.
- Guards (all 0 on branch): connect-options-path, server-listen-path,
  pipe-with-long-path, better-error-messages-listen-path.
- Footprint test 29/29; `node --check src/net.js` ok.

## Ship
PR #___ (squash-merged as ___). Branch `fix/net-pipe-connect-errors`.
