// Differential test for src/build-runtime.mjs.
//
// Builds runtime.js from src/runtime/*.js into a temp dir (the checked-in
// runtime.js is left untouched) and verifies the bundle is functionally
// identical to the modules it was assembled from, and structurally faithful
// to the current runtime.js:
//
//   structural (in this Jest process — pure text analysis, no import):
//     1. the build succeeds and the output parses as ESM
//     2. the export surface covers every export of the current runtime.js
//     3. no test-only shims (setBuiltinManifest) leak into the bundle
//     4. static imports are browser-correct: esm.sh URLs or relative paths,
//        no bare npm specifiers
//     5. the _RUNTIME_ contract markers are preserved verbatim
//   behavioral (tests/helpers/build-runtime-probe.mjs, spawned as plain
//   `node` because Jest forbids module.register() hooks in its sandbox):
//     6. transform/import-rewrite/host-util/transpile/syntax/event behaviors
//        are byte-identical to the src/runtime modules
//     7. cross-module wiring is real (CodeSandbox instanceof EventEmitter)

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const BUILD_DIR = path.join(__dirname, ".tmp-build-runtime");
const BUILT_FILE = path.join(BUILD_DIR, "runtime.js");
const CURRENT_RUNTIME = path.join(ROOT, "runtime.js");

const MODULE_ORDER = [
  "bootstrap.js",
  "builtins.js",
  "terminal.js",
  "builtin-modules.js",
  "transpile.js",
  "vfs-serialize.js",
  "transforms-esm.js",
  "transforms-cjs.js",
  "transforms-imports.js",
  "syntax.js",
  "events.js",
  "import-resolver.js",
  "vfs-server.js",
  "execution-context.js",
  "code-sandbox.js",
  "sandbox-runtime.js",
  "code-transformer.js",
  "entry.js",
  "host-utils.js",
  "message-handler.js",
  "output-shim.js",
];

// Every export of the current runtime.js, with the expected typeof.
const ORIGINAL_EXPORTS = {
  toNodeKeypress: "function",
  builtinModules: "object",
  transpileTypeScript: "function",
  customAcorn: "function",
  serializeVfs: "function",
  deserializeVfs: "function",
  rehydrateVfs: "function",
  convertEsmToCjs: "function",
  convertCjsToEsm: "function",
  convertCjsToEsm_backup: "function",
  replaceGlobalThisVar: "function",
  transformImportsToLoadModule: "function",
  SyntaxChecker: "function",
  ImportResolver: "function",
  __parseStackLocationFn: "function",
  SandboxRuntime: "function",
  CodeTransformer: "function",
  CodeSandbox: "function",
  executeCode: "function",
  createSandbox: "function",
  formatErrors: "function",
  flattenFileTree: "function",
};

let builtSrc;

function exportNamesOf(src) {
  const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });
  const names = [];
  for (const node of ast.body) {
    if (node.type !== "ExportNamedDeclaration") continue;
    if (node.declaration) {
      const d = node.declaration;
      if (d.type === "VariableDeclaration")
        d.declarations.forEach((x) => names.push(x.id.name));
      else names.push(d.id.name);
    } else {
      node.specifiers.forEach((s) => names.push(s.exported.name));
    }
  }
  return names;
}

function staticImportSources(src) {
  const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });
  return ast.body
    .filter((n) => n.type === "ImportDeclaration")
    .map((n) => n.source.value);
}

beforeAll(async () => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  await execFileAsync(
    "node",
    [path.join(ROOT, "src", "build-runtime.mjs"), "--out", BUILT_FILE],
    { cwd: ROOT, timeout: 120000 },
  );
  expect(fs.existsSync(BUILT_FILE)).toBe(true);
  builtSrc = fs.readFileSync(BUILT_FILE, "utf8");
}, 180000);

afterAll(() => {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
});

