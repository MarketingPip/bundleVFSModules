import { describe, test, expect, beforeEach } from "@jest/globals";
import {
  registerPlugin,
  clearPlugins,
  applyTransformPlugins,
  applyResolvePlugins,
  applyLoadPlugins,
  dispatchLoader,
  PluginError,
  toPluginError,
  VALID_LOADERS,
} from "../src/plugins.js";
import { jsonPlugin } from "../src/plugins/json.js";

beforeEach(() => {
  clearPlugins();
});

describe("onResolve", () => {
  test("first match wins in registration order", async () => {
    registerPlugin({
      name: "first",
      onResolve: [
        {
          filter: /\.foo$/,
          resolve: (args) => ({ path: args.path, namespace: "first-ns" }),
        },
      ],
    });
    registerPlugin({
      name: "second",
      onResolve: [
        {
          filter: /\.foo$/,
          resolve: (args) => ({ path: args.path, namespace: "second-ns" }),
        },
      ],
    });
    const r = await applyResolvePlugins("/x/a.foo", "/x/entry.js");
    expect(r.namespace).toBe("first-ns");
    expect(r.plugin).toBe("first");
  });

  test("no match returns undefined (default resolution proceeds)", async () => {
    registerPlugin({
      name: "only-foo",
      onResolve: [
        { filter: /\.foo$/, resolve: (args) => ({ path: args.path }) },
      ],
    });
    const r = await applyResolvePlugins("/x/a.bar", "/x/entry.js");
    expect(r).toBeUndefined();
  });

  test("resolve receives path and importer", async () => {
    let seen;
    registerPlugin({
      name: "capture",
      onResolve: [
        {
          filter: /\.cap$/,
          resolve: (args) => {
            seen = args;
            return { path: args.path };
          },
        },
      ],
    });
    await applyResolvePlugins("/x/a.cap", "/x/entry.js");
    expect(seen.path).toBe("/x/a.cap");
    expect(seen.importer).toBe("/x/entry.js");
  });

  test("entry without filter matches everything", async () => {
    registerPlugin({
      name: "catch-all",
      onResolve: [{ resolve: (args) => ({ path: "/rewritten" + args.path }) }],
    });
    const r = await applyResolvePlugins("/anything", "/e");
    expect(r.path).toBe("/rewritten/anything");
  });

  test("default namespace is 'file' when entry has none", async () => {
    registerPlugin({
      name: "no-ns",
      onResolve: [
        { filter: /\.nn$/, resolve: (args) => ({ path: args.path }) },
      ],
    });
    const r = await applyResolvePlugins("/x/a.nn", "/e");
    expect(r.namespace).toBe("file");
  });

  test("built-in plugins have lowest priority", async () => {
    // Built-in (registered first, like the json plugin) must lose to a
    // user plugin registered later for the same filter.
    registerPlugin({
      name: "builtin-test",
      builtIn: true,
      onResolve: [
        {
          filter: /\.prio$/,
          resolve: (args) => ({ path: args.path, namespace: "builtin" }),
        },
      ],
    });
    registerPlugin({
      name: "user",
      onResolve: [
        {
          filter: /\.prio$/,
          resolve: (args) => ({ path: args.path, namespace: "user" }),
        },
      ],
    });
    const r = await applyResolvePlugins("/x/a.prio", "/e");
    expect(r.namespace).toBe("user");
    expect(r.plugin).toBe("user");
  });

  test("resolve returning undefined falls through to next entry", async () => {
    registerPlugin({
      name: "fallthrough",
      onResolve: [
        { filter: /\.ft$/, resolve: () => undefined },
        {
          filter: /\.ft$/,
          resolve: (args) => ({ path: args.path, namespace: "second" }),
        },
      ],
    });
    const r = await applyResolvePlugins("/x/a.ft", "/e");
    expect(r.namespace).toBe("second");
  });

  test("throwing resolve is wrapped in PluginError", async () => {
    registerPlugin({
      name: "boom-resolve",
      onResolve: [
        {
          filter: /\.br$/,
          resolve: () => {
            throw new Error("kaboom");
          },
        },
      ],
    });
    await expect(applyResolvePlugins("/x/a.br", "/e")).rejects.toThrow(
      PluginError,
    );
    await expect(applyResolvePlugins("/x/a.br", "/e")).rejects.toThrow(
      /boom-resolve/,
    );
  });
});

