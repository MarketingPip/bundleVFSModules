# Wave 4 triage — HTTP2-DIAGNOSTICS (18 files)

- Worktree: `~/workspace/worktrees/w4-http2`, detached HEAD `6e4e6370`
- Oracle: native Node `v26.13.1` (`~/workspace/local/node-26/bin/node`), no preload, 60 s timeout
- Baseline: host node `v24.22.1` + `--import <worktree>/parity/preload.mjs`, `PARITY_TARGET=http2`, 60 s timeout
- Staging: Node 26 `test/common/` swapped in (v24 copy backed up to `/tmp`, restored after); 18 files staged in `parity/node-test/parallel/`, removed after; `git status` clean afterwards (only pre-existing `?? node_modules`)
- No `// Flags:` header on any of the 18 files (`grep -l "Flags:"` → none), so no flag-related false failures
- No name collisions with tracked v24 files in `parity/node-test/parallel/`
- Determinism: baseline run twice (full loop + per-file capture loop); all 18 fail rc=1 identically both times — no flakes, no timeouts, no OOM

## Totals (of 18)

| Category | Count |
|---|---|
| PASS already | 0 |
| FLIPPABLE | 0 |
| NO-FIX | 18 |
| NOT-A-GAP | 0 |

## Per-file table

| File | Oracle (Node 26.13.1) | Baseline (shim, PARITY_TARGET=http2) | Classification + reason |
|---|---|---|---|
| test-diagnostics-channel-http2-client-stream-body-multiple-buffers-and-strings.js | rc=0 | rc=1 — `bodyChunkSent` + `bodySent` subscribers never fired (mustCall expected 1, actual 0, each) | NO-FIX — shim never publishes the channels; no per-chunk writev body path (shim delivers whole body as one chunk) |
| test-diagnostics-channel-http2-client-stream-body-multiple-buffers.js | rc=0 | rc=1 — `bodyChunkSent` + `bodySent` subscribers never fired (mustCall 1→0 each) | NO-FIX — same as above |
| test-diagnostics-channel-http2-client-stream-body-no-chunks.js | rc=0 | rc=1 — `bodySent` subscriber never fired (mustCall 1→0); `bodyChunkSent` is `mustNotCall` (correctly silent) | NO-FIX — `bodySent` never published; needs real END_STREAM/body lifecycle |
| test-diagnostics-channel-http2-client-stream-body-single-buffer.js | rc=0 | rc=1 — `bodyChunkSent` + `bodySent` subscribers never fired (mustCall 1→0 each) | NO-FIX — same as above |
| test-diagnostics-channel-http2-client-stream-body-single-string.js | rc=0 | rc=1 — `bodyChunkSent` + `bodySent` subscribers never fired (mustCall 1→0 each) | NO-FIX — same as above |
| test-diagnostics-channel-http2-client-stream-close-error.js | rc=0 | rc=1 — `http2.client.stream.close` subscriber never fired (mustCall 1→0); abort `error` handler also never fired (mustCall 1→0, line 37) | NO-FIX — channel never published; abort path has no RST_STREAM/ABORT_ERR propagation; subscriber also asserts `rstCode === NGHTTP2_CANCEL` |
| test-diagnostics-channel-http2-client-stream-close.js | rc=0 | rc=1 — `http2.client.stream.close` subscriber never fired (mustCall 2→0) | NO-FIX — channel never published |
| test-diagnostics-channel-http2-client-stream-created.js | rc=0 | rc=1 — `http2.client.stream.created` subscriber never fired (mustCall 2→0) | NO-FIX — channel never published; subscriber asserts `constructor.name === 'ClientHttp2Stream'` + real pseudo-headers, which the single shared `Http2Stream` cannot satisfy |
| test-diagnostics-channel-http2-client-stream-error.js | rc=0 | rc=1 — `http2.client.stream.error` subscriber never fired (mustCall 1→0); stream `error` handler also never fired (mustCall 1→0, line 39) | NO-FIX — channel never published; no RST_STREAM error path on the client side |
| test-diagnostics-channel-http2-client-stream-finish.js | rc=0 | rc=1 — `http2.client.stream.finish` subscriber never fired (mustCall 2→0) | NO-FIX — channel never published; subscriber asserts `headers` + `flags` payloads from real END_STREAM |
| test-diagnostics-channel-http2-client-stream-start.js | rc=0 | rc=1 — `http2.client.stream.start` subscriber never fired (mustCall 2→0) | NO-FIX — channel never published |
| test-diagnostics-channel-http2-server-stream-close-error.js | rc=0 | rc=1 — crashed first on client `error` handler: `err.code` is `undefined`, expected `'ERR_HTTP2_STREAM_ERROR'` (test line 47; via `src/http2.js:1848` `_destroy` → `1946` `destroy`) | NO-FIX — no RST_STREAM code mapping across peers; `http2.server.stream.error` subscriber (asserts `error === expectedError` identity, `constructor.name === 'ServerHttp2Stream'`, `instanceof Duplex`) never reached |
| test-diagnostics-channel-http2-server-stream-close.js | rc=0 | rc=1 — `http2.server.stream.close` subscriber never fired (mustCall 2→0) | NO-FIX — channel never published |
| test-diagnostics-channel-http2-server-stream-created-start-timing.js | rc=0 | rc=1 — countdown reached 0 (response + push delivered) but channel map empty: `0 !== 2` at line 48 | NO-FIX — neither `created` nor `start` ever published; timing assertion (`createdTime < startTime` per `stream.id`) needs real frame-processing order. Proves the virtual loop runs request/response+push yet publishes nothing |
| test-diagnostics-channel-http2-server-stream-created.js | rc=0 | rc=1 — `http2.server.stream.created` subscriber never fired (mustCall 2→0) | NO-FIX — channel never published; subscriber asserts `constructor.name === 'ServerHttp2Stream'` + real headers |
| test-diagnostics-channel-http2-server-stream-error.js | rc=0 | rc=1 — crashed first on client `error` handler: `err.code` is `undefined`, expected `'ERR_HTTP2_STREAM_ERROR'` (test line 48; via `src/http2.js:1848` `_destroy`) | NO-FIX — same as server-stream-close-error |
| test-diagnostics-channel-http2-server-stream-finish.js | rc=0 | rc=1 — `http2.server.stream.finish` subscriber never fired (mustCall 2→0) | NO-FIX — channel never published; subscriber asserts `headers` + `flags` payloads |
| test-diagnostics-channel-http2-server-stream-start.js | rc=0 | rc=1 — `http2.server.stream.start` subscriber never fired (mustCall 2→0) | NO-FIX — channel never published |

