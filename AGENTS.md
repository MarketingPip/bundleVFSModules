# AGENTS.md — bundleVFSModules

Browser-native shims for every Node.js builtin, with the goal of **true Node.js
behaviour in the browser** — better fidelity than AlmostNode, NodePod, or
WebContainers.

If you are an agent working in this repo, read this file first, then
`docs/RUNTIME.md` (how the host runtime loads our code),
`docs/SHIM_AUTHORING.md` (how to write a new shim), and
`docs/SINGLETONS.md` (what must be singleton, what must not).

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
| `.__httpServerRunTime` | our `src/http.js` | `{ handleRequest(port, url, method, body, headers), waitForAllServers(), closeServer(port) }` — the runtime calls `handleRequest` for emulated inbound requests; `closeServer` forcibly closes the server on a port (host revokes a lost port claim) |
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
6. **Fix the platform, don't write library-specific shim code.** Adopted from
   AlmostNode's CLAUDE.md (2026-09-28 competitor study). A shim that exists
   only to satisfy one consumer — a Sentry remap, a framework-specific path
   rewrite — is a bug in the platform layer. Fix `src/node_globals.js`, the
   VFS, or the `_build_file` transform instead. Library-specific workarounds
   belong in the consumer's repo, never in core.
7. **No silent fakes.** Extends rule 2: an API that reports success for
   something that never happened is worse than a loud noop. `net.connect()`
   to a dead host must never emit `'connect'`; an unlistened loopback port
   gets a real `ECONNREFUSED`. Honest error or honest noop — never a fake
   success. (Nodepod's fake `net.connect()`/`dgram.send()` are the
   anti-pattern; see `docs/COMPETITOR_TECHNIQUES.md`.)
8. **WASM-of-the-real-thing for hard surfaces.** For surfaces too deep to
   reimplement faithfully (SQLite, …), ship the WASM build of the real
   implementation — the wa-sqlite pattern — instead of a from-scratch engine.
   Reimplementation needs a stated reason, recorded in the commit.
9. **Differential testing for emulated external behavior.** Where we emulate
   something with a real-world counterpart (dns, http), CI runs the
   real binary and diffs stdout/stderr/exit code — Nodepod's
   `bash-differential.test.ts` pattern. Catches drift our own assertions
   can't see. No shell differential — we don't build a shell (rule 11).
10. **The capability matrix is generated, never hand-written.** `module × API
    × status` (implemented / honest-noop / unsupported-with-reason) must be
    derivable from code and CI. Hand-written tables rot — we watched it
    happen to AlmostNode's README.
11. **No shell, no package manager as product.** We are a runtime library,
    not a dev environment: no shell emulation, no npm-install product, no
    esbuild anywhere (way too heavy — our `_build_file` transform stays the
    CJS→ESM path). The one exception is a clearly-marked **demo-only** fake
    shell for developers learning the library — npm install-time behavior
    (reads each package's `bin` field, routes through the runtime's `node`)
    plus sample code — which must never sit on the product path.

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
