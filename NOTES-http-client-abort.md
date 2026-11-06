# Client abort family (abort/destroy/signal + server-side 'aborted')

## Root cause

Four abort shapes failed on main (`00de1571`) for distinct reasons,
all in `src/http.js` (a fifth target, `test-http-client-abort-
no-agent`, and the unix-queued target were fixed on live main by
PR #337, the unix-socket lane — see below — and are NOT claimed
here):

1. **Signal abort set public `aborted`.** `_onAbortSignal` set

1. **Signal abort set public `aborted`.** `_onAbortSignal` set
   `this.aborted = true`; Node's signal path only *destroys* the
   stream with an `AbortError` (`lib/_http_client.js` addAbortSignal),
   so `req.aborted` stays `false` while `req.destroyed` becomes
   `true` (test-http-client-abort-destroy:124).
2. **Pre-aborted signal destroyed async.** The constructor deferred
   `_onAbortSignal` to a microtask, so `req.destroyed` read `false`
   synchronously after `http.get()` with an already-aborted signal;
   Node destroys synchronously in that case (abort-destroy:184).
3. **Socket errors swallowed after abort.** `socketErrorListener`
   returned early on `request._aborted`; Node's listener has no such
   guard (`lib/_http_client.js:757`) — an explicit socket error must
   reach the request even after `abort()`. Single-fire is via
   `_errorEmitted`/`_hadError`, not `_aborted`
   (test-http-client-abort3:20,30).
4. **Pre-round-trip destroys raced the factory.** `destroy()` and the
   socket-wait continuation destroyed the socket synchronously in a
   microtask, before a factory-queued `process.nextTick` error destroy
   could land; the ported stream `destroy()` no-ops on an
   already-destroyed socket, so the `Error("Oops")` never surfaced.
   Node only assigns `req.socket` on the next tick (`onSocketNT`),
   so a destroy landing before that tick never touches the socket
   (abort3). The factory socket also was never wired until the
   `await` continuation, so the error forwarder wasn't attached when
   user code ran.
