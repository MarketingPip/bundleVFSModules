// Parity ESM loader hooks.
//
// Redirects `import 'path'` / `import 'node:path'` (and subpaths like
// `path/posix`) to the repo's polyfill files, but ONLY when the importer
// lives under parity/node-test/parallel/. Node's own test helper
// (test/common) keeps using the real builtins.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const testsDir =
  path.join(repoRoot, "parity", "node-test", "parallel") + path.sep;
const target = process.env.PARITY_TARGET; // e.g. "path" — only redirect this module

// Extra redirects: modules that must follow the target's shim because the
// target's tests depend on them sharing the shim's virtual state.
// Currently: when PARITY_TARGET=http, `net` is also redirected. Http tests
// use net.createConnection() to speak raw HTTP bytes to the virtual server,
// and real net cannot see the http shim's virtual registry (ECONNREFUSED).
// The net shim shares one virtual registry per realm with the http shim
// (same src/net.js module instance), so the connection reaches the server.
function isExtraRedirect(name) {
  return target === "http" && name === "net";
}

function polyfillURL(specifier) {
  const name = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  if (name.startsWith(".") || path.isAbsolute(name)) return null;
  const parts = name.split("/");
  if (target && parts[0] !== target && !isExtraRedirect(parts[0])) return null;
  // Harness-only tmpdir sync for fs parity (parity/fs-harness.mjs).
  if (target === "fs" && name === "fs") {
    return pathToFileURL(path.join(repoRoot, "parity", "fs-harness.mjs")).href;
  }
  // node:fs/promises → the promises wrapper (same sync + timer restore).
  if (target === "fs" && name === "fs/promises") {
    return pathToFileURL(
      path.join(repoRoot, "parity", "fs-promises-harness.mjs"),
    ).href;
  }
  // Harness-only timer-globals restore for stream parity
  // (parity/stream-harness.mjs). ESM import path; CJS require path is in
  // preload.mjs.
  if (target === "stream" && name === "stream") {
    return pathToFileURL(path.join(repoRoot, "parity", "stream-harness.mjs"))
      .href;
  }
  // Harness-only timer-globals restore for async_hooks parity
  // (parity/async-hooks-harness.mjs). ESM import path; CJS require path is in
  // preload.mjs.
  if (target === "async_hooks" && name === "async_hooks") {
    return pathToFileURL(
      path.join(repoRoot, "parity", "async-hooks-harness.mjs"),
    ).href;
  }
  // Harness-only timer-globals restore for tty parity
  // (parity/tty-harness.mjs). ESM import path; CJS require path is in
  // preload.mjs.
  if (target === "tty" && name === "tty") {
    return pathToFileURL(path.join(repoRoot, "parity", "tty-harness.mjs")).href;
  }
  // Harness-only timer-globals restore for http2 parity
  // (parity/http2-harness.mjs). ESM import path; CJS require path is in
  // preload.mjs.
  if (target === "http2" && name === "http2") {
    return pathToFileURL(path.join(repoRoot, "parity", "http2-harness.mjs"))
      .href;
  }
  // Harness-only timer-globals restore for https parity
  // (parity/https-harness.mjs). ESM import path; CJS require path is in
  // preload.mjs.
  if (target === "https" && name === "https") {
    return pathToFileURL(path.join(repoRoot, "parity", "https-harness.mjs"))
      .href;
  }
  // Harness-only timer-globals restore for child_process parity
  // (parity/child_process-harness.mjs). ESM import path; CJS require path is
  // in preload.mjs.
  if (target === "child_process" && name === "child_process") {
    return pathToFileURL(
      path.join(repoRoot, "parity", "child_process-harness.mjs"),
    ).href;
  }
  // Harness-only timer-globals restore for net under the http target
  // (parity/net-harness.mjs): http tests that import 'net' get the shim so
  // net.createConnection() reaches the http shim's virtual server.
  // src/net.js itself is untouched.
  if (target === "http" && name === "net") {
    return pathToFileURL(path.join(repoRoot, "parity", "net-harness.mjs")).href;
  }
  // Harness-only timer-globals restore for net parity
  // (parity/net-harness.mjs). ESM import path; CJS require path is in
  // preload.mjs.
  if (target === "net" && name === "net") {
    return pathToFileURL(path.join(repoRoot, "parity", "net-harness.mjs")).href;
  }
  const candidate = path.join(repoRoot, "src", ...parts) + ".js";
  if (!fs.existsSync(candidate)) return null;
  return pathToFileURL(candidate).href;
}

export async function resolve(specifier, context, nextResolve) {
  let parentPath = "";
  try {
    parentPath = fileURLToPath(context.parentURL ?? "");
  } catch {
    /* ignore */
  }
  // For the fs target, common/fs.js (directory-comparison helpers) also
  // needs the shim: it reads the cp dest out of memfs.
  const isFsHelper =
    target === "fs" &&
    parentPath ===
      path.join(repoRoot, "parity", "node-test", "common", "fs.js");
  if (parentPath.startsWith(testsDir) || isFsHelper) {
    const url = polyfillURL(specifier);
    if (url) return { url, shortCircuit: true };
  }
  // Shims in src/ use relative imports (e.g. src/repl.js imports "./readline").
  // Node ESM doesn't resolve directory imports, so map "./readline" to the
  // actual src/readline.js file. This applies when the parent is a shim file
  // loaded via the parity harness.
  const srcDir = path.join(repoRoot, "src") + path.sep;
  if (
    parentPath.startsWith(srcDir) &&
    (specifier.startsWith("./") || specifier.startsWith("../"))
  ) {
    const resolved = path.resolve(path.dirname(parentPath), specifier);
    // Try with .js extension (directory imports like "./readline" -> "./readline.js")
    const candidates = [resolved + ".js", resolved];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    // Also try index.js for directory imports
    const indexCandidate = path.join(resolved, "index.js");
    if (fs.existsSync(indexCandidate)) {
      return { url: pathToFileURL(indexCandidate).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
