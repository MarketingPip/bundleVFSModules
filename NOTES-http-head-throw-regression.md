# NOTES: test-http-head-throw-on-response-body-write regression

## What the test asserts

Three blocks, all server-side:

1. HEAD request to a server that ends a body: the client must see
   `end` and the server must close (body bytes are dropped for HEAD
   responses by the client parser, as on real Node).
2. `createServer({ rejectNonStandardBodyWrites: true })`, GET,
   `writeHead(204)`, then `res.write(...)` MUST throw synchronously
   with `ERR_HTTP_BODY_NOT_ALLOWED` /
   "Adding content for this request method or response status is not
   allowed." — and the handler then calls `res.end()` and the client
   sees a 204 + `end`.
3. `createServer({ rejectNonStandardBodyWrites: false })`, HEAD,
   `writeHead(200)`, `res.end(body)`: client sees `end`, server closes.

## Why it hung (regression, not a new gap)

- The test passed on the Oct 28 sweep (main `1d8bc7b4`) for the WRONG
  reason, and hangs on current main. Bisect detail below.
- On Oct 28, `res.write` after `writeHead(204)` did NOT throw (the
  option was never implemented — `rejectNonStandardBodyWrites`
  appeared nowhere in `src/`), so the block-2 `assert.throws` failed
  inside the handler — but the Oct 28 dispatch still delivered the
  already-stored 204 headers to the client, so the client saw `end`
  and the test passed accidentally.
- On current main the same handler throw aborts the handler before
  `res.end()`, and nothing delivers the response: the client waits
  forever (exit 124). The swallowed-throw hang is the same failure
  mode the triage note names for this lane family.
- The principled fix is the missing feature, not the dispatch
  throw-handling: with the throw implemented, the test's `assert`
  passes, `res.end()` runs, and the exchange completes for the RIGHT
  reason on both the shim and real Node.

## Real-Node behavior (probed v24.22.1, single-trial processes)

- `reject: true` + write (even empty) to 204 / 304 / 1xx / HEAD-200 →
  throws `ERR_HTTP_BODY_NOT_ALLOWED` with the message above.
- `reject: true` + `end(body)` to 204 / HEAD-200 → throws the same.
- `reject: true` + 200 GET + write → no throw.
- Default (option absent) and `reject: false` → NO throw (silent
  drop, the pre-existing shim behavior, unchanged).
- Only the literal `true` enables it: a truthy `1` does NOT throw.

## Fix (`src/http.js` only, plus this file + allowlist)

- Error factory `ERR_HTTP_BODY_NOT_ALLOWED` beside
  `ERR_HTTP_TRAILER_INVALID` (same `makeError` shape).
- `ServerBase` stores `_rejectNonStandardBodyWrites =
  options.rejectNonStandardBodyWrites === true`, forwarded to every
  `ServerResponse` at the three construction sites (main dispatch,
  drop-response, runtime-bridge `handleRequest`); `ServerResponse`
  reads it from its `options` argument.
- `OutgoingMessage.write`: after `_implicitHeader`, before the
  `_hasBody === false` silent-drop branch — if the flag is set and
  (`_hasBody === false` or `req.method === "HEAD"`), throw. Only
  `ServerResponse` ever carries the flag, so `ClientRequest` is
  unaffected. The destroyed-branch check stays first (write-after-
  destroy keeps its existing path), and the write-after-end error
  emit in `ServerResponse.write` runs before `super.write`, so a
  finished response keeps the write-after-end error, not this one.
- `OutgoingMessage.end` AND `ServerResponse.end` (separate overrides;
  the latter does not call the former): same check for a non-null
  chunk, thrown before `finished` is set so a retry `end()` still
  delivers. A chunkless `end()` never throws.
- Deliberately NOT changed: the dispatch handler-throw path (the
  Oct 28 accidental pass is not a behavior to restore); default /
  `false` silent-drop behavior; client-side bodies.

## Verification

- Target 124 → 0 (branch + live main, see parent report).
- Full 397 differential vs pristine main `af5bf0f6`: see
  `http-sweep-reght-branch.csv` / `http-sweep-reght-base.csv`.
- Guards all exit 0: readable-data-event, 1.0, 1.0-keep-alive,
  server-keep-alive-defaults, outgoing-properties, outgoing-end-types,
  outgoing-buffer, outgoing-destroyed, res-write-after-end,
  res-write-end-dont-take-array, write-head-after-set-header,
  chunked-304, set-trailers, flush-response-headers, byteswritten,
  keep-alive, chunked, server, upgrade-server.
