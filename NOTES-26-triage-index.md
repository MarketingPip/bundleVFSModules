# Node 26 re-target triage — consolidated lane plan (index)

Base: main `3c091022` (PR #505 drift detector). Triage by 15 workers
(2026-11-19), one per module or small group; every worker doc was
verified by the coordinator against the banked oracle/baseline numbers
before acceptance — worker counts were recomputed, not trusted.

## Banked numbers and what triage did to them

Baseline (`parity/drift/node26-baseline.jsonc`, Node 26.13.1 tests vs the
v24.20.0 shims, host v24.22.1): **2,748 run — 2,144 pass / 575 fail /
29 timeout**. Oracle (`parity/drift/node26-oracle.json`, 604 non-passes):
**567 shim-gap / 32 fails-natively / 5 native-timeout**.

Triage corrected the oracle in 9 places (rule below). Net effect:

| | banked | true |
| --- | ---: | ---: |
| shim-gap | 567 | **563** |
| fails-natively | 32 | **27** |
| native-timeout | 5 | 5 |
| not-a-gap artifacts (removed) | 0 | 9 |
| **total classified** | 604 | **604** |

**Classification rule (applied uniformly):** a test leaves the gap count
only when it passes under a correct harness invocation (isolated, with its
declared flags, on the right host) or never touches the shim. A test that
fails deterministically under every legitimate harness invocation stays a
gap — even when the root cause is a host/harness limitation — and is
recorded NO-FIX with its mechanism.

**The 9 corrections** (each probe-verified by the worker and, where it
moves a count, re-probed by the coordinator):

| test(s) | module | was | is | why |
| --- | --- | --- | --- | --- |
| 5 Zip tests (`zip-files`, `zip-interop`, `zip-security-hardening`, `zip-security`, `zip-writable`) | zlib | fails-natively | shim-gap | Oracle's parallel native run hit the shared-`.tmp.0` collision; all 5 pass natively sequential (coordinator re-ran, exit 0 each) |
| `test-process-redirect-warnings.js` | process | shim-gap | not a gap | Sweep race on shared `.tmp.0`; passes isolated, both vendored and 26 file (coordinator re-ran, exit 0) |
| `test-inspector-strip-types.js` | inspector | shim-gap | not a gap | Test drives real children over raw WS, never touches the shim; fails only under the harness (coordinator: native 26 exit 0 ×3, native host-24 exit 0 ×4, harness exit 1 with identical v24-child SyntaxError). Doc mechanism sentence corrected by coordinator — the worker's "host v24 natively exits 1" does not reproduce |
| `test-repl-tab-complete-nested-repls.js` | repl | shim-gap | not a gap | Spawns `process.execPath` (host v24 child); native-26 exit 0, native-host-24 exit 1, harness exit 1 (coordinator re-ran all three) |
| `test-readline-promises-csi.mjs` | readline | shim-gap | not a gap | Needs `--expose-internals`; harness WITH flag exits 0, WITHOUT exits 1 (coordinator re-ran both) |
| `test-crypto-secure-heap.js` | crypto | shim-gap | not a gap | Forked children run without preload, abort at V8 init before any JS; shim never loads |
| `test-fs-stat-cancel-inflight.js` | fs | shim-gap | not a gap | Child spawned without preload; host native binding has no `cancel` (26 has it) |
| `test-buffer-copy-immutable.js`, `test-buffer-isutf8-isascii-fast.js` | buffer | shim-gap | not a gap | Host rejects/fatals on their declared flags (`--js-immutable-arraybuffer`, `--allow-natives-syntax`); both pass natively on 26 (coordinator re-ran) |
| `test-http2-util-update-options-buffer.js` | http2 | shim-gap | not a gap | Reads the host's internal options buffer, which the preload does not redirect; shim never in the path |

**Withdrawn parent correction:** the drift NOTES claimed
`test-worker-heap-profile.js` was a load artifact (true gap 566). The
misc worker refuted it and the coordinator confirmed with its own probes:
26 file aborts 134 under the harness ×2, natively on host v24, and
natively on Node 26 it exits 0; the vendored v24 file passes under the
harness. The parent's 566 was based on the vendored file, not the 26
file. heap-profile stays a gap (NO-FIX, host V8 abort — deterministic,
shim loaded and delegating). The program total lands at 563 anyway, by a
different route (567 + 5 zlib − 9 artifacts).

## Per-module table

26-suite = baseline run for that module (total / pass). True gap = after
the corrections above. Flips = conservative harness-measurable lane
estimates. Ceiling = 26-suite pass + flips. Detail lives in the
per-module doc; this table is the plan.

| module | 26-suite total/pass | true gap | lane flips | NO-FIX | HELD / parked / env | ceiling |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| http2 | 289 / 88 | 200 | 4 | 193 | TBD 3 | 92/289 |
| stream | 232 / 180 | 52 | 38 (+1 cond) | 0 | — | 218/232 |
| zlib | 89 / 48 | 41 | 20 cons (23) | 17 | cond 1 | 68/89 |
| vm | 101 / 65 | 36 | 1 (low conf) | 35 | — | 66/101 |
| fs | 385 / 346 | 27 | 18 | 7 | — | 364/385 |
| inspector | 76 / 41 | 29 | 0 | 29 | — | 41/76 |
| http | 422 / 390 | 30 | 15 (+6 upside) | 5 | HELD 4 | 405/422 |
| https | 70 / 58 | 10 | 2 (+1 upside) | 5 | HELD 1 | 60/70 |
| crypto | 167 / 145 | 19 | 15–19 | 0 | — | 160–164/167 |
| dns | 32 / 10 | 15 | 2 | 13 | — | 12/32 |
| net | 161 / 145 | 16 | 3 | 13 | — | 148/161 |
| perf_hooks | 31 / 17 | 14 | 5 certain (up to 7) | 0 | +5 browser-only | 22/31 |
| trace_events | 13 / 12 | 1 | 0 | 1 | — | 12/13 |
| process | 102 / 88 | 11 | 0 | 8 | parked 2, env 1 | 88/102 |
| os | 8 / 7 | 0 | — | — | — | 7/8 |
| repl | 108 / 95 | 12 | 5 (+1 util) | 2 | R5 parked | 100/108 |
| readline | 22 / 21 | 0 | — | — | — | 22/22* |
| buffer | 74 / 64 | 8 | 6 | 2 | — | 70/74 |
| util | 36 / 26 | 10 | 8–9 | 0 | — | 34–35/36 |
| events | 9 / 1 | 8 | 8 | 0 | — | 9/9 |
| async_hooks | 36 / 29 | 7 | 0 | 7 | — | 29/36 |
| worker_threads | 146 / 137 | 9 | 1 (cond) | 8 | — | 137–138/146 |
| module | 37 / 32 | 5 | 1 | 4 | — | 33/37 |
| assert | 14 / 12 | 2 files | 1 file | 0 files† | — | 13/14 |
| timers | 59 / 58 | 1 | 0 | 1 (harness) | — | 58/59 |
| console / string_decoder / tty | 22+4+3 / all | 0 | — | — | — | perfect |
| **TOTAL** | **2,748 / 2,144** | **563** | **~153** | **~350** | **HELD 5, parked 5, env 1** | **~2,297/2,748 (83.6%)** |

\* readline is 22/22 once the baseline honors the test's declared
`--expose-internals` flag (the 1 non-pass is the flags artifact above).
† assert: 2 files, 10 sub-tests. A-26-1 flips `test-assert.js` (1 file);
A-26-2 fixes 2 of 4 deep sub-tests but the file stays red; 2 sub-tests
are NO-FIX (Proxy rendering, sync promise settlement).

**Residual:** 563 − 153 flips − 350 NO-FIX − 5 HELD − 5 parked − 1 env =
49 tests in lane families but not conservatively flippable (upside /
conditional / unflipped-in-family — largest parts: stream iter
unflipped 10, http upside 6, perf_hooks browser-only 5, crypto
floor-to-total 4, http2 TBD 3, stream L1 unflipped 3, zlib
non-conservative 3, fs F15 unflipped 2, assert sub-tests 2).

**NO-FIX buckets (largest):** http2 engine 193 (no real HTTP/2
framing/HPACK/flow-control/multiplexing/sockets/TLS/ALPN/nghttp2 state);
vm 35 (ESM module graph 25, V8-isolate semantics 7, timeout interrupt
3); inspector 29 (protocol never arrives 20, url() by design 3, hangs
3, singles 3 after strip-types out); dns 13 (stub 8, UDP 4, perf 1);
net 13 (transfer 5, real-handle 3, cluster 1, lane-11 1, backpressure
3); zlib 17 (Brotli compressor 13, zstd flush, brotli error fidelity,
zip-internals, zip-vfs); async_hooks 7 (preload ID shift, no-preload
declined); fs 7 (socket/FIFO 5, FileHandle transfer, procfs mkdir);
worker_threads 8; process 8 (version skew 4, --process-timeout 3,
execve-throws 1).

## Lane sequence (recommended)

**Wave 1 — certain, small (~51 flips).** Do first; each lane is one
small root cause with a named test list in its doc.
- crypto L1 Mac/PKCS12 export table — 5
- buffer B1–B4 (detached isAscii/isUtf8, new APIs, indexOf ceil, write coercion) — 6
- events E1–E3 (timer-leak harness fix, abort-listener, getEventListeners unwrap) — 8
- util U1+U2 (debounce/throttle, isPartialDeepStrictEqual) — 3; U3–U8 (inspect regexp colorize, DataView indent, inspect proxy, long-running output budget, parse-env, stripvt OSC) — 5–6
- dns L1 NUL validation — 2
- net L1–L3 (autoselectfamily default 250→500, `_unrefTimer`, half-open async-iter) — 3
- http H-A new exports — 2
- https T-A getName + T-B SAN-parse — 2
- module M-26-1 `_load` parent-dir read — 1
- assert A-26-1 message semantics — 1
- fs F6/F7/F9/F12/F13 (openAsBlobSync, rmdir-recursive deletion, FileHandle-GC throw, negative-zero, windowsHandle order) — 5
- repl L2 highlight port + L4 TLA hook removal — 2
- perf_hooks L-PH4 ResourceTiming attrs — 2
- zlib L-SMALL (dictionary, pledged-src-size, params) — 3
- vm restricted-global — spike first, lane only if the spike clears sloppy-`let`/block-scope false positives (1, low confidence)

**Wave 2 — medium (~65 flips).**
- stream L1 readable.js 26 port (one-buffer + flowSync + EOF gating) — 8; L2+L2b conditional ALS bind + symbol adapter — 3; L3–L5 (wasCanceled, DEP0201, Duplex.from) — 3
- fs cp lanes F1–F5 (dir timestamps, dir modes, deref, errorOnExist, dest-appears-late) — 6; F10/F11/F14/F15 (stat signal, pull deferral, readdir BFS, recursive-watch) — 7
- http H-B–H-H (upgrade-with-body, agent lifecycle, outgoing/response, server interim, parser+clientError, CONNECT, `_header`) — 13
- crypto L2–L8 (DEP0198 shake, GCM short-tag, JWK validation, sync/async error parity, KMAC/SEC1, randomFill) — 14
- zlib L-RESET — 4
- repl L1 ALS error routing + util-lane `test-repl.js` — 3
- perf_hooks L-PH1 Histogram 26 API — 3–5
- worker_threads W-26-1 exit-listener cleanup — 1 (conditional on parent call)

**Wave 3 — large / uncertain (~45 flips).**
- zlib L-ZIP Zip API (8 new exports, pure-JS port onto pako/zstdify/crc32/fs) — 16 (+1 conditional)
- stream L6 `stream/iter` port (~9,000 lines) + preload redirect — 25. **Gated:** the 35 iter failures are host-v24 drift today; re-measure on a Node 26 host (or with the redirect in place) before scoring this lane.
- http2 H2-26-WR (write misroute) 2 + H2-26-W1 (connectionWindowSize) 1 + H2-26-C1 (compat getHeaders) 1 — 4

**Upside not in the totals:** http +6, https +1, http2 validation residue
(altsvc, origin, origin-set-max-size) 3 TBD, perf_hooks browser-only 5
(L-PH2 record(0) 3, L-PH3 ELD 2 — 0 harness flips). Program range:
**153 conservative → ~175 with all upside/conditionals** (ceiling
~2,297–2,319 / 2,748). Wave sums use full lane estimates (~51 + ~66 +
~45 = ~162), so they run slightly above the 153 conservative floor,
which uses zlib 20 (not 23), crypto 15 (not 19), util 8 (not 9),
stream 38 (not 39), perf_hooks 5 (not 6).

## Parked / declined (do not re-open as lanes)

- Inspector real bridge — host-architecture decision, already declined
  (v24 wave + this triage).
- trace_events T1 bridge — declined by parent in v24, carried.
- repl R5 harness gate — parked, branch `fix/repl-harness-gate`
  @ `807eec89` (75/101, 23 regressions). Family A (mode,
  tab-complete-import/require) stays gate-blocked.
- process eager-load question — parked design question (get-builtin.mjs,
  uncaught-exception-monitor).
- http lane 11 (cross-process virtual-server reachability) — HELD,
  design decision, not a fix lane (4 http + 1 https tests).
- async_hooks no-preload route — declined (would measure native against
  native).
- vm ESM / isolate / timeout families, http2 engine, dns UDP/stub,
  zlib Brotli compressor — NO-FIX, see buckets above.

## Baseline corrections and scope gaps (for the drift job, not lanes)

- **Flags:** `run-baseline.mjs` drops per-test `// Flags:` headers
  (unlike `parity/run.mjs:64-75`). Cost so far: readline promises-csi
  (false gap), stream consumers-dump.mjs link failure, http flagged
  re-runs (identical outcomes, no correction). Fix the runner to honor
  flags.
- **Exit-code mapping is lossy:** `runOne` maps any signal to 129.
  True signals seen in triage: 134 (SIGABRT), 139 (SIGSEGV), 133
  (SIGTRAP). Record the real signal.
- **Scope gaps — tests the baseline never ran (65 files, inside the 28
  program modules, unmeasured, not counted anywhere):**
  - events: 30 files — all 28 `test-event-*` (EventEmitter core) + 2
    `test-eventsource*`. The baseline's prefix `test-events-` misses
    the singular `test-event-`. The vendored v24 suite never had them
    either. Events triage covers only the 9 run tests.
  - http2: 18 `test-diagnostics-channel-http2-*` files (prefix
    `test-http2-` misses them). True 26 http2 suite is 307 files, not
    289.
  - async_hooks: 12 `test-async-local-storage-*` files.
  - module: 4 `test-diagnostics-channel-module-*`; worker_threads: 1
    `test-diagnostics-channel-worker-*`.
  - Everything else unrun (2,222 files: child_process, quic, dgram,
    cluster, tls, whatwg, permission, …) is outside the 28 program
    modules.
- **Unscored export:** `util.markPromiseAsHandled` — the shim lacks
  it, but no test in the 2,748 matches a module glob, so it has no
  lane. It rides with the util U1 lane if that lane touches the
  export table.
- **Host-conditional results:** several NO-FIX / artifact verdicts
  change on a Node 26 host (heap-profile, secure-heap, strip-types,
  stat-cancel-inflight, buffer B7/B8, perf_hooks F3–F5, process F2).
  If the CI drift job runs on a Node 26 host, those clear or move;
  the triage docs name each one.
- **Research-check:** the drift research's "crypto TOP drift, 27
  rows" overstates — the export diff is 3 added + 1 changed, and the
  grounded crypto gap is 19. The changelog cross-check's 35–45
  behaviour-change spine stands as the scope spine; the ~180
  source-diff count is the implementation layer, not the lane list.

## Per-module docs (this PR)

NOTES-26-triage-<mod>.md for all 25 modules with gaps (assert,
async_hooks, buffer, crypto, dns, events, fs, http, http2, https,
inspector, module, net, perf_hooks, process, repl, stream, timers,
trace_events, util, vm, worker_threads, zlib) plus os and readline
(zero-gap docs). console, string_decoder, tty have no gaps and no doc.
