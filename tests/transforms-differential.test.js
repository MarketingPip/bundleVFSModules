/**
 * Differential test: the extracted src/runtime/transforms-*.js modules must
 * produce BYTE-IDENTICAL output to the original functions in runtime.js.
 *
 * Method: parse runtime.js with acorn, slice each original function body,
 * eval it in a sandbox scope with the same dependencies (acorn, acorn-walk,
 * MagicString, estree-walker, the real _builtinManifest from runtime.js),
 * then compare extracted-module output vs original output over a corpus of
 * inputs. Math.random is reseeded before every call so the random lifted-var
 * names (__lm_xxxx) match exactly.
 */
import { jest, describe, test, expect, beforeAll } from "@jest/globals";
import { parse } from "acorn";
import * as acornNs from "acorn";
import * as walkNs from "acorn-walk";
import MagicString from "magic-string";
import { walk as walkerFn } from "estree-walker";
import { readFileSync } from "fs";

import * as esmMod from "../src/runtime/transforms-esm.js";
import * as cjsMod from "../src/runtime/transforms-cjs.js";
import * as importsMod from "../src/runtime/transforms-imports.js";

const FN_NAMES = [
  "convertEsmToCjs",
  "convertCjsToEsm",
  "convertCjsToEsm_backup",
  "_convertCjsToEsm",
  "isCommonJS",
  "detectModuleSystem",
  "transformRelativeModule",
  "replaceGlobalThisVar",
  "transformImportsToLoadModule",
  "generateImportBinding",
];

const EXTRACTED = {
  convertEsmToCjs: esmMod.convertEsmToCjs,
  convertCjsToEsm: cjsMod.convertCjsToEsm,
  convertCjsToEsm_backup: cjsMod.convertCjsToEsm_backup,
  _convertCjsToEsm: cjsMod._convertCjsToEsm,
  isCommonJS: cjsMod.isCommonJS,
  detectModuleSystem: cjsMod.detectModuleSystem,
  transformRelativeModule: cjsMod.transformRelativeModule,
  replaceGlobalThisVar: importsMod.replaceGlobalThisVar,
  transformImportsToLoadModule: importsMod.transformImportsToLoadModule,
  generateImportBinding: importsMod.generateImportBinding,
};

let originals;
let manifest;

function reseed(seed = 987654321) {
  let s = seed >>> 0;
  Math.random = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function norm(value) {
  // Normalize transform results for byte comparison: code/preamble/body as
  // exact strings, source maps as canonical JSON.
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] =
        k === "map" && value[k] != null
          ? JSON.parse(JSON.stringify(value[k]))
          : value[k];
    }
    return JSON.stringify(out);
  }
  return JSON.stringify(value);
}

function diffCheck(name, ...args) {
  reseed();
  const a = norm(EXTRACTED[name](...args));
  reseed();
  const b = norm(originals[name](...args));
  expect(a).toBe(b);
}

beforeAll(() => {
  const src = readFileSync(new URL("../runtime.js", import.meta.url), "utf8");
  const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });
  const defs = {};
  for (const n of ast.body) {
    const d = n.type === "ExportNamedDeclaration" ? n.declaration : n;
    if (d && d.type === "FunctionDeclaration" && FN_NAMES.includes(d.id.name)) {
      defs[d.id.name] = src.slice(n.start, n.end).replace(/^export\s+/, "");
    }
    if (n.type === "VariableDeclaration") {
      for (const dd of n.declarations) {
        if (dd.id.name === "_builtinManifest" && dd.init) {
          manifest = eval("(" + src.slice(dd.init.start, dd.init.end) + ")");
        }
      }
    }
  }
  expect(Object.keys(defs).sort()).toEqual([...FN_NAMES].sort());
  expect(manifest && typeof manifest).toBe("object");
  const factory = new Function(
    "acorn",
    "walk",
    "MagicString",
    "walker",
    "_builtinManifest",
    FN_NAMES.map((nm) => defs[nm]).join("\n") +
      "\nreturn {" +
      FN_NAMES.join(",") +
      "};",
  );
  originals = factory(acornNs, walkNs, MagicString, walkerFn, manifest);
  importsMod.setBuiltinManifest(manifest);
});

