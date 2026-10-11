import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import { parse } from "acorn";

import { convertEsmToCjs } from "../src/runtime/transforms-esm.js";
import {
  convertCjsToEsm,
  convertCjsToEsm_backup,
  _convertCjsToEsm,
  isCommonJS,
  detectModuleSystem,
  transformRelativeModule,
} from "../src/runtime/transforms-cjs.js";
import {
  replaceGlobalThisVar,
  transformImportsToLoadModule,
  generateImportBinding,
  setBuiltinManifest,
} from "../src/runtime/transforms-imports.js";

beforeEach(() => {
  setBuiltinManifest({ fs: "fs.js", path: "path.js", util: "util.js" });
});

describe("isCommonJS", () => {
  test("detects require() calls", () => {
    expect(isCommonJS(`const fs = require("fs");`)).toBe(true);
  });
  test("detects module.exports", () => {
    expect(isCommonJS(`module.exports = { a: 1 };`)).toBe(true);
  });
  test("detects exports.* assignments", () => {
    expect(isCommonJS(`exports.a = 1;`)).toBe(true);
  });
  test("bare exports references are NOT flagged by isCommonJS (only by detectModuleSystem)", () => {
    // isCommonJS only checks require() and export assignments; the free-
    // `exports` identifier heuristic lives in detectModuleSystem.
    expect(
      isCommonJS(
        `Object.defineProperty(exports, "__esModule", { value: true });`,
      ),
    ).toBe(false);
  });
  test("pure ESM is not CJS", () => {
    expect(isCommonJS(`import x from "y";\nexport default x;`)).toBe(false);
  });
  test("plain script is not CJS", () => {
    expect(isCommonJS(`const a = 1;\nconsole.log(a);`)).toBe(false);
  });
  test("returns false on unparsable input", () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(isCommonJS(`const = {{{`)).toBe(false);
    err.mockRestore();
  });
});

describe("detectModuleSystem", () => {
  test("ESM-only", () => {
    expect(detectModuleSystem(`import x from "y";\nexport default x;`)).toEqual(
      {
        isCJS: false,
        isESM: true,
      },
    );
  });
  test("CJS-only", () => {
    expect(
      detectModuleSystem(`const x = require("y");\nmodule.exports = x;`),
    ).toEqual({
      isCJS: true,
      isESM: false,
    });
  });
  test("mixed", () => {
    expect(
      detectModuleSystem(`import x from "y";\nmodule.exports = x;`),
    ).toEqual({ isCJS: true, isESM: true });
  });
  test("neither", () => {
    expect(detectModuleSystem(`const a = 1;`)).toEqual({
      isCJS: false,
      isESM: false,
    });
  });
  test("TS __esModule marker counts as CJS", () => {
    expect(
      detectModuleSystem(
        `Object.defineProperty(exports, "__esModule", { value: true });`,
      ).isCJS,
    ).toBe(true);
  });
  test("a locally declared `exports` binding is not CJS", () => {
    // The VariableDeclarator id position is excluded by
    // isExportsPropertyOrBinding. (A *free* `exports` reference elsewhere,
    // e.g. console.log(exports), IS flagged — the heuristic has no scope
    // analysis; that is the original behavior.)
    expect(detectModuleSystem(`const exports = 1;`)).toEqual({
      isCJS: false,
      isESM: false,
    });
    expect(detectModuleSystem(`try {} catch (exports) {}`).isCJS).toBe(false);
  });
});

