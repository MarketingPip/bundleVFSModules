# Events

`CodeSandbox` (exported from `runtime.js`) extends a small built-in
`EventEmitter`. Every event below is emitted on the `CodeSandbox` instance,
so a host page listens like this:

```js
import { CodeSandbox } from './runtime.js';

const sandbox = new CodeSandbox({ timeout: 30000 });
await sandbox.init();

sandbox.on('execution:stdout', ({ type, args }) => {
  // type is the console method: 'log', 'error', 'warn', 'clear', 'table', ...
  term.write(args);
});

sandbox.on('execution:complete', ({ id, result }) => {
  console.log('done in', result.executionTime, 'ms');
});

await sandbox.execute(`console.log('hello')`);
```

Emitter API: `on(event, fn)`, `once(event, fn)`, `off(event, fn)`
(`removeListener` is an alias), `removeAllListeners(event?)`, plus the
introspection events `newListener` / `removeListener` that fire when
handlers are added or removed.

Events are grouped by naming convention:

| Prefix          | Meaning                                              |
| --------------- | ---------------------------------------------------- |
| `initialized`, `error`, `reset` | Sandbox lifecycle                         |
| `execution:*`   | One `execute()` run: start, finish, and live streams  |
| `terminal:*`    | Terminal state changes                               |

---

## Lifecycle

### `initialized`

Fired once `init()` finishes.

```js
sandbox.on('initialized', ({ timestamp }) => { /* ready to execute */ });
```

Payload: `{ timestamp }` — `Date.now()` at init.

### `error`

Fired if `init()` throws.

```js
sandbox.on('error', ({ type, error }) => { /* type: 'initialization' */ });
```

Payload: `{ type: 'initialization', error }`.

### `reset`

Fired by `sandbox.reset()`, which clears the import cache and zeroes the
execution counter.

```js
sandbox.on('reset', ({ timestamp }) => { /* re-prime UI state */ });
```

Payload: `{ timestamp }`.

---

## Execution lifecycle

### `execution:start`

Fired when the sandbox iframe reports ready and begins running the code.

```js
sandbox.on('execution:start', ({ id }) => { /* show spinner */ });
```

Payload: `{ id, code }`. `id` is the per-sandbox execution counter.
Note: `code` is currently always `false` (the code-carrying emission is
disabled in the source); rely on `id` to correlate with
`execution:complete` / `execution:error` / `execution:timeout`.

### `execution:complete`

Fired when `execute()` resolves.

```js
sandbox.on('execution:complete', ({ id, result }) => {
  // result: { success, logs, errors, fs, executionTime }
});
```

Payload: `{ id, result }` — `result` is exactly what `execute()` resolves
with.

### `execution:error`

Fired when the execution rejects (window error or unhandled promise
rejection inside the sandbox, subject to the `captureWindowErrors` /
`capturePromiseRejections` config flags).

```js
sandbox.on('execution:error', ({ id, error }) => { /* show mapped stack */ });
```

Payload: `{ id, error }` — `error` is the message string. The mapped
stack trace is on the rejection value of `execute()`, not in this event.

### `execution:timeout`

Fired when the run exceeds the `timeout` config (default 30000 ms).

```js
sandbox.on('execution:timeout', ({ id }) => { /* note the hang */ });
```

Payload: `{ id }`.

### `execution:kill`

Fired when `sandbox.kill(reason)` force-stops a run.

```js
sandbox.on('execution:kill', ({ id, reason, executionTime }) => { /* … */ });
```

Payload: `{ id, reason, executionTime }`.

---

## Streaming output

### `execution:stdout`

Fired for every `console.*` call inside the sandbox. This is the live
stream — it arrives while the code runs, not just at completion.

```js
sandbox.on('execution:stdout', ({ type, args }) => {
  if (type === 'clear') { term.clear(); return; }
  // type: 'log' | 'error' | 'warn' | 'info' | 'debug' | 'clear' | 'table' | …
  term.write(String(args ?? ''));
});
```

Payload: `{ type, args }`. `type` is the console method name, `args` the
joined, serialized arguments string. Note there is **no separate stderr
event**: `console.error` arrives here with `type: 'error'`. The demo
wiring in `runtime.js` writes `args` straight into xterm.js, which
interprets ANSI escape sequences natively.

### `execution:key_event`

Fired for keypresses captured from the sandbox's stdin/readline layer,
as a Node-style keypress object. Used to feed terminal UIs or record
input.

```js
sandbox.on('execution:key_event', (keyData) => { /* … */ });
```

