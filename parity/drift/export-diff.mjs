// Diff the export surface of the program modules between two real Node
// binaries (pinned v24.20.0 vs target Node 26.x) and write a checked-in
// markdown diff plus the raw JSON dumps.
//
// Method: for each module, run parity/drift/dump-exports.mjs under each
// binary (that probe reuses the repo oracle test's method —
// tests/oracle-export-surface.test.js: Object.keys + getOwnPropertyNames
// incl. getters, typeof/name/arity per export, one level into plain-object
// sub-namespaces). The diff is presence + describeValue per top-level export.
// What it catches: added/removed exports, type/name/arity changes,
// sub-namespace additions. What it CANNOT catch (documented): behaviour
// changes with no surface change (error codes, validation order, defaults),
// prototype-method changes inside classes, and anything behind a flag.
// Usage:
//   node parity/drift/export-diff.mjs --node24 <path> --node26 <path>
//     [--out-md parity/drift/node26-export-diff.md]
//     [--json24 parity/drift/exports-node24.20.0.json]
//     [--json26 parity/drift/exports-node26.13.1.json]
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const probe = join(dirname(fileURLToPath(import.meta.url)), "dump-exports.mjs");

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const node24Bin = arg("--node24", null);
const node26Bin = arg("--node26", null);
if (!node24Bin || !node26Bin) {
  console.error(
    "usage: node parity/drift/export-diff.mjs --node24 <path> --node26 <path> [--out-md <path>] [--json24 <path>] [--json26 <path>]",
  );
  process.exit(2);
}

function dump(bin, mod) {
  const r = spawnSync(bin, [probe, mod], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`dump failed for ${mod} under ${bin}: ${r.stderr || r.status}`);
  }
  return JSON.parse(r.stdout);
}

function diffModule(a, b) {
  // a = 24 dump, b = 26 dump. Returns {added, removed, changed, subAdded, subRemoved}.
  const added = [];
  const removed = [];
  const changed = [];
  for (const k of Object.keys(b.exports)) {
    if (!(k in a.exports)) added.push(k);
    else if (a.exports[k] !== b.exports[k]) {
      changed.push({ key: k, from: a.exports[k], to: b.exports[k] });
    }
  }
  for (const k of Object.keys(a.exports)) {
    if (!(k in b.exports)) removed.push(k);
  }
  const subAdded = {};
  const subRemoved = {};
  for (const ns of Object.keys(b.sub)) {
    if (!(ns in a.sub)) continue; // the namespace itself is new: covered by top-level `added`
    const add = b.sub[ns].filter((k) => !a.sub[ns].includes(k));
    const rem = a.sub[ns].filter((k) => !b.sub[ns].includes(k));
    if (add.length) subAdded[ns] = add;
    if (rem.length) subRemoved[ns] = rem;
  }
  return { added, removed, changed, subAdded, subRemoved };
}

const dumps24 = {};
const dumps26 = {};
let v24 = null;
let v26 = null;
for (const mod of MODULES) {
  const d24 = dump(node24Bin, mod);
  const d26 = dump(node26Bin, mod);
  v24 ??= d24.node;
  v26 ??= d26.node;
  dumps24[mod] = d24;
  dumps26[mod] = d26;
  console.log(`${mod}: 24=${Object.keys(d24.exports).length} exports, 26=${Object.keys(d26.exports).length} exports`);
}

const outMd = arg("--out-md", join(repoRoot, "parity", "drift", "node26-export-diff.md"));
const outJson24 = arg("--json24", join(repoRoot, "parity", "drift", `exports-${v24.replace(/^v/, "node")}.json`));
const outJson26 = arg("--json26", join(repoRoot, "parity", "drift", `exports-${v26.replace(/^v/, "node")}.json`));

