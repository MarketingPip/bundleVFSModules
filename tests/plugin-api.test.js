import { describe, test, expect, beforeEach } from "@jest/globals";
import {
  registerPlugin,
  unregisterPlugin,
  getPlugins,
  clearPlugins,
  applyTransformPlugins,
} from "../src/plugins.js";

beforeEach(() => {
  clearPlugins();
});

describe("Plugin API", () => {
  test("registerPlugin stores plugin by name", () => {
    const plugin = { name: "test-plugin" };
    registerPlugin(plugin);
    expect(getPlugins()).toContain(plugin);
  });

  test("registerPlugin throws on duplicate name", () => {
    registerPlugin({ name: "dup" });
    expect(() => registerPlugin({ name: "dup" })).toThrow("already registered");
  });

  test("registerPlugin throws without name", () => {
    expect(() => registerPlugin({})).toThrow(TypeError);
  });

  test("unregisterPlugin removes plugin", () => {
    registerPlugin({ name: "temp" });
    expect(unregisterPlugin("temp")).toBe(true);
    expect(getPlugins().length).toBe(0);
  });

  test("applyTransformPlugins runs transforms in order", async () => {
    const order = [];
    registerPlugin({
      name: "a",
      transform(code) {
        order.push("a");
        return code + "/*a*/";
      },
    });
    registerPlugin({
      name: "b",
      transform(code) {
        order.push("b");
        return code + "/*b*/";
      },
    });
    const result = await applyTransformPlugins("let x=1;", "test.js");
    expect(order).toEqual(["a", "b"]);
    expect(result).toBe("let x=1;/*a*//*b*/");
  });

  test("transform returning undefined passes through", async () => {
    registerPlugin({
      name: "passthrough",
      transform() {
        // no return = passthrough
      },
    });
    const result = await applyTransformPlugins("original", "test.js");
    expect(result).toBe("original");
  });

  test("transform receives code and id", async () => {
    let receivedCode, receivedId;
    registerPlugin({
      name: "capture",
      transform(code, id) {
        receivedCode = code;
        receivedId = id;
      },
    });
    await applyTransformPlugins("mycode", "/path/to/file.ts");
    expect(receivedCode).toBe("mycode");
    expect(receivedId).toBe("/path/to/file.ts");
  });

  test("plugins without transform are skipped", async () => {
    registerPlugin({ name: "no-transform" });
    const result = await applyTransformPlugins("code", "id");
    expect(result).toBe("code");
  });
});
