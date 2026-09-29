// Regression tests for Vitest E2E gap #0: importing production runtime.js in a
// minimal host page (no demo/playground DOM) threw at module top level:
//   1. term.open(output) with output === null (xterm throws on null)
//   2. document.getElementById('sendInput').addEventListener on null
//   3. runBtn / clearBtn .addEventListener on null
//   4. filesDiv.addEventListener on null
//   5. renderFiles(sandbox.config.fs) -> filesDiv.innerHTML on null
// Evidence: the true Vitest E2E probe's first Firefox run failed before any
// sandbox execution because the shipped runtime.js assumes the demo
// playground DOM exists.
//
// Fix contract:
//   - The playground init lives in initPlayground(), between the
//     __BVM_PLAYGROUND_BEGIN__ / __BVM_PLAYGROUND_END__ markers.
//   - A top-level guard (__bvmPlaygroundPresent) only calls initPlayground()
//     when the demo DOM (codeInput + output) is present.
//   - renderFiles() is a no-op when there is no files panel.
// Importing runtime.js in a minimal page is therefore side-effect free and
// never throws on missing elements.

import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);

const BEGIN = "// __BVM_PLAYGROUND_BEGIN__";
const GUARD_END = "// __BVM_PLAYGROUND_GUARD_END__";

function playgroundSection() {
  const a = RUNTIME_SRC.indexOf(BEGIN);
  const b = RUNTIME_SRC.indexOf(GUARD_END);
  if (a === -1 || b === -1 || b < a) {
    throw new Error(
      "playground guard markers not found in runtime.js (gap #0 not fixed)",
    );
  }
  return RUNTIME_SRC.slice(a, b + GUARD_END.length);
}

function extractFunction(src, name) {
  const marker = "function " + name + "(";
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("function not found: " + name);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces in " + name);
}

// A minimal host page: document exists, but NONE of the demo elements do.
function nullDocument() {
  return {
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: () => {
      throw new Error(
        "createElement should not run during guarded playground init",
      );
    },
  };
}

function makeElement() {
  return {
    value: "",
    textContent: "",
    innerHTML: "",
    disabled: false,
    dataset: {},
    classList: { add() {}, contains: () => false, toggle() {} },
    addEventListener() {},
    focus() {},
  };
}

describe("gap #0: playground DOM guard", () => {
  test("guard markers exist in shipped runtime.js", () => {
    expect(RUNTIME_SRC).toContain(BEGIN);
    expect(RUNTIME_SRC).toContain("// __BVM_PLAYGROUND_END__");
    expect(RUNTIME_SRC).toContain(GUARD_END);
    expect(RUNTIME_SRC).toContain("__bvmPlaygroundPresent");
    expect(RUNTIME_SRC).toContain("function initPlayground()");
  });

  test("playground section evaluates cleanly with NO demo DOM and stays dormant", () => {
    const src = playgroundSection();
    const ctx = {
      document: nullDocument(),
      Terminal: class {
        open() {
          throw new Error("Terminal.open must not run without the demo DOM");
        }
        onData() {}
      },
      filesDiv: null,
      globalThis: {},
      console,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    expect(() =>
      vm.runInContext(src, ctx, { filename: "playground-section.js" }),
    ).not.toThrow();
    expect(vm.runInContext("__bvmPlaygroundPresent", ctx)).toBe(false);
    expect(vm.runInContext("typeof initPlayground", ctx)).toBe("function");
  });

  test("initPlayground() runs cleanly when the full demo DOM is present", () => {
    const src = playgroundSection();
    const els = {};
    const document = {
      getElementById: (id) => (els[id] = els[id] || makeElement()),
      querySelectorAll: () => [],
      createElement: () => makeElement(),
    };
    const opened = [];
    const ctx = {
      document,
      Terminal: class {
        open(el) {
          opened.push(el);
        }
        onData() {}
      },
      filesDiv: makeElement(),
      sandbox: {
        invoke: async () => {},
        init: async () => {},
        execute: async () => ({ success: true }),
        requireAllowed: false,
      },
      globalThis: {},
      console,
      performance: { now: () => 0 },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: "playground-section.js" });
    expect(vm.runInContext("__bvmPlaygroundPresent", ctx)).toBe(true);
    // the guard above already ran initPlayground() once (the demo-page path)
    expect(opened.length).toBe(1);
    expect(() => vm.runInContext("initPlayground()", ctx)).not.toThrow();
    expect(opened.length).toBe(2);
  });

  test("renderFiles() is a no-op without a files panel", () => {
    const src = extractFunction(RUNTIME_SRC, "renderFiles");
    const ctx = {
      filesDiv: null,
      flattenFileTree: (x) => x,
      activeBlobUrls: [],
      URL: { revokeObjectURL() {} },
      document: nullDocument(),
      console,
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: "renderFiles.js" });
    expect(() =>
      vm.runInContext('renderFiles({ "a.js": "x" })', ctx),
    ).not.toThrow();
  });

  test("getArgv() degrades gracefully without argvInput (beforeExecute hook)", () => {
    const src = extractFunction(RUNTIME_SRC, "getArgv");
    const ctx = { document: nullDocument(), console };
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: "getArgv.js" });
    expect(vm.runInContext("getArgv()", ctx)).toBe("node script.js ");
  });
});
