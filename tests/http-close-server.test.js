// Tests for __httpServerRunTime.closeServer(port) — the host-side hook the
// parent runtime uses to revoke a virtual server's port when its host-route
// claim is lost (e.g. a second sandbox grabbed the same port first).
import { describe, test, expect, beforeAll } from "@jest/globals";

let createServer, getServer, closeServer;

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

beforeAll(async () => {
  // src/http.js reads globalThis._RUNTIME_ once at import time; a plain
  // object is enough to get __httpServerRunTime populated.
  globalThis._RUNTIME_ = {};
  const mod = await import("../src/http.js");
  ({ createServer } = mod);
  ({ getServer } = mod.default);
  closeServer = globalThis._RUNTIME_.__httpServerRunTime.closeServer;
});

describe("__httpServerRunTime.closeServer", () => {
  test("is exposed as a function", () => {
    expect(typeof closeServer).toBe("function");
  });

  test("closes a listening server: true, EADDRINUSE error, then close", async () => {
    const server = createServer((req, res) => res.end("x"));
    server.listen(0);
    await once(server, "listening");
    const port = server.address().port;
    expect(getServer(port)).toBe(server);

    const errors = [];
    server.on("error", (err) => errors.push(err));
    const closed = once(server, "close");

    expect(closeServer(port)).toBe(true);
    await closed; // 'error' was queued before 'close', so it fired already.

    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("EADDRINUSE");
    expect(errors[0].port).toBe(port);
    expect(getServer(port)).toBeUndefined();
    expect(server.listening).toBe(false);
  });

  test("returns false for a port with no server", () => {
    expect(closeServer(59998)).toBe(false);
  });

  test("second call is a no-op returning false", async () => {
    const server = createServer((req, res) => res.end("x"));
    server.listen(0);
    await once(server, "listening");
    const port = server.address().port;
    server.on("error", () => {}); // swallow the EADDRINUSE
    expect(closeServer(port)).toBe(true);
    await once(server, "close");
    expect(closeServer(port)).toBe(false);
  });

  test("conflict scenario: loser server torn down and port freed", async () => {
    const loser = createServer((req, res) => res.end("loser"));
    loser.listen(0);
    await once(loser, "listening");
    const port = loser.address().port;

    const errors = [];
    loser.on("error", (err) => errors.push(err));
    const closed = once(loser, "close");

    // Host revokes the loser's port (another sandbox claimed it first).
    expect(closeServer(port)).toBe(true);
    await closed;

    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("EADDRINUSE");
    expect(getServer(port)).toBeUndefined();
  });
});
