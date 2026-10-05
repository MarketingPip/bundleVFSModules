// tests/preview-routing.test.js — unit tests for preview routing (no SW needed).
import {
  previewRoutingPlugin,
  PREVIEW_ROUTE_PREFIX,
  handlePreviewMessage,
} from "../src/plugins/preview-routing.js";

// The SW's parseVirtualUrl is not exported; test the contract via the
// plugin's documented URL scheme. We test what we can without a SW:
// plugin shape, prefix constant, and message handling.

describe("preview-routing plugin", () => {
  test("plugin has the correct shape", () => {
    expect(previewRoutingPlugin.name).toBe("preview-routing");
    expect(previewRoutingPlugin.builtIn).toBe(true);
  });

  test("route prefix is /__virtual__/", () => {
    expect(PREVIEW_ROUTE_PREFIX).toBe("/__virtual__/");
  });

  test("handlePreviewMessage ignores non-preview messages", async () => {
    const result = await handlePreviewMessage(
      { data: { type: "something-else" } },
      {},
    );
    expect(result).toBe(false);
  });

  test("handlePreviewMessage routes to sandbox.handlePreviewRequest", async () => {
    const messages = [];
    const fakePort = { postMessage: (msg) => messages.push(msg) };
    const sandbox = {
      handlePreviewRequest: async (port, path, method, headers, body) => {
        expect(port).toBe(3000);
        expect(path).toBe("/api/users");
        expect(method).toBe("GET");
        return { status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' };
      },
    };
    const result = await handlePreviewMessage(
      {
        data: {
          type: "__BVM_PREVIEW_REQUEST__",
          port: 3000,
          path: "/api/users",
          method: "GET",
          headers: {},
          body: null,
        },
        ports: [fakePort],
      },
      sandbox,
    );
    expect(result).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe(200);
    expect(messages[0].body).toBe('{"ok":true}');
  });

  test("handlePreviewMessage returns 502-style error when sandbox throws", async () => {
    const messages = [];
    const fakePort = { postMessage: (msg) => messages.push(msg) };
    const sandbox = {
      handlePreviewRequest: async () => {
        throw new Error("no server on port 9999");
      },
    };
    await handlePreviewMessage(
      {
        data: { type: "__BVM_PREVIEW_REQUEST__", port: 9999, path: "/", method: "GET" },
        ports: [fakePort],
      },
      sandbox,
    );
    expect(messages[0].error).toMatch(/no server on port 9999/);
  });

  test("handlePreviewMessage claims message even without a port", async () => {
    const result = await handlePreviewMessage(
      { data: { type: "__BVM_PREVIEW_REQUEST__", port: 3000 }, ports: [] },
      {},
    );
    expect(result).toBe(true); // claimed; SW will timeout with a clear message
  });
});
