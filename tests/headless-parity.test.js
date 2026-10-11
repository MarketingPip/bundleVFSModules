// Durable tests for the headless real-runtime parity harness (roadmap §4).
//
// The headless lane (parity/run-headless.mjs) executes Node's official test
// files through the REAL sandbox runtime — the generated template, the
// loadModule interop, taskTracker, the _RUNTIME_ -> _RUNTIME<uuid>_ AST
// rewrite — hosted in node:vm instead of an iframe. These tests pin the
// four §4 requirements:
//
//   (a) runtime-only execution (native delegation impossible),
//   (b) the marker is non-enumerable,
//   (c) expectation selection still works,
//   (d) report.json records the runtime.
//
// Plus: the core pipeline actually works (builtins resolve through
// _dynamic_import/_build_file, ESM preamble loads, worker transport runs).
import { describe, test, expect, jest } from "@jest/globals";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  expectedFailuresPath,
  makeUserCode,
  parseResultFromLogs,
  runtimeRecord,
  buildReport,
  writeReport,
} from "../parity/headless/lane.mjs";
import {
  createInProcessChannel,
  createWorkerChannel,
  interpretVerdict,
} from "../parity/headless/channel.mjs";
import { createSandboxContext } from "../parity/headless/vm-sandbox.mjs";
import { replaceGlobalThisVar } from "../parity/headless/runtime-scope.mjs";
import {
  builtinSource,
  isBuiltinSpecifier,
} from "../parity/headless/builtin-source.mjs";
import { builtinModules } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const preload = path.join(repoRoot, "parity", "preload.mjs");

jest.setTimeout(60000);

// ─── (c) expectation selection ────────────────────────────────────────────

describe("expectedFailuresPath", () => {
  test("headless lane selects expected-failures.headless.json", () => {
    expect(expectedFailuresPath("headless")).toBe(
      path.join(repoRoot, "parity", "expected-failures.headless.json"),
    );
  });

  test("shim and native lanes keep their existing files", () => {
    expect(expectedFailuresPath("shim")).toBe(
      path.join(repoRoot, "parity", "expected-failures.shim.json"),
    );
    expect(expectedFailuresPath("native")).toBe(
      path.join(repoRoot, "parity", "expected-failures.json"),
    );
  });

  test("unknown lane throws (no silent default)", () => {
    expect(() => expectedFailuresPath("browser")).toThrow(/unknown parity lane/);
  });

  test("the headless expectations file exists", () => {
    expect(fs.existsSync(expectedFailuresPath("headless"))).toBe(true);
  });
});

// ─── lane helpers ─────────────────────────────────────────────────────────

describe("makeUserCode", () => {
  test("stubs require('../common') with a working helper set", () => {
    const out = makeUserCode(
      'const common = require("../common");\nif (common.isWindows) {}',
      { filename: "t.js" },
    );
    expect(out).not.toContain('require("../common")');
    expect(out).toContain("isWindows: false");
    expect(out).toContain("invalidArgTypeHelper");
    expect(out).toContain("expectWarning");
    expect(out).toContain("mustCall");
    expect(out).toContain("mustNotCall");
    expect(out).toContain("expectsError");
  });

  test("stubs require('../common/fixtures')", () => {
    const out = makeUserCode('const fixtures = require("../common/fixtures");', {
      filename: "t.js",
    });
    expect(out).not.toContain('require("../common/fixtures")');
    expect(out).toContain("fixtures = {");
  });

  test("keeps the test body and adds the __RESULT__ wrapper", () => {
    const out = makeUserCode('const assert = require("assert");\nassert.ok(true);', {
      filename: "t.js",
    });
    expect(out).toContain('require("assert")');
    expect(out).toContain("__RESULT__");
    expect(out).toContain("TEST_SKIP");
  });
});

describe("parseResultFromLogs", () => {
  test("finds the __RESULT__ marker", () => {
    expect(
      parseResultFromLogs([{ type: "log", args: '__RESULT__{"ok":true}' }]),
    ).toEqual({ ok: true });
  });

  test("returns null when no marker is present", () => {
    expect(parseResultFromLogs([{ type: "log", args: "hello" }])).toBeNull();
  });
});

describe("interpretVerdict", () => {
  test("harnessError is not a pass", () => {
    expect(
      interpretVerdict({ ok: false, harnessError: "timeout" }, []).passed,
    ).toBe(false);
  });

  test("function_error is not a pass", () => {
    const r = interpretVerdict({ ok: false, error: "boom" }, []);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("boom");
  });

  test("skipped counts as passed", () => {
    const logs = [{ type: "log", args: '__RESULT__{"ok":true,"skipped":true}' }];
    const r = interpretVerdict({ ok: true, logs }, logs);
    expect(r.passed).toBe(true);
    expect(r.skipped).toBe(true);
  });

  test("missing __RESULT__ marker is not a pass", () => {
    expect(interpretVerdict({ ok: true, logs: [] }, []).passed).toBe(false);
  });
});

