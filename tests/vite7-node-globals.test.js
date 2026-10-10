// Global support: the Node.js `global` alias must be installed for sandboxed
// modules (Vite/Vitest reference `global`, not just `globalThis`).
//
// Two installation points, both required:
//  1. src/node_globals.js — the documented module loaded at sandbox startup
//     via loadModule("RUNTIME:NODE_GLOBALS").
//  2. runtime.js generate() template — the operative hand-maintained sandbox
//     script (e4f3ed8f); guarded here so the hunk is never silently dropped.
import { jest } from "@jest/globals"; // ESM: jest object is not a global here
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("node_globals installs the Node.js `global` alias", () => {
  let saved;
  beforeEach(() => {
    saved = globalThis.global;
    jest.resetModules();
  });
  afterEach(() => {
    if (saved === undefined) delete globalThis.global;
    else globalThis.global = saved;
  });

  test("missing `global` is installed as an alias of globalThis", async () => {
    delete globalThis.global;
    expect(typeof globalThis.global).toBe("undefined");
    await import("../src/node_globals.js");
    expect(globalThis.global).toBe(globalThis);
  });

  test("existing `global` is never overwritten", async () => {
    // Realistic pre-existing global: inherits the real primordials.
    const sentinel = Object.create(globalThis);
    sentinel.__test_marker__ = true;
    globalThis.global = sentinel;
    await import("../src/node_globals.js");
    expect(globalThis.global).toBe(sentinel);
  });

  test("alias is self-consistent like Node (global.global === global)", async () => {
    delete globalThis.global;
    await import("../src/node_globals.js");
    expect(globalThis.global.global).toBe(globalThis);
  });
});

describe("sandbox template keeps the operative `global` hunk", () => {
  // The template now lives in src/sandbox-template.js (built from
  // src/sandbox/*.js); guarded here so the hunk is never silently dropped.
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "sandbox-template.js"),
    "utf8",
  );
  test("generate() installs globalThis.global when missing", () => {
    expect(src).toMatch(/typeof globalThis\.global === ['"]undefined['"]/);
    expect(src).toMatch(/globalThis\.global = globalThis/);
  });
  test("alias is installed outside the defineProperty try block", () => {
    // The alias must survive a defineProperty(window,'process') throw, so it
    // lives after the catch — never inside the try. This pins the ordering
    // (regression: the alias used to sit inside the try and was skipped in
    // the M3 sandbox realm, causing `global is not defined`).
    const tryIdx = src.indexOf("Object.defineProperty(window, 'process'");
    const catchIdx = src.indexOf("}catch(err){", tryIdx);
    const aliasIdx = src.indexOf("globalThis.global = globalThis", catchIdx);
    expect(tryIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(tryIdx);
    expect(aliasIdx).toBeGreaterThan(catchIdx);
    expect(src.slice(catchIdx, aliasIdx)).not.toMatch(/try\s*\{/);
  });
});
