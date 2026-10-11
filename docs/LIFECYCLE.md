# CodeSandbox Lifecycle API

The product surface for booting, running, and tearing down sandboxes.

Source of truth: the `CodeSandbox` class in `src/runtime/code-sandbox.js`
(verbatim extraction; assembled into `runtime.js` at the repo root) and
`src/runtime/execution-context.js` (the `ExecutionContext` that owns the
iframe and the postMessage bridge). Everything marked **gap** is an API the
roadmap asks for that does not exist yet — it is documented here as missing,
not invented.

Companion docs (linked, not duplicated):

- `docs/EVENTS.md` — the full event catalog with per-event payload shapes
- `docs/INTEROP.md` — the sandbox↔host RPC channel, incl. the
  `__serverRequest__` flow this document refers to
- `docs/PREVIEW_ROUTING.md` — the `/__virtual__/{port}/` preview route in
  depth

## Creating a sandbox

```js
import { CodeSandbox } from "./runtime.js";

const sb = new CodeSandbox({
  fs: { "/hello.js": "console.log('hi')" },
  shell: (cmd, args, opts) => ({ stdout: "", stderr: "", exitCode: 0 }),
});
await sb.init();
const result = await sb.execute(`import "/hello.js";`);
```

### Config options

Every option below is read verbatim from the `CodeSandbox` constructor
(`src/runtime/code-sandbox.js`). Options not listed here are not honored.

| Option | Type | Default | Notes |
|---|---|---|---|
| `fs` | `object` | `{}` | Seed files `{ path: contents }` → `__USER_FILES__` → guest memfs. `runWasi()` writes its post-run file snapshot back into this object |
| `process` | `object` | Node 20-like stub | Merged over defaults (`title`, `arch`, `env`, `platform`, `pid`, `version`, `stdout.columns/rows`, …) via `mergeProcess` |
| `shell` | `function \| null` | `null` | BYO shell: `shell(command, args, options)`. Serialized via `.toString()` into the sandbox, so it must be self-contained (no closure references). When absent, `child_process` shell calls throw |
| `plugins` | `array \| null` | `null` | Per-sandbox plugin list; shadows the global registry when provided |
| `timeout` | `number` | `30000` | Execution timeout (ms). `Infinity` is accepted ("Number or infity" per the code comment) |
| `cdnBase` | `string` | `"https://esm.sh"` | CDN for bare imports |
| `fallbackCDN` | `boolean` | `true` | Fall back to CDN when VFS lookup misses |
| `fileName` | `string` | `"index.js"` | Entry file name |
| `ecmaVersion` | `number` | `2022` | Parser target for transforms |
| `seaAssets` | `object` | `{}` | `node:sea` asset store, normalized by `normalizeSeaAssets()` |
| `iframeElement` | `string \| HTMLIFrameElement \| null` | `null` | Existing iframe or CSS selector. When provided, the sandbox adopts it and does NOT remove it on cleanup (`destroyIframe = false`); otherwise a fresh hidden iframe is created per `execute()` |
| `beforeExecute` | `function \| null` | `null` | Hook awaited before each `execute()`. Note: the constructor comment says `// array`, but `execute()` only honors it when `typeof === "function"` |
| `transformRules` | `array` | `[]` | Extra code transform rules |
| `codeTransformers` | `array` | `[]` | Extra code transformers |
| `interopVariable` | `string` | `"interop"` | Name of the interop global the guest uses to expose methods |
| `logNetworkRequests` | `boolean` | `false` | Forward guest network requests as `execution:network_request` events |
| `captureWindowErrors` | `boolean` | `true` | Forward `window.onerror` into the sandbox |
| `capturePromiseRejections` | `boolean` | `true` | Forward unhandled rejections |

### Config validation (throws synchronously)

| Condition | Error |
|---|---|
| `shell` is not a function | `TypeError: CodeSandbox option 'shell' must be a function` |
| `plugins` is not an array | `TypeError: CodeSandbox option 'plugins' must be an array` |
| Duplicate plugin names in `plugins` | `Error: Duplicate plugin name '<name>' in 'plugins' option` |
| `iframeElement` selector matches nothing | `Error: No element found for selector: <sel>` |
| `iframeElement` is neither string nor iframe | `Error: iframeElement must be a query selector string or an <iframe> element` |

## Boot sequence

