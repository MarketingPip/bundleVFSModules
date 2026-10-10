import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MagicString from "magic-string";
import * as acorn from "acorn";

// Live ESM bindings (2026-10-09): named/default imports compile to live
// member access (`__lm_N.x`) instead of snapshotting (`const { x } = __lm`),
// and the interop proxy reads from the real (frozen, live) ESM namespace
// instead of its load-time copy. Re-exports (`export { x } from './m'` and
// `export { x }` where x is imported) are live via `__bvm_reexp_*` markers.
//
// runtime.js cannot be imported under Node (it wires a demo DOM at module
// scope), so — like tests/sync_require.test.js — these tests extract the
// exact shipped source and evaluate it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);
const SANDBOX_SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "sandbox", "21-sync-require.js"),
  "utf8",
);

function functionEnd(src, start) {
  let p = src.indexOf("(", start);
  let pdepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === "(") pdepth++;
    else if (src[p] === ")") {
      pdepth--;
      if (pdepth === 0) break;
    }
  }
  let i = src.indexOf("{", p);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error("unbalanced braces in extraction");
  return i + 1;
}

function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("marker not found: " + marker);
  return src.slice(start, functionEnd(src, start)).replace(/^export\s+/, "");
}

// Minimal walk.simple mirroring acorn-walk's contract (visit every node,
// dispatch on node.type). The transform attaches parents itself before
// walking, so we only need to avoid following the 'parent' links back up.
const walk = {
  simple(ast, visitors) {
    const seen = new Set();
    (function visit(node) {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (node.type && typeof visitors[node.type] === "function")
        visitors[node.type](node);
      for (const k of Object.keys(node)) {
        if (k === "parent") continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach(visit);
        else visit(v);
      }
    })(ast);
  },
};

function loadTransform() {
  const code =
    "const _builtinManifest = { fs: 'fs.js' };\n" +
    extractFunction(RUNTIME_SRC, "function generateImportBinding(node, liftedVar)") +
    "\n" +
    extractFunction(RUNTIME_SRC, "function transformImportsToLoadModule(");
  const factory = new Function(
    "MagicString",
    "acorn",
    "walk",
    code + "\nreturn { transformImportsToLoadModule };",
  );
  return factory(MagicString, acorn, walk).transformImportsToLoadModule;
}

function loadBuildModuleProxy() {
  const code = extractFunction(SANDBOX_SRC, "function buildModuleProxy(");
  return new Function(`${code}; return buildModuleProxy;`)();
}

const transform = loadTransform();
const buildModuleProxy = loadBuildModuleProxy();

