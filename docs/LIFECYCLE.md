# CodeSandbox Lifecycle API

The product surface for booting, running, and tearing down sandboxes.
Every method, event, and config option below is verified against
`runtime.js` (`class CodeSandbox`, lines 8338–10311). Anything marked
**planned** does not exist yet.

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

| Option | Type | Default | Notes |
|---|---|---|---|
| `fs` | `object` | `{}` | Seed files `{ path: contents }` → `__USER_FILES__` → `RT.__FS__` |
| `process` | `object` | Node 20-like stub | Merged over defaults (`title`, `arch`, `env`, `platform`, `pid`, `version`, …) |
| `shell` | `function \| null` | `null` | BYO shell: `shell(command, args, options)`. Must be self-contained (serialized via `.toString()`). If absent, `child_process` calls throw. |
| `plugins` | `array \| null` | `null` | Per-sandbox plugin list; shadows the global registry when provided |
| `timeout` | `number` | `30000` | Execution timeout (ms) |
| `cdnBase` | `string` | `"https://esm.sh"` | CDN for bare imports |
| `fallbackCDN` | `boolean` | `true` | Fall back to CDN when VFS lookup misses |
| `fileName` | `string` | `"index.js"` | Entry file name |
| `ecmaVersion` | `number` | `2022` | Parser target for transforms |
| `seaAssets` | `object` | `{}` | `node:sea` asset store |
| `iframeElement` | `string \| HTMLIFrameElement \| null` | `null` | Existing iframe or CSS selector; a fresh iframe is created when omitted |
| `beforeExecute` | `array \| null` | `null` | Hooks run before each execution |
| `transformRules` | `array` | `[]` | Extra code transform rules |
| `codeTransformers` | `array` | `[]` | Extra code transformers |
| `interopVariable` | `string` | `"interop"` | Name of the interop global |
| `logNetworkRequests` | `boolean` | `false` | Log outbound network requests |
| `captureWindowErrors` | `boolean` | `true` | Forward `window.onerror` into the sandbox |
| `capturePromiseRejections` | `boolean` | `true` | Forward unhandled rejections |

### Config validation (throws synchronously)

| Condition | Error |
|---|---|
| `shell` is not a function | `TypeError: CodeSandbox option 'shell' must be a function` |
| `plugins` is not an array | `TypeError: CodeSandbox option 'plugins' must be an array` |
| Duplicate plugin names in `plugins` | `Error: Duplicate plugin name '<name>' in 'plugins' option` |
| `iframeElement` selector matches nothing | `Error: No element found for selector: <sel>` |
| `iframeElement` is neither string nor iframe | `Error` (invalid element type) |

## Boot sequence

```
new CodeSandbox(config)          // validates config, no I/O
        │
        ▼
await sb.init()                  // idempotent — second call is a no-op
        │  creates (or adopts) the iframe
        │  builds the sandbox HTML via SandboxRuntime.generate()
        │  installs the Symbol-keyed runtime object
        ▼
"initialized" event              // { timestamp }
```

`init()` emits `"error"` (`{ type: "initialization", error }`) and
rethrows if bootstrap fails. `generate()` is a static on
`SandboxRuntime` (not `CodeSandbox`) — hosts don't call it directly.

## Executing code

### `await sb.execute(code)`

Runs `code` in the sandbox. Returns a promise of:

**Success:**
```js
{
  success: true,
  logs: [...],        // console.log arguments, in order
  errors: [...],      // console.error arguments, in order
  fs: {...},          // filesystem snapshot after execution
  executionTime: 123, // ms
}
```

**Failure (thrown error in guest code):**
```js
{
  success: false,
  error: "ReferenceError: x is not defined",
  stack: "…mapped to original positions…",  // source-mapped
  logs: [...],        // logs emitted before the throw
  executionTime: 45,
}
```

**Killed (via `kill()`):**
```js
{
  success: true,           // note: success is true
  error: <reason> | false,
  logs: [..., "Process Exited"],
  executionTime: 12,
  exitCode: null,
}
```

### Convenience wrappers

- **`await sb.run(code)`** — `execute()` plus human-readable formatting.
  Returns a string like `"✓ Execution successful (12ms)\n<logs>"`.
- **`await sb.runWasi(bytes, options)`** — runs a WASI binary.
  `options.preopenDir` defaults to `"/sandbox"`. The WASI engine loads
  lazily on first use.
