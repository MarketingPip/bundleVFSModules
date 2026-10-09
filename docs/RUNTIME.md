# Runtime integration — how `runtime.js` loads and runs our shims

`runtime.js` (repo root, ~9.7k lines) is Jared's host: a `CodeSandbox` class that
executes user JavaScript inside a sandboxed **iframe** and makes Node builtins
available by loading **this repo's** bundled shims. Our code is the guest; the
runtime is the landlord. This document is the contract between them, verified
against the actual `runtime.js` source.

## Big picture

1. Host page creates `new CodeSandbox(...)` with a config: `{ uuid, process: {...}, fs: {...} }`.
2. `SandboxRuntime.generate(code, config)` takes the sandbox template
   (`src/sandbox-template.js` — built from the authored fragments in
   `src/sandbox/*.js`, see "Sandbox template build" below), replaces its
   `%%TOKEN%%` placeholders with per-sandbox values, and builds the iframe
   HTML. The bootstrap installs the runtime object under the uuid-mangled
   string key `globalThis._RUNTIME<uuid>_` (see "Runtime-object and interop
   keys"), the module system (`loadModule`,
   `transformImportsToLoadModule`, `_build_file` / `_dynamic_import`
   interop handlers), the process shim, the terminal, and network
   wrappers — then runs the user code.
3. Any `import … from "node:fs"` (or `"fs"`) in user code is rewritten to
   `await globalThis._RUNTIME<uuid>_.loadModule("fs")`.
4. `loadModule` asks the parent frame (`_dynamic_import` interop) for the
   module source. For builtins the parent returns `sandboxModules["fs"]` —
   our `dist/vfs.js` bundle, fetched from jsDelivr and pinned to a commit.
   Unknown builtins resolve to `export default {}`.
5. `_build_file` then transforms the source: CJS→ESM conversion when needed,
   `globalThis._RUNTIME_` → `globalThis._RUNTIME<uuid>_`, recursive
   import→`loadModule` rewriting. Circular imports get Node-style partial
   exports via a module registry.

## Sandbox template build

The sandbox bootstrap script is **not** hand-written in `runtime.js`. The
authored source is the ordered fragments in `src/sandbox/*.js`
(`// SANDBOX SECTION` headers; execution order is the manifest in
`src/build-sandbox.mjs`), which build `src/sandbox-template.js`:

- `npm run build:sandbox` — concatenate fragments, rewrite `__TOKEN__`
  placeholders to `%%TOKEN%%`, inline a freshly esbuild-bundled cookie-jar
  IIFE (`src/sandbox/cookie-entry.js` bundles `src/cookieJar.js` + its npm
  deps into a self-contained IIFE), validate, and write
  `src/sandbox-template.js`.
- `npm run check:sandbox` — fail if the checked-in template differs from a
  fresh build. The build is deterministic (no timestamps); two consecutive
  builds are byte-identical.

The build validates twice: the concatenated fragments must parse as JS
*before* token rewriting, and the final template must parse *after*
`%%TOKEN%%` substitution (inert dummies per token kind, mirroring what
`generate()` injects) and cookie-IIFE inlining. `SandboxRuntime.generate()`
then does single-pass `%%TOKEN%%` replacement at runtime (`%%USER_CODE%%`
last, so user code containing `%%…%%`-like text is never replaced).

The fragments are the source of truth — edit them, rebuild, commit the
template. (The old reverse-extraction script `src/extract-sandbox.py` was
removed: it would clobber authored fragments with stale output.)

## The `_RUNTIME_` rewrite (the one rule that matters)

`replaceGlobalThisVar(source, "_RUNTIME_", { replacement: 'globalThis._RUNTIME<uuid>_' })`
walks the AST and replaces **only** `MemberExpression`s of the exact shape
`globalThis._RUNTIME_`. Consequences:

- Write `globalThis._RUNTIME_.__FS__` in shims — it becomes
  `globalThis._RUNTIME<uuid>_.__FS__` per sandbox. ✅
- Write bare `_RUNTIME_` — it is **not** rewritten and throws at runtime. ❌
- Guards like `typeof globalThis._RUNTIME_ !== "undefined"` are rewritten too,
  so they keep working inside the sandbox and protect us outside it (parity
  tests under real Node, direct imports).

## Runtime-object and interop keys

The per-sandbox runtime object lives under a uuid-mangled **string** key;
only the interop channel is Symbol-backed:

- `globalThis._RUNTIME<uuid>_` — the runtime object (`process`,
  `__FS__`, `loadModule`, …). Plain per-sandbox assignment (enumerable),
  installed in each sandbox's own realm. The template also installs the
  stable alias `globalThis._RUNTIME_` for platform shims whose
  `globalThis._RUNTIME_` references are not AST-rewritten (e.g.
  VFS-loaded CJS).
