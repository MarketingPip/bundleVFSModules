// Unit tests for src/runtime/execution-context.js (extracted from
// runtime.js lines 2810-3802 — the ExecutionContext class).
//
// The module intentionally carries NO imports: in runtime.js it lived in the
// same module scope as `acorn`, `walk` (acorn-walk), `builtinModules`,
// `normalizeBuiltinSpecifier` and the `_vfs*` fetch-bridge helpers. Until the
// final modularization wires those as real imports, the harness injects the
// ones the tested methods need onto globalThis (free identifiers in an ES
// module resolve through the global environment record).

import * as acorn from "acorn";
import * as walk from "acorn-walk";

globalThis.acorn = acorn;
globalThis.walk = walk;
globalThis._vfsExtractServerPort = () => null;
globalThis._vfsRegisterServerRoute = () => true;
const unregisteredRoutes = [];
globalThis._vfsUnregisterServerRoute = (port, owner) => {
  unregisteredRoutes.push([port, owner]);
};
// listen() wires the host-side message bus; stub just enough of window.
globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { ExecutionContext } =
  await import("../src/runtime/execution-context.js");

const makeSandbox = (overrides = {}) => ({
  config: { capturePromiseRejections: false, captureWindowErrors: false },
  destroyIframe: false,
  executionCount: 1,
  emit: () => {},
  ...overrides,
});

