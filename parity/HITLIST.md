# Parity Hit List — Node builtin shims ranked by official-test pass rate

Generated 2026-10-11 (sweep of `parity/node-test/parallel`, shim lane).
Updated 2026-10-20: http re-swept on main (see the http row): 108/399 → 131/397.
Updated 2026-10-21: http 131/397 → 134/397 — three verified single-test flips (PRs #244, #245, #246), no re-sweep.
Updated 2026-10-28: http 134/397 → 136/397 — two verified single-test flips (PR #250: client-keep-alive-hint, agent-keep-alive-timeout-buffer), no re-sweep.
Updated 2026-10-28: http 136/397 → 138/397 — two verified flips, no re-sweep (PR #252: test-http-server; test-http-server-non-utf8-header, timed out in the Oct 20 sweep and verified passing on post-#250 main f0fc91fd and on merged main 2983fd28).
Updated 2026-10-28: http 150/397 → 154/397 — full re-sweep at main 1d8bc7b4 (PR #254) restates the count at 151 (see below), plus three verified post-base flips (PR #256 options-incoming-message, PR #257 consumed-timeout, PR #259 connection-list-when-close), no re-sweep of the new base.
Updated 2026-10-28: http 154/397 → 159/397 — five verified flips, no re-sweep (PR #258: keep-alive-max-requests-null; PR #263: de-chunked-trailer; PR #264: keepalive-req-gc, the PR #246 regression, fixed; PR #265: unconsume-consume + connect-req-res). (Rebased head: original b0abcffb never triggered CI in 60 min of polling, so this branch was rebased onto main c58a458e to unstick it.)
Updated 2026-10-28: http 159/397 → 170/397 — eleven verified flips, no re-sweep (PR #267: keep-alive-defaults; PR #266: multiple-client-error, destroy-socket-on-client-error, client-error; PR #269: drop-connections-in-cluster; PR #270: delete-parser; PR #268: options-highwatermark; PR #261: multiheaders, multiheaders2, client-headers-host-array, headers-distinct-proto).
Updated 2026-10-12: readline 0/22 → 3/22 after PR #218.
Updated 2026-10-12: readline 3/22 → 22/22 — restored the Node v24.20.0 port
(commit 89b18176 had replaced the 2838-line port with a 642-line hand shim,
dropping 21/22 → 3/22). Root cause of the original swap fixed: the port's
`import { EventEmitter } from './events.js'` pulled `async_hooks.js` →
`als-browser`, which replaces the four timer globals at import time and trips
the harness global-leak check (all 22 failed at process exit). New
self-contained `src/readline/event-emitter.js` (zero imports, zero globals)
is used by `src/readline.js` and `src/readline/promises.js` instead.
Method: each `test-<module>-*` file run via `parity/preload.mjs` with
`PARITY_TARGET=<module>` (30s timeout per file). Pass rates are **raw** —
they do not subtract `parity/expected-failures.shim.json` entries.

> Note (2026-10-14): `parity/run.mjs` now uses exact module matching
> (`test-<mod>.js` or `test-<mod>-*.js`). Previously `startsWith("test-http")`
> also caught `test-http2-*`/`test-https-*` (743 files instead of 399 for http).

## Bottom 10 — biggest parity gaps (port Node's `lib/*.js` here first)

| # | Module | Passed | Total | Rate | Gap type |
|---|--------|--------|-------|------|----------|
| 1 | sea | 0 | 2 | 0.0% | Single-executable-application API — likely inherent (no SEA in browser); verify before investing |
| 2 | sqlite | 0 | 17 | 0.0% | Partial API surface (defensive mode, authz, backup, aggregate fns missing); the wa-sqlite WASM path (AGENTS.md rule 8) is the intended implementation |
| 3 | dgram | 1 | 80 | 1.3% | UDP sockets are honest noops by design (no raw UDP in browser); `socket.address()` returns null — document as inherent, don't chase |
| 4 | https | 20 | 67 | 29.9% | 1/67 -> 20/67: signal handling in ClientRequest, ALPNProtocols/ALPNCallback storage, timer-globals harness. 47 remaining: TLS handshake/session/SNI/keylog/pfx (inherent, no TLS in browser), Agent signal wiring gaps, https virtual-server dispatch gaps, server close/timeout hangs |
| 5 | http2 | 35 | 277 | 12.6% | 7→35 (+28): stream-compat methods (resume/pause/setEncoding/pipe/etc.) on Http2Stream/Request/Response; custom Request/Response classes via createServer options; validation (setLocalWindowSize, statusCode, altsvc); Symbol.asyncDispose; timer-globals harness. Remaining 242: inherent (no real HTTP/2 framing/HPACK/TLS/flow-control/multiplexing in browser) |
| 6 | child_process | 6 | 112 | 5.4% | +2 (4→6): timer-globals harness (parity/child_process-harness.mjs) fixed fork3 + uid-gid; fixed sync throw on missing shell (now async 'error') + pid undefined on failed spawn (was fake pid). 106 inherent: no real process spawning in browser (100 documented in expected-failures.shim.json) |
| 7 | fs | 324 | 349 | 92.8% | +9 (315→324): real shim bug — applyUmask parsed string modes as decimal not octal (mode-mask memfs getResolvedLink crash); real shim bug — makeRealpath double-invoked callback when user callback threw (realpath). Harness: in-place wrapping so test monkey-patches (fs.close/fs.write/t.mock.method fsync) land on the same object streams look up (7 stream/flush tests); symlink/hardlink target sync incl. Buffer targets + mtime preservation (realpath deep symlinks, symlink-buffer-path); syncArgs skips link-target parent creation; preload intercepts common/tmpdir.js so refresh() clears memfs. Housekeeping: removed stale test-fs-negative-zero expected-failure. Remaining 25: documented inherent (sockets, FIFOs, --expose-internals, pipe-large, watch, etc.) |
| 8 | domain | 2 | 50 | 4.0% | Deprecated Node API; low value — deprioritize unless cheap wins |
| 9 | cluster | 4 | 83 | 4.8% | Multi-process clustering is a noop in browser (single worker); mostly inherent |
| 10 | events | 1 | 9 | 11.1% | Misleading: 8 of 9 failures documented as inherent in `expected-failures.shim.json` (harness limitations); effective parity higher |

> readline graduated 2026-10-12: 3/22 → 22/22 (full Node v24.20.0 port restored).

## Full ranking (40/40 swept)

> Updated 2026-10-17: net 0/0 → 72/156 (PR #231) — 156 official tests vendored; previously unswept.

| Module | Passed | Total | Rate |
|--------|--------|-------|------|
| sea | 0 | 2 | 0.0% |
| sqlite | 0 | 17 | 0.0% |
| dgram | 1 | 80 | 1.3% |
| net | 72 | 156 | 46.2% | 1/156 → 72/156: vendored 156 official tests (previously zero); harness — parity/net-harness.mjs restores timer globals replaced by the stream chain on import, wired via preload.mjs (CJS) + hooks.mjs (ESM) for PARITY_TARGET=net; VirtualHandle _handle lifecycle (mockable while connected, null after destroy); keepAlive/noDelay delegation; blockList option on Socket.connect(). Remaining 84: 8 autoselectfamily (real DNS/CLI flags), internal bindings, worker transfer (DataCloneError), agent/socket lifecycle gaps. |
| https | 20 | 67 | 29.9% |
| http2 | 35 | 277 | 12.6% |
| child_process | 6 | 112 | 5.4% |
| fs | 99 | 349 | 28.4% |
| http | 170 | 397 | 42.8% | Full sequential re-sweep 2026-10-20 on main da9859b6 (30s/file, PARITY_TARGET=http; raw CSV: goals/node-parity-sweep hidden_files/http-sweep-2026-10-20.csv; sample re-runs reproduce exactly). 108/399 → 131/397 after PRs #238–#242 (keep-alive/chunked framing, chunk-extensions EOF ownership, agent onSocket delivery + idle reaping, blank-header pipelined validation, pooled-socket timeouts + keepSocketAlive + round-trip listener detach), then 131 → 134 via PRs #244 (keep-alive close-on-header socket release + connect replay), #245 (get-pipeline-problem: writeHead framing + binary-safe coalesced writes), #246 (pipelined leading-empty-line skip in the start-line parser), then 134 → 136 via PR #250 (agent keep-alive timeout-hint machinery: agentKeepAliveTimeoutBuffer storage + Keep-Alive: timeout hint park-time veto), then 136 → 138 via PR #252 (half-closed server drain + ServerResponse.req) and a verified #250 side-effect flip (test-http-server-non-utf8-header, 124 in the Oct 20 sweep, passing on post-#250 main f0fc91fd and on merged main 2983fd28), then 138 → 150 via PR #254 (server headers/request/keep-alive timeout enforcement: 408 + checking-interval loop + upgrade dispatch; 12 flips: 4 headers-timeout, 7 request-timeout, server-keep-alive-timeout; server-consumed-timeout still hangs on a client-side streaming-write gap). Full re-sweep 2026-10-28 on main 1d8bc7b4 (raw CSV: goals/node-parity-sweep hidden_files/http-sweep-2026-10-28.csv) restates the count at 151/397 (115 timeouts, 131 fast failures): vs the recorded 150, two unrecorded flips (test-http-client-timeout 124→0, test-http-keep-alive 1→0, both re-verified exit 0 on merged main 9c8a0c41) and one regression (test-http-server-keepalive-req-gc 0→124, re-verified hanging on merged main 9c8a0c41 — under investigation, counted as failing). Then 151 → 154 via three verified post-base flips (PR #256 options-incoming-message, PR #257 consumed-timeout, PR #259 connection-list-when-close; all re-verified exit 0 on merged main 9c8a0c41). Then 154 → 159 via five verified flips (PR #258 keep-alive-max-requests-null, re-verified exit 0 on merged main 7c4101c0; PR #263 de-chunked-trailer, re-verified exit 0 on merged main 20eed2ac; PR #264 keepalive-req-gc, the PR #246 regression, fixed and re-verified exit 0 on merged main bf0f3db9; PR #265 unconsume-consume + connect-req-res, re-verified exit 0 on merged main c58a458e). Then 159 → 170 via eleven verified flips (PR #267 keep-alive-defaults, re-verified exit 0 on merged main 301e6024; PR #266 multiple-client-error, destroy-socket-on-client-error, client-error, re-verified exit 0 on merged main 94195b72; PR #269 drop-connections-in-cluster, re-verified exit 0 on merged main be6cd380; PR #270 delete-parser, re-verified exit 0 on merged main 4f27f148; PR #268 options-highwatermark, re-verified exit 0 on merged main 33890db2; PR #261 multiheaders, multiheaders2, client-headers-host-array, headers-distinct-proto, re-verified exit 0 on merged main b6329529). Remaining 227: 100 timeouts (clusters: server-* 2, client-* 15) and 127 fast failures (client-* 30, server-* 12, agent-* 12, outgoing-* 11, upgrade-* 6). NONE of them are documented in expected-failures.shim.json — all are unclassified gaps, not documented-inherent. |
| domain | 2 | 50 | 4.0% |
| cluster | 4 | 83 | 4.8% |
| events | 1 | 9 | 11.1% |
| tls | 29 | 220 | 13.2% |
| stream | 237 | 237 | 100% | +195 (42→237): harness-only fix — parity/stream-harness.mjs restores timer globals (setImmediate/setInterval/setTimeout/queueMicrotask) replaced by async_hooks chain on import, tripping Node's global-leak detector. Wired via preload.mjs (CJS) + hooks.mjs (ESM). src/stream.js (full Node v24.20.0 lib/stream.js port) was already complete. |
| async_hooks | 29 | 36 | 80.6% | +20 (9→29): harness-only fix — parity/async-hooks-harness.mjs restores timer globals (setImmediate/setInterval/setTimeout/queueMicrotask) replaced by als-browser on import, tripping Node's global-leak detector. Wired via preload.mjs (CJS) + hooks.mjs (ESM), mirroring stream-harness.mjs. src/async_hooks.js untouched (delegates to native under Node by design). Remaining 7: documented inherent — als-browser's module-eval side effects shift async IDs, breaking tests that assert specific IDs (0!==1, 14!==15); lazy import would need TLA which breaks CJS require(). |
| dns | 10 | 31 | 32.3% | +1 (9→10): fixed lookupService validation order (explicit undefined → ERR_SOCKET_BAD_PORT, not ERR_MISSING_ARGS) in src/dns.js + src/dns/promises.js; fixed dns/promises reference equality in parity/preload.mjs. DoH-based shim (dns-packet + fetch). Remaining 21 documented inherent: UDP-transport tests (cancel/multi-channel hang), resolveAny ENOTIMP (intentional, mirrors Node), DoH vs getaddrinfo ordering differences, _handle internals, perf_hooks gap |
| inspector | 29 | 74 | 39.2% | All 45 failures documented as inherent: no V8 inspector backend in browser (honest noop stub by design). Breakdown: 9 inspector-url (url() returns undefined), 15 protocol-session (Session.post noop), 3 heap/cpu-profile, 7 connection-hang (no WS backend), 11 V8-internals. 29 passing are API shape/validation + subprocess-based tests. |
| vm | 48 | 97 | 49.5% | +7 (41→48): real shim bugs fixed — validateSandbox() allows arrays in createContext; isContext() consults contextified WeakSet for arrays; synthesizeCachedData() returns Buffer when available; scope proxy set trap throws Node-style TypeError in strict mode (sloppy swallows via sentinel); Script extracts //# sourceMappingURL= magic comment. 41 inherent documented (24 ESM vm.Module, 4 script timeout, 3 measureMemory, 10 V8-isolate semantics). |
| zlib | 33 | 65 | 50.8% | +2 (31→33): real shim bugs fixed — toBytes() throws ERR_OUT_OF_RANGE (not bare RangeError) for spoofed ArrayBufferView lengths; ERR_STREAM_DESTROYED with Node's message on write-after-destroy; makeZlibClass Factory supports old-style DeflateRaw.call(this) inheritance. 16 inherent documented (15 Brotli/Zstd honest stubs + 1 missing fixture). 16 need deeper investigation (stream lifecycle, data integrity, validation). |
| tty | 5 | 5 | 100% | +2 (3→5): harness fix — parity/tty-harness.mjs restores timer globals replaced by the stream chain (async_hooks → events → stream → tty) on import, which tripped Node's global-leak detector. Mirrors stream-harness.mjs / async-hooks-harness.mjs. No src/ changes. |
| repl | 78 | 102 | 76.5% | +7 (71→78): harness fix — parity/hooks.mjs resolves relative imports from src/ shims (./readline → src/readline.js), fixing ERR_UNSUPPORTED_DIR_IMPORT that blocked all ESM repl tests. Product fixes in src/repl.js: _domain property (minimal EventEmitter-compatible, tests access testMe._domain.on), inputStream/outputStream deprecated getters, complete() basic tab-completion from context, REPLServer callable without new. 24 remaining: 4 tab-completion edge cases, require/context integration, history persistence, colors/pretty-stack formatting — deep behavioral gaps needing investigation. |
| util | 28 | 31 | 90.3% | +3 (25→28): fetched 2 missing fixtures (uncaught-exceptions/callbackify1-2.js, dotenv/valid.env); preload harness fix for util/types reference equality (require('util/types') === require('util').types, mirrors dns/timers/promises pattern). 3 inherent: 2 getcallsites tests need real child_process.spawnSync (unavailable in harness shim lane); inspect deep-recursion cutoff is 499 vs 500+ (V8 stack-size dependent, shim correctly interrupts with proper message). |
| perf_hooks | 13 | 15 | 86.7% | +1 (timerify alias): preload installs shim's timerify/eventLoopUtilization on globalThis.performance for reference equality (mirrors console fix). 2 inherent: histogram MessageChannel cloning needs native shared memory; eventLoopUtilization idle>0 spin needs libuv counters (pure-JS returns idle:0 always). |
| os | 7 | 7 | 100% | getPriority/setPriority round-trip via stored values (SystemError for negative pids); uptime() floored min 1; userInfo shell "" |
| process | 81 | 97 | 83.5% | 16 inherent documented: 6 fixture gaps (versions, dlopen, env-allowed-flags, load-env-file, redirect-warnings x2), 2 permission-model (--permission flags), 2 getactiveresources harness handle counts, 1 uncaught-exception-monitor (fails natively), 1 warnings.mjs CLI flags, 2 reference-equality (default, get-builtin: shim separate from Node global under harness), 1 external-stdio-close (child_process noop), 1 finalization (V8 internals). |
| module | 29 | 32 | 90.6% | +1 (28→29): HITLIST was stale. 3 inherent documented: createRequire non-file URL bases = deliberate browser divergence (Vite import.meta.url; repo tests verify), --import harness artifact (module.parent undefined), stripTypeScriptTypes deliberate noop (no amaro). |
| trace_events | 28 | 29 | 96.6% | +2 (26→28): HITLIST was stale; actual shim-lane is 28/29. The 1 failure (get-category-enabled-buffer) is inherent: test uses --expose-internals + internalBinding('trace_events').getCategoryEnabledBuffer(), a Node C++ internal API the shim explicitly documents as unavailable. Documented in expected-failures.shim.json. |
| worker_threads | 134 | 141 | 95.0% | Shim delegates to native via process.getBuiltinModule under Node; browser impl uses Web Workers. 7 failures documented in expected-failures.shim.json, all harness limitations (not shim bugs): 3 thread-ID offset from preload register() consuming ID 1 (event, messaging, name), 3 inspector/v8 debugging APIs (debug, exit-heapsnapshot, message-port-inspect), 1 timer-globals leak detector artifact dependent on parent process type (process-env). |
| console | 22 | 22 | 100% | +2 (20→22): real shim bugs fixed — dirxml/groupCollapsed are now separate named functions (not aliases), matching Node where they are distinct function objects; formatTime port corrected (Node never outputs µs, uses e.g. `0.006ms`). Harness: preload.mjs sets globalThis.console to the shim when require('console') is called (require('console') === globalThis.console reference equality). |
| buffer | 62 | 62 | 100% |
| timers | 45 | 45 | 100% |
| crypto | 129 | 129 | 100% |
| assert | 18 | 18 | 100% |
| diagnostics_channel | 26 | 26 | 100% |
| path | 16 | 16 | 100% |
| querystring | 3 | 3 | 100% |
| readline | 22 | 22 | 100% |
| string_decoder | 2 | 2 | 100% |
| url | 16 | 16 | 100% |
| v8 | 22 | 22 | 100% |
| wasi | 2 | 2 | 100% |

## Not swept

- **http** (399 test files, exact match): Hang diagnosed 2026-10-14. NOT a single
  deadlock — it's death by a thousand timeouts. ~30% of http tests (abort,
  destroyed-socket, keep-alive, agent lifecycle) hang the full 30s spawn timeout
  because the shim leaks socket handles in abort/destroy scenarios (event loop
  never drains). 399 files × 30% × 30s ≈ 60 min. Root cause: product bug in
  src/http.js / src/net.js socket lifecycle, not harness. Also fixed: run.mjs
  was matching 743 files (http+http2+https) via startsWith — now exact.
- **constants, punycode, sys**: zero official test files — "no official tests".
- Internal shims with no test target (`_http_*`, `_stream_*`, `_tls_*`, `node_globals`, `fetch-patch`, `browser-builds`, etc.): not applicable.

## Notes for prioritization

- **events 1/9 is misleading**: 8 of the 9 failures are documented in `expected-failures.shim.json` as inherent (harness limitations). Effective parity is higher than raw rate suggests.
- **buffer 60/62**: the 2 failures are the documented expected failures — effectively at parity.
- **Fixable-first candidates** (real gaps, browser-achievable): `fs`, `stream`, `async_hooks`, `dns`, `zlib`, `vm`, `tls`, `http2`.
- **Inherent / deprioritize**: `dgram` (no UDP in browser), `https` (no byte transport), `child_process`/`cluster` (no real processes), `domain` (deprecated), `sea` (likely N/A).
- `sqlite` should go the WASM-of-the-real-thing route (wa-sqlite), not hand-rolled.
