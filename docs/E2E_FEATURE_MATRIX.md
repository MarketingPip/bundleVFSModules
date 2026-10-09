# E2E feature-matrix plan — 20-example execution

Branch: `feat/e2e-20-example-execution` (from origin/main `d2a19291`).

Every one of the 20 `data-example` buttons in ui.html must be **executed**
through the real playground path (headed Firefox under Xvfb, real
CodeSandbox iframe) with output assertions. The old 30/30 run only checked
that snippets loaded into `#codeInput`; that is not an execution verdict.

## Per-example execution expectations

| example | how to execute | expected output |
|---|---|---|
| basic | run, empty argv | `hello ui` + `42` |
| async | run | promise resolution logs, Done |
| sleep | run | waited output, Done |
| imports | run | ESM import of builtin works, Done |
| require | run | CJS `require("fs")` works in browser, Done |
| process_kill | run | process lifecycle output, Done |
| interop | run | CJS/ESM interop output, Done |
| top_level | run | top-level await output, Done |
| typescript | run | TS stripped + executed, Done |
| relative | run | relative module resolution works, Done |
| tests | run | `node:test`-style runner output, Done |
| cli | run + stdin via Send | echo of input, Done (already covered) |
| cli_menu | run + stdin '2' | `You picked:` + `green` (already covered) |
| inquirer | run + stdin 'Jared'/'Python' | `Hello, Jared!` + `Python is a great choice.` (already covered) |
| repl | run + stdin `2+2`, `exit` | `=> 4`, `Bye!` (already covered) |
| repl2 | run + stdin `x = 5`, `x * 2`, `exit` | `=> 5`, `=> 10`, `Bye!` (already covered) |
| fs | run | `Hello, virtual FS!` + `Read back:` (already covered) |
| child_process | run | spawned child output, Done |
| http | run | server + client exchange output, Done |
| express | run | express-like server response, Done |

## Other matrix items (separate files)

- `tests/ondemand-require-e2e.py` — on-demand require browser matrix:
  cold nested static require (lazy-on-call investigation), dynamic
  `require(moduleName)`, uncalled dynamic require/import, never-reached
  conditional/block imports, import→require and require→import identity,
  live bindings, side-effect count, CJS default/named export shape,
  sandbox identity.
- `tests/terminal-gating-e2e.py` — DOM terminal vs `?xterm=1`; completion
  gating: unawaited fetch tracking, active stdin/events hold completion
  without polling, listener removal / process exit releases the gate.
- `runtime.js` — duplicated `inlineWasmDataUrls` guard (lines ~8460-8461):
  fix only with a regression test.
