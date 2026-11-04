# test-http-parser-memory-retention — request.parser exposure + close-time nulling

## Test shape

Real Node frees the HTTP parser before returning it to the pool, so a
finished request must not retain parser state:

- Server side: in the `request` handler, `request.socket.parser[kOnTimeout]`
  (where `kOnTimeout = HTTPParser.kOnTimeout | 0`) must be a function; on
  socket `close`, the CAPTURED parser object's slot must be `null`.
- Client side: in the `socket` handler, `request.parser` must have
  `onIncoming` a function and `joinDuplicateHeaders === true` (the test
  passes `joinDuplicateHeaders: true` in `http.get` options); on response
  `end`, the captured parser's `onIncoming` and `joinDuplicateHeaders`
  must both be `null`.

## Diagnosis

- Server: the shim's `socket.parser` was a facade (`{ socket, incoming,
  outgoing, free(), close() }`) with NO numeric slot, and the close
  handler only nulled the socket's reference (`socket.parser = null`) —
  the captured facade object itself kept whatever it had. The test reads
  the captured object, so the slot must be nulled on the facade.
- Client: `request.parser` was never set anywhere in the shim (the #300
  lane's documented root cause: `undefined` at `socket` time; that branch
  only changed how the identical assertion throw surfaces).

Probed real Node v24.22.1: `HTTPParser.kOnTimeout` is the NUMBER `6`
(hence `| 0` works); default `joinDuplicateHeaders` is `undefined` (no
option); after response `end`, `req.parser` itself is `null` as well as
the captured object's props.

## Fix (src/http.js only)

- ClientRequest stores the raw `joinDuplicateHeaders` option value
  (default `undefined`, matching the probe — NOT `false`).
- `ClientRequest.onSocket()` creates the response parser eagerly at
  assignment — `this.parser = new HTTPParser("response", ...)` — sets
  `parser.onIncoming` to a no-op function and `parser.joinDuplicateHeaders`
  to the stored option, BEFORE the assignment-time `socket` microtask
  emission, so the test's `socket` handler sees it. The shim drives
  responses via `onHeadersComplete`/`onBody`/`onMessageComplete`/`onError`;
  this slot exists only so `request.parser` matches Node's shape.
  The parser is POOLED PER SOCKET (`socket._pooledParser`): real Node
  reuses one parser per socket, and `test-http-parser-free` asserts
  identity across 100 pooled requests — a per-request parser passed
  memory-retention but regressed parser-free (0→124, isolated 3/3).
  onSocket refreshes the pooled parser's per-request props (and the
  lenient flag, in case pooled requests differ) at each assignment.
  Parser state itself resets at message completion (`_resetMessage`),
  so reuse across sequential messages is safe; the socket owns the
  lifetime (destroy frees it with the socket).
- `_socketHttpRoundTrip` accepts an optional `parser` option and uses it
  instead of creating its own (still setting `isHeadResponse` +
  callbacks); the runtime-bridge caller keeps default creation.
- `IncomingMessage._finishBody()` nulls the client parser props before
  pushing EOF, guarded on `msg.req?.parser` (server-side `_finishBody`
  calls have no `.req.parser`, so they are no-ops): `parser.onIncoming =
  null`, `parser.joinDuplicateHeaders = null`, `msg.req.parser = null`.
  This runs before `push(null)`, so `end` fires after the nulling.
- Server facade gains a numeric slot keyed by the named constant
  `HTTP_PARSER_K_ON_TIMEOUT = 6` (comment records the probe and the
  ceiling: the vendored suite pins the era, a future Node renumbering
  would break the mapping), holding a no-op function during the request.
  The close handler sets `facade[slot] = null` AFTER calling `free()` (so
  app `free` replacements still observe the call), before
  `socket.parser = null`. The close handler runs before app `close`
  listeners (attached at connection setup vs. in the request handler),
  so the test's `close` assertion sees null.

## Deliberate non-changes

- No global parser pool: the pool exists per socket in Node, and the
  socket already owns the lifetime; a global pool would add lifecycle
  for no test gain (ponytail ceiling noted in code).
- The round trip's own callbacks (`onHeadersComplete`, etc.) are NOT
  nulled at end — the test asserts only `onIncoming` and
  `joinDuplicateHeaders`, and nulling driver callbacks could break
  pooled reuse paths.

## Verification

- Target passes isolated 3/3 on the branch; fails on pristine main
  (`01c83107`) with `request.parser` undefined at `socket` time.
- Full 397-file differential vs pristine main `01c83107`: see the PR body
  (expected: exactly 1 line toward pass, zero pass-to-fail).
- Guards: server-keepalive-req-gc, agent-keepalive, server-delete-parser,
  upgrade-client2, upgrade-server, keep-alive, client-parse-error,
  client-error-rawbytes, agent-keepalive-delay, client-timeout-event, 1.0,
  server, server-close-idle, server-close-all, client-path-toctou,
  parser-finish-error, max-http-headers, parser-freed-during-execute,
  parser-bad-ref, parser — all 0. `parser-free` is itself a guard: the
  first (per-request-parser) shape regressed it 0→124 isolated 3/3, and
  the pooled shape fixed it (3/3) without breaking memory-retention.
