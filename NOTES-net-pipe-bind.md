# NOTES — net pipe bind / fs socket files (lane N1-4)

Targets (PARITY_TARGET=net, base main `3199bb5d`, all exit 1):
`test-net-better-error-messages-listen-path`, `test-net-server-listen-path`,
`test-net-pipe-with-long-path`. All exit 0 on the branch (isolated 2x each).

## Mechanism (triage lane 4, verified by probe)

`Server.prototype._doListenPipe` registered any path and emitted
`listening` with no filesystem side effect. Real Node creates a real
socket file on bind (libuv `uv_pipe_bind`):

- Missing parent dir -> async `EACCES` (`listen EACCES: permission denied
  <path>`, errno -13, `address` = path). Probed real Node v24.22.1 twice
  (parent under /tmp and under /); the triage doc's "ENOENT" guess was
  wrong — the raw kernel bind gives ENOENT but libuv/Node reports EACCES,
  and `BoundSocket._bindPipe` in this file already uses EACCES for the
  same case. The lane test only asserts `e.address === '/blah/fadfa'`.
- Parent exists but is not a directory -> async `ENOTDIR` (errno -20).
- Path itself exists as a non-socket file/dir -> async `EADDRINUSE`
  (errno -98). A stale socket file is unlinked first, as libuv does.
- Path longer than 107 chars (sun_path, `UV_PIPE_NO_TRUNCATE`) -> async
  `EINVAL` on both listen and connect (errno -22). Connect-side probed:
  real Node `connect EINVAL <path>`; the shim previously yielded ENOENT
  for any missing pipe.
- On success the socket file exists: default mode 0770 under the harness
  umask 0007 (bind creates 0777 & ~umask); `readableAll`/`writableAll`
  REPLACE the mode via fchmod (readable-only 0444, writable-only 0222,
  both 0666 — probed all four combinations). `close()` unlinks it
  (probed: `existsSync` false after close).

## Fix (src/net.js only)

- `_doListenPipe(path, backlog, readableAll, writableAll)`: length check,
  parent-dir check (statSync; missing -> EACCES, non-dir -> ENOTDIR),
  existing-path check (non-socket -> EADDRINUSE, stale socket unlinked),
  registry EADDRINUSE check unchanged, then a placeholder file
  (`writeFileSync(path, "", { mode: 0o777, flag: "wx" })`, umask shapes
  it like bind) + `chmodSync` replacing the mode when either flag is set.
  Any failure during creation rolls the registry entry back and emits an
  async listen error instead of throwing out of the nextTick callback.
  Windows named pipes (`\\?\pipe\...`) and abstract sockets (`\0...`)
  skip all fs effects (registry only), as before.
- `Server.prototype.listen` threads `options.readableAll/writableAll`
  into `_doListenPipe`; `_adoptBoundSocket` passes none (BoundSocket has
  no such flags).
- `Server.prototype.close` unlinks the placeholder (flag
  `_pipeFileCreated`, set only when this server created the file;
  externally-removed files are ignored).
- `_doConnect` pipe branch: path longer than 107 chars -> async EINVAL
  before the registry lookup (missing pipes still yield ENOENT as before).
- New module const `SUN_PATH_MAX = 107`; `node:fs` import extended with
  `statSync`/`writeFileSync`/`chmodSync`/`unlinkSync` (same precedent as
  the existing `existsSync` import: real fs in the parity harness, the
  memfs-backed shim fs in the browser build; all four are named exports
  of src/fs.js).

## Differential

- Base CSV: `hidden_files/fast-sweep/net-n1-base-2026-11-14.csv`
  (156 rows; 86 pass / 62 fail / 8 timeout — vs the triage CSV's
  87/63/4/1/1, the only diffs are load-noise timeouts:
  listen-exclusive-random-ports 1->124, listen-handle-in-cluster-2
  0->124, throttle 134->124, write-fully-async-buffer 137->124).
  Note: the sweep started before the fix was written and the 3 targets
  still read 1 in it, so it stands as a clean base.
- Branch CSV: `hidden_files/fast-sweep/net-n1-branch-2026-11-14.csv`
  (156 rows; 89 pass / 59 fail / 8 timeout). Matched diff vs base:
  exactly the 3 claimed flips, 0 regressions, 0 other changes
  (the 8 timeouts are the identical set on both sides):
  better-error-messages-listen-path 1->0, pipe-with-long-path 1->0,
  server-listen-path 1->0. Net 86 -> 89 in this lane's sweep pair
  (base CSV reads 86, not the triage 87, due to the
  listen-handle-in-cluster-2 load flake noted above).
- Isolated re-runs on the branch (2x each): the 3 targets 0, 0.
- Guards re-run 2x each on the branch, unchanged vs base:
  pipe-connect-errors 1 (lane 21's target), server-listen-options 1
  (lane 8's target), server-listen-handle 1 (NO-FIX),
  connect-options-path 0, boundsocket 0, pingpong 0.

## Known leftovers (not this lane)

- The placeholder is a regular file, so `fs.statSync(path).isSocket()`
  is false where real Node reports true. No vendored test asserts
  `isSocket()` on a shim-bound pipe; a socket-typed placeholder needs a
  real bind() the browser cannot do. (ponytail ceiling, noted in code.)
- Node throws sync `ERR_INVALID_ARG_VALUE` from `listen()` when
  `readableAll`/`writableAll` is set on an abstract socket path
  (node-src lib/net.js:2569-2572); the shim does not. Untested.
- `listen()` on a path whose parent exists but is not writable fails at
  file creation with an async listen error (code from the fs error);
  real Node reports EACCES from bind. Same code, unprobed message shape.
- The connect-side EACCES sub-case of pipe-connect-errors (chmod 0 on a
  bound pipe) is lane 21's, not this lane's; the shim connect performs
  no permission check.
