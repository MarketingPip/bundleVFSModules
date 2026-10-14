# Parity Hit List — Node builtin shims ranked by official-test pass rate

Generated 2026-10-11 (sweep of `parity/node-test/parallel`, shim lane).
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

> Note: the stock `parity/run.mjs` matches files with `startsWith("test-http")`,
> which also catches `test-http2-*`/`test-https-*` (those then run against real
> Node — false passes). This sweep used exact prefix matching instead.

## Bottom 10 — biggest parity gaps (port Node's `lib/*.js` here first)

| # | Module | Passed | Total | Rate | Gap type |
|---|--------|--------|-------|------|----------|
| 1 | sea | 0 | 2 | 0.0% | Single-executable-application API — likely inherent (no SEA in browser); verify before investing |
| 2 | sqlite | 0 | 17 | 0.0% | Partial API surface (defensive mode, authz, backup, aggregate fns missing); the wa-sqlite WASM path (AGENTS.md rule 8) is the intended implementation |
| 3 | dgram | 1 | 80 | 1.3% | UDP sockets are honest noops by design (no raw UDP in browser); `socket.address()` returns null — document as inherent, don't chase |
| 4 | https | 1 | 67 | 1.5% | TLS-over-virtual-socket stack incomplete; real TLS client has no byte transport in browser (roadmap 2026-10-05 verdict: honest stub until transport exists) — mostly inherent |
| 5 | http2 | 7 | 277 | 2.5% | HTTP/2 framing/session multiplexing largely unimplemented; large surface (277 tests) |
| 6 | child_process | 4 | 112 | 3.6% | Real process spawning is a noop by design; 100 failures already documented in `expected-failures.shim.json` as inherent (harness global-leak detector vs ALS timer patching) |
| 7 | fs | 324 | 349 | 92.8% | +9 (315→324): real shim bug — applyUmask parsed string modes as decimal not octal (mode-mask memfs getResolvedLink crash); real shim bug — makeRealpath double-invoked callback when user callback threw (realpath). Harness: in-place wrapping so test monkey-patches (fs.close/fs.write/t.mock.method fsync) land on the same object streams look up (7 stream/flush tests); symlink/hardlink target sync incl. Buffer targets + mtime preservation (realpath deep symlinks, symlink-buffer-path); syncArgs skips link-target parent creation; preload intercepts common/tmpdir.js so refresh() clears memfs. Housekeeping: removed stale test-fs-negative-zero expected-failure. Remaining 25: documented inherent (sockets, FIFOs, --expose-internals, pipe-large, watch, etc.) |
| 8 | domain | 2 | 50 | 4.0% | Deprecated Node API; low value — deprioritize unless cheap wins |
| 9 | cluster | 4 | 83 | 4.8% | Multi-process clustering is a noop in browser (single worker); mostly inherent |
| 10 | events | 1 | 9 | 11.1% | Misleading: 8 of 9 failures documented as inherent in `expected-failures.shim.json` (harness limitations); effective parity higher |

> readline graduated 2026-10-12: 3/22 → 22/22 (full Node v24.20.0 port restored).

## Full ranking (39/40 swept)

