// Native oracle: for every test that did NOT pass in the harness baseline,
// run it once under real Node 26 (no preload, no shims) and record whether
// it passes natively. This is what turns a baseline "fail" into a reason:
//   native pass + harness fail  → "shim-gap" (the shim is what fails it)
//   native fail                → "fails-natively" (the test itself is broken
//                                 in this tree, needs a flag the runner did
//                                 not pass, or is environmental — NOT a shim gap)
//   native timeout             → "native-timeout"
// Flags: the test file's `// Flags: ...` header comment is parsed and passed
// through (e.g. --expose-internals), because many Node tests need one.
// Usage:
//   node parity/drift/run-oracle.mjs --node26-src <dir> --node26-bin <path>
//     --baseline parity/drift/node26-baseline.jsonc
//     --out parity/drift/node26-oracle.json [--jobs 4]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const node26Src = arg("--node26-src", null);
const node26Bin = arg("--node26-bin", null);
const baselineFile = arg("--baseline", null);
const outFile = arg("--out", null);
const jobs = parseInt(arg("--jobs", "4"), 10);
if (!node26Src || !node26Bin || !baselineFile || !outFile) {
  console.error(
    "usage: node parity/drift/run-oracle.mjs --node26-src <dir> --node26-bin <path> --baseline <jsonc> --out <json> [--jobs N]",
  );
  process.exit(2);
}

// Strip // comment lines: the baseline is JSONC.
const raw = readFileSync(baselineFile, "utf8")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//"))
  .join("\n");
const baseline = JSON.parse(raw);
const failing = [];
for (const [mod, m] of Object.entries(baseline.modules)) {
  for (const [test, v] of Object.entries(m.tests)) {
    if (v.status !== "pass") failing.push({ mod, test, harnessExit: v.exit });
  }
}
console.log(`${failing.length} non-passing tests to classify`);

function flagsFor(test) {
  try {
    const src = readFileSync(join(node26Src, "test", "parallel", test), "utf8")
      .split("\n")
      .slice(0, 30)
      .join("\n");
    const m = src.match(/\/\/ Flags:\s*(.+)/);
    if (!m) return [];
    // Split on whitespace; drop empty entries. Flags are trusted: they come
    // from Node's own test files, not user input.
    return m[1].trim().split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

function runOne({ test }) {
  return new Promise((res) => {
    const flags = flagsFor(test);
    const p = spawn(node26Bin, [...flags, join("test", "parallel", test)], {
      cwd: node26Src,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      res({ test, flags, nativeExit: 124 });
    }, 30000);
    p.on("error", () => {
      clearTimeout(timer);
      res({ test, flags, nativeExit: -1 });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      res({ test, flags, nativeExit: code === null ? -1 : code });
    });
  });
}

const results = {};
let idx = 0;
let done = 0;
await Promise.all(
  Array.from({ length: Math.max(1, jobs) }, async () => {
    while (idx < failing.length) {
      const f = failing[idx++];
      const r = await runOne(f);
      const cls =
        r.nativeExit === 0 ? "shim-gap" : r.nativeExit === 124 ? "native-timeout" : "fails-natively";
      results[f.test] = { ...f, ...r, class: cls };
      done++;
      if (done % 100 === 0 || done === failing.length) console.log(`oracle ${done}/${failing.length}`);
    }
  }),
);

const counts = { "shim-gap": 0, "fails-natively": 0, "native-timeout": 0 };
for (const r of Object.values(results)) counts[r.class]++;
writeFileSync(
  outFile,
  JSON.stringify(
    { node: "26.13.1", generated: new Date().toISOString().slice(0, 10), counts, tests: results },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${outFile}: ${JSON.stringify(counts)}`);
