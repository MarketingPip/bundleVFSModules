# Toolchain plugin API — contract and design

> Roadmap §1: first-class `runtime.runWasi(bytes, {args, env})`, package
> `exports`/`imports` resolution, and the toolchain plugin registration API.
>
> **Philosophy (non-negotiable):** core NEVER ships a toolchain and never
> knows what clang is. Core only knows *"compile sources → wasm bytes"* and
> *"run wasm bytes on my VFS"*. A toolchain plugin is written by library
> **users** (host developers), never by us — it adapts any compiler to the
> contract below. No esbuild-wasm. No N-API promises.

Implementation: `src/toolchain.js` (host-side, mirrors `src/plugins.js`).
Reference stub (fake compiler, proves the API): `tests/toolchain-stub-plugin.js`.
Tests: `tests/toolchain-plugin.test.js`.

---

## 1. Why registration is host-side, not on `globalThis._RUNTIME_`

`registerPlugin` is the precedent: a host-side module API. A toolchain's
`compile` is an async JS function doing heavy host-side work (lazy-loading
a WASI toolchain build, tens of MB — per `docs/PLUGINS.md`, plugins run
parent-side). The sandbox↔host channel is `postMessage`, and a JS function
cannot cross it (structured clone rejects functions). A sandbox-side
`globalThis._RUNTIME_.registerToolchain` could therefore never affect the
host `_build_file` pipeline — registering one would be a silent fake
(AGENTS.md rule 7), so it is deliberately absent. Hosts register from the
host page:

```js
import { registerToolchain } from "./src/toolchain.js"; // or "bundleVFSModules/toolchain" once packaged

const handle = registerToolchain({
  name: "wasi-clang",
  compile: async (files, opts) => { /* … */ return { bytes }; },
  sysroot: { "/usr/include/stdio.h": "…" },
});
// later: handle.unregister()  — or unregisterToolchain("wasi-clang")
```

---

## 2. Registration API

| function | behavior |
|---|---|
| `validateToolchain(tc)` | throws `TypeError` on bad shape; returns `true` |
| `registerToolchain(tc)` | validates; throws `Error("…already registered")` on duplicate name; auto-installs the resolution bridge (§5); returns `{ name, unregister() }` handle |
| `unregisterToolchain(name)` | removes toolchain **and** its bridge; returns `true`/`false` |
| `getToolchain(name)` / `getToolchains()` / `clearToolchains()` | lookup / snapshot / remove-all (tests use `clearToolchains()` in `beforeEach`) |
| `requireToolchain(name)` | `getToolchain` or throw `ToolchainError` |
| `ToolchainError` | `new ToolchainError(name, message, {file?, line?, column?})`; message is `[toolchain:<name>] <message> (<file>:<line>)`; compile failures also carry `err.errors` / `err.warnings` |

### Toolchain record shape

```js
{
  name: string,                    // required, unique, non-empty
  compile: async (files, opts) => result,  // required; §3 contract
  sysroot?: string | Record<string, string|Uint8Array>,
                                   // VFS path (follow-up seam) or file map
  extensions?: string[],           // e.g. [".c", ".h"] — drives the bridge
  target?: string,                 // default triple, e.g. "wasm32-wasi"
  matchBareSpecifier?: boolean,    // probe "./x"+ext for bare "./x"
                                   // (default true when extensions set)
  readFile?: async (absPath) => string|Uint8Array|null,
                                   // host VFS accessor for multi-file builds
  exists?: async (absPath) => boolean,
                                   // host VFS accessor for bare-specifier probing
}
```

Unknown fields are ignored (forward-compat). Registration is
all-or-nothing: if the bridge install fails, the toolchain is rolled back.

---

## 3. The `compile(files, opts)` contract

### Input: `files`

```js
{
  "main.c": "int add(int a,int b){return a+b;}\n",  // string = UTF-8 source
  "lib/util.c": <Uint8Array>,                        // bytes allowed
}
```

- A plain object map. Keys are **project-relative POSIX paths**.
- Values are `string` or `Uint8Array`; anything else → `ToolchainError`.
- Empty map → `ToolchainError`. This is validated by
  `compileWithToolchain` *before* your function runs.

