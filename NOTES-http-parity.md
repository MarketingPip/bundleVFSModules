# HTTP Module Parity — Working Notes

**Start:** 2026-10-14 ~21:00 EDT
**Branch:** feat/http-parity
**Baseline:** http was never scored (hang). http2 7/277, https 1/67 (raw, pre-fix measurements).

## Context from diagnosis (NOTES-http-diagnosis.md)

- ~30% of http tests hit the 30s spawnSync timeout — not an infinite hang.
- Root cause: `src/http.js` / `src/net.js` leak socket handles in abort/destroy scenarios.
- Leaked sockets keep the event loop alive → process never exits → 30s timeout kill.
- 399 files × 30% × 30s ≈ 60 min at ~0% CPU.
- `parity/run.mjs` now uses exact matching (commit ccb1b2e3).

## Plan

1. [x] Claim lane in LOCKS.md, create branch feat/http-parity
2. [ ] Read src/http.js + src/net.js — understand socket lifecycle
3. [ ] Write a minimal repro: create server, abort request, destroy socket, check process exits
4. [ ] Fix the leak: ensure abort/destroy/close paths actually release socket handles
5. [ ] Re-run the 4 known-hanging tests to verify they exit quickly now
6. [ ] Run full http suite (399 files) → baseline score
7. [ ] Batch-fix real failures, document inherent ones
8. [ ] Update HITLIST.md, roadmap.md, tracking
9. [ ] Open PR, get review, merge when green

## Investigation log

### src/http.js overview (2924 lines)

(TODO: read and map the socket lifecycle)

### src/net.js overview (2031 lines)

(TODO: read and map the socket lifecycle)

## Investigation log

### Socket leak root cause — CONFIRMED

**Repro:** `test-http-abort-client.js` hangs (30s timeout).

**Two bugs found:**

1. **ClientRequest.destroy() didn't destroy the socket** (FIXED):
   - In `_performVirtualRequest`, `sock = netConnect(port)` creates a real net.js socket
   - `destroy()` set `_aborted=true` but never called `sock.destroy()`
   - The `_socketHttpRoundTrip` promise never settles → socket's `_loopTimer` keeps event loop alive
   - Fix: destroy `this.socket` in `ClientRequest.destroy()`

2. **ServerResponse._destroy didn't destroy the socket** (FIXED):
   - `serverRes.destroy()` marked response destroyed but left socket open
   - Client never sees the reset
   - Fix: override `_destroy` in ServerResponse to destroy `this.socket`

**But tests STILL hang.** Deeper issue found:

3. **No streaming — responses are fully buffered** (NOT YET FIXED):
   - `ServerResponse.writeHead()` + `write()` buffer everything; socket write only happens in `_finishSocketResponse` on 'finish' (i.e., `res.end()`)
   - Client `_socketHttpRoundTrip` only resolves on `parser.onMessageComplete` (full body)
   - Client never emits 'response' until the ENTIRE response is received
   - Tests like `test-http-abort-client.js` need the client to get the response BEFORE `serverRes.destroy()` is called — impossible with buffering

**Required:** True streaming for the virtual server path:
- Server: flush headers on `writeHead()`, flush chunks on `write()`
- Client: emit 'response' on `parser.onHeadersComplete`, stream body via `parser.onBody`

This is a significant architectural change to `src/http.js`.

