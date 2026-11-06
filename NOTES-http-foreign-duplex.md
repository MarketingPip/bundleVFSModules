# NOTES — foreign-Duplex transport (test-http-client-readable, test-http-generic-streams, test-http-parser-multiple-execute)

## Targets

- `test-http-client-readable` — 1 → 0
- `test-http-generic-streams` — 1 → 0
- `test-http-parser-multiple-execute` — 1 → 0

All three share one surface: `createConnection` returning a foreign
(stream.Duplex, not a net Socket) — the shape used by
`test-http-header-value-relaxed` Test 10's duplexPair and by the three
targets' `FakeAgent`/`duplexPair` factories. Plain Content-Length responses
over a foreign Duplex already worked (generic-streams Test 1 passed on base);
three sub-behaviors failed.

## Root causes and fixes

### 1. Foreign sockets never reached the round trip (src/http.js ~5173, inherited)

A socket assigned from a custom `createConnection` fell through to the
fetch branch instead of `_performVirtualRequest`. Node
(`lib/_http_client.js:1242`, `tickOnSocket`) drives the request off any
socket the factory returns. Fix: a foreign (non-NetSocket) assigned socket
routes through `_performVirtualRequest`.

### 2. Pre-round-trip connect wait hung foreign Duplexes (src/http.js ~5935, inherited)

`_performVirtualRequest` waited for the socket's `'connect'` event before
starting the round trip. A foreign Duplex never emits `'connect'`, so the
request hung. Fix: the wait is gated on `NetSocket` only
(`Socket as NetSocket` imported from `./net.js` at ~:44).

### 3. 1xx: `100 Continue` swallowed the `information` event (src/http.js ~6148, inherited)

The 100 branch returned early after emitting `'continue'`, so `'information'`
never fired. Node (`lib/_http_client.js:910-924`) emits both. Fix: 100 falls
through to emit `'information'` as well as `'continue'`.

### 4. Parser reentrancy: nested `execute()` misread the next message (src/_http_parser.js, NEW)

`test-http-parser-multiple-execute` failed at `:38` — the `'response'`
handler never fired, although `'information'` DID fire. Root cause, proven
by probe `zz-fd-probe2.js`: the `'information'` handler pushes the 200
response into the socket while `onHeadersComplete` for the 100 is still on
the stack; the shim's stream emits `'data'` synchronously, so the nested
`execute()` ran while `_state` was still `"headers"` and misread
`HTTP/1.1 200 OK` as a header line (`HPE_INVALID_HEADER "malformed header
line: HTTP/1.1 200 OK"`). Real Node's llhttp is already in next-message
state when `onHeadersComplete` fires, so the nested bytes parse as a new
message (verified: the same probe under real Node completes
`information: 100` → `response: 200` → `sock end`).

Fix: an `_executing` flag on the parser (initialized `false` in the
constructor). If `execute()` is re-entered, the bytes are appended with a
plain `Buffer.concat([this._buf, bytes])` WITHOUT compaction — compaction
would corrupt the outer call's `_off`/`_headStart`, and
`_parseFixedBody`/`_parseChunkedBody` locals assume stable offsets — and
the call returns; the outer loop consumes the buffered bytes after the
current message completes (`_finishMessage` → state `"complete"` →
`_resetMessage` → new start line; the client parser never sets
`pauseBetweenMessages`, only the server parser does at src/http.js:8601).
`finally { this._executing = false; }` added to the existing try/catch.

### 5. Non-keep-alive server finish: `destroy()` fallback starved the peer (src/http.js ~10122, NEW)

In `_finishSocketResponse`'s non-keep-alive branch, the no-`destroySoon`
fallback was `socket.destroy()`. Node's `resOnFinish`
(`lib/_http_server.js:1123-1129`) does `if (typeof socket.destroySoon ===
'function') socket.destroySoon(); else socket.end();`. `destroy()` on a
foreign Duplex (a duplexPair side) propagates nothing to the peer, so the
client socket never saw `'end'` — this fixed the clientSide-`'end'` half of
generic-streams Tests 3/4. `destroy()` is kept only as the catch fallback
if `end()` throws. Safe for `FakeSocket` (it has `end()`, src/http.js ~597)
and for virtual net Sockets (they HAVE `destroySoon`, so the fallback never
fires for them).

### 6. Agent-less request never closed its socket (src/http.js `_releaseAgentSocket`, NEW)

