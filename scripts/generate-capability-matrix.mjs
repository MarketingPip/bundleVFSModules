#!/usr/bin/env node
// Capability-matrix generator for bundleVFSModules.
//
// Derives a module × API × status matrix from code alone:
//   - API universe per module: real Node's exports for `node:<module>` (CJS
//     keys + ESM namespace keys, excluding "default" and internals starting
//     with "_"), plus one level of prototype methods for class exports.
//   - Shim surface: export names extracted from the shim's source text,
//     supplemented by a disposable child-process probe of the module's
//     runtime exports (shims replace host globals, so they are never
//     loaded into the generator's own process).
//   - Status: absent -> unsupported; empty/constant body -> honest-noop;
//     single throw of a not-implemented error -> unsupported; otherwise
//     implemented. Function bodies are extracted from src source text, not
//     runtime inspection.
//
// Usage: node scripts/generate-capability-matrix.mjs
//   [--matrix <docs/CAPABILITY_MATRIX.md>]
//   [--json  <docs/capability-matrix.json>]
//   [--notes <NOTES-capability-matrix.md>]
//
// Writes three artifacts (human + machine + derivation notes). Re-running
// must produce byte-identical output.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const srcDir = path.join(repoRoot, "src");
const require = createRequire(import.meta.url);

// Capture the real Node process BEFORE any src module is loaded:
// src/process.js replaces globalThis.process with the shim's process
// object (whose version is "v0.0.0-shim"), which would corrupt every
// later process.* read in this script — including process.exit, whose
// shim version does not terminate the process.
const REAL_PROCESS = process;
const ORACLE_NODE_VERSION = process.version;

// ---------------------------------------------------------------------------
// 1. API universe from real Node (CJS + ESM union, minus default/internals)
// ---------------------------------------------------------------------------

