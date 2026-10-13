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
| 7 | fs | 130 | 349 | 37.2% | Largest test surface (349); harness-level tmpdir/fixtures sync fixed 227 ENOENT. Since 99: mkdir string modes, chown -1, fchmod/fd validation, umask on file creation, cp dereference:false, common/fs.js shim redirect (fixes 19 cp tests using assertDirEquivalent), fstat validation, throwIfNoEntry, Stats date accessors. Fresh full run in progress. Remaining: abort-signal cluster, stream edges, FileHandle events |
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
| fs | 130 | 349 | 37.2% |
| domain | 2 | 50 | 4.0% |
| cluster | 4 | 83 | 4.8% |
| events | 1 | 9 | 11.1% |
| tls | 29 | 220 | 13.2% |
| stream | 42 | 236 | 17.8% |
| async_hooks | 9 | 36 | 25.0% |
| dns | 9 | 30 | 30.0% |
| inspector | 29 | 74 | 39.2% |
| vm | 41 | 97 | 42.3% |
| zlib | 31 | 64 | 48.4% |
| tty | 3 | 5 | 60.0% |
| repl | 71 | 101 | 70.3% |
| util | 23 | 30 | 76.7% |
| perf_hooks | 12 | 15 | 80.0% |
| os | 5 | 6 | 83.3% |
| process | 81 | 97 | 83.5% |
| module | 28 | 32 | 87.5% |
| trace_events | 26 | 29 | 89.7% |
| worker_threads | 134 | 142 | 94.4% |
| console | 20 | 21 | 95.2% |
| buffer | 60 | 62 | 96.8% |
| timers | 43 | 44 | 97.7% |
| crypto | 126 | 128 | 98.4% |
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
