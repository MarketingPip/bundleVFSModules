// Host-side pure helpers for the runtime entry API (Worker F extraction,
// branch modular/host). All functions/classes are exported.
//
// Sources (copied verbatim from runtime.js except for added `export`s):
//   FormattedError      lines 6089-6113  (was module-private `class`)
//   formatErrors        lines 6115-6158  (already exported)
//   formatErrors2       lines 6160-6203  (added `export`)
//   normalizeSeaAssets  lines 6215-6255  (added `export`; kept its doc comment
//                                        6207-6214; dropped the stray
//                                        "// 2. Then declare ..." note at 6205)
//   base64EncodeBytes   lines 6257-6264  (added `export`)
//   isSeedEnvelope      lines 6273-6283  (added `export`; kept doc comment)
//   seedBytesToBase64   lines 6288-6298  (added `export`; kept doc comment)
//   flattenFileTree     lines 6300-6323  (already exported)
//
// No cross-module dependencies: the only intra-file references are
// normalizeSeaAssets -> base64EncodeBytes,
// seedBytesToBase64   -> base64EncodeBytes (+ guarded global `Buffer`),
// flattenFileTree     -> isSeedEnvelope, seedBytesToBase64,
// formatErrors/formatErrors2 -> FormattedError.
// Globals used: `btoa` (base64EncodeBytes), `Blob` (flattenFileTree,
// `instanceof` — same as the original), `Buffer` (seedBytesToBase64,
// guarded by `typeof Buffer !== "undefined"`).

// ---------------------------------------------------------------------------
// Shared error-formatting helpers. Used by core sandbox code (acorn
// parse-error paths at module top level), so they must stay at module scope
// and never move inside the demo-playground init below. (Vitest gap #0
// reorganization: previously interleaved with the playground init.)

export class FormattedError extends Error {
  constructor(originalError, formattedMessage) {
    super(formattedMessage);

    // Preserve original error properties
    this.name = originalError.name || "Error";
    this.originalMessage = originalError.message;
    this.code = originalError.code;
    this.stack = originalError.stack;

    // Attach the formatted message as well
    this.formattedMessage = formattedMessage;

    // Copy any extra properties
    Object.keys(originalError).forEach((key) => {
      if (!(key in this)) {
        this[key] = originalError[key];
      }
    });
  }

  toString() {
    return this.formattedMessage || this.message;
  }
}

export function formatErrors(code, err) {
  const message = err?.message || "Unknown error";

  function _getContext(lines, lineNum, contextSize = 2) {
    const start = Math.max(0, lineNum - contextSize - 1);
    const end = Math.min(lines.length, lineNum + contextSize);

    return lines
      .slice(start, end)
      .map((line, idx) => {
        const actualLine = start + idx + 1;
        const marker = actualLine === lineNum ? "→" : " ";
        return `${marker} ${actualLine.toString().padStart(4)} | ${line}`;
      })
      .join("\n");
  }

  // Support multiple error formats
  const loc =
    err?.loc ||
    err?.location ||
    err?.loc?.start ||
    (err?.location?.start && err.location.start) ||
    null;

  let formattedMessage = message;

  if (loc && code) {
    const lines = code.split("\n");
    const lineText = lines[loc.line - 1] || "";
    const unexpectedChar = lineText[loc.column] || "EOF";
    const context = _getContext(lines, loc.line);

    formattedMessage = [
      `${err.name || "SyntaxError"}: ${message}`,
      `at line ${loc.line}, column ${loc.column}`,
      `${message}: '${unexpectedChar}'`,
      "",
      context,
    ].join("\n");
  }

  return new FormattedError(err, formattedMessage);
}

export function formatErrors2(code, err) {
  const message = err?.message || "Unknown error";

  function _getContext(lines, lineNum, contextSize = 2) {
    const start = Math.max(0, lineNum - contextSize - 1);
    const end = Math.min(lines.length, lineNum + contextSize);

    return lines
      .slice(start, end)
      .map((line, idx) => {
        const actualLine = start + idx + 1;
        const marker = actualLine === lineNum ? "→" : " ";
        return `${marker} ${actualLine.toString().padStart(4)} | ${line}`;
      })
      .join("\n");
  }

  // Support multiple error formats
  const loc =
    err?.loc ||
    err?.location ||
    err?.loc?.start ||
    (err?.location?.start && err.location.start) ||
    null;

  let formattedMessage = message;

  if (loc && code) {
    const lines = code.split("\n");
    const lineText = lines[loc.line - 1] || "";
    const unexpectedChar = lineText[loc.column] || "EOF";
    const context = _getContext(lines, loc.line);

    formattedMessage = [
      `${err.name || "SyntaxError"}: ${message}`,
      `at line ${loc.line}, column ${loc.column}`,
      `${message}: '${unexpectedChar}'`,
      "",
      context,
    ].join("\n");
  }

  return new FormattedError(err, formattedMessage);
}

