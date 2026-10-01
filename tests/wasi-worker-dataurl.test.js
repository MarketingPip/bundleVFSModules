import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Worker .mjs data-URL inlining for WASI browser builds.
 *
 * The Rolldown WASI browser binding spawns its WASI worker via:
 *   new Worker(new URL('./wasi-worker-browser.mjs', import.meta.url), {type: 'module'})
 *
 * When the binding module is served from a data: URL (import.meta.url IS the
 * data: URL), the relative resolution throws TypeError. The runtime must
 * inline the VFS-resolved worker bytes as a data: URL, mirroring the
 * existing inlineWasmDataUrls mechanism for .wasm files.
 *
 * RED-first: the function does not handle .mjs yet, so the rewrite tests fail.
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

const WORKER_B64 = Buffer.from("fake-worker-js-bytes").toString("base64");
const WORKER_SRC = "fake-worker-js-bytes";
const VFS = {
  node_modules: {
    "@rolldown": {
      browser: {
        dist: {
          "rolldown-binding.wasi-browser.js":
            "const w = new Worker(new URL('./wasi-worker-browser.mjs', import.meta.url), {type:'module'});",
          // Plain string (not base64-enveloped): matches the real seed shape
          // from scripts/build-rolldown-seed.mjs, which only envelopes .wasm.
          "wasi-worker-browser.mjs": WORKER_SRC,
        },
      },
    },
  },
};
const MOD =
  "/node_modules/@rolldown/browser/dist/rolldown-binding.wasi-browser.js";

let inlineWasmDataUrls;
try {
  inlineWasmDataUrls = new Function(
    `${extractFunction(RUNTIME_SRC, "function inlineWasmDataUrls(")}\nreturn inlineWasmDataUrls;`,
  )();
} catch (e) {
  inlineWasmDataUrls = null;
}

describe("inlineWasmDataUrls: worker .mjs inlining", () => {
  test("helper exists in runtime.js", () => {
    expect(inlineWasmDataUrls).toBeInstanceOf(Function);
  });

  test("rewrites new URL(<worker.mjs>, import.meta.url) to a data: URL", () => {
    const src =
      "const w = new Worker(new URL('./wasi-worker-browser.mjs', import.meta.url), {type:'module'});";
    const out = inlineWasmDataUrls(src, MOD, VFS);
    expect(out).toBe(
      `const w = new Worker("data:text/javascript;base64,${WORKER_B64}", {type:'module'});`,
    );
  });

  test("handles the exact rolldown-binding.wasi-browser.js pattern", () => {
    const src = `    onCreateWorker() {
      const worker = new Worker(new URL('./wasi-worker-browser.mjs', import.meta.url), {
        type: 'module',
      })`;
    const out = inlineWasmDataUrls(src, MOD, VFS);
    expect(out).not.toContain("new URL('./wasi-worker-browser.mjs'");
    expect(out).toContain(`"data:text/javascript;base64,${WORKER_B64}"`);
  });

  test("handles plain string content (non-enveloped .mjs in seed)", () => {
    const vfs = {
      dist: {
        "x.js": "const w = new URL('./worker.mjs', import.meta.url);",
        "worker.mjs": "console.log('worker');",
      },
    };
    const out = inlineWasmDataUrls(vfs.dist["x.js"], "/dist/x.js", vfs);
    const expectedB64 = Buffer.from("console.log('worker');").toString(
      "base64",
    );
    expect(out).toBe(`const w = "data:text/javascript;base64,${expectedB64}";`);
  });

  test("leaves worker reference alone when the .mjs file is missing (honest miss)", () => {
    const src = "const w = new URL('./missing-worker.mjs', import.meta.url);";
    expect(inlineWasmDataUrls(src, MOD, VFS)).toBe(src);
  });

  test("still rewrites .wasm references (no regression)", () => {
    const wasmB64 = Buffer.from("fake-wasm").toString("base64");
    const vfs = {
      dist: {
        "x.js": 'const u = new URL("y.wasm", import.meta.url);',
        "y.wasm": { encoding: "base64", data: wasmB64 },
      },
    };
    const out = inlineWasmDataUrls(vfs.dist["x.js"], "/dist/x.js", vfs);
    expect(out).toBe(`const u = "data:application/wasm;base64,${wasmB64}";`);
  });
});
