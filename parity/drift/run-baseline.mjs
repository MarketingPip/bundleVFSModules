// Baseline runner: stage a Node test tree into a THROWAWAY worktree's
// parity/node-test/ (parallel + common + fixtures), run the per-module
// test files under the parity harness, aggregate exit codes into a
// Deno-style allow-list baseline (parity/drift/node<TARGET>-baseline.jsonc),
// then restore parity/node-test/ to its committed state.
//
// --target selects the tree AND the shim behaviour under test:
//   26 (default): the Node 26.13.1 tree from --node26-src (a Node source
//     checkout), shims run with PARITY_TARGET_NODE=26 (the default).
//   24: the vendored v24.20.0 tree (parity/node-test/ as committed —
//     snapshotted before staging, no download needed), shims run with
//     PARITY_TARGET_NODE=24, so the run measures the down-versioned build,
//     not the 26 build against v24 tests (the gate's harness override;
//     src/version-gate.js). --node-src may point at a 24.20.0 source
//     checkout instead of the vendored snapshot.
//
// The runner loop mirrors fast-sweep.py / sweep-mjs.py run_one/run_phase
// exactly (PARITY_TARGET=<module>, `timeout N node [flags from the test's
// // Flags: header] --import <absolute preload>
// parity/node-test/parallel/<test>`, phase 1 short timeout, phase 2
// full timeout only for 124s, signal -> 128+N) so results are comparable
// with the pinned sweeps — but it is self-contained (no dependency on the
// goal hidden_files runners) so the CI drift job can run it. Flags the host
// Node cannot parse (a 25/26-only flag on the v24 host) are dropped with a
// log line — see isFlagSupported below — never passed through to die as a
// bogus "bad option" failure.
//
// SAFETY: refuses unless `git status --porcelain -- parity/node-test` in the
// worktree is empty, and restores the directory afterwards (tracked files via
// `git checkout --`, untracked staged files via explicit deletion of exactly
// the paths it staged). NEVER point this at a worktree with uncommitted work
// under parity/node-test/. Also refuses (preflight) if the worktree cannot
// resolve the shims' npm deps — without node_modules every shim-loading test
// fails ERR_MODULE_NOT_FOUND, which reads as a catastrophic baseline instead
// of the setup error it is (caught live: fs 0/385 before the fix).
//
// Usage:
//   node parity/drift/run-baseline.mjs [--target 24|26]
//     --worktree <dir> --out <jsonc> --csv-dir <dir> [--jobs 2]
//     [--modules fs,http] [--short 10] [--full 30]
//     [--node26-src <dir>] [--node-src <dir>]
//   Target 26 (default) requires --node26-src (or --node-src): a Node
//   26.13.1 source checkout. Target 24 defaults to the worktree's
//   committed parity/node-test/ tree; --node-src overrides it with a
//   24.20.0 source checkout. --node26-src with --target 24 is an error.
import { spawnSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const MODULES = [
  "assert",
  "async_hooks",
  "buffer",
  "console",
  "crypto",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "perf_hooks",
  "process",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "timers",
  "trace_events",
  "tty",
  "util",
  "vm",
  "worker_threads",
  "zlib",
];

// Test-file prefixes per module. Most modules use their own name; some need
// extra prefixes for files the program already counts (the fast-sweep
// glob/target coupling gap — same as the pinned suite). The extras are the
// Wave 4 fold-in groups, measured by hand with isolated recipes before this
// fix: events' singular test-event-* files, the two test-eventsource* files
// (never touch the shim) and test-eventemitter-asyncresource.js; async_hooks'
// test-async-local-storage-* files; and the test-diagnostics-channel-*
// files for http2, module and worker_threads. A prefix matches
// `test-<prefix>-*` plus the bare `test-<prefix>.js`.
export const PREFIXES = {
  async_hooks: ["async-hooks", "async-local-storage"],
  events: ["events", "event", "eventsource", "eventemitter"],
  http2: ["http2", "diagnostics-channel-http2"],
  module: ["module", "diagnostics-channel-module"],
  perf_hooks: ["perf-hooks"],
  string_decoder: ["string-decoder"],
  trace_events: ["trace-events"],
  worker_threads: ["worker", "diagnostics-channel-worker"],
};

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// ponytail: one map is the whole target table — a third target (Node 27 at
// LTS) adds one line here plus its tree source, never a new branch of the
// runner. The version strings are the pinned releases the artifacts record.
const TARGETS = { 24: "24.20.0", 26: "26.13.1" };
const target = arg("--target", "26");
if (!(target in TARGETS)) {
  console.error(`--target must be 24 or 26, got ${JSON.stringify(target)}`);
  process.exit(2);
}
const nodeVersion = TARGETS[target];
const nodeSrcArg = arg("--node-src", null);
const node26SrcArg = arg("--node26-src", null);
if (target === "24" && node26SrcArg) {
  console.error("--node26-src is only valid with --target 26 (use --node-src for target 24)");
  process.exit(2);
}
const nodeSrc = target === "26" ? (nodeSrcArg ?? node26SrcArg) : nodeSrcArg;
// createRequire (preflight below) and git -C need an absolute worktree:
// a relative --worktree (drift.yaml passes `--worktree .`) made
// createRequire throw, which the preflight mis-reported as missing
// node_modules. resolve() here; --out/--csv-dir stay cwd-relative.
const worktreeArg = arg("--worktree", null);
const worktree = worktreeArg ? resolve(worktreeArg) : null;
const outFile = arg("--out", null);
const csvDir = arg("--csv-dir", null);
const jobs = parseInt(arg("--jobs", "2"), 10);
const shortS = parseInt(arg("--short", "10"), 10);
const fullS = parseInt(arg("--full", "30"), 10);
const onlyModules = arg("--modules", null)?.split(",").filter(Boolean) ?? null;
if ((target === "26" && !nodeSrc) || !worktree || !outFile || !csvDir) {
  console.error(
    "usage: node parity/drift/run-baseline.mjs [--target 24|26] --worktree <dir> --out <jsonc> --csv-dir <dir> [--jobs N] [--modules a,b] [--short N] [--full N] [--node26-src <dir>] [--node-src <dir>]",
  );
  process.exit(2);
}

const modules = onlyModules ?? MODULES;
const parallelDir = join(worktree, "parity", "node-test", "parallel");
const commonDir = join(worktree, "parity", "node-test", "common");
const fixturesDir = join(worktree, "parity", "node-test", "fixtures");
const preload = join(worktree, "parity", "preload.mjs");

function git(...args) {
  return spawnSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
}

// --- stage / restore -------------------------------------------------------
// Test-tree layout differs by source shape: a Node source checkout keeps
// the tree under test/{parallel,common,fixtures}; the vendored v24 tree
// keeps it directly under parity/node-test/{parallel,common,fixtures}.
// Detect it from the directory itself (same as run-oracle.mjs), so
// --node-src works for either shape on either target — branching on the
// target here would mis-stage a source checkout passed for target 24.
function treeDirs(srcRoot) {
  if (existsSync(join(srcRoot, "test", "parallel"))) {
    return {
      parallel: join(srcRoot, "test", "parallel"),
      common: join(srcRoot, "test", "common"),
      fixtures: join(srcRoot, "test", "fixtures"),
    };
  }
  return {
    parallel: join(srcRoot, "parallel"),
    common: join(srcRoot, "common"),
    fixtures: join(srcRoot, "fixtures"),
  };
}

function stage() {
  const st = git("status", "--porcelain", "--", "parity/node-test");
  if (st.status !== 0) throw new Error(`git status failed: ${st.stderr}`);
  if (st.stdout.trim() !== "") {
    throw new Error("refusing: parity/node-test/ has uncommitted changes in the worktree");
  }
  const before = git("ls-files", "-z", "--", "parity/node-test")
    .stdout.split("\0")
    .map((l) => l.trim())
    .filter(Boolean);
  // Target 24 with no --node-src stages from the worktree's own committed
  // tree: snapshot it first (the preflight above verified it is clean, so
  // the snapshot is exactly HEAD), because staging deletes the destination
  // dirs before copying. The snapshot is removed in main's finally.
  let snapshot = null;
  let srcRoot = nodeSrc;
  if (target === "24" && !nodeSrc) {
    snapshot = mkdtempSync(join(tmpdir(), "node24-tree-"));
    for (const d of ["parallel", "common", "fixtures"]) {
      cpSync(join(worktree, "parity", "node-test", d), join(snapshot, d), { recursive: true });
    }
    srcRoot = snapshot;
  }
  const src = treeDirs(srcRoot);
  const staged = [];
  for (const [s, dst] of [
    [src.parallel, parallelDir],
    [src.common, commonDir],
    [src.fixtures, fixturesDir],
  ]) {
    rmSync(dst, { recursive: true, force: true });
    cpSync(s, dst, { recursive: true });
    staged.push(dst);
  }
  return { before: new Set(before), staged, snapshot };
}

function restore(state) {
  const co = git("checkout", "--", "parity/node-test");
  if (co.status !== 0) throw new Error(`restore git checkout failed: ${co.stderr}`);
  // Delete exactly the staged paths that are not tracked files (Node 26 test
  // files that do not exist in the vendored set). Explicit list, no bulk clean.
  const after = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else after.push(p);
    }
  };
  for (const d of [parallelDir, commonDir, fixturesDir]) walk(d);
  const rel = (p) => p.slice(worktree.length + 1);
  let removed = 0;
  for (const p of after) {
    if (!state.before.has(rel(p))) {
      rmSync(p, { force: true });
      removed++;
    }
  }
  const st = git("status", "--porcelain", "--", "parity/node-test");
  if (st.stdout.trim() !== "") {
    console.warn("WARN: parity/node-test/ not clean after restore:\n" + st.stdout);
  } else {
    console.log(`restore: parity/node-test/ clean (${removed} staged-only files removed)`);
  }
}

