# Client request-head assembly (header-assembly lane, PR 1)

## Root cause

The client request head was assembled from three different rules that each
disagreed with real Node (`lib/_http_client.js`, `lib/_http_outgoing.js`
`_storeHeader`, `lib/internal/url.js` `urlToHttpOptions`, all v24.20.0):

1. **Host gate wrong.** The constructor keyed the auto Host on
   `setDefaultHeaders !== false` directly. Node's rule is
   `setHost = options.setHost !== undefined ? Boolean(setHost) :
   setDefaultHeaders !== false` — so `setDefaultHeaders:false` +
   `setHost:true` sent no Host at all, and the serializer then invented
   `Host: localhost`.
2. **Connection header invented in two places.** `_performVirtualRequest`
   injected `Connection: keep-alive` whenever `agent.keepAlive`, even
   with default headers off; the serializer unconditionally appended
   `Connection: close`. Node's rule (`_storeHeader`): with default
   headers off there is no Connection header; otherwise keep-alive iff
   `shouldKeepAlive && (Content-Length || chunked-by-default || agent)`,
   else close — and `shouldKeepAlive` is false only for a
   keepAlive:false agent with unbounded maxSockets.
3. **Array-form headers lost their order.** `_mergeArrayHeaders` folded
   ordered pairs into an object, regrouping duplicate names at first-seen
   position (`foo, test, foo` became `foo, foo, test`).
4. **`parseRequestArgs` did not decode URL auth.** It built
   `auth` from the raw percent-encoded userinfo, so the `Authorization`
   header base64'd the encoded form (`test%40test` instead of
   `test@test`). The constructor's own URL path already decoded; only
   the `http.request(url)` path was wrong. It also dropped user-added
   URL properties (e.g. `url.headers`); Node's `urlToHttpOptions`
   spreads the URL object.

## Fix (`src/http.js` only)

- `parseRequestArgs`: `decodeURIComponent` the username/password;
  spread a URL instance's own properties into options.
- `ClientRequest` constructor: Node's `setHost` rule (stored as
  `_setHost`); `_removedConnection/_removedContLen/_removedTE` set from
  `setDefaultHeaders === false`; auto Host is IPv6-bracketed and carries
  `:port` only off-default; `shouldKeepAlive` from the agent rule.
- `_performVirtualRequest`: the keep-alive injection is removed — the
  serializer owns Connection now, in one place. `noDefaultHost` is also
  suppressed when `setHost` is false.
- `_serializeRequestHead`: new `shouldKeepAlive` /
  `useChunkedEncodingByDefault` / `hasAgent` inputs (defaults preserve
  the runtime-bridge caller's old `Connection: close` wire); emits
  Connection before Content-Length, matching Node's render order; no
  Connection at all when `setDefaultHeaders` is false. Accepts ordered
  header pairs as well as objects.
- `_virtualHeaders`: array-form headers return as ordered pairs (with
  the `uniqueHeaders` `'; '` collapse preserved); `_mergeArrayHeaders`
  deleted as dead code. `_streamEnsureStarted`'s chunked-TE append
  handles the pairs shape.

## Flips (verified exit 0, 2/2 each after the fix)

- test-http-dont-set-default-headers
- test-http-dont-set-default-headers-with-setHost
- test-http-automatic-headers
- test-http-decoded-auth
- test-http-client-request-options (bonus: the test sets `url.headers`
  on a URL object; the `parseRequestArgs` spread carries it through,
  matching Node's `urlToHttpOptions` `...url`)

## Differential (fast runner, 397 files)

- Base `d09b6d08`: 324 pass / 28 timeout / 43 fast / 1x134 / 1x139
  (`http-sweep-ha-base.csv`)
- Branch: 329 pass / 23 timeout / 43 fast / 1x134 / 1x139
  (`http-sweep-ha-branch.csv`)
- Diff: exactly 5 lines, all 124 -> 0, zero pass-to-fail.

## Guards

content-length family, multiple-headers, host-headers,
dont-set-default-headers-with-set-header, client-default-headers-exist,
set-trailers, keep-alive family, raw-headers, agent-keepalive family,
client-with-create-connection, client-keep-alive-hint — all re-run on
the branch (see differential).

## Known follow-ups (not this PR)

- Array-form POST with defaults on: real Node sends
  `Transfer-Encoding: chunked` (headersSent at construction, so the
  empty-body `Content-Length: 0` rule never runs); the shim still sends
  `Content-Length: 0`. No lane target asserts it yet.
- Server `requireHostHeader` 400, `joinDuplicateHeaders`,
  `maxHeadersCount` enforcement, `writeHead` nested-array form +
  setHeader/getHeader error exactness, header-badrequest socket-error
  end behaviour — separate PRs in this lane.
