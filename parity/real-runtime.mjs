#!/usr/bin/env node
// Real-runtime parity harness.
//
// Runs a Node.js test file in two lanes and diffs the results:
//   1. Native Node: `node <testfile>` (the reference behavior)
//   2. Real browser sandbox: the test executes inside a genuine CodeSandbox
//      iframe through the full runtime pipeline (not a mock)
//
// Usage:
//   node parity/real-runtime.mjs <builtin> <test-file>
//   e.g. node parity/real-runtime.mjs path parity/node-test/parallel/test-path-basename.js
//
// Exit codes: 0 = parity, 1 = divergence, 2 = harness error.
//
// The browser lane reuses the e2e driver pattern (tests/byo-shell-e2e.py):
// an HTML file is generated from parity/real-runtime.html, served at
// /local-repo, and driven in headed Firefox under Xvfb with results
// captured via POST /report (crash-proof) and document.title.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const templatePath = path.join(__dirname, "real-runtime.html");
const driverPath = path.join(repoRoot, "tests", "real-runtime-parity-e2e.py");

// ─── Pure functions (unit-tested) ──────────────────────────────────────────

/**
 * Normalize a node:child_process spawnSync result into a lane result.
 */
export function parseNodeResult(r) {
  const passed = r.status === 0 && !r.error;
  let detail = "";
  if (r.error) {
    detail = `[spawn error: ${r.error.message}]`;
  } else if (!passed) {
    const tail = (r.stderr || "").trim().split("\n").slice(-8).join("\n");
    detail = tail || `[exit ${r.status}]`;
  }
  return {
    passed,
    exitCode: r.status,
    signal: r.signal || null,
    detail,
  };
}

/**
 * Hoist top-level ESM `import` statements out of test code.
 *
 * The browser-lane HTML template embeds the test code inside a `try {}`
 * block, where `import` declarations are a syntax error. Native Node
 * accepts them, so without hoisting the browser lane crashes on any ESM
 * test file (e.g. `import assert from "node:assert"`) while the node lane
 * passes — a harness bug, not a shim bug.
 *
 * Returns { hoisted: string[], body: string }. Only static imports on
 * their own line(s) are hoisted; dynamic import() is left in place.
 */
