/**
 * Tests for the opt-in `typecheck(files)` hook (docs/PLUGINS.md Part B §4).
 *
 * The hook runs FULL ts.createProgram checking on demand and must NEVER
 * slow down execute(): the transpile-only transform path stays the default.
 */
import { describe, test, expect, beforeEach } from "@jest/globals";
import { typescriptPlugin } from "../src/plugins/typescript.js";

const MISTYPED = [
  {
    path: "/a.ts",
    contents:
      "export function add(a: number, b: number): number { return a + b; }",
  },
  {
    path: "/b.ts",
    contents:
      'import { add } from "./a";\nconst s: string = add(1, 2);\nconsole.log(s);',
  },
];

const CLEAN = [
  {
    path: "/a.ts",
    contents:
      "export function add(a: number, b: number): number { return a + b; }",
  },
  {
    path: "/b.ts",
    contents:
      'import { add } from "./a";\nconst s: number = add(1, 2);\nconsole.log(s);',
  },
];

beforeEach(() => {
  typescriptPlugin._resetTypecheckCache();
});

describe("typecheck hook", () => {
  test("returns diagnostics with {file, line, column, message, code} shape", async () => {
    const diags = await typescriptPlugin.typecheck(MISTYPED);
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) {
      expect(typeof d.file === "string" || d.file === null).toBe(true);
      expect(typeof d.line === "number" || d.line === null).toBe(true);
      expect(typeof d.column === "number" || d.column === null).toBe(true);
      expect(typeof d.message).toBe("string");
      expect(typeof d.code).toBe("number");
    }
  });

  test("catches a mistyped export across files (TS2322 on b.ts)", async () => {
    const diags = await typescriptPlugin.typecheck(MISTYPED);
    const err = diags.find((d) => d.code === 2322);
    expect(err).toBeDefined();
    expect(err.file).toBe("/b.ts");
    expect(err.line).toBe(2);
    expect(err.message).toMatch(/not assignable/);
  });

  test("clean program returns []", async () => {
    const diags = await typescriptPlugin.typecheck(CLEAN);
    expect(diags).toEqual([]);
  });

  test("empty file list returns []", async () => {
    expect(await typescriptPlugin.typecheck([])).toEqual([]);
  });

  test("non-TS files are ignored as program roots", async () => {
    const diags = await typescriptPlugin.typecheck([
      { path: "/notes.txt", contents: "not code at all {{{" },
    ]);
    expect(diags).toEqual([]);
  });

  test("second identical call reuses the cached program (no rebuild)", async () => {
    await typescriptPlugin.typecheck(MISTYPED);
    const buildsAfterFirst = typescriptPlugin._buildCount();
    expect(buildsAfterFirst).toBe(1);
    await typescriptPlugin.typecheck(MISTYPED);
    expect(typescriptPlugin._buildCount()).toBe(buildsAfterFirst);
  });

  test("changed files invalidate the cache (rebuild)", async () => {
    await typescriptPlugin.typecheck(MISTYPED);
    expect(typescriptPlugin._buildCount()).toBe(1);
    const changed = MISTYPED.map((f) =>
      f.path === "/b.ts"
        ? { ...f, contents: f.contents.replace("string", "number") }
        : f,
    );
    const diags = await typescriptPlugin.typecheck(changed);
    expect(typescriptPlugin._buildCount()).toBe(2);
    expect(diags).toEqual([]);
  });

  test("transform (fast path) never builds a program", async () => {
    const js = await typescriptPlugin.transform(
      "const x: number = 'nope';",
      "/bad.ts",
    );
    expect(typeof js).toBe("string");
    expect(js).not.toMatch(/: number/); // types stripped
    expect(typescriptPlugin._buildCount()).toBe(0);
  });

  test("transform still strips types on a program with errors", async () => {
    // execute() runs this output; type errors must not block it.
    const js = await typescriptPlugin.transform(MISTYPED[1].contents, "/b.ts");
    expect(js).toContain("add(1, 2)");
    expect(typescriptPlugin._buildCount()).toBe(0);
  });
});
