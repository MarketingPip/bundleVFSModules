import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);

/**
 * Extract the inlineWasmDataUrls function from runtime.js source.
 * It is defined inside a larger function; find it by signature.
 */
function extractInlineFn(src) {
  const start = src.indexOf(
    "function inlineWasmDataUrls(source, moduleVfsPath, vfs)",
  );
  if (start === -1) throw new Error("inlineWasmDataUrls not found");
  let depth = 0,
    i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const fnSrc = src.slice(start, i + 1);
  return new Function(
    "source",
    "moduleVfsPath",
    "vfs",
    fnSrc + "\nreturn inlineWasmDataUrls(source, moduleVfsPath, vfs);",
  );
}

/**
 * RED-first: `new URL('./x.wasm', import.meta.url).href` — the rewrite
 * replaces the `new URL(...)` with a bare string literal, so `.href`
 * evaluates to `undefined`. The result must preserve the URL object
 * shape (e.g. wrap in `new URL(...)`).
 */
describe("inlineWasmDataUrls .href preservation", () => {
  test("new URL(...).href still yields the data URL", () => {
    const inline = extractInlineFn(RUNTIME_SRC);
    const vfs = {
      node_modules: {
        pkg: { "a.wasm": { encoding: "base64", data: "QUJD" } },
      },
    };
    const src = `const u = new URL('./a.wasm', import.meta.url).href;`;
    const out = inline(src, "/node_modules/pkg/main.js", vfs);
    // Evaluate the rewritten expression: it must produce a data: URL string.
    const href = new Function(`${out}; return u;`)();
    expect(typeof href).toBe("string");
    expect(href.startsWith("data:application/wasm;base64,")).toBe(true);
  });

  test("new Worker(new URL(...)) still works", () => {
    const inline = extractInlineFn(RUNTIME_SRC);
    const vfs = {
      node_modules: { pkg: { "w.mjs": "console.log(1)" } },
    };
    const src = `new Worker(new URL('./w.mjs', import.meta.url), {type: 'module'})`;
    const out = inline(src, "/node_modules/pkg/main.js", vfs);
    // The inner expression must still be a valid URL.
    const inner = out
      .replace(/^new Worker\(/, "")
      .replace(/,\s*\{type:\s*'module'\}\)$/, "");
    const url = new Function(`return ${inner};`)();
    expect(String(url).startsWith("data:text/javascript;base64,")).toBe(true);
  });
});
