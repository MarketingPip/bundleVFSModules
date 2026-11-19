// Dump the export surface of one Node builtin, as seen by real Node.
// Method: the repo's own oracle test (tests/oracle-export-surface.test.js) —
// Object.keys + getOwnPropertyNames incl. getters, typeof/name/arity per export.
// One extension: plain-object sub-namespaces (fs.promises, util.types, ...)
// are dumped one level deep.
// Usage: node dump-exports.mjs <module>  → JSON on stdout.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mod = process.argv[2];
if (!mod) {
  console.error("usage: node dump-exports.mjs <module>");
  process.exit(2);
}
const ns = require(`node:${mod}`);

function describeValue(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  const t = typeof v;
  if (t === "function") return `function:${v.name || "(anon)"}:${v.length}`;
  if (t === "object") {
    const proto = Object.getPrototypeOf(v);
    return `object:${proto?.constructor?.name || "Object"}`;
  }
  return t;
}

function getKeys(target) {
  const keys = new Set(Object.keys(target));
  for (const k of Object.getOwnPropertyNames(target)) {
    if (["__proto__", "constructor", "prototype"].includes(k)) continue;
    keys.add(k);
  }
  return [...keys].sort();
}

const out = { module: mod, node: process.version, exports: {}, sub: {} };
for (const k of getKeys(ns)) {
  try {
    out.exports[k] = describeValue(ns[k]);
  } catch {
    out.exports[k] = "throw";
  }
  // One level into plain-object sub-namespaces only. The `process` module is
  // excluded: its sub-objects (env, versions, config) are runtime state, not
  // API surface, and would show as drift on every run.
  if (mod === "process") continue;
  try {
    const v = ns[k];
    if (v !== null && typeof v === "object" && v.constructor === Object) {
      out.sub[k] = getKeys(v);
    }
  } catch {
    // Getter threw; ignore this sub-namespace.
  }
}
console.log(JSON.stringify(out));
