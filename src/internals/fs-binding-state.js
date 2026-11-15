// Shared cell for the `fs` binding — the functions the shim routes its
// readFile-fstat, readdir, and writeFileSync-utf8-fast-path calls through.
//
// Why a cell: vendored fs tests patch `internalBinding('fs').fstat` /
// `.readdir` / `.writeFileUtf8` (and `binding.fstat` for the sync/callback
// readFile forms) and expect the shim to call the patched function — the
// same net #425 pattern as src/internals/stream-wrap-state.js. src/fs.js
// installs the default implementations (over memfs) in buildApi; the
// parity adapter (parity/internal-test-binding-adapter.mjs) exposes the
// same object for `internalBinding('fs')` as a prototype-merged window
// onto real Node's fs binding, so everything else (openFileHandle,
// FSReqCallback, read, ...) falls through to the real binding and the
// currently-passing consumer tests behave exactly as today.
//
// The cell is looked up by property on every call (never captured), so a
// test patch lands in the shim immediately. `kUsePromises` is the cell's
// own symbol — the shim compares against it, never against Node's.
export const fsBindingState = {
  fstat: null,
  readdir: null,
  writeFileUtf8: null,
  kUsePromises: Symbol("fs_use_promises_symbol"),
};
