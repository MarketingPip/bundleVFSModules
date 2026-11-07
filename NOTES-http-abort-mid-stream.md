# NOTES-http-abort-mid-stream.md — Lane 9: client abort mid-stream

Target: `test-http-abort-stream-end` (1 → 0).

## Root cause

The server writes 1024 tiny chunks; the client aborts inside a `data`
handler once `size > 1024`. The shim kept emitting `data` for all 1024
chunks after the abort (probe: 1024 `data` events post-abort).

The chunks were already pushed into the response's Readable buffer before
the first `data` handler ran (the round trip pushes per-chunk via
`onBody` → `streamedMsg._pushBody`, and the flow drains them on the next
tick). The `onBody` guard (`!this._aborted`) only blocks *future* pushes;
it cannot stop the drain of already-buffered chunks.

## Fix — Node's own mechanism (lib/_http_client.js)

1. `ClientRequest.destroy()` dumps the in-flight response first
   (`lib/_http_client.js:686-692`: "If we're aborting, we don't care about
   any more response data"). `IncomingMessage._dump()` (faithful port,
   `lib/_http_incoming.js:502`) removes the response's `data` listeners and
   resumes it, so the in-progress flow loop drains silently.
2. `this.res` is now assigned when the response is created, as Node's
   `parserOnIncomingClient` does (`lib/_http_client.js:960`): streaming
   `onHeaders` and the buffered completion path in
   `_performVirtualRequest`. Before this lane `this.res` was always `null`
   (set only in the constructor, PR #360), so `destroy()` had nothing to
   dump.

Probe after the fix: data stops at event #284 (the abort), `req 'abort'`
fires with `size === 1024`.

## Scope limits

- `this.res` is NOT assigned for CONNECT tunnels / 101 upgrades. Node
  assigns it there too (`lib/_http_client.js:820`), but no official test
  covers it and the shim's upgrade path destroys via
  `Writable.prototype.destroy` (not `ClientRequest.destroy`), so the dump
  would not trigger there anyway. Follow-up if a test hinges on it.
- 1xx interim messages do not clear `this.res` (Node
  `lib/_http_client.js:911` does). The shim never assigns `res` for
  interim messages, so there is nothing stale to clear in the normal
  order; a 1xx arriving *after* a final response (double-response shape)
  is Lane 10's territory.

## Verification

- Target 0×2 on branch; guards 45/45 (abort families, timeout families,
  #359/#360/#362–#367 flips, upgrade/connect, write-callbacks,
  catch-uncaughtexception).
- Differential via fast-sweep (http-sweep-ams-{base,branch}.csv).
