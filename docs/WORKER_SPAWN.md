# Worker-backed spawn

The runtime's own honest process story for `child_process` — real child
processes backed by workers, with stdio streaming, signals, and exit codes.
Workers boot from a VFS snapshot and receive changes over a VFS bridge
(Nodepod's `process-manager.ts` + `process-worker-entry.ts` pattern;
technique only — all code here is original).

## Why this exists

PR #180 landed BYO shell: `new CodeSandbox({ shell })` lets developers
bring their own shell function. This plugin is the runtime's **own**
process implementation for hosts that don't bring one. It composes with
the BYO contract — `workerBackedShell` is just a shell function:

```js
import { workerSpawnPlugin, workerBackedShell } from "./src/plugins/worker-spawn.js";
import { registerPlugin } from "./src/plugins.js";

registerPlugin(workerSpawnPlugin);
const sb = new CodeSandbox({ shell: workerBackedShell });
```

## Opt-in, not default

The core stays shell-agnostic per the BYO design (Jared 2026-10-03: the
library ships no shell). Worker-spawn is an opt-in plugin following the
`vite-browser` pattern: `workerSpawnPlugin = { name: "worker-spawn",
builtIn: true }`. Nothing activates unless the host registers it.

## Two lanes, one entry source

There is exactly **one** worker entry source (`WORKER_ENTRY_SOURCE` in
`src/plugins/worker-spawn.js`), rendered per-spawn with the command, args,
VFS snapshot, and env baked in as JSON:

| Lane | Factory | Worker |
|---|---|---|
| Browser (default) | `defaultBrowserWorkerFactory` | Web Worker from a Blob URL |
| Node | `nodeWorkerFactory` | `worker_threads` Worker from a temp file |

The Node lane exists because the entry is written lane-agnostic: under
`worker_threads` there is no `self`, so a preamble wires `parentPort` to
the browser Worker message shape. Same script, both lanes — which gives a
real-Node test lane for the whole mechanism (`tests/worker-spawn-real.test.js`).

## API

### `spawnWorkerProcess(command, args, options)` — the process-manager primitive

One call = one child. Each boots an independent worker from its own VFS
snapshot.

```js
import { spawnWorkerProcess, nodeWorkerFactory } from "./src/plugins/worker-spawn.js";

const proc = spawnWorkerProcess("node", ["-e", 'console.log("hi")'], {
  vfs: { "/app.js": "…" },   // VFS snapshot the worker boots from
  env: { FOO: "bar" },       // process.env inside the worker
  signal: abortSignal,       // AbortSignal -> terminate (SIGTERM)
  createWorker: nodeWorkerFactory, // or omit for the browser lane
});

proc.on("stdout", (chunk) => …); // chunked stdio streaming
proc.on("stderr", (chunk) => …);
proc.on("exit", (result) => …);

proc.kill("SIGTERM");            // -> { exitCode: null, signal: "SIGTERM" }
await proc.applyVfsDiff({ "/flag.txt": 'module.exports = "x";' }); // VFS bridge

const { stdout, stderr, exitCode, signal, pid } = await proc.result();
```

Exit semantics match Node `child_process`: normal exit gives
`{ exitCode: <code>, signal: null }`; a kill gives
`{ exitCode: null, signal: "SIGTERM" | "SIGKILL" }`. Pids are synthetic
(start at 4097) — documented, not OS pids.

`command`/`args` follow the BYO shell contract: spawn-style
`("node", ["-e", code])` / `("node", ["/file.js"])`, or exec-style
`("node -e '…'", [])`. Inside the worker, `process.argv` is
`["node", ...args]`.

### `createProcessManager()` — track groups of children

```js
const mgr = createProcessManager();
const h1 = mgr.spawn("node", ["-e", "…"], { createWorker: nodeWorkerFactory });
mgr.list();            // live handles (settled ones are pruned)
mgr.killAll("SIGKILL"); // returns the number killed
```

### `workerBackedShell(command, args, options)` — the BYO shell function

Drop-in for `new CodeSandbox({ shell })`. Returns a Promise of
`{ stdout, stderr, exitCode, signal? }` with a `.kill(signal)` method
attached. Pass `createWorker: nodeWorkerFactory` in options for the Node
lane (useful in tests); the browser lane is the default.

**Sandbox-serialization constraint.** The shell is serialized via
`.toString()` into the sandbox (`src/runtime/sandbox-runtime.js`), so it
cannot reference module scope. `workerBackedShell` is therefore
*assembled* at module load from the canonical pieces
(`WORKER_ENTRY_SOURCE` + pure helpers + `spawnWorkerProcessCore`), each
embedded verbatim — one copy of everything, no drift. The test
"workerBackedShell embeds WORKER_ENTRY_SOURCE byte-for-byte (no drift)"
guards this, and the re-materialization tests prove the serialized shell
runs with zero module scope.

### `nodeWorkerFactory(scriptSource)` — the Node lane

Writes the entry to a temp file (worker_threads cannot boot from a blob
URL), spawns the thread, adapts it to the worker interface the core
expects, and removes the temp files on terminate/exit. Abnormal thread
death without an `{type:"exit"}` message resolves via the
`onunexpectedexit` safety net instead of hanging.

### `buildWorkerScript(command, args, vfs, env)` — pure, testable