After fixes 1–5, generic-streams Tests 3/4 still failed ONLY on the two
`serverSide.on("end", mustCall())` assertions (`:104`, `:154`); everything
else passed. Probe `zz-fd-t3d.js` proved the release path never ran:
`clientSide._releasedToAgent === undefined` at res end and at +100ms,
`clientSide.destroy()` never called, `clientSide.destroyed === false` —
and, decisively, `req.agent === false`: with a request-level
`createConnection`, real Node leaves `this.agent` undefined
(`lib/_http_client.js:366-372`, "agent will not be used when
createConnection is provided"), so `_releaseAgentSocket` returned early
and nobody ever closed the client socket. In real Node the serverSide
`'end'` comes from the CLIENT closing its socket after the
`Connection: close` response.

Fix: in `_releaseAgentSocket`, when there is no agent, apply Node's
`responseOnEnd` rule (`lib/_http_client.js:1017-1031`): if
`!this.shouldKeepAlive` and the socket is still writable,
`destroySoon()` when present, else `end()`. A keep-alive agent-less
socket is left alone — the next request reuses the same factory socket
(generic-streams Test 2). The end is subject to the same
writableFinished/`'finish'` deferral as the agent path (PR #355
principle), so an in-flight request body is not truncated.

## Probes (all under `parity/node-test/parallel/zz-fd-*.js`, deleted before commit)

- `zz-fd-probe1.js` — chunked body over a `FakeAgent` Duplex: before, the
  chunked bytes were visible on the socket but never delivered as `res`
  data; after, `res data: "hello world"` + `res end`.
- `zz-fd-probe2.js` — parser-multiple-execute shape (100 then 200 pushed
  from the `'information'` handler): before, `HPE_INVALID_HEADER` on the
  nested execute; after, `information: 100` → `response: 200` → `sock
  end`, identical to real Node.
- `zz-fd-probe3/4/5.js` — duplexPair FIN/end propagation: paused-side +
  peer `.end()` emits `'end'` in both real Node and the shim; peer
  `.destroy()` delivers nothing to a paused peer in BOTH — the drain
  hack from the first worker was chasing a non-issue on that point.
- `zz-fd-probe6.js` — 100 Continue via Duplex: before, the same nested
  execute error as probe2; after, `information 100` → `response 200`.
  (The probe itself keeps pushing 100 on every `_read`, so it errors
  `ERR_STREAM_PUSH_AFTER_EOF` after the socket ends — a probe bug, not a
  shim gap; real Node tolerates the infinite push because its socket
  never ends in that probe shape.)
- `zz-fd-t3.js` / `t3b.js` / `t3c.js` / `t3d.js` — generic-streams Test 3
  replications with logging. `t3c` proved `_releaseAgentSocket` never
  ran; `t3d` proved `req.agent` is falsy and `shouldKeepAlive === false`
  while the socket was never closed — the evidence for fix 6.

## Guards

- The 3 targets + neighboring families re-run 0 on the branch: keep-alive
  families, `#345/#347/#353/#355/#357` flips, upgrade families, parser
  families, TE/smuggling, client families, server-close families,
  header-badrequest, mutable-headers, agent families. (Full list in the
  lane report.)
- Repo jest suite vs pristine-base baseline: 7 known host-skew failures
  (constants, perf_hooks, sys, oracle crypto/util) — branch matches base.
- `tests/ondemand-require.test.js`: 29/29.
- Local builds: `build-vfs` / `build-sandbox --check` / `build-runtime
  --check` clean (build-vfs esm.sh transient, if any, proven on base too).

## Differential

- fast-sweep only: `http-sweep-fd-base.csv` / `http-sweep-fd-branch.csv`.
  Expect exactly the 3 targets 1 → 0, zero regressions.

## Scope limits

- Does NOT touch L13's tests (`test-http-header-overflow`,
  `test-http-max-header-size-per-stream`): `maxHeaderSize` is still never
  threaded from client/server options to the parser (src/_http_parser.js
  default `16*1024` at :135). Shared fake-socket dispatch surface only
  via rebase.
- The `_executing` reentrancy guard buffers during nested execute; a
  pathological stream that re-enters execute indefinitely (e.g. a handler
  that pushes unbounded bytes synchronously on every header) would grow
  the buffer instead of parsing incrementally — no test exercises that,
  and real Node's llhttp does not have the same reentrancy shape.
  ponytail: ceiling is a parser-level queue; upgrade path is moving the
  client round trip's data delivery to an async boundary so nested
  execute cannot happen at all.
- `test-http-client-close-with-default-agent` is TIMING-FLAKY in this
  environment, not a lane regression: it failed 2/3 isolated on the
  branch, 2/2 on the spawn base, 3/3 on pristine live main (88dde84b),
  and 1/2 under real Node with no preload (its 1s mustNotCall timer
  races process exit under load). The post357 CSV recorded it 0 from a
  clean sweep.
- `test-http-dns-error` and `test-https-timeout-server` are untouched
  (separate lanes).