describe("convertCjsToEsm", () => {
  test("module.exports = literal becomes default export + interop marker", () => {
    const { code } = convertCjsToEsm(`module.exports = 42;`);
    expect(code).toContain("export default 42;");
    expect(code).toContain("export const __bvm_cjs__ = true;");
  });
  test("exports.* become named exports when no module.exports", () => {
    const { code } = convertCjsToEsm(`exports.a = 1;\nexports.b = 2;`);
    expect(code).toContain("export const a = 1;");
    expect(code).toContain("export const b = 2;");
    expect(code).toContain("export const __bvm_cjs__ = true;");
  });
  test("last module.exports wins; earlier ones removed", () => {
    const { code } = convertCjsToEsm(
      `module.exports = { a: 1 };\nmodule.exports = { b: 2 };`,
    );
    expect(code).not.toContain("{ a: 1 }");
    expect(code).toContain("export default { b: 2 };");
  });
  test("TypeScript placeholder (exports.X = void 0) + self-ref re-export", () => {
    const { code } = convertCjsToEsm(
      `Object.defineProperty(exports, "__esModule", { value: true });\n` +
        `exports.foo = void 0;\nfunction foo() {}\nexports.foo = foo;`,
    );
    expect(code).not.toContain("__esModule");
    expect(code).not.toContain("void 0");
    expect(code).toContain("export { foo };");
  });
  test("__exportStar(require(x), exports) becomes export * from", () => {
    const { code } = convertCjsToEsm(`__exportStar(require("./x"), exports);`);
    expect(code).toContain(`export * from "./x";`);
  });
  test("exports.X reads rewrite to the local binding", () => {
    const { code } = convertCjsToEsm(
      `exports.a = 1;\nconsole.log(exports.a, exports.missing);`,
    );
    expect(code).toContain("console.log(a, undefined);");
  });
  test("returns a source map", () => {
    const { map } = convertCjsToEsm(`module.exports = 1;`, {
      filename: "m.js",
    });
    expect(JSON.parse(String(map)).sources).toEqual(["m.js"]);
  });
  test("no exports at all -> code passes through, no marker", () => {
    const { code } = convertCjsToEsm(`const a = 1;\nconsole.log(a);`);
    expect(code).toContain("const a = 1;");
    expect(code).not.toContain("__bvm_cjs__");
  });
});

describe("convertCjsToEsm_backup / _convertCjsToEsm", () => {
  test("backup: last module.exports wins", () => {
    const out = convertCjsToEsm_backup(
      `module.exports = { a: 1 };\nmodule.exports = { b: 2 };`,
    );
    expect(out).not.toContain("{ a: 1 }");
    expect(out).toContain("export default { b: 2 };");
  });
  test("_convertCjsToEsm: basic patterns", () => {
    const out = _convertCjsToEsm(`module.exports = foo;\nexports.bar = 2;`);
    expect(out).toContain("export default foo;");
    expect(out).toContain("export const bar = 2;");
  });
});

describe("convertEsmToCjs", () => {
  test("default export of a literal", () => {
    const { code } = convertEsmToCjs(`export default 42;`);
    expect(code).toContain("module.exports = 42;");
  });
  test("import statements become require()", () => {
    const { code } = convertEsmToCjs(
      `import x from "m1";\nimport { a, b as c } from "m2";\nimport "side";`,
    );
    expect(code).toContain(`const x = require("m1");`);
    expect(code).toContain(`const { a, b: c } = require("m2");`);
    expect(code).toContain(`require("side");`);
  });
  test("named exports become exports.* assignments", () => {
    const { code } = convertEsmToCjs(
      `export const a = 1;\nexport function f() {}`,
    );
    expect(code).toContain("exports.a = a;");
    expect(code).toContain("exports.f = f;");
  });
  test("export { x } specifier form", () => {
    const { code } = convertEsmToCjs(`const x = 1;\nexport { x, x as y };`);
    expect(code).toContain("exports.x = x;");
    expect(code).toContain("exports.y = x;");
  });
  test("export * from becomes Object.assign", () => {
    const { code } = convertEsmToCjs(`export * from "./lib.js";`);
    expect(code).toContain(`Object.assign(exports, require("./lib.js"));`);
  });
  test("returns a source map", () => {
    const { map } = convertEsmToCjs(`export default 1;`, { filename: "e.js" });
    expect(JSON.parse(String(map)).sources).toEqual(["e.js"]);
  });
});

describe("transformRelativeModule", () => {
  test("rewrites relative dynamic import() to loadModule", () => {
    const out = transformRelativeModule(`const m = await import("./a.js");`);
    expect(out).toContain(`loadModule("./a.js", 'import')`);
    expect(out).not.toContain("import(");
  });
  test("leaves bare/absolute dynamic imports alone", () => {
    const out = transformRelativeModule(`const m = await import("pkg");`);
    expect(out).toContain(`import("pkg")`);
  });
  test("does not rewrite require() (only import())", () => {
    const out = transformRelativeModule(`const x = require("./b.js");`);
    expect(out).toContain(`require("./b.js")`);
  });
});