Renders the entry source as a string without spawning anything.

## Architecture

```
host: spawnWorkerProcess(command, args, { vfs, env, createWorker })
  │  renderWorkerEntry(WORKER_ENTRY_SOURCE, …) → JS string
  │  createWorker(script) → worker adapter
  ▼
worker: boot → capture console → wait for {type:"init"} → run
  │  {type:"stdout"|"stderr", data}  (streaming, per console call)
  │  {type:"vfs-ack", applied}       (bridge acknowledgement)
  │  {type:"exit", code}             (event loop drained / process.exit)
  ▼
host: chunked on("stdout") events + result() → {stdout, stderr, exitCode, signal}
```

**VFS snapshot.** `options.vfs` (set by `execCore`/`spawn` in
`src/child_process.js`, or passed directly) is baked into the worker
script as JSON. The worker's `require()` resolves from the snapshot with
real relative-path semantics (`./`, `../`, absolute), plus `__dirname` /
`__filename`. There is deliberately **no module cache**: the VFS bridge
may replace files under a running worker, and re-`require` must observe
the patch.

**VFS bridge.** `proc.applyVfsDiff({ path: source | null })` posts a
`vfs-patch` message to the *running* worker, which merges it into its
live snapshot and acknowledges (`vfs-ack`). `null` deletes. Resolves
`true` on ack, `false` on timeout (2s — a worker stuck in synchronous
code can't process messages) or after the process settled. This is the
host→worker direction; worker-local writes are not synced back (see
Honest scope).

**Stdio streaming.** The worker replaces `console.log/info/error/warn`
with postMessage-forwarding versions. Each call streams one
`{type:"stdout"|"stderr", data}` chunk and appends to the buffer used for
the final result. `proc.on("stdout"|"stderr")` delivers chunks in order.

**Liveness.** A real process exits when the event loop drains. The entry
tracks the timers the program creates (wrapping `setTimeout`/`setInterval`
and their clear functions); once `main()` has returned and no timers are
pending, it posts `{type:"exit", code}`. `process.exit(code)` exits
immediately, like the real thing, and `process.exitCode = n` is honored
at drain.

**Signals.** `proc.kill(signal)` / `promise.kill(signal)` terminate the
worker and resolve `{ exitCode: null, signal }`. `options.signal`
(AbortSignal) terminates with `SIGTERM`. Termination is abrupt — like
SIGKILL, there are no cleanup hooks.

## Honest scope (what it does NOT do)

This is **not a shell emulator** (AGENTS.md rule 11: no shell as product).
The worker executes **JavaScript only**:

| Command | Behavior |
|---|---|
| `node -e '<code>'` | Runs the code. Full console capture. |
| `node <file>` | Runs the file from the VFS snapshot. |
| `node --version` / `-v` | Reports `v24.0.0-worker` (honest label). |
| anything else | Exit **127**, stderr `"<cmd>: command not found"`. |

No silent fakes (rule 7): a non-JS command never reports success.

## Limitations

- **No real syscalls.** File I/O goes through the VFS snapshot, not the
  host OS.
- **No raw sockets/UDP.** Same constraints as the main sandbox
  (see `docs/RUNTIME.md` CSP section).
- **No `exec` of binaries.** Only JavaScript executes. Deliberate:
  building a shell would violate rule 11.
- **No Node builtins inside the worker.** `require("fs")` etc. throw
  "Cannot find module" — the worker has the VFS snapshot and a minimal
  `assert` shim, nothing else.
- **Bare promise chains.** Timer-tracked liveness can't see promise jobs:
  a program that only `await`s a promise with no timer may be cut short.
  Keep the worker alive with a timer or call `process.exit()`.
- **Structured clone.** VFS snapshots cross as JSON baked into the worker
  script. Large snapshots make large scripts; prefer minimal snapshots.
- **Termination is abrupt.** `kill()` gives no cleanup hooks — like
  SIGKILL, not SIGTERM-with-handlers.
- **One direction bridge.** `applyVfsDiff` patches host→worker. Files the
  worker "writes" stay in the worker; they are not synced back to the host.
- **Synthetic pids.** `proc.pid` starts at 4097 and is not an OS pid.

## Testing

- **Unit:** `tests/worker-spawn.test.js` (11/11) — plugin shape, pure
  builder, the byte-for-byte template sync guard, and re-materialized
  shells (from `.toString()`, zero module scope) executing the REAL entry
  in a `node:vm` worker: stdout, exit codes, 127, kill-before-init race,
  AbortSignal.
- **Real execution:** `tests/worker-spawn-real.test.js` (19/19) — every
  feature through genuine `worker_threads` workers: spawn, chunked stdio
  streaming in order, exit codes (0/42/7/1), 127, VFS snapshot boot with
  relative require, env/argv, SIGTERM/SIGKILL mid-run kills, AbortSignal,
  the VFS bridge (add + delete observed by a running program),
  `workerBackedShell` end-to-end, and the process manager group kill.
- **Browser:** `tests/worker-spawn-e2e.py` + `.html` — headed Firefox,
  proves the serialized shell spawns real Web Workers through the full
  `CodeSandbox.execute()` pipeline: stdout streaming, exit codes, stderr
  capture, honest 127, VFS file execution.
