# NOTES — client reject-* loopback response parsing

## Targets (base main 793a7b51 → branch)

- `test-http-client-reject-chunked-with-content-length`: 1 → 0
- `test-http-client-reject-cr-no-lf`: 1 → 0
- `test-http-client-reject-unexpected-agent`: 1 → 0 (sibling bonus)

## Diagnosis (plain terms)

The two reject tests use a **raw net server** that writes malformed
response bytes (`Content-Length` + `Transfer-Encoding: chunked`, and a
header line ending in bare `\r`). Real Node's http client parses those
bytes and reports a parse error on the request. The shim's client sent
the request through `fetch()` instead — fetch cannot reach the virtual
network (no real TCP listener on the virtual port), so every such
request died with `fetch failed` and the malformed bytes were never
parsed at all. The #277 lane established this root cause and left it as
a feature lane: the fetch-backed client never delivered raw net-server
response bytes to the parser.

The plumbing to fix it already existed: `_performVirtualRequest(null,
...)` (built for websocket upgrades to raw net servers) drives an agent
socket through `_socketHttpRoundTrip`, which writes the serialized
request to the socket and parses the response bytes with the shared
`HTTPParser` — including the #277 server-side detections (CL+TE →
`HPE_INVALID_TRANSFER_ENCODING`, bare CR → `HPE_LF_EXPECTED`). Only the
routing decision was missing: `_performRequest` fell through to fetch
for every loopback target without a virtual http server.

## Fix

- `src/net.js`: new exported `hasTcpServer(host, port)` — whether a
  virtual TCP server is registered, using the exact connect lookup keys
  (IP-literal host's own key, else `127.0.0.1`, plus `::` and `0.0.0.0`
  wildcards). Internal only: it is a module export for http.js, NOT
  added to the Node-style default namespace. `tests/
  export_surface_net.test.js` EXPECTED gains the name, following the
  `_createServerHandle`/`_normalizeArgs` precedent for internal exports
  (without it the surface test fails on the extra export — caught by
  the full jest run, not the parity tests).
- `src/http.js`:
  - `_parseTarget()` now also returns `hostname` (existing callers
    destructure `{ local, port }`, unaffected).
  - New `_hasRawNetServer()`: loopback target + registry hit
    (bracketed IPv6 literals unbracketed for the lookup).
  - New gate in `_performRequest`, after the virtual-http-server branch
    and before the websocket branch: loopback + registered net server →
    `_performVirtualRequest(null, ...)` (same call the websocket branch
    makes, so websocket upgrades to registered net servers behave
    identically). The gate is the registry lookup only: loopback targets
    with no virtual listener keep the fetch path exactly, so real local
    servers in a browser still work.
  - `_socketHttpRoundTrip` parser errors now carry Node's client
    socket-error shape, mirrored from the server-side clientError
    normalization: `HPE_INVALID_METHOD` → `Parse Error: Invalid method
    encountered`, other HPE codes → `Parse Error: <reason>` prefix.
    `HPE_TRUNCATED` keeps today's shape (see below).
  - `_performVirtualRequest` non-streamed catch now destroys the socket
    on round-trip failure: real Node destroys the connection on a parse
    error, and leaving it open hangs the loop (the net server writes
    once and waits; `server.close()` does not destroy connections).
    Sockets already dead or closing make destroy a no-op.
  - `ClientRequest` agent validation now throws a dedicated
    `ERR_INVALID_ARG_TYPE_PROPERTY` (TypeError, `"property"` wording,
    invalidArgTypeHelper suffix formatting) instead of the shared
    factory (plain Error, `"argument"` wording). The shared factory is
    unchanged — it is correct for true arguments; only this options
    property needed the property shape.

## Real-Node behavior probed (v24.22.1, not assumed)