- `Symbol.for('bvm.interop')` — the `_dynamic_import` interop channel.

The Symbol key exists for **string-key enumeration hiding, not secrecy**:
`Object.keys`, `for…in`, `JSON.stringify`, and the `in` operator never
surface `bvm.interop`, so casual inspection of `globalThis` doesn't reveal
the interop channel. `Object.getOwnPropertySymbols` / `Reflect.ownKeys`
are deliberately *not* patched.

## Special runtime variables

These live on the per-sandbox runtime object
(`globalThis._RUNTIME<uuid>_`). The per-sandbox
singletons among them (`__FS__`, `__httpServerRunTime`) are documented
with their lifecycle rules in `docs/SINGLETONS.md`.

| Variable | Set by | Notes |
|---|---|---|
| `.process` | host config | `title, arch, env, platform, pid, ppid, argv, argv0, execPath, execArgv, version, versions`. JSON-serialised into the iframe at bootstrap. |
| `.__USER_FILES__` | host config | seed files `{ path: contents }`; also fed to `_dynamic_import` for VFS module resolution. |
| `.__FS__` | **our `src/fs.js`** | singleton virtual filesystem. The runtime reads it (cwd checks, `_getState`); other shims should reuse it, not create their own. |
| `.__httpServerRunTime` | **our `src/http.js`** | `{ handleRequest(port, url, method, body, headers), waitForAllServers(), closeServer(port) }`. The runtime's `__serverRequest__` interop calls `handleRequest` to deliver emulated inbound HTTP requests to servers created via `http.createServer`; `closeServer` forcibly closes the server on a port (host revokes a lost port claim). |
| `.taskTracker` | runtime (`GlobalTracker`) | wraps async work (`track/patch/start/stop`); `waitForIdle()` lets the host know when the sandbox is quiescent. |
| `.loadModule(name)` | runtime | load another builtin by bundle key (e.g. `"fs"`, `"timers_promises"`). Prefer this over relative imports for cross-builtin deps. |
| `.emit` / `globalThis.emitMe` | runtime | forwards console calls and events to the parent frame via `postMessage`. |
| `.globals` | runtime | `Set` of getter-backed host globals captured at bootstrap (sandboxing aid). |
| `._TEST_RUNNER_` | runtime | `node:test` runner instance, loaded on demand. |
| `.__RUNTIME_RESOLVE__HANDLE` | our `src/runtime/importMetaResolver.js` | backs `import.meta.resolve`. |
| `.coverage` | runtime (optional) | lcov-style coverage hooks. |

## `require()` semantics

`transformImportsToLoadModule` (in `runtime.js`) rewrites every `require()`
call site; there is no global `require` in the sandbox. The rules, verified
by `tests/ondemand-require.test.js` (transform + extracted runtime unit
tests) and `tests/ondemand-require-e2e.py` (headed-Firefox browser matrix):

- **Top-level `require("builtin")`** (including inside a top-level block,
  even a dead one like `if (false) { … }`) is hoisted: the preamble gets
  `const __lm_x = await loadModule("builtin", "require", …)` and the call
  site becomes `(__lm_x && __lm_x.default !== undefined ? __lm_x.default
  : __lm_x)`. It is **eager** — the module loads at init whether or not the
  code path runs.
- **Builtin `require()` nested in a function** rewrites to
  `__bvmRequireSync("builtin")` — nothing loads until the function is
  called (Worker B on-demand design).
- **`__bvmRequireSync` contract: sync-when-warm, promise-when-cold.** A
  cache hit in `_builtinCache` returns the module synchronously (same
  `_builtinRequireValue` unwrap the sync builtin consumers use). A cold
  builtin **triggers `loadModule()` and returns its promise** — the caller
  awaits it. True lazy-on-call with a synchronous return is impossible: JS
  has no primitive that blocks the event loop on a promise, so a sync
  `require()` can never wait for the async loader. Once the load completes,
  `loadModule`'s `_builtinCache` hook makes every later `require()` of that
  builtin synchronous, so the warm contract is unchanged. Concurrent cold
  requires share one in-flight promise (`_bvmRequirePending`, keyed by
  manifest key) and resolve to the same instance; a failed load deletes its
  pending entry so the next call retries instead of caching a rejection.
  The cold path calls `loadModule` via `globalThis._RUNTIME_.loadModule`,
  not the bare identifier: the bare top-level `loadModule` binding is not
  reliably resolvable from `__bvmRequireSync`'s scope in the
  es-module-shims-executed sandbox module (verified live 2026-10-09:
  `typeof loadModule === "undefined"` while
  `globalThis._RUNTIME_.loadModule === "function"`). The runtime-object
  property path is the same one the transform emits for imports.
