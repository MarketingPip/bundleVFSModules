# Techniques worth adapting — competitor study 2026-09-28

Study dossier (workers' notes + synthesis report):
`~/workspace/work-queue/jobs/2026-09-28-competitor-study/`
— `almostnode.md`, `nodepod.md`, `webcontainers.md`, `REPORT.md`.

Study clones (read-only reference, do not import code):
- `…/competitor-study/almostnode/` — AlmostNode @ depth-1, 2026-09-28
- `…/competitor-study/nodepod-src/` — Nodepod @ `a6fcbdde` (2026-09-27)

**License rules.** AlmostNode is MIT — techniques and independently-written
code are fine. **Nodepod is MIT + Commons Clause — techniques only, never
code** (the sale restriction is viral; nothing from it enters a commercial
bundleVFSModules). WebContainers is closed-source — docs claims only.

Standing policies adopted from this study live in `AGENTS.md` rules 6–10.

## File pointers for later

### AlmostNode (MIT) — https://github.com/macaly/almostnode

- `src/shims/child_process.ts` (~L816, "Create a Runtime for the child
  process") — opt-in worker-backed `fork()` with in-thread Runtime + cloned
  IPC mimicking V8 serialization. → *honest process story* (loud-noop
  default, worker-backed fork where the host allows it).
- `src/transform.ts` (`transformPackage`, `BATCH_SIZE=10`) — install-time
  ESM→CJS batch transform via esbuild-wasm; `import.meta` rewritten via
  esbuild `define`. → *roadmap item 1*.
- `src/runtime.ts` `builtinModules` map (L308–370) + `loadModule()` — runtime
  acorn-AST transform with regex fallback; dynamic `import("node:x")` →
  `Promise.resolve(require("x"))` rewrite. → *roadmap item 1*.
- `src/server-bridge.ts` + `public/__sw__.js` — Service Worker
  `/__virtual__/{port}/` preview routing so guest servers are reachable from
  the page. → *host runtime*.
- `src/shims/child_process.ts:116,322` + CHANGELOG 0.2.12 — generic `.bin`
  stub generation at `npm install` time (reads each package's `bin` field,
  routes through the runtime's `node`). → *roadmap item 1*.
- `src/npm/` — PackageManager with `exports`/`imports` field resolution.
  → *roadmap item 1*.
- `src/shims/http.ts` (L510+) — `http` client over real `fetch()`;
  `setCorsProxy()` with **no default proxy** for security reasons — the right
  default. → *http.js*.
- `src/shims/esbuild.ts` — `NODE_BUILTINS` stub set so transitive dep leaks
  resolve to shims instead of crashing.
- `vite-plugin.ts` / `next-plugin.ts` (`almostnode/vite`, `almostnode/next`
  subpath exports) — drop-in host-app integration pattern. → *roadmap item 2*.
- `CLAUDE.md` — "Never write library-specific shim code. Fix the platform
  instead." (now `AGENTS.md` rule 6); changelog discipline (deleted the
  Sentry no-op shim, removed Convex-specific path remaps).

### Nodepod (MIT + Commons Clause — techniques only) — https://github.com/R1ck404/Nodepod

- `src/__tests__/bash-differential.test.ts` — differential testing: runs real
  `bash` via `execFileSync` on Linux CI, diffs stdout/stderr/exit code
  against the TS shell. (Now `AGENTS.md` rule 9.) → *roadmap item 4*.
- `src/persistence/binary-snapshot.ts` — binary snapshot wire format:
  one ArrayBuffer of contents + offset manifest, no base64 inflation,
  shared between worker handoff and IndexedDB/OPFS persistence.
  → *FS persistence story*.
- `src/helpers/esbuild-engine.ts` — single shared esbuild-wasm instance,
  retired after calls over 512KB of input (wasm linear memory never
  shrinks), fresh worker per generation. Directly relevant if we lazily
  load esbuild-wasm. → *roadmap item 1*.
- `src/polyfills/dns.ts` — real DNS via DNS-over-HTTPS against
  `https://cloudflare-dns.com/dns-query` ("no inventing 0.0.0.0").
  → *dns.js*.
- `src/polyfills/fetch-response.ts` — patches the browser's
  `fetch`/`Headers`/`Response` to match Node 20's undici behavior
  (set-cookie handling, Headers parity). **Check whether our iframe realm
  needs the same** before writing per-call workarounds. → *platform layer*.
- `src/threading/process-manager.ts` + `process-worker-entry.ts` —
  worker-backed `spawn` with stdio streaming, signals, exit codes; workers
  boot from a VFS snapshot and receive changes over a VFS bridge.
  → *honest process story*.
- `src/packages/installer.ts` (~L222 bin normalization) — in-browser npm
  install lifecycle: registry resolution, tarball→VFS, exports maps, `.bin`
  stubs, lockfile. → *roadmap item 1*.
- `src/headless.ts` + `src/host/` — headless host abstraction: the same
  core runtime runs on browser Web Workers and Node/Bun worker threads,
  which gives a real-Node test lane for free. → *roadmap item 4*.
- `src/integrations/vite.ts`, `next.ts` — copy-based framework setup +
  plugins so host apps serve runtime assets and previews. → *roadmap item 2*.
- `src/polyfills/wasi.ts` (1898 lines) + `src/helpers/napi-wasm-worker.ts`
  — WASI path for napi-rs WASM packages; wa-sqlite as the standing example
  of WASM-of-the-real-thing (now `AGENTS.md` rule 8). → *roadmap item 1*.

### WebContainers (closed-source, docs only) — https://webcontainers.io/

- Public docs: explicit lifecycle API (boot/teardown promises, exit codes,
  `server-ready` events), preview URL scheme, `forwardPreviewErrors`
  pattern — the product surface we don't have yet. → *host runtime*.
- Sharp Node-API→WASM port writeup — the template for turning "not
  supported" into a porting guide instead of a dead end. → *roadmap item 1*.
- Deployment constraints to **not** copy: mandatory SharedArrayBuffer +
  COOP/COEP + HTTPS, one instance at a time, paid commercial licensing.

## Anti-patterns confirmed (do not adopt)

- Nodepod's `net.connect()` succeeding unconditionally, `dgram.send()`
  reporting success while sending nothing, silent `quic`/`fsevents` no-ops
  → `AGENTS.md` rule 7 (no silent fakes).
- AlmostNode's stale hand-written stub tables and test-count claims
  → `AGENTS.md` rule 10 (generated capability matrix).
- Self-authored "parity" tests that never run the official suite
  (Nodepod's `*-parity.test.ts`, AlmostNode's `node-compat/`)
  → our parity philosophy: only official suites + repo tests + differential
  checks count toward a score.
