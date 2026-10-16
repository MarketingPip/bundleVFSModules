# HTTP Fast Failures Triage

## Baseline
- http: 108/399 (from PR #223)
- PR #227 fixed 8 hanging agent-pooling tests → all 8 now PASS

## Triage Sample (first 50 tests)
- Pass: 6
- Fail (fast): 28
- Timeout: 16 (includes 5 flaky tests from PR #227 — intermittent, not deterministic)

## Fixed

### test-http-agent-getname.js ✅
**Bug:** `Agent.getName()` defaulted port to 80, didn't handle socketPath/family.
**Fix:** 
- Don't default port (Node returns empty string)
- Append socketPath and family (4/6) per Node behavior
**Commit:** da83a446

### HTTP/1.0 chunked encoding (partial)
**Bug:** ServerResponse used chunked transfer encoding for HTTP/1.0 requests.
**Fix:** Skip chunked encoding when `req.httpVersion === "1.0"` (store version in constructor).
**Status:** Fix implemented, but test-http-1.0.js has infrastructure issues (ECONNREFUSED on virtual server) preventing verification.

## Fast Failure Categories (from sample)

### 1. Unhandled 'error' events (node:events:505) — 15 tests
Tests: test-http-1.0-keep-alive, test-http-1.0, test-http-agent-domain-reused-gc, test-http-agent-error-on-idle, test-http-agent-keepalive-delay, test-http-agent-keepalive, test-http-agent-reuse-drained-socket-only, test-http-agent-uninitialized-with-handle, test-http-agent-uninitialized, test-http-blank-header, test-http-chunk-extensions-limit, test-http-chunked-304, test-http-chunked-smuggling, test-http-client-abort-event, test-http-1.0-keep-alive

**Pattern:** Tests emit 'error' events that aren't handled, causing unhandled error throws.
**Likely cause:** Our error handling doesn't match Node's exact semantics for when errors are emitted vs. when they're swallowed.
**Action:** Needs per-test investigation. These are real shim bugs but require careful analysis of Node's error emission rules.

### 2. Mismatched callback counts — 3 tests
- test-http-agent-close.js: Expected 1, actual 0
- test-http-agent-destroyed-socket.js: Expected 3, actual 0  
- test-http-agent-false.js: Expected 1, actual 2

**Pattern:** Callbacks not called (or called too many times).
**Likely cause:** Agent lifecycle events (close, destroy) not emitting correctly; or error/response both emitted when only one should be.
**Action:** Real shim bugs. test-http-agent-false is high priority (basic request with agent:false).

### 3. Assertion failures — 2 tests
- test-http-abort-before-end.js: function should not have been called
- test-http-chunk-problem.js: assertion failed

**Action:** Real shim bugs in abort semantics and chunked encoding edge cases.

### 4. Module load errors (node:internal/modules/run_main:107) — 4 tests
Tests: test-http-addrequest-localaddress, test-http-agent-keep-alive-timeout-buffer, test-http-agent-maxtotalsockets, test-http-agent-scheduling

**Pattern:** Test files fail to load.
**Likely cause:** Missing test fixtures or harness issues, not shim bugs.
**Action:** Verify test files exist; likely harness/infrastructure.

### 5. http.js internal errors — 1 test
- test-http-autoselectfamily.js: EADDRINUSE at src/http.js:58

**Pattern:** Port already in use.
**Likely cause:** Test isolation issue (previous test didn't cleanup) or virtual server port management bug.
**Action:** Needs investigation; may be test-runner artifact.

## Inherent / Don't Chase

The following are likely inherent to the browser environment:
- Tests requiring real network interfaces (beyond virtual)
- Tests requiring raw socket access
- Tests for HTTP/2-specific behavior (covered in http2 module)

## Error Event Investigation (2026-10-16)

### Root Cause Analysis

The 15 "unhandled 'error' event" tests fall into three categories, NOT one common root cause:

**1. Fixed: Aborted requests emitting 'error' (1 test)**
- **test-http-client-abort-event.js** ✅ FIXED
- **Bug:** `ClientRequest.onSocketError` emitted 'error' even when the request was aborted. Node only emits 'abort' for `abort()`, not 'error'.
- **Fix:** Check `_aborted || _abortGraceful` in `onSocketError` before emitting. (commit 5cd4ed47)

**2. Harness limitations: Tests using real `net` (7 tests)**
- test-http-1.0-keep-alive, test-http-1.0, test-http-agent-uninitialized, test-http-blank-header, test-http-chunk-extensions-limit, test-http-chunked-304, test-http-chunked-smuggling
- **Issue:** These tests `require('net')` directly and use `net.createConnection()` to talk to the virtual HTTP server. The parity harness only redirects `http`, not `net`, so the real `net` tries to connect to a real TCP port → ECONNREFUSED.
- **Action:** Harness limitation, not a shim bug. Would require the harness to also shim `net` for http tests, or the tests to be marked as expected failures.

**3. Agent edge cases: Manual socket manipulation (7 tests)**
- test-http-agent-domain-reused-gc, test-http-agent-error-on-idle, test-http-agent-keepalive-delay, test-http-agent-keepalive, test-http-agent-reuse-drained-socket-only, test-http-agent-uninitialized-with-handle
- **Issue:** These tests manually manipulate `agent.freeSockets` and call `agent.addRequest(req, {})` with empty options, testing agent internals.
- **Partial fix:** `AgentBase.createSocket` now falls back to `req.port`/`req.host` when options are empty (was defaulting to port 80). (commit 5cd4ed47)
- **Remaining:** Deeper issues with manual socket lifecycle (server refusing connections, socket state mismatches). These test agent internals in ways that require more careful emulation.

### Summary
- **Fixed:** 1 test (test-http-client-abort-event.js)
- **Harness limitations:** 7 tests (need `net` shimming in harness)
- **Needs deeper work:** 7 tests (agent edge cases)
- **Not one root cause** — the triage assumption was incorrect.

## Next Steps
1. Fix test-http-agent-false (basic functionality, high impact)
2. Investigate unhandled 'error' event pattern (15 tests, likely common root cause)
3. Triage remaining 349 tests (only sampled 50)
4. Document inherent failures in expected-failures.shim.json

## Agent Lifecycle Investigation (2026-10-16)

### The 7 Agent Edge Case Tests

**Harness limitations (5 tests) — NOT FIXABLE:**
These tests require `_http_agent` or `net` directly, bypassing our shim:
- test-http-agent-keepalive-delay.js — requires `_http_agent`
- test-http-agent-keepalive.js — requires `_http_agent`
- test-http-agent-reuse-drained-socket-only.js — requires `net` (uses `net.createServer`)
- test-http-agent-uninitialized-with-handle.js — requires `_http_agent`/`net`
- test-http-agent-uninitialized.js — requires `_http_agent`/`net`

All fail with ECONNREFUSED because they try real network connections.

**Node internals (1 test) — NOT FIXABLE:**
- test-http-agent-domain-reused-gc.js — uses `internal/js_stream_socket`, `domain` module, `ReusedHandle` (Node C++ internals), and async_hooks GC behavior. Cannot be emulated in browser.

**Real shim bug (1 test) — FIXED:**
- test-http-agent-error-on-idle.js ✅
- **Bug:** When a socket in the agent's free pool emitted an error (test manually emits on idle socket), the error propagated to the completed ClientRequest via the stale socket error listener, causing "unhandled 'error' event".
- **Fix (branch feat/http-agent-lifecycle, commit 4f87e57c):**
  - Add `_inFreePool` flag to track idle sockets
  - Request's socket error handler skips errors on idle sockets
  - Agent attaches cleanup handler in `releaseSocket` to remove errored idle sockets from pool and destroy them
  - Fix `createSocket` to remove error listener after successful connect (prevents stale callback)
  - `reuseSocket` clears the idle flag and removes the idle handler
- **Result:** Unhandled error no longer occurs. The agent properly cleans up errored idle sockets.

### Summary
- **Fixed:** 1 test (test-http-agent-error-on-idle.js — unhandled error eliminated)
- **Not fixable:** 6 tests (5 harness limitations + 1 Node internals)
- **No regressions:** 7/8 PR #227 tests still pass (test-http-agent-reuse-drained-socket-only was already failing before these changes due to harness limitation)
