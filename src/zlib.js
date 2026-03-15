import * as browserZlib from "https://esm.sh/browserify-zlib";
import {
  gzip as pakoGzip,
  ungzip as pakoUngzip,
  deflate as pakoDeflate,
  inflate as pakoInflate,
  deflateRaw as pakoDeflateRaw,
  inflateRaw as pakoInflateRaw
} from "https://esm.sh/pako";

export * from "https://esm.sh/browserify-zlib";

// Input normalization
function normalizeInput(input) {
  if (typeof input === "string") return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) return input;
  if (input?.buffer) return new Uint8Array(input.buffer);
  throw new TypeError("Invalid input type");
}

// Output normalization
function normalizeOutput(data) {
  if (typeof Buffer !== "undefined") return Buffer.from(data);
  return data;
}

// Sync methods
export const gzipSync = (input, options) =>
  normalizeOutput(pakoGzip(normalizeInput(input), options));

export const gunzipSync = (input, options) =>
  normalizeOutput(pakoUngzip(normalizeInput(input), options));

export const deflateSync = (input, options) =>
  normalizeOutput(pakoDeflate(normalizeInput(input), options));

export const inflateSync = (input, options) =>
  normalizeOutput(pakoInflate(normalizeInput(input), options));

export const deflateRawSync = (input, options) =>
  normalizeOutput(pakoDeflateRaw(normalizeInput(input), options));

export const inflateRawSync = (input, options) =>
  normalizeOutput(pakoInflateRaw(normalizeInput(input), options));

// Default export
const zlib = {
  ...browserZlib,
  gzipSync,
  gunzipSync,
  deflateSync,
  inflateSync,
  deflateRawSync,
  inflateRawSync
};

export default zlib;
