# NOTES — test-http-upgrade-client2 (GET-write flushing for upgrade requests)

## Target

`test-http-upgrade-client2` failed with exit 124 (30 s timeout, no output) on
base `72f81c74`.

## What the test does

- Server: on `upgrade`, writes `101` + `head`, ends the socket when the client
  ends it.
- Client: `http.request({ headers: { Connection: "Upgrade", Upgrade: "Test" } })`
  — no method, so GET — then `request.write("head")` and **never** calls
  `request.end()`. It expects the `upgrade` event, then `socket.end()`,
  then request `close`, twice in a row.

## Diagnosis

Since #257, GET writes are deliberately buffered on the client path: the
streaming round trip only starts for body-capable methods (POST/PUT/PATCH),
explicit Content-Length, or chunked TE. A GET upgrade request was therefore
ineligible for `_streamEnsureStarted`, so `write("head")` sat in
`OutgoingMessage` buffering and the bytes never left — the server never saw
the request, never emitted `upgrade`, and the client hung. The buffered
whole-body-at-end path cannot save this test: an upgraded request is never
ended, because the client owns the socket after 101.

## Real-Node behavior probed (v24.22.1, plain scripts under /tmp)

- GET + Upgrade + `write("head")`, no `end()`: headers + raw `head` reach the
  server within 500 ms. Headers go out on first write, not at end.
- POST/PUT + Upgrade + write, no CL: `Transfer-Encoding: chunked` +
  `4\r\nhead\r\n` chunk framing (the shim's existing streaming behavior).
- GET plain + write, no CL: raw body, no TE header.
- GET + Upgrade + explicit `Transfer-Encoding: chunked` + write: chunked
  framing (explicit TE wins).
- Rule: GET/HEAD bodies go raw unless TE chunked is explicit; POST/PUT/PATCH
  without CL chunk. The shim's old `hasCL ? "raw" : "chunked"` framing rule
  was only ever exercised for body-capable methods, so the GET case never
  mattered — until upgrade eligibility widened to GET.

## Fix (src/http.js only, _streamEnsureStarted)

1. Eligibility: an upgrade request (Upgrade header present, not `websocket`)
   is now streaming-eligible regardless of method. CONNECT and websocket
   upgrades keep their existing paths. No other upgrade test writes before
   end (grep-verified: 0 write calls in upgrade-client, upgrade-agent,
   upgrade-binary, upgrade-advertise, upgrade-reconsume-stream,
   upgrade-server2), so this branch only newly affects upgrade requests that
   write before end — i.e. this test.
2. Framing: `hasCL || ((GET || HEAD) && te !== "chunked") ? "raw" : "chunked"`.
   GET/HEAD upgrade bodies now go raw like real Node; POST/PUT/PATCH
   behavior is byte-identical to before.

Both changes carry `ponytail:` comments naming their ceilings.

## Deliberately left alone

- Non-upgrade GET/HEAD requests: still buffered, still flushed at end().
  Widening streaming to all GET writes would change the delivery path for
  every plain GET-with-body test for no covered benefit.
- `flushHeaders()` on a GET upgrade now also streams (it already called
  `_streamEnsureStarted`); that matches real Node, which sends headers
  immediately on flushHeaders.
- The parallel response-multi-content-length lane (OutgoingMessage
  rendering) was not touched; this lane touches only ClientRequest streaming
  eligibility/framing.
