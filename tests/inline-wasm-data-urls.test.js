import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for the inlineWasmDataUrls early-exit in runtime.js.
 *
 * The guard `typeof source !== "string" || !source.includes("import.meta.url")`
 * was once accidentally duplicated as two nested identical ifs — same
 * condition twice, same as once, but a red flag for copy/paste drift.
 * This test keeps the guard exactly once, and checks the early-exit
 * behaviour in isolation (the function is pure: args + globals only,
 * no closure dependencies, so new-Function extraction is safe).
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

const GUARD =
  'typeof source !== "string" || !source.includes("import.meta.url")';

const fnSrc = extractFunction(RUNTIME_SRC, "function inlineWasmDataUrls(");
// Verified: body references only its params and globals (String, RegExp,
// Buffer is passed via vfs arg) — no closure deps, safe to eval standalone.
const inlineWasmDataUrls = new Function(
  `${fnSrc}\nreturn inlineWasmDataUrls;`,
)();

const VFS = {
  node_modules: { pkg: { "x.wasm": { encoding: "base64", data: "eA==" } } },
};

describe("inlineWasmDataUrls guard dedupe regression", () => {
  test("early-exit guard appears exactly once in the function body", () => {
    const hits = fnSrc.split(GUARD).length - 1;
    expect(hits).toBe(1);
  });

  test("returns source unchanged when it lacks import.meta.url", () => {
    const src = 'const x = new URL("x.wasm");';
    expect(inlineWasmDataUrls(src, "/node_modules/pkg/mod.js", VFS)).toBe(src);
  });

  test("returns non-string input unchanged (identity)", () => {
    for (const bad of [null, undefined, 42, { toString: () => "x" }]) {
      expect(inlineWasmDataUrls(bad, "/node_modules/pkg/mod.js", VFS)).toBe(
        bad,
      );
    }
  });

  test("still inlines when import.meta.url is present (no behavioural regression)", () => {
    const src = 'const u = new URL("x.wasm", import.meta.url);';
    const out = inlineWasmDataUrls(src, "/node_modules/pkg/mod.js", VFS);
    expect(out).toBe('const u = new URL("data:application/wasm;base64,eA==");');
  });
});
