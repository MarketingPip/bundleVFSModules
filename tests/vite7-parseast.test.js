import { describe, test, expect } from "@jest/globals";
import {
  lookupNativeInterception,
  BROWSER_BUILD_TARGETS,
} from "../src/browser-builds.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * M3a — `rollup/parseAst` subpath: @rollup/browser does NOT ship it (its ESM
 * export list is exactly { VERSION, defineConfig, rollup }), but vite 7's
 * dist/node/index.js does `import { parseAst, parseAstAsync } from
 * "rollup/parseAst"` at the top level — real Vite cannot boot in the
 * browser runtime without it.
 *
 * AlmostNode's proven answer: an acorn-backed parseAst/parseAstAsync
 * (rollup 4 family). acorn is a real reference parser — implementing
 * rollup's parseAst(source, options)→ESTree Program on it is honest
 * (it really parses; syntax errors really throw), not a fake.
 *
 * RED first: src/vendor/rollup-parseast.mjs does not exist yet, and the
 * table maps 'rollup/parseAst' into the nonexistent
 * /node_modules/@rollup/browser/parseAst.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARSEAST_VFS = "/node_modules/.bvm/rollup-parseast.mjs";
const repoModule = path.join(
  __dirname,
  "..",
  "src",
  "vendor",
  "rollup-parseast.mjs",
);

describe("M3a: rollup/parseAst interception", () => {
  test("table maps bare 'rollup/parseAst' to the acorn-backed VFS module", () => {
    expect(lookupNativeInterception("rollup/parseAst")).toBe(PARSEAST_VFS);
  });

  test("absolute VFS path /node_modules/rollup/parseAst maps to the module", () => {
    expect(lookupNativeInterception("/node_modules/rollup/parseAst")).toBe(
      PARSEAST_VFS,
    );
    expect(lookupNativeInterception("/node_modules/rollup/parseAst.js")).toBe(
      PARSEAST_VFS,
    );
  });

  test("no regression: 'rollup' and other subpaths still map as before", () => {
    expect(lookupNativeInterception("rollup")).toBe(
      BROWSER_BUILD_TARGETS.ROLLUP_BROWSER_MAIN,
    );
    expect(lookupNativeInterception("rollup/dist/es/rollup.browser.js")).toBe(
      "/node_modules/@rollup/browser/dist/es/rollup.browser.js",
    );
    expect(lookupNativeInterception("@rollup/browser")).toBeNull();
    expect(lookupNativeInterception("rollup/utils")).toBe(
      "/node_modules/@rollup/browser/utils",
    );
  });

  test("repo module is ESM with the two named exports, backed by real acorn", () => {
    const src = fs.readFileSync(repoModule, "utf8");
    expect(src).toContain("export function parseAst");
    expect(src).toContain("export async function parseAstAsync");
    expect(src).toContain('from "acorn"');
  });
});

describe("M3a: acorn-backed parseAst really parses (node lane)", () => {
  test("parseAst returns a real ESTree Program", async () => {
    const { parseAst } = await import("../src/vendor/rollup-parseast.mjs");
    const program = parseAst("const x = 1;");
    expect(program.type).toBe("Program");
    expect(program.body).toHaveLength(1);
    expect(program.body[0].type).toBe("VariableDeclaration");
  });

  test("parses the ESM shapes vite actually feeds it", async () => {
    const { parseAst } = await import("../src/vendor/rollup-parseast.mjs");
    const imp = parseAst('import { a } from "b";').body[0];
    expect(imp.type).toBe("ImportDeclaration");
    expect(imp.specifiers[0].imported.name).toBe("a");
    const exp = parseAst("export const y = 2;").body[0];
    expect(exp.type).toBe("ExportNamedDeclaration");
  });

  test("parseAstAsync resolves to a Program", async () => {
    const { parseAstAsync } = await import("../src/vendor/rollup-parseast.mjs");
    const program = await parseAstAsync("export default 42;");
    expect(program.type).toBe("Program");
    expect(program.body[0].type).toBe("ExportDefaultDeclaration");
    expect(program.body[0].declaration.value).toBe(42);
  });

  test("allowReturnOutsideFunction option passes through", async () => {
    const { parseAst } = await import("../src/vendor/rollup-parseast.mjs");
    const program = parseAst("return 1;", { allowReturnOutsideFunction: true });
    expect(program.body[0].type).toBe("ReturnStatement");
  });

  test("syntax errors throw honest SyntaxErrors (no fake success)", async () => {
    const { parseAst, parseAstAsync } =
      await import("../src/vendor/rollup-parseast.mjs");
    expect(() => parseAst("const = ;")).toThrow(SyntaxError);
    await expect(parseAstAsync("function (")).rejects.toThrow(SyntaxError);
  });

  test("non-string source throws TypeError", async () => {
    const { parseAst } = await import("../src/vendor/rollup-parseast.mjs");
    expect(() => parseAst(null)).toThrow(TypeError);
    expect(() => parseAst(42)).toThrow(TypeError);
  });
});

