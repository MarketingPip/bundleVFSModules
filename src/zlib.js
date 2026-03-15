import * as browserZlib from "https://esm.sh/browserify-zlib";
import {
  gzip as pakoGzip,
  ungzip as pakoUngzip,
  deflate as pakoDeflate,
  inflate as pakoInflate
} from "https://esm.sh/pako";

export * from "https://esm.sh/browserify-zlib";

function normalizeInput(input) {
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }

  if (input instanceof Uint8Array) {
    return input;
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) {
    return input;
  }

  if (input?.buffer) {
    return new Uint8Array(input.buffer);
  }

  throw new TypeError("Invalid input type");
}

function normalizeOutput(data) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data);
  }
  return data;
}

export function gzipSync(input, options = {}) {
  const data = normalizeInput(input);
  const compressed = pakoGzip(data, options);
  return normalizeOutput(compressed);
}

export function gunzipSync(input, options = {}) {
  const data = normalizeInput(input);
  const out = pakoUngzip(data, options);
  return normalizeOutput(out);
}

export function deflateSync(input, options = {}) {
  const data = normalizeInput(input);
  const compressed = pakoDeflate(data, options);
  return normalizeOutput(compressed);
}

export function inflateSync(input, options = {}) {
  const data = normalizeInput(input);
  const out = pakoInflate(data, options);
  return normalizeOutput(out);
}

const zlib = {
  ...browserZlib,
  gzipSync,
  gunzipSync,
  deflateSync,
  inflateSync
};

export default zlib;