### Input: `opts` (toolchain-agnostic)

```js
{
  entry?: string,          // entry source file.
                           // Default: first file matching the toolchain's
                           // `extensions`, else the first file.
  cflags?: string[],       // e.g. ["-O2", "-Wall"] — raw compiler flags
  ldflags?: string[],      // raw linker flags
  target?: string,         // default: toolchain.target ?? "wasm32-wasi"
  output?: string,         // desired output name (default "a.out.wasm")
  env?: Record<string,string>,
  sysroot?: ...,           // overrides the registered sysroot
  sysrootMount?: string,   // where the host mounted it ("/.sysroot/<name>");
                           // set by CodeSandbox.compileToolchain
  toolchainOpts?: object,  // escape hatch for toolchain-specific knobs
}
```

The names are deliberately C-flavored but the semantics are generic:
`cflags` = "extra compiler flags", `entry` = "the root source file",
`target` = "what to build for". A rustc plugin maps them like this:

| contract field | clang plugin | rustc plugin |
|---|---|---|
| `entry` | `main.c` → `clang … main.c` | `main.rs` → `rustc … main.rs` |
| `cflags` | passed through | mapped (`--cfg`, `-C opt-level=`) or ignored |
| `target` | `wasm32-wasi` | `wasm32-wasip1` |
| `extensions` | `[".c", ".h"]` | `[".rs"]` |