describe("onLoad", () => {
  test("matches on filter AND namespace", async () => {
    registerPlugin({
      name: "ns-a",
      onLoad: [
        {
          filter: /\.ml$/,
          namespace: "ns-a",
          load: () => ({ contents: "A", loader: "text" }),
        },
      ],
    });
    registerPlugin({
      name: "ns-b",
      onLoad: [
        {
          filter: /\.ml$/,
          namespace: "ns-b",
          load: () => ({ contents: "B", loader: "text" }),
        },
      ],
    });
    const ra = await applyLoadPlugins("/x/a.ml", "ns-a", "fallback");
    const rb = await applyLoadPlugins("/x/a.ml", "ns-b", "fallback");
    expect(ra.contents).toBe("A");
    expect(rb.contents).toBe("B");
  });

  test("entry without namespace matches any namespace", async () => {
    registerPlugin({
      name: "any-ns",
      onLoad: [
        { filter: /\.an$/, load: () => ({ contents: "X", loader: "text" }) },
      ],
    });
    const r = await applyLoadPlugins("/x/a.an", "whatever", "fallback");
    expect(r.contents).toBe("X");
  });

  test("no match returns default text load with js loader", async () => {
    registerPlugin({
      name: "other",
      onLoad: [
        { filter: /\.other$/, load: () => ({ contents: "X", loader: "text" }) },
      ],
    });
    const r = await applyLoadPlugins("/x/a.js", "file", "fallback-source");
    expect(r.contents).toBe("fallback-source");
    expect(r.loader).toBe("js");
  });

  test("first match wins in registration order", async () => {
    registerPlugin({
      name: "l1",
      onLoad: [
        { filter: /\.dup$/, load: () => ({ contents: "one", loader: "text" }) },
      ],
    });
    registerPlugin({
      name: "l2",
      onLoad: [
        { filter: /\.dup$/, load: () => ({ contents: "two", loader: "text" }) },
      ],
    });
    const r = await applyLoadPlugins("/x/a.dup", "file", "fallback");
    expect(r.contents).toBe("one");
  });

  test("load receives path, namespace, and fallback source", async () => {
    let seen;
    registerPlugin({
      name: "cap-load",
      onLoad: [
        {
          filter: /\.cl$/,
          load: (args) => {
            seen = args;
            return { contents: "x", loader: "text" };
          },
        },
      ],
    });
    await applyLoadPlugins("/x/a.cl", "myns", "the-source");
    expect(seen.path).toBe("/x/a.cl");
    expect(seen.namespace).toBe("myns");
    expect(seen.source).toBe("the-source");
  });

  test("missing loader defaults to js", async () => {
    registerPlugin({
      name: "no-loader",
      onLoad: [{ filter: /\.nl$/, load: () => ({ contents: "const x = 1;" }) }],
    });
    const r = await applyLoadPlugins("/x/a.nl", "file", "fallback");
    expect(r.loader).toBe("js");
  });

  test("invalid loader throws PluginError", async () => {
    registerPlugin({
      name: "bad-loader",
      onLoad: [
        { filter: /\.bl$/, load: () => ({ contents: "x", loader: "nope" }) },
      ],
    });
    await expect(applyLoadPlugins("/x/a.bl", "file", "f")).rejects.toThrow(
      PluginError,
    );
  });

  test("throwing load is wrapped in PluginError", async () => {
    registerPlugin({
      name: "boom-load",
      onLoad: [
        {
          filter: /\.bl2$/,
          load: () => {
            throw new Error("load kaboom");
          },
        },
      ],
    });
    await expect(applyLoadPlugins("/x/a.bl2", "file", "f")).rejects.toThrow(
      /boom-load/,
    );
  });
});