writeFileSync(outJson24, JSON.stringify({ node: v24, generated: new Date().toISOString().slice(0, 10), modules: dumps24 }, null, 2) + "\n");
writeFileSync(outJson26, JSON.stringify({ node: v26, generated: new Date().toISOString().slice(0, 10), modules: dumps26 }, null, 2) + "\n");

const rows = [];
const details = [];
let totAdd = 0;
let totRem = 0;
let totChg = 0;
let totSubAdd = 0;
let totSubRem = 0;
const noChange = [];
for (const mod of MODULES) {
  const d = diffModule(dumps24[mod], dumps26[mod]);
  const subAddN = Object.values(d.subAdded).reduce((n, a) => n + a.length, 0);
  const subRemN = Object.values(d.subRemoved).reduce((n, a) => n + a.length, 0);
  totAdd += d.added.length;
  totRem += d.removed.length;
  totChg += d.changed.length;
  totSubAdd += subAddN;
  totSubRem += subRemN;
  rows.push(`| ${mod} | ${d.added.length} | ${d.removed.length} | ${d.changed.length} | ${subAddN} | ${subRemN} |`);
  if (!d.added.length && !d.removed.length && !d.changed.length && !subAddN && !subRemN) {
    noChange.push(mod);
    continue;
  }
  const lines = [`## ${mod}`, ""];
  if (d.added.length) lines.push(`Added: ${d.added.map((k) => "`" + k + "`").join(", ")}`, "");
  if (d.removed.length) lines.push(`Removed: ${d.removed.map((k) => "`" + k + "`").join(", ")}`, "");
  if (d.changed.length) {
    lines.push("Changed:");
    for (const c of d.changed) lines.push(`- \`${c.key}\`: \`${c.from}\` → \`${c.to}\``);
    lines.push("");
  }
  for (const ns of Object.keys(d.subAdded)) {
    lines.push(`Sub \`${ns}\` added: ${d.subAdded[ns].map((k) => "`" + k + "`").join(", ")}`, "");
  }
  for (const ns of Object.keys(d.subRemoved)) {
    lines.push(`Sub \`${ns}\` removed: ${d.subRemoved[ns].map((k) => "`" + k + "`").join(", ")}`, "");
  }
  details.push(lines.join("\n"));
}

const md = `# Node 26 export-surface diff (${v24} → ${v26})

Generated ${new Date().toISOString().slice(0, 10)} by \`parity/drift/export-diff.mjs\`
(\`--node24\` ${v24}, \`--node26\` ${v26}).

Method: for each of the 28 program modules, the export surface was dumped from
real Node on both versions (probe \`parity/drift/dump-exports.mjs\`, reusing the
repo oracle test's method — \`tests/oracle-export-surface.test.js\`: own
property names incl. getters, typeof/name/arity per export, one level into
plain-object sub-namespaces such as \`fs.promises\`). The diff is presence +
describeValue per top-level export.

What this catches: added/removed exports, type/name/arity changes,
sub-namespace additions. What it CANNOT catch: behaviour changes with no
surface change (error codes, validation order, defaults), prototype-method
changes inside classes, and anything behind a flag. Those need the baseline
(\`parity/drift/node26-baseline.jsonc\`) and the drift research
(\`~/workspace/research_notes/node-24-to-26-drift-20261119-1722/report.md\`).

## Totals

| module | added | removed | changed | sub-added | sub-removed |
| --- | ---: | ---: | ---: | ---: | ---: |
${rows.join("\n")}

**Total: ${totAdd} added, ${totRem} removed, ${totChg} changed, ${totSubAdd} sub-added, ${totSubRem} sub-removed across 28 modules.**

## No change

${noChange.length ? noChange.map((m) => "`" + m + "`").join(", ") : "(none — every module changed)"}

${details.join("\n")}
`;
writeFileSync(outMd, md);
console.log(`wrote ${outMd} (${totAdd} added, ${totRem} removed, ${totChg} changed)`);
console.log(`wrote ${outJson24}`);
console.log(`wrote ${outJson26}`);
