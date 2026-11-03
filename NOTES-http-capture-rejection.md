# test-http-outgoing-message-capture-rejection — drain throw never reaches the socket

## Test shape

`events.captureRejections = true`. Block 1: server response `drain` async
throw → `res.socket` `error` mustCall with the identical error →
`server.close()`; client sees `aborted` + `ECONNRESET`. Block 2: client
request `drain` async throw → `req` `error` mustCall with the identical
error → `server.close()` + response cleanup.

## Failure on pristine main `e48733e4`

Exit 124 (hang), 3/3 runs. Block 1 hangs; block 2 never runs.

## Diagnosis — traced end to end

1. The `events` module question resolves cleanly: the shim's
   `OutgoingMessage` extends the NATIVE `Writable` (bare `"stream"` import
   in `src/http.js`), so the test's `require("events")` (native) and the
   response/request objects share the native capture machinery. No
   harness split — the #295-class suspicion does not apply here. Proven
   by identity probe: `res instanceof native Writable`,
   `res.emit === native EventEmitter.prototype.emit`, and a plain native
   `Writable` under the harness DOES turn an async drain throw into
   `error`.

2. The drain rejection path for streams (Node docs: the capture handler
   routes to `Symbol.for("nodejs.rejection")` when present, else to
   `error`): for a `Writable`, the rejection goes through
   `errorOrDestroy` → `destroy(err)` → `ServerResponse._destroy(err)`.
   Real Node (probed v24.22.1, block 1 order): socket `error` (identical
   err) → res `close` → socket `close` hadError:true → client `aborted`
   → client `ECONNRESET` → client res `close`; NO res `error` ever fires.
   Block 2 order: req `error` (identical) → socket `error` (identical) →
   req `close` → socket `close` hadError:true.

3. The shim's `ServerResponse._destroy` destroyed the socket GRACEFULLY
   (`sock.destroy()`, no error) even when `err` was set — the #294 note
   already recorded this divergence ("real Node's
   `ServerResponse.destroy(err)` destroys the server socket WITH the
   error, shim destroys gracefully"). So the socket closed with
   hadError:false, no socket `error` fired, the test's `server.close()`
   never ran, and the test hung. (Block 2 already worked: `ClientRequest`
   `_destroy` propagates the error to `socket.destroy(err)` — probed
   passing in isolation before this fix.)

## Fix (`src/http.js`, `ServerResponse._destroy` only)

When `err` is present, destroy the socket WITH the error
(`sock.destroy(err)`); graceful destroys still pass no error. The
`super._destroy(err, cb)` below still swallows the callback error
(`cb(null)`), so — matching real Node — no res `error` ever fires, and
the socket `error` + `close` hadError:true carry the signal. One line of
behavior change plus a comment; no new link, no new invariant.

## Guards (all exit 0)

capture-rejection (3/3), outgoing-destroyed, outgoing-destroy,
response-close, set-trailers, byteswritten, keep-alive, chunked-304,
outgoing-properties.

## Pre-existing, NOT a regression, NOT fixed here

`test-http-server-capture-rejections` fails exit 1 on pristine main too
(2 runs): an async server HANDLER throw surfaces as an unhandled
`error` on the ServerBase instead of a 500 response. That is the
handler-throw-swallowed-by-dispatch shape (a different root cause from
this lane's drain→socket routing), and it belongs in a follow-up lane,
not this PR.
