// Tests for the demo-only fake shell (roadmap §2).
// Pure-logic tests with stub fs/execute — no browser needed.
import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFakeShell,
  resolveBinCommands,
} from "../examples/fake-shell/fake-shell.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stubFs() {
  const files = new Map();
  return {
    mkdirSync() {},
    writeFileSync(p, d) {
      files.set(p, String(d));
    },
    readFileSync(p) {
      if (!files.has(p))
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p);
    },
    _files: files,
  };
}

const PKG = { name: "cowsay", version: "1.0.0", bin: "./bin/cowsay.js" };
const FILES = {
  "bin/cowsay.js": 'console.log("moo " + process.argv.slice(2).join(" "));',
};

describe("resolveBinCommands", () => {
  test("string bin maps package name to path", () => {
    expect(resolveBinCommands(PKG)).toEqual({ cowsay: "./bin/cowsay.js" });
  });

  test("object bin passes through", () => {
    const pkg = { name: "x", bin: { a: "./a.js", b: "./b.js" } };
    expect(resolveBinCommands(pkg)).toEqual({ a: "./a.js", b: "./b.js" });
  });

  test("missing bin yields no commands", () => {
    expect(resolveBinCommands({ name: "x" })).toEqual({});
  });
});

describe("createFakeShell", () => {
  test("install writes package files under node_modules/<name>", async () => {
    const mem = stubFs();
    const shell = createFakeShell({ fs: mem, execute: async () => ({}) });
    await shell.install(PKG, FILES);
    expect(mem._files.get("/node_modules/cowsay/bin/cowsay.js")).toBe(
      FILES["bin/cowsay.js"],
    );
  });

  test("install registers the bin command name", async () => {
    const shell = createFakeShell({ fs: stubFs(), execute: async () => ({}) });
    await shell.install(PKG, FILES);
    expect(shell.list()).toEqual(["cowsay"]);
  });

  test("object bin registers every command", async () => {
    const shell = createFakeShell({ fs: stubFs(), execute: async () => ({}) });
    await shell.install(
      {
        name: "tools",
        version: "1.0.0",
        bin: { lint: "./lint.js", fmt: "./fmt.js" },
      },
      { "lint.js": "1", "fmt.js": "2" },
    );
    expect(shell.list().sort()).toEqual(["fmt", "lint"]);
  });

  test("exec on unknown command throws", async () => {
    const shell = createFakeShell({ fs: stubFs(), execute: async () => ({}) });
    await expect(shell.exec("nope")).rejects.toThrow("command not found: nope");
  });

  test("exec routes the bin script through execute() with argv set", async () => {
    const calls = [];
    const shell = createFakeShell({
      fs: stubFs(),
      execute: async (code) => {
        calls.push(code);
        return { success: true };
      },
    });
    await shell.install(PKG, FILES);
    await shell.exec("cowsay", ["hello", "world"]);
    expect(calls).toHaveLength(1);
    const [code] = calls;
    // argv assignment first, then the script source — the runtime's node path
    expect(code).toContain(
      'process.argv = ["node","/node_modules/cowsay/bin/cowsay.js","hello","world"]',
    );
    expect(code).toContain(FILES["bin/cowsay.js"]);
  });

  test("DEMO ONLY: runtime.js never references the fake shell", () => {
    const runtimeSrc = fs.readFileSync(
      path.join(__dirname, "..", "runtime.js"),
      "utf8",
    );
    expect(runtimeSrc).not.toContain("fake-shell");
    expect(runtimeSrc).not.toContain("examples/");
  });
});
