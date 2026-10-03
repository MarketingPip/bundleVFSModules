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

function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const parenOpen = src.indexOf("(", start);
  const parenClose = extractBalanced(src, parenOpen, "(", ")");
  const braceOpen = src.indexOf("{", parenClose);
  const braceClose = extractBalanced(src, braceOpen, "{", "}");
  return src.slice(start, braceClose + 1);
}

// Extract vfsLookup (nested inside the _dynamic_import handler).
// We find it by its docstring marker.
const FN_SRC = extractFunction(RUNTIME_SRC, "function vfsLookup(path, vfs) {");

describe("vfsLookup browser-variant preference", () => {
  const makeLookup = () => {
    const factory = new Function(`${FN_SRC}\nreturn vfsLookup;`);
    return factory();
  };

  test("prefers -browser.js variant over .cjs", () => {
    const vfsLookup = makeLookup();
    const vfs = {
      node_modules: {
        "@rolldown": {
          browser: {
            dist: {
              "rolldown-binding.wasi.cjs": "CJS CONTENT",
              "rolldown-binding.wasi-browser.js": "BROWSER CONTENT",
            },
          },
        },
      },
    };
    const result = vfsLookup(
      "/node_modules/@rolldown/browser/dist/rolldown-binding.wasi.cjs",
      vfs,
    );
    expect(result).toBe("BROWSER CONTENT");
  });

  test("falls back to .cjs when no browser variant exists", () => {
    const vfsLookup = makeLookup();
    const vfs = {
      lib: {
        "foo.cjs": "CJS ONLY",
      },
    };
    const result = vfsLookup("/lib/foo.cjs", vfs);
    expect(result).toBe("CJS ONLY");
  });

  test("non-.cjs paths unaffected", () => {
    const vfsLookup = makeLookup();
    const vfs = {
      lib: {
        "bar.js": "JS CONTENT",
      },
    };
    const result = vfsLookup("/lib/bar.js", vfs);
    expect(result).toBe("JS CONTENT");
  });
});