describe("ExecutionContext", () => {
  describe("instantiation", () => {
    test("constructor stores iframe/sandbox and initializes state", () => {
      const iframe = {};
      const sandbox = makeSandbox();
      const ctx = new ExecutionContext(iframe, sandbox);

      expect(ctx).toBeInstanceOf(ExecutionContext);
      expect(ctx.iframe).toBe(iframe);
      expect(ctx.sandbox).toBe(sandbox);
      expect(ctx.config).toBe(sandbox.config);
      expect(ctx.messageHandler).toBeNull();
      expect(ctx.cleanupCallbacks).toEqual([]);
      expect(ctx.resolved).toBe(false);
      expect(ctx.running).toBe(false);
      expect(ctx.interopCallbacks).toBeInstanceOf(Map);
      expect(ctx.stdout).toEqual([]);
      expect(ctx.stderr).toEqual([]);
      expect(ctx.startTime).toBeNull();
      expect(ctx._resolve).toBeNull();
      expect(ctx._reject).toBeNull();
      expect(ctx._serverRunning).toBe(false);
      expect(ctx._serverPort).toBeNull();
      expect(ctx._vfsPorts).toBeInstanceOf(Set);
      expect(ctx._vfsPorts.size).toBe(0);
    });
  });

  describe("method surface", () => {
    const proto = ExecutionContext.prototype;
    test.each([
      ["forceKill", 0], // (reason = "Process killed by user")
      ["inject", 2], // (code, hasImports)
      ["hoistingTransform", 2], // (code, objectName)
      ["listen", 2], // (resolve, reject)
      ["handleInteropCall", 1], // (data)
      ["_parseExposedMethods", 2], // (code, interopVar)
      ["cleanup", 0],
    ])("%s exists with arity %i", (name, arity) => {
      expect(typeof proto[name]).toBe("function");
      expect(proto[name].length).toBe(arity);
    });

    test("class-field helpers exist on instances", () => {
      const ctx = new ExecutionContext({}, makeSandbox());
      expect(typeof ctx.invoke).toBe("function"); // (method, ...args)
      expect(ctx.invoke.length).toBe(1);
      expect(typeof ctx.serverRunning).toBe("function");
      expect(typeof ctx.hasMethod).toBe("function");
    });
  });

  describe("hoistingTransform", () => {
    test("returns code unchanged (currently disabled)", () => {
      const ctx = new ExecutionContext({}, makeSandbox());
      const code = "interop.expose('a', () => 1);\nwindow['interop'] = {};";
      expect(ctx.hoistingTransform(code, "interop")).toBe(code);
      expect(ctx.hoistingTransform("", "interop")).toBe("");
    });
  });

  describe("_parseExposedMethods", () => {
    const code = `
      interop.expose('add', (a, b) => a + b);
      interop.expose("greet", function (name) { return "hi " + name; });
      other.expose('nope', () => {});
      interop.expose(dynamicName, () => {});
      interop.notExpose('also-nope', () => {});
    `;

    test("collects literal .expose() names for the interop var", () => {
      const ctx = new ExecutionContext({}, makeSandbox());
      expect(ctx._parseExposedMethods(code, "interop")).toEqual([
        "add",
        "greet",
      ]);
    });

    test("respects the interopVar argument", () => {
      const ctx = new ExecutionContext({}, makeSandbox());
      expect(ctx._parseExposedMethods(code, "other")).toEqual(["nope"]);
    });

    test("returns [] for code with no exposes", () => {
      const ctx = new ExecutionContext({}, makeSandbox());
      expect(ctx._parseExposedMethods("const x = 1;", "interop")).toEqual([]);
    });
  });

  describe("hasMethod / serverRunning", () => {
    test("hasMethod checks exposedMethods list", async () => {
      const ctx = new ExecutionContext({}, makeSandbox());
      ctx.exposedMethods = ["add", "greet"];
      await expect(ctx.hasMethod("add")).resolves.toBe(true);
      await expect(ctx.hasMethod("missing")).resolves.toBe(false);
    });

    test("serverRunning reflects _serverRunning flag", () => {
      const ctx = new ExecutionContext({}, makeSandbox());
      expect(ctx.serverRunning()).toBe(false);
      ctx._serverRunning = true;
      expect(ctx.serverRunning()).toBe(true);
    });
  });

  describe("forceKill", () => {
    test("resolves with killed result, navigates persistent iframe away", () => {
      const emitted = [];
      const sandbox = makeSandbox({
        executionCount: 7,
        emit: (type, payload) => emitted.push([type, payload]),
      });
      const iframe = {};
      const ctx = new ExecutionContext(iframe, sandbox);
      ctx._vfsPorts.add(8080);
      unregisteredRoutes.length = 0;

      let result;
      ctx.listen(
        (r) => {
          result = r;
        },
        () => {},
      );
      ctx.forceKill("boom");

      expect(ctx.resolved).toBe(true);
      expect(ctx.running).toBe(false);
      expect(result.success).toBe(false);
      expect(result.killed).toBe(true);
      expect(result.error).toBe("boom");
      expect(result.logs).toEqual(["Process Killed"]);
      expect(typeof result.executionTime).toBe("number");
      // persistent (non-destroyIframe) iframe is navigated away
      expect(iframe.src).toBe("about:blank");
      // VFS fetch-bridge routes released via cleanup()
      expect(unregisteredRoutes).toEqual([[8080, ctx]]);
      expect(ctx._vfsPorts.size).toBe(0);
      // host notified
      expect(emitted[0][0]).toBe("execution:kill");
      expect(emitted[0][1]).toMatchObject({ id: 7, reason: "boom" });
    });

    test("is a no-op once already resolved", () => {
      const ctx = new ExecutionContext({}, makeSandbox());
      ctx.resolved = true;
      let called = false;
      ctx._resolve = () => {
        called = true;
      };
      ctx.forceKill("again");
      expect(called).toBe(false);
    });
  });

  describe("cleanup", () => {
    test("runs callbacks, releases ports, swallows callback errors", () => {
      const emitted = [];
      const sandbox = makeSandbox({
        emit: (type, payload) => emitted.push([type, payload]),
      });
      const ctx = new ExecutionContext({ parentNode: null }, sandbox);
      const ran = [];
      ctx.cleanupCallbacks.push(() => ran.push("ok"));
      ctx.cleanupCallbacks.push(() => {
        throw new Error("callback boom");
      });
      ctx._serverRunning = true;
      ctx._serverPort = 3000;
      ctx._vfsPorts.add(3000);
      unregisteredRoutes.length = 0;

      expect(() => ctx.cleanup()).not.toThrow();

      expect(ran).toEqual(["ok"]);
      expect(ctx.cleanupCallbacks).toEqual([]);
      expect(ctx.running).toBe(false);
      expect(ctx._serverRunning).toBe(false);
      expect(ctx._serverPort).toBeNull();
      expect(unregisteredRoutes).toEqual([[3000, ctx]]);
      expect(emitted).toContainEqual([
        "execution:server",
        { type: "closed", port: 3000 },
      ]);
    });
  });
});
