#!/usr/bin/env node
// src/build-runtime.mjs — assemble runtime.js from src/runtime/*.js modules.
//
// The runtime was modularized (branch modular/integration) by extracting
// line ranges of the runtime.js monolith into src/runtime/*.js with `export`
// keywords added. This script reverses the extraction: it concatenates the
// modules back into ONE shared ESM scope — exactly the monolith's semantics —
// so free cross-module identifiers (EventEmitter, acorn, _builtinManifest, …)
// resolve naturally, and writes the result to <repo>/runtime.js.
//
// Why concatenation and not esbuild bundling: the extracted modules
// intentionally carry NO cross-imports for the shared scope (the 223 module
// tests inject those names via globalThis). A bundler cannot wire what is
// not imported; concatenation reproduces the original single scope.
//
// Adaptations applied during assembly (all fail loudly on mismatch):
//   1. Import unification — every module's static imports are hoisted once.
//      Bare npm specifiers (acorn, acorn-walk, magic-string, estree-walker)
//      are rewritten to the exact esm.sh URLs the original runtime.js used,
//      so the browser target needs no import map. Relative "../" imports are
//      rewritten relative to the output file (the original runtime.js lived
//      at the repo root, so they become "./src/…"). Intra-build imports
//      ("./code-sandbox.js", "./host-utils.js") are dropped — those bindings
//      are already in the shared scope.
//   2. Duplicate helpers — `isNodeLane()` was copied verbatim into
//      builtin-modules.js, transpile.js and vfs-serialize.js; only the first
//      copy is kept (asserted byte-identical).
//   3. Test-only shims in transforms-imports.js are dropped:
//      `let _builtinManifest = {}` + `setBuiltinManifest()` existed so unit
//      tests could inject a fake manifest. The bundle uses the real shared
//      `const _builtinManifest` from builtins.js, exactly like the original.
//   4. transpile.js's dual-lane `const acorn = await …` is dropped in favor
//      of the unified static `import * as acorn from "https://esm.sh/acorn"`
//      (same specifier the original used). Its dual-lane `ts` /
//      `importAssertions` dynamic imports are kept (Node fallback lane).
//   5. `export * from "./host-utils.js"` (entry.js) is dropped as redundant:
//      host-utils.js is concatenated into the same scope with its own
//      `export` statements, so its names are exported directly.
//   6. Export stripping — the extraction added `export` to declarations the
//      module tests import directly, but the bundle keeps the monolith's
//      exact 22-name export surface (KEEP_EXPORTS): every other top-level
//      `export` is removed at emit time. The declarations stay in the shared
//      scope (no functional change); this keeps marker-extracted blocks
//      `new Function`-able for the eight suites that eval them.
//   7. The original `// EXECUTION CONTEXT MODULE` section banner is
//      re-emitted right after the import-resolver section: tests use it as
//      the extractBlock end marker for the ImportResolver class.
//
// Usage:
//   node src/build-runtime.mjs [--out <path>] [--check]
//     --out <path>   write to <path> instead of <repo>/runtime.js
//     --check        build in memory and compare against the file at --out;
//                    exit 0 on match, 1 on mismatch (no write)

import { parse } from "acorn";
import { transformSync } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, "src", "runtime");

// Module order: the extraction order of the original runtime.js line ranges
// (bootstrap 1-690, transforms 688-2253, resolution, execution 2810-3802,
// sandbox 4036-6053, host 4900-6327). Evaluation order only matters for
// top-level side effects (registerPlugin calls, TLA consts); the class and
// function declarations that dominate the file are hoisted.
const MODULES = [
  "bootstrap.js",
  "builtins.js",
  "terminal.js",
  "builtin-modules.js",
  "transpile.js",
  "vfs-serialize.js",
  "transforms-esm.js",
  "transforms-cjs.js",
  "transforms-imports.js",
  "syntax.js",
  "events.js",
  "import-resolver.js",
  "vfs-server.js",
  "execution-context.js",
  "code-sandbox.js",
  "sandbox-runtime.js",
  "code-transformer.js",
  "entry.js",
  "host-utils.js",
  "message-handler.js",
  "output-shim.js",
];

