import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task 1 — Rollup WASM data-URL embedding moves from the harness seed
 * generator (make-seed.mjs) into the canonical runtime package-loading
 * path (runtime.js parent _dynamic_import handler).
 *
 * General platform mechanism (repo AGENTS.md rule 6), not a rollup
 * workaround: any vendored WASM build that references its binary via
 * `new URL("<rel>.wasm", import.meta.url)` breaks when the module is
 * executed from a `data:` URL (import.meta.url is the data: URL, so the
 * relative resolution throws). The runtime inlines the VFS-resolved bytes
 * as a data: URL when serving the module source.
 *
 * RED-first: `inlineWasmDataUrls` does not exist in runtime.js yet, so
 * extraction throws and every test below fails until it is implemented.
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

// Nested (unflattened) VFS, exactly as the parent handler sees it after
// pickDynamicImportVfs: binary files are {encoding:"base64",data} envelopes.
const WASM_B64 = Buffer.from("fake-wasm-bytes").toString("base64");
const VFS = {
  node_modules: {
    "@rollup": {
      browser: {
        dist: {
          es: {
            "rollup.browser.js":
              'const u = new URL("bindings_wasm_bg.wasm",import.meta.url);',
            "bindings_wasm_bg.wasm": { encoding: "base64", data: WASM_B64 },
          },
        },
      },
    },
    shared: { "x.wasm": { encoding: "base64", data: WASM_B64 } },
  },
};
const MOD = "/node_modules/@rollup/browser/dist/es/rollup.browser.js";

let inlineWasmDataUrls;
try {
  inlineWasmDataUrls = new Function(
    `${extractFunction(RUNTIME_SRC, "function inlineWasmDataUrls(")}\nreturn inlineWasmDataUrls;`,
  )();
} catch (e) {
  inlineWasmDataUrls = null;
}

describe("inlineWasmDataUrls (runtime package-loading path)", () => {
  test("helper exists in runtime.js", () => {
    // RED: throws "marker not found" until Task 1 is implemented.
    expect(inlineWasmDataUrls).toBeInstanceOf(Function);
  });

  test("rewrites new URL(<wasm>, import.meta.url) to a data: URL", () => {
    const src = 'const u = new URL("bindings_wasm_bg.wasm",import.meta.url);';
    const out = inlineWasmDataUrls(src, MOD, VFS);
    expect(out).toBe(
      `const u = new URL("data:application/wasm;base64,${WASM_B64}");`,
    );
  });

  test("handles single quotes and whitespace variants", () => {
    const src =
      "const u = new URL( 'bindings_wasm_bg.wasm' , import.meta.url );";
    const out = inlineWasmDataUrls(src, MOD, VFS);
    expect(out).toContain(`"data:application/wasm;base64,${WASM_B64}"`);
    expect(out).not.toContain("import.meta.url");
  });

  test("leaves non-wasm new URL(..., import.meta.url) alone", () => {
    const src = 'const u = new URL("data.json", import.meta.url);';
    expect(inlineWasmDataUrls(src, MOD, VFS)).toBe(src);
  });

  test("leaves source unchanged when the wasm file is missing (honest miss)", () => {
    const src = 'const u = new URL("nope.wasm", import.meta.url);';
    expect(inlineWasmDataUrls(src, MOD, VFS)).toBe(src);
  });

  test("resolves ../-relative wasm paths against the module dir", () => {
    const src =
      'const u = new URL("../../../../shared/x.wasm", import.meta.url);';
    const out = inlineWasmDataUrls(src, MOD, VFS);
    expect(out).toContain(`"data:application/wasm;base64,${WASM_B64}"`);
  });

  test("ignores new URL(wasm) without import.meta.url base", () => {
    const src = 'const u = new URL("https://cdn.example/x.wasm");';
    expect(inlineWasmDataUrls(src, MOD, VFS)).toBe(src);
  });

  test("rewrites the real @rollup/browser ESM build source end to end", () => {
    const realSrc = fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "node_modules",
        "@rollup",
        "browser",
        "dist",
        "es",
        "rollup.browser.js",
      ),
      "utf8",
    );
    expect(realSrc).toContain(
      'new URL("bindings_wasm_bg.wasm",import.meta.url)',
    );
    const out = inlineWasmDataUrls(realSrc, MOD, VFS);
    expect(out).not.toContain('new URL("bindings_wasm_bg.wasm"');
    expect(out).toContain("data:application/wasm;base64,");
  });
});
