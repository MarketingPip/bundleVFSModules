// Buffer for the stream port: the host Buffer when available (Node.js),
// otherwise the repo's browser-safe Buffer port (src/buffer.js).
//
// Using the host Buffer under Node makes the port's Buffers identical
// (instanceof / deepStrictEqual) to the ones real node:stream produces,
// while browsers transparently get the dependency-free port.
import { Buffer as RepoBuffer } from '../buffer.js';

export const Buffer =
  typeof globalThis.Buffer === 'function' ? globalThis.Buffer : RepoBuffer;
