# Plugin API — spec, usage, and design

> This document supersedes the `PLUGIN_API_DESIGN.md` referenced in
> `runtime.js` and `roadmap.md` (that file was never written — this is it).

Plugins extend the module-loading pipeline with custom language support
(TypeScript, C via clang, …) without hardcoding into the core runtime.

This document has two parts:

- **Part A — the implemented API** (shipped, tested): the `transform` hook.
  This is the contract your plugin code implements today.
- **Part B — the design for the smart plugin system**: `onResolve`/`onLoad`
  extension hooks (esbuild-style), true type-checking, scoping, and the
  error contract. This is the target your next plugin (e.g. clang) is
  written against once the hooks land.

---

## Part A — Implemented API (v1)

### Spec

```js
import {
  registerPlugin,
  unregisterPlugin,
  getPlugins,
  clearPlugins,
} from "./src/plugins.js"; // or "bundleVFSModules/plugins" once packaged

registerPlugin({
  name: "my-plugin",          // required, unique string
  transform(code, id),        // optional; see below
});
```

**`transform(code, id)`**

- `code: string` — the module source as loaded (UTF-8 text).
- `id: string` — the module identifier (VFS path or URL), e.g.
  `"/src/greet.ts"`.
- Return a `string` to replace the source, or `undefined` (or nothing) to
  pass through untouched.
- May be `async`.
- Runs **once per module, parent-side**, at the top of `_build_file` —
  **before** CJS/ESM detection, before import rewriting, before the source
  map registry. Your output must be parseable JavaScript (or JSON — see
  loaders below), because the acorn-based pipeline runs on what you return.
- Plugins run in **registration order**; each sees the previous plugin's
  output (chained, like esbuild).

Management:

| function | behavior |
|---|---|
| `registerPlugin(p)` | throws `TypeError` if `p.name` isn't a string; throws if the name is already registered |
| `unregisterPlugin(name)` | removes it; returns `true`/`false` |
| `getPlugins()` | snapshot array, registration order |
| `clearPlugins()` | removes all (tests use this in `beforeEach`) |

### Where it runs in the pipeline

```
host loads source (VFS / CDN / fs seed)
        │
        ▼
_build_file(source, fileName, …)          ← parent side
        │
        ├── ① applyTransformPlugins(source, fileName)   ← YOU ARE HERE
        ├── ② detectModuleSystem (acorn)
        ├── ③ CJS→ESM conversion if needed
        ├── ④ import → loadModule rewrites, _RUNTIME_ scoping
        └── ⑤ source-map registration
        │
        ▼
iframe executes the built module
```

The iframe never sees your plugin; it only ever receives built JS.
That means plugins are **host-side only** — they can `import` npm
packages, use `fetch`, and do heavy work without bloating the sandbox.

### Usage — host side

```js
import { CodeSandbox } from "./runtime.js"; // TS plugin auto-registered
import { registerPlugin } from "./src/plugins.js";

registerPlugin({
  name: "strip-logs",
  transform(code, id) {
    if (!id.endsWith(".js")) return; // passthrough
    return code.replace(/console\.log\(.*?\);?/g, "");
  },
});

const sb = new CodeSandbox({ /* … */ });
await sb.execute(`import "./app.ts";`); // .ts handled by the TS plugin
```

### Reference: the TypeScript plugin (`src/plugins/typescript.js`)

The only shipped plugin. It demonstrates every convention a new plugin
should follow:

```js
export const typescriptPlugin = {
  name: "typescript",
  async transform(code, id) {
    if (!id.endsWith(".ts") && !id.endsWith(".tsx")) return undefined;
    const ts = await loadCompiler();          // lazy — see below
    const out = ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,         // keep ESM; _build_file
        target: ts.ScriptTarget.ES2020,       // handles the rest
        experimentalDecorators: true,
      },
      fileName: id,
    });
    return out.outputText;
  },
};
```

Conventions to copy:

1. **Extension-guard first.** Return `undefined` fast for files you don't
   own. Every plugin sees every module.
