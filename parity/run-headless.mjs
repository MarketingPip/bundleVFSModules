#!/usr/bin/env node
// Parity runner: the headless real-runtime lane (roadmap §4).
//
// Runs Node.js's official test files through the ACTUAL sandbox runtime —
// the real generated template (SandboxRuntime.generate()), the real
// loadModule interop, the real taskTracker, the real
// globalThis._RUNTIME_ -> globalThis._RUNTIME<uuid>_ AST rewrite —
// hosted headlessly in Node worker_threads via node:vm instead of an
// iframe. Native delegation is structurally impossible (the vm realm has
// no host Node builtins); _RUNTIME_ is the real runtime object, not the
// { parityForceShim: true } stub of the shim lane.
//
// Usage:
//   node parity/run-headless.mjs [module]     e.g. node parity/run-headless.mjs path
//
// For each test/parallel/test-<module>*.js it spawns one worker (per-file
// isolation, like run.mjs's per-file child processes), collects
// pass/fail/skip, and diffs against parity/expected-failures.headless.json.
// Exits non-zero only on NEW failures (or newly-fixed tests), so it gates
// CI on real-runtime parity regressions. parity/report.json records the
// lane and the runtime identity (template SHA).
//
// This is a separate entry point from parity/run.mjs by design: run.mjs is
// shared across module PRs (AGENTS.md: never bulk-commit shared files),
// and the headless lane's execution model (workers, not child processes)
// deserves its own runner.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectedFailuresPath,
  makeUserCode,
  runtimeRecord,
  buildReport,
  writeReport,
} from "./headless/lane.mjs";
import { createWorkerChannel, interpretVerdict as interpret } from "./headless/channel.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const testsDir = path.join(repoRoot, "parity", "node-test", "parallel");
const reportPath = path.join(repoRoot, "parity", "report.json");

const target = process.argv[2] || process.env.PARITY_TARGET || "path";
const lane = "headless";
const expectedPath = expectedFailuresPath(lane);
const filePrefix = `test-${target.replace(/_/g, "-")}`;
const files = fs
  .readdirSync(testsDir)
  .filter(
    (f) =>
      f.startsWith(filePrefix) && (f.endsWith(".js") || f.endsWith(".mjs")),
  )
  .sort();

if (files.length === 0) {
  console.error(`No Node.js tests found for module "${target}" in ${testsDir}`);
  process.exit(2);
}

const expected = fs.existsSync(expectedPath)
  ? JSON.parse(fs.readFileSync(expectedPath, "utf8"))
  : {};

const channel = createWorkerChannel({ timeout: 60000 });
const results = [];

for (const file of files) {
  const abs = path.join(testsDir, file);
  const raw = fs.readFileSync(abs, "utf8");
  const relPath = path.relative(repoRoot, abs);
  const userCode = makeUserCode(raw, { filename: relPath });
  let verdict;
  try {
    verdict = await channel.run(userCode, { fileName: relPath });
  } catch (e) {
    verdict = { ok: false, harnessError: `channel run threw: ${e.message}` };
  }
  const r = interpret(verdict, verdict.logs);
  const skipped = r.passed && r.skipped;
  results.push({
    file,
    passed: r.passed,
    skipped: !!skipped,
    harnessError: r.harnessError || verdict.harnessError || undefined,
    detail: r.detail || verdict.error || "",
  });
  const mark = r.harnessError
    ? "ERROR"
    : r.passed
      ? skipped
        ? "SKIP "
        : "PASS "
      : "FAIL ";
  console.log(`${mark} ${file}${r.passed ? "" : `  (${r.detail || r.harnessError || "failed"})`.slice(0, 160)}`);
}

const failed = results.filter((r) => !r.passed);
const newFailures = failed.filter((r) => !(r.file in expected));
const fixed = Object.keys(expected).filter(
  (f) => !failed.some((r) => r.file === f) && files.includes(f),
);

console.log("\n----------------------------------------");
console.log(
  `Module: ${target}  [${lane} lane]  ${results.length - failed.length}/${results.length} passed`,
);

if (newFailures.length > 0) {
  console.log(`\nNEW FAILURES (not in ${path.basename(expectedPath)}):`);
  for (const r of newFailures) {
    console.log(`\n--- ${r.file} ---`);
    console.log(
      r.harnessError
        ? `[harness] ${r.harnessError}`
        : r.detail || "(no output)",
    );
  }
}
if (fixed.length > 0) {
  console.log(`\nNEWLY PASSING (remove from ${path.basename(expectedPath)}):`);
  for (const f of fixed) console.log(`  ${f}`);
}
if (newFailures.length === 0 && fixed.length === 0) {
  console.log("No new failures. Parity steady. ✔");
}

const runtime = await runtimeRecord();
const report = buildReport({ target, lane, runtime, results });
writeReport(reportPath, report);
console.log(`\nFull report: parity/report.json`);

process.exit(newFailures.length > 0 || fixed.length > 0 ? 1 : 0);
