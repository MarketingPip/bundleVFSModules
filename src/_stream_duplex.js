// node:_stream_duplex — Node internal module (module.exports = Duplex).
// Thin re-export of the stream port's Duplex class, which carries the same
// statics as Node's internal (from, fromWeb, toWeb).
// Dependency-free ESM, browser-safe. No _RUNTIME_ access needed.
import { Duplex } from './stream.js';
export default Duplex;
export const { from, fromWeb, toWeb } = Duplex;