- **`await sb.typecheck(options)`** — runs the registered plugin's
  `typecheck` hook over the VFS. Returns `[]` when no plugin provides
  one. Never blocks `execute()`.

## Events

Subscribe with `sb.on(event, handler)` (CodeSandbox extends EventEmitter).

| Event | Payload | When |
|---|---|---|
| `initialized` | `{ timestamp }` | `init()` completes |
| `execution:start` | `{ id, code }` | An `execute()` begins |
| `execution:stdout` | `{ type, args }` | Guest `console.log/info/debug` — `type` is the console method |
| `execution:stderr` | `{ type, args }` | Guest `console.error`/`console.warn` (derived alias; `execution:stdout` also fires) |
| `execution:server` | `{ type: "open", port }` | Guest server started listening |
| `execution:server` | `{ type: "closed", port }` | Guest server closed |
| `execution:complete` | `{ id, result }` | An `execute()` resolved |
| `execution:error` | `{ id, error }` | An `execute()` rejected |
| `execution:timeout` | `{ id }` | Execution exceeded `config.timeout` |
| `execution:resource_timing` | `{ … }` | Resource timing data from the guest |
| `execution:key_event` | `{ … }` | Key events from the guest |
| `terminal:resize` | `{ cols, rows }` | `setTerminalSize()` succeeded |
| `reset` | `{ timestamp }` | `reset()` called |
| `error` | `{ type, error }` | Initialization or runtime errors |

**Note:** there is no `server-ready` event. The server lifecycle is
reported via `execution:server` with `type: "open"` / `"closed"`.

## Server lifecycle

When guest code calls `http.createServer().listen(port)`:

1. The sandbox notifies the host (`serverListening`).
2. The host emits `execution:server` with `{ type: "open", port }`.
3. The port is claimed in the host route registry — **first claim wins**;
   a second sandbox listening on the same port gets `EADDRINUSE` and its
   server is closed (see `docs/SINGLETONS.md` rule 4).
4. When the server closes, the host emits `execution:server` with
   `{ type: "closed", port }` and releases the claim.

## Teardown

There is **no** `destroy()`, `close()`, `dispose()`, or `terminate()`
method. Teardown is:

- **`sb.kill(reason)`** — force-kills the running execution. Returns
  `true` if a sandbox was running, `false` otherwise (logs a warning).
  The in-flight `execute()` resolves with the killed shape
  (`success: true`, `logs: [..., "Process Exited"]`).
- **`sb.reset()`** — clears the import resolver cache and resets
  `executionCount` to 0. Emits `"reset"`. Does not destroy the iframe.
- Removing the iframe element from the DOM (host's responsibility)
  releases the sandbox.

## Introspection

- **`sb.getStats()`** — `{ executionCount, initialized, config }`.
  `config` is a shallow copy.
- **`await sb.setTerminalSize(cols, rows)`** — resizes the guest
  terminal. Throws `Error` unless both are positive integers. Emits
  `terminal:resize` and returns `{ cols, rows }`.
- **`sb.registerInterop(name, handler)`** /
  **`sb.unregisterInterop(name)`** — manage host-side interop handlers
  callable from guest code.

## Preview URLs — planned

There is currently **no** preview URL scheme (`/__virtual__/{port}/`
or similar) and no `getPreviewUrl()` method. Guest servers are
reachable through the host's fetch patch and the `execution:server`
events, but not as navigable browser URLs. This is a separate roadmap
item (Service Worker route).

## Error contract

| Situation | Behavior |
|---|---|
| Bad config option | Throws synchronously from the constructor |
| `init()` bootstrap failure | Emits `"error"`, rethrows |
| Guest code throws | `execute()` resolves `{ success: false, error, stack }` — never rejects |
| Execution timeout | Emits `"execution:timeout"`; `execute()` resolves per timeout policy |
| `kill()` with no running sandbox | Returns `false`, logs a warning — does not throw |
| `setTerminalSize()` invalid args | Throws `Error` |
| `invoke()` before running | Throws `Error: Sandbox is not running.` |

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
- `execution:start`
- `execution:stdout`
- `execution:stderr`
- `execution:server`
- `execution:complete`
- `execution:error`
- `execution:timeout`
- `execution:resource_timing`
- `execution:key_event`
- `terminal:resize`
- `reset`
- `error`

Config options validated in the constructor:
- `shell`
- `plugins`
- `iframeElement`
