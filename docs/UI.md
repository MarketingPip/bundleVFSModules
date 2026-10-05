# UI Playground Framework

The demo playground lives in `src/ui/playground.js` — **not** in `runtime.js`.
`runtime.js` is a pure library: no demo DOM, no xterm import, no
auto-executing demo code, no `__BVM_DISABLE_PLAYGROUND`. It can be imported
by any host page with zero side effects.

## Architecture

```
ui.html (thin page: HTML + one init call)
   │  import { CodeSandbox } from './runtime.js'
   │  import { initPlayground } from './src/ui/playground.js'
   ▼
src/ui/playground.js — the ONE framework
   │  initPlayground({ CodeSandbox, examples, useXterm, sandboxOptions, ids })
   │  EXAMPLES (20 canonical snippets) · createDemoSandbox · wireDemoHandlers
   │  splitArgv · renderFiles/renderFiles2 · refCheck
   ▼
runtime.js — pure library (CodeSandbox, transpileTypeScript,
  flattenFileTree, builtinModules, formatErrors, customAcorn, …)
```

## History

`runtime.js` used to contain a 2,477-line demo playground (an xterm-based
`initPlayground`, a module-level example `CodeSandbox`, snippet maps, and a
`__BVM_DISABLE_PLAYGROUND` auto-init guard). `ui.html` had its own newer
inline wiring and had to set the disable flag to suppress the built-in one.
The demo code was extracted to `src/ui/playground.js`; `ui.html`'s wiring —
streaming stdout via `execution:stdout`, argv parsing, stdin handling — was
the reference the unified `initPlayground` was built from, with the older
xterm wiring kept as opt-in `useXterm` mode.

## Usage

```html
<script type="module">
import { CodeSandbox } from './runtime.js';
import { initPlayground } from './src/ui/playground.js';
initPlayground({ CodeSandbox });
</script>
```

Expected DOM ids (overridable via `ids`): `codeInput`, `runBtn`, `argvInput`,
`stdinInput`, `sendInput`, `clearBtn`, `output`, `status`, `execTime`,
`files`, and `.example-btn[data-example]` buttons.

Options:

| Option | Default | Purpose |
|---|---|---|
| `CodeSandbox` | (required) | The `CodeSandbox` class from `runtime.js` |
| `examples` | `EXAMPLES` | Snippet map for the example buttons |
| `useXterm` | `false` | `true` → xterm.js terminal output instead of DOM divs |
| `sandboxOptions` | `{}` | Extra options for `new CodeSandbox()` |
| `ids` | `{}` | DOM id overrides |

Returns the `CodeSandbox` instance.

## Notes

- `initPlayground` runs `refCheck` on the code before executing (with the
  demo globals allowed, including `globalThis`); TypeScript examples are
  transpiled first via `transpileTypeScript`.
- Stdout streams in real time via `execution:stdout` with dedupe against
  the buffered `result.logs`.
- `createDemoSandbox(CodeSandbox)` + `wireDemoHandlers(sandbox)` preserve
  the legacy standalone demo (esm.sh transform rules, seeded FS, interop
  registrations) for pages that want it explicitly.