describe("byte-identical output vs runtime.js originals", () => {
  test("convertEsmToCjs corpus", () => {
    const cases = [
      `export default 42;`,
      `export default function foo() { return 1; }`,
      `import x from "m1";\nimport { a, b as c } from "m2";\nimport * as ns from "m3";\nimport "side";`,
      `export const a = 1, b = 2;\nexport function f() {}\nexport class K {}`,
      `const x = 1;\nexport { x, x as y };`,
      `export * from "./lib.js";\nexport { q } from "./lib2.js";`,
      `import d, { named } from "pkg";\nexport default d;\nexport { named };`,
    ];
    for (const code of cases) {
      diffCheck("convertEsmToCjs", code);
      diffCheck("convertEsmToCjs", code, { filename: "sample.js" });
    }
  });

  test("convertCjsToEsm corpus", () => {
    const cases = [
      `module.exports = 42;`,
      `function foo() {}\nmodule.exports = foo;`,
      `exports.a = 1;\nexports.b = 2;`,
      `module.exports = { a: 1 };\nmodule.exports = { b: 2 };`,
      `exports.a = 1;\nmodule.exports = 42;`,
      // TypeScript emit patterns
      `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.foo = void 0;\nfunction foo() {}\nexports.foo = foo;`,
      `exports.a = void 0;\nexports.a = 5;`,
      `exports.x = x;`,
      `__exportStar(require("./x"), exports);`,
      `exports.a = 1;\nconsole.log(exports.a, exports.missing);`,
      `const a = 1;\nconsole.log(a);`,
      `module.exports = require("./other.js");`,
    ];
    for (const code of cases) {
      diffCheck("convertCjsToEsm", code);
      diffCheck("convertCjsToEsm", code, { filename: "c.js" });
    }
  });

  test("convertCjsToEsm_backup corpus", () => {
    for (const code of [
      `module.exports = { a: 1 };\nmodule.exports = { b: 2 };`,
      `exports.a = 1;`,
      `module.exports = foo;`,
    ]) {
      diffCheck("convertCjsToEsm_backup", code);
    }
  });

  test("_convertCjsToEsm corpus", () => {
    for (const code of [
      `module.exports = foo;\nexports.bar = 2;`,
      `exports.a = 1;\nexports.b = function() {};`,
    ]) {
      diffCheck("_convertCjsToEsm", code);
    }
  });

  test("isCommonJS / detectModuleSystem corpus", () => {
    const cases = [
      `const x = require("fs");`,
      `module.exports = 1;`,
      `exports.a = 1;`,
      `import x from "y";\nexport default x;`,
      `import x from "y";\nmodule.exports = x;`,
      `const a = 1;\nconsole.log(a);`,
      `Object.defineProperty(exports, "__esModule", { value: true });`,
      `const exports = 1;`,
      `export * from "./x.js";`,
    ];
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const code of cases) {
        diffCheck("isCommonJS", code);
        diffCheck("detectModuleSystem", code);
      }
    } finally {
      err.mockRestore();
    }
  });

  test("transformRelativeModule corpus", () => {
    for (const code of [
      `const m = await import("./a.js");`,
      `import("../up/b.js");\nimport("pkg");\nimport("/abs.js");`,
      `const x = require("./b.js");`,
      `console.log(1);`,
    ]) {
      diffCheck("transformRelativeModule", code);
    }
  });

  test("replaceGlobalThisVar corpus", () => {
    diffCheck(
      "replaceGlobalThisVar",
      `globalThis._RUNTIME_.loadModule("x");`,
      "_RUNTIME_",
      {
        replacement: "globalThis._RUNTIMEabc_",
      },
    );
    diffCheck(
      "replaceGlobalThisVar",
      `globalThis._RUNTIME_.x;\nglobalThis.other.y;`,
      "_RUNTIME_",
      {
        generateUnique: true,
      },
    );
    diffCheck(
      "replaceGlobalThisVar",
      `const a = globalThis._RUNTIME_;`,
      "_RUNTIME_",
      {},
    );
  });

  test("transformImportsToLoadModule corpus", () => {
    const cases = [
      // static imports: all specifier shapes
      `import def from "./m.js";\nimport { a, b as c } from "./n.js";\nimport * as ns from "pkg";\nimport "side";\nconsole.log(def, a, c, ns);`,
      // re-export of an imported binding + local export
      `import { x } from "./m.js";\nexport { x };\nconst y = 1;\nexport { y as z };`,
      // export * from / export {} from
      `export * from "./x.js";\nexport { a, b as c } from "./y.js";`,
      // dynamic import
      `async function f() { return await import("./dyn.js"); }\nconst g = () => import("pkg2");`,
      // top-level builtin require (hoist) + nested builtin require (sync)
      `const fs = require("fs");\nfunction g() { return require("path").join("a"); }\nconsole.log(fs, g());`,
      // relative + dynamic requires
      `const u = require("./u.js");\nconst m = require(name);`,
      // import.meta
      `console.log(import.meta.url);\nconst m2 = import.meta;`,
      // shadowed import binding must NOT be rewritten
      `import { a } from "./m.js";\nfunction f(a) { return a + 1; }\nconsole.log(a, f(2));`,
      // write to import binding stays bare
      `import { a } from "./m.js";\na = 2;`,
      // non-manifest bare require
      `const z = require("some-pkg");`,
    ];
    for (const code of cases) {
      diffCheck(
        "transformImportsToLoadModule",
        "testuuid",
        code,
        "entry.js",
        null,
        {},
      );
    }
    // opts variants
    diffCheck(
      "transformImportsToLoadModule",
      "testuuid",
      `const x = require("./u.js");`,
      "entry.js",
      "parent.js",
      { preserveRequireCalls: true },
    );
    diffCheck(
      "transformImportsToLoadModule",
      "",
      `import { a } from "./m.js";\nconsole.log(a);`,
      null,
      null,
      {},
    );
  });

  test("generateImportBinding corpus", () => {
    const nodeFor = (src) =>
      parse(src, { ecmaVersion: "latest", sourceType: "module" }).body[0];
    for (const src of [
      `import * as ns from "m";`,
      `import d, { a } from "m";`,
      `import "m";`,
      `import def from "m";`,
    ]) {
      reseed();
      const a = EXTRACTED.generateImportBinding(nodeFor(src), "__lm_x");
      reseed();
      const b = originals.generateImportBinding(nodeFor(src), "__lm_x");
      expect(a).toBe(b);
    }
  });
});
