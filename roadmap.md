# bundleVFSModules Roadmap

The plan of record for the runtime. Completed work stays listed briefly for
context; planned work is ordered by priority. One PR per change; merge only
on green "Run Tests" + "Build VFS".

## Direction

The north star: true Node.js behaviour in the browser — a better
Node-in-browser runtime library than AlmostNode, NodePod, or WebContainers.

The path there is continued builtin parity: porting Node's own `lib/*.js`
sources for parity-critical modules, measured against Node's official test
suites through the parity harness and scoreboard (`parity/`, CI "Parity"
job). Dependencies are allowed where they beat hand-rolled code (maintained
npm packages over reinventing, platform APIs where native);
unimplementable-in-browser APIs stay honest noop stubs, never throws.

## Recently completed

- **ui.html playground wired to v1** (2026-10-03, PR #165): managed
  CodeSandbox wiring (Run, console, status/elapsed, argv, stdin, clear).
  Adds `__BVM_DISABLE_PLAYGROUND` opt-out to the runtime's demo-playground
  auto-init guard so host pages can supply their own wiring. Headed-Firefox
  e2e 3/3 (basic output, error rendering, argv). Jest 2365/2365 green.
- **ui.html playground: example buttons + stdin streaming** (2026-10-03):
  the 20 example-snippet buttons (dead since ui.html's creation) now load
  working snippets. Two real playground bugs fixed during proof: (1) logs
  were buffered until `execute()` resolved, so interactive stdin programs
  never showed prompts — now streams via the runtime's `execution:stdout`
  events with dedupe against buffered logs; (2) the Send button raced
  sandbox boot (`invoke` threw "Sandbox is not running" before
  `execution:start`) — now waits up to 10s for `context.running`. The fs
  example needed `mkdirSync({recursive:true})` for `/tmp`. Headed-Firefox
  e2e 26/26 on final main (basic/error/argv, 20/20 example buttons, stdin
  round-trip, repeated runs, fs write/read); verify-loop green.
- **Verify loop green** (2026-10-03, PR #161): full jest suite 191/191
  suites, 2359/2359 tests green; the 600s zero-output `bin/verify` timeout
  root-caused twice — (a) a module-scope `BroadcastChannel` in `src/ws.js`
  pinned the event loop on import (fixed with guarded `unref()` +
  regression test), (b) the wrapper buffered all step output (now streams
  live, kills the process group on timeout). `src/build-vfs.mjs` gained a
  shebang + executable bit; `rollup@4.64.0` added as a devDependency so the
  real `rollup/parseAst` differential runs.
- **Plugin API wired into `_build_file`** (2026-10-03, PR #162): transform
  hooks run at the top of the real `_build_file` pipeline before module
  detection (per `PLUGIN_API_DESIGN.md` §4). Headed-Firefox proof 7/7 — a
  `.ts` module seeded in the VFS is transformed by the registered plugin and
  executed with correct values; it fails pre-wiring, proving the hook
  position matters.
- **Real TypeScript transpiler plugin** (2026-10-03, PR #163): the regex
  type-stripping spike replaced with the real TypeScript 5.9.2 compiler
  (`ts.transpileModule`, lazy-loaded — npm package in Node, pinned esm.sh
  in the browser host page). 6 red-first tests (enum, generics, namespace,
  casts, non-null assertions). Headed-Firefox E2E 10/10.
- **Clang WASI hello-world spike** (2026-10-03, PR #164): the 184-byte
  hand-assembled fixture replaced with a real Clang 19.1.5 / wasi-sdk 25.0
  binary (149,568 bytes — libc startup, malloc/free, snprintf, argc/argv),
  reproducibly built by `scripts/build-clang-wasi.sh`. Browser proof: real
  `runtime.js` → `sandbox.execute()` → `node:wasi` `WASI.start()`, stdout
  via `result.logs` — 10/10 in headed Firefox.
- **Vite 7 browser E2E — M3** (2026-09-29, `feat/vite7-browser`): real
  Vite 7.3.6 `vite.build()` executes in headed Firefox through the browser
  runtime — 5060 ms, emits 1 chunk, verdict `ok:true`. Rollup runs via
  `@rollup/browser` ESM build with WASM embedded as a data URL; sandbox
  exposes a stable `globalThis._RUNTIME_` alias per realm so platform shims
  (`esbuild-shim.cjs`, `fs.js`) find the VFS. `build.minify` is `false` —
  esbuild-wasm `transform()` hangs in the sandbox worker (init succeeds).
  **Update 2026-09-29:** `minify: "terser"` now works (PR #133) — real
  Terser 5.51.2 minifies in Firefox (6530 ms, 41 chars vs 100 unminified,
  chunk executes). Full writeup: `docs/VITE_BROWSER.md`.
- **Vite 7 browser E2E — M4** (2026-09-29, `feat/vite7-browser`): real
  Vitest 5.0.2 runs in headed Firefox — 1 suite, 1 test, 1 passed, via
  genuine `expect(add(1,2)).toBe(3)` through Vitest's actual matcher code.
  **Update 2026-09-29:** stub removed — general TypeScript CJS interop
  (`__exportStar`, multi-assignment exports, bare-`exports` detection) in
  the transformer; M4 re-verified stub-free with real `expect-type@1.4.0`
  (PR #132).
- **VFS-aware `require.resolve`** (2026-09-29, PR #136): the sync-require
  resolver replaced blind `.js`-appending with Node CJS semantics —
  LOAD_AS_FILE (exact, `.js`, `.json`), LOAD_AS_DIRECTORY (`package.json`
  `main`, `index.js`/`index.json`), bare specifiers walking `node_modules`
  upward (nearest wins, mirroring `src/module.js`), live-memfs-first
  probing, JSON via `JSON.parse`, `require.resolve()` without execution.
  18/18 new unit tests (TDD red-first), 11/11 headed-Firefox E2E.

- **http.js virtual-network round trip — phase 1** (PR #99, merged
  2026-09-26): incremental HTTP/1.x parser (`src/_http_parser.js`); real
  virtual-socket `http.Server` accept path over `net.js` (byte-level parsing,
  real `req.socket`, keep-alive, chunked, 100-continue).
- **http.js virtual-network round trip — phase 2** (PR #100, merged
  2026-09-26): client loopback and host `__serverRequest__` bridge now dial
  real `net.Socket`s — genuine request/response bytes through the phase-1
  parser instead of synthetic sockets. `Server.prototype.handleRequest()`
  kept as the public direct API.

## Planned

Technique references from the 2026-09-28 competitor study (AlmostNode,
Nodepod, WebContainers) live in `docs/COMPETITOR_TECHNIQUES.md`; several
items below cite it.

### 1. Toolchain plugin architecture — opt-in power for library users

**Philosophy** (2026-09-27): we never ship a toolchain in core. It stays a
plugin that developers *choose* to install, so they can unlock more power
from the library: node modules with C code working through a compile step,
WASI modules executed against the VFS, and other toolchain-shaped
capabilities. Same rule as the shell — never bake it in, provide the
*support*.

**Seams to add** (design stage):

- `runtime.runWasi(bytes, { args, env })` — first-class wasm32-wasi
  execution wired to `__FS__` and the virtual net. Useful with zero plugins
  installed: runs *any* prebuilt wasm32-wasi module against our VFS.
- `globalThis._RUNTIME_.registerToolchain({ name, compile(files, opts),
  sysroot })` — the runtime mounts the sysroot into the VFS, calls
  `compile()` to get wasm bytes, feeds them to `runWasi`. Core never knows
  what clang is.
- VFS read-only lazy mounts capable of hosting a sysroot (headers + libs).
- Module-resolution build hook: `require('./native-addon')` may resolve to
  "compile via registered toolchain → instantiate → exports", so node
  modules with C sources work for developers who install the plugin.

**Unlocks** (all opt-in, none in core): node modules with C code compile and
run in the browser; WASI programs execute against the runtime VFS; WASI
socket calls bridge to the virtual net so compiled programs use the same
virtual networking as the Node shims.

**Non-goals**: shipping any toolchain in core; using the plugin to build our
own parity shims (core shims stay ported JS — the plugin is for library
*users*, not for us); promising N-API compatibility; designing the core
around any single toolchain. The core only knows "compile sources → wasm
bytes" and "run wasm bytes on my VFS".

**Musts from Jared's 2026-09-28 verdicts** (`docs/COMPETITOR_TECHNIQUES.md`):

- Package `exports`/`imports` field resolution for the VFS — the resolution
  logic is a must (the npm-install product stays OUT per AGENTS.md rule 11).
  **Update 2026-09-29 (PR #136):** `package.json` `main` + directory/index
  probing done for the sync-require path; `exports`/`imports` still open.
- WASI execution path (Nodepod's `wasi.ts` + `napi-wasm-worker.ts`) with
  wa-sqlite as the standing WASM-of-the-real-thing example (AGENTS.md
  rule 8). **Update 2026-10-03 (PR #164):** a Clang-produced WASI binary is
  proven through the browser runtime via `node:wasi`
  (`tests/clang-wasi-e2e.py` 10/10); the first-class `runtime.runWasi()`
  API is still open.
- A Sharp-style Node-API→WASM port writeup as the template: "not supported"
  becomes a porting guide, never a dead end.
- Evaluate `reclaimprotocol/tls` as the `tls.js` dependency instead of
  hand-rolled crypto — custom license, check terms before vendoring; needs
  a byte transport (WS→TCP bridge or the future Node.js-hosted lane).
- **OUT**: esbuild-wasm anywhere — way too heavy for this project; our
  `_build_file` transform stays the CJS→ESM path.

### 2. Interop audit leftovers

- Fix possibly reversed direction headings in interop docs.
- Update the main `__serverRequest__` example from the legacy argument
  order.
- Complete Chrome 137 verification: iframe / postMessage /
  `sandbox.invoke()` and the cookie wrapper.
- Resolve the runtime-template source of truth.
- **Framework integrations (must):** Vite/Next copy-based setup + plugins
  so host apps serve runtime assets and previews (Nodepod's
  `src/integrations/vite.ts`, `next.ts` pattern) — zero manual wiring for
  host developers.
- **Demo-only fake shell:** a fake shell for developers learning the
  library — npm install-time behavior (reads each package's `bin` field,
  routes through the runtime's `node`) plus sample code. Clearly marked
  demo; never on the product path (AGENTS.md rule 11).
- **Vite 7 browser E2E gaps** (follow-ups to M3/M4, `docs/VITE_BROWSER.md`):
  - ~~esbuild-wasm `transform()` hang → terser~~ — **done 2026-09-29**
    (PR #133): `minify: "terser"` works; only revisit esbuild if a real TS
    fixture needs `vite:esbuild-transpile`.
  - ~~Proper `expect-type` support~~ — **done 2026-09-29** (PR #132):
    general TS CJS interop; M4 re-verified stub-free.
  - Canonicalize Rollup WASM data-URL loading into the runtime
    package-loading path (currently harness-only).
  - Red-first test proving the `@rollup/browser` ESM interception target
    and named exports.

### 3. Full-suite open-handle investigation

Full jest run passes all assertions but Jest reports it "did not exit one
second after the test run" (2026-09-26). Investigate with
`--detectOpenHandles` and suite isolation. Do not assume the http/net
changes caused it — measure first.

### 4. Real-runtime parity harness — official suites through the iframe host protocol

**Problem** (2026-09-28): parity runs under Node with a
`{ parityForceShim: true }` stub marker — a bridge kill-switch, not the
real runtime (see `parity/README.md`). It proves our shim code with bridges
off, but never the sandbox integration: `loadModule` interop, `taskTracker`,
the `globalThis._RUNTIME_` → `globalThis._RUNTIME<uuid>_` AST rewrite,
`node_globals.js` startup wiring, iframe execution. Scores are honest about
our code, but not yet proof of execution through the real host protocol.

**Build**: a parity execution path (or faithful adapter to the real host
protocol) that runs the vendored official suites inside the actual sandbox
runtime — the same iframe/postMessage path user code takes. Durable harness
tests must prove: runtime-only execution (native delegation impossible),
the marker is non-enumerable, expectation selection still works, and
`report.json` records the runtime. Re-triage expectations inside that real
runtime once it exists.

**Non-goals**: replacing the Node-hosted parity lane (it stays as the fast
lane); changing any shim to suit the harness; enshrining harness artifacts
as expected failures.

**Must**: headless host abstraction — the same core runtime runs on browser
Web Workers and Node/Bun worker threads (Nodepod's `src/headless.ts` +
`src/host/`), which gives a real-Node test lane for free.

### 5. Host runtime product surface

The public surface host developers actually touch — lifecycle, previews,
and the process story. Technique references in
`docs/COMPETITOR_TECHNIQUES.md`.

- **Lifecycle API docs (must):** explicit boot/teardown promises, exit
  codes, `server-ready` events, preview URL scheme — the product surface we
  don't have yet (WebContainers' public docs are the template).
- **Preview routing (must):** Service-Worker `/__virtual__/{port}/` route so
  guest servers are real navigable URLs. Patching `fetch` only covers
  programmatic requests from JS — the SW route covers address-bar
  navigation, iframes, and new-tab previews.
- **Worker-backed spawn (must):** stdio streaming, signals, exit codes —
  workers boot from a VFS snapshot and receive changes over a VFS bridge
  (Nodepod's `process-manager.ts` + `process-worker-entry.ts`). The honest
  process story.
- **DNS-over-HTTPS (must):** real DNS against
  `https://cloudflare-dns.com/dns-query` for `dns.js` — no inventing
  answers (Nodepod's `dns.ts`).
- **Fetch platform-layer audit (must):** check whether our iframe realm
  needs the browser `fetch`/`Headers`/`Response` patched to Node 20 undici
  behavior (set-cookie handling, Headers parity — Nodepod's
  `fetch-response.ts`).
- **`forwardPreviewErrors`** pattern for preview error surfacing
  (WebContainers).