describe("build-runtime differential", () => {
  test("build output parses as ESM and contains every module section in order", () => {
    expect(() =>
      parse(builtSrc, { ecmaVersion: "latest", sourceType: "module" }),
    ).not.toThrow();
    let lastIdx = -1;
    for (const m of MODULE_ORDER) {
      const idx = builtSrc.indexOf(`// ── src/runtime/${m} ──`);
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  test("export surface covers every export of the current runtime.js", () => {
    const currentSrc = fs.readFileSync(CURRENT_RUNTIME, "utf8");
    const currentExports = exportNamesOf(currentSrc);
    // The recorded contract: the current file must export exactly these 22.
    expect([...currentExports].sort()).toEqual(
      Object.keys(ORIGINAL_EXPORTS).sort(),
    );
    const builtExports = new Set(exportNamesOf(builtSrc));
    const missing = Object.keys(ORIGINAL_EXPORTS).filter(
      (n) => !builtExports.has(n),
    );
    expect(missing).toEqual([]);
  });

  test("no test-only shims leak into the bundle", () => {
    const builtExports = new Set(exportNamesOf(builtSrc));
    expect(builtExports.has("setBuiltinManifest")).toBe(false);
    expect(builtSrc).not.toMatch(/function setBuiltinManifest/);
  });

  test("static imports are browser-correct (esm.sh URLs or relative paths)", () => {
    const sources = staticImportSources(builtSrc);
    expect(sources.length).toBeGreaterThan(0);
    const bad = sources.filter(
      (s) =>
        !(
          s.startsWith("https://esm.sh/") ||
          s.startsWith("./") ||
          s.startsWith("../")
        ),
    );
    // A bare specifier would fail in the browser (no import map on the host).
    expect(bad).toEqual([]);
    const esm = sources.filter((s) => s.startsWith("https://esm.sh/"));
    const expectedEsm = [
      "https://esm.sh/acorn",
      "https://esm.sh/acorn-walk",
      "https://esm.sh/magic-string",
      "https://esm.sh/estree-walker",
      "https://esm.sh/uuid",
      "https://esm.sh/@jridgewell/trace-mapping",
      "https://esm.sh/@ampproject/remapping",
    ];
    expect(expectedEsm.filter((p) => !esm.includes(p))).toEqual([]);
    // Dual-lane dynamic imports keep the exact browser specifiers too.
    const expectedDynamic = [
      "https://esm.sh/builtin-modules",
      "https://esm.sh/typescript@5.4.5",
      "https://esm.sh/memfs",
      "https://esm.sh/acorn-import-assertions",
    ];
    expect(expectedDynamic.filter((s) => !builtSrc.includes(s))).toEqual([]);
  });

  // Strip comments via real parsing (a regex would mangle URLs in strings).
  function stripComments(src) {
    const comments = [];
    parse(src, {
      ecmaVersion: "latest",
      sourceType: "module",
      onComment: (block, text, start, end) => comments.push([start, end]),
    });
    let out = src;
    for (const [start, end] of comments.sort((a, b) => b[0] - a[0])) {
      out = out.slice(0, start) + " ".repeat(end - start) + out.slice(end);
    }
    return out;
  }

  test("_RUNTIME_ contract markers are preserved verbatim", () => {
    const currentSrc = fs.readFileSync(CURRENT_RUNTIME, "utf8");
    // Extraction added explanatory comments mentioning _RUNTIME_; compare
    // the functional code only.
    const count = (s) => (stripComments(s).match(/_RUNTIME_/g) || []).length;
    expect(count(builtSrc)).toBe(count(currentSrc));
    expect(stripComments(builtSrc)).toContain("globalThis._RUNTIME_");
  });

  test("behavioral differential vs the modules (child node process)", async () => {
    const { stdout } = await execFileAsync(
      "node",
      [path.join(__dirname, "helpers", "build-runtime-probe.mjs"), BUILT_FILE],
      { cwd: ROOT, timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
    );
    const { checks } = JSON.parse(stdout);
    const failed = checks.filter((c) => !c.pass);
    for (const c of checks) {
      expect(`${c.name}${c.pass ? "" : ` — ${c.detail}`}`).toBe(c.name);
    }
    expect(failed).toEqual([]);
    expect(checks.length).toBeGreaterThan(15);
  }, 180000);
});
