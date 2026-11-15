# NOTES-fs-harness-mirror.md — fs wave F1 lane 6 (triage L6)

## Result

- **Flips (2):** `test-fs-readfile-pipe-large.js` 1 → 0, `test-fs-readfilesync-pipe-large.js`
  1 → 0 (isolated 2x each on the branch, exit 0, empty stderr — logs contain only
  `ok\n`).
- **Partial (1):** `test-fs-rm.js` still exit 1, but now fails ONLY at :265 — the L5
  assertion (`rmSync` on a nonexistent path must report syscall `lstat`; the shim
  reports `rm`). Zero git/spawn errors remain: the git block (`git init` at :235)
  passes. rm.js banks only when L5 lands.
- **Guards:** all 12 other child_process-using fs tests unchanged (10 exit 0; the
  two NO-FIX tests fail identically to base — read-stream FIFO ENOENT,
  syncwritestream spawn EBADF). Broader passing-sample guard set: see results file.
- **Repo tests:** `tests/ondemand-require.test.js` 29/29 (see results file).

## Fix

Harness-only; `src/` untouched. Three files:

1. `parity/fs-harness.mjs` — new exported `mirrorMemfsTmpdirToDisk()` (+ internal
   `mirrorDirToDisk`): walks the memfs tmpdir subtree via the `raw` (unwrapped)
   shim methods and writes missing/stale files to real disk. One-way, tmpdir-scoped,
   never clobbers a newer real file (same rule as `syncPath`, mirrored). Symlinks
   are mirrored as links, never followed (memfs holds link loops, e.g. rm.js
   loop-link-async-a ↔ loop-link-async-b). Sockets/fifos left alone.
2. `parity/child_process-fs-harness.mjs` (new) — native child_process wrapper: the
   spawn entry points (`spawn`, `spawnSync`, `exec`, `execSync`, `execFile`,
   `execFileSync`, `fork`) mirror first, then delegate with identical semantics
   (`Reflect.apply`). Every other export passes through by reference. This is NOT
   the child_process shim — native spawn is required (real git, real shells).
3. `parity/preload.mjs` + `parity/hooks.mjs` — one extra redirect under the fs
   target: `child_process` → `child_process-fs-harness.mjs` (#232 precedent,
   stated in the PR body). Importer-scoped as usual (only `require`/`import`
   from under `parity/node-test/parallel/`); `test/common` keeps native
   child_process. A wrapper-module import of `node:child_process` resolves
   natively (its parent is `parity/`, outside the redirect scope) — no
   self-redirect loop.

## Why this shape (ponytail)

Traced the real flow first: the pipe-large pair stages 999999 `'a'`s in memfs,
then a NATIVE shell opens the file via `< filename` — real disk only. rm.js
`mkdirSync`s a dir in memfs, then native `execSync("git init", {cwd})` needs the
OS to chdir into it. The only interception points are spawn time (wrap
child_process) or write time (write-through on every shim write). Write-through
was rejected: it would change what every fs call observes and needs delete /
rename / rmdir propagation for correctness — a full two-way sync. The spawn-time
mirror is one function + seven one-line wrappers, runs only before a spawn, and
changes nothing about any fs call's semantics. Unconditional mirror (no
cwd/command heuristic): the pipe-large spawn's cwd is the default while the
command string holds the tmpdir file — a cwd-only predicate would miss it, and
command parsing is fragile. Cost is one tmpdir walk per spawn; the tmpdir is
per-process scratch.

## Ceiling / caveats

- Files staged in memfs AFTER the last spawn stay invisible until the next spawn;
  memfs deletions are NOT propagated (a stale real file can survive a memfs rm —
  the same gap `syncPath` already has in reverse). Neither matters for the three
  targets.
- The mirror runs before EVERY spawn under the fs target, including the
  `git --version` probe in rm.js (tmpdir empty then — trivial walk).
- `test-fs-rm.js` needs L5 + L6 together; L3's `validateRmOptionsSync` port is a
  guard for the rm assertions.

## Differential

Results file: `~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/fs-f1-harness-mirror-results.txt`

- Base (main `5d6b0f71`, isolated 2x): readfile-pipe-large 1,1;
  readfilesync-pipe-large 1,1; rm 1,1 (git block: `spawnSync /bin/sh ENOENT` at
  gitInit:29; pipe-large: exec callback `code: 2` on the shell redirection).
- Branch (isolated 2x): readfile-pipe-large 0,0; readfilesync-pipe-large 0,0;
  rm 1,1 — failing ONLY at :265 (L5 assertion).

## Ship

PR #___ / Merge SHA: ___ (filled at ship time)
