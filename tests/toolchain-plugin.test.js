import { describe, test, expect, beforeEach } from "@jest/globals";
import {
  registerToolchain,
  unregisterToolchain,
  getToolchain,
  getToolchains,
  clearToolchains,
  validateToolchain,
  compileWithToolchain,
  resolveSysrootFileMap,
  mountSysrootIntoSeed,
  isSysrootMounted,
  toolchainBridgePlugin,
  toolchainNamespace,
  ToolchainError,
  SYSROOT_MOUNT_PREFIX,
} from "../src/toolchain.js";
import {
  applyResolvePlugins,
  applyLoadPlugins,
  dispatchLoader,
  getPlugins,
  clearPlugins,
  registerPlugin,
} from "../src/plugins.js";
import { runWasi } from "../src/runtime/runwasi.js";
import {
  createStubToolchain,
  buildStubWasm,
  STUB_C_SOURCE,
} from "./toolchain-stub-plugin.js";

beforeEach(() => {
  clearToolchains();
  clearPlugins();
});

const good = () => ({
  name: "t",
  compile: async () => ({ bytes: new Uint8Array([0, 1]) }),
});

describe("registration validation", () => {
  test("accepts a minimal valid toolchain", () => {
    expect(validateToolchain(good())).toBe(true);
  });

  test.each([
    ["null", null],
    ["non-object", "nope"],
    ["array", []],
    ["missing name", { compile: async () => ({}) }],
    ["non-string name", { name: 42, compile: async () => ({}) }],
    ["empty name", { name: "", compile: async () => ({}) }],
    ["missing compile", { name: "t" }],
    ["non-function compile", { name: "t", compile: "x" }],
    ["bad sysroot type", { ...good(), sysroot: 42 }],
    ["relative sysroot path", { ...good(), sysroot: "usr/include" }],
    ["bad sysroot file value", { ...good(), sysroot: { "/a.h": 42 } }],
    ["bad extensions type", { ...good(), extensions: ".c" }],
    ["extension without dot", { ...good(), extensions: ["c"] }],
    ["bad target", { ...good(), target: 42 }],
    ["bad readFile", { ...good(), readFile: "x" }],
    ["bad exists", { ...good(), exists: 42 }],
  ])("rejects %s with TypeError", (_label, tc) => {
    expect(() => validateToolchain(tc)).toThrow(TypeError);
  });

  test("accepts optional fields", () => {
    expect(
      validateToolchain({
        ...good(),
        sysroot: "/opt/sysroot",
        extensions: [".c", ".h"],
        target: "wasm32-wasi",
        matchBareSpecifier: true,
        readFile: async () => null,
        exists: async () => false,
      }),
    ).toBe(true);
  });
});

describe("registry", () => {
  test("registerToolchain stores by name and returns an unregister handle", () => {
    const tc = createStubToolchain();
    const handle = registerToolchain(tc);
    expect(handle.name).toBe("stub-cc");
    expect(getToolchain("stub-cc")).toBe(tc);
    expect(getToolchains()).toContain(tc);
    expect(handle.unregister()).toBe(true);
    expect(getToolchain("stub-cc")).toBeUndefined();
  });

  test("rejects duplicate names", () => {
    registerToolchain(good());
    expect(() => registerToolchain(good())).toThrow("already registered");
  });

  test("unregisterToolchain returns false for unknown names", () => {
    expect(unregisterToolchain("nope")).toBe(false);
  });

  test("registering installs the resolution bridge plugin", () => {
    registerToolchain(createStubToolchain());
    expect(
      getPlugins().some((p) => p.name === "__toolchain_bridge:stub-cc"),
    ).toBe(true);
  });

  test("unregistering removes the bridge plugin", () => {
    registerToolchain(createStubToolchain());
    unregisterToolchain("stub-cc");
    expect(
      getPlugins().some((p) => p.name === "__toolchain_bridge:stub-cc"),
    ).toBe(false);
  });

  test("failed bridge install rolls back the toolchain registration", () => {
    // Poison the plugin registry with a colliding bridge name so the
    // toolchain's bridge install throws; the toolchain must not remain
    // half-registered.
    registerPlugin({ name: "__toolchain_bridge:t" });
    expect(() => registerToolchain(good())).toThrow();
    expect(getToolchain("t")).toBeUndefined();
  });
});

