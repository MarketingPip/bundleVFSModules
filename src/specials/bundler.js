// moduleLoader.js
import {parse} from "https://esm.sh/acorn";
import { simple } from "https://esm.sh/acorn-walk";

// ─── Fetch cache ─────────────────────────────────────────────────────────────

const fetchCache = new Map(); // url → Promise<string>

function fetchModule(url) {
  if (fetchCache.has(url)) return fetchCache.get(url);
  const p = fetch(url).then((res) => {
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${url}`);
    return res.text();
  });
  fetchCache.set(url, p);
  return p; // shared Promise — no duplicate requests
}

// ─── URL resolution ───────────────────────────────────────────────────────────

function resolveImport(spec, importer) {
  if (/^https?:\/\//.test(spec)) return spec;
  if (spec.startsWith("/")) return new URL(spec, new URL(importer).origin).href;
  if (spec.startsWith("./") || spec.startsWith("../")) return new URL(spec, importer).href;
  throw new Error(`Bare specifier "${spec}" — supply a full URL or CDN prefix`);
}

// ─── AST extraction ───────────────────────────────────────────────────────────

function extractImports(code, baseUrl) {
  let ast;
  try {
    ast = parse(code, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return []; // opaque / CJS module — treat as leaf
  }
  const hits = [];
  const record = (node) => {
    const src = node.source;
    if (!src || src.type !== "Literal" || typeof src.value !== "string") return;
    hits.push({ start: src.start, end: src.end, url: resolveImport(src.value, baseUrl) });
  };
  simple(ast, {
    ImportDeclaration: record,
    ExportNamedDeclaration: record,
    ExportAllDeclaration: record,
    ImportExpression(node) {
      const src = node.source;
      if (src?.type === "Literal" && typeof src.value === "string")
        hits.push({ start: src.start, end: src.end, url: resolveImport(src.value, baseUrl) });
    },
  });
  return hits.sort((a, b) => a.start - b.start);
}

// ─── Parallel graph collection ────────────────────────────────────────────────

async function collectModules(entryUrl) {
  const modules = new Map();
  const deps = new Map();
  const inFlight = new Map(); // dedup concurrent visits to the same URL

  function visit(url) {
    if (inFlight.has(url)) return inFlight.get(url);
    const p = fetchModule(url).then(async (code) => {
      const hits = extractImports(code, url);
      const depUrls = hits.map((h) => h.url);
      let rewritten = "";
      let cursor = 0;
      for (const { start, end, url: depUrl } of hits) {
        rewritten += code.slice(cursor, start) + `"${depUrl}"`;
        cursor = end;
      }
      rewritten += code.slice(cursor);
      modules.set(url, rewritten);
      deps.set(url, depUrls);
      await Promise.all(depUrls.map(visit)); // fetch all deps in parallel
    });
    inFlight.set(url, p);
    return p;
  }

  await visit(entryUrl);
  return { modules, deps };
}

// ─── Topological sort ─────────────────────────────────────────────────────────

function topoSort(entryUrl, deps) {
  const order = [];
  const visited = new Set();
  const recursionStack = new Set(); // Tracks modules in the current path

  function visit(url) {
    if (recursionStack.has(url)) {
      // Circular dependency detected!
      console.warn(`Circular dependency detected: ${url} is part of a loop.`);
      return; 
    }
    if (visited.has(url)) return;

    recursionStack.add(url);
    visited.add(url);

    const moduleDeps = deps.get(url) ?? [];
    for (const dep of moduleDeps) {
      visit(dep);
    }

    recursionStack.delete(url); // Path finished
    order.push(url); // Post-order: dependencies first
  }

  visit(entryUrl);
  return order;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Bundle entryUrl and all transitive dependencies.
 *
 * Returns { url, revoke }.
 *   url    — blob: URL ready for dynamic import (no base64, no size limit)
 *   revoke — call after import() to free all Blob URLs for this bundle
 *
 * @example
 * const { url, revoke } = await bundle("https://esm.sh/some-lib");
 * const mod = await import(url);
 * revoke();
 */
export async function bundle(entryUrl) {
  const { modules, deps } = await collectModules(entryUrl);
  const order = topoSort(entryUrl, deps);

  const blobUrls = new Map();
  const created = [];

  for (const url of order) {
    let code = modules.get(url);
    const moduleDeps = deps.get(url) ?? [];

    /**
     * Precise Rewriting:
     * Instead of replaceAll (which might corrupt string literals), 
     * we should ideally use the AST offsets. However, since we already 
     * performed one pass of rewriting in collectModules, the offsets 
     * have shifted. 
     * * To be safe, we replace the absolute URLs generated in collectModules
     * with their final blob: equivalents.
     */
    for (const depUrl of moduleDeps) {
      const blobUrl = blobUrls.get(depUrl);
      if (blobUrl) {
        // We only replace exact quoted matches of the absolute URL
        // to minimize accidental "partial string" corruption.
        code = code.split(`"${depUrl}"`).join(`"${blobUrl}"`);
      }
    }

    const blob = new Blob([code], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    
    blobUrls.set(url, blobUrl);
    created.push(blobUrl);
  }

  return {
    url: blobUrls.get(entryUrl),
    revoke() {
      created.forEach((u) => URL.revokeObjectURL(u));
    },
  };
}