// Normalize the 'seaAssets' sandbox option into a JSON-safe map for the
// bootstrap object: { [key]: { encoding: 'utf8'|'base64', data: string } }.
// Accepted value shapes (mirrors the leniency of 'fs' -> __USER_FILES__):
//   string                                   -> utf8 text
//   Uint8Array / ArrayBuffer / SharedArrayBuffer -> base64 bytes
//   { encoding: 'utf8'|'base64', data: string }  -> used as-is
// Anything else (including empty keys) is dropped: a misconfigured asset
// must never break sandbox bootstrap.
export function normalizeSeaAssets(assets) {
  const out = {};
  if (!assets || typeof assets !== "object") return out;
  const entries =
    typeof assets.entries === "function" && assets instanceof Map
      ? assets.entries()
      : Object.entries(assets);
  for (const [key, value] of entries) {
    if (typeof key !== "string" || key === "") continue;
    if (typeof value === "string") {
      out[key] = { encoding: "utf8", data: value };
    } else if (
      typeof ArrayBuffer !== "undefined" &&
      ArrayBuffer.isView(value)
    ) {
      out[key] = {
        encoding: "base64",
        data: base64EncodeBytes(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        ),
      };
    } else if (
      value instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== "undefined" &&
        value instanceof SharedArrayBuffer)
    ) {
      out[key] = {
        encoding: "base64",
        data: base64EncodeBytes(new Uint8Array(value)),
      };
    } else if (
      value &&
      typeof value === "object" &&
      typeof value.data === "string" &&
      (value.encoding === "utf8" || value.encoding === "base64")
    ) {
      out[key] = { encoding: value.encoding, data: value.data };
    }
  }
  return out;
}

export function base64EncodeBytes(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// A file-seed value of exactly { encoding: 'utf8'|'base64', data: string }
// is a binary/text envelope, NOT a directory (mirrors the normalizeSeaAssets
// convention, which documents these shapes as the fs -> __USER_FILES__
// leniency). flattenFileTree must keep it as a leaf so seedVolume in the
// sandbox can decode it; recursing would create bogus 'encoding'/'data'
// files. The two-key strictness keeps a user directory that merely happens
// to contain encoding/data files from being reinterpreted.
export function isSeedEnvelope(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Blob) &&
    (value.encoding === "utf8" || value.encoding === "base64") &&
    typeof value.data === "string" &&
    Object.keys(value).length === 2
  );
}

// Normalize raw bytes (Uint8Array/Buffer/ArrayBuffer) to a JSON-safe
// { encoding: 'base64', data } envelope. __USER_FILES__ is JSON-serialized
// into the sandbox bootstrap, where raw bytes would corrupt to {"0":..}.
export function seedBytesToBase64(value) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
    return Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).toString("base64");
  }
  return base64EncodeBytes(bytes);
}

export function flattenFileTree(obj, parentPath = "") {
  let flat = {};
  if (!obj || typeof obj !== "object") return flat;

  for (const [key, value] of Object.entries(obj)) {
    const fullPath = parentPath ? `${parentPath}/${key}` : key;

    if (value === null) {
      continue;
    } else if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      // Binary leaf: JSON-safe envelope (raw bytes cannot survive
      // JSON.stringify into the bootstrap).
      flat[fullPath] = { encoding: "base64", data: seedBytesToBase64(value) };
    } else if (isSeedEnvelope(value)) {
      // Already an envelope: keep as a leaf for seedVolume to decode.
      flat[fullPath] = value;
    } else if (typeof value === "object" && !(value instanceof Blob)) {
      Object.assign(flat, flattenFileTree(value, fullPath));
    } else {
      flat[fullPath] = value;
    }
  }
  return flat;
}
