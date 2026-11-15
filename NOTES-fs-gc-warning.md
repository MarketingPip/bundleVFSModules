# NOTES-fs-gc-warning — FileHandle GC-close warning (triage lane L4)

## Target
- `test-fs-promises-file-handle-close.js`: 1 → 0 (isolated 2× on branch, 2× on live main).
- fs 324 → 325 / 349.

## Mechanism (Node source, grounded)
Real Node closes an unclosed FileHandle from the GC finalizer
(`src/node_file.cc`, `FileHandle::Close()`): the fd is closed synchronously
and a process warning is emitted from an **unref'd setImmediate** — a per-fd
`Warning` (`Closing file descriptor %d on garbage collection`) plus a
**once-per-process** `DeprecationWarning` with code `DEP0137` (gated on
`env->filehandle_close_warning()`). If the close itself fails, Node schedules
a fatal exception instead of the warning.

## Fix (src/fs.js only, +40 lines)
- Module-level `FinalizationRegistry` beside the `FileHandle` class. It holds
  only the fd number, never the handle, so registration cannot keep the
  handle alive; the handle itself is the unregister token.
- `FileHandle` constructor registers (`register(this, fd, this)`).
- `_closeSync()` — the single close core every explicit close funnels through
  (`close()`, `Symbol.dispose`/`Symbol.asyncDispose`, pullSync autoClose,
  writer fail/endSync) — unregisters, so an explicitly closed handle never
  warns.
- Registry callback: `vol.closeSync(fd)` (best-effort, EBADF swallowed —
  ponytail: real Node fatals that edge in C++; a browser shim cannot and
  should not reproduce a fatal for a double-closed fd), then
  `process.emitWarning(...)` for the per-fd Warning and, once per process,
  the DEP0137 DeprecationWarning (exact Node strings, verified against
  node_file.cc). The shim's `process.emitWarning` defers to a nextTick, which
  lands before any pending setImmediate — same observable order as Node's
  unref'd setImmediate for the test's extra-turn wait.

## Verification
- zz probes (deleted after use): (1) `process.emitWarning` delivers to
  `process.on('warning')` with name/message/code intact, and a
  FinalizationRegistry callback fires after `globalThis.gc()` + a tick;
  (2) explicitly closed handle → no warning; two unclosed handles → two
  per-fd Warnings + exactly ONE DEP0137 (matches native shape; native
  second warning can lag a tick because it comes from an unref'd
  setImmediate, while the shim's lands via nextTick — earlier, same
  observable outcome).
- Differential: target 0,0 on branch; guards 0 — all 14 other passing
  `test-fs-promises-file-handle-*.js` (append-file, chmod, dispose, pull,
  pullsync, read, readFile, stat, stream, sync, truncate, write, writeFile,
  writer) + `test-fs-promises`, `test-fs-promises-appendfile`,
  `test-fs-promises-exists` (17 guards total).
- Repo suites: `tests/fs.test.js`, `tests/fs_promises.test.js`,
  `tests/export_surface_fs.test.js`,
  `tests/export_surface_fs_promises.test.js`,
  `tests/ondemand-require.test.js` — 118/118 pass.

## Ship
- PR #___ / Merge SHA: ___ (filled at ship time; see memory entry instead)