// ─── (d) report.json records the runtime ──────────────────────────────────

describe("runtimeRecord / buildReport / writeReport", () => {
  test("runtimeRecord identifies the real template", async () => {
    const rec = await runtimeRecord();
    expect(rec.kind).toBe("headless-vm");
    expect(rec.template).toBe("src/sandbox-template.js");
    expect(rec.templateSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.node).toMatch(/^v\d+/);
  });

  test("buildReport carries lane + runtime, writeReport round-trips", async () => {
    const runtime = await runtimeRecord();
    const report = buildReport({
      target: "path",
      lane: "headless",
      runtime,
      results: [{ file: "t.js", passed: true }],
    });
    expect(report.lane).toBe("headless");
    expect(report.target).toBe("path");
    expect(report.runtime.kind).toBe("headless-vm");
    expect(report.runtime.templateSha256).toMatch(/^[0-9a-f]{64}$/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-report-"));
    const p = path.join(dir, "report.json");
    writeReport(p, report);
    const back = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(back.runtime.templateSha256).toBe(runtime.templateSha256);
  });
});

// ─── (b) the marker is non-enumerable ─────────────────────────────────────

describe("marker enumerability", () => {
  test("shim lane: preload.mjs marker stays non-enumerable", () => {
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        "-e",
        [
          "const d = Object.getOwnPropertyDescriptor(globalThis, '_RUNTIME_');",
          "if (!d || d.enumerable !== false) throw new Error('marker enumerable or missing');",
          "if (globalThis._RUNTIME_.parityForceShim !== true) throw new Error('not the stub');",
          "if (Object.keys(globalThis).includes('_RUNTIME_')) throw new Error('marker leaks into Object.keys');",
          "console.log('MARKER_OK');",
        ].join("\n"),
      ],
      { env: { ...process.env, PARITY_TARGET: "path" }, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("MARKER_OK");
  });
});

// ─── (a)+(b) in-sandbox probes through the real runtime ───────────────────

const PROBE = `
const __out = {};
__out.isRealObject = typeof globalThis._RUNTIME_ === "object" && globalThis._RUNTIME_ !== null;
__out.noStubMarker = globalThis._RUNTIME_.parityForceShim === undefined;
__out.loadModuleFn = typeof globalThis._RUNTIME_.loadModule === "function";
__out.taskTracker = !!(globalThis._RUNTIME_.taskTracker && typeof globalThis._RUNTIME_.taskTracker.waitForAll === "function");
const __uuidKeys = Object.getOwnPropertyNames(globalThis).filter((k) => /^_RUNTIME_u_[0-9a-f]+_$/.test(k));
__out.uuidKeyCount = __uuidKeys.length;
__out.aliasIsSame = __uuidKeys.length === 1 && globalThis[__uuidKeys[0]] === globalThis._RUNTIME_;
const __d1 = Object.getOwnPropertyDescriptor(globalThis, "_RUNTIME_");
const __d2 = __uuidKeys.length === 1 ? Object.getOwnPropertyDescriptor(globalThis, __uuidKeys[0]) : null;
__out.markerNonEnumerable = !!(__d1 && __d1.enumerable === false && __d2 && __d2.enumerable === false);
__out.notInKeys = Object.keys(globalThis).indexOf("_RUNTIME_") === -1;
console.log("__PROBE__" + JSON.stringify(__out));
`;

function probeResult(logs) {
  for (const entry of logs || []) {
    const raw = typeof entry === "string" ? entry : entry.args;
    if (typeof raw !== "string") continue;
    const j = raw.indexOf("__PROBE__");
    if (j !== -1) return JSON.parse(raw.slice(j + "__PROBE__".length));
  }
  return null;
}

describe("real-runtime probes (in-process channel)", () => {
  test("(a) _RUNTIME_ is the real runtime object, not the stub", async () => {
    const channel = createInProcessChannel({ timeout: 30000 });
    const verdict = await channel.run(PROBE, { fileName: "probe.js" });
    expect(verdict.harnessError).toBeUndefined();
    expect(verdict.ok).toBe(true);
    const p = probeResult(verdict.logs);
    expect(p).not.toBeNull();
    expect(p.isRealObject).toBe(true);
    expect(p.noStubMarker).toBe(true);
    expect(p.loadModuleFn).toBe(true);
    expect(p.taskTracker).toBe(true);
    expect(p.uuidKeyCount).toBe(1);
    expect(p.aliasIsSame).toBe(true);
  });

  test("(b) the sandbox markers are non-enumerable", async () => {
    const channel = createInProcessChannel({ timeout: 30000 });
    const verdict = await channel.run(PROBE, { fileName: "probe.js" });
    expect(verdict.ok).toBe(true);
    const p = probeResult(verdict.logs);
    expect(p.markerNonEnumerable).toBe(true);
    expect(p.notInKeys).toBe(true);
  });

  test("(a) the fresh vm realm has no host Node builtins", () => {
    const { context } = createSandboxContext("_u_probe_", () => {});
    expect(vm.runInContext("typeof process", context)).toBe("undefined");
    expect(vm.runInContext("typeof require", context)).toBe("undefined");
    expect(vm.runInContext("typeof module", context)).toBe("undefined");
    expect(vm.runInContext("typeof Buffer", context)).toBe("undefined");
    expect(vm.runInContext("typeof __dirname", context)).toBe("undefined");
    // The only process/Buffer the sandbox ever sees are installed by the
    // sandbox's own services (node_globals via loadModule -> our shims).
  });
});

// ─── the real pipeline: builtins through _dynamic_import + _build_file ────

describe("builtin execution through the real host protocol", () => {
  test("require('path') resolves via loadModule with the _RUNTIME_ rewrite", async () => {
    const channel = createInProcessChannel({ timeout: 30000 });
    const code = [
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
      'const path = require("path");',
      'if (path.basename("a/b.js") !== "b.js") throw new Error("basename mismatch");',
      'const assert = require("assert");',
      "assert.strictEqual(1 + 1, 2);",
      'console.log("__PIPE_OK__");',
    ].join("\n");
    const verdict = await channel.run(code, { fileName: "t.js" });
    expect(verdict.harnessError).toBeUndefined();
    expect(verdict.ok).toBe(true);
    expect(
      (verdict.logs || []).some(
        (l) => typeof l.args === "string" && l.args.includes("__PIPE_OK__"),
      ),
    ).toBe(true);
  });

  test("static ESM import goes through the ImportResolver preamble", async () => {
    const channel = createInProcessChannel({ timeout: 30000 });
    const code = [
      'import path from "node:path";',
      'import { strict as assert } from "node:assert";',
      'assert.strictEqual(path.basename("x/y.js"), "y.js");',
      'console.log("__ESM_OK__");',
    ].join("\n");
    const verdict = await channel.run(code, { fileName: "t.js" });
    expect(verdict.harnessError).toBeUndefined();
    expect(verdict.ok).toBe(true);
    expect(
      (verdict.logs || []).some(
        (l) => typeof l.args === "string" && l.args.includes("__ESM_OK__"),
      ),
    ).toBe(true);
  });

  test("replaceGlobalThisVar rewrites globalThis._RUNTIME_ to the uuid form", () => {
    const out = replaceGlobalThisVar("globalThis._RUNTIME_.loadModule('x');", "_RUNTIME_", {
      replacement: "globalThis._RUNTIME_u_abc123_",
      filename: "t.js",
    }).code;
    expect(out).toContain("globalThis._RUNTIME_u_abc123_.loadModule");
    expect(out).not.toMatch(/globalThis\._RUNTIME_\./);
  });
});

// ─── worker transport ─────────────────────────────────────────────────────

describe("worker channel", () => {
  test("a real official test file passes through the worker transport", async () => {
    const raw = fs.readFileSync(
      path.join(repoRoot, "parity", "node-test", "parallel", "test-path-basename.js"),
      "utf8",
    );
    const userCode = makeUserCode(raw, {
      filename: "parity/node-test/parallel/test-path-basename.js",
    });
    const channel = createWorkerChannel({ timeout: 60000 });
    const verdict = await channel.run(userCode, {
      fileName: "test-path-basename.js",
    });
    expect(verdict.harnessError).toBeUndefined();
    const r = interpretVerdict(verdict, verdict.logs);
    expect(r.passed).toBe(true);
  }, 120000);
});

// ─── builtin-source ─────────────────────────────────────────────────────────

describe("builtin-source", () => {
  test("internal/event_target gets the sandbox adapter (not the generic stub)", () => {
    expect(isBuiltinSpecifier("internal/event_target", builtinModules)).toBe(true);
    const src = builtinSource("internal/event_target");
    expect(src).toContain("NodeEventTarget");
    expect(src).toContain("kEvents");
    expect(src).toContain("module.exports");
    expect(src).not.toBe("export default {};");
  });
});