// --- // Flags: headers ------------------------------------------------------
// Mirrors run-oracle.mjs flagsFor: Node test files declare CLI flags in a
// `// Flags:` header comment (same format Node itself uses), and the oracle
// already passes them through. The baseline did NOT — a test needing a flag
// was run without it and mis-measured (e.g. a test requiring internals
// failed before its first assertion). Read the header from the STAGED file:
// parallelDir holds the target's tree after stage() (Node 26.13.1 for
// --target 26, v24.20.0 for --target 24).
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

// The harness runs Node 26 tests under the HOST Node (v24.22.1 here), and a
// flag added in 25/26 does not exist there: the child dies at startup with
// "bad option" (exit 9) and the test is mis-measured as a shim failure.
// Probe each distinct flag once (cached); drop only on positive evidence of
// rejection (exit 9 + "bad option" on stderr). Any other probe outcome —
// including a probe timeout — passes the flag through, so a probe failure
// can never silently change a test's invocation.
const flagSupportCache = new Map();
const droppedFlags = new Set();
function isFlagSupported(flag) {
  if (flagSupportCache.has(flag)) return flagSupportCache.get(flag);
  let ok = true;
  try {
    const r = spawnSync("node", [flag, "-e", ""], { encoding: "utf8", timeout: 10000 });
    ok = !(r.status === 9 && /bad option/.test(r.stderr ?? ""));
  } catch {
    ok = true; // probe failure (e.g. timeout) is not evidence of rejection
  }
  flagSupportCache.set(flag, ok);
  if (!ok && !droppedFlags.has(flag)) {
    droppedFlags.add(flag);
    console.log(`flags: host rejects ${flag} — dropping it (test runs as before)`);
  }
  return ok;
}

