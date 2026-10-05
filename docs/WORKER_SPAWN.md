# Worker-backed spawn

The runtime's own honest process story for `child_process` — real child
processes backed by Web Workers, with stdio streaming, signals, and exit
codes.

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

## Architecture

```
host: workerBackedShell(command, args, options)
  │  buildWorkerScript(command, args, vfs) → JS string
  │  new Blob([script]) → URL.createObjectURL → new Worker(url)
  ▼
worker: boot → capture console → run command → postMessage
  │  {type:"stdout", data} / {type:"stderr", data}  (streaming)
  │  {type:"exit", code}                            (done)
  ▼
host: resolve({stdout, stderr, exitCode, signal})
```

**VFS snapshot.** `options.vfs` (set by `execCore`/`spawn` in
`src/child_process.js`) is serialized into the worker script via
`buildWorkerScript`. The worker's `require()` resolves from the snapshot.
This is the VFS bridge (Nodepod's `process-worker-entry.ts` pattern):
workers boot from a snapshot; the parent merges changes back via the
existing `applyVfsDiff` path in `child_process.js`.

**Stdio streaming.** The worker replaces `console.log/error/warn/info`
with postMessage-forwarding versions. Each line is both streamed
(`{type:"stdout", data}`) and buffered for the final result. The async
`exec`/`spawn` paths in `child_process.js` already forward these to
`child.stdout`/`child.stderr` streams.

**Signals.** `worker.terminate()` is the SIGTERM/SIGKILL. Two paths:
- `promise.kill(signal)` — attached to the returned Promise (extra,
  contract-compatible). Terminates immediately.
- `options.signal` (AbortSignal) — abort terminates the worker.
  This already composes with `ChildProcess`'s `options.signal` support.

Kill resolves with `{stdout, stderr, exitCode: null, signal: "SIGTERM"}`
— matching Node's `child.killed` + `signalCode` semantics.

## Honest scope (what it does NOT do)

This is **not a shell emulator** (AGENTS.md rule 11: no shell as product).
The worker executes **JavaScript only**:

| Command | Behavior |
|---|---|
| `node -e '<code>'` | Runs the code. Full console capture. |
| `node <file>` | Runs the file from the VFS snapshot. |
| `node --version` | Reports `v24.0.0-worker` (honest label). |
| anything else | Exit **127**, stderr `"<cmd>: command not found"`. |

No silent fakes (rule 7): a non-JS command never reports success.
`process.exit(code)` is honored via a sentinel throw. The worker has no
DOM, no `window`, no raw sockets, no syscalls — it's a JS sandbox, not
an OS process. Documented here, not hidden.

## Limitations

- **No real syscalls.** File I/O goes through the VFS snapshot, not the
  host OS. `fs` calls in the worker resolve from the snapshot.
- **No raw sockets/UDP.** Same constraints as the main sandbox
  (see `docs/RUNTIME.md` CSP section).
- **No `exec` of binaries.** Only JavaScript executes. This is deliberate:
  building a shell would violate rule 11.
- **Structured clone.** VFS snapshots cross via `JSON.stringify` in the
  worker script (baked into the blob). Large snapshots make large blobs;
  prefer minimal snapshots.
- **Termination is abrupt.** `worker.terminate()` gives no cleanup hooks
  — like SIGKILL, not SIGTERM-with-handlers.

## Testing

- **Unit:** `tests/worker-spawn.test.js` (12/12) — mocked Worker, covers
  the shell contract, kill, AbortSignal, 127 for unknown commands.
- **Browser:** `tests/worker-spawn-e2e.py` + `.html` — headed Firefox,
  proves a real worker spawns, streams output, and exits.
- **Parity:** `node parity/real-runtime.mjs` can run spawn tests through
  the real sandbox to verify Node `child_process` semantics where they
  apply (exit codes, stdio ordering).
