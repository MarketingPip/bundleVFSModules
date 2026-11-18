# NOTES — repl setupHistory port (R6)

## What this lane does

Ports Node's `setupHistory` into the shim so the two
programmatic-history tests pass. `src/repl.js` gains the delegation;
`src/readline.js` gains the file-persistence half of `ReplHistory`.

## Triage correction (parent-verified via R0)

The repl triage classified `test-repl-programmatic-history` and
`test-repl-programmatic-history-setup-history` as FIXTURE-only certain
flips. R0 proved that wrong: with the fixtures present both pass
natively (exit 0) but fail under the shim [1,1] (`"Failed test # 1"`,
`2 !== 0` — the "Persistent history support disabled" message never
emitted). Root cause: the shim's `setupHistory` (`src/repl.js`) was a
stub that just called back `(null, this)` — it never read the history
file or emitted any message. These 2 tests need a real `setupHistory`
port. The ceiling is unchanged (100/102) — the classification shifted
from fixture to shim.

## Mechanism (Node source cites — Node v24.20.0 source pack)

- `src/repl.js` `setupHistory(historyConfig, cb)` — port of
  `lib/repl.js:1052-1062`: a string `historyConfig` is normalized to
  `{ filePath }` (backwards compatibility); an explicit `cb` overwrites
  `options.onHistoryFileLoaded`; the options are handed to
  `setupHistoryManager`, which creates a new `ReplHistory` and calls
  `initialize(options.onHistoryFileLoaded)` if present.
- `src/readline.js` `ReplHistory` — port of
  `lib/internal/repl/history.js`:
  - `getHistoryPath(options)` trims a string `filePath` (blank disables).
  - `initialize(onReadyCallback)`: empty path → save the context's
    original `_historyPrev`, install the disabled-message override, call
    back; unresolvable path (homedir throws) → homedir-error message +
    same override; otherwise `pause()` and run `_initializeHistory`.
  - `_initializeHistory`: open `a+` mode `0600` (creates the file) and
    close; read; split on `/\r?\n+/` with the size limit; open `r+`;
    truncate(0); register the flush-on-`line` and close-on-`exit`
    listeners; flush once and call back on `flushHistory`.
  - `_handleHistoryInitError`: failed-read message + disabled override +
    resume + callback (never crashes — Node's rule).
  - `_replHistoryMessage`: on the first UP with empty history, print
    `"\nPersistent history support disabled. Set the NODE_REPL_HISTORY
    environment\nvariable to a valid, user-writable path to enable.\n"`,
    restore the original `_historyPrev`, then call it.
  - `_flushHistory`: write the joined history at offset 0, coalescing a
    write already in flight (`kWriting`/`kPending`), 15 ms debounce
    (`kDebounceHistoryMS`, Node's paste guard), emit `flushHistory`
    when the queue drains.
  - `_onHistoryExit`: if a flush is in flight, wait for it before
    closing the handle. The `off("line", ...)` with a fresh bound
    function mirrors Node's upstream quirk (it never matches the
    registered listener).

## Three shim divergences the port had to work around (all probe-proven)

1. **Native bridge gate.** The lane brief said "native fs/os/path via
   `process.getBuiltinModule`, gated on no `_RUNTIME_`" — that gate
   evaluates OFF under the parity harness, because the harness itself
   defines `globalThis._RUNTIME_ = { parityForceShim: true }`
   (`parity/preload.mjs:37-42`) precisely to switch native bridges off.
   The marker is distinguishable from Jared's sandbox runtime (which
   carries `loadModule`/`process`/`globals` and never `parityForceShim`),
   so `_historyNativeModules()` enables the bridge exactly when
   `_RUNTIME_` is absent OR is the parity marker, plus the `src/os.js`
   browser-navigator check and a shape check on the returned modules.
   In the sandbox the bridge stays OFF and the in-memory no-op is the
   behavior. The fs shim cannot substitute: the fs-harness mirrors
   tmpdir only for `target === "fs"` (`parity/preload.mjs:192`), so
   under `target=repl` memfs has no tmpdir mirror and cannot see the
   test's real-disk fixture files; likewise `_nativeOs` is null under
   the harness, so the os shim's `homedir()` cannot see the test's
   `os.homedir` mock — only `getBuiltinModule('os')` returns the same
   native singleton the test mocks.
