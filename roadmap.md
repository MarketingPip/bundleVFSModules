# bundleVFSModules Roadmap

The plan of record for the runtime. Completed work stays listed briefly for
context; planned work is ordered by priority. One PR per change; merge only
on green "Run Tests" + "Build VFS".

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

### 1. Toolchain plugin architecture — support, don't ship, the toolchain

**Philosophy** (2026-09-27): same rule as the shell — we never bake in the
toolchain, developers bring their own; the runtime provides the *support* so
a toolchain plugin can work. clang.wasm is real and shipping (clang + lld as
wasm32-wasi modules, e.g. msorvig/llvm-wasi), but it is tens of MB and stays
a plugin, never core.

**Seams to add** (design stage):

- `runtime.runWasi(bytes, { args, env })` — first-class wasm32-wasi
  execution wired to `__FS__` and the virtual net. Useful with zero plugins
  installed: runs *any* prebuilt wasm32-wasi module (sqlite.wasm, codecs,
  …) against our VFS. A clang plugin just becomes one producer of such
  modules.
- `globalThis._RUNTIME_.registerToolchain({ name, compile(files, opts),
  sysroot })` — the runtime mounts the sysroot into the VFS, calls
  `compile()` to get wasm bytes, feeds them to `runWasi`. Core never knows
  what clang is.
- VFS read-only lazy mounts capable of hosting a sysroot (headers + libs).
- Module-resolution build hook: `require('./foo.c')` may resolve to
  "compile via registered toolchain → instantiate → exports". Makes plugins
  feel native instead of bolted on.

**Unlocks**: an honest answer for native addons (the `node-gyp` gap becomes
"install the toolchain plugin" instead of "not supported"); a real
`child_process` backend for toolchain commands; prebuilt WASM modules as
first-class citizens.

**Non-goals**: shipping clang.wasm in core; promising N-API compatibility
(enormous surface); designing the core around any single toolchain. The core
only knows "compile sources → wasm bytes" and "run wasm bytes on my VFS".

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
