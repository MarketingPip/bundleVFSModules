import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  throw new Error("unbalanced");
}

function extractClass(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const braceOpen = src.indexOf("{", start);
  const braceClose = extractBalanced(src, braceOpen, "{", "}");
  return src.slice(start, braceClose + 1);
}

// Extract ImportResolver class source for isolated testing.
let CLASS_SRC = extractClass(RUNTIME_SRC, "export class ImportResolver {");
// Strip the export keyword for Function() evaluation.
CLASS_SRC = CLASS_SRC.replace(/^export\s+/, "");

describe("ImportResolver VFS-first (no CDN fallback for seeded packages)", () => {
  test("leaves bare 'vite' untouched when fallbackCDN is false", async () => {
    // Build a minimal ImportResolver with fallbackCDN:false.
    // We eval the class with stubbed dependencies.
    const stubDeps = `
      const customAcorn = { parse: () => ({ body: [] }) };
      const builtinModules = [];
      function normalizeBuiltinSpecifier(s) { return { isNodeBuiltIn: false, modulePath: s }; }
      function lookupNativeInterception() { return null; }
    `;
    const factory = new Function(
      `${stubDeps}\n${CLASS_SRC}\nreturn new ImportResolver({ fallbackCDN: false });`,
    );
    const resolver = factory();
    const out = resolver._transformSource("vite", "import");
    // With fallbackCDN:false, bare specifiers must pass through untouched
    // so loadModule() can resolve them via the VFS seed.
    expect(out).toBe("vite");
  });

  test("still applies CDN fallback when fallbackCDN is true (default)", async () => {
    const stubDeps = `
      const customAcorn = { parse: () => ({ body: [] }) };
      const builtinModules = [];
      function normalizeBuiltinSpecifier(s) { return { isNodeBuiltIn: false, modulePath: s }; }
      function lookupNativeInterception() { return null; }
    `;
    const factory = new Function(
      `${stubDeps}\n${CLASS_SRC}\nreturn new ImportResolver({ fallbackCDN: true, cdnBase: "https://esm.sh" });`,
    );
    const resolver = factory();
    const out = resolver._transformSource("some-unseeded-pkg", "import");
    expect(out).toBe("https://esm.sh/some-unseeded-pkg");
  });
});