// Bare npm specifiers -> the exact esm.sh specifiers the original runtime.js
// used for them (browser target: no import map needed).
const BARE_TO_ESMSH = {
  acorn: "https://esm.sh/acorn",
  "acorn-walk": "https://esm.sh/acorn-walk",
  "magic-string": "https://esm.sh/magic-string",
  "estree-walker": "https://esm.sh/estree-walker",
};

// Imports that resolve inside the bundle itself — dropped, the bindings are
// declared by the concatenated modules in the shared scope. Derived from the
// module list so every "./<module>.js" cross-import is covered.
const INTRA_BUILD_SOURCES = new Set(MODULES.map((m) => `./${m}`));

// The original runtime.js monolith's export surface (22 names; verified via
// `git show <cutover>^:runtime.js | grep -c "^export "`). The extraction added
// `export` to many more declarations so the 223 module tests can import the
// modules directly — but the generated bundle must keep the monolith's exact
// export surface: eight test suites extract code blocks from runtime.js by
// section markers and eval them with `new Function`, which throws on `export`.
// Non-listed exports are stripped at emit time (the declarations stay, so the
// shared scope is unchanged — this is purely the bundle's export surface).
const KEEP_EXPORTS = new Set([
  "toNodeKeypress",
  "builtinModules",
  "transpileTypeScript",
  "customAcorn",
  "serializeVfs",
  "deserializeVfs",
  "rehydrateVfs",
  "convertEsmToCjs",
  "convertCjsToEsm",
  "convertCjsToEsm_backup",
  "replaceGlobalThisVar",
  "transformImportsToLoadModule",
  "SyntaxChecker",
  "ImportResolver",
  "__parseStackLocationFn",
  "SandboxRuntime",
  "CodeTransformer",
  "CodeSandbox",
  "executeCode",
  "createSandbox",
  "formatErrors",
  "flattenFileTree",
]);

// Original-monolith section banner that one test suite uses as an extractBlock
// end marker: sync_require_bare_builtins.test.js extracts the ImportResolver
// class between "export class ImportResolver {" and "// EXECUTION CONTEXT
// MODULE". In the monolith the banner headed the section that followed the
// ImportResolver class; in the modular layout vfs-server.js sits between
// import-resolver.js and execution-context.js, so the banner is re-emitted
// here — immediately after the import-resolver section — to preserve the
// extraction contract.
const EXEC_CTX_BANNER_AFTER = "import-resolver.js";
const EXEC_CTX_BANNER = "// EXECUTION CONTEXT MODULE";

