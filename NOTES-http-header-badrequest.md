# NOTES-http-header-badrequest.md

## Test

`test-http-header-badrequest.js`: server handler does `res.write("asd", () => res.socket.emit("error", new Error("kaboom")))`.
The raw client must see `'end'` with the received bytes ending in `asd\r\n`
— i.e. the chunk frame `3\r\nasd\r\n` and then EOF, with no trailing `0\r\n\r\n`.

- Base (`5387fe4b`): **124** (hangs — `'end'` never fires).
- Branch: **0** (twice).

## Root cause (two layers)

1. **Socket `'error'` was a no-op on server sockets.** `_onSocketConnection`
   attached `onHttpError = () => { /* 'close' handles cleanup */ }`, so a
   manual error emit left the socket alive forever. Real Node attaches
   `socketOnError` to every accepted socket (`lib/_http_server.js:832`,
   `999-1033`): it removes itself, ensures a noop `'error'` listener exists,
   emits `'clientError'` on the server, writes a 400 when the response
   header has not been sent yet, and destroys the socket unless
   `'clientError'` handled it. In this test the header was already sent,
   so Node just destroys and the client sees FIN.
2. **The chunk frame was still pended when the write callback fired.**
   `OutgoingMessage._write` calls the write callback synchronously after
   `_pendFrame()` (flush is a microtask), so a destroy inside the callback
   discarded the frame before delivery and the client saw `'end'` with
   zero bytes. Real Node has the bytes in the kernel buffer before the
   callback fires. The fix flushes the in-flight response's pending frame
   before destroying (`_flushPendingFrame` delivers to the peer
   synchronously via `_deliverToPeer`).

## Fix (`src/http.js` only, `_onSocketConnection`)

Port of `socketOnError`, minus the HPE/413 branches (those arrive via the
parser path, which owns its own responses):

- `if (socket.destroyed) return;` — destroy's own error emission
  re-enters here with the socket already destroyed (the parser-error path
  destroys directly); without this guard `'clientError'` would be
  double-emitted.
- `removeListener('error', onHttpError)` + add a noop `'error'` listener
  if none — destroy re-emits `'error'` on nextTick via `emitErrorNT`
  (`src/stream/destroy.js:147`); with the handler removed and no other
  listener that emission would throw unhandled.
- `if (!this.emit('clientError', e, socket))` — a handled `'clientError'`
  leaves the socket to the app, exactly as Node; unhandled proceeds.
- Header not sent yet: write `HTTP/1.1 400 Bad Request\r\nConnection:
  close\r\n\r\n` (Node's default; the 431/413 mappings live in the
  parser path).
- Flush the in-flight response's pending frame (`state.current?.res ??
  state.lastResponse`), then `socket.destroy(e)`.

## Verification

- Target 0×2 on branch; 124 on base.
- Guards 25/25 on branch: all 8 PR #345 flips, all 4 PR #347 flips,
  outgoing-finish, outgoing-drain-writable-length, client-error-rawbytes,
  socket-error-listeners, socket-encoding-error,
  server-destroy-socket-on-client-error, server-multiple-client-error,
  server-client-error, client-read-in-error (client-side error emit —
  unaffected, still 0), parser-finish-error, blank-header,
  double-content-length, client-parse-error.
- Mode-changed trio unchanged on branch (still exit 1):
  mutable-headers, set-cookies, should-keep-alive (PR 4 targets).
- Differential (fast runner): base 353 → branch 354, exactly 1 toward
  pass, 0 regressions, 0 mode changes. CSVs `http-sweep-hb-{base,branch}.csv`.
- Jest: 3059 passed / 7 failed / 1 skipped (exact baseline).
- Ondemand 29/29. Builds: vfs/sandbox/runtime `--check` all 0.

## Follow-ups (not this PR)

- PR 4 (mutable-headers + set-cookies) is the remaining header-assembly
  follow-up; its targets now fail fast (exit 1) instead of hanging,
  which should make diagnosis easier.
- The 400 branch of the new `onHttpError` is untested by any current
  test (the only manual server-socket error emit has its header sent);
  it mirrors Node's `socketOnError` default for a pre-headers error emit.
