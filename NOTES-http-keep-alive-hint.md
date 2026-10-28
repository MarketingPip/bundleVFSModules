# NOTES: agent keep-alive timeout hint (`agentKeepAliveTimeoutBuffer`)

## What was missing

Two vendored Node tests failed on main, both in the agent's keep-alive
timeout-hint machinery (Node v22.20+/v24.7+):

- `test-http-client-keep-alive-hint` (exit 1): the server answers with
  `Connection: keep-alive` + `Keep-Alive: timeout=1`, and the client
  agent must retire the pooled socket before the test's 3s guard timer
  fires. Our agent never read the hint, so the socket sat pooled and
  the guard timer fired (`mustNotCall`).
- `test-http-agent-keep-alive-timeout-buffer` (exit 1): `new
  http.Agent({ agentKeepAliveTimeoutBuffer: 1500 })` must expose the
  property; ours was `undefined` (the option was never stored).

## What real Node actually does (probed, not assumed)

Probes ran against real Node v24.22.1 via `zz-probe-keepalive.js`
(no preload, deleted after use). Findings:

1. **Property coercion.** Default 1000. Only a finite number `>= 0`
   passes through (0, -0 and 500.5 kept). Negative, `Infinity`, `NaN`,
   strings, `null` and booleans all fall back to 1000.
2. **Hint enforcement is park-time veto only.** When a response
   carries `Keep-Alive: timeout=N`, the agent pools the socket unless
   `N*1000 <= agentKeepAliveTimeoutBuffer`, in which case it destroys
   it at once (stack trace: `Socket.onFree` → agent `free` listener →
   `keepSocketAlive` returning false → `destroy`). There is NO timer
   and NO reuse-time check: a `timeout=3`/`buffer=1500` socket stayed
   pooled past 1500ms, was not closed at 10s with a 60s server
   timeout, and was reused by a second request after 2000ms.
   (The docs' "closes slightly before the server does" is realized
   only through the veto case; the server's own timeout does the rest.)
3. **The veto lives in `keepSocketAlive`.** A subclass override
   replaces it wholesale (the block-4 custom agent in
   `test-http-agent-timeout` calls `super.keepSocketAlive`, so it
   inherits the veto — its server sends no `Keep-Alive` header, so
   it is unaffected).

## The fix (`src/http.js` only)

- `AgentBase` constructor stores `agentKeepAliveTimeoutBuffer` with
  the probed coercion (covers `http.Agent`, `https.Agent` via
  inheritance, and `globalAgent`).
- New `parseKeepAliveTimeoutHint(headers)` helper: `/timeout\s*=\s*(\d+)/i`
  over the lowercased `keep-alive` header value (handles
  `timeout=5, max=3`).
- `_performVirtualRequest` stashes the parsed hint on the socket
  (`socket._serverKeepAliveTimeout`, null when absent) at response
  time, in both the streamed and non-streamed paths, before the
  release — including before the deferred non-keep-alive release, so
  the value is fixed at response time. Stashing null clears any stale
  hint from an earlier response on a reused socket.
- `AgentBase.keepSocketAlive` returns false when
  `hint*1000 <= agentKeepAliveTimeoutBuffer`; `releaseSocket`
  already destroys on a false return, so no other plumbing changed.
- `reuseSocket` clears the hint at checkout; the next response
  re-stashes from its own headers.

## Verification

- Both target tests: exit 0 (were exit 1 on main).
- Guards (all exit 0 on the branch): agent-error-on-idle,
  agent-getname, agent-maxsockets, agent-no-protocol, agent-null,
  agent-timeout, agent-uninitialized, client-keep-alive-release-before-
  finish, keep-alive-timeout-buffer/-custom/-race-condition,
  keep-alive, keepalive-override, chunked, chunked-smuggling,
  outgoing-finished, outgoing-message-write-callback,
  outgoing-write-types, blank-header,
  incoming-pipelined-socket-destroy, get-pipeline-problem,
  keep-alive-close-on-header.
- Differential (scratch worktree of pristine main, same commands):
  agent-reuse-drained-socket-only 124, agent-keepalive 1,
  agent-timeout-option 1, keep-alive-timeout 124 — identical on main,
  so pre-existing, not regressions. (None of them send a veto-sized
  hint: reuse-drained sends `Connection: Keep-Alive` with no
  `Keep-Alive:` header; max-requests/custom send `timeout=5`/`50`.)
- Repo suites: http, http-socket, http-close-server, https, net —
  187/187 pass. Full suite run logged separately.

## Scope notes

- The hint path covers the virtual-server client path only
  (`_performVirtualRequest`). The server-side emulated-inbound path
  (`__serverRequest__`) does not use the agent pool and is untouched.
- `timeout=0.5`-style fractional hints parse as integers (the
  documented form is integer seconds); untested either way.
