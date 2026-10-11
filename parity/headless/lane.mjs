#!/usr/bin/env node
// parity/headless/lane.mjs — pure helpers for the headless parity lane.
// Unit-tested by tests/headless-parity.test.js (expectation selection,
// report shape). No side effects on import.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const parityDir = path.resolve(__dirname, "..");

/** Lane -> expectations file (mirrors run.mjs's lane selection). */
export function expectedFailuresPath(lane) {
  const files = {
    shim: "expected-failures.shim.json",
    native: "expected-failures.json",
    headless: "expected-failures.headless.json",
  };
  if (!files[lane]) throw new Error(`unknown parity lane: ${lane}`);
  return path.join(parityDir, files[lane]);
}

/** Node's test files declare required CLI flags via `// Flags: ...`. */
export function extractFlags(testFile) {
  const head = fs
    .readFileSync(testFile, "utf8")
    .split("\n", 20)
    .join("\n");
  const m = head.match(/^\/\/ Flags:\s*(.+)$/m);
  return m ? m[1].trim().split(/\s+/) : [];
}

/**
 * Wrap a test file for the headless sandbox.
 *
 * - require("../common") is stubbed (the real test/common uses Node
 *   internals that cannot load in the sandbox) — same stub as the browser
 *   lane's transformForBrowser.
 * - The body runs inside try/catch and reports via a __RESULT__ console
 *   marker, so skips (common.skip -> TEST_SKIP) report as skipped, not
 *   failed — the same contract as parity/real-runtime.html.
 * - Top-level static imports are left in place: the host's ImportResolver
 *   extracts them into the %%IMPORTS%% preamble (like execute() does).
 */
