# NOTES-fs-rm-async.md — test-fs-rm.js :166 async-rm resurrection (follow-up lane)

## Target
- `test-fs-rm.js` 1 → 0 (isolated 2× on branch, exit 0, empty stderr).

## Root cause (probe-proven, harness-only)
The shim's async `rm` is correct: it deletes from memfs inside `nextTick`
and only then invokes the user callback with `null`. The resurrection is in
the harness's one-way mirror, documented in `parity/fs-harness.mjs` itself:
"memfs deletions are NOT propagated — a stale real file can survive a
memfs rm".

Sequence in the test:
1. Async section writes `rm-async-file.txt` through the shim (memfs only).
2. The `.git` block runs `git init` synchronously right after; the
   child_process wrapper calls `mirrorMemfsTmpdirToDisk()`, writing the
   whole memfs tmpdir subtree — including `rm-async-file.txt` — to real disk.
3. The async `rm` callback fires (file gone from memfs, err null) and calls
   `fs.existsSync(filePath)`; `wrapFn` → `syncArgs` → `syncPath` finds the
   file on real disk with memfs lacking it and copies it back into memfs.
4. `existsSync` returns true → assert at test:166 fails (`true !== false`).

zz probe (`zz-rm-async-mirror.js`, deleted after use) proved it:
- A: no spawn between write and async rm → exists false.
- B: `execSync("true")` (mirror) between write and async rm → exists true,
  and the file was still on real disk afterwards.
- C: sync `rmSync` after a mirror → exists true (same gap, sync path).

The earlier "isolated async-rm probe passes" observation fits: with no
native spawn in between, nothing exists on real disk to resurrect the file.

## Fix (`parity/fs-harness.mjs` only, +~60 lines; `src/` untouched)
`wrapFn` now propagates successful memfs deletions to real disk, the mirror
image of L6's `mirrorMemfsTmpdirToDisk`:
- Sync methods (`rmSync`, `unlinkSync`, `rmdirSync`): after the shim call
  returns without throwing, `realFs.rmSync(p, {recursive:true, force:true})`.
- Async methods (`rm`, `unlink`, `rmdir`): the user's callback is wrapped;
  on success (`err` null) the real path is deleted BEFORE the user's
  callback runs, so its `existsSync` observes the deletion.
- Scoped to the test tmpdir only (never fixtures or the repo tree — a real
  fixture must never be deleted by a shim rm) and to success only.
- `ponytail:` comments in code name the ceilings: `fs.promises.rm`
  returns a promise and gets no propagation here; `rename` is not a
  deletion, so a renamed-away real file can still be resurrected by
  `syncPath` (no test in the suite observes it).

## Differential
- Flip: `test-fs-rm.js` 1 → 0, isolated 2× (runs 1–2, exit 0).
- Guards (all exit 0): `test-fs-rmdir-recursive`, `test-fs-mkdir`,
  `test-fs-readdir`, `test-fs-promises-file-handle-close` (L4),
  `test-fs-utils-get-dirents` (L3), `test-fs-mkdir-rmdir`,
  `test-fs-symlink`, `test-fs-write-file`, `test-fs-open`,
  `test-fs-readfile` (a 137 in the first guard loop was an OOM kill of the
  shell, not the test — isolated re-run exit 0, matching the triage
  adjudication), `test-fs-rmdir-recursive-sync-warns-not-found`,
  `test-fs-rmdir-recursive-throws-not-found`, `test-fs-rmdir-type-check`,
  `test-fs-unlink-type-check`, `test-fs-readfile-unlink`.
- Filename traps (not failures): `test-fs-rmdir.js` and `test-fs-unlink.js`
  do not exist (`ERR_MODULE_NOT_FOUND`).

## Ship
- PR #___ / Merge SHA: ___ (filled at ship time)
