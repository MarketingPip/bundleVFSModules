import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MagicString from "magic-string";
import * as acorn from "acorn";

// Regression: dynamic import() must not be lifted to a preamble top-level await.
//
// transformImportsToLoadModule lifted EVERY import-like specifier — including
// dynamic import('x') — into a preamble `const __lm_xxx = await
// loadModule(...)` that runs before any user code. For static imports that
// hoist is correct (the declaration is removed and rebound to the lifted
// var). For dynamic imports it is dead code: the in-situ call is rewritten
// to loadModule(...) and never references the lifted var, but the preamble
// await still runs first. A slow module (real vite@7: ~30 chunks through
// _dynamic_import/_build_file) stalls the whole module before the user's own
// code runs — before a drain-hold timer is even registered — so execute()
// resolves early with no output and no marker. This killed the M3
// vite.build() probe: the entire user script never ran a single line.
//
// Dynamic imports must be transformed in-situ only, with no preamble lift.
// Static imports keep their existing hoist behavior.
//
// runtime.js cannot be imported under Node (it wires a demo DOM at module
// scope), so — like tests/sync_require.test.js — these tests extract the
// exact shipped source and evaluate it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);

function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1)
    throw new Error("marker not found in runtime.js: " + marker);
  // Skip the parameter list: find its balanced closing paren first, so a
  // default like `opts = {}` doesn't end the scan early.
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
  if (depth !== 0) throw new Error("unbalanced braces extracting: " + marker);
  return src.slice(start, i + 1).replace(/^export\s+/, "");
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
    extractFunction(
      RUNTIME_SRC,
      "function generateImportBinding(node, liftedVar)",
    ) +
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

const transform = loadTransform();
const LIFT_RE =
  /const __lm_[a-z0-9]{5} = await globalThis\._RUNTIMETESTUUID_\.loadModule\(/g;

describe("dynamic import() is not lifted to a preamble await", () => {
  test("dynamic-only import emits no lifted preamble", () => {
    const code = `console.log("a");\nconst m = await import("vite");\nconsole.log("b", m);`;
    const out = transform("TESTUUID", code, "index.js").code;
    // No preamble lift for the dynamic specifier...
    expect(out).not.toMatch(LIFT_RE);
    // ...but the in-situ call is still rewritten to the sandbox loader
    // (keeping the source literal's original quoting).
    expect(out).toContain(
      `globalThis._RUNTIMETESTUUID_.loadModule("vite", 'import', "index.js", null)`,
    );
    // User code order is preserved: the first statement runs before the import.
    expect(out.indexOf('console.log("a")')).toBeLessThan(
      out.indexOf('loadModule("vite"'),
    );
  });

  test("static imports still lift (hoist) as before", () => {
    const code = `import { x } from "foo";\nconsole.log(x);`;
    const out = transform("TESTUUID", code, "index.js").code;
    const lifts = out.match(LIFT_RE) || [];
    expect(lifts.length).toBe(1);
    expect(out).toContain('loadModule("foo", "import", "index.js", null)');
    // Live bindings (2026-10-09): named imports no longer destructure
    // (`const { x } = __lm_…` was a snapshot); references compile to live
    // member access on the lifted namespace.
    expect(out).not.toMatch(/const \{ x \} = __lm_[a-z0-9]{5};/);
    expect(out).toMatch(/console\.log\(__lm_[a-z0-9]{5}\.x\);/);
  });

  test("mixed static + dynamic: only the static import lifts", () => {
    const code = `import { x } from "foo";\nconst m = await import("bar");\nconsole.log(x, m);`;
    const out = transform("TESTUUID", code, "index.js").code;
    const lifts = out.match(LIFT_RE) || [];
    expect(lifts.length).toBe(1);
    expect(out).toContain('loadModule("foo", "import", "index.js", null)');
    expect(out).toContain(`loadModule("bar", 'import', "index.js", null)`);
  });
});