export function hoistEsmImports(testCode) {
  const importRe = /^[ \t]*import[ \t]+(?:[^'";]+?[ \t]+from[ \t]+)?['"][^'"]+['"][ \t]*;?[ \t]*$/gm;
  const hoisted = [];
  const body = testCode.replace(importRe, (m) => {
    hoisted.push(m.trim());
    return "";
  });
  return { hoisted, body };
}

/**
 * Transform a Node.js test file for execution in the browser sandbox.
 *
 * - Replaces `require("../common")` (and variants) with a minimal stub:
 *   the real test/common module cannot load in the sandbox (it uses Node
 *   internals), but the tests we target only need `isWindows`, `skip()`,
 *   and a few helpers. The stub is POSIX (isWindows: false); skip() throws
 *   a SkipError which the harness reports as skipped, not failed.
 * - Everything else is preserved verbatim: `require("assert")` and
 *   `require("<builtin>")` resolve through the sandbox's real
 *   createRequire → loadModule pipeline to our shims.
 */
export function transformForBrowser(code) {
  const stub = `const common = {
    isWindows: false,
    skip(msg) { const e = new Error("SKIP: " + msg); e.code = "TEST_SKIP"; throw e; },
    invalidArgTypeHelper: () => {},
    platform: "linux",
  };`;
  return code
    .split("\n")
    .map((line) =>
      /^\s*(?:const|let|var)\s+common\s*=\s*require\(\s*["']\.\.\/common[^"']*["']\s*\)\s*;?\s*$/.test(line)
        ? stub
        : /^\s*require\(\s*["']\.\.\/common[^"']*["']\s*\)\s*;?\s*$/.test(line)
          ? "// (common stubbed by harness)"
          : line,
    )
    .join("\n");
}

/**
 * Diff the two lane results.
 *
 * - parity: both pass, or both fail (same failure mode = the shim matches
 *   native behavior, even when that behavior is "fails here").
 * - divergence: one passes and the other fails — the real signal.
 * - error: the browser harness itself failed (timeout, crash) — not a
 *   parity verdict, needs investigation, not a shim fix.
 */
export function diffResults(nodeResult, browserResult) {
  if (browserResult.harnessError) {
    return {
      verdict: "error",
      detail: `browser harness error: ${browserResult.harnessError}`,
    };
  }
  if (nodeResult.passed === browserResult.passed) {
    return { verdict: "parity", detail: "" };
  }
  const which = nodeResult.passed ? "browser" : "node";
  return {
    verdict: "divergence",
    detail:
      `${which} lane disagrees: ` +
      `node(passed=${nodeResult.passed}, exit=${nodeResult.exitCode}) ` +
      `browser(passed=${browserResult.passed}, detail=${browserResult.detail || "n/a"})`,
  };
}

/** Map a diff verdict to a process exit code. */
export function computeVerdict(diff) {
  if (diff.verdict === "parity") return { exitCode: 0 };
  if (diff.verdict === "divergence") return { exitCode: 1 };
  return { exitCode: 2 };
}

// ─── Lane runners ──────────────────────────────────────────────────────────

/** Lane 1: run the test file in native Node. */
export function runNodeNative(testFile) {
  const r = spawnSync(process.execPath, [testFile], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseNodeResult(r);
}

/**
 * Generate the browser HTML from the template.
 * Returns the path to the generated file.
 */
export function generateHtml(testCode, { builtin, filename, outDir } = {}) {
  const template = fs.readFileSync(templatePath, "utf8");
  for (const marker of ["__TEST_CODE__", "__BUILTIN__", "__FILENAME__", "__HOISTED_IMPORTS__"]) {
    if (!template.includes(marker)) {
      throw new Error(`real-runtime.html template missing ${marker} marker`);
    }
  }
  // Hoist ESM imports out of the test body (they can't live inside try {}).
  const { hoisted, body } = hoistEsmImports(testCode);
  // Escape for embedding in a <script> block: break out of </script> and
  // template-literal hazards. The test code is embedded as a JS string
  // literal via JSON.stringify, so only </script> needs neutralizing.
  const safe = JSON.stringify(body).replace(/<\/script/gi, "<\\/script");
  // Hoisted imports become string elements of the userCode array in the
  // template (they're joined with "\n" before execution).
  const hoistedSrc = hoisted.length
    ? hoisted
        .map((line) => JSON.stringify(line).replace(/<\/script/gi, "<\\/script"))
        .join(",\n  ") + ","
    : "";
  const html = template
    .replaceAll("__TEST_CODE__", () => safe)
    .replaceAll("__HOISTED_IMPORTS__", () => hoistedSrc)
    .replaceAll("__BUILTIN__", () => JSON.stringify(builtin || ""))
    .replaceAll("__FILENAME__", () => JSON.stringify(filename || "test.js"));
  const dir = outDir || fs.mkdtempSync(path.join(os.tmpdir(), "real-runtime-"));
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, "parity-test.html");
  fs.writeFileSync(outPath, html);
  return outPath;
}

/**
 * Lane 2: run the generated HTML in headed Firefox via the e2e driver.
 * Returns { passed, detail, harnessError? }.
 */
export function runBrowser(htmlPath, { port = 8941, timeoutMs = 240000 } = {}) {
  const verdictFile = path.join(
    os.tmpdir(),
    `real-runtime-verdict-${process.pid}.jsonl`,
  );
  // Start from clean: a stale verdict file from a killed run must not
  // contaminate this run.
  try {
    fs.unlinkSync(verdictFile);
  } catch {}
  const r = spawnSync(
    "xvfb-run",
    [
      "-a",
      "/home/hatch/workspace/venvs/ffauto/bin/python",
      driverPath,
      String(port),
      htmlPath,
      verdictFile,
    ],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env },
    },
  );
  if (r.error) {
    return { passed: false, detail: "", harnessError: `driver spawn: ${r.error.message}` };
  }
  // Crash-proof channel: the last /report line is authoritative.
  let verdict = null;
  try {
    const lines = fs.readFileSync(verdictFile, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length > 0) verdict = JSON.parse(lines[lines.length - 1]);
  } catch {}
  if (!verdict) {
    return {
      passed: false,
      detail: r.stdout.slice(-2000),
      harnessError: `no verdict received (driver exit ${r.status})`,
    };
  }
  return {
    passed: verdict.ok === true,
    detail: (verdict.checks || [])
      .filter((c) => c.startsWith("FAIL"))
      .join("\n")
      .slice(0, 2000),
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function usage() {
  console.error("Usage: node parity/real-runtime.mjs <builtin> <test-file>");
  console.error("  e.g. node parity/real-runtime.mjs path parity/node-test/parallel/test-path-basename.js");
}

async function main() {
  const [builtin, testFile] = process.argv.slice(2);
  if (!builtin || !testFile) {
    usage();
    process.exit(2);
  }
  const absTest = path.resolve(repoRoot, testFile);
  if (!fs.existsSync(absTest)) {
    console.error(`test file not found: ${absTest}`);
    process.exit(2);
  }

  console.log(`[node] running ${testFile} ...`);
  const nodeResult = runNodeNative(absTest);
  console.log(
    `[node] ${nodeResult.passed ? "PASS" : "FAIL"} (exit ${nodeResult.exitCode})`,
  );
  if (!nodeResult.passed) console.log(`[node] detail: ${nodeResult.detail}`);

  console.log(`[browser] generating HTML ...`);
  const raw = fs.readFileSync(absTest, "utf8");
  const browserCode = transformForBrowser(raw);
  // __filename mimics the Node test layout so dirname()/basename() assertions
  // behave the same in both lanes.
  const relPath = path.relative(repoRoot, absTest);
  const htmlPath = generateHtml(browserCode, {
    builtin,
    filename: relPath,
  });
  console.log(`[browser] html: ${htmlPath}`);

  console.log(`[browser] launching headed Firefox ...`);
  const browserResult = runBrowser(htmlPath);
  if (browserResult.harnessError) {
    console.log(`[browser] HARNESS ERROR: ${browserResult.harnessError}`);
  } else {
    console.log(`[browser] ${browserResult.passed ? "PASS" : "FAIL"}`);
    if (!browserResult.passed) console.log(`[browser] detail: ${browserResult.detail}`);
  }

  const diff = diffResults(nodeResult, browserResult);
  console.log(`\nverdict: ${diff.verdict.toUpperCase()}`);
  if (diff.detail) console.log(`detail: ${diff.detail}`);
  process.exit(computeVerdict(diff).exitCode);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`harness error: ${e.message}`);
    process.exit(2);
  });
}