// --- runner (mirrors fast-sweep.py run_one/run_phase) -----------------------
// Signal numbers (POSIX): a child killed by a signal reports code === null
// and the signal NAME on the close event. Record the shell convention
// 128+N so the recorded exit says which signal killed it (SIGKILL 137,
// SIGTERM 143, SIGABRT 134, SIGSEGV 139, ...). Previously every signal
// recorded a hardcoded 129, which is only correct for SIGHUP — the
// baseline's nine 129s hid real 134s, 137s and 139s (see NOTES,
// "Signal-death adjudication"). Unknown signal → -1, matching the
// spawn-error path.
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

// ponytail: the runner's `target` parameter below is the MODULE name
// (PARITY_TARGET); the drift target (24/26) is the outer `target` const.
// Renamed the parameter to `mod` so the two can never be confused again.
function runOne(test, timeoutS, mod) {
  return new Promise((res) => {
    const flags = flagsFor(test).filter(isFlagSupported);
    const p = spawn(
      "timeout",
      [String(timeoutS), "node", ...flags, "--import", preload, `parity/node-test/parallel/${test}`],
      // PARITY_TARGET_NODE selects the shim behaviour under test
      // (src/version-gate.js harness override): the --target value, never
      // an ambient env value — an explicit flag beats the shell. For 26
      // this is the gate's default, so the 26 path is unchanged.
      { cwd: worktree, env: { ...process.env, PARITY_TARGET: mod, PARITY_TARGET_NODE: target }, stdio: "ignore" },
    );
    p.on("error", () => res(-1));
    p.on("close", (code, signal) => {
      if (code === null) res(signal ? signalExit(signal) : -1);
      else res(code);
    });
  });
}

