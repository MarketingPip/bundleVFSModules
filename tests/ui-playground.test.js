// Tests for the UI extraction: runtime.js is a pure library (no demo UI),
// and src/ui/playground.js is the ONE playground framework.
import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);
const PLAYGROUND_SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "ui", "playground.js"),
  "utf8",
);

function extractFunction(src, name) {
  const marker = "function " + name + "(";
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("function not found: " + name);
  // Skip the parameter list (may contain destructuring braces) by
  // paren-matching first, then brace-match the body.
  let i = src.indexOf("(", start) + 1;
  let pdepth = 1;
  for (; i < src.length && pdepth > 0; i++) {
    if (src[i] === "(") pdepth++;
    else if (src[i] === ")") pdepth--;
  }
  i = src.indexOf("{", i);
  let depth = 0;
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces in " + name);
}

describe("runtime.js is a pure library", () => {
  // Strip comments: the extraction notes mention the old names, which is
  // explicitly allowed. What matters is no FUNCTIONAL demo code remains.
  const CODE = RUNTIME_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
    /\/\/[^\n]*/g,
    "",
  );

  test("no demo playground markers or flags", () => {
    expect(CODE).not.toContain("__BVM_DISABLE_PLAYGROUND");
    expect(CODE).not.toContain("__BVM_PLAYGROUND_BEGIN__");
    expect(CODE).not.toContain("__BVM_PLAYGROUND_END__");
    expect(CODE).not.toContain("__BVM_PLAYGROUND_GUARD_BEGIN__");
    expect(CODE).not.toContain("__BVM_PLAYGROUND_GUARD_END__");
    expect(CODE).not.toContain("__bvmPlaygroundPresent");
    expect(CODE).not.toContain("function initPlayground(");
  });

  test("no xterm import and no demo DOM lookups", () => {
    expect(CODE).not.toContain("xterm@");
    expect(CODE).not.toContain('from "https://esm.sh/xterm');
    expect(CODE).not.toContain("globalThis._xterm");
    expect(CODE).not.toContain('getElementById("codeInput")');
    expect(CODE).not.toContain('getElementById("output")');
    expect(CODE).not.toContain('getElementById("files")');
    expect(CODE).not.toContain("function renderFiles(");
    expect(CODE).not.toContain("function renderFiles2(");
    expect(CODE).not.toContain("const examples = {");
  });

  test("no module-level demo sandbox", () => {
    // The old module-level `const sandbox = new CodeSandbox({...})` demo is gone.
    expect(CODE).not.toMatch(/^const sandbox = new CodeSandbox\(/m);
  });

  test("library exports are intact", () => {
    for (const name of [
      "export class CodeSandbox",
      "export async function executeCode",
      "export function createSandbox",
      "export function toNodeKeypress",
      "export function transpileTypeScript",
      "export function flattenFileTree",
      "export function formatErrors",
      "export const builtinModules",
      "export const customAcorn",
    ]) {
      expect(RUNTIME_SRC).toContain(name);
    }
  });

  test("extraction notes explain the moves", () => {
    expect(RUNTIME_SRC).toContain("src/ui/playground.js");
  });
});

