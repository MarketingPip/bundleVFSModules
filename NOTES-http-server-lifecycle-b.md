# NOTES — http server lifecycle, PR-B (connections-checker bridge)

Targets (all verified failing on main `44c60370` before work — the slot
was never set — passing after; each re-run twice):

- test-http-server-async-dispose
- test-http-server-clear-timer
- test-http-server-close-destroy-timeout

## The bridge

All three tests read `server[kConnectionsCheckingInterval]` from
`require("_http_server")`. Real Node (probed v24.22.1): the slot is
undefined at construction; each 'listening' emit destroys the previous
interval object and creates a NEW one (a Timeout with
`_destroyed=false`); close() destroys the current one (same object
identity afterwards).

Two things had to be true at once, and the first attempt got one of
them wrong:

1. The shim's ServerBase must maintain the slot. Implemented in
   `src/http.js`: a construction-time internal 'listening' listener
   (registered before any user listener, so it runs first on every
   emit — including manual `server.emit("listening")`, which
   clear-timer emits twice by hand) destroys the previous bridged
   object and creates a new `{ _destroyed: false }`; `close()`
   destroys (does not replace) the current object; `[Symbol.asyncDispose]()`
   returns a promise resolving via `close()`'s callback.
   `_stopConnectionChecker` deliberately does NOT touch the slot: it
   only clears the shim's real `_checkTimer`, and a connection
   draining to zero while listening must not destroy the bridged
   object.
2. The test's imported symbol must BE the shim's slot key. The first
   attempt edited `src/_http_server.js` to a `Symbol.for` key — but
   the test never loads that module: under the harness,
   `require("_http_server")` has no preload redirect and falls
   through to native Node's `_http_server` (verified: the symbol
   description matches native exactly, and `mod.Server !==
   http.Server` under the harness while natively they are equal), so
   the slot always read undefined. The fix follows the established
   `internal/timers` precedent: a new harness-only adapter
   `parity/http-server-adapter.mjs` exports the bridge key
   `Symbol.for("bundleVFSModules.http.kConnectionsCheckingInterval")`
   (the same key ServerBase uses — the global registry is the sharing
   mechanism, avoiding a circular import), and `parity/preload.mjs`
   gains one special case redirecting `require("_http_server")` to it
   for the http target only. The `src/_http_server.js` edit was
   reverted (it is the browser runtime's module; the test doesn't
   use it). Only `kConnectionsCheckingInterval` is exported: it is
   the only member the http tests use, and no other http-target
   importer touches this module.

## ponytail ceiling

The bridged value is a plain `{_destroyed}` object, not a real
Timeout — no suite test asserts timer identity or firing, only
`_destroyed`; the shim's real checker timer (`_checkTimer`, started
lazily on first connection) stays separate. If a test ever asserts
the object IS a Timeout, this bridge needs a real timer behind it.

## Out of scope (not regressed, still failing as before)

- test-https-server-async-dispose and
  test-https-server-close-destroy-timeout also import
  `kConnectionsCheckingInterval` from `_http_server`, but they run
  under the https target, which keeps the real module. The preload
  redirect is http-target-only by design; the https twins are a
  separate follow-up if the https Server ever shares this slot.

## Probes (v24.22.1)

- `kConnectionsCheckingInterval` lifecycle: undefined at
  construction; each 'listening' emit creates a NEW interval object
  (internal 'listening' handler destroys the old, creates a new one
  — this explains clear-timer: emit1 saves interval-A, emit2's
  internal handler destroys A before the user handler asserts
  A._destroyed, then user saves B; close destroys B); after listen
  the object is a Timeout with `_destroyed=false`; after close
  `_destroyed=true`, same object identity.
