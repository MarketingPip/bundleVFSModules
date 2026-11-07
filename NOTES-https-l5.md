# NOTES-https-l5 — https agent socket release/free (wave 3 L5)

Targets (2 flips, 0 regressions — full 67-file https sweep, base
`4f98f142` 38/6/23 → branch 40/5/22; changed lines exactly the two
targets):
- `test-https-agent-sockets-leak.js`: 1 → 0
- `test-https-agent-additional-options.js`: 124 → 0

## Fix 1 — TLS fields thread into `_agentOptions` (src/http.js, ClientRequest ctor)

Root cause: Node passes the FULL request options to `agent.addRequest`
(`lib/_http_client.js:575`), and https `Agent.getName` reads the TLS
fields from them (`lib/https.js:515-594`). The shim's `_agentOptions`
carried only host/port + lookup/socketPath/localAddress/localPort/
family/highWaterMark, so every https request pooled under a TLS-empty
name (`localhost:PORT:::::::::::::::::::::`). Consequences, both
probed under the shim:
- the freeSockets key never contained the option values, so
  additional-options' per-variation assert (`:<value>:` in the key)
  failed at the `dhparam` variation (and the failure was swallowed
  somewhere in the release path — the test hung at 124 instead of
  exiting 1);
- requests with different TLS options wrongly shared one pool (the
  dhparam variation reused the first request's pooled socket).

Fix: copy the 21 fields `HttpsAgentBase.getName` reads
(ca/cert/clientCertEngine/ciphers/key/pfx/passphrase/
rejectUnauthorized/servername/minVersion/maxVersion/secureProtocol/
crl/honorCipherOrder/ecdhCurve/dhparam/secureOptions/sessionIdContext/
sigalgs/privateKeyIdentifier/privateKeyEngine) from the request
options into `_agentOptions` when defined. The http base name ignores
them, and `createSocket` builds its own curated connect options, so
nothing leaks into `net.connect`. The per-request checkServerIdentity
symbol is not threaded — nothing sets it on request options yet
(L8 note), and `getName` only reads it if present.

## Fix 2 — non-keep-alive agent: no early request destroy at response completion (src/http.js, streamed completion branch)

Root cause: the streamed completion branch destroyed the request at
response completion (`Writable.prototype.destroy` schedules `close`
on nextTick), so req `close` fired BEFORE res `end` and before the
socket left the agent pool. Real Node does not destroy the request
at completion for a non-keep-alive agent (`responseOnEnd` only
`destroySoon()`s the socket); req becomes destroyed at socket close,
AFTER the agent's `onClose` removed the socket — probed on real Node
v24.22.1: `agent.sockets` 1 at res `end`, 0 at req `close`, socket
destroyed. The test asserts the pool is empty at req `close`.

Fix: skip the early destroy when the request has a non-keep-alive
agent. `_releaseAgentSocket` (via `_releaseAfterEnd`) still destroys
the request after `end`, which emits `close` once the socket has left
the pool (`releaseSocket` removes it synchronously before the
nextTick `close`). Keep-alive and agent-less requests keep the
current shape: `test-http-keepalive-free` asserts `req.destroyed` at
`end`, and the socket must stay tracked through `end`
(`test-http-keep-alive-close-on-header` asserts `sockets[name] === 1`
inside `end` — its agent is non-keep-alive, so the socket must NOT
leave the pool at completion, only `close` must move after the
release).

## Guards (all 0)

http: keepalive-free, keep-alive-close-on-header,
agent-destroyed-socket, agent-keepalive, agent-free-socket-data-guard,
client-close-event, client-agent-end-close-event, req-res-close,
connect-req-res, client-override-global-agent, agent-getname,
client-highwatermark, agent-maxtotalsockets,
agent-maxsockets-respected. https: agent-getname, hwm, pfx,
connecting-to-http. (`test-http-agent-sockets-leak.js` does not
exist; `test-https-agent-session-reuse` is 1 on base too — L6's
target, not this lane.)
