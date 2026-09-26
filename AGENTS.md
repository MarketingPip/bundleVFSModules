# AGENTS.md — bundleVFSModules

Browser-native shims for every Node.js builtin, with the goal of **true Node.js
behaviour in the browser** — better fidelity than AlmostNode, NodePod, or
WebContainers.

If you are an agent working in this repo, read this file first, then
`docs/RUNTIME.md` (how the host runtime loads our code) and
`docs/SHIM_AUTHORING.md` (how to write a new shim).

## How the pieces fit

```
src/*.js                      ESM shims, one per Node builtin
        │  src/build-vfs.mjs (esbuild, platform:"browser")
        ▼
dist/<key>.js + dist/vfs.js   published via jsDelivr, pinned by commit
        │  runtime.js (repo root — Jared's host, runs user code in an iframe)
        ▼
_RUNTIME_.loadModule("fs") → _dynamic_import interop → sandboxModules["fs"]
        │  _build_file: CJS→ESM, import→loadModule rewrites,
        │              globalThis._RUNTIME_ → globalThis._RUNTIME<uuid>_
        ▼
executed in the sandbox, imports resolved recursively
```

`node:timers/promises` → bundle key `timers_promises`;
`RUNTIME:NODE_GLOBALS` → `RUNTIME_NODE_GLOBALS` (`src/node_globals.js`, loaded
at sandbox startup to install globals like `Buffer`, `setImmediate`).

## The `_RUNTIME_` contract

- In shim sources, **always write `globalThis._RUNTIME_`**. The runtime
  AST-rewrites exactly that `MemberExpression` to the sandbox-scoped object.
  A bare `_RUNTIME_` is never rewritten and throws `ReferenceError`.
- Outside the sandbox (parity tests under real Node, direct `import`), it is
  undefined — guard with `typeof globalThis._RUNTIME_ !== "undefined"`.
  The guard survives the rewrite.
- Never touch `window`/`document` at module scope; use `globalThis` so shims
  stay worker-loadable.

### Special runtime variables

| Variable (on the sandbox `_RUNTIME<uuid>_` object) | Set by | Purpose |
|---|---|---|
| `.process` | host config | `title, arch, env, platform, pid, ppid, argv, argv0, execPath, execArgv, version, versions` |
| `.__USER_FILES__` | host config | seed `{ path: contents }` for the virtual FS |
| `.__FS__` | our `src/fs.js` | singleton virtual filesystem |
| `.__httpServerRunTime` | our `src/http.js` | `{ handleRequest(port, url, method, body, headers), waitForAllServers() }` — the runtime calls `handleRequest` for emulated inbound requests |
| `.taskTracker` | runtime (`GlobalTracker`) | in-flight async work tracking; `waitForIdle()` |
| `.loadModule(name)` | runtime | load another builtin by bundle key |
| `.emit` | runtime | forward console/events to the host |
| `.globals` | runtime | snapshot of host globals at bootstrap |
| `._TEST_RUNNER_`, `.__RUNTIME_RESOLVE__HANDLE` | runtime | test-runner and `import.meta` resolver wiring |

## Non-negotiable rules

1. **Browser-first.** Every shim must work with zero native-Node delegation.
   Official parity tests run under real Node and mostly exercise the facade;
   the browser-fallback lane (native builtins disabled) is the real proof.
2. **Noop over throw.** APIs that cannot exist in a browser (UDP sockets, raw
   TLS, …) become honest noop stubs, never throws.
3. **Don't "simplify" runtime integrations.** `src/{fs,http,module,process,
   child_process,test}.js` and `src/runtime/*` carry `_RUNTIME_` wiring —
   preserve it.
4. **Dependencies allowed — don't reinvent the wheel.** Prefer a maintained
   npm package over hand-rolling an algorithm or protocol (decision order in
   `docs/SHIM_AUTHORING.md` rule 1). The dep must survive the build: esbuild
   `platform: "browser"`, running from a string of source in the sandbox.
   If an npm shim already exists, test it before replacing it.
5. **100% parity where achievable** for deterministic modules; record honest
   gaps instead of faking them (`parity/expected-failures.json` is `{}`).

## Working in this shared tree

Multiple agents work here concurrently. Behave accordingly:

- Explicit file lists only. Never `git add .`, `git checkout -- .`,
  `git clean`, or bulk `git reset`.
- **One PR per module.** Never bulk-commit shared files
  (`parity/preload.mjs`, `parity/run.mjs`, `dist/*`,
  `.github/workflows/run.yaml`) — they carry everyone's work.
- HTTPS push has no credentials. Ship via the git-database API:
  `~/workspace/skills/github/bin/gh.py` (fetch live base SHA → create blobs →
  tree with `base_tree` → commit → `/git/refs` (plural) → PR). Read
  `~/workspace/skills/github/SKILL.md` first; retry transient disconnects.
- Don't claim a score until repo tests **and** vendored official tests
  **and** differential checks vs real Node pass on the pushed branch.

## Commands

- Repo tests: `npx --no-install jest tests/<name>.test.js`
  (assert suites need `NODE_OPTIONS=--experimental-vm-modules`)
- Parity suite: see `parity/README.md`; runner is `parity/run.mjs`
- Syntax check: `node --check src/<name>.js`
- Build: `node src/build-vfs.mjs` (needs `dist/`; uses esbuild)