describe("compile contract (stub end-to-end)", () => {
  test("register -> compile -> wasm bytes -> instantiate -> add(40,2)=42", async () => {
    const tc = createStubToolchain();
    registerToolchain(tc);
    const { bytes, warnings, errors } = await compileWithToolchain(
      "stub-cc",
      { "main.c": STUB_C_SOURCE },
      {},
    );
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0x61); // wasm magic
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
    // entry defaults to the first file matching the toolchain extensions
    expect(tc.calls[0].opts.entry).toBe("main.c");
    expect(tc.calls[0].opts.target).toBe("wasm32-wasi");

    const mod = await WebAssembly.compile(bytes);
    const instance = await WebAssembly.instantiate(mod, {});
    expect(instance.exports.add(40, 2)).toBe(42);
  });

  test("compiled bytes run under runWasi (exit 0)", async () => {
    registerToolchain(createStubToolchain());
    const { bytes } = await compileWithToolchain("stub-cc", {
      "main.c": STUB_C_SOURCE,
    });
    const result = await runWasi(bytes, { args: ["a.out.wasm"] });
    expect(result.exitCode).toBe(0);
  });

  test("explicit entry + opts pass through to compile", async () => {
    const tc = createStubToolchain();
    registerToolchain(tc);
    await compileWithToolchain(
      "stub-cc",
      {
        "lib/util.c": STUB_C_SOURCE,
        "main.c": "/* entry */\n" + STUB_C_SOURCE,
      },
      { entry: "lib/util.c", cflags: ["-O2"], toolchainOpts: { foo: 1 } },
    );
    const call = tc.calls[0];
    expect(call.opts.entry).toBe("lib/util.c");
    expect(call.opts.cflags).toEqual(["-O2"]);
    expect(call.opts.toolchainOpts).toEqual({ foo: 1 });
  });

  test("compile errors throw ToolchainError with diagnostics attached", async () => {
    registerToolchain(createStubToolchain());
    const err = await compileWithToolchain("stub-cc", {
      "main.c": "int main() { return 0; }\n",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolchainError);
    expect(err.toolchain).toBe("stub-cc");
    expect(err.errors).toHaveLength(1);
    expect(err.errors[0].file).toBe("main.c");
    expect(err.errors[0].line).toBe(1);
    expect(err.message).toContain("[toolchain:stub-cc]");
  });

  test("toolchain-agnostic: a rustc-shaped record fits the same contract", async () => {
    const tc = createStubToolchain({
      name: "stub-rustc",
      extensions: [".rs"],
      target: "wasm32-wasip1",
      expectPattern: /fn\s+add\s*\(/,
      sysroot: { "/lib/rustlib/src/lib.rs": "// fake rustlib\n" },
    });
    registerToolchain(tc);
    const { bytes } = await compileWithToolchain("stub-rustc", {
      "main.rs": "fn add(a: i32, b: i32) -> i32 { a + b }\n",
    });
    expect(tc.calls[0].opts.target).toBe("wasm32-wasip1");
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(bytes),
      {},
    );
    expect(instance.exports.add(1, 2)).toBe(3);
  });

  test.each([
    ["null files", null],
    ["array files", []],
    ["empty files", {}],
    ["non-string value", { "main.c": 42 }],
  ])("rejects %s", async (_label, files) => {
    registerToolchain(createStubToolchain());
    await expect(compileWithToolchain("stub-cc", files)).rejects.toThrow(
      ToolchainError,
    );
  });

  test("unknown toolchain throws ToolchainError", async () => {
    await expect(
      compileWithToolchain("nope", { "main.c": STUB_C_SOURCE }),
    ).rejects.toThrow(/unknown toolchain/);
  });

  test("compile throwing a raw error is wrapped in ToolchainError", async () => {
    registerToolchain({
      name: "boom",
      compile: async () => {
        throw new Error("segfault (fake)");
      },
    });
    await expect(
      compileWithToolchain("boom", { "main.c": "x" }),
    ).rejects.toThrow(/\[toolchain:boom\] compile threw: segfault/);
  });

  test("non-bytes result throws ToolchainError", async () => {
    registerToolchain({
      name: "empty",
      compile: async () => ({}),
    });
    await expect(
      compileWithToolchain("empty", { "main.c": "x" }),
    ).rejects.toThrow(/'bytes' must be a Uint8Array/);
  });
});

describe("sysroot", () => {
  test("file-map sysroot normalizes to absolute paths", () => {
    const tc = createStubToolchain({
      sysroot: { "usr/include/a.h": "x", "/b.h": "y" },
    });
    expect(resolveSysrootFileMap(tc)).toEqual({
      "/usr/include/a.h": "x",
      "/b.h": "y",
    });
  });

  test("absent sysroot resolves to empty map", () => {
    expect(resolveSysrootFileMap(good())).toEqual({});
  });

  test("string sysroot throws a clear follow-up-seam error", () => {
    const tc = { ...good(), sysroot: "/opt/sysroot" };
    expect(() => resolveSysrootFileMap(tc)).toThrow(
      /requires the read-only lazy mount seam/,
    );
  });

  test("mountSysrootIntoSeed merges under /.sysroot/<name> and is idempotent", () => {
    const tc = createStubToolchain();
    const seed = {};
    const prefix = mountSysrootIntoSeed(tc, seed);
    expect(prefix).toBe(`${SYSROOT_MOUNT_PREFIX}/stub-cc`);
    expect(seed["/.sysroot/stub-cc/usr/include/stub.h"]).toBe(
      "int add(int a, int b);\n",
    );
    expect(isSysrootMounted("stub-cc", seed)).toBe(true);
    const before = Object.keys(seed).length;
    expect(mountSysrootIntoSeed(tc, seed)).toBe(prefix);
    expect(Object.keys(seed).length).toBe(before);
  });

  test("mounts are tracked per seed object", () => {
    const tc = createStubToolchain();
    const seedA = {};
    const seedB = {};
    mountSysrootIntoSeed(tc, seedA);
    expect(isSysrootMounted("stub-cc", seedA)).toBe(true);
    expect(isSysrootMounted("stub-cc", seedB)).toBe(false);
  });
});

