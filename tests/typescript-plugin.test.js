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

  // The cases below are RED against the old regex-strip implementation:
  // every one of them produced output that is not valid JavaScript.
  // They prove the plugin uses a real transpiler, not pattern matching.
  // Each case executes the output to prove it is runnable JS.

  test("transpiles enums (regex left 'enum' keyword -> SyntaxError)", async () => {
    registerPlugin(typescriptPlugin);
    const tsCode = `
      enum Color { Red, Green, Blue }
      const c: Color = Color.Green;
    `;
    const result = await applyTransformPlugins(tsCode, "/test/enum.ts");
    expect(result).not.toMatch(/\benum\s+Color/);
    const run = new Function(`${result}; return [Color.Red, Color.Green, c];`);
    expect(run()).toEqual([0, 1, 1]);
  });

  test("transpiles 'as' casts (regex left 'as' -> SyntaxError)", async () => {
    registerPlugin(typescriptPlugin);
    const tsCode = `const x = "hello" as string;`;
    const result = await applyTransformPlugins(tsCode, "/test/as.ts");
    expect(result).not.toContain(" as ");
    const run = new Function(`${result}; return x;`);
    expect(run()).toBe("hello");
  });

  test("transpiles non-null assertions (regex left '!' -> SyntaxError)", async () => {
    registerPlugin(typescriptPlugin);
    const tsCode = `
      function getV(m: { v: number } | null): number { return m!.v; }
      const y = getV({ v: 7 });
    `;
    const result = await applyTransformPlugins(tsCode, "/test/bang.ts");
    const run = new Function(`${result}; return y;`);
    expect(run()).toBe(7);
  });

  test("transpiles generics (regex left '<T>' -> SyntaxError)", async () => {
    registerPlugin(typescriptPlugin);
    const tsCode = `
      function id<T>(x: T): T { return x; }
      const z = id<number>(5);
    `;
    const result = await applyTransformPlugins(tsCode, "/test/generics.ts");
    expect(result).not.toMatch(/<T>/);
    const run = new Function(`${result}; return z;`);
    expect(run()).toBe(5);
  });

  test("transpiles namespaces (regex left 'namespace' -> SyntaxError)", async () => {
    registerPlugin(typescriptPlugin);
    const tsCode = `
      namespace NS { export const v = 42; }
      const w = NS.v;
    `;
    const result = await applyTransformPlugins(tsCode, "/test/ns.ts");
    expect(result).not.toMatch(/\bnamespace\s+NS/);
    const run = new Function(`${result}; return w;`);
    expect(run()).toBe(42);
  });

  test("transpiles legacy decorators (regex could not)", async () => {
    registerPlugin(typescriptPlugin);
    const tsCode = `
      function sealed(constructor: Function) { (constructor as any).sealed = true; }
      @sealed
      class Foo {}
      const isSealed = (Foo as any).sealed === true;
    `;
    const result = await applyTransformPlugins(tsCode, "/test/deco.ts");
    const run = new Function(`${result}; return isSealed;`);
    expect(run()).toBe(true);
  });
});