// The seven-case differential probe (2026-09-30) compared the acorn-backed
// vendor module against REAL rollup/parseAst and matched 7/7 — committed
// here so the evidence is reproducible instead of living only in a handoff.
// Honest accounting: the 7/7 match is SEMANTIC, not byte-identical. Real
// rollup wraps acorn nodes in its internal `Node` class (invisible to any
// property-traversing consumer like vite) and adds `decorators: []` to
// class elements. The tests below prove those are the ONLY deltas.
const DIFFERENTIAL_CASES = [
  "const x = 1;",
  'import { a, b as c } from "mod"; export const y = 2;',
  "class Foo extends Bar { #priv = 1; async method() { await x(); } }",
  "export default function() { return `tpl ${1 + 2}`; }",
  "for (const [k, v] of Object.entries(o)) { if (k) break; }",
  "a?.b?.(c) ?? d;",
  'export * from "./x.js"; const m = await import("./y.js");',
];

// Recursive differ over plain-object ASTs. Reports "path: a !== b" lines.
function diffPaths(a, b, path, out) {
  out = out || [];
  path = path || "";
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length)
      out.push(path + ": length " + a.length + " !== " + b.length);
    else
      for (let i = 0; i < a.length; i++)
        diffPaths(a[i], b[i], path + "/" + i, out);
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diffPaths(a[k], b[k], path + "/" + k, out);
  } else if (!Object.is(a, b)) {
    out.push(path + ": " + JSON.stringify(a) + " !== " + JSON.stringify(b));
  }
  return out;
}

// JSON round-trip neutralizes rollup's internal Node class instances; the
// only permitted remaining delta is real rollup's `decorators: []` on class
// elements (a rollup-internal affordance our acorn output omits).
function onlyDecoratorsDelta(mine, real) {
  const mineN = JSON.parse(JSON.stringify(mine));
  const realN = JSON.parse(JSON.stringify(real));
  const diffs = diffPaths(mineN, realN);
  return diffs.filter((d) => {
    const m = d.match(/^(.*): (.*) !== (.*)$/);
    return !(
      m &&
      /\/decorators$/.test(m[1]) &&
      m[2] === "undefined" &&
      m[3] === "[]"
    );
  });
}

describe("M3: differential parseAst — acorn-backed vs real rollup/parseAst", () => {
  test("7/7 varied inputs: identical ASTs modulo the known decorators delta", async () => {
    const mine = await import("../src/vendor/rollup-parseast.mjs");
    const real = await import("rollup/parseAst");
    expect(DIFFERENTIAL_CASES).toHaveLength(7);
    for (const src of DIFFERENTIAL_CASES) {
      const unexplained = onlyDecoratorsDelta(
        mine.parseAst(src),
        real.parseAst(src),
      );
      expect({ src, unexplained }).toEqual({ src, unexplained: [] });
    }
  });

  test("parseAstAsync matches real rollup/parseAstAsync modulo the same delta", async () => {
    const mine = await import("../src/vendor/rollup-parseast.mjs");
    const real = await import("rollup/parseAst");
    for (const src of DIFFERENTIAL_CASES) {
      const unexplained = onlyDecoratorsDelta(
        await mine.parseAstAsync(src),
        await real.parseAstAsync(src),
      );
      expect({ src, unexplained }).toEqual({ src, unexplained: [] });
    }
  });
});
