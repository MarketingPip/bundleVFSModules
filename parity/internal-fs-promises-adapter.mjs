// Parity adapter for `require('internal/fs/promises')` used by the official
// Node fs tests test-fs-promises-file-handle-aggregate-errors.js,
// test-fs-promises-file-handle-close-errors.js and
// test-fs-promises-file-handle-op-errors.js (the only fs tests importing it).
//
// The problem: the tests patch `FileHandle.prototype.fd` and expect the
// shim's path-based promises ops (readFile/writeFile/truncate) to use the
// patched class — but without a redirect the require falls through to real
// Node's internal/fs/promises, whose FileHandle the shim never sees. The
// adapter exports the shim's FileHandle class (src/fs.js `_FileHandle`,
// a non-enumerable internal slot on the fs singleton — never published on
// fs or fs.promises). Same instance as the harness's: ESM caches by URL,
// so this import and the harness's `../src/fs.js` share one singleton.
//
// Harness-only; src/fs.js behavior is untouched beyond the `_FileHandle`
// slot and the fd accessor the tests patch (see NOTES-fs-filehandle-agg.md).
import shimFs from "../src/fs.js";

export const FileHandle = shimFs._FileHandle;
export default { FileHandle: shimFs._FileHandle };
