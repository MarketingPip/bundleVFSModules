# Singleton policy — what must be singleton, what must not, and why

Some state in this repo **must** exist exactly once; other state **must**
exist once per use. Getting this wrong produces the worst bugs we have:
two filesystems that disagree, two servers answering one port, a fetch
patch that never restores. This document is the registry and the rules,
verified against the sources it cites.

## The two scopes

"Singleton" here always means **singleton within a scope**. There are two:

1. **Per-sandbox** — one instance per iframe sandbox, living on the
   uuid-mangled runtime key `globalThis._RUNTIME<uuid>_`
   (authored in shim source as `globalThis._RUNTIME_.*`, rewritten at load
   time; see `docs/RUNTIME.md`). Two sandboxes on one page each get their
   own. These are the cross-shim shared services.
2. **Per-module-instance** — one instance per loaded copy of the shim,
   held in module-level `const`s. The bundle is loaded once per sandbox,
   so in practice this is also per-sandbox — but the guarantee comes from
   the module system, not from the runtime object.

Never store per-sandbox state in a place visible to other sandboxes, and
never create a second instance of anything in the registry below.

## The registry — must be singleton

| Singleton | Source | Scope | Created by | Lifecycle |
|---|---|---|---|---|
| `RT.__FS__` — the virtual filesystem | `src/fs.js` `buildSingleton()` | per-sandbox | `buildSingleton()`: reuse `rt.__FS__` if present, else `buildApi(createVolume())` (seeded from `rt.__USER_FILES__` via `seedVolume`, best-effort), published as `rt.__FS__` | lives for the sandbox lifetime; seeded once from `RT.__USER_FILES__` |
| `RT.__httpServerRunTime` — the server bridge | `src/http.js` (bottom) | per-sandbox | `http.js`, **only** `if (RT)` — never a placeholder outside the sandbox | `{ handleRequest, waitForAllServers, closeServer }`; the host calls `handleRequest` for emulated inbound requests |
| `serverRegistry` — port → server map | `src/http.js` (`_httpShared().registry`) | per-sandbox (`RT.__httpSharedState`; module-local fallback under real Node) | `_registerServer` / `_unregisterServer` | exact-port matching only (see below); released on close |
| `process` | `src/process.js` (single `process2` export) | per-sandbox | mirrors `RT.process` config values | never re-created; `import "node:process"` returns this object |
| `Module._cache` / `require.cache` | `src/module.js` (`const _cache = Object.create(null)`) | per-module-instance | module loader | Node-style partial exports for circular imports |
| `http.globalAgent` | `src/http.js` (`export const globalAgent = new Agent({ keepAlive: true, … })`) | per-module-instance | module init | the default agent; see "must not" for user agents |
| DNS server list | `src/dns.js` (`getServers` / `setServers`) | per-module-instance | `setServers()` | DoH endpoint URLs; `IP[:port]` entries cannot be transports in a browser |
| `diagnostics_channel` registry | `src/diagnostics_channel.js` | per-module-instance | `channel(name)` | named channels; same name → same channel object |
| `perf_hooks` Performance facade | `src/perf_hooks.js` (§9) | per-module-instance | module init | the `performance` object |
| Host `fetch` patch | host `runtime.js` (not this repo) | per-page | installed once by the host | restored when the final route disappears |

## The registry — must NOT be singleton

Each of these is per-instance by design. Sharing one across uses is a bug:

- `new http.Agent()` / `new https.Agent()` — user-constructed agents carry
  per-use options (keepAlive, maxSockets); only `globalAgent` is shared.
- `http.createServer()` — every server is its own instance with its own
  listeners; the *registry* is singleton, the *servers* are not.
- `net.Socket`, `tls` sockets, `dgram` sockets — one per connection.
- Streams (`Readable`, `Writable`, `Duplex`, file streams) — one per use.
- `fs` file handles, `FileHandle` — one per open.
- `crypto` `Hash` / `Hmac` / `Cipher` / `Decipher` — one per operation.
- `vm.Script`, `vm.Context` — one per compilation/context.
- `worker_threads.Worker`, `child_process.ChildProcess` — one per spawn.
- `URL`, `URLSearchParams`, `Buffer` — value objects, always fresh.

Rule of thumb: **if Node lets the user `new` it (or get a fresh one per
call), it is not a singleton here either.** Singletons are the things Node
itself keeps exactly one of: `process`, the module cache, `globalAgent`,
the DNS server list, the channel registry.

## Rules

### 1. Reuse, never rebuild
If a singleton exists for your need, use it. Don't build a second VFS
(`new Volume()` in your shim), a second process object, or a second
server registry. The SHIM_AUTHORING.md rule-3 list
(`RT.__FS__`, `RT.__httpServerRunTime`, `RT.process`, `RT.taskTracker`)
is the complete set of cross-shim services — if you need a fifth, propose
it in the PR; don't smuggle one in.

