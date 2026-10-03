import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * normalizeBuiltinSpecifier must recognize the underscore-normalized
 * bundle-key form of builtins.
 *
 * The vite proof failed with `[ERR_MODULE_NOT_FOUND]: Cannot find module
 * fs_promises` even though the parent handler and fetch path were proven
 * working. Interop tracing showed the sandbox calling
 * `_dynamic_import` with `path='fs_promises', isNodeBuiltIn=false` — the
 * sandbox-side normalizer only matched the slash form (`fs/promises`) in
 * the builtin list, so the underscore form fell through to VFS resolution
 * and died. Some bundlers/transforms emit the underscore form; both
 * spellings must resolve as builtins (platform fix, AGENTS.md rule 6).
 *
 * Pattern: extract normalizeBuiltinSpecifier verbatim from
 * src/sandbox/20-module-loader.js (it cannot be imported under Node).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const LOADER_SRC = fs.readFileSync(
  path.join(REPO, "src", "sandbox", "20-module-loader.js"),
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
  throw new Error("unbalanced " + openCh + closeCh);
}

function extractNormalizer(src) {
  const start = src.indexOf("function normalizeBuiltinSpecifier(");
  expect(start).toBeGreaterThan(-1);
  const parenOpen = src.indexOf("(", start);
  const parenClose = extractBalanced(src, parenOpen, "(", ")");
  const braceOpen = src.indexOf("{", parenClose);
  const braceClose = extractBalanced(src, braceOpen, "{", "}");
  const fnSrc = src.slice(start, braceClose + 1);
  return new Function(fnSrc + "\nreturn normalizeBuiltinSpecifier;")();
}

const normalizeBuiltinSpecifier = extractNormalizer(LOADER_SRC);
// Minimal builtin list in the real shape (slash form, as shipped).
const BUILTINS = ["fs", "fs/promises", "path", "node:test", "timers/promises"];

describe("normalizeBuiltinSpecifier underscore form", () => {
  test("fs_promises (underscore) is recognized as builtin", () => {
    const r = normalizeBuiltinSpecifier("fs_promises", BUILTINS);
    expect(r.isNodeBuiltIn).toBe(true);
    expect(r.modulePath).toBe("fs_promises");
  });

  test("node:fs/promises still works", () => {
    const r = normalizeBuiltinSpecifier("node:fs/promises", BUILTINS);
    expect(r.isNodeBuiltIn).toBe(true);
    expect(r.modulePath).toBe("fs_promises");
  });

  test("fs/promises (slash) still works", () => {
    const r = normalizeBuiltinSpecifier("fs/promises", BUILTINS);
    expect(r.isNodeBuiltIn).toBe(true);
    expect(r.modulePath).toBe("fs_promises");
  });

  test("plain fs still works", () => {
    const r = normalizeBuiltinSpecifier("fs", BUILTINS);
    expect(r.isNodeBuiltIn).toBe(true);
    expect(r.modulePath).toBe("fs");
  });

  test("non-builtin relative path is not a builtin", () => {
    const r = normalizeBuiltinSpecifier("./fs_promises", BUILTINS);
    expect(r.isNodeBuiltIn).toBe(false);
  });

  test("non-builtin bare specifier is not a builtin", () => {
    const r = normalizeBuiltinSpecifier("my_module", BUILTINS);
    expect(r.isNodeBuiltIn).toBe(false);
  });
});
