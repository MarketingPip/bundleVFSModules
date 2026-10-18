# HTTP Hangs Investigation — Working Notes

## Branch: fix/http-parity-hangs (from b6678070)

## Summary

Investigated 4 hanging HTTP tests. **Fixed 2**, documented root causes for the other 2.

### Fixed
1. **test-http-1.0-keep-alive** — was EXIT 124 (hang), now EXIT 0
2. **test-http-chunked-304** — was EXIT 124 (hang), now EXIT 0

### Still Hanging (documented, not fixed)
3. **test-http-agent-uninitialized** — pre-existing hang, complex agent/socket interaction
4. **test-http-blank-header** — pre-existing hang, parser doesn't respond to blank header

### Still Failing (not a hang, separate issue)
5. **test-http-chunk-extensions-limit** — EXIT 1, known microtask timing issue (see NOTES-http-parity-fix.md)

## Fix 1: test-http-1.0-keep-alive — Chunked Response Data Event Splitting

### Root Cause
The server sent chunked responses as **two separate `socket.write()` calls**:
1. `socket.write(headOut)` — headers
2. `socket.write(bodyChunk)` — body + terminator

Each write became a separate `'data'` event on the client. The test increments
its request counter (`current++`) on EVERY data event, assuming one event per
response.

For keep-alive-reused connections (tests 2 and 3 in the file), this desynced
the counter:
- 1st handler: `current=0` ✓
- Client got 2 data events (headers, body) → `current` went 0→1→2
- 2nd handler: `current=2` (should be 1!) → `test.responses[2]` is undefined
- `current+1 (3) !== responses.length (2)` → `this.close()` never called
- The `net.Server`'s `_loopTimer` (setInterval) kept the process alive

### The Fix (commit d459b16a)
Coalesce headers + body + terminator into a **single** `socket.write()` for
chunked responses, matching the non-chunked path which already coalesces:
```js
let out = headOut;
if (sendBody) {
  out += `${body.length.toString(16)}\r\n${body.toString()}\r\n0\r\n\r\n`;
} else if (!noBodyStatus) {
  out += "0\r\n\r\n";
}
socket.write(out);
```

### Test Evidence
- test-http-1.0-keep-alive: was EXIT 124, now EXIT 0
- test-http-1.0: still EXIT 0 (no regression)
- test-http-chunked-smuggling: still EXIT 0 (no regression)

## Fix 2: test-http-chunked-304 — 204/304 with Transfer-Encoding

### Root Cause
The test sends `res.writeHead(304, { "Transfer-Encoding": "chunked" })` followed
by `res.end()`. Per RFC 2616 10.2.5, 204/304 MUST NOT have a body.

Our code treated this as keep-alive (because `shouldKeepAlive=true` for
HTTP/1.1 and `framingOk=true`), so:
1. No `Connection: close` header was sent (test expects it)
2. The socket was NOT destroyed (went to keep-alive branch)
3. Client waited for `'end'` which never came → hang

In native Node, when Transfer-Encoding is explicitly set on a 204/304, the
server closes the connection (the framing is a protocol error).

### The Fix (commit 8a3d5d95)
Two changes in `src/http.js`:

1. In `writeHead()`: if status is 204/304/1xx AND Transfer-Encoding is set
   (via writeHead obj or prior setHeader), set `this.shouldKeepAlive = false`.
   This causes `Connection: close` to be sent in the response headers.

2. In `_finishSocketResponse()`: add `noBodyWithTE` guard to the keepAlive
   decision, forcing `socket.destroy()` for 204/304 with TE:
   ```js
   const noBodyWithTE =
     res._hasBody === false &&
     (res.hasHeader("transfer-encoding") ||
       (res._renderedHeaders || {})["transfer-encoding"] !== undefined);
   const keepAlive =
     info.shouldKeepAlive && maxOk && !socket.destroyed && framingOk && !noBodyWithTE;
   ```

### Test Evidence
- test-http-chunked-304: was EXIT 124, now EXIT 0
- test-http-1.0-keep-alive: still EXIT 0 (no regression)
- test-http-1.0: still EXIT 0 (no regression)
- test-http-chunked-smuggling: still EXIT 0 (no regression)

## Still Hanging: test-http-agent-uninitialized

### Status
Pre-existing hang (verified on base commit b6678070 without my changes).
Not caused by my fixes.