- **Dynamic `require(name)`** (non-literal specifier, including template
  literals) rewrites the callee to `__bvmRequireSync(name)` and resolves at
  runtime as above. A specifier that is not a manifest builtin throws
  `ERR_REQUIRE_ASYNC_MODULE` — dynamic require of non-builtins has no sync
  path; use `import()`.
- **Identity across paths.** `await import("x")` populates `_builtinCache`
  via the `loadModule` hook, so a later `require("x")` returns the **same
  instance** (`import * as ns` / `require("x")` are `===`, including named
  exports). Builtins canonicalize to the modulePath registry key
  (`resolvedPath` is null), so a `require()` racing an `import()` dedupes to
  a single evaluation; `diagnostics_channel`'s registry is a singleton
  across both paths (each module is evaluated exactly once).
- **Live bindings are NOT supported.** Named imports destructure at import
  time (`const { x } = __lm`), and the interop proxy snapshots export values
  at load (`Object.assign({}, data)`), so `export let` reassignment *inside*
  a shim is invisible to importers (verified: `node:domain`'s `active` stays
  `null` through the proxy after `enter()`). Same-object mutation through a
  shared namespace *is* visible — that is identity, not live bindings.
- **Sandbox identity caveat.** Every `dist/` entry is bundled independently
  (esbuild `bundle: true, external: []` per entry in `src/build-vfs.mjs`),
  so each bundle inlines its own dependency copies:
  `require("buffer").Buffer !== globalThis.Buffer` (the latter is
  `RUNTIME:NODE_GLOBALS`' inlined copy; the bundle's class is even minified
  to `je`). Both are sandbox-scoped and fully functional — neither is the
  host's (the browser host has no `Buffer`) — but cross-bundle class
  identity does not hold.

## The process shim

The runtime installs its **own** `globalThis.process` (and non-configurable
`window.process`) built from `config.process`: every function is cloaked so
`fn.toString()` returns `function name() { [native code] }`, and the object
carries `Symbol.toStringTag: 'Process'`. It also wires `process.stdin/stdout/
stderr` to the DOM terminal shims and `process.hrtime.bigint` to
`performance.now()`.

Our `src/process.js` is **not** that object — it only serves explicit
`import "node:process"`. It must mirror the same values (read them from
`globalThis._RUNTIME_.process`, with guards for standalone use).

## `node:test` auto-run contract (`--test`)

The `--test` auto-run trigger lives in the shim (`src/test.js`
`_maybeAutoRun`), not in the runtime template. The template no longer
intercepts `--test` — imports are always injected and user code always runs
the normal `await (async () => { code })()` path.

- **Host lane** (sandbox, `globalThis._RUNTIME_` installed by the host):
  registered tests auto-run **only when `--test` appears in
  `process.argv`** (Node parity with `node --test`; the playground's argv
  box feeds `config.process.argv`). Without it, tests register but do not
  run. `globalThis.__VITEST_SHIM_MANUAL__ = true` opts out even with
  `--test`. Gates are re-checked when the debounced `setImmediate` fires,
  since flags may change between scheduling and firing.
- **Real-Node lane** (no host): auto-runs unconditionally. The parity
  harness's `{ parityForceShim: true }` `_RUNTIME_` marker is explicitly
  excluded from the host lane, so `parity/run.mjs` (which spawns children
  with no `--test` flag) keeps working.
- **Reporting**: the shim parses `--test-reporter <v>` /
  `--test-reporter=<v>` from `process.argv` (comma-separated, default
  `['spec']`; unknown names warn and fall back to `spec` via the existing
  `_resolveReporter`). Tests run once; the collected events are formatted
  through each reporter (shared `_formatEvents` helper, also used by
  `execute()`) and each output is `console.log`ed. The sandbox completion
  gate is held (`_RUNTIME_.taskTracker.start()` before the run,
  `.stop()` in a `finally` after printing — guarded, the tracker may be
  null), and `process.exitCode = 1` when any test fails.
- `_TEST_RUNNER_` stays installed by the shim (guarded on
  `globalThis._RUNTIME_`) as the host integration point; `execute()`
  remains a public API that disables auto-run for the instance.

## Console, timers, network, terminal

- **Console**: `emitMe` → `sendConsoleMessage` → `window.parent.postMessage({ type: "console", … })`.
  The runtime may wrap or restore the host console around execution.
- **Timers**: `setTimeout`/`clearTimeout`/etc. are wrapped to feed the task
  tracker; `waitForAllTimers()` drains them at shutdown.
