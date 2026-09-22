# Writing a shim

A shim is `src/<name>.js` (or `src/<name>/<subpath>.js`), dependency-free ESM,
that behaves like the Node.js builtin **in a browser**, inside Jared's runtime
(see `docs/RUNTIME.md`) and standalone.

## Template

```js
// src/mymod.js — port of node:mymod for the browser runtime.

// 1. Runtime bridge (guarded: rewritten to the sandbox scope at load time,
//    undefined under real Node / direct import).
const RT = (typeof globalThis._RUNTIME_ !== "undefined")
  ? globalThis._RUNTIME_
  : undefined;

// 2. Feature detection, not UA sniffing.
const hasSubtle = typeof globalThis.crypto?.subtle !== "undefined";

// 3. Pure implementation first; runtime services only where the browser
//    cannot do it alone (fs, servers, processes).
export function myFunc(...) { /* real implementation */ }

// 4. Unimplementable surface → honest noop, never throw.
export function notPossibleInBrowser(...) { /* noop */ }
export default { myFunc, notPossibleInBrowser };
```

## Rules

1. **ESM, no dependencies.** No npm imports in `src/` — esbuild bundles with
   `platform: "browser"` and the result must run from a string of source.
2. **`globalThis._RUNTIME_`, never bare `_RUNTIME_`, never `window`.**
   The runtime AST-rewrites exactly the `globalThis._RUNTIME_` member
   expression. `window`/`document` at module scope breaks future worker
   support — use `globalThis` and feature-detect.
3. **Reuse the singletons.** `RT.__FS__` (filesystem), `RT.__httpServerRunTime`
   (server registry), `RT.process` (config values), `RT.taskTracker`
   (async tracking). Don't build a second VFS or a second process object.
4. **Noop over throw.** If the browser fundamentally cannot do it (UDP,
   raw TCP servers, `process.kill` semantics), export a stub with the right
   shape that does nothing. Document the gap in the PR, not in an exception.
5. **Match Node's observable behaviour**, not its internals: argument
   validation, error codes (`ERR_*`), event names, and edge cases first;
   performance second. Differential-test against `node:<builtin>`.
6. **Register the module** in `BUNDLED_MODULES` in `src/build-vfs.mjs`
   (bundle key: `node:timers/promises` → `timers_promises`,
   `node:test/reporters` → `test_reporters`).
7. **Test the existing thing first.** If `src/<name>.js` already exists (even
   as a re-export or npm shim), run its tests before rewriting it.

## Browser capability map (starting points, verify each)

| Node builtin | Browser strategy |
|---|---|
| `path`, `querystring`, `punycode`, `string_decoder`, `util`, `assert`, `events` | pure JS ports of Node's `lib/` — 100% parity achievable |
| `buffer` | `Uint8Array` + `TextEncoder/Decoder`; `Buffer` global via `RUNTIME_NODE_GLOBALS` |
| `crypto` | `crypto.subtle` for digests/ciphers; pure-JS fallback for the rest; `randomBytes` via `getRandomValues` |
| `stream`, `string_decoder` | pure JS; `stream/web` maps to native `ReadableStream` etc. |
| `timers` | native timers + `taskTracker` integration; `timers/promises` on top |
| `url`, `URLSearchParams` | native `URL` — verify edge cases differentially |
| `util/types` | native type checks |
| `os` | static browser-plausible values (`platform: "browser"`); `tmpdir()` → in-memory path; `cpus()` → `navigator.hardwareConcurrency` |
| `process` | mirror `RT.process`; `hrtime.bigint` via `performance.now()`; `nextTick` via `queueMicrotask` |
| `console` | port of Node's console; forwards through the runtime's `emit` where present |
| `fs` | virtual FS singleton on `RT.__FS__`, seeded from `RT.__USER_FILES__` |
| `http`/`https` | client via `fetch`; server via `RT.__httpServerRunTime` emulation |
| `net` | in-memory/virtual sockets; client via fetch/WebSocket where sensible |
| `dns` | DNS-over-HTTPS |
| `zlib` | `CompressionStream`/`DecompressionStream` + pure-JS fallback |
| `readline` | runtime terminal streams (`process.stdin/stdout` shims) |
| `vm` | `eval`/`new Function` sandbox (CSP allows `unsafe-eval`); document the weaker isolation |
| `worker_threads` | blob-URL `Worker`s (CSP allows `worker-src blob:`) |
| `child_process` | host `postMessage` protocol (already in `src/child_process.js`) |
| `dgram`, `tls` (server), `http2` framing, `cluster` | noop stubs with correct shapes |
| `inspector`, `trace_events`, `sea`, `quic`, `sqlite`, `wasi` | honest minimal stubs / WASM-backed where viable |

## The three test lanes

Every shim PR must pass all three:

1. **Repo tests** — `tests/<name>.test.js` (or `.js`), written against real
   Node v24 behaviour, not against the shim's wishes. Assert the uncomfortable
   cases (e.g. `v8.getHeapStatistics()` has no `total_allocated_bytes`).
2. **Official parity** — vendored Node v24.20.0 tests under `parity/`,
   run via `parity/run.mjs`. Keep `parity/expected-failures.json` empty;
   record infrastructure-blocked tests honestly instead.
3. **Browser-fallback lane** — run the repo tests with native builtins
   disabled (`process.getBuiltinModule` stubbed out) so the shim proves
   itself without Node delegation. Official parity passing under Node is
   **not** proof the browser path works.

Plus **differential testing**: property/fuzz checks of the shim against
`node:<builtin>` for pure functions (see `parity/` helpers).

## PR checklist

- [ ] Three lanes green (or honest gaps recorded)
- [ ] `node --check` on changed files
- [ ] No new npm dependencies; no `window`/`document` at module scope
- [ ] `globalThis._RUNTIME_` used (never bare), guarded for standalone use
- [ ] Unimplementable APIs are noops with correct shapes
- [ ] Registered in `src/build-vfs.mjs` if it's a new builtin
- [ ] Explicit file manifest in the PR (shared tree — never bulk-add)
- [ ] Score recorded in `parity/README.md` scoreboard

## Anti-patterns

- ❌ `throw new Error("Not implemented")` for browser-impossible APIs → noop.
- ❌ Delegating to `process.getBuiltinModule("x")` as the implementation →
  that's the facade, not the fallback; the browser lane must not need it.
- ❌ Copying invented behaviours into tests (e.g. asserting stub shapes
  instead of real Node output) → verify against real Node v24.20.0 first.
- ❌ Rewriting `src/fs.js`, `src/http.js`, `src/module.js`, `src/process.js`,
  `src/child_process.js`, `src/runtime/*` to "simplify" them → they carry
  `_RUNTIME_` integration; extend, don't replace.
- ❌ Claiming "works in browser" from Node-only test runs.
