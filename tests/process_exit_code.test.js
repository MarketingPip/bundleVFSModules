// Regression tests for Vitest E2E gap #7: `process.exit(code)` did not
// propagate the exit code into the execute() result. The probe recorded:
//   process.exit(42) -> execute() resolves
//     { success: true, logs: ["Process Exited"], executionTime }
// with no exit-code field anywhere in the result.
//
// The break is in two places in runtime.js:
//   1. Sandbox side (inlined process shim, `rawMethods.exit`): posts
//      { type: 'kill', logs, executionTime } with NO exitCode.
//   2. Host side (ExecutionContext message handler, data.type === 'kill'):
//      resolves { success, error, logs, executionTime } with NO exitCode.
//
// Fix contract:
//   - The sandbox 'kill' postMessage carries exitCode: <the code passed to
//     process.exit()> (default 0).
//   - The host 'kill' handler resolves results.exitCode from the message
//     (null when the message carries none).
//
// Both tests below execute the REAL code extracted from runtime.js inside
// node:vm with mocked surroundings (same pattern as
// tests/playground_dom_guard.test.js).
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
// The sandbox template now lives in src/sandbox-template.js (built from
// src/sandbox/*.js). TEMPLATE_SRC is the decoded template value.
const TEMPLATE_SRC = JSON.parse(
  fs
    .readFileSync(
      path.join(__dirname, "..", "src", "sandbox-template.js"),
      "utf8",
    )
    .match(/export const SANDBOX_TEMPLATE = (".*");/s)[1],
);


// Extract a brace-balanced block starting at the opening brace index.
function balanced(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  let quote = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  throw new Error("unbalanced braces");
}

// The real sandbox-side exit: `async exit(code = 0) { ... }` inside rawMethods.
function sandboxExitFn() {
  const anchor = "async exit(code = 0) {";
  const idx = TEMPLATE_SRC.indexOf(anchor);
  if (idx === -1)
    throw new Error("sandbox exit() not found in template (moved?)");
  return balanced(TEMPLATE_SRC, idx + anchor.length - 1);
}

// The real host-side 'kill' handler block.
function hostKillBlock() {
  // NOTE: matched with a whitespace/quote-tolerant regex so prettier
  // reformatting (else-if spacing, quote style) cannot break the pin.
  const anchorRe =
    /}\s*else\s*if\s*\(\s*data\.type\s*===\s*["']kill["']\s*\)\s*{/;
  const m = anchorRe.exec(RUNTIME_SRC);
  if (!m)
    throw new Error("host 'kill' handler not found in runtime.js (moved?)");
  return balanced(RUNTIME_SRC, m.index + m[0].length - 1);
}

describe("gap #7: process.exit(code) propagates through the kill message", () => {
  test("sandbox exit(42) posts { type: 'kill', exitCode: 42 }", async () => {
    const posted = [];
    const ctx = {
      emit: () => {},
      _intervalId: null,
      clearInterval: () => {},
      performance: { now: () => 1000 },
      startTime: 900,
      logs: ["hello"],
      window: { parent: { postMessage: (msg) => posted.push(msg) } },
    };
    vm.createContext(ctx);
    vm.runInContext(
      `const rawMethods = { async exit(code = 0) ${sandboxExitFn()} };`,
      ctx,
    );
    await vm.runInContext("rawMethods.exit(42)", ctx);
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("kill");
    expect(posted[0].exitCode).toBe(42);
  });

  test("sandbox exit() with no code posts exitCode 0", async () => {
    const posted = [];
    const ctx = {
      emit: () => {},
      _intervalId: null,
      clearInterval: () => {},
      performance: { now: () => 1000 },
      startTime: 900,
      logs: [],
      window: { parent: { postMessage: (msg) => posted.push(msg) } },
    };
    vm.createContext(ctx);
    vm.runInContext(
      `const rawMethods = { async exit(code = 0) ${sandboxExitFn()} };`,
      ctx,
    );
    await vm.runInContext("rawMethods.exit()", ctx);
    expect(posted).toHaveLength(1);
    expect(posted[0].exitCode).toBe(0);
  });
});

describe("gap #7: host 'kill' handler resolves exitCode into execute() results", () => {
  function runKillHandler(data) {
    let resolved;
    const mockThis = {
      resolved: false,
      killed: false,
      cleanup: () => {},
      sandbox: { emit: () => {} },
    };
    const ctx = {
      data,
      resolve: (r) => {
        resolved = r;
      },
      __this: mockThis,
    };
    vm.createContext(ctx);
    // The extracted block uses `this.` and `resolve(`; run it as the body of
    // a function invoked with the mocked receiver.
    vm.runInContext(
      `const __handleKill = function(data, resolve) ${hostKillBlock()};` +
        `\n__handleKill.call(__this, data, resolve);`,
      ctx,
    );
    return { resolved, mockThis };
  }

  test("results carry exitCode from the kill message", () => {
    const { resolved } = runKillHandler({
      type: "kill",
      logs: ["hi"],
      executionTime: 1.5,
      exitCode: 42,
    });
    expect(resolved.success).toBe(true);
    expect(resolved.logs).toEqual(["hi", "Process Exited"]);
    expect(resolved.exitCode).toBe(42);
  });

  test("results.exitCode is null when the message carries none", () => {
    const { resolved } = runKillHandler({
      type: "kill",
      logs: [],
      executionTime: 1.5,
    });
    expect(resolved.success).toBe(true);
    expect(resolved.exitCode).toBeNull();
  });
});