```
new CodeSandbox(config)          // validates config, no I/O
        │
        ▼
await sb.init()                  // idempotent — second call is a no-op
        │
        ▼
"initialized" event              // { timestamp }
        │
        ▼
await sb.execute(code)           // creates the iframe (or adopts iframeElement),
                                 // SandboxRuntime.generate() builds the sandbox HTML,
                                 // ExecutionContext.inject() loads it
```

`init()` is deliberately thin: it flips the `initialized` flag and emits
`"initialized"`. It does **not** create the iframe and does **not** build
sandbox HTML — that happens inside each `execute()` call, which calls
`init()` itself when `initialized` is false. `init()` emitting `"error"`
(`{ type: "initialization", error }`) and rethrowing on failure exists in the
code, but there is no async work inside the current implementation that can
fail that way.

Each `execute()` creates a **fresh** `ExecutionContext` and, unless
`iframeElement` was provided, a fresh hidden iframe appended to
`document.body` (styled `position: absolute; width: 0; height: 0; border:
0;`). The previous context is overwritten on the instance
(`this._context`, `this.iframe`, and the bound `this.invoke`).

## Executing code

### `await sb.execute(code)`

Runs `code` in the sandbox. One `execute()` = one iframe, one execution id
(`this.executionCount` increments per call). Returns a promise that
**resolves** with one of these shapes:

**Success** (guest `function_results` message):
```js
{
  success: true,
  logs: [...],        // console.log arguments, in order
  errors: [...],      // console.error arguments, in order
  fs: {...},          // filesystem snapshot after execution
  executionTime: 123, // ms
}
```

**Guest threw** (`function_error` message — resolves, does NOT reject):
```js
{
  success: false,
  error: "ReferenceError: x is not defined",
  stack: "…mapped to original positions…",  // source-mapped via _sourceMapRegistry
  logs: [...],        // logs emitted before the throw
  executionTime: 45,
}
```

**Guest exited** (`process.exit(code)` → sandbox posts a `kill` message):
```js
{
  success: true,           // note: success is true
  error: false,
  logs: [...logs, "Process Exited"],
  executionTime: 12,
  exitCode: <code>,        // the code passed to process.exit()
}
```

**Force-killed** (`sb.kill()`, timeout, or codegen failure path):
```js
{
  success: false,
  killed: true,
  error: "Process killed by user" | "Execution timeout after 30000ms",
  stack: <reason>,
  logs: [...stdout, "Process Killed"],
  executionTime: 12,
}
```

**Rejection** happens only for host-side failures: code generation /
syntax-check errors in `execute()` (emits `execution:error`, then rejects),
and — in theory — the timeout path (but see the note below).

