# AI_CONTRIBUTING.md

Task board for **external AI agents** (Claude Code, Vercel, other platforms)
who want to contribute to bundleVFSModules.

**Reserved:** these tasks are for external contributors only. The repo owner's
agents will not pick them up — if a box is unchecked, it's yours.

## How to contribute

1. Fork the repo, create one branch per task: `ai/<task-slug>`.
2. One PR per task. Keep diffs small and focused.
3. **Never touch the locked paths** listed below — active work lives there and
   your PR will conflict.
4. New files only, unless the task says otherwise.
5. Every code task needs a test that fails before and passes after (red-first).
6. Run the repo's checks before opening the PR (see repo README / verify docs).

## Locked paths (do not touch)

Active development is happening here. PRs touching these will be closed:

- `runtime.js` (generated bundle)
- `src/sandbox/20-module-loader.js`
- `src/sandbox/30-interop.js`
- `src/sandbox/*` (whole directory)
- `scripts/build-vite-seed.mjs`
- `scripts/build-vfs.mjs`, `src/build-sandbox.mjs`
- `tests/vite-build-proof.py`, `tests/vite-build-proof.html`
- `tests/rolldown-wasm-proof.py`, `tests/consumption-path-e2e.py`
- Branch `fix/wasi-worker-bundle`

## Tasks

### Build / plugins

- [x] **TypeScript plugin via real transpiler** — DONE by the runtime arc
  (2026-10-03, branch `feat/typescript-plugin-real`, v1 gate #3).
  `src/plugins/typescript.js` now uses the real `typescript@5.9.2` compiler
  (`ts.transpileModule`, lazy-loaded; npm package under Node, esm.sh in the
  browser host page). Do not duplicate this work.

- [ ] **Clang hello-world WASI spike**
  Prove a real Clang-produced WASI module through the browser runtime
  (the current 184-byte test module is hand-assembled, not Clang output).
  New files only: `scripts/clang-wasi-spike.mjs`, `tests/clang-wasi-spike.test.js`.
  Done when: C source compiled with a real Clang/WASI toolchain runs in the
  browser runtime and the test asserts its stdout.

- [ ] **Real Rolldown build proof**
  Invoke `rolldown()` on a small input and assert actual emitted output.
  New file only: `tests/rolldown-build-proof.py` (headed-Firefox pattern from
  the repo's other `*-proof.py` scripts).
  Done when: the proof builds a tiny entry, asserts emitted bytes contain a
  marker string, and passes headed.

### Shims

- [ ] **Missing builtin shims**
  Author real shims for builtins that currently have none (e.g.
  `trace_events`). One new file per builtin: `dist/<name>.js`.
  Done when: each shim loads through the existing `fetchBuiltinSource` path
  with no changes to the loader, and a test per shim proves its exports load.
  Never add generic `export default {}` fallbacks to hide missing shims.

- [ ] **Shim authoring examples**
  New file only: `docs/shim-examples.md`.
  Done when: it shows 3 complete before/after shim examples (Node API →
  browser implementation) following `docs/SHIM_AUTHORING.md` conventions.

### Docs / contract

- [ ] **Plugin API contract doc**
  New file only: `docs/plugin-api.md`.
  Done when: hook names, call signatures, execution order, and error
  semantics are fully specified. Spec only — no implementation in the
  `_build_file` path.

### Investigation (report only, no code changes)

- [ ] **Profile `transformImportsToLoadModule`**
  New file only: `scripts/profile-transform.mjs` + findings in the PR body.
  Done when: the report breaks down where time goes on a large input
  (parse vs MagicString vs source-map generation) with measured numbers.
  Do not change the transform itself.

- [ ] **Root-cause the Jest suite hang**
  The full suite (177 files) times out after 600s. Investigate and report.
  Done when: the PR/issue names the hanging file or handler with evidence
  (bisection log, not guesses). Code fix optional — the diagnosis is the
  deliverable.

## Questions

Open an issue tagged `ai-contrib` instead of guessing. Include what you tried
and the exact file/line numbers involved.