// The matrix covers Node.js builtin modules that this repo ships a
// shim for. The builtin set comes from the oracle itself
// (module.builtinModules); src files that are not Node builtins
// (browser helpers, bundler plugins, service workers) are reported
// as excluded — never silently dropped, never presented as modules.
const SUBPATH_FILES = { "stream-consumers": "stream/consumers" };
function publicModules() {
  const builtins = new Set(
    require("node:module")
      .builtinModules.map((m) => m.replace(/^node:/, ""))
      .filter((m) => !m.startsWith("internal/")),
  );
  const entries = [];
  const excluded = [];
  for (const f of fs.readdirSync(srcDir).sort()) {
    if (!f.endsWith(".js") || f.startsWith("_")) continue;
    const base = f.replace(/\.js$/, "");
    const name = SUBPATH_FILES[base] || base;
    if (builtins.has(name)) entries.push({ name, file: f });
    else excluded.push({ file: f, reason: "not a Node.js builtin module" });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { entries, excluded };
}

// Build the union of CJS enumerable keys + ESM namespace keys for a module.
// Excludes "default" and internal keys starting with "_". Enumerable keys
// only: getOwnPropertyNames would add function artefacts ("length",
// "name") for function-valued module exports such as node:assert.
async function nodeApiUniverse(mod) {
  const union = new Set();
  try {
    const cjs = require(`node:${mod}`);
    if (cjs && (typeof cjs === "object" || typeof cjs === "function")) {
      for (const k of Object.keys(cjs)) union.add(k);
    }
  } catch {
    /* some modules aren't requireable as CJS — the ESM import may cover them */
  }
  try {
    const ns = await import(`node:${mod}`);
    for (const k of Object.keys(ns)) union.add(k);
  } catch {
    /* not importable either — the universe stays whatever CJS gave */
  }
  for (const k of [...union]) {
    if (k === "default" || k.startsWith("_")) union.delete(k);
  }
  return [...union].sort();
}

// One level of prototype methods for class exports.
function classProtoMethods(mod, apiName) {
  const methods = [];
  let ctor;
  try {
    ctor = eval(`require("node:${mod}").${apiName}`);
  } catch {
    return methods;
  }
  if (typeof ctor === "function" && ctor.prototype) {
    for (const k of Object.getOwnPropertyNames(ctor.prototype)) {
      if (k === "constructor") continue;
      if (k.startsWith("_")) continue;
      methods.push(k);
    }
  }
  return methods;
}

// ---------------------------------------------------------------------------
// 2. Shim surface extraction from src source text
// ---------------------------------------------------------------------------

// Extract exported names from the ESM source text of a shim module.
// Handles: export function, export class, export const/let/var,
// export { a, b as c }, export default, re-export from.
function shimExports(src) {
  const names = new Set();
  const lines = src.split("\n");
  // We do a token-aware scan rather than regex to handle multi-line exports.
  // Strategy: walk top-level export declarations.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    // export async function foo / export function foo
    let m = stripped.match(
      /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    );
    if (m) {
      names.add(m[1]);
      continue;
    }
    // export class Foo
    m = stripped.match(/^export\s+class\s+([A-Za-z_$][\w$]*)/);
    if (m) {
      names.add(m[1]);
      continue;
    }
    // export const foo / export let foo / export var foo
    m = stripped.match(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (m) {
      names.add(m[1]);
      continue;
    }
    // export { a, b as c } (possibly multi-line)
    if (/^export\s*\{/.test(stripped)) {
      let buf = stripped;
      let j = i;
      while (!buf.includes("}") && j + 1 < lines.length) {
        j++;
        buf += " " + lines[j].trim();
      }
      const bm = buf.match(/export\s*\{([^}]*)\}/);
      if (bm) {
        for (const part of bm[1].split(",")) {
          const t = part.trim().split(/\s+as\s+/);
          const nm = (t[1] || t[0] || "").trim();
          if (/^[A-Za-z_$][\w$]*$/.test(nm)) names.add(nm);
        }
      }
    }
    // export * from / export { x } from
    if (
      /^export\s+\*/.test(stripped) ||
      /^export\s*\{.*\}\s*from/.test(stripped)
    ) {
      // re-export: cannot determine names without resolving the source —
      // mark as re-export (handled by caller via note). Skip name extraction.
      continue;
    }
    // export default
    if (/^export\s+default\b/.test(stripped)) {
      names.add("default");
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// 3. Function-body extraction & classification
// ---------------------------------------------------------------------------

// Find the source span of an exported binding's definition.
// Returns { start, end, kind } where kind is "function"|"class"|"const"|
// "re-export"|null. For const/let/var we grab the initializer expression
// when it's a function/class.
function findExportBody(src, name) {
  // export async function foo(...) { ... }
  // export function* foo(...) { ... }
  // export function foo(...) { ... }
  let re = new RegExp(
    `export\\s+(?:async\\s+)?function\\s*\\*?\\s*${escapeRegex(name)}\\s*\\(`,
  );
  let m = src.match(re);
  if (m) return findFunctionBody(src, m.index);

  // export class Foo ... { ... }  /  export class Foo extends X { ... }
  re = new RegExp(`export\\s+class\\s+${escapeRegex(name)}\\b`);
  m = src.match(re);
  if (m) return findClassBody(src, m.index);

  // export const foo = (...) => ... / function expression / class expression
  re = new RegExp(`export\\s+(?:const|let|var)\\s+${escapeRegex(name)}\\s*=`);
  m = src.match(re);
  if (m) return findInitializerBody(src, m.index);

  // export { foo }  (re-exported from local) — try to find `function foo`
  // or `const foo =` locally.
  re = new RegExp(`function\\s+${escapeRegex(name)}\\s*\\(`);
  m = src.match(re);
  if (m) return findFunctionBody(src, m.index);

  re = new RegExp(`(?:const|let|var)\\s+${escapeRegex(name)}\\s*=`);
  m = src.match(re);
  if (m) return findInitializerBody(src, m.index);

  // Bare class declaration (exported via a separate export list).
  re = new RegExp(`class\\s+${escapeRegex(name)}\\b`);
  m = src.match(re);
  if (m) return findClassBody(src, m.index);

  // Not found in source (re-export from another module, or computed).
  return null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Given index of `function name(` (or `export ... function name(`), find the
// body between balanced braces.
function findFunctionBody(src, startIdx) {
  let i = src.indexOf("(", startIdx);
  if (i === -1) return null;
  // skip balanced parens
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  // now i is just past the closing paren; find the body brace
  const braceIdx = src.indexOf("{", i);
  if (braceIdx === -1) return null;
  return extractBracedSpan(src, braceIdx);
}

// Given index of `class Foo`, find the class body (everything to the closing
// brace of the class block).
function findClassBody(src, startIdx) {
  // skip "class Foo" possibly "extends X"
  let i = src.indexOf("{", startIdx);
  if (i === -1) return null;
  return extractBracedSpan(src, i);
}

// For `export const foo = ...`, find the initializer expression.
function findInitializerBody(src, startIdx) {
  // startIdx points at "export" or "const"; find the "="
  let i = src.indexOf("=", startIdx);
  if (i === -1) return null;
  i++;
  // skip whitespace
  while (i < src.length && /\s/.test(src[i])) i++;
  // If it's an arrow function or function expression, grab its body
  if (src[i] === "(" || src.slice(i, i + 8) === "function") {
    // arrow: (...) => ...  OR  function expr: function(...) {...}
    if (src.slice(i, i + 8) === "function") {
      return findFunctionBody(src, i);
    }
    // arrow function
    let p = src.indexOf("(", i);
    let depth = 0;
    for (; p < src.length; p++) {
      if (src[p] === "(") depth++;
      else if (src[p] === ")") {
        depth--;
        if (depth === 0) {
          p++;
          break;
        }
      }
    }
    // skip to =>
    let arrow = src.indexOf("=>", p);
    if (arrow === -1) return null;
    arrow += 2;
    while (arrow < src.length && /\s/.test(src[arrow])) arrow++;
    if (src[arrow] === "{") return extractBracedSpan(src, arrow);
    // expression body — single expression, treat as the body
    return extractExpression(src, arrow);
  }
  // Other initializer (e.g. a value, object) — return the expression span
  return extractExpression(src, i);
}

// Extract a balanced { ... } span starting at braceIdx (inclusive).
function extractBracedSpan(src, braceIdx) {
  let depth = 0;
  for (let i = braceIdx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return { start: braceIdx, end: i + 1 };
    }
  }
  return null;
}

// Extract a single expression (until ; or newline at top level or EOF).
function extractExpression(src, start) {
  let i = start;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if ((c === ";" || c === "\n") && depth === 0) break;
    i++;
  }
  return { start, end: i };
}

// Get the body text of an export (the inner content of the function/class,
// or the initializer expression for const).
function bodyText(src, span) {
  if (!span) return null;
  return src.slice(span.start, span.end);
}

// One level of local sources for body lookup: the module's own file
// plus every file it imports from or re-exports. Relative specifiers
// resolve against the importing file; `node:<builtin>` maps to that
// builtin's shim file — the same mapping the runtime's loader applies
// (e.g. src/sys.js re-exports node:util, whose definition bodies live
// in src/util.js). Bare package specifiers are not followed: bodies
// inside node_modules are not ours to classify.
function moduleSources(mainFile, mainSrc) {
  const sources = [{ file: mainFile, src: mainSrc }];
  const seen = new Set([mainFile]);
  const specRe = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = specRe.exec(mainSrc)) !== null) {
    const spec = m[1];
    let resolved = null;
    if (spec.startsWith("./") || spec.startsWith("../")) {
      resolved = path.resolve(path.dirname(mainFile), spec);
    } else if (spec.startsWith("node:")) {
      const name = spec.slice(5);
      const base =
        Object.keys(SUBPATH_FILES).find((k) => SUBPATH_FILES[k] === name) ||
        name;
      resolved = path.join(srcDir, base + ".js");
    }
    if (!resolved) continue;
    if (!resolved.endsWith(".js")) resolved += ".js";
    if (seen.has(resolved) || !fs.existsSync(resolved)) continue;
    seen.add(resolved);
    try {
      sources.push({ file: resolved, src: fs.readFileSync(resolved, "utf8") });
    } catch {
      /* unreadable — skip */
    }
  }
  return sources;
}

// local name -> original name, from `import { orig as local }` and
// `export { orig as local } from ...` statements in the main source.
function importAliases(mainSrc) {
  const map = new Map();
  const stmtRe =
    /(?:import|export)\s*\{([^}]*)\}(?:\s*from\s*['"][^'"]+['"])?/g;
  let m;
  while ((m = stmtRe.exec(mainSrc)) !== null) {
    for (const part of m[1].split(",")) {
      const am = /^\s*([\w$]+)\s+as\s+([\w$]+)\s*$/.exec(part);
      if (am) map.set(am[2], am[1]);
    }
  }
  return map;
}