async function runPhase(tests, timeoutS, mod, label) {
  const results = {};
  let idx = 0;
  let done = 0;
  const workers = Array.from({ length: Math.max(1, jobs) }, async () => {
    while (idx < tests.length) {
      const t = tests[idx++];
      results[t] = await runOne(t, timeoutS, mod);
      done++;
      if (done % 50 === 0 || done === tests.length) {
        console.log(`[${label}] ${done}/${tests.length}`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function runModule(mod) {
  const prefixes = PREFIXES[mod] ?? [mod];
  const files = readdirSync(parallelDir)
    .filter((f) =>
      prefixes.some((p) => f.startsWith(`test-${p}-`) || f === `test-${p}.js`),
    )
    .sort();
  if (!files.length) {
    console.log(`${mod}: no test files (prefixes ${prefixes.join(", ")})`);
    return {};
  }
  console.log(`${mod}: ${files.length} files`);
  const p1 = await runPhase(files, shortS, mod, `${mod} phase1`);
  const needFull = files.filter((t) => p1[t] === 124);
  const final = { ...p1 };
  if (needFull.length) {
    console.log(`${mod}: phase2: ${needFull.length} hit the ${shortS}s cap; re-running at ${fullS}s`);
    const p2 = await runPhase(needFull, fullS, mod, `${mod} phase2`);
    Object.assign(final, p2);
  }
  return final;
}

// --- main ------------------------------------------------------------------
// Preflight: the shims import npm deps (memfs, pako, dns-packet, ...) from the
// worktree's node_modules. A worktree without the symlink makes every test
// that loads a shim fail ERR_MODULE_NOT_FOUND — refuse before staging.
try {
  createRequire(join(worktree, "package.json")).resolve("memfs");
} catch {
  console.error(
    `refusing: cannot resolve 'memfs' from ${worktree} — the worktree has no usable node_modules. ` +
      `Symlink it from the main checkout (ln -s <checkout>/node_modules ${join(worktree, "node_modules")}) and re-run.`,
  );
  process.exit(2);
}

const state = stage();
const aggregate = {};
try {
  mkdirSync(csvDir, { recursive: true });
  for (const mod of modules) {
    const results = await runModule(mod);
    const rows = Object.keys(results).sort();
    const csv = ["test,exit", ...rows.map((t) => `${t},${results[t]}`)].join("\n") + "\n";
    writeFileSync(join(csvDir, `node${target}-baseline-${mod}.csv`), csv);
    const counts = { total: rows.length, pass: 0, fail: 0, timeout: 0 };
    const tests = {};
    for (const t of rows) {
      const code = results[t];
      const status = code === 0 ? "pass" : code === 124 ? "timeout" : "fail";
      counts[status]++;
      tests[t] = { status, exit: code };
    }
    aggregate[mod] = { ...counts, tests };
    console.log(`${mod}: ${counts.pass}/${counts.total} pass, ${counts.fail} fail, ${counts.timeout} timeout`);
  }
} finally {
  restore(state);
  if (state.snapshot) rmSync(state.snapshot, { recursive: true, force: true });
}

const head = git("rev-parse", "HEAD").stdout.trim();
const baseline = {
  node: nodeVersion,
  host: spawnSync("node", ["--version"], { encoding: "utf8" }).stdout.trim(),
  generated: new Date().toISOString().slice(0, 10),
  worktree: head,
  modules: aggregate,
};
const header = `// Node ${target} baseline: Node v${nodeVersion} test/parallel files for the 28 program
// modules, run under the parity harness (PARITY_TARGET per module, preload,
// PARITY_TARGET_NODE=${target}) on host ${baseline.host}. Each test is run
// with its // Flags: header flags (a flag the host Node cannot parse is
// dropped and logged, not passed through). Status per test: "pass" (exit 0),
// "fail" (any other non-zero exit), "timeout" (exit 124).
// "fail" means "does not pass under the shims" — NOT "the shim is wrong": a
// test can fail because it needs a newer API, a newer test/common helper, or
// a feature the shim never implemented. Reasons are added per test as lanes
// triage them; until then the exit code is the reason.
`;
writeFileSync(outFile, header + JSON.stringify(baseline, null, 2) + "\n");
const tot = Object.values(aggregate).reduce(
  (a, m) => ({ total: a.total + m.total, pass: a.pass + m.pass, fail: a.fail + m.fail, timeout: a.timeout + m.timeout }),
  { total: 0, pass: 0, fail: 0, timeout: 0 },
);
console.log(`wrote ${outFile}: ${tot.pass}/${tot.total} pass, ${tot.fail} fail, ${tot.timeout} timeout`);
