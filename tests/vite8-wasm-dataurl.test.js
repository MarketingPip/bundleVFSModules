import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * WASM epic — prove `inlineWasmDataUrls` (runtime.js:9073) handles the
 * ACTUAL @rolldown/browser binding file, not just synthetic sources.
 *
 * The binding (`rolldown-binding.wasi-browser.js:71`) loads its 11MB WASM via:
 *   const __wasmUrl = new URL('./rolldown-binding.wasm32-wasi.wasm', import.meta.url).href
 * When served through the parent _dynamic_import handler, this must be
 * rewritten to `data:application/wasm;base64,...` using VFS bytes, because
 * the module executes from a data: URL where relative resolution throws.
 *
 * RED-first: if extraction fails or the rewrite misses the real file's
 * exact syntax, these tests fail and drive the fix.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
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

function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1)
    throw new Error("marker not found in runtime.js: " + marker);
  const parenOpen = src.indexOf("(", start);
  const parenClose = extractBalanced(src, parenOpen, "(", ")");
  const braceOpen = src.indexOf("{", parenClose);
  const braceClose = extractBalanced(src, braceOpen, "{", "}");
  return src.slice(start, braceClose + 1);
}

// Real binding file, read from the installed @rolldown/browser package.
const BINDING_PATH = path.join(
  __dirname,
  "..",
  "node_modules",
  "@rolldown",
  "browser",
  "dist",
  "rolldown-binding.wasi-browser.js",
);
const BINDING_VFS_PATH =
  "/node_modules/@rolldown/browser/dist/rolldown-binding.wasi-browser.js";

// Fake WASM bytes (the real 11MB file is seeded separately; the rewrite
// logic only needs the {encoding,data} envelope shape).
const WASM_B64 = Buffer.from("fake-rolldown-wasm-bytes").toString("base64");

function makeVfs(withWasm = true) {
  const dist = {};
  if (withWasm) {
    dist["rolldown-binding.wasm32-wasi.wasm"] = {
      encoding: "base64",
      data: WASM_B64,
    };
  }
  return {
    node_modules: {
      "@rolldown": { browser: { dist } },
    },
  };
}

let inlineWasmDataUrls;
try {
  inlineWasmDataUrls = new Function(
    `${extractFunction(RUNTIME_SRC, "function inlineWasmDataUrls(")}\nreturn inlineWasmDataUrls;`,
  )();
} catch (e) {
  inlineWasmDataUrls = null;
}

describe("inlineWasmDataUrls — real @rolldown/browser binding", () => {
  test("helper exists in runtime.js", () => {
    expect(inlineWasmDataUrls).toBeInstanceOf(Function);
  });

  test("real binding file contains the exact new URL(..., import.meta.url) pattern", () => {
    const src = fs.readFileSync(BINDING_PATH, "utf8");
    expect(src).toContain(
      "new URL('./rolldown-binding.wasm32-wasi.wasm', import.meta.url)",
    );
  });

  test("rewrites the real binding file's WASM URL to a data: URL", () => {
    const src = fs.readFileSync(BINDING_PATH, "utf8");
    const out = inlineWasmDataUrls(src, BINDING_VFS_PATH, makeVfs(true));
    // The exact line 71 pattern must be gone, replaced by the data: URL.
    expect(out).not.toContain(
      "new URL('./rolldown-binding.wasm32-wasi.wasm', import.meta.url)",
    );
    expect(out).toContain(`"data:application/wasm;base64,${WASM_B64}"`);
  });

  test("leaves the binding file unchanged when WASM is not seeded (honest miss)", () => {
    const src = fs.readFileSync(BINDING_PATH, "utf8");
    const out = inlineWasmDataUrls(src, BINDING_VFS_PATH, makeVfs(false));
    expect(out).toBe(src);
  });

  test("rewritten data: URL is fetchable-shape (mime type application/wasm)", () => {
    const src =
      "const __wasmUrl = new URL('./rolldown-binding.wasm32-wasi.wasm', import.meta.url).href;";
    const out = inlineWasmDataUrls(src, BINDING_VFS_PATH, makeVfs(true));
    // fetch(data:application/wasm;base64,...) must yield a Response whose
    // arrayBuffer() is the WASM bytes — the binding's exact consumption path.
    // ae81372a: new URL() wrapper kept so the trailing .href resolves.
    expect(out).toMatch(
      /^const __wasmUrl = new URL\("data:application\/wasm;base64,/,
    );
    expect(out.endsWith(".href;")).toBe(true);
    const b64 = out.match(/base64,([A-Za-z0-9+/=]+)"/)[1];
    expect(Buffer.from(b64, "base64").toString()).toBe(
      "fake-rolldown-wasm-bytes",
    );
  });
});
