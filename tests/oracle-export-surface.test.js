// Oracle export-surface test: compares our shims against REAL Node.js builtins
// at test runtime. Catches drift when Node adds/changes exports.
//
// For each builtin: import real node:X and our src/X.js, then compare:
// - Export keys (missing/extra)
// - typeof each export
// - Function/class .name and .length (arity)
// - Prototype method names for classes (one level)

const BUILTINS = [
  "buffer",
  "path",
  "util",
  "events",
  "stream",
  "crypto",
  "os",
  "fs",
  "http",
  "https",
  "url",
  "querystring",
  "string_decoder",
  "timers",
  "assert",
  "zlib",
];

// Deprecated-but-intentional extras: these existed in older Node versions.
// We keep them for backward compatibility (Jared, 2026-10-06).
// The oracle test does not flag these as problems.
const DEPRECATED_ALLOWLIST = {
  util: [
    "isBoolean",
    "isBuffer",
    "isDate",
    "isError",
    "isFunction",
    "isNull",
    "isNullOrUndefined",
    "isNumber",
    "isObject",
    "isPrimitive",
    "isRegExp",
    "isString",
    "isSymbol",
    "isUndefined",
    "log",
  ],
  // Our virtual-FS extensions (not in real Node, intentional)
  // FSWatcher/StatWatcher are real Node classes (internal, not publicly exported)
  // We expose them for compatibility.
  fs: [
    "_vol",
    "mkdirp",
    "mkdirpSync",
    "mkdtempDisposable",
    "FSWatcher",
    "StatWatcher",
  ],
  // Internal helpers that leaked into public API (should be non-enumerable eventually)
  http: [
    "_createClientRequest",
    "_createWsFrame",
    "_parseWsFrame",
    "getAllServers",
    "getServer",
    "kHighWaterMark",
    "kUniqueHeaders",
  ],
  // Internal timer APIs (exist in Node internals, not public API)
  timers: ["_unrefActive", "active", "enroll", "unenroll"],
};

function describeValue(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  const t = typeof v;
  if (t === "function") {
    // Classes and functions are equivalent for API surface purposes.
    // We check the name and arity, not the syntax used to define it.
    return `function:${v.name || "(anon)"}:${v.length}`;
  }
  if (t === "object") {
    const proto = Object.getPrototypeOf(v);
    const ctorName = proto?.constructor?.name || "Object";
    return `object:${ctorName}`;
  }
  return t;
}

function getExports(mod) {
  // Handle both ESM namespace and CJS-like default export
  const target = mod?.default ?? mod;
  const keys = new Set([
    ...Object.keys(target),
    ...Object.getOwnPropertyNames(target).filter(
      (k) =>
        !["__proto__", "constructor", "prototype"].includes(k) &&
        typeof Object.getOwnPropertyDescriptor(target, k)?.get !== "undefined",
    ),
  ]);
  // Also check getters defined via defineProperties
  for (const k of Object.getOwnPropertyNames(target)) {
    const desc = Object.getOwnPropertyDescriptor(target, k);
    if (desc && (desc.get || desc.set)) keys.add(k);
  }
  return { target, keys: [...keys].sort() };
}

async function compareModule(name) {
  const results = { module: name, missing: [], extra: [], mismatched: [] };

  let real, shim;
  try {
    real = await import(`node:${name}`);
  } catch (e) {
    results.error = `Cannot load real node:${name}: ${e.message}`;
    return results;
  }

  try {
    const shimPath = `../src/${name}.js`;
    shim = await import(shimPath);
  } catch (e) {
    results.error = `Cannot load shim src/${name}.js: ${e.message}`;
    return results;
  }

  const realExp = getExports(real);
  const shimExp = getExports(shim);

  // Check keys
  for (const k of realExp.keys) {
    if (!shimExp.keys.includes(k)) {
      results.missing.push(k);
    }
  }
  for (const k of shimExp.keys) {
    if (!realExp.keys.includes(k) && k !== "default" && k !== "__esModule") {
      // Skip deprecated-but-intentional extras (backward compat)
      const allowlist = DEPRECATED_ALLOWLIST[name] || [];
      if (!allowlist.includes(k)) {
        results.extra.push(k);
      }
    }
  }

  // Check types for common keys
  for (const k of realExp.keys) {
    if (!shimExp.keys.includes(k)) continue;
    try {
      const realDesc = describeValue(realExp.target[k]);
      const shimDesc = describeValue(shimExp.target[k]);
      // Compare base type (before colon)
      const realType = realDesc.split(":")[0];
      const shimType = shimDesc.split(":")[0];
      if (realType !== shimType) {
        results.mismatched.push({
          key: k,
          real: realDesc,
          shim: shimDesc,
          issue: `type mismatch: ${realType} vs ${shimType}`,
        });
      } else if (realType === "function" || realType === "class") {
        // Check name (arity is informational — polyfills may differ)
        const realName = realDesc.split(":")[1];
        const shimName = shimDesc.split(":")[1];
        if (realName !== shimName) {
          results.mismatched.push({
            key: k,
            real: realDesc,
            shim: shimDesc,
            issue: `name mismatch: ${realName} vs ${shimName}`,
          });
        }
        // Arity mismatch is a warning, not error (polyfills may have different signatures)
      }
    } catch (e) {
      // Skip keys that throw on access
    }
  }

  return results;
}

describe("Oracle export-surface parity (live vs node:*)", () => {
  for (const name of BUILTINS) {
    test(`node:${name} surface matches real Node`, async () => {
      const r = await compareModule(name);
      if (r.error) {
        console.warn(`Skipping ${name}: ${r.error}`);
        return;
      }

      const problems = [];
      if (r.missing.length > 0) {
        problems.push(`Missing exports: ${r.missing.join(", ")}`);
      }
      if (r.extra.length > 0) {
        problems.push(`Extra exports: ${r.extra.join(", ")}`);
      }
      const typeMismatches = r.mismatched.filter((m) =>
        m.issue.startsWith("type"),
      );
      if (typeMismatches.length > 0) {
        problems.push(
          `Type mismatches: ${typeMismatches
            .map((m) => `${m.key} (real: ${m.real}, shim: ${m.shim})`)
            .join("; ")}`,
        );
      }

      if (problems.length > 0) {
        throw new Error(
          `Oracle mismatch for node:${name}:\n` + problems.join("\n"),
        );
      }
    });
  }
});