function fail(msg) {
  console.error(`build-runtime: FATAL: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let outPath = join(root, "runtime.js");
let checkMode = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && args[i + 1]) outPath = resolve(args[++i]);
  else if (args[i] === "--check") checkMode = true;
  else fail(`unknown argument: ${args[i]}`);
}
const outDir = dirname(outPath);
// Prefix for repo-relative imports, so --out to a subdirectory still works.
const repoPrefix = relative(outDir, root) === "" ? "." : relative(outDir, root);

function rewriteSource(src) {
  if (src.startsWith("../")) return `${repoPrefix}/src/${src.slice(3)}`;
  if (BARE_TO_ESMSH[src]) return BARE_TO_ESMSH[src];
  return src;
}

// ---------------------------------------------------------------------------
// Pass 1: parse every module, collect imports/exports, find the canonical
// isNodeLane text for the duplicate-helper assertion.
// ---------------------------------------------------------------------------
const parsed = [];
let canonicalIsNodeLane = null;
for (const name of MODULES) {
  const file = join(runtimeDir, name);
  if (!existsSync(file)) fail(`missing module: ${file}`);
  const src = readFileSync(file, "utf8");
  let ast;
  try {
    ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });
  } catch (err) {
    fail(`parse error in src/runtime/${name}: ${err.message}`);
  }
  parsed.push({ name, src, ast });
  for (const node of ast.body) {
    if (
      node.type === "FunctionDeclaration" &&
      node.id &&
      node.id.name === "isNodeLane" &&
      name === "builtin-modules.js"
    ) {
      canonicalIsNodeLane = src.slice(node.start, node.end);
    }
  }
}
if (!canonicalIsNodeLane)
  fail("canonical isNodeLane not found in builtin-modules.js");

// ---------------------------------------------------------------------------
// Pass 2: assemble.
// ---------------------------------------------------------------------------
const unifiedImports = new Map(); // rewritten source -> Map(local -> {kind, imported})
const dropped = [];
const allExportedNames = new Set();
let body = "";

function recordImport(origSource, specifiers, moduleName) {
  const source = rewriteSource(origSource);
  if (!unifiedImports.has(source)) unifiedImports.set(source, new Map());
  const slot = unifiedImports.get(source);
  for (const s of specifiers) {
    const prev = slot.get(s.local);
    if (prev) {
      if (prev.kind !== s.kind || prev.imported !== s.imported)
        fail(
          `conflicting import of "${s.local}" from "${source}" ` +
            `(${moduleName}: ${s.kind} ${s.imported} vs ${prev.kind} ${prev.imported})`,
        );
      continue;
    }
    slot.set(s.local, { kind: s.kind, imported: s.imported });
  }
}

// Drop rules: [module, predicate, reason]. Checked before any other handling.
function dropReason(moduleName, node, src) {
  if (
    moduleName === "transforms-imports.js" &&
    node.type === "VariableDeclaration" &&
    node.declarations.length === 1 &&
    node.declarations[0].id.name === "_builtinManifest"
  )
    return "test-only manifest shim (bundle uses the shared const from builtins.js)";
  if (
    moduleName === "transforms-imports.js" &&
    node.type === "ExportNamedDeclaration" &&
    node.declaration?.type === "FunctionDeclaration" &&
    node.declaration.id.name === "setBuiltinManifest"
  )
    return "test-only manifest setter (not in the original runtime.js)";
  if (
    (moduleName === "transpile.js" || moduleName === "vfs-serialize.js") &&
    node.type === "FunctionDeclaration" &&
    node.id?.name === "isNodeLane"
  ) {
    const text = src.slice(node.start, node.end);
    if (text !== canonicalIsNodeLane)
      fail(`${moduleName}: isNodeLane differs from builtin-modules.js copy`);
    return "duplicate helper (kept from builtin-modules.js)";
  }
  if (
    moduleName === "transpile.js" &&
    node.type === "VariableDeclaration" &&
    node.declarations.length === 1 &&
    node.declarations[0].id.name === "acorn"
  )
    return "dual-lane acorn (bundle uses the unified static esm.sh import)";
  return null;
}

for (const { name, src, ast } of parsed) {
  body += `\n// ── src/runtime/${name} ─────────────────────────────────────────────\n`;
  let pos = 0;
  const emit = (from, to) => {
    if (to > from) body += src.slice(from, to);
  };
  for (const node of ast.body) {
    // Preserve comments/whitespace between top-level nodes verbatim.
    emit(pos, node.start);

    if (node.type === "ImportDeclaration") {
      const source = node.source.value;
      if (INTRA_BUILD_SOURCES.has(source)) {
        // Provided by the bundle scope itself.
      } else {
        recordImport(
          source,
          node.specifiers.map((s) =>
            s.type === "ImportDefaultSpecifier"
              ? { kind: "default", imported: "default", local: s.local.name }
              : s.type === "ImportNamespaceSpecifier"
                ? { kind: "namespace", imported: "*", local: s.local.name }
                : {
                    kind: "named",
                    imported: s.imported.name,
                    local: s.local.name,
                  },
          ),
          name,
        );
      }
      pos = node.end;
      continue;
    }

    const reason = dropReason(name, node, src);
    if (reason) {
      dropped.push(`${name}: ${describeNode(node)} — ${reason}`);
      pos = node.end;
      continue;
    }

    if (
      node.type === "ExportAllDeclaration" &&
      node.source.value === "./host-utils.js"
    ) {
      // `export *` from an intra-build module is redundant: host-utils.js is
      // concatenated into this same scope below with its own `export`
      // statements, so the names are exported directly. Drop it (emitting an
      // explicit list here would duplicate those later exports).
      dropped.push(
        `${name}: export * from ./host-utils.js — redundant (module is bundled)`,
      );
      pos = node.end;
      continue;
    }

    if (
      node.type === "ExportNamedDeclaration" &&
      !node.declaration &&
      !node.source
    ) {
      // `export { a, b as c };` — re-export of locals/imports. Only names in
      // KEEP_EXPORTS survive into the bundle; the rest are bundle-internal
      // (the bindings stay declared in the shared scope, so intra-bundle
      // references keep working).
      const kept = node.specifiers.filter((s) =>
        KEEP_EXPORTS.has(s.exported.name),
      );
      for (const s of kept) {
        if (allExportedNames.has(s.exported.name))
          fail(`duplicate export "${s.exported.name}" (${name})`);
        allExportedNames.add(s.exported.name);
      }
      if (kept.length === 0) {
        dropped.push(`${name}: bare export list — not in KEEP_EXPORTS`);
        pos = node.end;
        continue;
      }
      const list = kept
        .map((s) =>
          s.local.name === s.exported.name
            ? s.local.name
            : `${s.local.name} as ${s.exported.name}`,
        )
        .join(", ");
      body += `export { ${list} };\n`;
      pos = node.end;
      continue;
    }
    if (node.type === "ExportNamedDeclaration" && node.declaration) {
      const d = node.declaration;
      const names =
        d.type === "VariableDeclaration"
          ? d.declarations.map((x) => x.id.name)
          : [d.id.name];
      for (const n of names) {
        if (allExportedNames.has(n)) fail(`duplicate export "${n}" (${name})`);
        allExportedNames.add(n);
      }
      if (!names.some((n) => KEEP_EXPORTS.has(n))) {
        // Not part of the monolith's export surface: emit the declaration
        // WITHOUT the `export` keyword (skip exactly the `export` token;
        // anything between it and the declaration — comments, whitespace —
        // is preserved verbatim).
        if (src.slice(node.start, node.start + 6) !== "export")
          fail(`expected "export" keyword at node start (${name})`);
        // Gap before `export` was already emitted at the top of the loop.
        body += src.slice(node.start + 6, node.end);
        pos = node.end;
        continue;
      }
    }

    emit(node.start, node.end);
    pos = node.end;
  }
  emit(pos, src.length);
  body += "\n";
  if (name === EXEC_CTX_BANNER_AFTER) body += `${EXEC_CTX_BANNER}\n`;
}

function describeNode(node) {
  if (node.type === "VariableDeclaration")
    return `top-level ${node.kind} ${node.declarations.map((d) => d.id.name).join(", ")}`;
  if (node.type === "FunctionDeclaration") return `function ${node.id?.name}`;
  if (
    node.type === "ExportNamedDeclaration" &&
    node.declaration?.type === "FunctionDeclaration"
  )
    return `exported function ${node.declaration.id.name}`;
  return node.type;
}

// The runwasi dynamic import inside CodeSandbox.runWasi is written
// repo-root-relative (like the original runtime.js). Keep it correct when
// --out points at a subdirectory.
if (repoPrefix !== ".") {
  const from = '"./src/runtime/runwasi.js"';
  const to = `"${repoPrefix}/src/runtime/runwasi.js"`;
  if (!body.includes(from)) fail(`expected runwasi literal ${from} not found`);
  body = body.split(from).join(to);
}

// ---------------------------------------------------------------------------
// Emit the unified import block.
// ---------------------------------------------------------------------------
const ESM_PRIORITY = [
  "https://esm.sh/acorn",
  "https://esm.sh/acorn-walk",
  "https://esm.sh/magic-string",
  "https://esm.sh/estree-walker",
  "https://esm.sh/uuid",
  "https://esm.sh/@jridgewell/trace-mapping",
  "https://esm.sh/@ampproject/remapping",
];
const orderedSources = [...unifiedImports.keys()].sort((a, b) => {
  const pa = ESM_PRIORITY.indexOf(a);
  const pb = ESM_PRIORITY.indexOf(b);
  if (pa !== -1 || pb !== -1)
    return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
  return a < b ? -1 : a > b ? 1 : 0;
});

let importBlock = "";
for (const source of orderedSources) {
  const specs = [...unifiedImports.get(source).entries()];
  const defaults = specs.filter(([, s]) => s.kind === "default");
  const namespaces = specs.filter(([, s]) => s.kind === "namespace");
  const named = specs.filter(([, s]) => s.kind === "named");
  if (defaults.length > 1 || namespaces.length > 1)
    fail(`cannot merge multiple default/namespace imports from "${source}"`);
  let clause = "";
  if (defaults.length) clause += defaults[0][0];
  if (namespaces.length)
    clause += (clause ? ", " : "") + `* as ${namespaces[0][0]}`;
  if (named.length) {
    const list = named
      .map(([local, s]) =>
        local === s.imported ? local : `${s.imported} as ${local}`,
      )
      .join(", ");
    clause += (clause ? ", " : "") + `{ ${list} }`;
  }
  importBlock += `import ${clause} from "${source}";\n`;
}

// ---------------------------------------------------------------------------
// Assemble, validate, write.
// ---------------------------------------------------------------------------
const header = `// runtime.js — GENERATED FILE. DO NOT EDIT BY HAND.
// Assembled from src/runtime/*.js by: node src/build-runtime.mjs
// Module order: ${MODULES.join(", ")}
// Adaptations vs the extracted sources (see src/build-runtime.mjs):
//   - static imports hoisted once; bare npm specifiers rewritten to the
//     exact esm.sh URLs the original runtime.js used (browser target)
//   - duplicate isNodeLane() helpers deduped (kept from builtin-modules.js)
//   - test-only _builtinManifest/setBuiltinManifest shim dropped (shared
//     const from builtins.js is used, as in the original)
//   - transpile.js dual-lane acorn dropped (unified static esm.sh import)
//   - export * from ./host-utils.js dropped as redundant (host-utils.js is
//     bundled in the same scope with its own exports)
//   - export stripped except the monolith's 22-name export surface
//     (KEEP_EXPORTS) so marker-extracted blocks stay new-Function-able
//   - "// EXECUTION CONTEXT MODULE" re-emitted after the import-resolver
//     section (extractBlock end marker used by tests)
`;

const output = `${header}\n${importBlock}\n${body}`;

if (dropped.length === 0)
  fail("expected test-shim drops, got none (extraction drift?)");

// Validate: the bundle must parse — with acorn AND esbuild's parser
// (build-sandbox.mjs convention: fail loudly if the bundle doesn't parse).
try {
  parse(output, { ecmaVersion: "latest", sourceType: "module" });
} catch (err) {
  fail(`assembled output failed acorn parse: ${err.message}`);
}
try {
  transformSync(output, { loader: "js" });
} catch (err) {
  fail(`assembled output failed esbuild parse: ${err.message}`);
}

if (checkMode) {
  if (!existsSync(outPath)) {
    console.error(`check: ${outPath} does not exist`);
    process.exit(1);
  }
  const current = readFileSync(outPath, "utf8");
  if (current === output) {
    console.log(
      `check ok: ${outPath} matches fresh build (${output.length} chars)`,
    );
  } else {
    console.error(
      `check FAILED: ${outPath} differs from fresh build ` +
        `(current ${current.length} chars, fresh ${output.length} chars)`,
    );
    process.exit(1);
  }
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, output);
  console.log(`✅ runtime.js built → ${outPath} (${output.length} chars)`);
  console.log(
    `   modules: ${MODULES.length}, exports: ${allExportedNames.size}`,
  );
  console.log(`   dropped ${dropped.length} test-only/duplicate declarations:`);
  for (const d of dropped) console.log(`     - ${d}`);
}
