// node:_stream_passthrough — Node internal module (module.exports = PassThrough).
// Thin re-export of the stream port's PassThrough class.
// Dependency-free ESM, browser-safe. No _RUNTIME_ access needed.
import { PassThrough } from './stream.js';
export default PassThrough;
export { PassThrough };