**Timeout note:** when the timer fires, `forceKill()` resolves the promise
with the killed shape *first*, then the timeout handler's explicit
`reject(new Error("Execution timeout …"))` is a no-op (a settled promise
can't re-settle). The observable sequence is: `execution:kill` →
`execution:complete` (with the killed result) → `execution:timeout`. The
`execute()` promise **resolves**, it does not reject on timeout.

### Exit codes

The only real exit-code path is guest-initiated: `process.exit(code)`
delivers `exitCode` in the killed-success result (see above). There are no
exit codes for host-killed runs, timeouts, or `runWasi()` aside — **`gap`**:
nothing like Node's `(code, signal)` close event exists on the host API.

### Convenience wrappers

- **`await sb.run(code)`** — `execute()` plus human-readable formatting.
  Returns a string like `"✓ Execution successful (12ms)\n<logs>"`.
- **`await sb.runWasi(bytes, options)`** — runs a WASI binary.
  `options.preopenDir` defaults to `"/sandbox"`; `options.args` and
  `options.env` pass argv/env. Returns
  `{ exitCode, stdout, stderr, files }` and writes the guest's file changes
  back into `config.fs` so later `execute()` calls see them. The WASI engine
  loads lazily on first use.
- **`await sb.typecheck(options)`** — runs the registered plugin's
  `typecheck` hook over the VFS. Returns `[]` when no plugin provides one.
  Never blocks `execute()`.

## Teardown

There is **no** `destroy()`, `close()`, `dispose()`, or `terminate()` method
— **`gap`**: no teardown promise exists. Teardown today is:

- **`sb.kill(reason)`** — force-kills the running execution. Returns
  `true` if a sandbox was running, `false` otherwise (logs a warning via
  `console.warn`, does not throw). The in-flight `execute()` resolves with
  the force-killed shape (`success: false, killed: true`, logs end with
  `"Process Killed"`). Emits `execution:kill` `{ id, reason, executionTime }`.
- **`sb.reset()`** — clears the import resolver cache and resets
  `executionCount` to 0. Emits `"reset"`. Does not touch the iframe.
- **Automatic iframe cleanup** — `ExecutionContext.cleanup()` runs on every
  completion path: when `destroyIframe` is true (the default — a fresh
  iframe per `execute()`), the iframe node is removed from the DOM. A
  user-supplied iframe (`iframeElement`, `destroyIframe = false`) is kept;
  `forceKill` instead navigates it to `about:blank`, which destroys the
  guest realm immediately. Cleanup also emits `execution:server`
  `{ type: "closed", port }` when a server was running, and unregisters the
  sandbox's virtual-server routes.

**Gap:** there is no way to fully release a `CodeSandbox` instance from
host code (no `destroy()` promise, no iframe disposal API for
host-created iframes beyond killing the execution). The instance simply
becomes inert once its execution completes.

## Events

`CodeSandbox` extends `EventEmitter`; subscribe with
`sb.on(event, handler)`. **The full catalog with payload shapes is
`docs/EVENTS.md`** — this document lists only the lifecycle-critical ones.
Event names are exact string literals from `runtime.js`.

| Event | Payload | When |
|---|---|---|
| `initialized` | `{ timestamp }` | `init()` completes (idempotent) |
| `execution:start` | `{ id, code: false }` | Guest iframe posted `sandbox_ready`. Note: `code` is always `false` today |
| `execution:stdout` | `{ type, args }` | Guest `console.log/info/debug/…` — `type` is the console method |
| `execution:stderr` | `{ type, args }` | Guest `console.error`/`console.warn` (derived alias; `execution:stdout` also fires) |
| `execution:server` | `{ type: "open", port }` | Guest server started listening |
| `execution:server` | `{ type: "closed", port }` | Guest server closed, or the sandbox was cleaned up while running |
| `execution:kill` | `{ id, reason, executionTime }` | `kill()` / `forceKill()` force-stopped a run |
| `execution:complete` | `{ id, result }` | An `execute()` resolved (success, guest error, guest exit, or killed) |
| `execution:error` | `{ id, error }` | An `execute()` rejected (host-side failure) |
| `execution:timeout` | `{ id }` | Execution exceeded `config.timeout` |
| `error` | `{ type, error }` | Initialization or runtime errors |
| `reset` | `{ timestamp }` | `reset()` called |
| `terminal:resize` | `{ cols, rows }` | `setTerminalSize()` succeeded |

**Note:** there is no `server-ready` event — **`gap`** (roadmap §5 asks for
one). The server lifecycle is reported via `execution:server` with
`type: "open"` / `"closed"`. Other emitted events not central to the
lifecycle (`execution:fs`, `execution:network_request`,
`execution:resource_timing`, `execution:key_event`,
`execution:readline_newline`, `execution:interop_registered`) are covered in
`docs/EVENTS.md`.

## Server lifecycle

When guest code calls `http.createServer().listen(port)`:

1. The sandbox notifies the host (`serverListening`).
2. The host emits `execution:server` with `{ type: "open", port }` and marks
   the context server-running (`sb.serverRunning()` returns `true`).
3. The port is claimed in the host route registry — **first claim wins**;
   a second sandbox listening on the same port gets `EADDRINUSE` (see
   `docs/SINGLETONS.md` rule 4).
4. When the server closes (or the sandbox is cleaned up), the host emits
   `execution:server` with `{ type: "closed", port }` and releases the claim.

Inbound requests reach the guest through the public
`sb.invoke("__serverRequest__", port, path, method, body, headers)` bridge
— the exact call shape, cookie-jar behavior, and the response object
(`{ statusCode, statusMessage, headers, body }`) are documented in
`docs/INTEROP.md` and are not repeated here.

## Preview URLs

Guest servers are real navigable URLs through the Service Worker route in
`src/plugins/preview-routing.js` (full details in
`docs/PREVIEW_ROUTING.md`). The scheme:

```
/__virtual__/{port}/{path}
```

e.g. a guest server on port 3000 with route `/api/users` is reachable at
`/__virtual__/3000/api/users` — address bar, iframe, new tab, `fetch`.

Host setup (all explicit; nothing auto-registers):

```js
import {
  registerPreviewSW,
  trackSandbox,
} from "./src/plugins/preview-routing.js";

// 1. Serve src/preview-sw.js at /__virtual__/preview-sw.js on the host origin.
// 2. Requires a secure context (HTTPS or localhost).
await registerPreviewSW(); // resolves with the registration once ACTIVE

// 3. Wire a sandbox's execution:server open/close events into the route registry.
const untrack = trackSandbox(sb);
```

`trackSandbox(sb)` registers a per-port handler on `execution:server`
`open` that calls `sb.invoke("__serverRequest__", port, path, method, body,
headers)` — the same bridge as the host fetch patch — and unregisters on
`closed`. Returns an `untrack()` function that removes the sandbox's routes.
Ports are first-claim-wins; an unclaimed port renders a 502 error page
(`buildPreviewErrorHtml`) instead of hanging, and a dead mid-flight handler
is dropped like the fetch bridge does.

**Gaps:** there is no `getPreviewUrl(port)` method on `CodeSandbox` — hosts
construct URLs by concatenating `/__virtual__/` + port + path themselves
(the `parsePreviewUrl()` helper parses, it doesn't build). There is no
`server-ready` event to await before navigating; hosts listen for
`execution:server` `{ type: "open" }`.

## Introspection

- **`sb.getStats()`** — `{ executionCount, initialized, config }`.
  `config` is a shallow copy.
- **`await sb.setTerminalSize(cols, rows)`** — requires a live sandbox
  (`invoke()` throws `"Sandbox is not running."` otherwise). Throws `Error`
  unless both args are positive integers. Invokes `__terminal_resize__` in
  the guest, emits `terminal:resize`, returns `{ cols, rows }`.
- **`sb.registerInterop(name, handler)`** /
  **`sb.unregisterInterop(name)`** — manage host-side interop handlers
  callable from guest code (return `this` for chaining).
- **`sb.invoke(method, ...args)`** — calls a sandbox-exposed method
  (default: a stub that throws `"Sandbox is not running."`; bound to the
  live context inside `execute()`). Rejects with `"Sandbox is not running."`
  when no execution is active, `"Interop invoke timeout: <method>"` after
  10s, or `"Interop method failed (sandbox is closed): <method>"` when the
  sandbox closed mid-call. After `execute()`, `sb.serverRunning()` and
  `sb.hasMethod(name)` are also bound to the last context.
- **`sb.uuid`** — the sandbox's unique id suffix (`_u_<uuid>`), used in the
  guest global name (`_RUNTIME<uuid>_`) and source-map registry keys.

## Error contract

| Situation | Behavior |
|---|---|
| Bad config option | Throws synchronously from the constructor |
| `init()` failure | Emits `"error"`, rethrows |
| Guest code throws | `execute()` **resolves** `{ success: false, error, stack }` — never rejects |
| `process.exit(code)` | `execute()` resolves `{ success: true, error: false, logs: [..., "Process Exited"], exitCode: code }` |
| `kill()` / timeout | Emits `execution:kill`, `execute()` resolves `{ success: false, killed: true, error: reason, … }` |
| `kill()` with no running sandbox | Returns `false`, logs a warning — does not throw |
| Code generation failure | Emits `"execution:error"`, rejects |
| `setTerminalSize()` invalid args | Throws `Error` |
| `invoke()` with no active execution | Throws `Error: Sandbox is not running.` |
| `invoke()` 10s without reply | Rejects `Interop invoke timeout: <method>` |

---

## API inventory (machine-readable)

The consistency test (`tests/lifecycle-docs.test.js`) parses this
section. Each entry must exist in `runtime.js`.

Methods on `CodeSandbox.prototype`:
- `constructor`
- `registerInterop`
- `unregisterInterop`
- `kill`
- `init`
- `execute`
- `run`
- `runWasi`
- `typecheck`
- `getStats`
- `reset`
- `setTerminalSize`

Events emitted (string literals in `runtime.js`):
- `initialized`
- `error`
- `reset`
- `terminal:resize`
- `execution:start`
- `execution:stdout`
- `execution:stderr`
- `execution:server`
- `execution:kill`
- `execution:complete`
- `execution:error`
- `execution:timeout`
- `execution:fs`
- `execution:network_request`
- `execution:resource_timing`
- `execution:key_event`
- `execution:readline_newline`
- `execution:interop_registered`

Config options validated in the constructor:
- `shell`
- `plugins`
- `iframeElement`
