// Native oracle: for every test that did NOT pass in the harness baseline,
// run it once under real Node (no preload, no shims) and record whether
// it passes natively. This is what turns a baseline "fail" into a reason:
//   native pass + harness fail  → "shim-gap" (the shim is what fails it)
//   native fail                → "fails-natively" (the test itself is broken
//                                 in this tree, needs a flag the runner did
//                                 not pass, or is environmental — NOT a shim gap)
//   native timeout             → "native-timeout"
// Flags: the test file's `// Flags: ...` header comment is parsed and passed
// through (e.g. --expose-internals), because many Node tests need one.
// --target selects the oracle Node and the tree the headers are read from:
//   26 (default): --node26-src (source checkout) + --node26-bin (26.13.1
//     binary); headers from <src>/test/parallel, run with cwd <src>.
//   24: the vendored v24.20.0 tree (parity/node-test/ in this repo —
//     headers from parity/node-test/parallel, run with cwd parity/node-test/)
//     + --node24-bin (24.20.0 binary). --node-src overrides the tree root
//     for either target (a source checkout: <src>/test/parallel).
// Usage:
//   node parity/drift/run-oracle.mjs [--target 24|26]
//     --baseline <jsonc> --out <json> [--jobs 4]
//     [--node26-src <dir> --node26-bin <path>]
//     [--node24-bin <path>] [--node-src <dir> --node-bin <path>]
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// ponytail: one map is the whole target table (mirrors run-baseline.mjs).
const TARGETS = { 24: "24.20.0", 26: "26.13.1" };
const target = arg("--target", "26");
if (!(target in TARGETS)) {
  console.error(`--target must be 24 or 26, got ${JSON.stringify(target)}`);
  process.exit(2);
}
const nodeVersion = TARGETS[target];
const nodeSrcArg = arg("--node-src", null);
const nodeBinArg = arg("--node-bin", null);
const node26SrcArg = arg("--node26-src", null);
const node26BinArg = arg("--node26-bin", null);
const node24SrcArg = arg("--node24-src", null);
const node24BinArg = arg("--node24-bin", null);
if (target === "24" && (node26SrcArg || node26BinArg)) {
  console.error("--node26-src/--node26-bin are only valid with --target 26 (use --node-src/--node-bin or --node24-src/--node24-bin for target 24)");
  process.exit(2);
}
if (target === "26" && (node24SrcArg || node24BinArg)) {
  console.error("--node24-src/--node24-bin are only valid with --target 24 (use --node-src/--node-bin or --node26-src/--node26-bin for target 26)");
  process.exit(2);
}
// Tree root: target 26 needs a source checkout; target 24 defaults to the
// vendored tree in this repo. Layout differs (source checkout:
// test/parallel; vendored tree: parallel) — detect it from the directory
// itself, so an explicit --node-src pointing at either shape works.
const nodeSrc =
  target === "26"
    ? (nodeSrcArg ?? node26SrcArg)
    : (nodeSrcArg ?? node24SrcArg ?? join(repoRoot, "parity", "node-test"));
const nodeBin = target === "26" ? (nodeBinArg ?? node26BinArg) : (nodeBinArg ?? node24BinArg);
const baselineFile = arg("--baseline", null);
const outFile = arg("--out", null);
const jobs = parseInt(arg("--jobs", "4"), 10);
if (!nodeSrc || !nodeBin || !baselineFile || !outFile) {
  console.error(
    "usage: node parity/drift/run-oracle.mjs [--target 24|26] --baseline <jsonc> --out <json> [--jobs N] [--node26-src <dir> --node26-bin <path>] [--node24-bin <path>] [--node-src <dir> --node-bin <path>]",
  );
  process.exit(2);
}
// Layout detection runs AFTER the usage check: with target 26 and no src,
// nodeSrc is null and join() would throw a TypeError instead of the usage
// error above.
const parallelDir = existsSync(join(nodeSrc, "test", "parallel"))
  ? join(nodeSrc, "test", "parallel")
  : join(nodeSrc, "parallel");
const runDir = nodeSrc;

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
    const src = readFileSync(join(parallelDir, test), "utf8")
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

// Signal numbers (POSIX): a child killed by a signal reports code === null
// and the signal NAME on the close event. Record the shell convention
// 128+N so the recorded exit says which signal killed it (SIGKILL 137,
// SIGTERM 143, SIGABRT 134, SIGSEGV 139, ...). Previously a signal death
// recorded -1, losing the signal entirely. Unknown signal → -1, matching
// the spawn-error path. (Mirrors run-baseline.mjs signalExit; the two
// tools are standalone scripts with no shared import.)
const SIGNAL_NUMBERS = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
  SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
  SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGSTKFLT: 16, SIGCHLD: 17,
  SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22,
  SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27,
  SIGWINCH: 28, SIGIO: 29, SIGPWR: 30, SIGSYS: 31,
};
function signalExit(signal) {
  const n = SIGNAL_NUMBERS[signal];
  return n === undefined ? -1 : 128 + n;
}

function runOne({ test }) {
  return new Promise((res) => {
    const flags = flagsFor(test);
    // Test path is relative to the tree root: test/parallel/<test> for a
    // source checkout, parallel/<test> for the vendored tree — same
    // parallelDir detection as flagsFor, expressed relative to runDir.
    const relTest = join(parallelDir.slice(runDir.length + 1), test);
    const p = spawn(nodeBin, [...flags, relTest], {
      cwd: runDir,
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
    p.on("close", (code, signal) => {
      clearTimeout(timer);
      res({ test, flags, nativeExit: code === null ? (signal ? signalExit(signal) : -1) : code });
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
    { node: nodeVersion, generated: new Date().toISOString().slice(0, 10), counts, tests: results },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${outFile}: ${JSON.stringify(counts)}`);
