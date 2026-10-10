# runWasi — first-class WASI execution (roadmap §1)

`runtime.runWasi(bytes, { args, env })` runs a prebuilt wasm32-wasi
(preview1) module against the sandbox's virtual filesystem. It is a **core
seam**: the toolchain plugin architecture (compile C → wasm bytes → run)
builds on it, but no toolchain ships in core. Any wasm32-wasi binary runs
with **zero plugins installed**.

Two entry points:

| Entry | Wires to |
|---|---|
| `runWasi(bytes, opts)` from `src/runtime/runwasi.js` | An explicit `files` seed you pass in |
| `CodeSandbox.prototype.runWasi(bytes, options)` (`runtime.js`) | The sandbox's `config.fs`; guest file changes are written back into `config.fs` after the run |

```js
const { exitCode, stdout, stderr, files } = await sandbox.runWasi(wasmBytes, {
  args: ["prog.wasm", "foo"],   // argv; argv[0] is the program name
  env: { HOME: "/sandbox" },    // environment variables
  preopenDir: "/sandbox",       // guest mount point (default)
});
```

## What works

- **Bytes**: `Uint8Array` or `ArrayBuffer`; bad magic is rejected with a
  `TypeError` before anything runs.
- **stdio**: guest stdout/stderr are captured as `string[]` (one entry per
  line), returned separately — never mixed.
- **Filesystem**: the guest sees `preopenDir` as a real preopened virtual
  directory (`path_open` / `fd_read` / `fd_write` / `fd_readdir` /
  `fd_seek` / `fd_tell` / `fd_filestat_get` all operate on real open-file
  state). Files you seed via `opts.files` (flat `"/path"` keys) are
  visible to the guest; after the run, `result.files` is the post-run
  snapshot — seeded files reflect guest modifications, guest-created
  files are included. `CodeSandbox.runWasi` writes the snapshot back
  into `config.fs`, so later `execute()` / `runWasi()` calls observe it.
- **args / env**: delivered to the guest via the real preview1
  `args_*` / `environ_*` syscalls.
- **Exit codes**: `proc_exit(n)` returns `n` through `start()`
  (`returnOnExit: true` internally) instead of throwing.
- **WASI engine**: `@bjorn3/browser_wasi_shim` preview1, loaded lazily
  (~100KB bundled `dist/wasi.js` in browser hosts; `src/wasi.js` under
  Node). No bare specifiers leak into the browser.

## What doesn't work (documented, not faked)

- **Sockets**: the entire `sock_*` family returns
  `__WASI_ERRNO_NOSYS` (errno 52). There is no byte transport behind
  them yet — networking is honest-NOSYS until one exists. `proc_raise`
  is likewise NOSYS.
- **`returnOnExit: false` semantics**: a browser cannot
  `process.exit()`; the guest's `proc_exit` always flows back as the
  exit code. (Core `runWasi` never exposes the throwing lane.)
- **Partial stdio lines**: in capture mode the engine line-buffers
  output, but any trailing partial line is flushed when the instance
  finishes — nothing is silently dropped.
- **Host paths**: preopens are virtual directories, not host
  directories — Node's `UVWASI_ENOENT` host-path validation cannot be
  reproduced in a browser.

## Tests

- Unit: `tests/runwasi.test.js` — validation, the real Clang fixture
  (`tests/fixtures/hello-wasi.wasm`), args/env passing, VFS read/write,
  stderr separation, non-zero exit via a hand-assembled `proc_exit(42)`
  module. Run with
  `NODE_OPTIONS=--experimental-vm-modules npx --no-install jest tests/runwasi.test.js`.
- Browser E2E: `tests/runwasi-e2e.py` (driver) +
  `tests/runwasi-e2e.html` (page) — headed Firefox under Xvfb runs the
  real fixture **and** `CodeSandbox.prototype.runWasi` end to end,
  including write-back into `config.fs`. Verdict via document.title and
  the crash-proof POST /report channel.