const COMMON_STUB = `const __headlessStubState = { warnings: [], warnHook: false, mustCalls: [] };
function __headlessMustCallWrap(fn, criteria, field) {
  if (typeof fn === "number") { criteria = fn; fn = () => {}; }
  else if (fn === undefined) { fn = () => {}; }
  const ctx = { field, criteria, actual: 0 };
  __headlessStubState.mustCalls = __headlessStubState.mustCalls || [];
  __headlessStubState.mustCalls.push(ctx);
  return function (...args) { ctx.actual++; return fn.apply(this, args); };
}
const common = {
  isWindows: false,
  platform: "linux",
  skip(msg) { const e = new Error("SKIP: " + msg); e.code = "TEST_SKIP"; throw e; },
  // Portable subset of test/common's invalidArgTypeHelper (enough for the
  // message-shape assertions; the real one uses util.inspect).
  invalidArgTypeHelper(input) {
    if (input == null) return " Received " + input;
    if (typeof input === "function") return " Received function " + input.name;
    if (typeof input === "object") {
      const name = input.constructor && input.constructor.name;
      return name && name !== "Object"
        ? " Received an instance of " + name
        : " Received " + JSON.stringify(input);
    }
    const inspected =
      typeof input === "string" ? "'" + input + "'" : String(input);
    return " Received type " + typeof input + " (" + inspected + ")";
  },
  // Portable subset of test/common's expectWarning: wraps the sandbox
  // process.emitWarning, records emissions, and verifies expectations when
  // the harness calls __verifyWarnings() before reporting __RESULT__.
  expectWarning(name, message, code) {
    const list = Array.isArray(name) ? name : [[name, message, code]];
    __headlessStubState.warnings = __headlessStubState.warnings || [];
    for (const [n, m, c] of list) {
      __headlessStubState.warnings.push({ name: n, message: m, code: c, seen: false });
    }
    if (!__headlessStubState.warnHook) {
      __headlessStubState.warnHook = true;
      const state = __headlessStubState;
      const orig =
        process.emitWarning && process.emitWarning.bind(process);
      process.emitWarning = function (msg, type, c) {
        const msgStr = String(msg && msg.message ? msg.message : msg);
        const wCode = type && typeof type === "object" ? type.code : c;
        for (const exp of state.warnings || []) {
          if (
            !exp.seen &&
            exp.code === wCode &&
            (exp.message === undefined || exp.message === msgStr)
          ) {
            exp.seen = true;
          }
        }
        return orig ? orig(msg, type, c) : undefined;
      };
    }
  },
  __verifyWarnings() {
    const missing = (__headlessStubState.warnings || []).filter((e) => !e.seen);
    if (missing.length) {
      throw new Error(
        "Expected warnings not emitted: " +
          JSON.stringify(missing.map((e) => e.code)),
      );
    }
  },
  // Portable subset of test/common's mustCall family: counts invocations and
  // verifies them when the harness calls __verifyMustCalls() before
  // reporting __RESULT__ (the real one verifies on process 'exit').
  mustCall(fn, exact) {
    return __headlessMustCallWrap(fn, exact === undefined ? 1 : exact, "exact");
  },
  mustCallAtLeast(fn, minimum) {
    return __headlessMustCallWrap(fn, minimum === undefined ? 1 : minimum, "minimum");
  },
  mustNotCall(msg) {
    return () => {
      throw new Error(msg || "mustNotCall called");
    };
  },
  __verifyMustCalls() {
    for (const c of __headlessStubState.mustCalls || []) {
      const ok =
        c.field === "exact" ? c.actual === c.criteria : c.actual >= c.criteria;
      if (!ok) {
        throw new Error(
          "mustCall " + c.field + " " + c.criteria +
            " failed: called " + c.actual + " time(s)",
        );
      }
    }
  },
  // Portable subset of test/common's expectsError: validates err against a
  // {code, type, message, name} validator (or predicate function).
  expectsError(validator, exact) {
    return __headlessMustCallWrap(
      (err) => {
      if (validator && typeof validator === "object") {
        if (validator.code !== undefined && err.code !== validator.code) {
          throw new Error("expected code " + validator.code + ", got " + err.code);
        }
        if (validator.type !== undefined && !(err instanceof validator.type)) {
          throw new Error("expected error type mismatch");
        }
        if (validator.name !== undefined && err.name !== validator.name) {
          throw new Error("expected name " + validator.name + ", got " + err.name);
        }
        if (validator.message !== undefined) {
          const m = validator.message;
          const ok =
            m instanceof RegExp ? m.test(err.message) : err.message === m;
          if (!ok) throw new Error("message mismatch: " + err.message);
        }
      } else if (typeof validator === "function") {
        if (!validator(err)) throw new Error("validator function returned false");
      }
      return true;
      },
      exact,
      "exact",
    );
  },
  // The real platformTimeout scales for slow CI; the sandbox is fast.
  platformTimeout(ms) {
    return ms;
  },
  hasCrypto: true,
  enoughTestMem: true,
  // The sandbox has extra globals by design; the real allowGlobals whitelists
  // for Node's leak detector, which doesn't run here.
  allowGlobals() {},
  getArrayBufferViews(buf) {
    const { buffer, byteOffset, byteLength } = buf;
    const out = [];
    const types = [
      Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
      Int32Array, Uint32Array, Float32Array, Float64Array,
      BigInt64Array, BigUint64Array, DataView,
    ];
    for (const T of types) {
      const bpe = T.BYTES_PER_ELEMENT || 1;
      if (byteLength % bpe === 0) out.push(new T(buffer, byteOffset, byteLength / bpe));
    }
    return out;
  },
};`;

// test/common/fixtures.js reads fixture files off disk via fs — impossible in
// the sandbox. Path-only tests just need fixtures.path(); stub it.
const FIXTURES_STUB = `const fixtures = {
  path(...args) { return "/fixtures/" + args.join("/"); },
};`;

