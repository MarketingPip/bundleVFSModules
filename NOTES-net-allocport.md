# Net lane N2-19 — allocPort: randomized ephemeral start + registry skip

## Target

- `test-net-listen-exclusive-random-ports` — 1 → 0 (isolated 10× on branch).

## Mechanism

Cluster workers are separate processes sharing no counter: `allocPort`
(`src/net.js`) started every process at a fixed 40000 and incremented
sequentially, so each worker's `listen({port: 0, exclusive: true})` bound
40000 and the test's `assert.notStrictEqual(port1, port2)` failed. It also
never consulted the `_tcpServers` registry — a wrapped-around counter could
hand out a live listener's port (which `_bindTCP` would then reject with
`EADDRINUSE` instead of allocating).

## Fix (`src/net.js` only)

- Per-process start randomized: `40000 + Math.floor(Math.random() * 20000)`.
- `allocPort()` now skips any port held in the `_tcpServers` registry
  (suffix scan on `:${port}`, the same idiom `_tcpListenerConflicts`
  already uses), so a wrapped-around counter never returns a live
  listener's port. The loop's 20000-iteration bound and the
  `return nextEphemeral++` fallback are unchanged.

## Ceiling / probabilistic note

Cross-process uniqueness is probabilistic (~1/20000 collision), not
deterministic — there is no shared registry between processes, and real
Node gets its uniqueness from the kernel instead. The flip was verified
with 10 consecutive isolated passes, not a single run. The registry-skip
half is defensive and is not exercised by the vendored test (it only
matters on counter wraparound); it was verified by code inspection
against the `_tcpServers` key shape, not by a test.

## Guards (isolated, branch)

- 0: server-listen-options, listen-invalid-port, connect-immediate-destroy,
  socket-destroy-twice, server-close, listen-error, connect-buffer.
- Unchanged vs base: reuseport 1 (lane 15's target), listen-twice 124
  (lane 14's target).
- No test depends on the literal 40000 start (grep: only unrelated
  `0o040000`/`0o140000` constants, `src/http2.js`'s own counter, and
  timeouts). `allocPort` is used only by `src/net.js`.

## Differential

- fast-sweep `--target net --force`, fresh filenames:
  `hidden_files/fast-sweep/net-n2-allocport-base-2026-11-15.csv` (base,
  main `453d2976`) vs `net-n2-allocport-branch-2026-11-15.csv` (branch).
- Changed lines (sorted, deduped): exactly one toward-pass, zero
  regressions —
  `test-net-listen-exclusive-random-ports.js: 1 -> 0` (the target).
  Only other changed line: `test-net-write-fully-async-buffer.js:
  124 -> 137`, the known pre-existing spinner (same spin, 124 isolated /
  137 sweep — mode change, not a regression). Base pass 127, branch 128.

## Ship

- Branch `fix/net-allocport`; PR #___ (squash-merged ___).
- Rebased onto main `453d2976` (docs sync #413 landed after the lane
  branched from `b2657677`; docs-only, allowlist-only conflict).