- **Network**: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, and
  `navigator.sendBeacon` are wrapped (`wrapNetwork`) so the host can observe/
  block; `connect-src *` in the CSP permits real outbound requests.
- **Terminal**: a DOM REPL with `toNodeKeypress` (DOM key events → Node-style
  keypress objects with ANSI sequences), `process.stdin`/`makeOutputShim` streams.
  `src/readline.js` should integrate with these stdin/stdout shims.

### Completion model — what sets the playground status to "Done"

After user code finishes, the sandbox does **not** resolve immediately. The
drain sequence lives in the `_build_file` execution wrapper in `runtime.js`:

1. **Micro/macrotask drain** — one `await Promise.resolve()` plus one 100 ms
   `setTimeout`, so cascading async work gets a chance to start.
2. **Parallel gates** (`Promise.all`):
   - `taskTracker.waitForAll()` — the `GlobalTracker`'s wrapped async work.
   - `waitForAllFetches()` — the patched `fetch` registers every call in
     `pendingFetches` at **call time**, so an *unawaited* `fetch()` still
     holds completion until it settles. `Promise.allSettled` semantics:
     a failed fetch does not block completion.
   - `waitForAllXhrs()` — same tracking for `XMLHttpRequest`.
   - `waitForAllTimers()` — polls `timerRegistry` every 50 ms until no
     timeout/interval entries remain. A live `setInterval` holds completion
     until `clearInterval`.
   - `__httpServerRunTime.waitForAllServers?.()` — resolves when the
     server registry empties; a listening `http.createServer` holds
     completion until `server.close()` (see `docs/SINGLETONS.md` rule 5).
3. **Sequential stdin gate** — `process.stdin.waitUntilNoListeners()`, run
   *after* the parallel gates so late-attaching listeners are seen.
   Event-driven, no polling: with no `data`/`end`/`close`/`error`/`keypress`
   listeners it resolves immediately; otherwise it waits for the stdin
   `removeListener` event (`_checkResolve`). Release paths:
   `process.stdin.end()`/`destroy()` (sets `_ended`), or all listeners
   removed. A program blocked on readline/stdin input therefore stays out
   of "Done" until input arrives **and** the stdin hold is released.
4. `function_results` is posted → the host resolves `{success: true}` →
   the playground shows **Done**.

**`process.exit(code)`** bypasses the gates: both the bare `process` global
and `import "node:process"` post the `kill` interop, the host resolves
`{success: true, logs: [...logs, "Process Exited"]}`, and the playground
shows **Done**. Asymmetry to remember: a *thrown* error posts
`function_error` → `{success: false}` → the playground shows **Error**.

## Content Security Policy

The iframe runs under a CSP equivalent to:

```
default-src 'none';
script-src 'unsafe-eval' 'unsafe-inline' data: blob: https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com;
script-src-elem 'self' 'unsafe-inline' blob: data: https://esm.sh … https://ga.jspm.io;
worker-src blob: data:;
connect-src * data: blob:;
img-src 'self' data:;
style-src 'unsafe-inline'
```

What this buys our shims:

- `'unsafe-eval'` — `eval` / `new Function` work → a faithful `vm` module is feasible.
- `worker-src blob: data:` — workers can be spawned from blob URLs → `worker_threads` via blob workers is feasible.
- `connect-src *` — real `fetch`/WebSocket to anywhere → `https` client, `dns` over DNS-over-HTTPS.
- No raw sockets/UDP → `net`/`dgram`/`tls` servers stay emulated or noop.

## Web workers (aspirational)

Today the sandbox is iframe-only; the bootstrap itself references `window`
(e.g. `Object.defineProperty(window, "process", …)`), so full worker support
needs runtime-side changes too. Shim-side, the rule is simple: no
`window`/`document` at module scope, use `globalThis`, feature-detect browser
APIs. `MessageChannel`/`postMessage` code paths should be written so they can
move to a worker later.

## `RUNTIME:NODE_GLOBALS`

Bundle key `RUNTIME_NODE_GLOBALS` → `src/node_globals.js`, loaded once at
sandbox startup (`loadModule("RUNTIME:NODE_GLOBALS")`). It installs the
Node-global surface: `Buffer`, `setImmediate`/`clearImmediate`,
`queueMicrotask` fallback. Anything that must exist as a bare global (not via
import) belongs here.

## Version pinning

`runtime.js` imports `dist/vfs.js` from jsDelivr **pinned to a commit**
(`…/bundleVFSModules@<sha>/dist/vfs.js`). Shipping a shim means: merge the PR,
rebuild `dist/`, and (separately) bump the pin in `runtime.js`.
