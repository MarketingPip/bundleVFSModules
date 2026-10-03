import { describe, test, expect, beforeEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builtin shim resolution through the live parent `_dynamic_import` handler.
 *
 * The vite proof unblocked `fs_promises` only via a generic stub
 * (`export default {}; ...`) committed as a workaround. This test proves the
 * REAL shim path: the live (second) `_dynamic_import` handler in runtime.js
 * must call the real `fetchBuiltinSource()` and return the actual
 * `dist/fs_promises.js` bytes — not a stub.
 *
 * Pattern follows tests/vite7-dynamic-import.test.js: extract the handler
 * verbatim from runtime.js (it cannot be imported under Node) with its
 * closure neighbors wired in. `fetch` is stubbed to serve `dist/` from disk,
 * exactly like the proof server's `/local-repo/dist/` route; any CDN fetch
 * throws so the test proves no network is needed.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const RUNTIME_SRC = fs.readFileSync(path.join(REPO, "runtime.js"), "utf8");
const DIST_SRC = fs.readFileSync(
  path.join(REPO, "dist", "fs_promises.js"),
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

function extractFunctionAt(src, start) {
  const parenOpen = src.indexOf("(", start);
  const parenClose = extractBalanced(src, parenOpen, "(", ")");
  const braceOpen = src.indexOf("{", parenClose);
  const braceClose = extractBalanced(src, braceOpen, "{", "}");
  return src.slice(start, braceClose + 1).replace(/^export\s+/, "");
}

// The second registerInterop('_dynamic_import', ...) wins — the live handler.
function extractLiveHandler(src) {
  const hits = [
    ...src.matchAll(/registerInterop\(\s*["']_dynamic_import["']/g),
  ];
  expect(hits.length).toBeGreaterThanOrEqual(2);
  const start = hits[1].index;
  const asyncIdx = src.indexOf("async (", start);
  const parenOpen = src.indexOf("(", asyncIdx);
  const parenClose = extractBalanced(src, parenOpen, "(", ")");
  const braceOpen = src.indexOf("{", parenClose);
  const braceClose = extractBalanced(src, braceOpen, "{", "}");
  return src.slice(asyncIdx, braceClose + 1);
}

// Extract a `const NAME = ...;` statement (object literal or string).
function extractConst(src, name) {
  const marker = `const ${name} =`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("const not found: " + name);
  const eq = src.indexOf("=", start);
  // find statement end: semicolon at depth 0
  let depth = 0;
  for (let i = eq + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === ";" && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("unterminated const: " + name);
}

function buildHandler() {
  const handlerSrc = extractLiveHandler(RUNTIME_SRC);
  const manifestSrc = extractConst(RUNTIME_SRC, "_builtinManifest");
  const baseUrlSrc = extractConst(RUNTIME_SRC, "_builtinBaseUrl");
  const cacheSrc = extractConst(RUNTIME_SRC, "_builtinSourceCache");
  const fetchSrcIdx = RUNTIME_SRC.indexOf("async function fetchBuiltinSource(");
  const fetchSrc = extractFunctionAt(RUNTIME_SRC, fetchSrcIdx);
  const pickVfsSrc = extractFunctionAt(
    RUNTIME_SRC,
    RUNTIME_SRC.indexOf("function pickDynamicImportVfs("),
  );
  const unflattenSrc = extractFunctionAt(
    RUNTIME_SRC,
    RUNTIME_SRC.indexOf("function unflattenFileSystem("),
  );
  const factory = new Function(
    "pickDynamicImportVfs",
    "unflattenFileSystem",
    `${manifestSrc}\n${baseUrlSrc}\n${cacheSrc}\n${fetchSrc}\n${pickVfsSrc}\n${unflattenSrc}\nreturn { handler: (${handlerSrc}), fetchBuiltinSource };`,
  );
  // The handler is an arrow function: it captures the factory's `this`
  // lexically, so invoke the factory with .call(fakeHost) — .bind() on the
  // arrow itself would be ignored (same pattern as
  // tests/vite7-dynamic-import.test.js).
  const fakeHost = { config: { fs: {} } };
  const { handler, fetchBuiltinSource } = factory.call(
    fakeHost,
    new Function(`${pickVfsSrc}\nreturn pickDynamicImportVfs;`)(),
    new Function(`${unflattenSrc}\nreturn unflattenFileSystem;`)(),
  );
  return { handler, fetchBuiltinSource };
}

// `fetch` serves dist/ from disk for /local-repo/dist/* (proof-server
// behavior). Anything else throws: the test must not need the CDN.
function installDistFetch() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const m = u.match(/\/local-repo\/dist\/(.+)$/);
    if (m) {
      const p = path.join(REPO, "dist", m[1]);
      if (fs.existsSync(p)) {
        const text = fs.readFileSync(p, "utf8");
        return { ok: true, status: 200, text: async () => text };
      }
      return { ok: false, status: 404, text: async () => "" };
    }
    throw new Error("network fetch not allowed in test: " + u);
  };
}

describe("builtin shim resolution through live _dynamic_import handler", () => {
  beforeEach(() => {
    installDistFetch();
  });

  test("RED: handler returns the REAL fs_promises shim, not the generic stub", async () => {
    const { handler } = buildHandler();
    const result = await handler(
      "fs_promises",
      "import",
      null,
      null,
      true,
      "/",
    );
    expect(result).toBeTruthy();
    expect(typeof result.source).toBe("string");
    expect(result.resolvedPath).toBeNull();
    // The real shim is 649KB of bundled code — the generic stub is <200 chars.
    expect(result.source.length).toBeGreaterThan(100000);
    expect(result.source).toBe(DIST_SRC);
  });

  test("fetchBuiltinSource resolves manifest key fs/promises for path fs_promises", async () => {
    const { fetchBuiltinSource } = buildHandler();
    const src = await fetchBuiltinSource("fs_promises");
    expect(src).toBe(DIST_SRC);
  });

  test("missing builtin (trace_events) falls back to generic stub, not throw", async () => {
    const { handler } = buildHandler();
    const result = await handler(
      "trace_events",
      "import",
      null,
      null,
      true,
      "/",
    );
    expect(result).toBeTruthy();
    expect(typeof result.source).toBe("string");
    expect(result.source.length).toBeGreaterThan(0);
  });
});