describe("replaceGlobalThisVar", () => {
  test("replaces globalThis._RUNTIME_ member expressions", () => {
    const { code } = replaceGlobalThisVar(
      `globalThis._RUNTIME_.loadModule("x");`,
      "_RUNTIME_",
      {
        replacement: "globalThis._RUNTIMEabc_",
      },
    );
    expect(code).toBe(`globalThis._RUNTIMEabc_.loadModule("x");`);
  });
  test("generateUnique produces a suffixed replacement", () => {
    const { code } = replaceGlobalThisVar(
      `globalThis._RUNTIME_.x;`,
      "_RUNTIME_",
      {
        generateUnique: true,
      },
    );
    expect(code).toMatch(/globalThis\._RUNTIME__RUNTIME__[a-z0-9]+\.x;/);
  });
  test("does not touch other member expressions", () => {
    const { code } = replaceGlobalThisVar(`globalThis.other.x;`, "_RUNTIME_", {
      replacement: "globalThis._R_",
    });
    expect(code).toBe(`globalThis.other.x;`);
  });
});

describe("transformImportsToLoadModule", () => {
  test("static imports lift through loadModule; named refs become live member access", () => {
    const { code } = transformImportsToLoadModule(
      "UU",
      `import def, { a, b as c } from "./m.js";\nconsole.log(def, a, c);`,
      "entry.js",
    );
    expect(code).toContain(
      `globalThis._RUNTIMEUU_.loadModule("./m.js", "import", "entry.js", null)`,
    );
    expect(code).toContain("__lm_");
    // live-binding rewrite: local refs -> liftedVar.importedName
    expect(code).toMatch(
      /console\.log\(__lm_[a-z0-9]+\.default, __lm_[a-z0-9]+\.a, __lm_[a-z0-9]+\.b\)/,
    );
    expect(code).not.toContain("import def");
  });
  test("namespace import keeps a live const alias", () => {
    const { code } = transformImportsToLoadModule(
      "UU",
      `import * as ns from "pkg";\nconsole.log(ns.x);`,
      "entry.js",
    );
    expect(code).toMatch(/const ns = __lm_[a-z0-9]+;/);
  });
  test("nested builtin require() rewrites to __bvmRequireSync", () => {
    const { code } = transformImportsToLoadModule(
      "UU",
      `function g() { return require("fs").readFileSync; }`,
      "entry.js",
    );
    expect(code).toContain(`__bvmRequireSync("fs")`);
  });
  test("dynamic require() rewrites the callee to __bvmRequireSync", () => {
    const { code } = transformImportsToLoadModule(
      "UU",
      `const m = require(name);`,
      "entry.js",
    );
    expect(code).toContain(`__bvmRequireSync(name)`);
  });
  test("preserveRequireCalls leaves require() intact", () => {
    const { code } = transformImportsToLoadModule(
      "UU",
      `const x = require("./u.js");`,
      "entry.js",
      null,
      { preserveRequireCalls: true },
    );
    expect(code).toContain(`require("./u.js")`);
  });
  test("dynamic import() becomes _RUNTIME<uuid>_.loadModule", () => {
    const { code } = transformImportsToLoadModule(
      "UU",
      `async function f() { return await import("./dyn.js"); }`,
      "entry.js",
    );
    expect(code).toContain(
      `globalThis._RUNTIMEUU_.loadModule("./dyn.js", 'import', "entry.js", null)`,
    );
  });
  test("export * from emits a star marker", () => {
    const { code } = transformImportsToLoadModule(
      "UU",
      `export * from "./x.js";`,
      "entry.js",
    );
    expect(code).toMatch(/export const __bvm_star_0 = __lm_[a-z0-9]+;/);
  });
  test("import.meta.url is rewritten", () => {
    const { code } = transformImportsToLoadModule(
      "UU",
      `console.log(import.meta.url);`,
      "entry.js",
    );
    expect(code).toContain(`'file:///entry.js'`);
  });
  test("returns preamble/body split", () => {
    const r = transformImportsToLoadModule(
      "UU",
      `import { a } from "./m.js";\nconsole.log(a);`,
      "entry.js",
    );
    expect(r.preamble).toContain("loadModule");
    expect(r.body).toContain("console.log");
    expect(typeof r.code).toBe("string");
    expect(JSON.parse(String(r.map)).sources).toEqual(["entry.js"]);
  });
});

describe("generateImportBinding", () => {
  const importNode = (src) =>
    parse(src, { ecmaVersion: "latest", sourceType: "module" }).body[0];
  test("namespace import -> live const alias", () => {
    expect(
      generateImportBinding(importNode(`import * as ns from "m";`), "__lm_1"),
    ).toBe("const ns = __lm_1;");
  });
  test("named/default imports -> no binding (live member access instead)", () => {
    expect(
      generateImportBinding(importNode(`import d, { a } from "m";`), "__lm_1"),
    ).toBe("");
    expect(generateImportBinding(importNode(`import "m";`), "__lm_1")).toBe("");
  });
});