### What I Found
The test manually stuffs an unconnected `net.Socket()` (no `_handle`) into
`agent.freeSockets`, then calls `agent.addRequest(req, {})`.

Our `addRequest` correctly detects the invalid socket (no `_handle`), destroys
it, and falls through to create a new socket via `netConnect()`. The new
socket connects successfully (verified via debug: 'connect' fires).

However, the server never receives the request. The issue involves:
1. `new http.ClientRequest()` (without explicit agent) uses `globalAgent`,
   which calls `addRequest` in the constructor
2. The test then calls `customAgent.addRequest(req, {})` manually
3. Both agents create sockets and call `req.onSocket(socket)`
4. `onSocket()` ignores the second call (`if (this.socket) return;`)
5. The request gets bound to globalAgent's socket, but never reaches the server

The exact reason the request doesn't reach the server was not determined.
Possible causes:
- The `_performVirtualRequest` path vs the socket path confusion
- The `req.end()` happening before socket assignment
- The virtual server registry lookup failing

### Recommendation
This needs deeper investigation into the ClientRequest/Agent/socket
interaction. The `onSocket` duplicate-ignore logic (added for a specific
case) may be too aggressive. However, changing it risks breaking other
agent tests. **Do not fix without careful analysis.**

## Still Hanging: test-http-blank-header

### Status
Pre-existing hang (verified on base commit b6678070 without my changes).
Not caused by my fixes.

### What I Found
The test sends a request with a blank `Cookie:` header:
```
GET /blah HTTP/1.1\r\n
Host: example.org:443\r\n
Cookie:\r\n
Origin: http://example.org\r\n
\r\n
\r\nhello world
```

The client connects and sends the request, but never receives a response.
The server's parser does not invoke the handler and does not send a 400.

The test expects:
- Server handler to be called with `cookie: ""` in headers (mustCall)
- Client to receive `400 Bad Request` with `Connection: close`
- Client to get 'end', then close

This is contradictory: if the handler is called, the request was parsed
successfully, so why 400? The 400 likely comes from Node's automatic
handling of the blank header AFTER the handler runs (or the handler is
expected to trigger it).

From PR #235 summary: "parser-data-arrival unpause for blank-header 400"
was a fix. The parser should detect the blank header and emit an error,
which triggers the `onError` → 400 + destroy path.

But in our current code, the parser is not erroring and not calling the
handler. It's stuck.

### Recommendation
This is a parser-level issue (`src/_http_parser.js`). The blank header
handling needs investigation. **Do not fix without understanding the
parser's header validation logic.**

## Investigation Methodology

Key techniques used:
1. **Handle dumping**: `process._getActiveHandles()` is unreliable in this
   environment (als-browser replaces timer globals; `setInterval` handles
   don't appear). Used a global `Map` registry in `src/net.js` instead.
2. **Server registry**: Found that `net.Server` instances with active
   `_loopTimer` were keeping the loop alive (servers 2 and 3 not closed).
3. **Counter tracing**: Added debug to track the test's `current` variable,
   revealing the 0→2 jump from split data events.
4. **Native vs virtual**: Discovered `process._getActiveHandles()` returns
   2 native `Socket` with `Pipe` handles from the environment (not our code).
   These are harmless (trivial test exits fine).

## Files Changed
- `src/http.js`: two fixes (chunked coalescing, 204/304 TE handling)
- `NOTES-http-hangs.md`: this file

## Commits
- `d459b16a`: fix(http): coalesce chunked response into single socket.write
- `8a3d5d95`: fix(http): close connection for 204/304 with explicit Transfer-Encoding

## Test Results (after fixes)
| Test | Before | After |
|------|--------|-------|
| test-http-1.0 | EXIT 0 | EXIT 0 |
| test-http-1.0-keep-alive | EXIT 124 (hang) | EXIT 0 ✅ |
| test-http-agent-uninitialized | EXIT 124 (hang) | EXIT 124 (hang) |
| test-http-blank-header | EXIT 124 (hang) | EXIT 124 (hang) |
| test-http-chunked-304 | EXIT 124 (hang) | EXIT 0 ✅ |
| test-http-chunked-smuggling | EXIT 0 | EXIT 0 |
| test-http-chunk-extensions-limit | EXIT 1 (fail) | EXIT 1 (fail, separate issue) |
