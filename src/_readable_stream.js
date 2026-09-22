// node:_stream_readable — Node internal module (module.exports = Readable).
// Thin re-export of the stream port's Readable class, which carries the same
// statics as Node's internal (ReadableState, _fromList, from, fromWeb, toWeb, wrap).
// Dependency-free ESM, browser-safe. No _RUNTIME_ access needed.
//
// NOTE: the file is named _readable_stream.js for history; the bundle key is
// `_stream_readable` (see BUNDLED_MODULES in src/build-vfs.mjs), matching the
// runtime's builtin-module key normalization.
import { Readable } from './stream.js';
export default Readable;
export { Readable };
