import { describe, test, expect, beforeEach } from "@jest/globals";
import {
  registerPlugin,
  clearPlugins,
  getPlugins,
  applyTransformPlugins,
  applyResolvePlugins,
  applyLoadPlugins,
  validatePlugin,
} from "../src/plugins.js";

beforeEach(() => {
  clearPlugins();
});

const txtPlugin = {
  name: "scope-txt",
  onResolve: [
    {
      filter: /\.txt$/,
      namespace: "scope-txt",
      resolve: (args) => ({ path: args.path, namespace: "scope-txt" }),
    },
  ],
  onLoad: [
    {
      filter: /\.txt$/,
      namespace: "scope-txt",
      load: (args) => ({ contents: args.source, loader: "text" }),
    },
  ],
};

const bannerPlugin = {
  name: "scope-banner",
  transform: (code) => "/*banner*/" + code,
};

describe("per-sandbox plugin scoping (pluginList parameter)", () => {
  test("applyTransformPlugins with explicit list ignores globals", async () => {
    registerPlugin({ name: "global-x", transform: (c) => c + "/*global*/" });
    const out = await applyTransformPlugins("let x=1;", "a.js", [bannerPlugin]);
    expect(out).toBe("/*banner*/let x=1;");
  });

  test("applyTransformPlugins without list uses globals (default preserved)", async () => {
    registerPlugin({ name: "global-x", transform: (c) => c + "/*global*/" });
    const out = await applyTransformPlugins("let x=1;", "a.js");
    expect(out).toBe("let x=1;/*global*/");
  });

  test("applyTransformPlugins with empty list applies nothing (full shadow)", async () => {
    registerPlugin({ name: "global-x", transform: (c) => c + "/*global*/" });
    const out = await applyTransformPlugins("let x=1;", "a.js", []);
    expect(out).toBe("let x=1;");
  });

  test("applyResolvePlugins with explicit list ignores globals", async () => {
    registerPlugin({
      name: "global-r",
      onResolve: [
        { filter: /\.txt$/, resolve: () => ({ path: "/global.txt" }) },
      ],
    });
    const r = await applyResolvePlugins("./note.txt", "/app.js", [txtPlugin]);
    expect(r.namespace).toBe("scope-txt");
    expect(r.plugin).toBe("scope-txt");
  });

  test("applyResolvePlugins without list uses globals", async () => {
    registerPlugin({
      name: "global-r",
      onResolve: [
        { filter: /\.txt$/, resolve: () => ({ path: "/global.txt" }) },
      ],
    });
    const r = await applyResolvePlugins("./note.txt", "/app.js");
    expect(r.path).toBe("/global.txt");
    expect(r.plugin).toBe("global-r");
  });

  test("applyLoadPlugins with explicit list ignores globals", async () => {
    registerPlugin({
      name: "global-l",
      onLoad: [
        {
          filter: /\.txt$/,
          load: () => ({ contents: "global!", loader: "text" }),
        },
      ],
    });
    const r = await applyLoadPlugins("/note.txt", "scope-txt", "src", [
      txtPlugin,
    ]);
    expect(r.loader).toBe("text");
    expect(r.plugin).toBe("scope-txt");
    expect(r.contents).toBe("src");
  });

  test("applyLoadPlugins with empty list falls back to default js load", async () => {
    registerPlugin({
      name: "global-l",
      onLoad: [{ load: () => ({ contents: "x", loader: "text" }) }],
    });
    const r = await applyLoadPlugins("/a.js", "file", "src", []);
    expect(r).toEqual({ contents: "src", loader: "js", plugin: null });
  });

  test("ordering preserved within the custom list (list order wins)", async () => {
    const first = { name: "p-first", transform: (c) => c + "/*1*/" };
    const second = { name: "p-second", transform: (c) => c + "/*2*/" };
    const out = await applyTransformPlugins("x", "a.js", [first, second]);
    expect(out).toBe("x/*1*//*2*/");
  });

  test("builtIn plugins sort last within a custom list", async () => {
    const builtin = {
      name: "p-builtin",
      builtIn: true,
      transform: (c) => c + "/*builtin*/",
    };
    const user = { name: "p-user", transform: (c) => c + "/*user*/" };
    // builtIn listed first in the array but must still run last
    const out = await applyTransformPlugins("x", "a.js", [builtin, user]);
    expect(out).toBe("x/*user*//*builtin*/");
  });

  test("getPlugins() still reports only the global set", () => {
    registerPlugin({ name: "global-only" });
    applyTransformPlugins("x", "a.js", [bannerPlugin]); // must not leak
    expect(getPlugins().map((p) => p.name)).toEqual(["global-only"]);
  });
});

describe("validatePlugin", () => {
  test("accepts a valid plugin object", () => {
    expect(validatePlugin({ name: "ok" })).toBe(true);
  });

  test("throws TypeError when name is missing", () => {
    expect(() => validatePlugin({})).toThrow(TypeError);
  });

  test("throws TypeError when name is not a string", () => {
    expect(() => validatePlugin({ name: 42 })).toThrow(TypeError);
  });

  test("throws TypeError for null/undefined", () => {
    expect(() => validatePlugin(null)).toThrow(TypeError);
    expect(() => validatePlugin(undefined)).toThrow(TypeError);
  });
});