## Shared root-cause mechanism (all 18)

Grounded in source, not assumed:

- `src/http2.js` contains **zero** references to `diagnostics_channel` / `diagnosticsChannel` and zero `http2.client.*` / `http2.server.*` channel names — the shim never publishes any of the 12 channels these tests subscribe to (`bodyChunkSent`, `bodySent`, `close`, `created`, `error`, `finish`, `start` × client/server).
- Node 26 publishes them from `lib/internal/http2/core.js:197-208` (channel handles) at 15 publish sites (`core.js:389, 395, 413, 419, 465, 841, 1937, 2092, 2095, 2371, 2397, 2546, 2552, 3027, 3037, 3096`), all embedded in the nghttp2 frame-processing lifecycle (HEADERS receipt → created, first byte → start, DATA write → bodyChunkSent, END_STREAM → finish, teardown → close, RST_STREAM → error).
- `src/http2.js:1611` — a single `class Http2Stream extends EventEmitter`, not a Duplex; no `ClientHttp2Stream` / `ServerHttp2Stream` classes exist. Every subscriber asserts `stream instanceof Duplex` and `stream.constructor.name === 'ClientHttp2Stream'` / `'ServerHttp2Stream'` — both fail even if publish calls were added.
- `src/http2.js:24-44` (shim's own header): the virtual loop shares **one** `Http2Stream` object between client and server (real Node has distinct objects per side) and delivers the whole response body as a single `'data'` chunk; no framing, flow control, HPACK, multiplexing over a socket, ALPN, or TLS.
- `src/http2.js:1836-1856` `_destroy` emits the raw error object with no code mapping — the peer never gets `ERR_HTTP2_STREAM_ERROR` (proven by the two server error tests: client `err.code === undefined`).
- Close-error tests additionally assert `stream.rstCode === NGHTTP2_CANCEL` / `NGHTTP2_INTERNAL_ERROR` — `rstCode` comes from the RST_STREAM frame, which has no wire in the shim.

## Why not FLIPPABLE

Every file carries ≥2 independent engine-level blockers (no publish sites + wrong stream class hierarchy + not a Duplex + one shared object per stream + no RST_STREAM code propagation + single-chunk body). Adding publish calls alone would still fail the constructor-name, `instanceof Duplex`, header deep-equal, per-chunk `writev`/`data`/`encoding`, `flags`, and error-code assertions. Satisfying them means re-implementing the nghttp2 stream lifecycle's observable behavior in the virtual loop — i.e. the standing NO-FIX bucket (no real HTTP/2 engine: no framing/HPACK/flow-control/multiplexing/sockets/TLS/ALPN/nghttp2 state). No lane family can flip these without that engine.

## Notes

- `~/workspace/local/node-26-src/AGENTS.md` read: upstream Node.js agent policy (no unsupervised PRs/commits to nodejs/node). This task did no commits/pushes/PRs and touched that tree read-only, so nothing in it blocks this triage.
- Raw logs: `/tmp/w4-http2-base/` (per-file baseline logs), `/tmp/w4-http2-oracle.txt`, `/tmp/w4-http2-baseline.txt`.
