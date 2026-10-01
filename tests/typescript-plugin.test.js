import { describe, test, expect, beforeEach } from "@jest/globals";
import {
  registerPlugin,
  clearPlugins,
  applyTransformPlugins,
} from "../src/plugins.js";
import { typescriptPlugin } from "../src/plugins/typescript.js";

beforeEach(() => {
  clearPlugins();
});

describe("TypeScript plugin", () => {
  test("plugin has correct name", () => {
    expect(typescriptPlugin.name).toBe("typescript");
  });

  test("transforms .ts files by stripping type annotations", async () => {
    registerPlugin(typescriptPlugin);
    const tsCode = `
      function greet(name: string): string {
        return "hello " + name;
      }
      const x: number = 42;
    `;
    const result = await applyTransformPlugins(tsCode, "/test/file.ts");
    // Type annotations should be stripped
    expect(result).not.toContain(": string");
    expect(result).not.toContain(": number");
    expect(result).toContain("function greet(name)");
    expect(result).toContain("const x = 42");
  });

  test("ignores non-.ts files", async () => {
    registerPlugin(typescriptPlugin);
    const jsCode = "const x: number = 42;"; // invalid JS, but plugin should ignore
    const result = await applyTransformPlugins(jsCode, "/test/file.js");
    expect(result).toBe(jsCode); // unchanged
  });

  test("handles interfaces and type aliases", async () => {
    registerPlugin(typescriptPlugin);
    const tsCode = `
      interface User { name: string; age: number; }
      type ID = string | number;
      const u: User = { name: "a", age: 1 };
    `;
    const result = await applyTransformPlugins(tsCode, "/test/types.ts");
    expect(result).not.toContain("interface User");
    expect(result).not.toContain("type ID");
  });
});
