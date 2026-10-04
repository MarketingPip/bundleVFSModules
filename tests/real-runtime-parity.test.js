// Tests for the real-runtime parity harness (parity/real-runtime.mjs).
//
// The harness runs a Node.js test file in two lanes — native Node and the
// real browser CodeSandbox — then diffs the results. These tests cover the
// harness logic itself (diff, parsing, transforms), not the browser.

import {
  diffResults,
  parseNodeResult,
  transformForBrowser,
  computeVerdict,
} from "../parity/real-runtime.mjs";

describe("parseNodeResult", () => {
  test("exit 0 with empty output is a pass", () => {
    const r = parseNodeResult({ status: 0, stdout: "", stderr: "", signal: null });
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  test("non-zero exit is a failure with stderr tail", () => {
    const r = parseNodeResult({
      status: 1,
      stdout: "",
      stderr: "AssertionError: expected 1 to be 2\n    at foo (test.js:1:1)\n",
      signal: null,
    });
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.detail).toContain("AssertionError");
  });

  test("signal termination is a failure", () => {
    const r = parseNodeResult({ status: null, stdout: "", stderr: "", signal: "SIGTERM" });
    expect(r.passed).toBe(false);
    expect(r.signal).toBe("SIGTERM");
  });

  test("spawn error is a failure", () => {
    const r = parseNodeResult({
      status: null,
      stdout: "",
      stderr: "",
      signal: null,
      error: new Error("spawn ENOENT"),
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("ENOENT");
  });
});

describe("transformForBrowser", () => {
  const sample = `"use strict";
require("../common");
const assert = require("assert");
const path = require("path");

assert.strictEqual(path.basename("a/b.js"), "b.js");
`;

  test("replaces side-effect require('../common') with a stub comment", () => {
    const out = transformForBrowser(sample);
    expect(out).not.toContain('require("../common")');
    expect(out).toContain("// (common stubbed by harness)");
  });

  test("replaces assigned require('../common') with a minimal stub", () => {
    const out = transformForBrowser('const common = require("../common");\nif (common.isWindows) {}');
    expect(out).not.toContain('require("../common")');
    expect(out).toContain("isWindows: false");
    expect(out).toContain("if (common.isWindows) {}");
  });

  test("keeps assert and path requires", () => {
    const out = transformForBrowser(sample);
    expect(out).toContain('require("assert")');
    expect(out).toContain('require("path")');
  });

  test("keeps the assertions intact", () => {
    const out = transformForBrowser(sample);
    expect(out).toContain('assert.strictEqual(path.basename("a/b.js"), "b.js")');
  });

  test("handles require('../common/index') variants", () => {
    const out = transformForBrowser('const common = require("../common/index");\nconst x = 1;');
    expect(out).not.toContain('require("../common/index")');
    expect(out).toContain("isWindows: false");
    expect(out).toContain("const x = 1;");
  });

  test("handles already-ESM test files (no require)", () => {
    const esm = 'import path from "node:path";\nconsole.log(path.basename("a"));';
    expect(transformForBrowser(esm)).toBe(esm);
  });
});

describe("diffResults", () => {
  const nodePass = { passed: true, exitCode: 0, detail: "" };
  const nodeFail = { passed: false, exitCode: 1, detail: "AssertionError: x" };
  const browserPass = { passed: true, detail: "" };
  const browserFail = { passed: false, detail: "AssertionError: x" };

  test("both pass → parity", () => {
    expect(diffResults(nodePass, browserPass).verdict).toBe("parity");
  });

  test("both fail → parity (same failure mode)", () => {
    // Both lanes failing the same way is still parity — the shim matches
    // native behavior, even if that behavior is "this test fails here".
    expect(diffResults(nodeFail, browserFail).verdict).toBe("parity");
  });

  test("node passes, browser fails → divergence", () => {
    const d = diffResults(nodePass, browserFail);
    expect(d.verdict).toBe("divergence");
    expect(d.detail).toContain("browser");
  });

  test("node fails, browser passes → divergence", () => {
    const d = diffResults(nodeFail, browserPass);
    expect(d.verdict).toBe("divergence");
    expect(d.detail).toContain("node");
  });

  test("browser harness error → error (not divergence)", () => {
    const d = diffResults(nodePass, { passed: false, detail: "", harnessError: "timeout" });
    expect(d.verdict).toBe("error");
  });
});

describe("computeVerdict", () => {
  test("parity → exit 0", () => {
    expect(computeVerdict({ verdict: "parity" }).exitCode).toBe(0);
  });

  test("divergence → exit 1", () => {
    expect(computeVerdict({ verdict: "divergence", detail: "x" }).exitCode).toBe(1);
  });

  test("error → exit 2 (harness issue, not a parity failure)", () => {
    expect(computeVerdict({ verdict: "error", detail: "x" }).exitCode).toBe(2);
  });
});
