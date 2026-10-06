#!/usr/bin/env node
// Parity runner: executes Node.js's official test files against the polyfills.
//
// Usage:
//   node parity/run.mjs [module]        e.g. node parity/run.mjs path
//   PARITY_TARGET=path node parity/run.mjs
//   PARITY_NATIVE=1 node parity/run.mjs child_process   # bridge diagnostic:
//                           native delegation on, official tests run against
//                           Node itself (a tautology, not a shim test)
// The default lane is the shim lane: native bridges stay off, official tests
// run against the code that actually executes in the sandbox.
// For each test/parallel/test-<module>*.js it spawns:
//   node --import ./parity/preload.mjs <testfile>
// with PARITY_TARGET set, so only that module's builtin is redirected to
// src/<module>.js. Results are compared against expected-failures.json:
// the run fails only on NEW failures (or newly-fixed tests).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const testsDir = path.join(repoRoot, "parity", "node-test", "parallel");
const preload = path.join(repoRoot, "parity", "preload.mjs");
const reportPath = path.join(repoRoot, "parity", "report.json");

const target = process.argv[2] || process.env.PARITY_TARGET || "path";
// The shim lane is the default: the same test file legitimately fails in the
// browser lane (e.g. real process spawning is a noop by design) while passing
// via native delegation, so one flat file cannot describe both lanes.
// PARITY_NATIVE=1 opts into the bridge diagnostic lane (native delegation);
// PARITY_FORCE_SHIM=1 is accepted for backwards compatibility and is a no-op.
const lane = process.env.PARITY_NATIVE === "1" ? "native" : "shim";
const expectedPath = path.join(
  repoRoot,
  "parity",
  lane === "shim" ? "expected-failures.shim.json" : "expected-failures.json",
);
// Node names some test files with hyphens (test-string-decoder.js) while the
// builtin uses an underscore; also pick up .mjs tests (e.g. events).
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

const results = [];
// Node's test files declare required CLI flags via `// Flags: --foo --bar`
// (usually in the first few lines). Parse and pass them to the child.
function extractFlags(file) {
  const head = fs
    .readFileSync(path.join(testsDir, file), "utf8")
    .split("\n", 20)
    .join("\n");
  const m = head.match(/^\/\/ Flags:\s*(.+)$/m);
  return m ? m[1].trim().split(/\s+/) : [];
}
for (const file of files) {
  const flags = extractFlags(file);
  const r = spawnSync(
    process.execPath,
    [...flags, "--import", preload, path.join(testsDir, file)],
    {
      env: { ...process.env, PARITY_TARGET: target },
      timeout: 30000,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const err = r.error ? ` [spawn error: ${r.error.message}]` : "";
  const stderrTail = (r.stderr || "").trim().split("\n").slice(-12).join("\n");
  results.push({
    file,
    passed: r.status === 0,
    status: r.status,
    signal: r.signal,
    detail: err || stderrTail,
  });
  const mark = r.status === 0 ? "PASS" : "FAIL";
  console.log(
    `${mark}  ${file}${r.status === 0 ? "" : `  (exit ${r.status}${r.signal ? `, ${r.signal}` : ""})`}`,
  );
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
    console.log(r.detail || "(no output)");
  }
}
if (fixed.length > 0) {
  console.log(`\nNEWLY PASSING (remove from ${path.basename(expectedPath)}):`);
  for (const f of fixed) console.log(`  ${f}`);
}
if (newFailures.length === 0 && fixed.length === 0) {
  console.log("No new failures. Parity steady. ✔");
}

// Deno-style structured failure report
// Categories: fixable (A), inherent (B), wontfix (C)
const byCategory = { fixable: 0, inherent: 0, wontfix: 0, unknown: 0 };
const missingReason = [];
for (const [file, entry] of Object.entries(expected)) {
  if (typeof entry === "string") {
    // Legacy format: treat as inherent with the string as reason
    byCategory.inherent++;
  } else if (entry && typeof entry === "object") {
    if (!entry.reason) missingReason.push(file);
    const cat = entry.category || "unknown";
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }
}
if (missingReason.length > 0) {
  console.log(
    `\nWARNING: ${missingReason.length} entries missing 'reason' (Deno requires it):`,
  );
  for (const f of missingReason.slice(0, 5)) console.log(`  ${f}`);
}
const totalExpected = Object.keys(expected).length;
if (totalExpected > 0) {
  console.log(
    `\nExpected failures: ${totalExpected} (fixable: ${byCategory.fixable}, inherent: ${byCategory.inherent}, wontfix: ${byCategory.wontfix})`,
  );
}

fs.writeFileSync(
  reportPath,
  JSON.stringify({ target, lane, results }, null, 2),
);
console.log(`\nFull report: parity/report.json`);

process.exit(newFailures.length > 0 || fixed.length > 0 ? 1 : 0);
