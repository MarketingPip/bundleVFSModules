# fs write-buffer-large (triage lane 11) — harness-only fix

## Result

- **Flip:** `test-fs-write-buffer-large.js` 1 → 0 (isolated 2× on branch,
  exit 0, empty stderr both runs).
- **Files:** `parity/fs-harness.mjs` only (syncArgs) + this note.
- **Base:** main `5d6b0f71`. Branch: `fix/fs-write-buffer-large`.

## Mechanism

`fs.write(fd, buf, 0, 0x7fffffff + 1, 0, cb)` — Node throws ERR_OUT_OF_RANGE
("The value of \"length\" is out of range. It must be >= 0 && <= 2147483647.
Received 2147483648"). The shim would throw exactly that: `parseWriteArgs`
(src/fs.js:3443) calls `validateOffsetLengthWrite` (:3376, incl.
`validateIntegerArg(length, "length", 0, 2147483647)`).

The thrower was the harness, not the shim. `wrapFn` calls `syncArgs(args)`
before the shim runs, and syncArgs did `p = a.toString()` for EVERY Buffer
arg — to sync Buffer paths into memfs. The test's data Buffer is 2GB+1 bytes;
`Buffer.prototype.toString()` on it throws ERR_STRING_TOO_LONG (V8 max string
length), so the wrapped `fs.write` threw ERR_STRING_TOO_LONG before the shim
ever saw the call. Base failure reproduced: exit 1, thrown from
`wrapped [as write]` (fs-harness.mjs:260), expected ERR_OUT_OF_RANGE.

## Fix

syncArgs only converts a Buffer arg to a path string when
`a.byteLength <= 4096` (PATH_MAX). A Buffer longer than 4096 bytes can never
be a valid path — the shim rejects it with ENAMETOOLONG — so skipping the
sync loses nothing, and a data Buffer is never stringified. `ponytail:`
comment in code names the ceiling: the bound is PATH_MAX, not an arbitrary
cap; if a platform ever allowed longer paths, the guard moves with it.

Deliberately NOT touched (neighbor lanes' regions): the deleted-cwd check and
the symlink/link target handling in wrapFn also toString() Buffer args, but
the target test never reaches them and they handle paths, not data — out of
scope for this lane.

## Differential

- Target: test-fs-write-buffer-large 1 → 0, isolated 2× on branch
  (exit 0, empty stderr).
- Guards (all exit 0 on branch): 29/29 — Buffer-path/syncArgs-sensitive
  (symlink-buffer-path, readdir-buffer, readfile-buffer-option,
  write-file-buffer, write-buffer, read-empty-buffer), write suite (write,
  write-sync, write-file, write-file-sync, write-stream, writev, append-file,
  write-optional-params, write-negativeoffset, write-no-fd,
  write-reuse-callback), read suite (read, readfile, read-file-sync,
  readSync-optional-params, readv, promises-file-handle-readFile), general
  path-sync (open, stat, readdir, copyfile, access, exists).
  Full list in `hidden_files/fs-f1-write-buffer-large-results.txt`.
  Regressions: 0.

## Ship

- PR #___ / Merge SHA: ___ (filled at ship time)
