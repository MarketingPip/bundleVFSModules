#!/usr/bin/env node
// Parity runner: executes Node.js's official test files against the polyfills.
//
// Usage:
//   node parity/run.mjs [module]        e.g. node parity/run.mjs path
//   PARITY_TARGET=path node parity/run.mjs
//
// For each test/parallel/test-<module>*.js it spawns:
//   node --import ./parity/preload.mjs <testfile>
// with PARITY_TARGET set, so only that module's builtin is redirected to
// src/<module>.js. Results are compared against expected-failures.json:
// the run fails only on NEW failures (or newly-fixed tests).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const testsDir = path.join(repoRoot, 'parity', 'node-test', 'parallel');
const preload = path.join(repoRoot, 'parity', 'preload.mjs');
const expectedPath = path.join(repoRoot, 'parity', 'expected-failures.json');
const reportPath = path.join(repoRoot, 'parity', 'report.json');

const target = process.argv[2] || process.env.PARITY_TARGET || 'path';
const files = fs
  .readdirSync(testsDir)
  .filter((f) => f.startsWith(`test-${target}`) && f.endsWith('.js'))
  .sort();

if (files.length === 0) {
  console.error(`No Node.js tests found for module "${target}" in ${testsDir}`);
  process.exit(2);
}

const expected = fs.existsSync(expectedPath)
  ? JSON.parse(fs.readFileSync(expectedPath, 'utf8'))
  : {};

const results = [];
for (const file of files) {
  const r = spawnSync(
    process.execPath,
    ['--import', preload, path.join(testsDir, file)],
    {
      env: { ...process.env, PARITY_TARGET: target },
      timeout: 30000,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    }
  );
  const err = r.error ? ` [spawn error: ${r.error.message}]` : '';
  const stderrTail = (r.stderr || '').trim().split('\n').slice(-12).join('\n');
  results.push({
    file,
    passed: r.status === 0,
    status: r.status,
    signal: r.signal,
    detail: err || stderrTail,
  });
  const mark = r.status === 0 ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${file}${r.status === 0 ? '' : `  (exit ${r.status}${r.signal ? `, ${r.signal}` : ''})`}`);
}

const failed = results.filter((r) => !r.passed);
const newFailures = failed.filter((r) => !(r.file in expected));
const fixed = Object.keys(expected).filter(
  (f) => !failed.some((r) => r.file === f) && files.includes(f)
);

console.log('\n----------------------------------------');
console.log(`Module: ${target}   ${results.length - failed.length}/${results.length} passed`);

if (newFailures.length > 0) {
  console.log('\nNEW FAILURES (not in expected-failures.json):');
  for (const r of newFailures) {
    console.log(`\n--- ${r.file} ---`);
    console.log(r.detail || '(no output)');
  }
}
if (fixed.length > 0) {
  console.log('\nNEWLY PASSING (remove from expected-failures.json):');
  for (const f of fixed) console.log(`  ${f}`);
}
if (newFailures.length === 0 && fixed.length === 0) {
  console.log('No new failures. Parity steady. ✔');
}

fs.writeFileSync(reportPath, JSON.stringify({ target, results }, null, 2));
console.log(`\nFull report: parity/report.json`);

process.exit(newFailures.length > 0 || fixed.length > 0 ? 1 : 0);