2. **Lazy-load heavy dependencies.** The TS compiler (~8 MB) loads on the
   first `.ts`/`.tsx` transform, never for pure-JS workloads. Under Node it
   imports the npm `typescript` package; in the browser host it imports the
   same pinned version from `https://esm.sh/typescript@5.9.2`.
3. **Emit ESM.** `module: ESNext` preserves `import`/`export` so the
   downstream pipeline (CJS detection, import rewriting) behaves.
4. **Transpile-only contract.** `ts.transpileModule` is per-file: no type
   information, no cross-file checks — the same contract as esbuild,
   sucrase, and Node's native type-stripping. True type-checking is a
   separate hook (Part B §3).

The plugin is **auto-registered** at module scope in `runtime.js`, so
`.ts`/`.tsx` work out of the box with zero host configuration.

---

## Part B — Design for the smart plugin system

The v1 `transform` hook is deliberately minimal. These are the hooks the
system grows to support clang (`.c` → WASM), true type-checking, and any
future language — designed esbuild-style, mapped onto our pipeline.

### 1. The gap v1 doesn't cover

`transform` only sees source **after it has been loaded as text**. It
cannot:

- **Claim a file extension at resolve time.** Today `.json` is hardcoded
  in `_build_file` and `.wasm` is special-cased in CDN fetching. A clang
  plugin can't teach the resolver that `import "./add.c"` is a thing.
- **Produce non-text modules.** A `.c` file compiles to a WASM binary,
  not to JS source text. `transform` must return a string.
- **Type-check.** `transpileModule` is per-file by design.

### 2. Proposed hooks: `onResolve` / `onLoad`

Modeled on esbuild's plugin API, adapted to our two-stage pipeline
(parent `_build_file` + iframe `_dynamic_import` interop):

```js
registerPlugin({
  name: "clang",

  // Decide WHAT a path means. Runs wherever resolution happens:
  // parent resolveVFS and the _dynamic_import interop handler.
  onResolve: [
    {
      filter: /\.c$/,                 // RegExp tested against the specifier
      namespace: "clang",             // isolates plugin-owned paths
      resolve(args) {
        // args: { path, importer, kind }
        return { path: args.path, namespace: "clang" };
      },
    },
  ],

  // Decide HOW a resolved path loads. Runs in _build_file before
  // transform, replacing the default text load.
  onLoad: [
    {
      filter: /\.c$/,
      namespace: "clang",
      async load(args) {
        // args: { path, namespace }
        const cSource = readFromVFS(args.path);   // host VFS access
        const wasm = await compileC(cSource);      // WASI clang, lazy
        return {
          contents: wasm,            // Uint8Array allowed, not just string
          loader: "wasm",             // see §3
        };
      },
    },
  ],
});
```

**Semantics:**

- `onResolve` entries run in registration order; the **first match wins**
  (esbuild behavior). No match → default resolution (VFS → node_modules →
  CDN).
- `namespace` keeps plugin-owned paths from colliding with real files.
  A resolved `{path, namespace}` pair is the module's identity from then
  on; the default loader never touches namespaced paths.
- `onLoad` entries are matched by `filter` **and** `namespace`. First
  match wins; no match → default text load → `transform` chain (v1
  behavior preserved).
- `transform` (v1) keeps running **after** `onLoad`, on the `contents`
  the loader returned (coerced to string for text loaders). Existing
  plugins are unaffected.

**Where they slot into the pipeline:**

```
import "./add.c"  (iframe)
        │ _dynamic_import interop
        ▼ parent
① onResolve chain ──► { path:"/src/add.c", namespace:"clang" }
        │
② onLoad chain ──► { contents:<wasm bytes>, loader:"wasm" }
        │
③ transform chain (v1 — TS plugin etc. see text loaders only)
        │
④ loader dispatch: "js" → existing pipeline · "json" → JSON.parse
   "wasm" → instantiate + wrap exports · "text" → export string
        ▼
iframe executes
```

### 3. Loaders

