import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * M3b prerequisite — JSON-safe binary file seeds.
 *
 * __USER_FILES__ is JSON-serialized into the sandbox bootstrap, so raw
 * Uint8Array seeds corrupt (JSON.stringify turns them into {"0":..}).
 * The platform convention (already documented for seaAssets in runtime.js,
 * "mirrors the leniency of fs -> __USER_FILES__") is the
 * { encoding: 'utf8'|'base64', data: string } envelope — but flattenFileTree
 * currently recurses into such objects (creating `encoding`/`data` files)
 * and seedVolume writes them as "[object Object]".
 *
 * RED first: flattenFileTree mangles envelopes; seedVolume has no decode.
 * Green: flattenFileTree preserves {encoding,data} leaves and encodes raw
 * bytes; src/fs.js seedVolume decodes envelopes back to bytes/strings.
 * The M3 harness seeds esbuild.wasm this way (real bytes for
 * WebAssembly.compile in the esbuild-wasm shim).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);
const FS_SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "fs.js"),
  "utf8",
);

function extractBalanced(src, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced " + openCh + closeCh + " at " + openIdx);
}

function extractFunctionAt(src, start) {
  if (start === -1) throw new Error("marker index -1");
  const parenOpen = src.indexOf("(", start);
  const parenClose = extractBalanced(src, parenOpen, "(", ")");
  const braceOpen = src.indexOf("{", parenClose);
  const braceClose = extractBalanced(src, braceOpen, "{", "}");
  return src.slice(start, braceClose + 1).replace(/^export\s+/, "");
}

function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("marker not found: " + marker);
  return extractFunctionAt(src, start);
}

function loadFlatten() {
  const fns = [
    extractFunction(RUNTIME_SRC, "function isSeedEnvelope("),
    extractFunction(RUNTIME_SRC, "function seedBytesToBase64("),
    extractFunction(RUNTIME_SRC, "function flattenFileTree("),
  ].join("\n");
  return new Function(`${fns}\nreturn flattenFileTree;`)();
}

function loadSeedVolume() {
  const fns = [
    extractFunction(FS_SRC, "function isUint8ArrayLike("),
    extractFunction(FS_SRC, "function toPathString("),
    extractFunction(FS_SRC, "function posixDirname("),
    extractFunction(FS_SRC, "function decodeSeedValue("),
    extractFunction(FS_SRC, "function seedVolume("),
  ].join("\n");
  return new Function(`${fns}\nreturn seedVolume;`)();
}

function fakeVol() {
  const written = {};
  return {
    written,
    mkdirSync() {},
    writeFileSync(p, data) {
      written[p] = data;
    },
  };
}

describe("flattenFileTree preserves binary seed envelopes", () => {
  test("{encoding:'base64', data} stays a leaf (not encoding/data files)", () => {
    const flattenFileTree = loadFlatten();
    const flat = flattenFileTree({
      "/node_modules/esbuild-wasm/esbuild.wasm": {
        encoding: "base64",
        data: "aGk=",
      },
    });
    expect(Object.keys(flat)).toEqual([
      "/node_modules/esbuild-wasm/esbuild.wasm",
    ]);
    expect(flat["/node_modules/esbuild-wasm/esbuild.wasm"]).toEqual({
      encoding: "base64",
      data: "aGk=",
    });
  });

  test("raw Uint8Array seeds become base64 envelopes (JSON-safe)", () => {
    const flattenFileTree = loadFlatten();
    const flat = flattenFileTree({ "/bin/a.wasm": new Uint8Array([104, 105]) });
    expect(flat["/bin/a.wasm"]).toEqual({
      encoding: "base64",
      data: "aGk=",
    });
    // JSON round-trip (what the bootstrap does) preserves it.
    expect(JSON.parse(JSON.stringify(flat))).toEqual(flat);
  });

  test("plain strings and nested dirs still flatten as before", () => {
    const flattenFileTree = loadFlatten();
    const flat = flattenFileTree({
      "/a.txt": "hi",
      lib: { "b.js": "code" },
    });
    expect(flat).toEqual({ "/a.txt": "hi", "lib/b.js": "code" });
  });
});

describe("seedVolume decodes envelopes to real bytes", () => {
  test("base64 envelope -> Uint8Array bytes", () => {
    const seedVolume = loadSeedVolume();
    const vol = fakeVol();
    seedVolume(vol, { "/w.wasm": { encoding: "base64", data: "aGk=" } });
    const got = vol.written["/w.wasm"];
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Array.from(got)).toEqual([104, 105]);
  });

  test("utf8 envelope -> string", () => {
    const seedVolume = loadSeedVolume();
    const vol = fakeVol();
    seedVolume(vol, { "/a.txt": { encoding: "utf8", data: "hi" } });
    expect(vol.written["/a.txt"]).toBe("hi");
  });

  test("plain strings pass through untouched", () => {
    const seedVolume = loadSeedVolume();
    const vol = fakeVol();
    seedVolume(vol, { "/a.txt": "hi" });
    expect(vol.written["/a.txt"]).toBe("hi");
  });

  test("lookalike objects (extra keys) are NOT decoded", () => {
    const seedVolume = loadSeedVolume();
    const vol = fakeVol();
    const tricky = { encoding: "base64", data: "aGk=", extra: 1 };
    seedVolume(vol, { "/t": tricky });
    // Not a strict envelope: written as-is (honest, no silent reinterpret).
    expect(vol.written["/t"]).toBe(tricky);
  });
});
