// moduleLoader.js
import * as acorn from "https://esm.sh/acorn";
import { simple } from "https://esm.sh/acorn-walk";

const cache = new Map();

async function fetchModule(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  cache.set(url, text);
  return text;
}

function resolveImport(importPath, importer) {
  if (/^https?:\/\//.test(importPath)) return importPath;
  if (importPath.startsWith("/")) return new URL(importPath, new URL(importer).origin).toString();
  if (importPath.startsWith("./") || importPath.startsWith("../")) return new URL(importPath, importer).toString();
  return importPath;
 // throw new Error(`Bare specifier "${importPath}" — pass a full URL or CDN prefix`);
}

/**
 * Collect every module reachable from entryUrl.
 * Returns:
 *   modules  — { url: rewrittenCode }   (import specifiers → absolute URLs)
 *   deps     — { url: [depUrl, …] }     (adjacency list for topo sort)
 */
async function collectModules(entryUrl, modules = {}, deps = {}, seen = new Set()) {
  if (seen.has(entryUrl)) return { modules, deps };
  seen.add(entryUrl);

  const code = await fetchModule(entryUrl);
  const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
  const rewrites = [];  // { start, end, url }
  const depUrls = [];

  const handleSource = (node) => {
    if (!node.source) return;
    const url = resolveImport(node.source.value, entryUrl);
    rewrites.push({ start: node.source.start, end: node.source.end, url });
    depUrls.push(url);
  };

  simple(ast, {
    ImportDeclaration: handleSource,
    ExportNamedDeclaration: handleSource,
    ExportAllDeclaration: handleSource,
  });

  // Sort by position so slicing offsets stay valid
  rewrites.sort((a, b) => a.start - b.start);

  // Rewrite all specifiers to absolute URLs in one pass
  let rewritten = "";
  let last = 0;
  for (const { start, end, url } of rewrites) {
    rewritten += code.slice(last, start) + `"${url}"`;
    last = end;
  }
  rewritten += code.slice(last);

  modules[entryUrl] = rewritten;
  deps[entryUrl] = depUrls;

  // Recurse into dependencies
  for (const url of depUrls) {
    await collectModules(url, modules, deps, seen);
  }

  return { modules, deps };
}

/**
 * Topological sort — dependencies come before dependents.
 * (Same ordering esbuild uses when it concatenates chunks.)
 */
function topoSort(entryUrl, deps) {
  const order = [];
  const visited = new Set();

  function visit(url) {
    if (visited.has(url)) return;
    visited.add(url);
    for (const dep of deps[url] ?? []) visit(dep);
    order.push(url);           // push AFTER children → leaves first
  }

  visit(entryUrl);
  return order;
}

/**
 * Bundle entryUrl and all its transitive dependencies.
 *
 * Strategy (mirrors esbuild's chunk linking):
 *   1. Collect every module with absolute-URL specifiers.
 *   2. Topo-sort so every dep is ready before its consumer.
 *   3. For each module (leaves → entry), replace every absolute URL
 *      with the Blob URL already created for that dependency.
 *   4. Seal the module in its own Blob URL.
 *
 * Returns a Blob URL for the entry module.
 * Use it with:  const mod = await import(blobUrl)
 */
export async function bundle(entryUrl) {
  const { modules, deps } = await collectModules(entryUrl);
  const order = topoSort(entryUrl, deps);     // e.g. [lodash.mjs, lodash-entry]

  const blobUrls = {};   // absUrl → blobUrl

  for (const url of order) {
    let code = modules[url];

    // Rewrite every already-resolved dependency to its Blob URL
    for (const [abs, blob] of Object.entries(blobUrls)) {
      // String split/join is safe: we already normalised all specifiers to abs URLs
      code = code.split(`"${abs}"`).join(`"${blob}"`);
    }

    blobUrls[url] = URL.createObjectURL(
      new Blob([code], { type: "application/javascript" })
    );
  }

  return blobUrls[entryUrl];
}