| Module | Passed | Total | Rate |
|--------|--------|-------|------|
| sea | 0 | 2 | 0.0% |
| sqlite | 0 | 17 | 0.0% |
| dgram | 1 | 80 | 1.3% |
| https | 1 | 67 | 1.5% |
| http2 | 7 | 277 | 2.5% |
| child_process | 4 | 112 | 3.6% |
| fs | 99 | 349 | 28.4% |
| domain | 2 | 50 | 4.0% |
| cluster | 4 | 83 | 4.8% |
| events | 1 | 9 | 11.1% |
| tls | 29 | 220 | 13.2% |
| stream | 237 | 237 | 100% | +195 (42→237): harness-only fix — parity/stream-harness.mjs restores timer globals (setImmediate/setInterval/setTimeout/queueMicrotask) replaced by async_hooks chain on import, tripping Node's global-leak detector. Wired via preload.mjs (CJS) + hooks.mjs (ESM). src/stream.js (full Node v24.20.0 lib/stream.js port) was already complete. |
| async_hooks | 29 | 36 | 80.6% | +20 (9→29): harness-only fix — parity/async-hooks-harness.mjs restores timer globals (setImmediate/setInterval/setTimeout/queueMicrotask) replaced by als-browser on import, tripping Node's global-leak detector. Wired via preload.mjs (CJS) + hooks.mjs (ESM), mirroring stream-harness.mjs. src/async_hooks.js untouched (delegates to native under Node by design). Remaining 7: documented inherent — als-browser's module-eval side effects shift async IDs, breaking tests that assert specific IDs (0!==1, 14!==15); lazy import would need TLA which breaks CJS require(). |
| dns | 10 | 31 | 32.3% | +1 (9→10): fixed lookupService validation order (explicit undefined → ERR_SOCKET_BAD_PORT, not ERR_MISSING_ARGS) in src/dns.js + src/dns/promises.js; fixed dns/promises reference equality in parity/preload.mjs. DoH-based shim (dns-packet + fetch). Remaining 21 documented inherent: UDP-transport tests (cancel/multi-channel hang), resolveAny ENOTIMP (intentional, mirrors Node), DoH vs getaddrinfo ordering differences, _handle internals, perf_hooks gap |
| inspector | 29 | 74 | 39.2% |
| vm | 48 | 97 | 49.5% | +7 (41→48): real shim bugs fixed — validateSandbox() allows arrays in createContext; isContext() consults contextified WeakSet for arrays; synthesizeCachedData() returns Buffer when available; scope proxy set trap throws Node-style TypeError in strict mode (sloppy swallows via sentinel); Script extracts //# sourceMappingURL= magic comment. 41 inherent documented (24 ESM vm.Module, 4 script timeout, 3 measureMemory, 10 V8-isolate semantics). |
| zlib | 33 | 65 | 50.8% | +2 (31→33): real shim bugs fixed — toBytes() throws ERR_OUT_OF_RANGE (not bare RangeError) for spoofed ArrayBufferView lengths; ERR_STREAM_DESTROYED with Node's message on write-after-destroy; makeZlibClass Factory supports old-style DeflateRaw.call(this) inheritance. 16 inherent documented (15 Brotli/Zstd honest stubs + 1 missing fixture). 16 need deeper investigation (stream lifecycle, data integrity, validation). |
| tty | 3 | 5 | 60.0% |
| repl | 71 | 101 | 70.3% |
| util | 23 | 30 | 76.7% |
| perf_hooks | 12 | 15 | 80.0% |
| os | 5 | 6 | 83.3% |
| process | 81 | 97 | 83.5% |
| module | 28 | 32 | 87.5% |
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

- **http** (398 test files): sweep hung past 35 min at 0% CPU — noted per task instructions, needs investigation separately (likely a test that deadlocks the runner rather than hitting the 30s spawn timeout).
- **constants, punycode, sys**: zero official test files — "no official tests".
- Internal shims with no test target (`_http_*`, `_stream_*`, `_tls_*`, `node_globals`, `fetch-patch`, `browser-builds`, etc.): not applicable.

## Notes for prioritization

- **events 1/9 is misleading**: 8 of the 9 failures are documented in `expected-failures.shim.json` as inherent (harness limitations). Effective parity is higher than raw rate suggests.
- **buffer 60/62**: the 2 failures are the documented expected failures — effectively at parity.
- **Fixable-first candidates** (real gaps, browser-achievable): `fs`, `stream`, `async_hooks`, `dns`, `zlib`, `vm`, `tls`, `http2`.
- **Inherent / deprioritize**: `dgram` (no UDP in browser), `https` (no byte transport), `child_process`/`cluster` (no real processes), `domain` (deprecated), `sea` (likely N/A).
- `sqlite` should go the WASM-of-the-real-thing route (wa-sqlite), not hand-rolled.