describe("dispatchLoader", () => {
  test("VALID_LOADERS is the closed enum js/json/text/wasm", () => {
    expect([...VALID_LOADERS].sort()).toEqual(["js", "json", "text", "wasm"]);
  });

  test("js: returns kind js with string contents", () => {
    const d = dispatchLoader("const x = 1;", "js", "/a.js");
    expect(d.kind).toBe("js");
    expect(d.source).toBe("const x = 1;");
  });

  test("json: valid JSON becomes an ESM default export", () => {
    const d = dispatchLoader('{"a":1,"b":[2,3]}', "json", "/a.json");
    expect(d.kind).toBe("module");
    expect(d.source).toContain("export default");
    // The exported value must deep-equal JSON.parse of the input.
    const m = d.source.match(/export default (.*);/s);
    expect(JSON.parse(m[1])).toEqual({ a: 1, b: [2, 3] });
  });

  test("json: invalid JSON throws PluginError", () => {
    expect(() => dispatchLoader("{not json", "json", "/a.json")).toThrow(
      PluginError,
    );
  });

  test("text: contents exported as a string", () => {
    const d = dispatchLoader("hello\nworld", "text", "/a.txt");
    expect(d.kind).toBe("module");
    const m = d.source.match(/export default (.*);/s);
    expect(JSON.parse(m[1])).toBe("hello\nworld");
  });

  test("wasm: Uint8Array accepted, returns instantiating module", () => {
    // Minimal valid wasm module: magic + version, no sections.
    const bytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ]);
    const d = dispatchLoader(bytes, "wasm", "/a.wasm");
    expect(d.kind).toBe("module");
    expect(d.source).toContain("WebAssembly");
    expect(d.source).toContain("export default");
  });

  test("wasm: non-Uint8Array contents throws PluginError", () => {
    expect(() => dispatchLoader("not-bytes", "wasm", "/a.wasm")).toThrow(
      PluginError,
    );
  });

  test("unknown loader throws PluginError", () => {
    expect(() => dispatchLoader("x", "bogus", "/a.x")).toThrow(PluginError);
  });
});

describe("built-in json plugin", () => {
  beforeEach(() => {
    registerPlugin(jsonPlugin);
  });

  test("resolves .json with namespace 'json'", async () => {
    const r = await applyResolvePlugins("/data/config.json", "/entry.js");
    expect(r).toBeDefined();
    expect(r.namespace).toBe("json");
    expect(r.path).toBe("/data/config.json");
  });

  test("loads .json with the json loader", async () => {
    const r = await applyLoadPlugins("/data/config.json", "json", '{"k":"v"}');
    expect(r.loader).toBe("json");
    expect(r.contents).toBe('{"k":"v"}');
  });

  test("does not claim non-json files", async () => {
    const r = await applyResolvePlugins("/data/app.js", "/entry.js");
    expect(r).toBeUndefined();
  });

  test("user plugin can override .json (built-in is lowest priority)", async () => {
    registerPlugin({
      name: "user-json",
      onResolve: [
        {
          filter: /\.json$/,
          resolve: (args) => ({ path: args.path, namespace: "user-json" }),
        },
      ],
      onLoad: [
        {
          filter: /\.json$/,
          namespace: "user-json",
          load: (args) => ({ contents: args.source, loader: "text" }),
        },
      ],
    });
    const rr = await applyResolvePlugins("/d.json", "/e");
    expect(rr.namespace).toBe("user-json");
    const lr = await applyLoadPlugins("/d.json", "user-json", '{"a":1}');
    expect(lr.loader).toBe("text");
  });
});

describe("PluginError", () => {
  test("carries plugin, file, line, column, message", () => {
    const e = new PluginError("myplug", "bad thing", {
      file: "/a.ts",
      line: 3,
      column: 7,
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("PluginError");
    expect(e.plugin).toBe("myplug");
    expect(e.file).toBe("/a.ts");
    expect(e.line).toBe(3);
    expect(e.column).toBe(7);
    expect(e.message).toContain("myplug");
    expect(e.message).toContain("/a.ts");
    expect(e.message).toContain("3");
  });

  test("toPluginError passes through PluginError untouched", () => {
    const orig = new PluginError("p", "m", { file: "/f" });
    expect(toPluginError("other", orig, "/f")).toBe(orig);
  });

  test("toPluginError wraps plain errors with plugin name and file", () => {
    const e = toPluginError("pluggy", new Error("nope"), "/x/y.z");
    expect(e).toBeInstanceOf(PluginError);
    expect(e.plugin).toBe("pluggy");
    expect(e.file).toBe("/x/y.z");
    expect(e.message).toContain("nope");
  });
});

describe("v1 transform contract unchanged", () => {
  test("transform still chains in registration order", async () => {
    registerPlugin({ name: "t1", transform: (c) => c + "/*1*/" });
    registerPlugin({ name: "t2", transform: (c) => c + "/*2*/" });
    expect(await applyTransformPlugins("x", "a.js")).toBe("x/*1*//*2*/");
  });

  test("plugin with hooks but no transform is skipped by transform chain", async () => {
    registerPlugin({
      name: "hooks-only",
      onResolve: [{ filter: /\.h$/, resolve: (a) => ({ path: a.path }) }],
    });
    expect(await applyTransformPlugins("code", "a.h")).toBe("code");
  });
});
