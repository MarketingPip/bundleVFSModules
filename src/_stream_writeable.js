// node:_stream_writable — Node internal module (module.exports = Writable).
// Thin re-export of the stream port's Writable class, which carries the same
// statics as Node's internal (WritableState, fromWeb, toWeb).
// Dependency-free ESM, browser-safe. No _RUNTIME_ access needed.
//
// NOTE: the file keeps Node's historical "writeable" spelling; the bundle key
// is `_stream_writable` (see BUNDLED_MODULES in src/build-vfs.mjs), matching
// the runtime's builtin-module key normalization.
import { Writable } from './stream.js';
export default Writable;
export const { WritableState, fromWeb, toWeb } = Writable;