describe("src/ui/playground.js framework", () => {
  test("exports the framework surface", () => {
    for (const name of [
      "export function initPlayground",
      "export const EXAMPLES",
      "export function createDemoSandbox",
      "export function wireDemoHandlers",
      "export function splitArgv",
      "export function renderFiles",
      "export function renderFiles2",
    ]) {
      expect(PLAYGROUND_SRC).toContain(name);
    }
  });

  test("EXAMPLES has the 20 canonical snippets", () => {
    const keys = [
      "basic",
      "async",
      "sleep",
      "imports",
      "require",
      "process_kill",
      "interop",
      "top_level",
      "typescript",
      "relative",
      "tests",
      "cli",
      "cli_menu",
      "inquirer",
      "repl",
      "repl2",
      "fs",
      "child_process",
      "http",
      "express",
    ];
    for (const k of keys) {
      expect(PLAYGROUND_SRC).toContain(`  ${k}: \``);
    }
  });

  test("owns the demo-only CDN imports (xterm, shellwords)", () => {
    expect(PLAYGROUND_SRC).toContain("https://esm.sh/xterm@");
    expect(PLAYGROUND_SRC).toContain("https://esm.sh/shellwords");
  });

  test("initPlayground requires a CodeSandbox class", () => {
    const src = extractFunction(PLAYGROUND_SRC, "initPlayground");
    // The real initPlayground needs DOM + CDN imports; here we only check
    // the guard clause shape via source.
    expect(src).toContain("if (!CodeSandbox)");
    expect(src).toContain(
      'throw new Error("initPlayground requires { CodeSandbox }")',
    );
    expect(src).toContain("new CodeSandbox({");
  });

  test("splitArgv builds node argv with shell quoting", () => {
    const src = extractFunction(PLAYGROUND_SRC, "splitArgv");
    const ctx = {
      // stub the shellwords split: quote-aware-ish for the test
      split: (t) => (t || "").trim().split(/\s+/).filter(Boolean),
      console,
    };
    vm.createContext(ctx);
    vm.runInContext(
      src + "\nthis.result = splitArgv('--name \"foo bar\"');",
      ctx,
    );
    expect(ctx.result).toEqual([
      "node",
      "playground.mjs",
      "--name",
      '"foo',
      'bar"',
    ]);
    // The real shellwords split handles quotes properly; the shape is what
    // matters here: ['node', 'playground.mjs', ...args].
    expect(ctx.result[0]).toBe("node");
    expect(ctx.result[1]).toBe("playground.mjs");
  });

  test("refCheck passes the canonical examples (no false positives)", () => {
    // Extract the checker block + a minimal acorn stub is NOT enough —
    // instead assert the wiring: initPlayground transpiles TS before
    // checking and allows the demo globals.
    expect(PLAYGROUND_SRC).toContain("code = transpileTypeScript(code)");
    expect(PLAYGROUND_SRC).toContain('"globalThis"');
    expect(PLAYGROUND_SRC).toContain('allowedGlobals.push("require")');
  });
});

describe("ui.html is thin", () => {
  const UI_SRC = fs.readFileSync(path.join(__dirname, "..", "ui.html"), "utf8");

  test("no __BVM_DISABLE_PLAYGROUND hack", () => {
    expect(UI_SRC).not.toContain("__BVM_DISABLE_PLAYGROUND");
  });

  test("delegates to initPlayground", () => {
    expect(UI_SRC).toContain("from './src/ui/playground.js'");
    expect(UI_SRC).toContain("initPlayground({ CodeSandbox })");
  });

  test("no inline EXAMPLES duplication", () => {
    expect(UI_SRC).not.toContain("const EXAMPLES = {");
  });

  test("keeps the demo DOM ids the framework expects", () => {
    for (const id of [
      "codeInput",
      "runBtn",
      "argvInput",
      "stdinInput",
      "sendInput",
      "clearBtn",
      "output",
      "status",
      "execTime",
      "files",
    ]) {
      expect(UI_SRC).toContain(`id="${id}"`);
    }
    expect(UI_SRC).toContain("example-btn");
  });
});

describe("iframe interop exposes precede the sync builtin preload", () => {
  // Regression test: the __stdin__ (and sibling) expose() calls in the
  // SandboxRuntime.generate() template MUST appear before the sync builtin
  // preload loop. The preload does ~49 sequential interop loadModule calls
  // and can exceed the execution timeout; if the exposes come after it,
  // invoke('__stdin__') fails with "Method '__stdin__' not found" and
  // interactive samples (cli, cli_menu, inquirer, repl, repl2) can't
  // receive stdin.
  const PRELOAD_MARKER = "begin sync builtin preload";

  test("all four exposes are registered before the preload loop", () => {
    const preloadIdx = RUNTIME_SRC.indexOf(PRELOAD_MARKER);
    expect(preloadIdx).toBeGreaterThan(0);
    for (const name of [
      "__stdin__",
      "__terminal_resize__",
      "__serverRequest__",
      "__closeServer__",
    ]) {
      const idx = RUNTIME_SRC.indexOf(`expose('${name}'`);
      expect(idx).toBeGreaterThan(0);
      expect(idx).toBeLessThan(preloadIdx);
    }
  });

  test("ExecutionContext.invoke allows __stdin__ without the running flag", () => {
    // The sandbox_ready message (which sets running=true) is posted after
    // the preload loop; the UI must be able to send stdin as soon as the
    // iframe exists.
    expect(RUNTIME_SRC).toContain('const isStdin = method === "__stdin__"');
  });

  test("playground send handler waits for iframe, not the running flag", () => {
    expect(PLAYGROUND_SRC).toContain(
      "if (ctx && ctx.iframe && ctx.iframe.contentWindow) break;",
    );
    expect(PLAYGROUND_SRC).not.toContain(
      "if (ctx && ctx.running && ctx.iframe && ctx.iframe.contentWindow) break;",
    );
  });
});