// Find an export's body across the module's source set: the main file
// first, then (under the original name, if aliased) the followed
// sources, then the plain name in the followed sources.
function findBodyText(sources, aliases, name) {
  const main = sources[0];
  let span = findExportBody(main.src, name);
  if (span) return bodyText(main.src, span);
  const original = aliases.get(name) || name;
  for (let i = 1; i < sources.length; i++) {
    span = findExportBody(sources[i].src, original);
    if (span) return bodyText(sources[i].src, span);
    if (original !== name) {
      span = findExportBody(sources[i].src, name);
      if (span) return bodyText(sources[i].src, span);
    }
  }
  // Last resort: a method-style definition of the name anywhere in
  // the source set. Some modules define their exports as methods of
  // a table or class and export them destructured (console:
  // `export const { log, error } = ...`), leaving no named definition
  // site; the runtime values are bound functions whose toString is
  // "[native code]", so the probe cannot help either.
  for (const { src } of sources) {
    const body = findMethodBody(src, name);
    if (body) return body;
  }
  return null;
}

// Find one method's body inside a class body text: a method
// definition, a getter/setter, or a class-field initializer.
function findMethodBody(classText, method) {
  const esc = escapeRegex(method);
  let re = new RegExp(
    `(?:^|\\n)\\s*(?:static\\s+)?(?:async\\s+)?(?:get\\s+|set\\s+)?${esc}\\s*\\(`,
  );
  let m = classText.match(re);
  if (m) {
    const span = findFunctionBody(classText, m.index);
    if (span) return bodyText(classText, span);
  }
  re = new RegExp(`(?:^|\\n)\\s*(?:static\\s+)?${esc}\\s*=`);
  m = classText.match(re);
  if (m) {
    const span = findInitializerBody(classText, m.index);
    if (span) return bodyText(classText, span);
  }
  return null;
}

