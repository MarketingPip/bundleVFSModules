// tests/helpers/build-runtime-probe.mjs — child-process behavioral probe for
// the build-runtime differential test.
//
// Why a child process: the built runtime.js targets the browser (its static
// imports use https://esm.sh/… specifiers), and Node can only import those
// via module.register() customization hooks — which Jest explicitly forbids
// inside its sandboxed loader. So the Jest test spawns plain `node` (where
// the hooks work fine) to import the bundle and run the behavioral battery.
//
// Usage: node tests/helpers/build-runtime-probe.mjs <built-runtime.js>
// Prints JSON: { checks: [{ name, pass, detail? }] }. Exit 0 iff all pass.

import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "acorn";

const builtFile = process.argv[2];
if (!builtFile) {
  console.error("usage: build-runtime-probe.mjs <built-runtime.js>");
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..");

register(pathToFileURL(path.join(here, "esm-sh-resolve-hook.mjs")).href);

const built = await import(pathToFileURL(builtFile).href);
const load = (m) =>
  import(pathToFileURL(path.join(repoRoot, "src", "runtime", m)).href);
const mod = {
  "transforms-esm": await load("transforms-esm.js"),
  "transforms-cjs": await load("transforms-cjs.js"),
  "transforms-imports": await load("transforms-imports.js"),
  "host-utils": await load("host-utils.js"),
  transpile: await load("transpile.js"),
  syntax: await load("syntax.js"),
  events: await load("events.js"),
};
// syntax.js references the monolith-scope `acorn` free identifier; mirror
// the module tests' documented globalThis injection for the module side.
globalThis.acorn = await import("acorn");

const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, pass: true, ...(detail ? { detail } : {}) });
  } catch (err) {
    checks.push({
      name,
      pass: false,
      detail: String((err && err.message) || err).slice(0, 300),
    });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
// fnBuilt/fnModule must agree byte-for-byte (throws normalized).
function agree(name, fnBuilt, fnModule) {
  check(name, () => {
    let a,
      b,
      ea = null,
      eb = null;
    try {
      a = fnBuilt();
    } catch (e) {
      ea = `${e.constructor.name}: ${e.message}`;
    }
    try {
      b = fnModule();
    } catch (e) {
      eb = `${e.constructor.name}: ${e.message}`;
    }
    const x = ea ? `THROW:${ea}` : JSON.stringify(a);
    const y = eb ? `THROW:${eb}` : JSON.stringify(b);
    assert(x === y, `built=${x.slice(0, 200)} module=${y.slice(0, 200)}`);
  });
}

const importNode = (src) =>
  parse(src, { ecmaVersion: "latest", sourceType: "module" }).body[0];
const esmSrc = `import { readFile } from "fs";\nimport path from "path";\nexport const x = 1;\nexport default function main() { return x; }\n`;
const cjsSrc = `const fs = require("fs");\nconst { join } = require("path");\nmodule.exports = { a: 1 };\nexports.b = 2;\n`;

agree(
  "convertEsmToCjs",
  () => built.convertEsmToCjs(esmSrc),
  () => mod["transforms-esm"].convertEsmToCjs(esmSrc),
);
agree(
  "convertCjsToEsm",
  () => built.convertCjsToEsm(cjsSrc),
  () => mod["transforms-cjs"].convertCjsToEsm(cjsSrc),
);
agree(
  "convertCjsToEsm_backup",
  () => built.convertCjsToEsm_backup(cjsSrc),
  () => mod["transforms-cjs"].convertCjsToEsm_backup(cjsSrc),
);
agree(
  "isCommonJS",
  () => built.isCommonJS(cjsSrc),
  () => mod["transforms-cjs"].isCommonJS(cjsSrc),
);
agree(
  "detectModuleSystem",
  () => built.detectModuleSystem(esmSrc),
  () => mod["transforms-cjs"].detectModuleSystem(esmSrc),
);
agree(
  "transformRelativeModule",
  () => built.transformRelativeModule(`require("./x")`),
  () => mod["transforms-cjs"].transformRelativeModule(`require("./x")`),
);
agree(
  "replaceGlobalThisVar",
  () =>
    built.replaceGlobalThisVar(`globalThis._RUNTIME_foo.bar()`, "_RUNTIME_"),
  () =>
    mod["transforms-imports"].replaceGlobalThisVar(
      `globalThis._RUNTIME_foo.bar()`,
      "_RUNTIME_",
    ),
);
agree(
  "generateImportBinding(namespace)",
  () =>
    built.generateImportBinding(
      importNode(`import * as ns from "m";`),
      "__lm_1",
    ),
  () =>
    mod["transforms-imports"].generateImportBinding(
      importNode(`import * as ns from "m";`),
      "__lm_1",
    ),
);
agree(
  "generateImportBinding(named)",
  () =>
    built.generateImportBinding(
      importNode(`import d, { a } from "m";`),
      "__lm_1",
    ),
  () =>
    mod["transforms-imports"].generateImportBinding(
      importNode(`import d, { a } from "m";`),
      "__lm_1",
    ),
);
agree(
  "transformImportsToLoadModule",
  () => built.transformImportsToLoadModule(`import x from "./y.js";`, {}),
  () =>
    mod["transforms-imports"].transformImportsToLoadModule(
      `import x from "./y.js";`,
      {},
    ),
);
const tree = { a: { b: "x" }, c: new Uint8Array([1, 2, 3]) };
agree(
  "flattenFileTree",
  () => built.flattenFileTree(tree),
  () => mod["host-utils"].flattenFileTree(tree),
);
agree(
  "seedBytesToBase64",
  () => built.seedBytesToBase64(new Uint8Array([104, 105])),
  () => mod["host-utils"].seedBytesToBase64(new Uint8Array([104, 105])),
);
const tsSrc = `const x: number = 1;\nexport { x };`;
agree(
  "transpileTypeScript",
  () => built.transpileTypeScript(tsSrc),
  () => mod["transpile"].transpileTypeScript(tsSrc),
);
agree(
  "SyntaxChecker.check(valid)",
  () => new built.SyntaxChecker().check("const x = 1;"),
  () => new mod["syntax"].SyntaxChecker().check("const x = 1;"),
);
agree(
  "SyntaxChecker.check(invalid)",
  () => new built.SyntaxChecker().check("const x = ;"),
  () => new mod["syntax"].SyntaxChecker().check("const x = ;"),
);
agree(
  "EventEmitter",
  () => {
    const e = new built.EventEmitter();
    let g = null;
    e.on("ping", (d) => {
      g = d;
    });
    e.emit("ping", 42);
    return g;
  },
  () => {
    const e = new mod["events"].EventEmitter();
    let g = null;
    e.on("ping", (d) => {
      g = d;
    });
    e.emit("ping", 42);
    return g;
  },
);

check("bundle evaluates without ReferenceError", () => {
  assert(typeof built.CodeSandbox === "function", "CodeSandbox missing");
});
check("CodeSandbox extends bundled EventEmitter (real shared scope)", () => {
  assert(
    built.CodeSandbox.prototype instanceof built.EventEmitter,
    "not instanceof",
  );
});
check("expected classes/functions are present", () => {
  for (const n of [
    "ExecutionContext",
    "ImportResolver",
    "CodeTransformer",
    "SandboxRuntime",
    "__parseStackLocationFn",
    "executeCode",
    "createSandbox",
    "toNodeKeypress",
    "stripAnsi",
    "mergeProcess",
    "normalizeBuiltinSpecifier",
    "loadBuiltin",
    "fetchBuiltinSource",
  ])
    assert(typeof built[n] === "function", `${n} is ${typeof built[n]}`);
});
check("builtinModules is the real manifest-backed list", () => {
  assert(
    Array.isArray(built.builtinModules) && built.builtinModules.length > 50,
    "too short",
  );
  assert(built.builtinModules.includes("fs"), "missing fs");
  assert(built.builtinModules.includes("_http_agent"), "missing _http_agent");
});
check("COOKIE_JAR_IIFE inlined", () => {
  assert(
    typeof built.COOKIE_JAR_IIFE === "string" &&
      built.COOKIE_JAR_IIFE.includes("__cookieJarLib"),
  );
});
check("memfsFs export alias works", () => {
  assert(built.memfsFs !== undefined, "memfsFs undefined");
});
check("no test-only setBuiltinManifest export", () => {
  assert(built.setBuiltinManifest === undefined, "setBuiltinManifest leaked");
});

console.log(JSON.stringify({ checks }));
process.exit(checks.every((c) => c.pass) ? 0 : 1);