Payload: the keypress object (sequence, name, ctrl/meta/shift flags —
the same shape `process.stdin` `'keypress'` listeners receive in Node).

### `execution:readline_newline`

Fired when the sandbox's readline layer emits a newline (user pressed
Enter). Payload is `true`.

```js
sandbox.on('execution:readline_newline', () => { /* … */ });
```

---

## Filesystem

### `execution:fs`

Fired when sandboxed code calls a `fs` method (the virtual FS is
instrumented to report through).

```js
sandbox.on('execution:fs', ({ method, filename, data }) => {
  // method: e.g. 'writeFile', 'mkdir' ('promises.' prefix stripped)
});
```

Payload: `{ type: 'fs', method, filename, data }`.

---

## Network

These only fire for activity the runtime can observe; they are
opt-in via config where noted.

### `execution:network_request`

Fired when the sandbox's `fetch`/XHR shims issue a request.

```js
sandbox.on('execution:network_request', (req) => { /* log to network panel */ });
```

Payload: parsed request descriptor object.

### `execution:resource_timing`

Fired with resource-timing entries for sandbox loads.

Payload: parsed timing object.

### `execution:server`

Fired when sandboxed code starts or stops an emulated HTTP server
(`node:http` shim).

```js
sandbox.on('execution:server', ({ type, port }) => {
  if (type === 'open') showLink(port);
  // type: 'open' | 'closed'
});
```

Payload: `{ type: 'open' | 'closed', port }`.

---

## Interop

### `execution:interop_registered`

Fired when the sandbox registers a parent-callable interop handler
(`registerInterop`).

```js
sandbox.on('execution:interop_registered', ({ name }) => { /* … */ });
```

Payload: `{ name }`.

---

## In-sandbox events (for guest code)

These fire *inside* the sandbox for the code being executed, not on the
parent `CodeSandbox` instance:

- `process` emits `'exit'` with the exit code when guest code calls
  `process.exit(code)`. (The parent currently learns about this only
  through the resulting `execution:error` — see the proposal below.)

---

## Terminal

### `terminal:resize`

Fired when the sandbox terminal size changes via `setTerminalSize()`.

```js
// e.g. xterm.js onResize, or a settings panel:
await sandbox.setTerminalSize(120, 40);

sandbox.on('terminal:resize', ({ cols, rows }) => {
  term.resize(cols, rows); // keep the visible terminal in sync
});
```

Payload: `{ cols, rows }`.

**Semantics:**

- `setTerminalSize(cols, rows)` validates (positive integers) and requires
  a live sandbox — same constraint as `invoke('__stdin__', …)`: it throws
  `"Sandbox is not running."` before `init()` or when no execution is
  active.
- The sandbox updates `process.stdout.columns/rows` and
  `process.stderr.columns/rows`, then emits Node's `'resize'` event on
  both streams, so `readline` reflows and any guest
  `process.stdout.on('resize', …)` handlers fire — matching real Node.
- The parent then emits `terminal:resize` so *other* host listeners
  (status bars, layout code) can react, not just the caller.
- Returns the applied `{ cols, rows }`.

**Initial size:** `process.stdout.columns/rows` (and stderr's) default to
80×24 but are overridable at construction time:

```js
const sandbox = new CodeSandbox({
  process: { stdout: { columns: 120, rows: 40 } }
});
```

---

## Proposed additions

The following are **not implemented yet** — gaps found while auditing the
event surface. (`terminal:resize` / `setTerminalSize()` graduated from this
list; see the Terminal section above.)

### 1. `terminal:resize` + `setTerminalSize()` — implemented

Graduated from this list; see the Terminal section above.

### 2. `execution:exit` (proposed)

Guest `process.exit(code)` fires `'exit'` in-sandbox, but the parent has
no dedicated event — it surfaces indirectly via `execution:error`.
A dedicated `execution:exit` with `{ id, code }` would let hosts
distinguish "program exited(1)" from "program crashed", which matters
for REPL exit-code display.

### 3. `execution:cleanup` (proposed)

No event fires when the iframe is torn down after a run. Hosts managing
their own terminal/output widgets currently have to infer teardown from
`execution:complete`. An explicit event would make UI lifecycle
deterministic.

### 4. Smaller notes

- `execution:start`'s `code` field is always `false` today; either carry
  the code or drop the field so hosts don't depend on it.
- `console.error` arrives via `execution:stdout` with `type: 'error'`.
  That works, but a documented `execution:stderr` alias would make the
  split explicit for hosts that render stderr separately.
