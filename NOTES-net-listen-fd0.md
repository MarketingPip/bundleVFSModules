# NOTES — net: listen({fd}) async EINVAL/ENOTSOCK (triage lane 27)

Target: `test-net-listen-fd0` (1 → 0).

## Mechanism (probed real Node v24.22.1, node-src lib/net.js:2528)

Real `Server.prototype.listen` checks the fd path BEFORE the port/path
branches: `typeof options.fd === 'number' && options.fd >= 0` routes to
`listenInCluster(..., fd)` → `setupListenHandle` → `createServerHandle`,
which hands the fd to libuv. A bad fd errors ASYNC via
`process.nextTick(emitErrorNT, ...)` — never a sync throw:

- `{fd: 0}` (stdin, an open non-socket) → async `ENOTSOCK`,
  `listen ENOTSOCK: socket operation on non-socket`, syscall `listen`.
- `{fd: 1.5}` (non-integer) → async `EINVAL`, `listen EINVAL: invalid argument`.
- `{fd: 3}` (closed fd) → async `EINVAL`.
- `{fd: -1}` / `{fd: 'x'}` → sync `ERR_INVALID_ARG_VALUE` (fd branch not
  taken; falls through to the port/path check) — unchanged by this lane.

The shim fell through to the final `if (!("port" in options ||
"path" in options))` throw, so `{fd: 0}` threw sync `ERR_INVALID_ARG_VALUE`.

## Fix (`src/net.js` only)

- `Server.prototype.listen`: new fd branch placed BEFORE the port branch,
  matching Node's precedence (fd wins over port for `{fd: 0, port: 0}`).
  Condition mirrors Node exactly: `typeof options.fd === 'number' &&
  options.fd >= 0`.
- A browser has no fd table, so no fd can ever be adopted: integer fds
  emit async `ENOTSOCK` (new `errFdNotSocket()`, errno -88), non-integers
  async `EINVAL` (new `errFdInvalid()`, errno -22) — both via the existing
  `errnoError()` factory, same `listen <CODE>: <message>` shape as
  `errAddrNotAvail`. No `_bindPending`/`_handle` state is touched (the
  outcome is decided synchronously, like the TCP `_bindTCP` path), so a
  re-listen after the error works.
- `ponytail:` ceiling — a closed integer fd reads `EINVAL` in real Node,
  `ENOTSOCK` here; indistinguishable without a real fd table, and no
  vendored test covers it. Valid-fd adoption is impossible in the browser
  (see triage NO-FIX: server-listen-handle) — the async error IS the lane.

## Verification

- Target `test-net-listen-fd0`: 1 → 0, isolated 2× on branch.
- zz probe (deleted after use) under the shim, all matching real Node:
  fd 0 → ENOTSOCK with exact message/syscall/errno; fd 1.5 → EINVAL;
  fd -1 / fd 'x' → sync ERR_INVALID_ARG_VALUE; fd 0 + port 0 → ENOTSOCK
  (fd precedence); re-listen on a port after the fd error works.
- Differential: fast-sweep `--target net` base vs branch (CSVs in
  goal hidden_files/fast-sweep/); guards: listen-adjacent passing tests
  re-run 0 (see PR body).
  Base CSV `net-n2-listen-fd0-base-2026-11-14.csv` (full, 156 rows, on
  main b2657677): 126 pass — the 127th recorded pass is
  listen-handle-in-cluster-2, 124 here under 14-lane contention (passes
  isolated; known load flake). Branch targeted CSV
  `net-n2-listen-fd0-branch-targeted-2026-11-14.csv` (49 rows: all base
  non-pass + 20 listen-family passing extras): exactly one changed line,
  listen-fd0 1→0; 0 regressions. Three mode changes adjudicated isolated
  2× as contention flakes, not regressions: connect-options-fd 0→124
  (isolated 0×2 on branch), end-close 1→124 (isolated 1×2, fails as on
  base), server-listen-handle 124→1 (isolated 1×2, still fails — NO-FIX).
  (A full branch sweep was started and killed mid-phase-2: under 20
  concurrent lane sweeps phase 1 recorded 124 for trivial tests, so the
  full run was replaced by this targeted differential plus isolated
  re-runs; the change only executes on `listen({fd})`, which only
  listen-fd0 exercises in the suite — verified by grep.)
