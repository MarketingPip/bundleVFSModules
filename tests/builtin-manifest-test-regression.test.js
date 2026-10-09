import { describe, test, expect, beforeEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression: `node:test` / `test` must resolve to the REAL test.js shim.
 *
 * 2026-10-08: commit d6c7b6e4 removed `test: "test.js"` from _builtinManifest
 * under the mistaken claim that test.js was "not a real Node builtin".
 * Jared corrected this: src/test.js IS the real node:test browser shim.
 * With the entry missing, fetchBuiltinSource('node:test') fell through to
 * the generic `export default {}` stub and sync require('test') threw
 * ERR_MODULE_NOT_FOUND (browser E2E: basic/repl/repl2 runs logged
 * "[bvm] sync-builtin preload skipped test: [ERR_MODULE_NOT_FOUND]").
 *
 * Also covers the sibling landmine found the same day: the manifest listed
 * `trace_events: "trace_events.js"` but the dist file is `trace.js`
 * (src/build-vfs.mjs derives dist names from the bundle KEY, and the key
 * is `trace`). Every manifest value must name a file that exists in dist/.
 *
 * Pattern: extract _builtinManifest + fetchBuiltinSource verbatim from
 * runtime.js (they cannot be imported under Node), stub fetch to serve
 * dist/ from disk exactly like the proof server's /local-repo/dist/ route.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const RUNTIME_SRC = fs.readFileSync(path.join(REPO, "runtime.js"), "utf8");

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

function extractConst(src, name) {
  const marker = `const ${name} =`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("const not found: " + name);
  const eq = src.indexOf("=", start);
  let depth = 0;
  for (let i = eq + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === ";" && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("unterminated const " + name);
}

function extractFunctionAt(src, start) {
  const parenOpen = src.indexOf("(", start);
  const parenClose = extractBalanced(src, parenOpen, "(", ")");
  const braceOpen = src.indexOf("{", parenClose);
  const braceClose = extractBalanced(src, braceOpen, "{", "}");
  return src.slice(start, braceClose + 1).replace(/^export\s+/, "");
}

function buildFetch() {
  const manifestSrc = extractConst(RUNTIME_SRC, "_builtinManifest");
  const baseUrlSrc = extractConst(RUNTIME_SRC, "_builtinBaseUrl");
  const cacheSrc = extractConst(RUNTIME_SRC, "_builtinSourceCache");
  const fetchSrcIdx = RUNTIME_SRC.indexOf("async function fetchBuiltinSource(");
  const fetchSrc = extractFunctionAt(RUNTIME_SRC, fetchSrcIdx);
  const factory = new Function(
    `${manifestSrc}\n${baseUrlSrc}\n${cacheSrc}\n${fetchSrc}\nreturn { manifest: _builtinManifest, fetchBuiltinSource };`,
  );
  return factory();
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

describe("builtin manifest: node:test regression (2026-10-08)", () => {
  let manifest;
  let fetchBuiltinSource;

  beforeEach(() => {
    installDistFetch();
    ({ manifest, fetchBuiltinSource } = buildFetch());
  });

  test("src/test.js exists — it is the real node:test shim, not bogus", () => {
    expect(fs.existsSync(path.join(REPO, "src", "test.js"))).toBe(true);
  });

  test("manifest maps bare 'test' to dist/test.js", () => {
    expect(manifest["test"]).toBe("test.js");
  });

  test("manifest maps 'test/reporters' to dist/test_reporters.js", () => {
    expect(manifest["test/reporters"]).toBe("test_reporters.js");
  });

  test("manifest maps 'trace_events' to the real dist filename trace.js", () => {
    expect(manifest["trace_events"]).toBe("trace.js");
  });

  test("every manifest value names a file that exists in dist/", () => {
    const missing = Object.entries(manifest)
      .filter(([, file]) => !fs.existsSync(path.join(REPO, "dist", file)))
      .map(([key, file]) => `${key} -> ${file}`);
    expect(missing).toEqual([]);
  });

  test("fetchBuiltinSource('node:test') returns the REAL shim, not the stub", async () => {
    const src = await fetchBuiltinSource("node:test");
    expect(src).not.toMatch(/^export default \{\}/);
    expect(src.length).toBeGreaterThan(1024);
  });

  test("fetchBuiltinSource('test') (bare/internal) returns the REAL shim", async () => {
    const src = await fetchBuiltinSource("test");
    expect(src).not.toMatch(/^export default \{\}/);
    expect(src.length).toBeGreaterThan(1024);
  });

  test("node:test and bare test resolve to identical bytes", async () => {
    const a = await fetchBuiltinSource("node:test");
    const b = await fetchBuiltinSource("test");
    expect(a).toBe(b);
  });

  test("fetchBuiltinSource('node:test/reporters') returns the reporters shim", async () => {
    const src = await fetchBuiltinSource("node:test/reporters");
    expect(src).not.toMatch(/^export default \{\}/);
    expect(src.length).toBeGreaterThan(512);
  });

  test("fetchBuiltinSource('node:trace_events') returns the trace shim", async () => {
    const src = await fetchBuiltinSource("node:trace_events");
    expect(src).not.toMatch(/^export default \{\}/);
  });
});