describe("module-resolution bridge", () => {
  test("extension specifier is claimed with the toolchain namespace", async () => {
    registerToolchain(createStubToolchain());
    const hit = await applyResolvePlugins("./add.c", "/src/main.js");
    expect(hit).toMatchObject({
      path: "./add.c",
      namespace: toolchainNamespace("stub-cc"),
    });
  });

  test("foreign extensions pass through untouched", async () => {
    registerToolchain(createStubToolchain());
    expect(
      await applyResolvePlugins("./app.js", "/src/main.js"),
    ).toBeUndefined();
    expect(await applyResolvePlugins("lodash", "/src/main.js")).toBeUndefined();
  });

  test("bare specifier probes <specifier><ext> via exists()", async () => {
    const tc = createStubToolchain({
      exists: async (absPath) => absPath === "/src/native-addon.c",
    });
    registerToolchain(tc);
    const hit = await applyResolvePlugins("./native-addon", "/src/main.js");
    expect(hit).toMatchObject({
      path: "./native-addon.c",
      namespace: toolchainNamespace("stub-cc"),
    });
  });

  test("bare specifier with no exists() hit falls through", async () => {
    const tc = createStubToolchain({ exists: async () => false });
    registerToolchain(tc);
    expect(
      await applyResolvePlugins("./native-addon", "/src/main.js"),
    ).toBeUndefined();
  });

  test("bare specifier without an exists accessor passes through (honest MODULE_NOT_FOUND)", async () => {
    registerToolchain(createStubToolchain());
    expect(
      await applyResolvePlugins("./native-addon", "/src/main.js"),
    ).toBeUndefined();
  });

  test("onLoad compiles to wasm bytes via the toolchain", async () => {
    const tc = createStubToolchain();
    registerToolchain(tc);
    const loaded = await applyLoadPlugins(
      "./add.c",
      toolchainNamespace("stub-cc"),
      STUB_C_SOURCE,
    );
    expect(loaded.loader).toBe("wasm");
    expect(loaded.contents).toBeInstanceOf(Uint8Array);
    expect(tc.calls).toHaveLength(1);
    expect(tc.calls[0].opts.entry).toBe("add.c");

    // Through the existing wasm loader dispatch: instantiable ESM.
    const dispatched = dispatchLoader(loaded.contents, "wasm", "./add.c");
    expect(dispatched.kind).toBe("module");
    expect(dispatched.source).toContain("WebAssembly.instantiate");
    expect(dispatched.source).toContain("export default");
  });

  test("compiled load output instantiates and exports add()", async () => {
    registerToolchain(createStubToolchain());
    const loaded = await applyLoadPlugins(
      "./add.c",
      toolchainNamespace("stub-cc"),
      STUB_C_SOURCE,
    );
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(loaded.contents),
      {},
    );
    expect(instance.exports.add(20, 22)).toBe(42);
  });

  test("onLoad with no source and no readFile surfaces a PluginError", async () => {
    // Per the Part B error contract (docs/PLUGINS.md §7), hook errors are
    // wrapped in PluginError attributed to the bridge plugin; the
    // ToolchainError message survives inside.
    registerToolchain(createStubToolchain());
    const err = await applyLoadPlugins(
      "./add.c",
      toolchainNamespace("stub-cc"),
      null,
    ).catch((e) => e);
    expect(err.name).toBe("PluginError");
    expect(err.plugin).toBe("__toolchain_bridge:stub-cc");
    expect(err.message).toContain("[toolchain:stub-cc] cannot load sources");
  });

  test("bridge plugin is exposed for per-sandbox lists", () => {
    const tc = createStubToolchain();
    const bridge = toolchainBridgePlugin(tc);
    expect(bridge.name).toBe("__toolchain_bridge:stub-cc");
    expect(bridge.onResolve.length).toBe(2); // ext filter + bare probe
    expect(bridge.onLoad).toHaveLength(1);
  });

  test("after unregister, specifiers are no longer claimed", async () => {
    registerToolchain(createStubToolchain());
    unregisterToolchain("stub-cc");
    expect(
      await applyResolvePlugins("./add.c", "/src/main.js"),
    ).toBeUndefined();
  });
});

describe("stub wasm fixture", () => {
  test("buildStubWasm emits a valid module with add/_start/memory", async () => {
    const bytes = buildStubWasm();
    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0x61);
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(bytes),
      {},
    );
    expect(instance.exports.add(-1, 1)).toBe(0);
    expect(typeof instance.exports._start).toBe("function");
    expect(instance.exports.memory).toBeInstanceOf(WebAssembly.Memory);
  });
});
