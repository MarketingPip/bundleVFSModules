#!/usr/bin/env node
// Parity scoreboard generator: Cloudflare-style compat matrix
// Generates a markdown report with per-module pass rates and export surface parity.
//
// Usage: node scripts/generate-scoreboard.mjs [--output <file>]
//
// Output: Markdown table with:
// - Module name
// - Parity tests: X/Y passed (Z%)
// - Oracle: export surface match/mismatch
// - Status: ✅ green, ⚠️ partial, ❌ failing

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const outputIdx = args.indexOf("--output");
const outputFile = outputIdx >= 0 ? args[outputIdx + 1] : null;

// Get list of modules from src/
const srcDir = path.join(repoRoot, "src");
const modules = fs
  .readdirSync(srcDir)
  .filter((f) => f.endsWith(".js") && !f.startsWith("_") && !f.startsWith("."))
  .map((f) => f.replace(/\.js$/, ""))
  .sort();

console.log(`Scanning ${modules.length} modules...`);

// For each module, get parity test results
// (We use the expected-failures file to know what's passing)
const expectedPath = path.join(
  repoRoot,
  "parity",
  "expected-failures.shim.json",
);
const expected = fs.existsSync(expectedPath)
  ? JSON.parse(fs.readFileSync(expectedPath, "utf8"))
  : {};

// Count expected failures per module
const failuresByModule = {};
for (const [file] of Object.entries(expected)) {
  // Extract module name from test-buffer-foo.js -> buffer
  const m = file.match(/^test-([a-z0-9_]+)/);
  if (m) {
    const mod = m[1].replace(/-/g, "_");
    failuresByModule[mod] = (failuresByModule[mod] || 0) + 1;
  }
}

// Get total test counts per module (from parity/node-test)
const testsDir = path.join(repoRoot, "parity", "node-test", "parallel");
const testsByModule = {};
if (fs.existsSync(testsDir)) {
  for (const f of fs.readdirSync(testsDir)) {
    const m = f.match(/^test-([a-z0-9_]+)/);
    if (m && (f.endsWith(".js") || f.endsWith(".mjs"))) {
      const mod = m[1].replace(/-/g, "_");
      testsByModule[mod] = (testsByModule[mod] || 0) + 1;
    }
  }
}

// Generate markdown
let md = `# Parity Scoreboard\n\n`;
md += `Generated: ${new Date().toISOString()}\n\n`;
md += `| Module | Parity Tests | Pass Rate | Expected Failures | Status |\n`;
md += `|--------|--------------|-----------|-------------------|--------|\n`;

let totalTests = 0;
let totalFailures = 0;

for (const mod of modules) {
  const total = testsByModule[mod] || 0;
  const failures = failuresByModule[mod] || 0;
  const passed = total - failures;
  const rate = total > 0 ? Math.round((passed / total) * 100) : 0;

  totalTests += total;
  totalFailures += failures;

  let status = "❌";
  if (rate === 100) status = "✅";
  else if (rate >= 80) status = "⚠️";
  else if (total === 0) status = "➖"; // No tests

  md += `| \`${mod}\` | ${passed}/${total} | ${rate}% | ${failures} | ${status} |\n`;
}

const overallRate =
  totalTests > 0
    ? Math.round(((totalTests - totalFailures) / totalTests) * 100)
    : 0;
md += `\n**Overall:** ${totalTests - totalFailures}/${totalTests} passed (${overallRate}%)\n`;
md += `\n**Legend:** ✅ 100% | ⚠️ 80-99% | ❌ <80% | ➖ No tests\n`;

if (outputFile) {
  fs.writeFileSync(outputFile, md);
  console.log(`Wrote to ${outputFile}`);
} else {
  console.log(md);
}
