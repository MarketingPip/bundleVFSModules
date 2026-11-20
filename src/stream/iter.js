// Port of Node v26.13.1 lib/stream/iter.js — converted to browser-safe ESM for the
// bundleVFSModules stream shim (Wave 3 lane L6). Function bodies are
// byte-identical to the Node source except for the import/binding
// rewrites noted in the converter (see /tmp/w3-l6/convert.py) and,
// for transform.js, the bare-native-zlib engine section, which is
// reimplemented on the shim's zlib (src/zlib.js).
'use strict';

// Public entry point for the iterable streams API.
// Usage: require('stream/iter') or require('node:stream/iter')
// Requires: --experimental-stream-iter

import { ObjectFreeze } from "./primordials.js";

import { emitExperimentalWarning } from "./iter/internal-util.js";
emitExperimentalWarning('stream/iter');

// Protocol symbols
import { toStreamable, toAsyncStreamable, broadcastProtocol, shareProtocol, shareSyncProtocol, drainableProtocol } from "./iter/types.js";

// Factories
import { push } from "./iter/push.js";
import { duplex } from "./iter/duplex.js";
import { from, fromSync } from "./iter/from.js";

// Pipelines
import { pull, pullSync, pipeTo, pipeToSync } from "./iter/pull.js";

// Consumers
import { bytes, bytesSync, text, textSync, arrayBuffer, arrayBufferSync, array, arraySync, dump, dumpSync, tap, tapSync, merge, ondrain } from "./iter/consumers.js";

// Classic stream interop (Node.js-specific, not part of the spec)
import { fromReadable, fromWritable, toReadable, toReadableSync, toWritable } from "./iter/classic.js";

// Multi-consumer
import { broadcast, Broadcast } from "./iter/broadcast.js";
import { share, shareSync, Share, SyncShare } from "./iter/share.js";

/**
 * Stream namespace - unified access to all stream functions.
 * @example
 * const { Stream } = require('stream/iter');
 *
 * const { writer, readable } = Stream.push();
 * await writer.write("hello");
 * await writer.end();
 *
 * const output = Stream.pull(readable, transform1, transform2);
 * const data = await Stream.bytes(output);
 */
const Stream = ObjectFreeze({
  // Factories
  push,
  duplex,
  from,
  fromSync,

  // Pipelines
  pull,
  pullSync,

  // Pipe to destination
  pipeTo,
  pipeToSync,

  // Consumers (async)
  bytes,
  text,
  arrayBuffer,
  array,
  dump,

  // Consumers (sync)
  bytesSync,
  textSync,
  arrayBufferSync,
  arraySync,
  dumpSync,

  // Combining
  merge,

  // Multi-consumer (push model)
  broadcast,

  // Multi-consumer (pull model)
  share,
  shareSync,

  // Utilities
  tap,
  tapSync,

  // Drain utility for event source integration
  ondrain,

  // Protocol symbols
  toStreamable,
  toAsyncStreamable,
  broadcastProtocol,
  shareProtocol,
  shareSyncProtocol,
  drainableProtocol,
});

export {
  // The Stream namespace
  Stream,

  // Also export everything individually for destructured imports

  // Protocol symbols
  toStreamable,
  toAsyncStreamable,
  broadcastProtocol,
  shareProtocol,
  shareSyncProtocol,
  drainableProtocol,

  // Factories
  push,
  duplex,
  from,
  fromSync,

  // Pipelines
  pull,
  pullSync,
  pipeTo,
  pipeToSync,

  // Consumers (async)
  bytes,
  text,
  arrayBuffer,
  array,
  dump,

  // Consumers (sync)
  bytesSync,
  textSync,
  arrayBufferSync,
  arraySync,
  dumpSync,

  // Combining
  merge,

  // Multi-consumer
  broadcast,
  Broadcast,
  share,
  shareSync,
  Share,
  SyncShare,

  // Utilities
  tap,
  tapSync,
  ondrain,

  // Classic stream interop
  fromReadable,
  fromWritable,
  toReadable,
  toReadableSync,
  toWritable,
};
