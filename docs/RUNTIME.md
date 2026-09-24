# Runtime integration — how `runtime.js` loads and runs our shims

`runtime.js` (repo root, ~8.7k lines) is Jared's host: a `CodeSandbox` class that
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
   HTML. The bootstrap installs the runtime object under the Symbol key
   `Symbol.for('bvm.runtime.<uuid>')` (non-enumerable — see "Symbol-backed
   runtime globals"), the module system (`loadModule`,
   `transformImportsToLoadModule`, `_build_file` / `_dynamic_import`
   interop handlers), the process shim, the terminal, and network
   wrappers — then runs the user code.
3. Any `import … from "node:fs"` (or `"fs"`) in user code is rewritten to
   `await globalThis[Symbol.for("bvm.runtime.<uuid>")].loadModule("fs")`.
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

`replaceGlobalThisVar(source, "_RUNTIME_", { replacement: 'globalThis[Symbol.for("bvm.runtime.<uuid>")]' })`
walks the AST and replaces **only** `MemberExpression`s of the exact shape
`globalThis._RUNTIME_`. Consequences:

- Write `globalThis._RUNTIME_.__FS__` in shims — it becomes
  `globalThis[Symbol.for("bvm.runtime.<uuid>")].__FS__` per sandbox. ✅
- Write bare `_RUNTIME_` — it is **not** rewritten and throws at runtime. ❌
- Guards like `typeof globalThis._RUNTIME_ !== "undefined"` are rewritten too,
  so they keep working inside the sandbox and protect us outside it (parity
  tests under real Node, direct imports).

## Symbol-backed runtime globals

The per-sandbox runtime object and the interop channel live under Symbol
keys, not string keys:

- `Symbol.for('bvm.runtime.<uuid>')` — the runtime object (`process`,
  `__FS__`, `loadModule`, …). Installed via `Object.defineProperty` as
  **writable, configurable, non-enumerable**.
- `Symbol.for('bvm.interop')` — the `_dynamic_import` interop channel.

The point is **string-key enumeration hiding, not secrecy**: `Object.keys`,
`for…in`, `JSON.stringify`, and the `in` operator never surface these keys,
so casual inspection of `globalThis` doesn't reveal runtime internals. The
UUID is visible in the generated script source, so devtools can always
reconstruct the key — `Object.getOwnPropertySymbols` / `Reflect.ownKeys`
are deliberately *not* patched. Non-enumerable also keeps the keys out of
`Object.assign` / spread copies.

## Special runtime variables

These live on the Symbol-keyed runtime object
(`globalThis[Symbol.for('bvm.runtime.<uuid>')]`):

| Variable | Set by | Notes |
|---|---|---|
| `.process` | host config | `title, arch, env, platform, pid, ppid, argv, argv0, execPath, execArgv, version, versions`. JSON-serialised into the iframe at bootstrap. |
| `.__USER_FILES__` | host config | seed files `{ path: contents }`; also fed to `_dynamic_import` for VFS module resolution. |
| `.__FS__` | **our `src/fs.js`** | singleton virtual filesystem. The runtime reads it (cwd checks, `_getState`); other shims should reuse it, not create their own. |
| `.__httpServerRunTime` | **our `src/http.js`** | `{ handleRequest(port, url, method, body, headers), waitForAllServers() }`. The runtime's `__serverRequest__` interop calls `handleRequest` to deliver emulated inbound HTTP requests to servers created via `http.createServer`. |
| `.taskTracker` | runtime (`GlobalTracker`) | wraps async work (`track/patch/start/stop`); `waitForIdle()` lets the host know when the sandbox is quiescent. |
| `.loadModule(name)` | runtime | load another builtin by bundle key (e.g. `"fs"`, `"timers_promises"`). Prefer this over relative imports for cross-builtin deps. |
| `.emit` / `globalThis.emitMe` | runtime | forwards console calls and events to the parent frame via `postMessage`. |
| `.globals` | runtime | `Set` of getter-backed host globals captured at bootstrap (sandboxing aid). |
| `._TEST_RUNNER_` | runtime | `node:test` runner instance, loaded on demand. |
| `.__RUNTIME_RESOLVE__HANDLE` | our `src/runtime/importMetaResolver.js` | backs `import.meta.resolve`. |
| `.coverage` | runtime (optional) | lcov-style coverage hooks. |

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

## Console, timers, network, terminal

- **Console**: `emitMe` → `sendConsoleMessage` → `window.parent.postMessage({ type: "console", … })`.
  The runtime may wrap or restore the host console around execution.
- **Timers**: `setTimeout`/`clearTimeout`/etc. are wrapped to feed the task
  tracker; `waitForAllTimers()` drains them at shutdown.
- **Network**: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, and
  `navigator.sendBeacon` are wrapped (`wrapNetwork`) so the host can observe/
  block; `connect-src *` in the CSP permits real outbound requests.
- **Terminal**: a DOM REPL with `toNodeKeypress` (DOM key events → Node-style
  keypress objects with ANSI sequences), `getStdin`/`makeOutputShim` streams.
  `src/readline.js` should integrate with these stdin/stdout shims.

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