// Runtime fallback for exports whose bodies are computed in source
// (factory tables, Object.assign): the probe child's captured
// Function.prototype.toString text for the export, classified by the
// same rules as a source body. Native functions are refused — a
// re-exported real builtin (e.g. via sys) is not evidence about the
// shim's body.
function runtimeBodyFromSource(text) {
  if (!text || typeof text !== "string") return null;
  if (text.includes("[native code]")) return null;
  if (text.startsWith("class")) {
    const span = findClassBody(text, 0);
    return span ? bodyText(text, span) : null;
  }
  if (
    /^(?:async\s+)?function\b/.test(text) ||
    /^(?:get\s+|set\s+)?[\w$]+\s*\(/.test(text)
  ) {
    const span = findFunctionBody(text, 0);
    if (span) return bodyText(text, span);
  }
  const wrapped = `const __rt = ${text};`;
  const span = findInitializerBody(wrapped, 0);
  return span ? bodyText(wrapped, span) : null;
}

// Find a body assigned outside the class: `Class.prototype.m = ...`
// or `Class.m = ...` anywhere in the source set.
function findAssignedBody(sources, baseName, method) {
  const re = new RegExp(
    `${escapeRegex(baseName)}(?:\\.prototype)?\\.${escapeRegex(method)}\\s*=`,
  );
  for (const { src } of sources) {
    const m = src.match(re);
    if (m) {
      const span = findInitializerBody(src, m.index);
      if (span) return bodyText(src, span);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4. Classification
// ---------------------------------------------------------------------------

// Noop patterns: empty body, or returns a constant / undefined / this,
// with no other statements.
function isHonestNoop(body) {
  if (!body) return false;
  // Strip the outer braces for function/class bodies.
  let inner = body;
  if (inner.startsWith("{") && inner.endsWith("}")) {
    inner = inner.slice(1, -1).trim();
  }
  if (inner === "") return true;
  // Single statement: return <constant>
  const retMatch = inner.match(/^\s*return\s+(.+?)\s*;?\s*$/);
  if (retMatch) {
    const val = retMatch[1].trim().replace(/;+$/, "");
    if (
      val === "undefined" ||
      val === "null" ||
      val === "void 0" ||
      val === "this"
    )
      return true;
    if (/^(true|false|\d+|"[^"]*"|'[^']*'|\[[^\]]*\]|\{[^}]*\})$/.test(val))
      return true;
  }
  // Single bare identifier/expression that's a noop (e.g. `void 0`)
  if (/^(void\s+0|undefined|null|true|false)$/.test(inner)) return true;
  return false;
}

// Single throw of a not-implemented style error.
function isUnsupportedThrow(body) {
  if (!body) return null;
  let inner = body;
  if (inner.startsWith("{") && inner.endsWith("}")) {
    inner = inner.slice(1, -1).trim();
  }
  // Match: throw new X("message") or throw X("message") or throw Error(...)
  const throwMatch = inner.match(
    /^\s*throw\s+(?:new\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*;?\s*$/,
  );
  if (!throwMatch) return null;
  const msg = throwMatch[2].toLowerCase();
  if (msg.includes("not implemented") || msg.includes("not implemented")) {
    return `unsupported: throws not-implemented (${throwMatch[1]})`;
  }
  if (msg.includes("err_not_implemented"))
    return "unsupported: ERR_NOT_IMPLEMENTED";
  return null;
}

// ---------------------------------------------------------------------------
// 5. Loading the shim module to get its actual exports
// ---------------------------------------------------------------------------

// The shim's export surface comes primarily from source-text extraction
// (shimExports, section 2): it is deterministic and does not depend on
// whether the module can execute under bare Node. When the module DOES
// load (loadShimModuleSync, below), its runtime export keys supplement
// the source-extracted set. A load failure is recorded per module
// (failedLoads + the module's loadError field); it does not change any
// API's status by itself.

// ---------------------------------------------------------------------------
// 6. Main
// ---------------------------------------------------------------------------

// Measured official-test pass rates, curated in
// parity/measured-rates.json from actual sweep runs (never derived
// from this matrix). Modules without an entry simply have no
// measured rate yet.
function loadMeasuredRates() {
  const p = path.join(repoRoot, "parity", "measured-rates.json");
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")).modules || {};
  } catch {
    return {};
  }
}

async function buildMatrix() {
  const { entries, excluded } = publicModules();
  const mods = entries.map((e) => e.name);
  const rates = loadMeasuredRates();
  const results = {};
  const failedLoads = [];
  const rows = [];

  for (const { name: mod, file: fileName } of entries) {
    const file = path.join(srcDir, fileName);
    const { loadError, src, sources, probe, srcExports } =
      loadShimModuleSync(file);
    if (loadError) failedLoads.push({ mod, error: loadError });
    const aliases = importAliases(src);

    // API universe from real Node
    const universe = await nodeApiUniverse(mod);
    // Prototype methods for class exports
    const cjsModule = (() => {
      try {
        return require(`node:${mod}`);
      } catch {
        return null;
      }
    })();
    const protoEntries = [];
    for (const api of universe) {
      if (cjsModule) {
        const methods = classProtoMethods(mod, api);
        for (const m of methods) protoEntries.push(`${api}.prototype.${m}`);
      }
    }

    const allApis = [...universe, ...protoEntries].sort();
    // Probe keys were merged into srcExports by the loader.
    const shimKeys = new Set(srcExports);

    const modRows = [];
    for (const api of allApis) {
      const isProto = api.includes(".prototype.");
      const baseName = isProto ? api.split(".prototype.")[0] : api;

      let status = "unsupported";
      let reason = "not yet implemented";

      if (!shimKeys.has(isProto ? baseName : api)) {
        // Absent from the shim's exports (source text, supplemented by
        // the runtime namespace when the module loads). For prototype
        // rows, presence means the base class is exported. Reasons in
        // parity/expected-failures.shim.json are per-test, not
        // per-API, so they are not borrowed here.
        status = "unsupported";
        reason = "not yet implemented";
      } else {
        // Present in the shim — classify by source body. Prototype
        // rows classify the METHOD's body (inside the class, or an
        // outside `Class.prototype.m = ...` assignment), never the
        // whole class body. When source extraction fails (computed
        // definitions), the runtime value's own source is the
        // fallback (runtimeBodyText).
        let body;
        if (isProto) {
          const method = api.split(".prototype.")[1];
          const classBody = findBodyText(sources, aliases, baseName);
          const classKnown =
            Boolean(classBody) ||
            probe.keys.includes(baseName) ||
            Boolean(probe.protos[baseName]);
          body =
            (classBody && findMethodBody(classBody, method)) ||
            findAssignedBody(sources, baseName, method) ||
            runtimeBodyFromSource((probe.protos[baseName] || {})[method]);
          if (!body) {
            // The class itself was located (in source or at runtime)
            // but the method was not: it is absent, not unknown.
            if (classKnown) {
              status = "unsupported";
              reason = "not present in shim class";
            } else {
              status = "unknown";
              reason =
                "export shape not extractable from source (re-export or computed)";
            }
            modRows.push({ api, status, reason });
            rows.push({ module: mod, api, status, reason });
            continue;
          }
        } else {
          body =
            findBodyText(sources, aliases, baseName) ||
            runtimeBodyFromSource(probe.fns[baseName]);
        }
        if (!body) {
          status = "unknown";
          reason =
            "export shape not extractable from source (re-export or computed)";
        } else if (isHonestNoop(body)) {
          status = "honest-noop";
          reason = "";
        } else {
          const unsupported = isUnsupportedThrow(body);
          if (unsupported) {
            status = "unsupported";
            reason = unsupported.replace(/^unsupported: /, "");
          } else {
            status = "implemented";
            reason = "";
          }
        }
      }

      modRows.push({ api, status, reason });
      rows.push({ module: mod, api, status, reason });
    }

    results[mod] = {
      apis: allApis.length,
      proto: protoEntries.length,
      rows: modRows,
      ...(loadError ? { loadError } : {}),
      ...(rates[mod]
        ? {
            parity: {
              passed: rates[mod].passed,
              total: rates[mod].total,
              rate:
                Math.round((rates[mod].passed / rates[mod].total) * 1000) / 10,
              date: rates[mod].date,
              source: rates[mod].source,
            },
          }
        : {}),
    };
  }

  return { mods, excluded, results, rows, failedLoads };
}

// Shim loading happens in a disposable child process per module.
// Loading a shim in THIS process is unsafe: src modules replace
// globals (process, console, AsyncLocalStorage) with shim versions,
// corrupting the generator itself. The child imports one file and
// reports back JSON: its export keys, each function export's source
// (Function.prototype.toString), and each class export's prototype
// method sources. The parent never executes shim code.
const PROBE_SOURCE = `
import fs from "node:fs";
// Capture everything needed BEFORE the import: a shim may replace
// process/env during its module evaluation (src/process.js does).
const file = process.env.PROBE_FILE;
const outPath = process.env.PROBE_OUT;
const writeFileSync = fs.writeFileSync;
const stringify = JSON.stringify;
let ns = null;
let loadError = null;
try {
  ns = await import("file://" + file);
} catch (e) {
  loadError = (e && e.message ? e.message : String(e)).split("\\n")[0];
}
const keys = [];
const fns = {};
const protos = {};
if (ns) {
  for (const k of Object.keys(ns)) {
    if (k === "default") continue;
    keys.push(k);
    const v = ns[k];
    if (typeof v === "function") {
      try {
        fns[k] = Function.prototype.toString.call(v).slice(0, 200000);
      } catch {}
      if (v.prototype) {
        const pm = {};
        for (const mk of Object.getOwnPropertyNames(v.prototype)) {
          if (mk === "constructor") continue;
          try {
            const mv = v.prototype[mk];
            if (typeof mv === "function") {
              pm[mk] = Function.prototype.toString.call(mv).slice(0, 200000);
            }
          } catch {}
        }
        if (Object.keys(pm).length) protos[k] = pm;
      }
    }
  }
}
// Report via a file, not stdout: large payloads on a pipe hit
// partial writes and EAGAIN under the parent's drain timing.
writeFileSync(outPath, stringify({ loadError, keys, fns, protos }), "utf8");
`;

function probeShimModule(file) {
  const fallback = { loadError: null, keys: [], fns: {}, protos: {} };
  const outFile = path.join(
    fs.mkdtempSync(path.join("/tmp", "capability-probe-")),
    "probe.json",
  );
  try {
    execFileSync(
      REAL_PROCESS.execPath,
      ["--input-type=module", "-e", PROBE_SOURCE],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...REAL_PROCESS.env, PROBE_FILE: file, PROBE_OUT: outFile },
      },
    );
    const parsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
    return { ...fallback, ...parsed };
  } catch (e) {
    const stderrTail = e.stderr
      ? String(e.stderr).trim().split("\n").slice(-8).join(" | ")
      : "";
    return {
      ...fallback,
      loadError: `probe failed: ${(e.message || String(e)).split("\n")[0]}${stderrTail ? ` — child stderr: ${stderrTail}` : ""}`,
    };
  } finally {
    try {
      fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
    } catch {}
  }
}

function loadShimModuleSync(file) {
  const src = fs.readFileSync(file, "utf8");
  const srcExports = new Set(shimExports(src));
  const probe = probeShimModule(file);
  for (const k of probe.keys) {
    if (k !== "default") srcExports.add(k);
  }
  const sources = moduleSources(file, src);
  return {
    loadError: probe.loadError,
    src,
    sources,
    probe,
    srcExports: [...srcExports].sort(),
  };
}

// ---------------------------------------------------------------------------
// 7. Output generation
// ---------------------------------------------------------------------------

function generateMarkdown(mods, results, rows, failedLoads, excluded) {
  const counts = {
    implemented: 0,
    "honest-noop": 0,
    unsupported: 0,
    unknown: 0,
  };
  for (const r of rows) counts[r.status]++;

  let md = `# Capability Matrix\n\n`;
  md += `> Generated from code by \`scripts/generate-capability-matrix.mjs\`.\n`;
  md += `> Do not edit by hand — regenerate instead.\n\n`;
  md += `Oracle: Node ${ORACLE_NODE_VERSION} (the Node running the generator). Modules:\n`;
  md += `Node.js builtins with a shim in \`src/\`. Derivation: real Node\n`;
  md += `\`node:<module>\` exports × shim source-body classification.\n\n`;
  md += `## Summary\n\n`;
  md += `| Module | APIs | Implemented | Honest-noop | Unsupported | Unknown | Parity (official tests) |\n`;
  md += `|--------|------|-------------|-------------|-------------|---------|-------------------------|\\n`;
  for (const mod of mods) {
    const r = results[mod];
    const mc = { implemented: 0, "honest-noop": 0, unsupported: 0, unknown: 0 };
    for (const row of r.rows) mc[row.status]++;
    const parityCell = r.parity
      ? `${r.parity.passed}/${r.parity.total} (${r.parity.rate}%) · ${r.parity.date}`
      : "—";
    md += `| \`${mod}\` | ${r.apis} | ${mc.implemented} | ${mc["honest-noop"]} | ${mc.unsupported} | ${mc.unknown} | ${parityCell} |\n`;
  }
  md += `\n**Totals:** ${rows.length} rows — ${counts.implemented} implemented, ${counts["honest-noop"]} honest-noop, ${counts.unsupported} unsupported, ${counts.unknown} unknown.\n`;
  md += `\nParity column: measured official-test pass rates from \`parity/measured-rates.json\` (see NOTES-capability-matrix.md §6); "—" means not yet swept.\n`;

  if (failedLoads.length) {
    md += `\n## Load failures\n\n`;
    md += `These modules could not be loaded under bare Node, so their export\n`;
    md += `surface comes from source text alone; the error is recorded per module.\n\n`;
    for (const { mod, error } of failedLoads) {
      md += `- \`${mod}\`: ${error}\n`;
    }
  }

  if (excluded.length) {
    md += `\n## Excluded src files\n\n`;
    md += `These \`src/*.js\` files are not Node.js builtin modules (browser\n`;
    md += `helpers, bundler plugins, service workers), so they are not part\n`;
    md += `of the matrix.\n\n`;
    for (const { file } of excluded) {
      md += `- \`${file}\`\n`;
    }
  }

  md += `\n## Per-module detail\n\n`;
  for (const mod of mods) {
    const r = results[mod];
    md += `### ${mod}\n\n`;
    if (r.loadError) {
      md += `> **Load error:** ${r.loadError}\n\n`;
    }
    md += `| API | Status | Reason |\n`;
    md += `|-----|--------|--------|\n`;
    for (const row of r.rows) {
      const reason = row.reason || "—";
      md += `| \`${row.api}\` | ${row.status} | ${reason} |\n`;
    }
    md += `\n`;
  }

  md += `\n## Status legend\n\n`;
  md += `- **implemented**: present in the shim and contains real logic.\n`;
  md += `- **honest-noop**: present but body is empty or returns a constant / undefined / this.\n`;
  md += `- **unsupported**: absent from shim exports, or present but throws a not-implemented error.\n`;
  md += `- **unknown**: could not be classified (export shape not extractable, or module failed to load).\n`;

  return md;
}

function generateJson(mods, results, rows, failedLoads, excluded) {
  return JSON.stringify(
    {
      nodeVersion: ORACLE_NODE_VERSION,
      moduleNames: mods,
      failedLoads,
      excludedSrcFiles: excluded,
      summary: {
        totalRows: rows.length,
        byStatus: {
          implemented: rows.filter((r) => r.status === "implemented").length,
          "honest-noop": rows.filter((r) => r.status === "honest-noop").length,
          unsupported: rows.filter((r) => r.status === "unsupported").length,
          unknown: rows.filter((r) => r.status === "unknown").length,
        },
      },
      modules: mods.reduce((acc, mod) => {
        acc[mod] = results[mod];
        return acc;
      }, {}),
    },
    null,
    2,
  );
}

const notes = `# Capability Matrix — Derivation Notes

## Overview

The capability matrix (\`docs/capability-matrix.json\`, \`docs/CAPABILITY_MATRIX.md\`)
is generated by \`scripts/generate-capability-matrix.mjs\` from code alone — no
hand-written tables. This file documents the derivation rules, their limits,
and what is classified as "unknown".

## Derivation rules

### 1. API universe (real Node)

For each Node.js builtin module with a shim in \`src/\` (the builtin set
comes from the oracle's \`module.builtinModules\`; \`src\` files that are
not Node builtins are listed as excluded in the matrix, never presented
as modules), the API universe is the union of:

- **CJS enumerable keys** via \`require('node:<module>')\` — covers the
  majority of builtins.
- **ESM namespace keys** via \`await import('node:<module>')\` — captures
  ESM-only named exports not surfaced on the CJS object.

From this union we **exclude** \`default\` and any key starting with \`_\`
(internals). For class exports, we add one level of prototype method names as
\`<Export>.prototype.<method>\` entries — these are part of the public API
contract (e.g. \`Socket.prototype.send\`, \`Session.prototype.post\`).

### 2. Shim surface

The shim's actual exports are extracted from the **source text** of
\`src/<module>.js\` using a token-aware scanner (not regex on the whole file)
that recognizes:

- \`export function foo\` / \`export async function foo\`
- \`export class Foo\`
- \`export const foo\` / \`export let\` / \`export var\`
- \`export { a, b as c }\` (single- and multi-line)
- \`export default\`

**Definition lookup follows one level of local imports and
re-exports**: when an export's body is not in \`src/<module>.js\`, the
files it imports from or re-exports are searched (relative paths, and
\`node:<builtin>\` mapped to that builtin's shim file — the mapping the
runtime itself applies, e.g. \`src/sys.js\` re-exports \`node:util\`,
whose bodies live in \`src/util.js\`). Aliased imports are followed to
the original name. As a last resort, a method-style definition of the
name anywhere in the source set is used (console's methods live in a
methods table and are exported destructured, leaving no named
definition site).

**Runtime probe**: each module is also imported in a disposable
child process (never in the generator — shim modules replace
globals such as \`process\` and \`AsyncLocalStorage\` with their own,
which corrupts the host). The probe reports the module's export keys
and each function's own source. When source extraction cannot locate
a body (factory-computed definitions such as fs's file functions),
the probe's function source is classified by the same rules. Bound
or native functions report \`[native code]\` and are refused as
evidence.

### 3. Status classification (source-form rule)

For each API in the universe:

1. **Absent from shim exports** → \`unsupported\`, reason
   "not yet implemented". (Reasons in \`parity/expected-failures.shim.json\`
   are per-test, not per-API, so they are not borrowed for API rows.)

2. **Present in shim exports** → inspect the function/class body extracted
   from the source text (the export's own definition site, not a runtime
   snapshot):

   - Body is **empty** or **only returns a constant / undefined / this**
     (no other statements) → \`honest-noop\`.
   - Body is a **single throw** of a not-implemented style error
     (\`ERR_NOT_IMPLEMENTED\` code or "not implemented" in the message)
     → \`unsupported\` with that reason.
   - **Otherwise** → \`implemented\`.

3. **Export shape not extractable** (re-export, computed name, dynamic
   export) → \`unknown\` with the reason above.

### 4. Module load failures

Some shim modules cannot be loaded under bare Node (browser globals at
module scope, directory imports the ESM loader rejects, packages the
repo's bundler resolves but bare Node does not). The current list,
with each module's error, is in the generated matrix's "Load failures"
section and in the JSON's \`failedLoads\`.

A load failure does not change any API's status. The export surface
comes primarily from source-text extraction (§2); a successful load
only supplements that set with the module's runtime export keys. The
load error is recorded on the module so the weaker evidence is visible
rather than hidden.

### 5. Limits & known gaps

- **Prototype methods**: only one level deep, and only for exports that are
  classes in real Node. Deeper inheritance chains are not traversed.
- **Re-exports**: followed one level (see §2). Deeper chains, and
  bodies inside bare package imports, are not followed.
- **Computed / dynamic exports**: not extracted. Classified \`unknown\`.
- **Function-body analysis**: the body extractor is a brace-matching scan,
  not a full AST. It handles standard \`function\` and \`class\` bodies and
  arrow-function/class-expression initializers. It does **not** resolve
  calls to helper functions defined elsewhere in the file — a function that
  delegates to a real implementation via a helper is still classified
  \`implemented\` (because its body is not empty/throwing), but a function
  whose body is literally \`return _impl(x)\` is classified \`implemented\`
  even if \`_impl\` is itself a noop. This is a conservative over-classification
  that errs toward "implemented" for non-trivial bodies.
- **Noop detection**: only catches the simplest noop shapes (empty body,
  \`return undefined\`, \`return null\`, \`return this\`, \`return void 0\`,
  \`return <constant>\`). Functions that perform validation then noop are
  classified \`implemented\` — they have real logic (validation), even if
  the core operation is a noop. Named example: \`inspector\`
  \`Session.prototype.post\` is a documented noop (it invokes the
  callback with an empty result), but its body normalizes the callback
  argument first, so the mechanical rule classifies it \`implemented\`.
  This matches the spec's intent: "present, and its body is empty or
  only returns a constant / undefined / this (no other statements)".

### 6. Measured parity rates

The matrix's Parity column (and the JSON's per-module \`parity\`
object) comes from \`parity/measured-rates.json\`: pass/total counts
from actual runs of Node's official tests against the shims, with
the run date and source recorded per module. These numbers are
measured independently of this generator and are never derived from
the capability classification — a module can have most APIs
"implemented" and still fail tests (behavioral gaps), or few APIs
and pass everything written for it. Entries are updated only when a
module is re-swept; a module with no entry shows "—" rather than an
estimate.

## Verification gates

- \`unknown\` rows must be < 10% of total. The generator fails (exit 1)
  when the share is exceeded.
- Hard gates (dgram noops, inspector noops, fs.readFileSync + http.createServer
  implemented, one unsupported example) are checked in the verification
  step, not by the generator itself.
`;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const out = {
  matrix:
    args[args.indexOf("--matrix") + 1] ||
    path.join(repoRoot, "docs", "CAPABILITY_MATRIX.md"),
  json:
    args[args.indexOf("--json") + 1] ||
    path.join(repoRoot, "docs", "capability-matrix.json"),
  notes:
    args[args.indexOf("--notes") + 1] ||
    path.join(repoRoot, "NOTES-capability-matrix.md"),
};

const { mods, excluded, results, rows, failedLoads } = await buildMatrix();

const counts = { implemented: 0, "honest-noop": 0, unsupported: 0, unknown: 0 };
for (const r of rows) counts[r.status]++;
const unknownPct = (counts.unknown / rows.length) * 100;

fs.writeFileSync(
  out.matrix,
  generateMarkdown(mods, results, rows, failedLoads, excluded),
);
fs.writeFileSync(
  out.json,
  generateJson(mods, results, rows, failedLoads, excluded),
);
fs.writeFileSync(out.notes, notes);

// Report via fd 1 and the REAL process: by now a loaded src module
// may have replaced globalThis.process/console with the shim's, whose
// exit() does not terminate and whose log goes nowhere.
const say = (s) => fs.writeSync(1, s + "\n");
say(`Modules processed: ${mods.length}`);
say(`API rows total: ${rows.length}`);
say(`  implemented: ${counts.implemented}`);
say(`  honest-noop: ${counts["honest-noop"]}`);
say(`  unsupported: ${counts.unsupported}`);
say(`  unknown: ${counts.unknown} (${unknownPct.toFixed(1)}%)`);
say(`Failed loads: ${failedLoads.length}`);
for (const { mod, error } of failedLoads) {
  say(`  - ${mod}: ${error}`);
}
if (unknownPct >= 10) {
  fs.writeSync(
    2,
    `FAIL: unknown rows exceed 10% (${unknownPct.toFixed(1)}%)\n`,
  );
  REAL_PROCESS.exit(1);
}
say(`Wrote: ${out.matrix}, ${out.json}, ${out.notes}`);
