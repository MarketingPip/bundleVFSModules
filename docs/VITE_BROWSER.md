# Running Vite 7 in the Browser Runtime

How real Vite 7.3.6 executes inside the bundleVFSModules browser sandbox —
what runs, what is intercepted, and what is still missing.

## Principle

**Emulate the environment, run the real compute.** Node platform APIs
(`fs`, `path`, `process`, timers) are emulated by our shims — they are
interfaces to the environment with small, documented contracts. Compute
engines (Rollup, esbuild) run as their real implementations: faking a
bundler means reimplementing a bundler, which produces subtly wrong output
for every real app. There is exactly one Rollup; there is no honest shim
for it.

## Stack

| Component      | Version  | Form in browser                              |
|----------------|----------|----------------------------------------------|
| Vite           | 7.3.6    | Real package, loaded from VFS into sandbox   |
| Vitest         | 5.0.2    | Real package, loaded from VFS into sandbox   |
| Rollup         | 4.63.5   | `@rollup/browser` ESM build, WASM backend    |
| esbuild        | 0.28.2   | `esbuild-wasm` via `src/vendor/esbuild-shim.cjs` |

Vite 8 / Rolldown are deferred until the Vite 7 path is fully green.

## Where each engine fires in `vite.build()`

**Rollup** — the build itself. Vite hands its plugin pipeline to
`rollup()`: module resolution, loading, per-file transforms, module graph,
tree-shaking, chunking, output generation. No Rollup = no output. This is
the `@rollup/browser` WASM doing real work.

**esbuild** — three call sites, all optional:

1. **TS/JSX transpile** — Vite's `vite:esbuild-transpile` plugin calls
   `esbuild.transform()` per file, but only for `.ts` / `.tsx` / `.jsx`.
   Plain `.js` never triggers it.
2. **JS minify** — `build.minify` defaults to `'esbuild'`; minifies each
   chunk after Rollup emits them.
3. **CSS minify** — defaults to esbuild in Vite 7.

## Interception points

### Rollup ESM redirect

Vite's `import ... from "rollup"` (and `createRequire(import.meta.url)("rollup")`)
is intercepted at module load:

```js
const ROLLUP_BROWSER_MAIN =
  "/node_modules/@rollup/browser/dist/es/rollup.browser.js";
```

The CJS `dist/rollup.browser.js` fails ESM named linkage
(`The requested module 'rollup' does not provide an export named 'rollup'`);
the ESM build provides `VERSION`, `defineConfig`, and `rollup` correctly.

### Rollup WASM as data URL

`@rollup/browser` ships its compiler as a 580,572-byte WASM binary. Because
transformed modules execute from `data:` URLs, the WASM is embedded as a
`data:application/wasm;base64,...` URL. This is currently done in the
harness seed generator; it belongs in a general canonical
runtime/package-loading mechanism (open item).

### esbuild shim

`src/vendor/esbuild-shim.cjs` wraps `esbuild-wasm`. It must run with
`worker: true` and a Blob worker URL — the main-thread Go runtime hangs in
the sandbox; the worker path initializes (all 6 init steps complete).

## Minification status (2026-09-29, updated)

`build.minify: "esbuild"` hangs: `esbuild-wasm`'s `initialize()` succeeds
but `transform()` never resolves inside the sandbox worker — a deep issue in
esbuild-wasm's Go runtime worker communication, not in our shim. The
`worker: false` path also hangs (during init).

**Resolved via terser (2026-09-29):** `vite.build({ minify: "terser" })`
works in headed Firefox — 6530 ms, emits a minified chunk (41 chars vs 100
unminified, comments stripped), and the chunk executes the fixture's real
behavior. Real Terser 5.51.2 (pure JS, no WASM, no worker). Three
platform-general fixes were needed (PR #133): absolute VFS paths in
`loadModule`/`_dynamic_import`, `file://` URL normalization, and the
es-module-shims resolve hook now intercepts `file://` URLs (any `file://`
import was broken, not just terser's).

`minify: false` remains the known-working plain-JS path; `minify: "terser"`
is the minification path. Only revisit esbuild-wasm if a real TS fixture
demands the transpile path — `vite:esbuild-transpile` never fires for plain
JS.

## The `_RUNTIME_` alias (M3 blocker, fixed 2026-09-29)

The sandbox template created only the UUID-suffixed
`globalThis._RUNTIME_<uuid>_`. Platform shims (`esbuild-shim.cjs`,
`browser-builds.js`, `fs.js`) write the stable `globalThis._RUNTIME_` path
per the runtime contract, but the AST rewrite mapping `_RUNTIME_` to the
UUID-specific name only applies to Node builtins — not VFS-loaded CJS.
Result: `[vite:esbuild-transpile] esbuild-shim: browser runtime VFS
(globalThis._RUNTIME_.__FS__) is not available`.

Fix (`runtime.js`, `SandboxRuntime.generate()`): expose a stable alias per
realm —

```js
globalThis._RUNTIME_ = globalThis._RUNTIME_<uuid>_;
```

Each sandbox has its own realm, so isolation is preserved. TDD'd in
`tests/vite7-runtime-alias.test.js`.

## Milestones

- **M3** (2026-09-29): real `vite.build()` in headed Firefox — 5060 ms,
  emits 1 chunk (`assets/main-Dek8wJvI.js`), verdict `ok:true`.
  Pushed on `feat/vite7-browser`.
- **M4** (2026-09-29): real Vitest 5.0.2 in headed Firefox — 1 suite,
  1 test, 1 passed, via genuine `expect(add(1,2)).toBe(3)` through Vitest's
  actual matcher code.

## Open items

- ~~`minify: "esbuild"` hangs → terser evaluation~~ — **done 2026-09-29:**
  `minify: "terser"` works (PR #133).
- ~~`expect-type` stubbed~~ — **done 2026-09-29:** general TypeScript CJS
  interop in the transformer; M4 re-verified stub-free (PR #132).
- Rollup WASM data-URL embedding should move from the harness seed
  generator into the canonical runtime package-loading path.
- Red-first test proving the Rollup ESM interception target and named
  exports.