// Node caches data: URL modules by URL string: identical bodies across
// tests would share one module instance (and its `export let` state).
// Prefix every body with a unique comment so each import is a fresh module.
let _dataUrlSeq = 0;
function dataUrl(body) {
  _dataUrlSeq++;
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(`//livebind-${_dataUrlSeq}\n${body}`)}`;
}

// The lifted var name is random per transform; normalize it for assertions.
function liftOf(out, source) {
  const m = out.match(
    new RegExp(`const (__lm_[a-z0-9]{5}) = await globalThis\\._RUNTIMETESTUUID_\\.loadModule\\(${JSON.stringify(source)}`),
  );
  if (!m) throw new Error("no lifted var for " + source + " in:\n" + out);
  return m[1];
}

describe("transform: named/default imports become live member access", () => {
  test("no destructuring; references rewritten to liftedVar.importedName", () => {
    const out = transform(
      "TESTUUID",
      `import { count, bump } from './counter.js';\nconsole.log(count);\nbump();\nconsole.log(count);`,
      "entry.js",
    ).code;
    const lm = liftOf(out, "./counter.js");
    expect(out).not.toMatch(/const \{[^}]*\} = __lm_/);
    expect(out).toContain(`console.log(${lm}.count);`);
    expect(out).toContain(`(0, ${lm}.bump)();`);
  });

  test("default import references become liftedVar.default", () => {
    const out = transform(
      "TESTUUID",
      `import d from './def.js';\nconsole.log(d);\nd();`,
      "entry.js",
    ).code;
    const lm = liftOf(out, "./def.js");
    expect(out).not.toMatch(/const \{[^}]*\} = __lm_/);
    expect(out).not.toContain(`const d = ${lm}.default;`);
    expect(out).toContain(`console.log(${lm}.default);`);
    expect(out).toContain(`(0, ${lm}.default)();`);
  });

  test("namespace import keeps `const ns = __lm` (unchanged)", () => {
    const out = transform(
      "TESTUUID",
      `import * as ns from './ns.js';\nns.foo();`,
      "entry.js",
    ).code;
    const lm = liftOf(out, "./ns.js");
    expect(out).toContain(`const ns = ${lm};`);
    expect(out).toContain(`ns.foo();`);
  });

  test("shadowed locals are NOT rewritten", () => {
    const out = transform(
      "TESTUUID",
      `import { x } from './m.js';\nconsole.log(x);\nfunction f(x) { return x + 1; }\n{\n  let x = 10;\n  console.log(x);\n}\nfunction g() { var x = 3; return x; }`,
      "entry.js",
    ).code;
    const lm = liftOf(out, "./m.js");
    // The module-scope reference is live...
    expect(out).toContain(`console.log(${lm}.x);`);
    // ...but the parameter, block-let and hoisted-var shadows are untouched.
    expect(out).toContain(`function f(x) { return x + 1; }`);
    expect(out).toContain(`let x = 10;\n  console.log(x);`);
    expect(out).toContain(`function g() { var x = 3; return x; }`);
  });

  test("shorthand property becomes explicit (no invalid `{ __lm.x }`)", () => {
    const out = transform(
      "TESTUUID",
      `import { x } from './m.js';\nconst o = { x };`,
      "entry.js",
    ).code;
    const lm = liftOf(out, "./m.js");
    expect(out).toContain(`const o = { x: ${lm}.x };`);
  });

  test("member-expression properties and non-computed keys are untouched", () => {
    const out = transform(
      "TESTUUID",
      `import { x } from './m.js';\nconst o = { x: 1 };\nconsole.log(o.x, x.y, o[x]);`,
      "entry.js",
    ).code;
    const lm = liftOf(out, "./m.js");
    expect(out).toContain(`const o = { x: 1 };`);
    expect(out).toContain(`console.log(o.x, ${lm}.x.y, o[${lm}.x]);`);
  });

  test("direct calls use the (0, ...) indirect form (this stays undefined)", () => {
    const out = transform(
      "TESTUUID",
      `import { fn } from './m.js';\nfn(1);\nnew fn(2);`,
      "entry.js",
    ).code;
    const lm = liftOf(out, "./m.js");
    expect(out).toContain(`(0, ${lm}.fn)(1);`);
    // `new` keeps the plain member access (construct, not call).
    expect(out).toContain(`new ${lm}.fn(2);`);
  });

  test("assignment/update targets are left alone (invalid ESM still throws)", () => {
    const out = transform(
      "TESTUUID",
      `import { x } from './m.js';\nx = 5;\nx++;`,
      "entry.js",
    ).code;
    expect(out).toContain(`x = 5;`);
    expect(out).toContain(`x++;`);
  });

  test("side-effect-only import emits no binding", () => {
    const out = transform(
      "TESTUUID",
      `import './m.js';\nconsole.log('hi');`,
      "entry.js",
    ).code;
    const lm = liftOf(out, "./m.js");
    expect(out).not.toMatch(new RegExp(`const .* = ${lm};`));
  });
});

describe("transform: re-exports are live markers, not destructures", () => {
  test("export { x } from './m' emits a __bvm_reexp_ marker", () => {
    const out = transform(
      "TESTUUID",
      `export { count, bump as b2 } from './counter.js';`,
      "entry.js",
    ).code;
    const lm = liftOf(out, "./counter.js");
    expect(out).not.toMatch(/export const \{[^}]*\} = __lm_/);
    expect(out).toContain(
      `export const __bvm_reexp_0 = { "count": [${lm}, "count"], "b2": [${lm}, "bump"] };`,
    );
  });

  test("export { x } (no source, x imported) becomes a live marker", () => {
    const out = transform(
      "TESTUUID",
      `import { x } from './m.js';\nconst y = 1;\nexport { x, y };`,
      "entry.js",
    ).code;
    const lm = liftOf(out, "./m.js");
    expect(out).toContain(`export { y };`);
    expect(out).toContain(
      `export const __bvm_reexp_0 = { "x": [${lm}, "x"] };`,
    );
  });

  test("export { y } (no source, y local) is left as-is", () => {
    const out = transform(
      "TESTUUID",
      `const y = 1;\nexport { y };`,
      "entry.js",
    ).code;
    expect(out).toContain(`export { y };`);
    expect(out).not.toContain(`__bvm_reexp_`);
  });

  test("export * from keeps the __bvm_star_ marker (unchanged)", () => {
    const out = transform(
      "TESTUUID",
      `export * from './m.js';`,
      "entry.js",
    ).code;
    const lm = liftOf(out, "./m.js");
    expect(out).toContain(`export const __bvm_star_0 = ${lm};`);
  });
});

describe("proxy: reads are live from the real namespace", () => {
  test("export let reassignment is visible (old snapshot behavior is gone)", async () => {
    const data = await import(
      dataUrl(`export let count = 0; export function bump() { count++; }`)
    );
    const mod = buildModuleProxy(data, "/c.js", "/c.js", "import");
    expect(mod.count).toBe(0);
    mod.bump();
    expect(mod.count).toBe(1);
    mod.bump();
    expect(mod.count).toBe(2);
  });

  test("live default binding via `export { v as default }`", async () => {
    const data = await import(
      dataUrl(
        `let v = 1; export { v as default }; export function setV(x) { v = x; }`,
      )
    );
    const mod = buildModuleProxy(data, "/d.js", "/d.js", "import");
    expect(mod.default).toBe(1);
    mod.setV(42);
    expect(mod.default).toBe(42);
  });

  test("PRESERVED QUIRK: falsy .default falls back to the whole namespace", async () => {
    // Intentional, documented in docs/RUNTIME.md — do not "fix" this test.
    // The quirk returns the namespace object (the proxy target copy), not
    // the falsy default value.
    for (const falsy of ["0", "''", "null", "undefined"]) {
      const data = await import(dataUrl(`export default ${falsy}; export const a = 1;`));
      const mod = buildModuleProxy(data, "/f.js", "/f.js", "import");
      expect(mod.default).not.toBe(0);
      expect(mod.default).not.toBe("");
      expect(mod.default).not.toBeNull();
      expect(mod.default).not.toBeUndefined();
      expect(typeof mod.default).toBe("object");
      expect(mod.default.a).toBe(1);
    }
    // ...but a truthy default is read live.
    const data = await import(dataUrl(`export default 7;`));
    const mod = buildModuleProxy(data, "/t.js", "/t.js", "import");
    expect(mod.default).toBe(7);
  });

  test("__esModule / then-guard / missing-export semantics preserved", async () => {
    const data = await import(dataUrl(`export const a = 1;`));
    const mod = buildModuleProxy(data, "/s.js", "/s.js", "import");
    expect(mod.__esModule).toBe(true);
    expect(mod.then).toBeUndefined();
    expect(() => mod.nope).toThrow(SyntaxError);
    expect(() => mod.nope).toThrow(
      "does not provide an export named 'nope'",
    );
    expect(String(mod)).toContain("Module");
  });

  test("CJS named-import fallback reads module.exports live", async () => {
    // A CJS module mutating its own exports object: the fallback must see
    // the current value, not the load-time copy.
    const data = await import(
      dataUrl(
        `const exp = { n: 1 };` +
          `exp.bump = () => { exp.n++; };` +
          `export default exp;` +
          `export const __bvm_cjs__ = true;`,
      )
    );
    const mod = buildModuleProxy(data, "/cjs.js", "/cjs.js", "import");
    expect(mod.n).toBe(1);
    mod.bump();
    expect(mod.n).toBe(2);
  });

  test("star re-export fallback reads live through the star source", async () => {
    const innerData = await import(
      dataUrl(`export let v = 1; export function inc() { v++; }`)
    );
    const inner = buildModuleProxy(innerData, "/inner.js", "/inner.js", "import");
    // Simulate what the transform emits: the __bvm_star_0 marker holds the
    // live proxy of the star source (here as a plain object standing in for
    // the namespace — the proxy only needs the marker key).
    const outer = buildModuleProxy(
      { __bvm_star_0: inner, own: "mine" },
      "/outer.js",
      "/outer.js",
      "import",
    );
    expect(outer.own).toBe("mine");
    expect(outer.v).toBe(1);
    inner.inc();
    expect(outer.v).toBe(2);
    expect(() => outer.missing).toThrow(SyntaxError);
  });

  test("re-export marker resolves live through the source namespace", async () => {
    // End-to-end for `export { count } from '/c.js'`: transform the
    // re-exporter, load it through a mock loadModule (faithful: the real
    // loader wraps every module in buildModuleProxy), and observe liveness.
    const UUID = "livereexp";
    const counterSrc = `export let count = 0; export function bump() { count++; }`;
    const counterUrl = dataUrl(counterSrc);
    const counterNs = await import(counterUrl);
    const reSrc = transform(
      UUID,
      `export { count } from '/c.js';`,
      "/re.js",
    ).code;
    expect(reSrc).toContain("__bvm_reexp_");
    globalThis[`_RUNTIME${UUID}_`] = {
      loadModule: async () =>
        buildModuleProxy(counterNs, "/c.js", "/c.js", "import"),
    };
    try {
      const reNs = await import(dataUrl(reSrc));
      const mod = buildModuleProxy(reNs, "/re.js", "/re.js", "import");
      expect(mod.count).toBe(0);
      counterNs.bump();
      counterNs.bump();
      expect(mod.count).toBe(2);
      // The marker itself is hidden from the visible namespace.
      expect("count" in mod && Object.keys(mod).includes("__bvm_reexp_0")).toBe(false);
      expect(Object.keys(mod).some((k) => k.startsWith("__bvm_reexp_"))).toBe(false);
    } finally {
      delete globalThis[`_RUNTIME${UUID}_`];
    }
  });
});

describe("pipeline: cross-module liveness through transform + proxy", () => {
  // Faithful mock of the sandbox loadModule: every module is wrapped in
  // buildModuleProxy, exactly like src/sandbox/20-module-loader.js does.
  async function loadViaPipeline(files, entryPath) {
    const UUID = "livepipe";
    const cache = new Map();
    async function mockLoadModule(specifier, _type, entryPoint) {
      const resolved = specifier; // absolute VFS paths in these fixtures
      void entryPoint;
      if (cache.has(resolved)) return cache.get(resolved);
      const src = files[resolved];
      if (src === undefined)
        throw new Error(`[ERR_MODULE_NOT_FOUND]: Cannot find module ${specifier}`);
      const { code } = transform(UUID, src, resolved, entryPath, {});
      const ns = await import(
        dataUrl(code),
      );
      const proxied = buildModuleProxy(ns, resolved, resolved, "import");
      cache.set(resolved, proxied);
      return proxied;
    }
    globalThis[`_RUNTIME${UUID}_`] = { loadModule: mockLoadModule };
    try {
      const { code } = transform(UUID, files[entryPath], entryPath, entryPath, {});
      const data = await import(
        dataUrl(code),
      );
      return buildModuleProxy(data, entryPath, entryPath, "import");
    } finally {
      delete globalThis[`_RUNTIME${UUID}_`];
    }
  }

  test("named import sees reassignment: direct, cross-module, and re-export", async () => {
    const mod = await loadViaPipeline(
      {
        "/c.js": `export let count = 0; export function bump() { count++; }`,
        "/r.js": `import { count } from '/c.js';\nexport const read = () => count;`,
        "/re.js": `export { count } from '/c.js';`,
        "/e.js": [
          `import { count, bump } from '/c.js';`,
          `import { read } from '/r.js';`,
          `import { count as rc } from '/re.js';`,
          `export function run() {`,
          `  const before = count;`,
          `  bump(); bump();`,
          `  return [before, count, read(), rc];`,
          `}`,
        ].join("\n"),
      },
      "/e.js",
    );
    // Old snapshot behavior would yield [0, 0, 0, 0]; live yields:
    expect(mod.run()).toEqual([0, 2, 2, 2]);
  });

  test("default import is live; namespace import is live", async () => {
    const mod = await loadViaPipeline(
      {
        "/d.js": `let v = 10;\nexport { v as default };\nexport function setV(x) { v = x; }`,
        "/e.js": [
          `import d, { setV } from '/d.js';`,
          `import * as ns from '/d.js';`,
          `export function run() {`,
          `  const before = [d, ns.default];`,
          `  setV(99);`,
          `  return [before, d, ns.default];`,
          `}`,
        ].join("\n"),
      },
      "/e.js",
    );
    expect(mod.run()).toEqual([[10, 10], 99, 99]);
  });

  test("this stays undefined for direct calls of imported functions", async () => {
    const mod = await loadViaPipeline(
      {
        "/t.js": `export function who() { return this; }`,
        "/e.js": `import { who } from '/t.js';\nexport const run = () => who();`,
      },
      "/e.js",
    );
    // ESM call semantics: `this` is undefined, not the interop proxy.
    // (The entry module is sloppy-mode via data: URL? No — data: URL
    // modules are always strict, so `this` is undefined, not globalThis.)
    expect(mod.run()).toBeUndefined();
  });
});
