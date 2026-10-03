import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * moduleRegistry dedup by resolved path (RED-first).
 *
 * Root cause: loadModule keyed moduleRegistry by `${entryPoint}::${modulePath}`
 * using the RAW import specifier. Vite's chunks import the WASM binding via
 * different specifiers ("../rolldown-binding.wasi.cjs", "@rolldown/browser",
 * ...) that all resolve to the SAME file → 7 registry entries → 7 data: URLs
 * → 7 evaluations → 7 × 1GB WebAssembly.Memory → browser process death.
 *
 * Fix: after _dynamic_import returns importResult.resolvedPath, canonicalize
 * the registry entry to just the resolvedPath. An aliased import
 * that resolves to an already-loading/done file reuses that record instead
 * of evaluating again. sourceURL/source maps are stamped with the resolved
 * path so identical files also yield identical data: URLs (browser module
 * map dedupes as a second line of defense).
 *
 * 2026-10-02 follow-up: the entryPoint prefix had to go entirely. Vite's
 * chunks import the binding from DIFFERENT entry points (each chunk stamps
 * its own resolved path as entryPoint), so `entry::resolved` still split
 * one file into N evaluations (observed 9x, browser died at +112s). Node
 * evaluates once per resolved path per realm; the registry now does too.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);

function extractBalanced(src, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced");
}

function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) return null;
  const parenOpen = src.indexOf("(", start);
  const parenClose = extractBalanced(src, parenOpen, "(", ")");
  const braceOpen = src.indexOf("{", parenClose);
  const braceClose = extractBalanced(src, braceOpen, "{", "}");
  return src.slice(start, braceClose + 1);
}

// NOTE: runtime.js embeds the sandbox template with escaped backticks (\`).
// The helpers below use no backticks, so they extract verbatim.
const KEY_SRC = extractFunction(RUNTIME_SRC, "function canonicalRegistryKey(");
const DEDUP_SRC = extractFunction(
  RUNTIME_SRC,
  "function canonicalizeRegistryEntry(",
);

function loadHelpers() {
  if (!KEY_SRC || !DEDUP_SRC) return null;
  return new Function(
    `"use strict";\n${KEY_SRC}\n${DEDUP_SRC}\nreturn { canonicalRegistryKey, canonicalizeRegistryEntry };`,
  )();
}

describe("canonicalRegistryKey: key by resolved path, not raw specifier", () => {
  test("helpers exist in runtime.js", () => {
    expect(KEY_SRC).not.toBeNull();
    expect(DEDUP_SRC).not.toBeNull();
  });

  test("uses resolvedPath when present (no entry prefix)", () => {
    const h = loadHelpers();
    expect(h).not.toBeNull();
    expect(
      h.canonicalRegistryKey(
        "/entry.js",
        "../binding.wasi.cjs",
        "/node_modules/pkg/binding.wasi.cjs",
      ),
    ).toBe("/node_modules/pkg/binding.wasi.cjs");
  });

  test("falls back to the raw specifier when resolvedPath is null (builtins)", () => {
    const h = loadHelpers();
    expect(h).not.toBeNull();
    expect(h.canonicalRegistryKey("/entry.js", "fs", null)).toBe("fs");
  });

  test("different specifiers resolving to the same file share one key", () => {
    const h = loadHelpers();
    expect(h).not.toBeNull();
    const k1 = h.canonicalRegistryKey(
      "/entry.js",
      "../rolldown-binding.wasi.cjs",
      "/node_modules/@rolldown/binding/rolldown-binding.wasi.cjs",
    );
    const k2 = h.canonicalRegistryKey(
      "/entry.js",
      "@rolldown/browser",
      "/node_modules/@rolldown/binding/rolldown-binding.wasi.cjs",
    );
    expect(k1).toBe(k2);
  });

  test("same resolved path from DIFFERENT entry points shares one key (vite chunks)", () => {
    // 2026-10-02: each vite chunk stamps its own resolved path as entryPoint,
    // so an entryPoint-prefixed key still split one file into N evaluations
    // (9x observed, browser died at +112s). Node evaluates once per resolved
    // path per realm; the registry must too.
    const h = loadHelpers();
    expect(h).not.toBeNull();
    const k1 = h.canonicalRegistryKey(
      "/node_modules/vite/dist/node/chunks/chunk-a.js",
      "../rolldown-binding.wasi.cjs",
      "/node_modules/@rolldown/browser/dist/rolldown-binding.wasi-browser.js",
    );
    const k2 = h.canonicalRegistryKey(
      "/node_modules/vite/dist/node/chunks/chunk-b.js",
      "@rolldown/browser",
      "/node_modules/@rolldown/browser/dist/rolldown-binding.wasi-browser.js",
    );
    expect(k1).toBe(k2);
    expect(k1).toBe(
      "/node_modules/@rolldown/browser/dist/rolldown-binding.wasi-browser.js",
    );
  });
});