export function makeUserCode(testCode, { filename }) {
  const body = testCode
    .split("\n")
    .map((line) => {
      // fixtures first: ../common/fixtures also matches the ../common prefix
      if (
        /^\s*(?:const|let|var)\s+fixtures\s*=\s*require\(\s*["']\.\.\/common\/fixtures[^"']*["']\s*\)\s*;?\s*$/.test(line)
      )
        return FIXTURES_STUB;
      if (/^\s*require\(\s*["']\.\.\/common\/fixtures[^"']*["']\s*\)\s*;?\s*$/.test(line))
        return "// (fixtures stubbed by harness)";
      if (
        /^\s*(?:const|let|var)\s+common\s*=\s*require\(\s*["']\.\.\/common["']\s*\)\s*;?\s*$/.test(line)
      )
        return COMMON_STUB;
      // Destructured: const { a, b } = require('../common') — define the stub
      // under a unique name (the file may also declare `common` separately)
      // then destructure the requested names from it.
      {
        const m = line.match(
          /^\s*(?:const|let|var)\s+(\{[^}]*\})\s*=\s*require\(\s*["']\.\.\/common["']\s*\)\s*;?\s*$/,
        );
        if (m) {
          return (
            COMMON_STUB.replace("const common =", "const __headlessCommon =") +
            "\nconst " +
            m[1] +
            " = __headlessCommon;"
          );
        }
      }
      if (/^\s*require\(\s*["']\.\.\/common[^"']*["']\s*\)\s*;?\s*$/.test(line))
        return "// (common stubbed by harness)";
      return line;
    })
    .join("\n");
  return [
    'import { createRequire } from "node:module";',
    "const require = createRequire(import.meta.url);",
    "const __filename = " + JSON.stringify(filename) + ";",
    'const __dirname = ".";',
    "try {",
    body,
    // Verify common.expectWarning()/mustCall() expectations before reporting.
    // (Handles both `const common = require(...)` and destructured forms.)
    '  {',
    '    const __hc = (typeof common !== "undefined" && common) ||',
    '      (typeof __headlessCommon !== "undefined" && __headlessCommon);',
    "    if (__hc) {",
    "      if (__hc.__verifyWarnings) __hc.__verifyWarnings();",
    "      if (__hc.__verifyMustCalls) __hc.__verifyMustCalls();",
    "    }",
    "  }",
    '  console.log("__RESULT__" + JSON.stringify({ ok: true, exitCode: (typeof process !== "undefined" && process.exitCode) || 0 }));',
    "} catch (e) {",
    '  if (e && e.code === "TEST_SKIP") {',
    '    console.log("__RESULT__" + JSON.stringify({ ok: true, skipped: true, reason: e.message }));',
    "  } else {",
    '    console.log("__RESULT__" + JSON.stringify({ ok: false, error: String((e && e.message) || e), stack: String((e && e.stack) || "") }));',
    "  }",
    "}",
  ].join("\n");
}

/**
 * Find the __RESULT__ marker in captured sandbox logs.
 * Returns { ok, skipped?, reason?, error?, stack?, exitCode? } or null.
 */
export function parseResultFromLogs(logs) {
  for (const entry of logs || []) {
    let raw;
    if (typeof entry === "string") raw = entry;
    else if (entry && typeof entry.args === "string") raw = entry.args;
    else if (entry && entry.type === "log") raw = entry.args;
    else continue;
    if (typeof raw !== "string") continue;
    const j = raw.indexOf("__RESULT__");
    if (j === -1) continue;
    try {
      return JSON.parse(raw.slice(j + "__RESULT__".length));
    } catch {
      return { ok: false, error: "result parse error: " + raw.slice(j, j + 200) };
    }
  }
  return null;
}

/** The runtime identity recorded in report.json (roadmap §4 req. d). */
export async function runtimeRecord() {
  const { SANDBOX_TEMPLATE } = await import("../../src/sandbox-template.js");
  return {
    kind: "headless-vm",
    template: "src/sandbox-template.js",
    templateSha256: createHash("sha256").update(SANDBOX_TEMPLATE, "utf8").digest("hex"),
    node: process.version,
  };
}

/** Build the report.json payload. */
export function buildReport({ target, lane, runtime, results }) {
  return {
    target,
    lane,
    runtime,
    results,
    generatedAt: new Date().toISOString(),
  };
}

/** Write the report; returns the path written. */
export function writeReport(reportPath, report) {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
}