`onLoad` returns a `loader` naming how the contents enter the module
system. Initial set:

| loader | contents | result |
|---|---|---|
| `"js"` | string | existing `_build_file` pipeline (default) |
| `"json"` | string | `JSON.parse` (replaces today's hardcoded `.json` branch) |
| `"text"` | string | module exports the string |
| `"wasm"` | `Uint8Array` | instantiated; module exports the instance's `exports` |

Moving `.json` handling into a **built-in plugin** (registered first, lowest
priority) proves the hook covers what used to be hardcoded — the AGENTS.md
rule "fix the platform, don't hardcode" applies to our own pipeline too.

### 4. True type-checking

Transpile-only (`transpileModule`) is per-file: it strips types without
knowing whether they're *correct*. True checking needs a whole-program
view. Proposed as an **opt-in second hook**, not part of `transform`:

```js
registerPlugin({
  name: "typescript",

  // …transform as today (fast path: strip types, run code)…

  // Slow path: full type-check, runs on demand (e.g. host calls
  // sandbox.typecheck() or the ui.html "Check types" button).
  async typecheck(files) {
    // files: [{ path, contents }] — the program roots + VFS snapshot
    const program = ts.createProgram(files.map(f => f.path), options, vfsHost);
    return ts.getPreEmitDiagnostics(program).map(d => ({
      file: d.file?.fileName,
      line: d.file && d.file.getLineAndCharacterOfPosition(d.start).line + 1,
      column: …,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      code: d.code,
    }));
  },
});
```

Design points:

- **Separate from execution.** Type-checking is 10–100× slower than
  transpiling and needs the full VFS in a `CompilerHost`. It must never
  block `execute()`. The host opts in explicitly.
- **Diagnostics surface** through `execution:stderr` (see §7) or a
  dedicated `execution:diagnostics` event — undecided; either way they are
  *not* mixed into `execute()`'s `logs`.
- **Incremental programs.** The plugin caches the `ts.Program` across
  calls and reuses it when the VFS snapshot is unchanged (esbuild watch
  mode does the same). Without this, checking on every keystroke is
  unusable.
- The **fast path stays the default**: strip types and run, exactly like
  esbuild and Node's type-stripping. Type errors never block execution
  unless the host asks.

### 5. Scoping: global vs per-sandbox

Today the registry is **module-global**: every `CodeSandbox` on the page
shares plugins. For a playground page running untrusted user code, a
plugin is host configuration — global is fine. But hosts embedding
multiple sandboxes with different languages want isolation.

Proposed: `new CodeSandbox({ plugins: [...] })` — a per-sandbox list that
**shadows** the global registry for that sandbox (union would make
ordering ambiguous; shadowing is predictable and easy to document).
`getPlugins()` keeps reporting the global set.

### 6. Ordering and conflicts

- Within one hook kind, **registration order wins, first match wins**
  (esbuild semantics — no priority numbers to argue about).
- Two plugins claiming the same extension: the first registered owns it.
  The loser can still match on `namespace` if the winner re-exports, or
  the host reorders registration. Document it; don't build a resolver UI.
- `transform` (v1) stays last in the chain and keeps its "return string or
  undefined" contract.

### 7. Error contract

A plugin that throws today breaks `_build_file` opaquely. Proposed
contract:

- Throw (or return) a **`PluginError`** carrying `{ plugin, file, line?,
  column?, message }`. The pipeline catches it at the hook boundary and
  converts it to the existing `function_error` result shape
  (`{ success: false, error, stack }`) with the plugin name in the frame,
  so stack-mapping and the ui.html error renderer work unchanged.
- A plugin must never leave the registry half-mutated on error; hook
  execution is all-or-nothing per module.

### 8. What a clang plugin looks like (sketch)

```js
// src/plugins/clang.js — sketch, not shipped
import { registerPlugin } from "../plugins.js";

let clangPromise = null; // lazy-load the WASI clang build (~tens of MB)

registerPlugin({
  name: "clang",
  onResolve: [{ filter: /\.c$/, namespace: "clang",
    resolve: (args) => ({ path: args.path, namespace: "clang" }) }],
  onLoad: [{ filter: /\.c$/, namespace: "clang",
    async load(args) {
      const clang = await (clangPromise ??= loadWasiClang());
      const src = readVFS(args.path);
      const wasm = await clang.compile(src, { target: "wasm32-wasi" });
      return { contents: wasm, loader: "wasm" };
    } }],
});
```

The host page then does `import { add } from "./add.c"` and gets the
WASM exports — the same shape as the existing Clang/WASI spike (PR #164),
but generalized through the plugin hooks instead of bespoke wiring.

> **Superseded:** this sketch is now implemented as the toolchain plugin
> API — see `docs/TOOLCHAIN.md`. `registerToolchain({ name, compile,
> sysroot })` (in `src/toolchain.js`, host-side, following the
> `registerPlugin` precedent) auto-installs exactly the `onResolve` /
> `onLoad` bridge sketched above, and `compile(files, opts)` is the
> generalized contract (`{ "main.c": "…" }` in, `{ bytes, warnings,
> errors }` out) that a clang plugin and a rustc plugin both satisfy.
> The reference stub (`tests/toolchain-stub-plugin.js`) proves it against
> a fake compiler.

---

## Decision: `execution:stderr`

**Recommendation: add `execution:stderr` as a derived alias event, keep
`execution:stdout` unchanged.**

Today every `console.*` call funnels through the single `execution:stdout`
event with a `type` field (`'log' | 'error' | 'warn' | …`). `console.error`
is stderr semantically, but the host has to branch on `type === 'error'`
itself (ui.html does exactly this).

The change is one branch in the parent's message handler:

```js
// parent, where data.type === "stdout" is handled today:
this.sandbox.emit("execution:stdout", { type: data.method, args: data.message });
if (data.method === "error" || data.method === "warn") {
  // Node routes console.error AND console.warn to fd 2.
  this.sandbox.emit("execution:stderr", { type: data.method, args: data.message });
}
```

Why an alias instead of a split:

- **Backward compatible.** Every existing host keeps working; nothing
  currently listening breaks.
- **Node-faithful.** `console.warn` → stderr in Node too, so the alias
  covers both, matching fd 2 semantics.
- **Cheap and local.** No iframe/bootstrap changes, no new message types
  on the interop channel, no result-shape changes.
- The `execute()` result keeps its single `logs` array (plus the
  already-separated `error`/`stack` on failure) — the streaming events
  are the live path; the result shape stays stable.

Hosts that render stderr separately (a red terminal pane, an error drawer)
subscribe to `execution:stderr`; everyone else ignores it. The docs note
in `docs/EVENTS.md` §4 already anticipates exactly this — this decision
resolves it.

---

## Test contract for new plugins

Every plugin ships with:

1. **Unit tests** (`tests/<name>-plugin.test.js`): register/unregister,
   passthrough for foreign extensions, transform output correctness —
   following `tests/plugin-api.test.js` and `tests/typescript-plugin.test.js`.
2. **Browser proof** (`tests/<name>-plugin-e2e.py` + `.html`): headed
   Firefox via Xvfb, driving the real `CodeSandbox` consumption path
   (the `tests/plugin-api-e2e.*` pattern) — Node/unit tests alone don't
   prove the pipeline.
3. **Lazy-load proof**: assert the heavy dependency (compiler, clang
   build) is not fetched until the first matching file is transformed.

---

## Open questions (for the implementing agent)

1. Should `onLoad`'s `loader` be a closed enum or an open registry
   plugins can extend (`registerLoader("wat", fn)`)? Closed enum first;
   open it when the third loader need appears.
2. `execution:diagnostics` vs reusing `execution:stderr` for type errors —
   lean `execution:stderr` (simpler host code), split later if hosts need
   structured diagnostics.
3. Per-sandbox `plugins` option: shadow vs merge — spec says shadow;
   revisit if a real host needs merge.
