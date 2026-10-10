// Host/iframe output-stream shim (Worker F extraction, branch modular/host).
//
// Source: runtime.js lines 4900-4938 (`makeOutputShim2`), copied verbatim
// except for the added `export` keyword.
//
// ORIGIN — iframe-side code: this function is defined INSIDE the `_getState`
// interop template literal (runtime.js:4635-5005) that builds the sandboxed
// iframe's bootstrap IIFE. It is NOT host-side code.
//
// STATUS — dead code: `makeOutputShim2` is never called anywhere in
// runtime.js. The live output shims are the (separate) `makeOutputShim`
// defined later in the same template.
//
// FREE-VARIABLE DEPENDENCIES (resolved from the enclosing scope at the use
// site — inside the iframe these are the iframe's own globals):
//   - `Writable`  (stream.Writable; the template has `//const { Writable } =
//      require('stream');` commented out just above the definition)
//   - `Buffer`
//   - `process` (with `.stdout` / `.stderr`)
// Per the established worker convention these stay bare references; tests
// install faithful equivalents on globalThis.
/* global Writable */

export function makeOutputShim2(type) {
  const isError = type === "stderr";

  // Inherit from Writable to get all internal Node logic for free
  const stream = new Writable({
    decodeStrings: false, // Prevents automatic conversion of strings to buffers
    write(chunk, encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk.toString() : chunk;

      // Use process.binding or low-level write if you want to avoid console.log
      // but for a shim, this is the safest way to ensure output visibility.
      if (isError) {
        process.stderr.write(data);
      } else {
        process.stdout.write(data);
      }

      // Node specs require calling the callback to signal the write is finished
      callback();
    },
  });

  // TTY Specific properties required by CLI tools (like chalk or inquirer)
  Object.defineProperties(stream, {
    isTTY: { value: true },
    fd: { value: isError ? 2 : 1 },
    columns: { value: process.stdout.columns || 80, writable: true },
    rows: { value: process.stdout.rows || 24, writable: true },
    isRaw: { value: false, writable: true },
  });

  // Mandatory TTY methods for cursor manipulation
  stream.clearLine = (dir, cb) => {
    if (cb) cb();
    return true;
  };
  stream.cursorTo = (x, y, cb) => {
    if (cb) cb();
    return true;
  };
  stream.moveCursor = (dx, dy, cb) => {
    if (cb) cb();
    return true;
  };
  stream.getColorDepth = () => 8; // Reports 256-color support

  return stream;
}