### 2. Lazy + guarded creation
Singletons are created on first use, behind a guard — never eagerly at
module top-level (eager creation runs before seeds/config exist):

```js
// src/fs.js — the pattern to copy
function buildSingleton() {
  const rt = (typeof globalThis._RUNTIME_ !== 'undefined' && globalThis._RUNTIME_ !== null)
    ? globalThis._RUNTIME_
    : undefined; // standalone (parity tests, direct import): own instance, clearly marked
  if (rt && rt.__FS__) return rt.__FS__;
  const vol = createVolume(); // seeds from rt.__USER_FILES__ via seedVolume (best-effort)
  const fs = buildApi(vol);
  fs._vol = vol;
  if (rt) rt.__FS__ = fs;
  return fs;
}
const fs = buildSingleton(); // module-level, but guarded: no RT → unseeded standalone instance
```

### 3. Never fabricate a sandbox singleton outside the sandbox
`src/http.js` publishes `RT.__httpServerRunTime` only `if (RT)` — the
comment in the source is explicit: *"guarded — never create a placeholder
runtime object outside the sandbox"*. A fake `__httpServerRunTime` under
plain Node would make `handleRequest` silently misbehave instead of
failing loudly. Outside the sandbox, the absence of the singleton **is**
the signal.

### 4. The server registry: exact-port matching, first claim wins
`serverRegistry` maps port → server. The contract (enforced by tests):

- **Exact-port matching only.** A request for port P routes to the server
  registered for P, or to native `fetch` — never to an arbitrary registered
  server. Falling back to "any server" misroutes traffic across sandboxes.
- **First claim wins.** Within a sandbox, a second `listen()` on a taken
  port gets `EADDRINUSE` (like Node — see `ServerBase.listen`). Across
  sandboxes, the host registry decides: the first sandbox to claim a
  virtual port wins, and the host revokes the loser's claim via
  `closeServer(port)`.
- **Release on close.** `server.close()`, `closeServer(port)` (host-side
  revocation), cleanup, and self-shutdown all unregister the port. A leaked
  registration is a leaked route.
- The host-side `fetch` patch follows the same rule: localhost URLs route
  to the sandbox holding the matching port claim; unmatched ports use
  native fetch. One patch installed, restored when the final route
  disappears — never one patch per server.

### 5. Teardown is part of the singleton
A singleton that holds resources must know how to let go:

- `serverRegistry` → `_unregisterServer` on close; `closeServer(port)`
  for host-initiated revocation (emits `EADDRINUSE` + `'close'`).
- `_waitForAllServers()` resolves when the registry empties — the runtime's
  completion hook depends on it. Don't leave the registry non-empty at
  shutdown or the sandbox never looks idle.
- The host `fetch` patch restores the original `fetch` when the last route
  is removed.

### 6. Keep singletons inside their sandbox
Module-level singletons are safe because the bundle loads once per
sandbox. `RT.*` singletons are safe because the `_RUNTIME_` rewrite
scopes them to the uuid-mangled per-sandbox key
(`globalThis._RUNTIME<uuid>_`), installed in each sandbox's own realm.
What breaks
isolation: stashing per-sandbox state in a place shared across sandboxes
(e.g. a module-level `Map` keyed by nothing, or string-keyed `globalThis`
properties outside the runtime object). If two sandboxes can see it and
it isn't keyed by sandbox, it's a cross-talk bug.

## Test implications

- Tests that register servers must use unique or ephemeral ports and close
  them — a leaked registration poisons later tests in the same file
  (exact-port matching means a stale entry *wins* over native fetch).
- `getAllServers()` returns a copy (`new Map(serverRegistry)`) — assert
  against the copy, never mutate the registry directly in tests.
- Standalone/parity runs (no `RT`) exercise the non-singleton paths;
  sandbox-only singletons (`__httpServerRunTime`) are covered by the
  browser lane, not by Node.

## Anti-patterns

- ❌ `new Volume()` (or any second FS) inside a shim → reuse `RT.__FS__`.
- ❌ Eager singleton construction at module top-level → lazy + guarded.
- ❌ `if (!RT) RT = { __httpServerRunTime: fake }` → the absence is the signal.
- ❌ "Closest port" / "any server" fallback in routing → exact-port or native.
- ❌ One `fetch` patch per server, or a patch that's never restored.
- ❌ Module-level `Map` shared across sandboxes without a sandbox key.
- ❌ Forgetting `_unregisterServer` on an error path → the port stays
  claimed after the server is dead.
