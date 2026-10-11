//import {Buffer} from "https://esm.sh/buffer"

// Dual-lane import (pattern from src/plugins/typescript.js):
// - Under Node (tests, direct import): the npm `memfs` package declared in
//   package.json.
// - In the browser host page: https://esm.sh/memfs — the exact specifier
//   runtime.js used.
function isNodeLane() {
  return (
    typeof process !== "undefined" &&
    process.versions &&
    typeof process.versions.node === "string"
  );
}

const memfsModule = await (isNodeLane()
  ? import("memfs")
  : import("https://esm.sh/memfs"));
const fs = memfsModule.default ?? memfsModule;

// The host-side default volume (also exported for other runtime modules).
export { fs as memfsFs };

// Initialize virtual filesystem structure
fs.vol.fromJSON({
  "/hello.txt": "Hello world",
  "/dir/nested.txt": "Nested file",
});

export const TEXT_EXTS = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "json",
  "jsonc",
  "json5",
  "md",
  "mdx",
  "txt",
  "csv",
  "yaml",
  "yml",
  "xml",
  "svg",
  "graphql",
  "gql",
  "sh",
  "bash",
  "env",
  "toml",
  "ini",
  "conf",
]);

export const BINARY_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
  "bmp",
  "wasm",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "mp3",
  "mp4",
  "wav",
  "ogg",
  "webm",
  "pdf",
  "zip",
  "gz",
  "tar",
]);

export function getExt(path) {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

// ─── Serialize ────────────────────────────────────────────────────────────────
// Converts a memfs volume into a plain JSON-safe object.
// All files are stored as base64 strings — safe for JSON / eval embedding.

export function serializeVfs(fs) {
  const out = {};
  const files = fs.vol?.toJSON?.() ?? {};

  for (const path in files) {
    try {
      const data = fs.fs.readFileSync(path); // raw Buffer / Uint8Array
      out[path] = Buffer.from(data).toString("base64");
    } catch (e) {
      console.warn(`[vfs] failed to read ${path}:`, e);
    }
  }

  return out; // { '/index.js': 'abc123...', '/image.png': 'iVBORw0...' }
}

// ─── Deserialize ──────────────────────────────────────────────────────────────
// Converts the serialized object back into typed values:
//   JSON  → parsed object
//   text  → utf-8 string
//   binary → Uint8Array

export function deserializeVfs(serializedFs) {
  const out = {};

  for (const [path, b64] of Object.entries(serializedFs)) {
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const ext = getExt(path);

      if (ext === "json" || ext === "jsonc" || ext === "json5") {
        out[path] = JSON.parse(new TextDecoder().decode(bytes));
      } else if (TEXT_EXTS.has(ext)) {
        out[path] = new TextDecoder().decode(bytes);
      } else if (BINARY_EXTS.has(ext)) {
        out[path] = bytes;
      } else {
        // Unknown extension — try UTF-8, fall back to bytes if it fails
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes,
          );
          out[path] = decoded;
        } catch {
          out[path] = bytes;
        }
      }
    } catch (e) {
      console.warn(`[vfs] failed to deserialize ${path}:`, e);
    }
  }

  return out;
}

// ─── Reconstruct back into memfs ──────────────────────────────────────────────
// Takes the deserialized VFS and writes everything back into a memfs instance.

export function rehydrateVfs(deserializedFs, fs) {
  for (const [path, content] of Object.entries(deserializedFs)) {
    try {
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir) fs.mkdirSync(dir, { recursive: true });

      if (typeof content === "string") {
        fs.writeFileSync(path, content, "utf8");
      } else if (content instanceof Uint8Array) {
        fs.writeFileSync(path, content);
      } else {
        // JSON object — write as formatted string
        fs.writeFileSync(path, JSON.stringify(content, null, 2), "utf8");
      }
    } catch (e) {
      console.warn(`[vfs] failed to rehydrate ${path}:`, e);
    }
  }
}

