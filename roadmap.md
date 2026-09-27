# bundleVFSModules Roadmap

The plan of record for the runtime. Completed work stays listed briefly for
context; planned work is ordered by priority. One PR per change; merge only
on green "Run Tests" + "Build VFS".

## Direction

The north star: true Node.js behaviour in the browser — a better
Node-in-browser runtime library than AlmostNode, NodePod, or WebContainers.

The path there is continued builtin parity: porting Node's own `lib/*.js`
sources for parity-critical modules, measured against Node's official test
suites through the parity harness and scoreboard (`parity/`, CI "Parity"
job). Dependencies are allowed where they beat hand-rolled code (maintained
npm packages over reinventing, platform APIs where native);
unimplementable-in-browser APIs stay honest noop stubs, never throws.

## Recently completed

- **http.js virtual-network round trip — phase 1** (PR #99, merged
  2026-09-26): incremental HTTP/1.x parser (`src/_http_parser.js`); real
  virtual-socket `http.Server` accept path over `net.js` (byte-level parsing,
  real `req.socket`, keep-alive, chunked, 100-continue).
- **http.js virtual-network round trip — phase 2** (PR #100, merged
  2026-09-26): client loopback and host `__serverRequest__` bridge now dial
  real `net.Socket`s — genuine request/response bytes through the phase-1
  parser instead of synthetic sockets. `Server.prototype.handleRequest()`
  kept as the public direct API.

## Planned

### 1. Toolchain plugin architecture — opt-in power for library users

**Philosophy** (2026-09-27): we never ship a toolchain in core. It stays a
plugin that developers *choose* to install, so they can unlock more power
from the library: node modules with C code working through a compile step,
WASI modules executed against the VFS, and other toolchain-shaped
capabilities. Same rule as the shell — never bake it in, provide the
*support*.

**Seams to add** (design stage):

- `runtime.runWasi(bytes, { args, env })` — first-class wasm32-wasi
  execution wired to `__FS__` and the virtual net. Useful with zero plugins
  installed: runs *any* prebuilt wasm32-wasi module against our VFS.
- `globalThis._RUNTIME_.registerToolchain({ name, compile(files, opts),
  sysroot })` — the runtime mounts the sysroot into the VFS, calls
  `compile()` to get wasm bytes, feeds them to `runWasi`. Core never knows
  what clang is.
- VFS read-only lazy mounts capable of hosting a sysroot (headers + libs).
- Module-resolution build hook: `require('./native-addon')` may resolve to
  "compile via registered toolchain → instantiate → exports", so node
  modules with C sources work for developers who install the plugin.

**Unlocks** (all opt-in, none in core): node modules with C code compile and
run in the browser; WASI programs execute against the runtime VFS; WASI
socket calls bridge to the virtual net so compiled programs use the same
virtual networking as the Node shims.

**Non-goals**: shipping any toolchain in core; using the plugin to build our
own parity shims (core shims stay ported JS — the plugin is for library
*users*, not for us); promising N-API compatibility; designing the core
around any single toolchain. The core only knows "compile sources → wasm
bytes" and "run wasm bytes on my VFS".

### 2. Interop audit leftovers

- Fix possibly reversed direction headings in interop docs.
- Update the main `__serverRequest__` example from the legacy argument
  order.
- Complete Chrome 137 verification: iframe / postMessage /
  `sandbox.invoke()` and the cookie wrapper.
- Resolve the runtime-template source of truth.

### 3. Full-suite open-handle investigation

Full jest run passes all assertions but Jest reports it "did not exit one
second after the test run" (2026-09-26). Investigate with
`--detectOpenHandles` and suite isolation. Do not assume the http/net
changes caused it — measure first.
