# NOTES — net lane N2-13: listen options.signal

Target: `test-net-server-listen-options-signal` (1 → 0).

## Mechanism

`Server.prototype.listen` ignored `options.signal` entirely: a bad signal
(`'INVALID_SIGNAL'`) never threw, and aborting a live signal never closed
the server.

## Fix (`src/net.js` only)

Port of Node `lib/net.js:2126` `addServerAbortSignalOption`, called from
`listen()` right after the already-listening guard and before the port/path
dispatch (same position as Node `lib/net.js:2526`, so a bad signal throws
synchronously):

- `options.signal === undefined` → no-op.
- Otherwise validate with Node's exact predicate
  (`lib/internal/validators.js:454`): null, non-object, or no `'aborted'`
  property → `ERR_INVALID_ARG_TYPE('options.signal', 'AbortSignal', signal)`
  via the file's existing `errInvalidArgType` helper.
- Already-aborted signal → `nextTick(() => self.close())`.
- Live signal → `addAbortListener(signal, onAborted)` (imported from
  `./events.js`, which already exports it and returns a disposable) with
  `onAborted = () => self.close()`; `self.once('close', () =>
  signal.removeEventListener('abort', onAborted))` for the disposal Node
  does at `lib/net.js:2140` — Node's disposable is exactly that
  `removeEventListener` call
  (`lib/internal/events/abort_listener.js:48`), so no `SymbolDispose` key
  is needed.

## Differential

- Targeted base-vs-branch differential (isolated, 60s timeout each):
  base = main `453d2976`, branch = this lane. Exactly 1 toward-pass
  (`test-net-server-listen-options-signal` 1 → 0, 0×3 on branch),
  0 regressions — all other values identical on both sides
  (server-listen-options, listen-error, server-listen-path,
  server-listen-remove-callback, listen-close-server,
  server-call-listen-multiple-times, listening all 0/0;
  server-listen-handle 1/1; listen-twice 124/124).
- Blast-radius proof: `grep` over all vendored `test-net-*.js` shows
  only the target test passes `signal` to `listen()`; the new code
  returns immediately when `options.signal === undefined`, so no other
  test can observe a behavior change.
- Full fast-sweep `--target net --force`: base
  `hidden_files/fast-sweep/net-n2-listen-signal-base-2026-11-14.csv`
  (main `453d2976`) = 121 pass / 20 fail / 15 timeout; branch
  `hidden_files/fast-sweep/net-n2-listen-signal-branch-2026-11-14.csv`
  = 126 pass / 21 fail / 9 timeout. Matched changed-value lines (7):
  exactly 1 genuine toward-pass (`test-net-server-listen-options-signal`
  1 → 0), 0 regressions. The other 6 are adjudicated load noise: 4
  apparent flips (autoselectfamily-attempt-timeout-cli-option,
  connect-options-fd, normalize-args, socket-constructor) read 124 in
  the base sweep but 0 isolated on BOTH base and branch (already-counted
  N1 flips); 2 mode changes (end-close, server-listen-handle) read 124
  in the base sweep but 1 isolated on both sides (end-close is lane 24's
  target, still failing; server-listen-handle is triage NO-FIX).

## Ship

- Branch `fix/net-listen-signal`; PR #___; merged ___.
