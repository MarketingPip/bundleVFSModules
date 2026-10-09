# E2E feature-matrix — 20-example execution (VERIFIED)

Branch: `feat/e2e-20-example-execution` (from origin/main `d2a19291`).

Every one of the 20 `data-example` buttons in ui.html is **executed**
through the real playground path (headed Firefox under Xvfb, real
CodeSandbox iframe) with output assertions, by
`tests/ui-examples-execution-e2e.py`. The old 30/30 run only checked
that snippets loaded into `#codeInput`; that is not an execution verdict.

Run: `xvfb-run -a ~/workspace/venvs/ffauto/bin/python tests/ui-examples-execution-e2e.py [port]`
Result 2026-10-09: **20/20 PASS** (headed Firefox, local dist rewrite).

## Verified per-example expected output

Snippets live in `src/ui/playground.js` `export const EXAMPLES`. The test
clicks each example button (not just setting `#codeInput` — the click sets
`currentExample`, which the `typescript` example needs for its transpile
step), clicks `#runBtn`, scripts stdin via `#stdinInput` + `#sendInput`
for the interactive ones, and asserts `#status` reaches `Done` plus the
output substrings below.

| example | stdin script | verified output (status Done) |
|---|---|---|
| basic | — | `Hello from the browser sandbox!`, `2 + 2 = 4`, `Node version: v24.x` |
| async | — | `Stars: <n>` (live GitHub API; observed `0`), `Language: JavaScript`. Network-dependent (api.github.com). |
| sleep | — | `Waiting 1 second...`, `Done waiting!`, `Waiting 500ms more...`, `Finished.` |
| imports | — | mathjs via esm.sh: `Square root of 16: 4`, `2^10 = 1024`, `factorial(5) = 120`. Network-dependent. |
| require | — | `Joined path: /home/user/docs`, `Platform: linux` (UA-inferred), `Basename: c.txt` |
| process_kill | — | `tick 1`, `tick 2`, `tick 3`, `Terminating...`, `Process Exited` (runtime appends the exit line) |
| interop | — | `Interop channel available: true`, `Emitted playground-ping event` |
| top_level | — | `Top-level await result: 42`, `Delayed value: later` |
| typescript | — | `hello typed world`, `answer = 42`, `add(2, 3) = 5` (transpiled by the playground's TS step) |
| relative | — | `Resolve ./lib/util.js from /app: /app/lib/util.js`, `Relative from /app/src to /app/lib: ../lib` |
| tests | `--test` in argv (auto-filled by the example button) | `Tests registered — pass --test in argv to execute them.` + real spec output: `✔ addition works`, `✔ strings concatenate`, `ℹ tests 2`, `ℹ pass 2`, `ℹ fail 0` |
| cli | send `hello-stdin` at `Waiting for your input` | `You typed: hello-stdin`, `Uppercase: HELLO-STDIN` |
| cli_menu | send `2` at `Choice (1-3)` | `You picked: green` |
| inquirer | send `Jared` at `What is your name?`, `Python` at `Favorite language?` | `Hello, Jared!`, `Python is a great choice.` |
| repl | send `2+2` at banner, `exit` at `=> 4` | `=> 4`, `Bye!` |
| repl2 | send `x = 5`, `x * 2`, `exit` at each `=>` | `=> 5`, `=> 10`, `Bye!` |
| fs | — | `Wrote /tmp/hello.txt`, `Read back: Hello, virtual FS!` (+ `Exists: true`, `Files in /tmp:`) |
| child_process | — | `execSync type: function` then the honest-noop error: `exec unavailable in browser (expected): CodeSandbox: no shell configured. Pass a \`shell\` function in CodeSandbox options to enable child_process.` |
| http | — | `Server listening on port 3000`, `Response: Hello from virtual server! Path: /hello`, `Server closed.` (loopback fetch bridged to the virtual server by the host) |
| express | — | `App on :3001`, `/hello -> 200 Hello!`, `/json -> 200 {"ok":true}`, `/missing -> 404 not found` |

### `tests` auto-run now lives in the shim (fixed 2026-10-09)

The old gap — tests only *registered*, never executed, in the playground
path — is fixed. The mechanism was never an unwired `isTest` flag: the
sandbox template keyed its `--test` interception off `config.process.argv`
(`runtime.js` template:
``${config?.process?.argv.includes("--test") ? …test bootstrap… : …normal…}``),
which diverted user code through `_TEST_RUNNER_.execute()` instead of the
normal path. That interception is deleted; the trigger moved into
`src/test.js` `_maybeAutoRun()`:

- **Host lane** (playground, `_RUNTIME_` installed): auto-runs registered
  tests only when `--test` appears in `process.argv` (Node parity with
  `node --test`). Clicking the `tests` example button fills the argv box
  with `--test`. The shim runs the tests once, formats the collected events
  through each `--test-reporter` (default `spec`), and `console.log`s each
  output. Output text is real spec lines (`✔ addition works (0.123ms)`,
  `ℹ tests 2` / `ℹ pass 2` / `ℹ fail 0`). The sandbox completion gate is
  held (`taskTracker.start/stop`) until printing finishes.
- **`globalThis.__VITEST_SHIM_MANUAL__ = true`** opts out of auto-run even
  with `--test` (the run is then driven externally).
- **Real-Node lane** (including the parity harness's
  `{ parityForceShim: true }` `_RUNTIME_` marker) keeps unconditional
  auto-run — `parity/run.mjs` spawns children with no `--test` flag and
  official test files rely on it. Scheduling stays debounced: every
  `test()`/`suite()` call re-arms a `setImmediate`, so registrations across
  top-level awaits are picked up.

The E2E asserts all three host-lane behaviors: `--test` → real spec
output; no `--test` → registration line only, no test output; manual
opt-out with `--test` → registration line only, no test output.

### Test-harness notes

- stdin delivery is race-prone (a send can hit a sandbox mid boot/teardown
  and the `__stdin__` invoke times out after 10s). The driver confirms
  delivery via the page's `"> <text>"` echo, expected follow-up output, or
  — for inputs that make the program `process.exit()` (cli, cli_menu,
  inquirer-final, repl/repl2 `exit`) — the run reaching `Done`, since the
  sandbox can die before the interop call resolves and the echo then never
  prints. Retries happen only on a confirmed `Interop method failed` line
  with no delivery proof — never blindly, since a duplicate send would
  corrupt multi-prompt flows (inquirer).
- The playground kills executions after 30s (`Process Killed`); interactive
  examples must finish their stdin script inside that window.
- Network examples (`async`, `imports`) need the proxy relay at
  127.0.0.1:18080 (Firefox proxy prefs, localhost bypassed); they fail
  closed if egress is down.

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
