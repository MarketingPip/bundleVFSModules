# child_process Parity — Working Notes

Per Jared's 2026-10-14 standing rule: notes to make thinking easy, remember things, build understanding.

## 2026-10-15 00:37 — Start

**Task:** child_process module parity. Baseline 4/112 (3.6%).
**Branch:** `feat/child_process-parity` (from main @ 20beb21e, https merged).
**Expectation:** Most failures inherent — no real process spawning in browser sandbox. But verify; the module may have a spawn shim worth improving.

## Questions to answer

1. What does `src/child_process.js` currently implement? (spawn? exec? execFile? fork?)
2. Which 4 tests pass at baseline? What do they test?
3. Are failures all "spawn ENOENT / not implemented" or are there real bugs in argument validation, option parsing, signal handling, stdio config?
4. Is there an honest-noop story here (like inspector), or a virtual-process shim worth building?

## 2026-10-15 01:05 — Fixed sync throw + fake pid

**Bug 1:** `ChildProcess.prototype.spawn` called `getShell()` synchronously, throwing "CodeSandbox: no shell configured" instead of returning a child and emitting async 'error' (Node contract).

**Fix:** Check for shell without throwing; if missing, `queueMicrotask` an 'error' emit + finalize, return child with `pid: undefined`.

**Bug 2:** Constructor assigned `this.pid = makeFakePid()` immediately. Node leaves pid undefined until spawn succeeds; on failure it stays undefined.

**Fix:** Constructor sets `pid = undefined`; `spawn()` assigns fake pid only after shell check passes.

**Result:** `test-child-process-cwd.js` no longer crashes sync; pid assertion passes. Still fails on error code (ERR_NO_SHELL vs ENOENT) — inherent, can't simulate OS-level cwd validation without real spawn.

## Score update

- Baseline: 4/112
- After harness: 6/112 (+2: fork3, uid-gid)
- After pid fix: still 6/112 (cwd test progresses further but still fails on error code)
