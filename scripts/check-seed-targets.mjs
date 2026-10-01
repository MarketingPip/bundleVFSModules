// Seed-targets gate: every native-interception FILE target in
// src/browser-builds.js must resolve to a real file in each served seed.
// The M3 rollup failure (2026-09-30) was exactly this: a hand-maintained
// seed missed /node_modules/@rollup/browser/dist/es/rollup.browser.js,
// and vite.build() died with ERR_MODULE_NOT_FOUND.
// Targets are DERIVED from BROWSER_BUILD_TARGETS (the platform's own promise),
// not a hardcoded list — a new interception target is checked automatically.
//
// Usage:
//   node scripts/check-seed-targets.mjs <seed.json> [seed2.json ...]
// Exit 0 = all targets present in every seed; exit 1 otherwise.
//
// This is a repository-relative port of the dossier-only harness script
// (work-queue/jobs/2026-09-29-vite7-browser/harness/check-seed-targets.mjs).
import { BROWSER_BUILD_TARGETS } from "../src/browser-builds.js";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// File targets the platform promises to serve. ROLLUP_BROWSER_DIR is a
// directory prefix for subpath passthrough, not a file — skip it.
export const SEED_TARGETS = Object.entries(BROWSER_BUILD_TARGETS)
  .filter(([k]) => k !== "ROLLUP_BROWSER_DIR")
  .map(([, v]) => v);

export function checkSeedTargets(seedPath) {
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const failures = [];
  for (const target of SEED_TARGETS) {
    const hit = seed[target];
    const ok = typeof hit === "string" ? hit.length > 1000 : hit != null;
    if (!ok) failures.push(target);
  }
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error(
      "Usage: node scripts/check-seed-targets.mjs <seed.json> [...]",
    );
    process.exit(2);
  }
  let total = 0;
  for (const s of args) {
    const failures = checkSeedTargets(s);
    console.log(`\n== ${s} ==`);
    for (const target of SEED_TARGETS) {
      const ok = !failures.includes(target);
      console.log(`${ok ? "PASS" : "FAIL"} ${target}`);
    }
    total += failures.length;
  }
  if (total) {
    console.error(`\n${total} interception target(s) missing`);
    process.exit(1);
  }
  console.log("\nAll interception targets seeded in every seed.");
}