describe("canonicalizeRegistryEntry: migrate-or-reuse decision", () => {
  test("same key: no-op, returns no reuse", () => {
    const h = loadHelpers();
    expect(h).not.toBeNull();
    const registry = new Map();
    const record = { status: "loading", exports: {} };
    registry.set("e::/a.js", record);
    const out = h.canonicalizeRegistryEntry(
      registry,
      "e::/a.js",
      "e::/a.js",
      record,
    );
    expect(out.reused).toBeNull();
    expect(registry.get("e::/a.js")).toBe(record);
  });

  test("aliased specifier, no existing record: migrates to canonical key", () => {
    const h = loadHelpers();
    expect(h).not.toBeNull();
    const registry = new Map();
    const record = { status: "loading", exports: {} };
    registry.set("e::../x.cjs", record);
    const out = h.canonicalizeRegistryEntry(
      registry,
      "e::../x.cjs",
      "/pkg/x.cjs",
      record,
    );
    expect(out.reused).toBeNull();
    expect(registry.has("e::../x.cjs")).toBe(false);
    expect(registry.get("/pkg/x.cjs")).toBe(record);
  });

  test("aliased specifier, existing DONE record: reuses, drops provisional", () => {
    const h = loadHelpers();
    expect(h).not.toBeNull();
    const registry = new Map();
    const done = { status: "done", exports: { answer: 42 } };
    const loading = { status: "loading", exports: {} };
    registry.set("/pkg/x.cjs", done);
    registry.set("e::@pkg/x", loading);
    const out = h.canonicalizeRegistryEntry(
      registry,
      "e::@pkg/x",
      "/pkg/x.cjs",
      loading,
    );
    expect(out.reused).toBe(done);
    expect(out.reused.exports).toEqual({ answer: 42 });
    expect(registry.has("e::@pkg/x")).toBe(false);
    expect(registry.get("/pkg/x.cjs")).toBe(done);
  });

  test("aliased specifier, existing LOADING record: reuses partial exports (Node circular semantics)", () => {
    const h = loadHelpers();
    expect(h).not.toBeNull();
    const registry = new Map();
    const partial = {};
    const loading = { status: "loading", exports: partial };
    const mine = { status: "loading", exports: {} };
    registry.set("/pkg/x.cjs", loading);
    registry.set("e::../x.cjs", mine);
    const out = h.canonicalizeRegistryEntry(
      registry,
      "e::../x.cjs",
      "/pkg/x.cjs",
      mine,
    );
    expect(out.reused).toBe(loading);
    expect(out.reused.exports).toBe(partial);
    expect(registry.has("e::../x.cjs")).toBe(false);
  });

  test("entry point does NOT split: same resolved path, different entries share the record", () => {
    // 2026-10-02: flipped. The old entryPoint-prefixed key split one file
    // into N evaluations when imported from different chunks (9x WASM
    // binding evals -> browser death). Resolved path alone disambiguates:
    // /a/utils.js vs /b/utils.js are already different keys.
    const h = loadHelpers();
    expect(h).not.toBeNull();
    const k1 = h.canonicalRegistryKey("/a.js", "./x.js", "/pkg/x.js");
    const k2 = h.canonicalRegistryKey("/b.js", "./x.js", "/pkg/x.js");
    expect(k1).toBe(k2);
  });
});

describe("loadModule stamps sourceURL with the resolved path", () => {
  test("sourceURL uses buildFileName (resolved), not the raw specifier", () => {
    // The data: URL must be identical for identical files so the browser
    // module map dedupes as a second line of defense.
    const idx = RUNTIME_SRC.indexOf("//# sourceURL=");
    expect(idx).not.toBe(-1);
    const line = RUNTIME_SRC.slice(idx, RUNTIME_SRC.indexOf("\n", idx));
    expect(line).toContain("buildFileName");
    expect(line).not.toContain("${modulePath}");
  });
});
