import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";
import MagicString from "magic-string";
import * as walk from "acorn-walk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);

/**
 * Extract a top-level function from runtime.js source using acorn,
 * so braces inside strings/template literals don't break matching.
 */
function extractFn(src, name) {
  const ast = acorn.parse(src, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  for (const node of ast.body) {
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "ExportNamedDeclaration") &&
      ((node.declaration &&
        node.declaration.type === "FunctionDeclaration" &&
        node.declaration.id.name === name) ||
        (node.id && node.id.name === name))
    ) {
      const fnNode =
        node.type === "ExportNamedDeclaration" ? node.declaration : node;
      return src.slice(fnNode.start, fnNode.end);
    }
  }
  throw new Error(`${name} not found`);
}

function buildTransform() {
  const genBindSrc = extractFn(RUNTIME_SRC, "generateImportBinding");
  const transformSrc = extractFn(
    RUNTIME_SRC,
    "transformImportsToLoadModule",
  ).replace(/^export\s+/, "");
  const factory = new Function(
    "acorn",
    "MagicString",
    "walk",
    `${genBindSrc}\n${transformSrc}\nreturn transformImportsToLoadModule;`,
  );
  return factory(acorn, MagicString, walk);
}

/**
 * RED-first perf regression test (2026-10-02): _build_file on the 16MB
 * WASM-inlined binding took 17–25s in the browser, blocking the parent
 * page's main thread and killing the Firefox/WebDriver session mid-proof.
 *
 * Root cause: generateMap({ hires: true }) produced a 74MB VLQ mappings
 * string for the 14.7MB inlined base64 literal. The transform must stay
 * well under the 60s interop timeout — budget 5s for a 16MB input.
 */
describe("transformImportsToLoadModule large-file performance", () => {
  test("16MB string-laden file transforms in under 5s", () => {
    const transform = buildTransform();
    // Mimic the WASM-inlined binding: real import/export structure plus
    // one giant base64 string literal (the inlined .wasm data URL).
    const bigLiteral = "data:application/wasm;base64," + "QUJD".repeat(3650000); // ~14.6MB
    const code = [
      `import { x } from "./dep.js";`,
      `const { y } = require("./other.cjs");`,
      `const __wasmDataUrl = ${JSON.stringify(bigLiteral)};`,
      `export const getWasm = () => __wasmDataUrl;`,
      `export default { x, y };`,
    ].join("\n");
    expect(code.length).toBeGreaterThan(14_000_000);

    const t0 = Date.now();
    const result = transform("test-uuid", code, "big.cjs", "entry.js", {});
    const elapsed = Date.now() - t0;

    expect(result.code).toContain("__wasmDataUrl");
    expect(result.code).not.toContain('from "./dep.js"');
    // The composed source map must stay small: no 74MB hires VLQ blowup.
    expect(result.map.mappings.length).toBeLessThan(1_000_000);
    expect(elapsed).toBeLessThan(5000);
  }, 30000);
});