- Both reject tests pass unmodified under real Node (exit 0).
- Client parse error shape: message `Parse Error: <llhttp reason>`,
  codes `HPE_INVALID_TRANSFER_ENCODING` / `HPE_LF_EXPECTED`, emitted on
  the request's `'error'`, response callback never called.
- Agent validation messages probed for all six failing values
  (`true`, `'agent'`, `{}`, `1`, `() => null`, `Symbol()`): TypeError,
  `"property"` wording, suffix per invalidArgTypeHelper (object →
  `an instance of Object`, function → `function <name>`, string →
  quoted inspect form).
- Truncated response (headers + partial body, then destroy): response
  `'aborted'` + response `'error'` ECONNRESET `"aborted"`; the request
  itself does NOT error. The shim's non-streamed truncation path
  (request `'error'` HPE_TRUNCATED) already diverges from this and is
  left alone — no test hinges on it.

## Deliberately left alone

- `HPE_TRUNCATED` message shape (see above): pre-existing divergence,
  separate work if a test ever hinges on it.
- `HPE_INVALID_CONTENT_LENGTH` vs `HPE_UNEXPECTED_CONTENT_LENGTH`
  code-name gap (left open by #287): unrelated to these tests, still
  open.
- Fresh zero-byte connections still destroyed by `close()` (#287 note):
  pre-existing, untested divergence, untouched.
- The fetch path for loopback targets with no virtual listener is
  byte-identical to before (only the registry-hit case routes
  differently).

## Follow-up lane (found by the differential, not fixed here)

- `test-http-multi-line-headers` changed failure mode 124 → 1 under
  this lane (still failing; NOT a pass→fail regression). Cause: the
  test sends obs-fold continuation headers with
  `insecureHTTPParser: true`, and the shim parser deliberately rejects
  obs-fold (`HPE_INVALID_HEADER "obsolete line folding is not
  supported"`) — the `insecureHTTPParser` option is unimplemented on
  the client path, so the option is ignored and the parse fails. On
  base the test hung in the fetch path (124) and never reached the
  parser, which hid the gap. Fixing it means threading the option from
  `ClientRequest` into the parser plus a lenient obs-fold mode — a
  separate option-plumbing lane, not a drive-by in this one.

## Verification

- Targets 1 → 0 (branch; see differential below for live-main re-check).
- Guard battery: full client/agent/upgrade/CONNECT/keep-alive/chunked/
  close-idle/outgoing/set-max-idle/parser families — all 0 (see PR
  body for the list).
- Full 397-test differential branch vs pristine base 793a7b51 (CSVs
  `http-sweep-clientreject-branch.csv` / `http-sweep-clientreject-base.csv`
  in the parity-sweep goal hidden_files): base 222/67/108 → branch
  227/64/106. Exactly 6 lines differ: 5 toward pass (the 3 targets
  1→0, plus bonus flips `test-http-extra-response` 124→0 and
  `test-http-no-content-length` 124→0 — both are net-server + http.get
  shapes fixed by the same routing, re-run twice each to rule out
  flake) and 1 changed failure mode, still failing
  (`test-http-multi-line-headers` 124→1 — the new routing exposes the
  unimplemented `insecureHTTPParser` option; see Follow-up lane
  below). Zero pass→fail regressions; crash codes identical
  (134/139).
- Repo jest: 3059 passed / 7 failed (known host version-skew) / 1
  skipped — exactly baseline. Ondemand 29/29. `build-vfs` exit 0.

## CI retrigger (amended head 285bd19d)

- Parity job: success. Build job: failure at the "Build VFS" step,
  with no log summary on the check run — same transient signature
  seen on earlier lanes.
- Local `build-vfs` on this tree: exit 0, `http` and `net` built
  clean. The only local build failure mode observed was the
  transient esm.sh fetch for `src/specials/bundler.js` (acorn /
  acorn-walk), unrelated to this change; a re-run passed.
- This commit is a notes-only retrigger; no source or test file
  changed, footprint unchanged.
