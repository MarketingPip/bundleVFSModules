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

## Next Steps
1. Fix test-http-agent-false (basic functionality, high impact)
2. Investigate unhandled 'error' event pattern (15 tests, likely common root cause)
3. Triage remaining 349 tests (only sampled 50)
4. Document inherent failures in expected-failures.shim.json
