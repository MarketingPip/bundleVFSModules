# NOTES: server-socket parser facade (`socket.parser`)

## Test
`test-http-server-connection-list-when-close` — hung (exit 124) on main
`72df9e75`; passes (exit 0) with this change.

## Real-Node behavior probed (plain Node v24.22.1, before implementing)
- `req.socket.parser` on the server side is the HTTPParser instance
  (object; `free` and `close` are functions; fields include `socket`,
  `incoming`, `outgoing`, `_headers`, `_url`).
- `free()` is called exactly ONCE, at socket-close time — NOT at response
  finish (`res finish` observed with free count 0; the call lands after
  `server.close()` drives socket destruction, immediately before the
  socket `'close'` event).
- After free, `socket.parser` reads `null`.

## Root cause in plain terms
The shim's server dispatch never attached anything to `socket.parser`,
so it was `undefined`. The test does `req.socket.parser.free =
common.mustCall()` in the handler — assigning a property on `undefined`
throws TypeError inside the handler, the throw is swallowed, `res.end`
never runs, and the client waits forever. Case B fails on the same
missing object (`parser.free` replacement + `parser.close()`).

## Fix (src/http.js only, in `_onSocketConnection`)
- Attach a minimal facade as `socket.parser` at connection time:
  `{ socket, incoming: null, outgoing: null, free(), close() }`.
  The shim's real parser stays internal (per-connection, not pooled),
  so `free()`/`close()` are honest no-ops — there is no native
  resource to release and no pool to return to.
- The socket `'close'` handler invokes the CURRENT facade's `free()`
  exactly once (guarded by `state.parserFreed`), inside try/catch so a
  throwing app replacement cannot break close handling, then sets
  `socket.parser = null` — matching real Node's close-time semantics.
  Calling the current facade (not a captured original) is what lets
  test replacements of `parser.free` observe the call.
- No change to the throw-swallowing mechanism: it was not needed. The
  handler no longer throws once the facade exists, so `res.end` runs.

## Deliberately out of scope
- Client-side sockets: `req.socket.parser` for client requests is a
  separate surface (ClientRequest round-trip parser) and is untouched.
- `test-http-server-delete-parser` (sibling test, still hangs on a
  post-exchange loop-drain gap): `delete socket.parser` still succeeds
  — the facade is a plain configurable data property — and the close
  handler skips the free call when the property is gone. Its hang is
  unchanged by this PR and belongs to its own lane.
- Facade `incoming`/`outgoing` stay `null`: no in-scope test reads them,
  and wiring them would touch request dispatch for no test value.

## Verification
- Baseline (main `72df9e75`, same command): exit 124.
- After fix: exit 0.
- Guards: see PR body (server + keep-alive + agent families, PR #254
  timeout flips, PR #256 incoming-message option) — all previously
  passing guards still pass.
