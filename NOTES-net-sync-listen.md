# Net lane N1-3 — Synchronous listen/address (fix/net-sync-listen)

Base: main `3199bb5d`. Triage: `triage-net-2026-11-14.md` lane 3.
Targets (all `PARITY_TARGET=net`): test-net-connect-immediate-destroy,
test-net-connect-memleak, test-net-connect-reset-before-connected,
test-net-socket-destroy-twice, test-net-socket-reset-twice,
test-net-socket-timeout-unref.

## Mechanism

All six call `server.address().port` synchronously right after `listen(0)`
and died on `TypeError: Cannot read properties of null (reading 'port')`.
`Server.prototype.listen` deferred the bind to
`nextTick(() => this._doListenTCP(...))`, so `_listening`/`_bindAddress`
were unset until the next tick. Real Node binds synchronously in
`setupListenHandle` (node-src `lib/net.js:2272` → `_handle.bind`, then
`_handle.listen(backlog)`), and only the `'listening'` event is deferred
(`process.nextTick(emitListeningNT)`, `:2353`), guarded by
`if (self._handle)` (`:2416-2419` — skipped if the server closed first).

## Fix (src/net.js only)

- Extracted the bind body of `_doListenTCP` into a synchronous
  `Server.prototype._bindTCP(port, host, backlog)`: host resolution, port
  allocation (`allocPort()` for 0), registry claim, `_listening = true`,
  `_bindAddress`, `_keepLoopAlive()`. Returns the error to emit on
  failure (non-IP hostname → `errNotFound`; in-use port →
  `errAddrInUse`), or `null` on success. It does NOT emit `'listening'`.
- `listen()` TCP branch now calls `_bindTCP` synchronously; on error it
  schedules an async `'error'` event (as Node does via `emitErrorNT`);
  on success it schedules `nextTick(() => { if (this._listening)
  this.emit("listening"); })` — the `_listening` guard mirrors Node's
  `emitListeningNT` handle check, so `listen(0); close();` never emits
  a stray `'listening'`.
- `_doListenTCP` kept as the deferred wrapper for the BoundSocket-adopt
  path (`_adoptBoundSocket`'s nextTick): same bind core, `'listening'`
  emitted synchronously inside the tick as before. No behavior change
  there.
- The already-listening guard stays synchronous: after a successful sync
  bind `_listening` is true, so a second `listen()` still throws
  `ERR_SERVER_ALREADY_LISTEN` synchronously (listen-twice depends on
  this). After a failed bind `_bindPending` is cleared and `_listening`
  stays false, so the server can be re-listened, as in Node.

## Verification

- Baseline (base `3199bb5d`, isolated): all 6 exit 1 with the null-port
  TypeError (incl. connect-memleak with `--expose-gc`).
- Branch, isolated, 3x each: all 6 exit 0.
- connect-memleak: the triage caveat is resolved — the GC assertion
  holds. The test re-spawns itself with `--expose-gc` (Node common
  harness), so it passes under the plain parity invocation too; the
  `once('connect', cb)` registration at `src/net.js:1557` lets the
  closure be collected after connect fires.
- Differential: fast-sweep `--target net --force`, base
  `hidden_files/fast-sweep/net-n1-base-2026-11-14.csv` vs branch
  `hidden_files/fast-sweep/net-n1-branch-2026-11-14.csv` — exactly 6
  toward-pass lines, 0 regressions (see below).

## Differential (matched changed-value lines, sorted, deduped)

- test-net-connect-immediate-destroy.js: 1 -> 0
- test-net-connect-memleak.js: 1 -> 0
- test-net-connect-reset-before-connected.js: 1 -> 0
- test-net-socket-destroy-twice.js: 1 -> 0
- test-net-socket-reset-twice.js: 1 -> 0
- test-net-socket-timeout-unref.js: 1 -> 0

No other changed lines. (Sweep 124s adjudicated against the base CSV;
known pre-existing spinners — throttle, write-fully-async-buffer,
write-fully-async-hex-string, socket-write-after-close — unchanged.)

## Guards re-run (isolated, branch, exit 0 unless noted)

- listen-twice: still 124 (lane 14, pre-existing hang — unchanged by
  this lane; 2nd listen() still throws sync, verified by the hang
  signature, not a new failure).
- listen-error / better-error-messages-listen: still 1 (lane 7, not
  this lane — EADDRNOTAVAIL validation untouched).
- server-listen-path: still 1 (lane 4, pipe fs side effects untouched).

## Scope

Region: `Server.prototype.listen` / `_doListenTCP` / `_bindTCP` (new) /
`address()` (untouched, now reads a synchronously-set `_bindAddress`).
No other lane's region touched. No preload/hook changes. No docs-number
changes (syncs are batched separately).

## Follow-ups (not this lane)

- Pipe listen (`_doListenPipe`) still defers its bind to nextTick, so
  `server.address()` right after `listen(path)` still returns null
  until the tick — lane 4 (pipe bind/fs) owns that path if it needs the
  same treatment.
- `_connectionKey` is still never set (lane 8 owns it; Node sets it in
  `setupListenHandle`, `lib/net.js:2345`).