5. **(Fixed on main by PR #337, not this PR.)** Request-level
   factories never ran for loopback targets: `_performRequest`'s
   virtual-server gate ran before the factory path. The unix lane
   moved the whole factory block before the virtual/raw gates
   ("factory-before-gates"), which also flips
   `test-http-client-abort-no-agent` and, with its socketPath
   threading + `listen(path)` pipe bind,
   `test-http-client-abort-keep-alive-queued-unix-socket`. This
   PR's own virtual-gate skip for factories was dropped in the
   rebase onto `d09b6d08` as subsumed by that move; the
   synchronous-`onSocket` edit below was carried onto the moved
   factory block instead.
6. **Server-side `'aborted'` never fired.** For a bodyless request
   `state.current` is cleared at `onMessageComplete`, so
   `onHttpClose` only destroyed the stashed response without
   emitting `'aborted'` on its request; and after a peer FIN the
   server socket waited for `_finishSocketResponse`, which never
   runs when the handler never ends (test-http-client-abort, N=8).

## What changed (`src/http.js` only)

- `_onAbortSignal`: no longer sets public `aborted` (only internal
  `_aborted` + `destroy(AbortError)`). Constructor calls it
  synchronously for an already-aborted signal (the `AbortError`
  itself still arrives async — destroy schedules `'error'` on
  nextTick — so a listener attached after `http.get()` still
  catches it).
- `socketErrorListener`: the `if (request._aborted) return;` guard
  is now `if (request._errorEmitted) return;`. The synthetic
  `'socket hang up'` stays suppressed at emission time in
  `destroy()`/the wait-continuation, not here.
- `destroy()`: when the round trip hasn't started and the socket is
  real (not `FakeSocket`), the socket destroy is deferred one
  macrotask (`setTimeout(0)`). In-flight aborts keep the synchronous
  destroy. The deferral must be a macrotask, not a microtask: under
  the parity harness the test module runs inside a dynamic-import
  microtask, so microtasks drain before nextTicks there (inverted
  vs real Node — probed with a `process.nextTick` /
  `queueMicrotask` marker file) — a `queueMicrotask` destroy would
  still beat the factory's nextTick.
- Factory executor in `_performRequest` (moved before the
  virtual/raw gates by PR #337; this edit applies to the moved
  block): when the factory returns a socket synchronously,
  `onSocket(ret)` runs synchronously (with `_connected = true` set
  first, exactly as the continuation does), so the error forwarder
  is attached before user code runs. The continuation's later
  `onSocket` is a no-op via its duplicate guard; `'socket'`
  emission stays microtask-guarded by `!this._aborted`, so
  aborted-before-tick requests still never emit `'socket'`.
  (PR #337's move subsumes this PR's earlier virtual-gate skip for
  factories — that edit was dropped in the rebase onto `d09b6d08`.)
- `_performVirtualRequest` socket-wait aborted branch: the socket
  destroy is deferred the same macrotask (the continuation is a
  microtask, which the harness drains before nextTicks).
- Server `onHttpEnd`: when the peer link is nulled (`socket._peer
  === null` — net.js `_destroy` nulls it before delivering the EOF,
  while a graceful FIN keeps it) with a response outstanding
  (`inFlight > 0`), the socket is destroyed one microtask later so
  `onHttpClose` runs. Idle FINs keep the existing path.
- Server `onHttpClose`: the stashed-response branch now emits
  `'aborted'` on `stashed.req` (guarded by `!stashedReq.aborted`)
  before destroying the unfinished response — the case the
  `state.current` branch misses for bodyless requests.

## Verification (all on base `d09b6d08` vs branch, host Node v24.22.1)

- Targets, 3 runs each on the branch, all exit 0 (base: 1/1/124):
  `test-http-client-abort`, `test-http-client-abort3`,
  `test-http-client-abort-destroy`.
- NOT this PR's flips (fixed on live main by PR #337, verified
  0×3 on the branch too): `test-http-client-abort-no-agent`,
  `test-http-client-abort-keep-alive-queued-unix-socket`.
- Guards green on the branch: `client-abort-keep-alive-destroy-res`,
  `client-abort-keep-alive-queued-tcp-socket`,
  `client-abort-unix-socket`, `agent-close`,
  `agent-abort-controller`, `agent-destroyed-socket`,
  `client-abort-event`, `client-abort2`, `client-aborted-event`,
  `client-abort-response-event`.
- Full 397-file differential via `fast-sweep.py` vs base
  `d09b6d08`: base 324 pass / 45 fail / 28 timeout / 1×134 /
  1×139; branch 328 pass / 42 fail / 27 timeout / 1×134 / 1×139
  — toward-pass 4, regressions 0, mode-changes 0. The fourth flip
  is `test-http-writable-true-after-close` (base exit 1, branch
  exit 0 ×3): an observed side-effect flip, mechanism unprobed —
  the test asserts `res.writable === true` on a piped server
  response's `finish`/`close`, and the server-close-path changes
  above moved its close ordering. Base CSV
  `http-sweep-ab-base-d09b6d08.csv`, branch CSV
  `http-sweep-ab-branch-r3.csv`.
- Repo tests: jest baseline 3059 passed / 7 failed / 1 skipped
  (the 7 are known host-Node skew, identical on base);
  `tests/ondemand-require.test.js` 29/29.

## Follow-ups (not this PR)

- Unix-socket pair (`test-http-client-abort-keep-alive-queued-
  unix-socket`, `test-http-unix-socket`,
  `test-http-unix-socket-keep-alive`,
  `test-http-client-with-create-connection`): fixed on live main
  by PR #337 — no longer open.
- `test-http-aborted` (timeout) and `test-http-abort-stream-end`
  (exit 1) still fail as on base: adjacent shapes needing
  `IncomingMessage` `'error'` (`ECONNRESET`, message `'aborted'`)
  emission on both the server request and the client response —
  a different sub-cause from the `'aborted'`-event emission fixed
  here. Diagnosed, not attempted; next abort-family round.
