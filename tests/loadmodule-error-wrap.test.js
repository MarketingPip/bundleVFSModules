import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * loadModule's catch block augments caught errors with module context:
 *   error.message = `${error.message} in ${displayPath} at ${entryPoint}`
 *
 * RED-first: if the caught error has a getter-only `message` property
 * (DOMException, exotic WASM binding errors, frozen error-likes), the
 * assignment throws `setting getter-only property "message"`, masking the
 * real failure. Seen in headed Firefox as:
 *   success=false error="setting getter-only property \"message\"
 *   in ./normalize-string-or-regex-JvbFp3Ww.js at .../index.browser.mjs"
 *
 * The augmentation must never throw: fall back to wrapping.
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

// The helper to be extracted from loadModule's catch block.
const HELPER_SRC = extractFunction(RUNTIME_SRC, "function augmentLoadError(");

function makeGetterOnlyError(msg) {
  const e = {};
  Object.defineProperty(e, "message", {
    get: () => msg,
    enumerable: true,
    configurable: true,
  });
  return e;
}

describe("augmentLoadError: never masks the original failure", () => {
  test("helper exists in runtime.js", () => {
    expect(HELPER_SRC).not.toBeNull();
    expect(typeof HELPER_SRC).toBe("string");
  });

  test("writable message gets augmented in place", () => {
    if (!HELPER_SRC) return;
    const augmentLoadError = new Function(
      `"use strict";\n${HELPER_SRC}\nreturn augmentLoadError;`,
    )();
    const err = new Error("boom");
    const out = augmentLoadError(err, "./mod.js", "/parent.js");
    expect(out).toBe(err);
    expect(err.message).toContain("boom in ./mod.js at /parent.js");
  });

  test("getter-only message does NOT throw; original preserved", () => {
    if (!HELPER_SRC) return;
    const augmentLoadError = new Function(
      `"use strict";\n${HELPER_SRC}\nreturn augmentLoadError;`,
    )();
    const exotic = makeGetterOnlyError("exotic failure");
    let thrown = null;
    let out = null;
    try {
      out = augmentLoadError(exotic, "./mod.js", "/parent.js");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeNull();
    // Either mutated in place or wrapped — but the message context
    // must be present and the original must be reachable.
    const msg = out && out.message ? out.message : "";
    expect(msg).toContain("exotic failure");
    expect(msg).toContain("./mod.js");
    const isWrapped = out !== exotic;
    if (isWrapped) {
      expect(out.cause).toBe(exotic);
    }
  });
});
