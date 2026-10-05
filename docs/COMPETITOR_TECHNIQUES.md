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
reclaimprotocol/tls license is MIT text (CreatorOS Inc.) at
`reclaimprotocol/.github` — the "custom" flag was about the non-standard
location, not the terms. Eval 2026-10-05: do not vendor — no byte transport
exists in the browser runtime; revisit when one does (see roadmap §1).

## Jared's verdicts (2026-09-28)

**MUST** — build it. **OUT** — explicitly rejected, do not pursue.
**DEMO** — demo/learning only, never on the product path.
**EVAL** — research candidate, no commitment yet.

Standing policies adopted from this study live in `AGENTS.md` rules 6–11.

### Scope decisions (binding)

- **No shell. No npm-install / package manager as product.** We are a
  runtime library, not a dev environment. (`AGENTS.md` rule 11.)
- **esbuild is OUT — way too heavy for this project.** No esbuild-wasm
  anywhere: no install-time ESM→CJS via esbuild, no esbuild instance
  hygiene to manage. Our own `_build_file` transform stays the CJS→ESM path.
- **Demo fake shell: DEMO.** A fake shell for developers learning the
  library — with npm install-time behavior (reads each package's `bin`
  field, routes through the runtime's `node`) and sample code. Clearly
  marked demo, never on the product path.

## File pointers for later

### AlmostNode (MIT) — https://github.com/macaly/almostnode

- `src/shims/child_process.ts` (~L816, "Create a Runtime for the child
  process") — **MUST** (already substantially implemented): opt-in
  worker-backed `fork()` with in-thread Runtime + cloned IPC mimicking V8
  serialization. → *honest process story*.
- `src/transform.ts`, `src/runtime.ts` `loadModule()` ESM→CJS via
  esbuild-wasm — **OUT** (esbuild too heavy). Our `_build_file` transform
  stays.
- `src/server-bridge.ts` + `public/__sw__.js` — **MUST**: Service Worker
  `/__virtual__/{port}/` preview routing so guest servers are reachable
  from the page. Note: patching `fetch` only covers programmatic requests
  from JS — it does **not** cover address-bar navigation, `<iframe src>`,
  `<img>`/`<script>`/`<link>` tags, or new-tab previews, which bypass JS
  entirely. The SW route is what makes a guest server a real navigable URL.
  Both layers: fetch patch for in-realm code, SW for page-level
  reachability. → *host runtime*.
- `src/shims/child_process.ts:116,322` + CHANGELOG 0.2.12 — **DEMO**:
  generic `.bin` stub generation at npm install time (reads each package's
  `bin` field, routes through the runtime's `node`). For the demo fake
  shell only. → *demo shell*.
- `src/npm/` PackageManager (`exports`/`imports` resolution) — **split**:
  the **resolution logic is MUST** (package `exports`/`imports` field
  resolution for our VFS → *roadmap item 1*); the install manager product
  is **OUT**.
- `src/shims/http.ts` (L510+) — `http` client over real `fetch()`;
  `setCorsProxy()` with **no default proxy** for security reasons — the
  right default. Worth reading when we touch outbound http. → *http.js*.
- `vite-plugin.ts` / `next-plugin.ts` (`almostnode/vite`, `almostnode/next`
  subpath exports) — drop-in host-app integration pattern. → *roadmap
  item 2* (see Nodepod integrations, MUST).
- `CLAUDE.md` — "Never write library-specific shim code. Fix the platform
  instead." (now `AGENTS.md` rule 6); changelog discipline.

### Nodepod (MIT + Commons Clause — techniques only) — https://github.com/R1ck404/Nodepod

- `src/__tests__/bash-differential.test.ts` — **OUT**: differential testing
  against real bash. We are not building a shell. (`AGENTS.md` rule 9 keeps
  differential testing for emulated external behavior we *do* own: dns,
  http.)
- `src/persistence/binary-snapshot.ts` — binary snapshot wire format
  (ArrayBuffer + offset manifest, no base64), shared between worker handoff
  and IndexedDB/OPFS persistence. Useful when we do FS persistence; not
  urgent. → *FS persistence story*.
- `src/helpers/esbuild-engine.ts` — **OUT** (esbuild too heavy).
- `src/polyfills/dns.ts` — **MUST**: real DNS via DNS-over-HTTPS against
  `https://cloudflare-dns.com/dns-query` ("no inventing 0.0.0.0").
  → *dns.js*.
- `src/polyfills/fetch-response.ts` — **MUST**: patches the browser's
  `fetch`/`Headers`/`Response` to match Node 20's undici behavior
  (set-cookie handling, Headers parity). **Check whether our iframe realm
  needs the same** before writing per-call workarounds. → *platform layer*.
- `src/threading/process-manager.ts` + `process-worker-entry.ts` —
  **MUST**: worker-backed `spawn` with stdio streaming, signals, exit codes;
  workers boot from a VFS snapshot and receive changes over a VFS bridge.
  → *honest process story*.
- `src/packages/installer.ts` (~L222 bin normalization) — **split**: bin
  normalization technique is **DEMO** (demo shell); registry/tarball
  install product is **OUT**.
- `src/headless.ts` + `src/host/` — **MUST**: headless host abstraction —
  the same core runtime on browser Web Workers and Node/Bun worker threads,
  which gives a real-Node test lane for free. → *roadmap item 4*.
- `src/integrations/vite.ts`, `next.ts` — **MUST**: copy-based framework
  setup + plugins so host apps serve runtime assets and previews.
  → *roadmap item 2*.
- `src/polyfills/wasi.ts` (1898 lines) + `src/helpers/napi-wasm-worker.ts`
  — **MUST**: WASI path for napi-rs WASM packages; wa-sqlite as the standing
  example of WASM-of-the-real-thing (now `AGENTS.md` rule 8).
  → *roadmap item 1*.

### WebContainers (closed-source, docs only) — https://webcontainers.io/

- Public docs — **MUST**: explicit lifecycle API (boot/teardown promises,
  exit codes, `server-ready` events), preview URL scheme, `forwardPreviewErrors`
  pattern — the product surface we don't have yet. → *host runtime*.
- Sharp Node-API→WASM port writeup — **MUST** as a template: turn "not
  supported" into a porting guide instead of a dead end. → *roadmap item 1*.
- Deployment constraints to **not** copy: mandatory SharedArrayBuffer +
  COOP/COEP + HTTPS, one instance at a time, paid commercial licensing.

### reclaimprotocol/tls — https://github.com/reclaimprotocol/tls (EVAL)

Pure-TypeScript TLS 1.2/1.3 client, fully browser-compatible with zero
polyfills: crypto via WebCrypto (pure-JS fallback), X509 validation via
`@peculiar/x509`, full Mozilla CA store, AIA intermediate fetching.
**Why it matters:** our `tls.js`/`https.js` should prefer a maintained
package over hand-rolled crypto (`AGENTS.md` rule 4) — this is the
WASM-of-the-real-thing instinct applied to TLS. **Caveats:** it needs a byte
transport (`new Socket()` in its example) — in-browser that means a
WS→TCP bridge or equivalent; it fits cleanly in the future Node.js-hosted
lane (real `net.Socket` exists there). **Custom license — check terms
before vendoring or depending.**

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
