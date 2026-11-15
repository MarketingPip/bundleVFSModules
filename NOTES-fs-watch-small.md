# NOTES-fs-watch-small.md — fs wave F1 lane 7 (watch small fixes)

## Targets (2 flips, both 1 → 0 isolated 2× on branch)

- `test-fs-watch-encoding.js` — `fs.watch(dir, { encoding: "buffer" })`
  threw `TypeError: The argument 'encoding' is invalid encoding. Received
  'buffer'` from `validateEncodingOpt` (src/fs.js:4570), called from the
  `fs.watch` wrapper without `allowBuffer`.
- `test-fs-watch-enoent.js` — `fs.watch(nonexistent)` threw, but
  `err.path` was `undefined` (test needs `path`/`filename` === the path,
  syscall `watch`|`stat`, code ENOENT, errno -2, message starting
  `ENOENT: no such file or directory`); `{ throwIfNoEntry: false }`
  threw instead of returning a watcher.

## Fix (src/fs.js only)

1. **Encoding validation** — the watch call site now calls
   `validateEncodingOpt(options, true)`. Grounded in Node
   `lib/internal/fs/utils.js:332-333` (`getOptions` skips the encoding
   assertion for `'buffer'`).
2. **Filename encoding on emit** — memfs always emits plain-string
   filenames; Node encodes them per `options.encoding` in the binding.
   The wrapper now wraps `w.emit` (outside the ignore-matcher wrap, so
   the ignore matcher sees the encoded name like Node's does —
   `lib/internal/fs/watchers.js` onchange) and converts `'change'`
   filenames: `'buffer'` → `Buffer.from(name, "utf8")`, other
   non-utf8 encodings → `Buffer.from(name, "utf8").toString(encoding)`.
   Only installed when the encoding is not utf8/utf-8.
3. **Start-error shape** — new `normalizeWatchStartError(e, ps)`:
   memfs throws `watch <path> ENOENT` with a *string* errno and no
   path/filename; Node's `kFSWatchStart` throws a UVException shaped
   `ENOENT: no such file or directory, watch '<path>'` with numeric
   errno and `path` + `filename` set. For ENOENT the error is rebuilt
   via `makeFsError` (+ `filename`, `errno = ERRNO_BY_CODE.ENOENT`);
   other codes go through `enrichErr` plus path/filename/errno
   normalization.
4. **`throwIfNoEntry: false`** — when the start fails ENOENT and the
   option is false, the wrapper returns an unstarted `_FsEventEmitter`
   watcher (Node returns silently from `kFSWatchStart`,
   `lib/internal/fs/watchers.js:319`); `close()`/`ref()`/`unref()`
   are no-ops. `patchWatcher` skips the `'close'` emission for a
   never-started watcher (`_neverStarted` flag) — Node's `close()`
   returns early without emitting in that state.

## Guards

All 33 passing `test-fs-watch*.js` / `test-fs-watchfile*.js` re-run on the
branch (see `fs-f1-watch-small-results.txt`): 33/33 exit 0. Known
still-failing neighbors unchanged: `test-fs-watch-recursive-delete-race.js`
(L8's target, exit 1), `test-fs-watchfile-bigint.js` (L3's target, exit 1).

## Differential

- Flips: `test-fs-watch-encoding` 1 → 0 (2×), `test-fs-watch-enoent`
  1 → 0 (2×). Results: `~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/fs-f1-watch-small-results.txt`.
- No regressions in the guard set above.

## Ship

- PR #___ / Merge SHA: ___ (filled at ship time)
