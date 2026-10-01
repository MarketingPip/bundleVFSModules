// Red-first tests for the seed-targets gate (scripts/check-seed-targets.mjs).
// The M3 rollup failure (2026-09-30) was a stale seed missing an interception
// target; this gate ensures every FILE target the platform promises to serve
// is actually present in each seed.
import { BROWSER_BUILD_TARGETS } from "../src/browser-builds.js";
import {
  SEED_TARGETS,
  checkSeedTargets,
} from "../scripts/check-seed-targets.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("seed-targets gate", () => {
  test("targets are derived from BROWSER_BUILD_TARGETS, not hardcoded", () => {
    const expected = Object.entries(BROWSER_BUILD_TARGETS)
      .filter(([k]) => k !== "ROLLUP_BROWSER_DIR")
      .map(([, v]) => v);
    expect(SEED_TARGETS).toEqual(expected);
    // ROLLUP_BROWSER_DIR is a directory prefix, not a file — excluded.
    expect(SEED_TARGETS).not.toContain(
      BROWSER_BUILD_TARGETS.ROLLUP_BROWSER_DIR,
    );
  });

  test("detects a missing interception target (red)", () => {
    // Build a seed missing the first target.
    const seed = {};
    for (const t of SEED_TARGETS.slice(1)) {
      seed[t] = "x".repeat(2000); // plausible file content
    }
    const p = path.join(os.tmpdir(), `seed-missing-${Date.now()}.json`);
    fs.writeFileSync(p, JSON.stringify(seed));
    try {
      const failures = checkSeedTargets(p);
      expect(failures).toContain(SEED_TARGETS[0]);
      expect(failures).toHaveLength(1);
    } finally {
      fs.unlinkSync(p);
    }
  });

  test("passes when all targets are present (green)", () => {
    const seed = {};
    for (const t of SEED_TARGETS) {
      seed[t] = "x".repeat(2000);
    }
    const p = path.join(os.tmpdir(), `seed-full-${Date.now()}.json`);
    fs.writeFileSync(p, JSON.stringify(seed));
    try {
      expect(checkSeedTargets(p)).toEqual([]);
    } finally {
      fs.unlinkSync(p);
    }
  });

  test("rejects stub content under 1000 chars (not a real file)", () => {
    const seed = {};
    for (const t of SEED_TARGETS) {
      seed[t] = "stub"; // too short to be a real bundled file
    }
    const p = path.join(os.tmpdir(), `seed-stub-${Date.now()}.json`);
    fs.writeFileSync(p, JSON.stringify(seed));
    try {
      const failures = checkSeedTargets(p);
      expect(failures).toHaveLength(SEED_TARGETS.length);
    } finally {
      fs.unlinkSync(p);
    }
  });
});
