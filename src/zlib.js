// Import browser-compatible zlib
import * as browserZlib from "browserify-zlib";
import { gzip as pakoGzip } from "https://esm.sh/pako";

// Re-export everything from browserify-zlib
export * from "browserify-zlib";

/**
 * gzipSync implementation compatible with Node.js zlib
 */
export function gzipSync(input, options = {}) {
  let data;

  if (typeof input === "string") {
    data = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    data = input;
  } else if (input?.buffer) {
    data = new Uint8Array(input.buffer);
  } else {
    throw new TypeError("Invalid input type for gzipSync");
  }

  const compressed = pakoGzip(data, options);

  // Node returns a Buffer, but browsers don't have Buffer
  if (typeof Buffer !== "undefined") {
    return Buffer.from(compressed);
  }

  return compressed;
}

// expose gzipSync on default export to mimic node:zlib
browserZlib.gzipSync = gzipSync;

// Default export (Node-style)
export default browserZlib;