2. **Prompt ordering.** Node calls the ready callback synchronously on
   the disabled/homedir-error paths — safe there because Node prints
   the initial prompt synchronously in the constructor. The shim
   defers its prompt to a Promise microtask (`src/repl.js`), so the
   ready callback (and, on the homedir-error path, the error message
   itself) is deferred to `Promise.resolve().then(...)`: microtasks
   run FIFO and the prompt's was queued first. A `process.nextTick`
   callback jumps ahead of the prompt and scrambles chunk order
   (the old stub's `Promise.resolve().then` existed for this reason).
3. **The `line` event never fires for a REPL server.** The shim's
   `[kOnLine]` is a getter returning `this._onLine`
   (`src/readline.js`, backward-compat descriptors), and
   `REPLServerImpl` overrides `_onLine` with the eval method — so
   `[kLine]` calls the eval directly and `line` is never emitted.
   (The repl's own `this.on("line", ...)` listener at `src/repl.js:260`
   is dead code on this path.) Node's flush trigger is the context's
   `line` listener, so the port schedules the debounced flush from
   `ReplHistory.addHistory` instead — `[kLine]` calls `addHistory`
   immediately before the eval, which is equivalent to Node's
   flush-on-`line` (scheduled first so even empty/whitespace lines
   flush, as in Node). The `line` listener registration is kept:
   it fires on plain Interfaces, where `[kOnLine]` does emit `line`.
   `_onHistoryLine` no-ops when no handle is open (in-memory mode or
   the disabled path — Node only registers the listener after a
   successful open, so `isFlushing` can never stick true there).

## Scope

`setupHistory` + its history plumbing only: `src/repl.js`
(`setupHistory`) and `src/readline.js` (`ReplHistory` file-persistence
half + the `addHistory` flush trigger). NOT touched: `createContext`,
options defaults, the scope-proxy `has` trap (R1), the constructor
stream wiring / `start()` (R2), `complete()` (R3). The `src/readline.js`
change is the history plumbing the brief's "`src/repl.js` only" did
not foresee: the file-persistence half lives in `ReplHistory`, and
reimplementing the manager inside `setupHistory` would duplicate the
class.

## Verification (branch head `3f8422c5`, base `92b5e369` = R1 #470)

- Flips 2x isolated, exit 0 each:
  `test-repl-programmatic-history` [0,0],
  `test-repl-programmatic-history-setup-history` [0,0].
- Guards exit 0: `test-repl-persistent-history`,
  `test-repl-context`, `test-repl-history-navigation`,
  `test-repl-autocomplete`, `test-repl-domain`.
- Full repl differential, `fast-sweep --target repl --force --jobs 2`:
  base (main `92b5e369`) 90/101 pass, 1 timeout, 10 fail;
  branch 92/101 pass, 1 timeout, 8 fail.
  Delta: exactly the 2 flips, ZERO regressions.
  Branch non-zero (all pre-existing, unchanged from base):
  `test-repl-envvars` 124 (harness stall, NO-FIX),
  `test-repl-mode` 1 (R5 gate, not landed),
  `test-repl-preview` 1 (NO-FIX, needs V8 inspector),
  `test-repl-require` 1 (R2 positional-stream drop),
  `test-repl-recoverable` 1, `test-repl-reverse-search` 1 (sweep flake,
  passes isolated), `test-repl-tab-complete-import` 1,
  `test-repl-tab-complete-require` 1 (R3),
  `test-repl-top-level-await` 1 (R4b).
  `test-repl.js` (no dash, glob-invisible): exit 1 on branch and base
  (unchanged, R2).
- Footprint test: `tests/ondemand-require.test.js` 29/29 passed.
- `node --check` clean on `src/repl.js` and `src/readline.js`.
- Sweep CSVs:
  `hidden_files/fast-sweep/repl-r6-base-2026-11-18.csv`,
  `hidden_files/fast-sweep/repl-r6-branch-2026-11-18.csv`.
- Size-1 note: `test-repl-programmatic-history` case 6
  (`NODE_REPL_HISTORY_SIZE: 1`) needs R1's `historySize` forwarding
  through the constructor. R1 merged first (#470, `92b5e369`), so the
  branch was rebased onto it (clean, no conflicts) and both tests
  flip on the rebased head.

## Ship

- Branch: `fix/repl-setup-history`
- PR #471
- Merge SHA: c76a10f0 (squash-merged 2026-11-18)
- Repl count: 91/102 on main after R1 (90 glob-pass in sweep;
  reverse-search passes isolated but flakes in sweep, `test-repl.js`
  fails) -> 93/102 after this merge (92 glob-pass in sweep).
  Recorded count before this wave: 78/102 (stale); triage-verified
  true count 80/102; R0 +9 -> 89; R1 +2 -> 91; R6 +2 -> 93.