A plugin MUST accept every documented opt key (ignore what doesn't apply)
and MUST NOT require undocumented keys — hosts build opts generically.

### Output: result object

```js
{
  bytes: Uint8Array,                 // the linked wasm module (required
                                     // on success; ArrayBuffer also accepted)
  warnings?: [{ file?, line?, column?, message }],
  errors?:   [{ file?, line?, column?, message }],  // non-empty = failed
  stdout?: string,
  stderr?: string,
  elapsedMs?: number,
}
```

Error semantics: **report, don't throw, for compilation failures.**
Return `{ errors: […] }`; `compileWithToolchain` throws `ToolchainError`
with the full arrays on `err.errors` / `err.warnings`. Throw only for
infrastructure failures (toolchain binary missing, OOM) — those are wrapped
in `ToolchainError` as `compile threw: …` so callers always see one error
type. `bytes` missing on success → `ToolchainError`.

`compileWithToolchain(name, files, opts)` (also exported) enforces all of
the above: validates the record, validates `files`, merges
`{ target, entry, sysroot }` defaults, calls `compile`, normalizes the
result to `{ bytes, warnings, errors: [], stdout, stderr, elapsedMs }`.

---

## 4. Sysroot mounting

A sysroot gets into the VFS in two stages:

1. **Now (minimal): file maps.** `sysroot: { "/usr/include/stdio.h": "…" }`
   is merged by `mountSysrootIntoSeed(tc, seed)` under
   `/.sysroot/<name>/…` (constant `SYSROOT_MOUNT_PREFIX`), idempotent per
   `(seed, toolchain)` pair (tracked in a `WeakMap`; `isSysrootMounted`
   queries it). `CodeSandbox.compileToolchain` / `mountToolchainSysroot`
   do this against `config.fs` before compiling.
2. **Follow-up seam: read-only lazy mounts** (roadmap lists this as a
   separate seam). A *string* sysroot (`"/opt/wasi-sysroot"`) throws a
   clear `ToolchainError` today — no silent partial mount. The follow-up
   mount must satisfy:

```js
// Interface the lazy-mount seam must provide:
interface SysrootMount {
  readonly: true;                                   // enforce, don't document
  readFile(absPath: string): Promise<Uint8Array | null>;  // lazy, no full copy
  stat?(absPath: string): Promise<{ size: number, isDirectory: boolean } | null>;
  listDir?(absPath: string): Promise<string[] | null>;
}
mountSysroot(name: string): Promise<SysrootMount>
```

Until it lands: hosts needing large sysroots keep them in the toolchain's
own `readFile`/`exists` accessors (already supported) and pass
`sysrootMount` through `opts`.

The mount is **read-only by convention** until the seam enforces it: hosts
must not write under `/.sysroot/…`.

---

## 5. Module-resolution build hook

`registerToolchain` auto-installs a Part B plugin named
`__toolchain_bridge:<name>` (a plain, non-`builtIn` plugin — it sits in
registration order; first registered toolchain wins an extension).
`toolchainBridgePlugin(tc)` is exported for hosts whose per-sandbox
`plugins: […]` lists shadow the global registry (`this.plugins` semantics
in `runtime.js` — shadowing also shadows bridges; install the bridge
explicitly in that case).

Decision flow per specifier (runs in the existing `_dynamic_import` →
`_build_file` pipeline; no new hook points were needed):

```
import "./add.c"  /  require("./native-addon")
        │  _dynamic_import interop (host)
        ▼
applyResolvePlugins (first match wins)
 ├─ "./add.c" matches extensions [".c"]
 │    → claim { path:"./add.c", namespace:"toolchain:<name>" }
 ├─ "./native-addon" (bare, no extension) AND exists() probe hits
 │    "./native-addon.c" → claim { path:"./native-addon.c",
 │                                 namespace:"toolchain:<name>" }
 └─ no claim → default VFS → node_modules → CDN resolution
        │  _build_file: namespace re-derived, applyLoadPlugins
        ▼
bridge onLoad (filter + namespace match)
 └─ compileWithToolchain(name, { "<base>": source }, { entry:"<base>" })
 └─ return { contents:<wasm bytes>, loader:"wasm" }
        │  dispatchLoader "wasm" (existing)
        ▼
ESM exporting the instance's exports
(require() callers get module.exports; see runtime.js _build_file)
```

Notes:

- The `onLoad` `source` arg is the default text load — single-file builds
  need no VFS accessor. Multi-file builds use the toolchain's `readFile`.
- Bare-specifier probing **requires** the `exists` accessor; without it
  the bridge passes through so the default resolver raises an honest
  `MODULE_NOT_FOUND` instead of a late, confusing compile error.
- Hook errors follow the Part B contract: wrapped in `PluginError`
  attributed to `__toolchain_bridge:<name>`, with the `ToolchainError`
  message preserved.
- **Open:** the `wasm` loader instantiates with `{}` imports. Reactor-style
  modules (no imports, like the stub's `add`) work through
  `import "./add.c"` today; WASI-command modules (which need
  `wasi_snapshot_preview1` imports) should go through
  `compileToolchain` → `runWasi` instead. Wiring WASI imports into the
  loader is follow-up work owned by the runWasi seam.

---

## 6. Host API on CodeSandbox

```js
await sandbox.mountToolchainSysroot("wasi-clang"); // → "/.sysroot/wasi-clang"
const { bytes, warnings } = await sandbox.compileToolchain("wasi-clang",
  { "add.c": "int add(int a,int b){return a+b;}" }, { cflags: ["-O2"] });
const { exitCode, stdout } = await sandbox.runToolchain("wasi-clang",
  { "main.c": "…" }, { args: ["prog.wasm"], cflags: ["-O2"] });
// runToolchain: args/env/preopenDir → runWasi; everything else → compile()
```

---

## 7. Reference stub plugin

`tests/toolchain-stub-plugin.js` — **not core, never shipped**. Implements
the contract against a fake compiler: validates the entry source defines
the expected symbol, otherwise emits a hand-assembled wasm module
(`add` + `_start` + `memory`). It proves register → compile → bytes →
runWasi and the resolution bridge without any toolchain. Copy its shape
when writing a real plugin; replace `compile` with the real thing.

## 8. Test contract

`tests/toolchain-plugin.test.js` (52 tests): registration validation table,
duplicate rejection, unregister + bridge removal, rollback on failed bridge
install, compile contract (bytes → instantiate → `add(40,2)===42`;
`runWasi` exit 0; error diagnostics; rustc-shaped record), sysroot
mounting/idempotence, and the resolution decision flow through the real
`applyResolvePlugins` / `applyLoadPlugins` / `dispatchLoader`.
