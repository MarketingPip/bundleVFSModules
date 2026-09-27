import {
  jest,
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";

/**
 * Repo tests for src/child_process.js — the Node v24.20.0 port.
 *
 * Every assertion below was verified against the real `node:child_process`
 * before being written (see /tmp/cp-diff.mjs, /tmp/cp-probe*.mjs):
 * validation throws the exact same constructor, `code`, and message.
 *
 * Behaviors that need a real subprocess (actually running commands) cannot
 * be tested here — the browser can never spawn. What IS tested:
 *  - argument validation (exact ERR_* codes/messages)
 *  - option normalization (shell handling, defaults)
 *  - ChildProcess shapes, kill() semantics, events
 *  - fork()/execSync/spawnSync/execFileSync noops
 *  - the host postMessage protocol, with a fake window/parent and ZERO
 *    native delegation (the browser-fallback lane in miniature)
 */

let cp;
let realCp;

beforeEach(async () => {
  jest.resetModules();
  cp = await import("../src/child_process.js");
  realCp = await import("node:child_process");
});

afterEach(() => {
  delete globalThis.window;
  delete globalThis.parent;
});

const tick = () => new Promise((r) => setTimeout(r, 10));

function throwsCode(fn) {
  try {
    const r = fn();
    if (r && typeof r.unref === "function") r.unref();
    if (r && typeof r.on === "function") r.on("error", () => {});
  } catch (e) {
    return e;
  }
  return null;
}

// ─── Fake host parent (protocol tests) ───────────────────────────────────────

function withFakeParent() {
  const sent = [];
  const listeners = {};
  globalThis.window = {
    addEventListener: (type, handler) => {
      (listeners[type] ??= []).push(handler);
    },
    removeEventListener: (type, handler) => {
      listeners[type] = (listeners[type] || []).filter((h) => h !== handler);
    },
  };
  globalThis.parent = {
    postMessage: (message) => {
      sent.push(message);
    },
  };
  return {
    sent,
    respond: (payload, requestId = sent[0]?.requestId) => {
      for (const h of listeners.message || []) {
        h({ data: { type: "PARENT_CHILD_EXEC_RESPONSE", requestId, payload } });
      }
    },
  };
}

// ─── Validation ─────────────────────────────────────────────────────────────

describe("argument validation (exact Node v24.20.0 errors)", () => {
  test("exec: command must be a string", () => {
    const e = throwsCode(() => cp.exec(null, () => {}));
    expect(e.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(e.message).toBe(
      'The "command" argument must be of type string. Received null',
    );
    const e2 = throwsCode(() => cp.exec(123, () => {}));
    expect(e2.message).toBe(
      'The "command" argument must be of type string. Received type number (123)',
    );
  });

  test("exec: command must not contain null bytes", () => {
    const e = throwsCode(() => cp.exec("a\0b", () => {}));
    expect(e.code).toBe("ERR_INVALID_ARG_VALUE");
    expect(e.message).toBe(
      "The argument 'command' must be a string without null bytes. Received 'a\\x00b'",
    );
  });

  test("exec: bad callback", () => {
    const e = throwsCode(() => cp.exec("x", null, "notfn"));
    expect(e.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(e.message).toBe(
      "The \"callback\" argument must be of type function. Received type string ('notfn')",
    );
  });

  test("exec: timeout out of range", () => {
    const e = throwsCode(() => cp.exec("x", { timeout: -1 }, () => {}));
    expect(e.code).toBe("ERR_OUT_OF_RANGE");
    expect(e.message).toBe(
      'The value of "timeout" is out of range. It must be an unsigned integer. Received -1',
    );
  });

  test("exec: maxBuffer out of range", () => {
    const e = throwsCode(() => cp.exec("x", { maxBuffer: "a" }, () => {}));
    expect(e.code).toBe("ERR_OUT_OF_RANGE");
    expect(e.message).toBe(
      "The value of \"options.maxBuffer\" is out of range. It must be a positive number. Received 'a'",
    );
  });

  test("exec: bad killSignal", () => {
    const e = throwsCode(() => cp.exec("x", { killSignal: {} }, () => {}));
    expect(e.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(e.message).toBe(
      'The "options.killSignal" property must be one of type string or number. Received an instance of Object',
    );
    const e2 = throwsCode(() =>
      cp.exec("x", { killSignal: "BOGUS" }, () => {}),
    );
    expect(e2.code).toBe("ERR_UNKNOWN_SIGNAL");
    expect(e2.message).toBe("Unknown signal: BOGUS");
  });

  test("exec: bad signal", () => {
    const e = throwsCode(() => cp.exec("x", { signal: null }, () => {}));
    expect(e.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(e.message).toBe(
      'The "options.signal" property must be an instance of AbortSignal. Received null',
    );
  });

  test("exec: string options do not throw (Node quirk)", () => {
    expect(throwsCode(() => cp.exec("x", "notfn"))).toBeNull();
  });

  test("execFile: file must be a non-empty string", () => {
    const e = throwsCode(() => cp.execFile(123));
    expect(e.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(e.message).toBe(
      'The "file" argument must be of type string. Received type number (123)',
    );
    const e2 = throwsCode(() => cp.execFile(""));
    expect(e2.code).toBe("ERR_INVALID_ARG_VALUE");
    expect(e2.message).toBe("The argument 'file' cannot be empty. Received ''");
  });

  test("execFile: args must be an array or options object", () => {
    const e = throwsCode(() => cp.execFile("f", "str"));
    expect(e.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(e.message).toBe(
      "The \"args\" argument must be of type object. Received type string ('str')",
    );
  });

  test("execFile: null bytes in args", () => {
    const e = throwsCode(() => cp.execFile("f", ["a\0b"]));
    expect(e.code).toBe("ERR_INVALID_ARG_VALUE");
    expect(e.message).toBe(
      "The argument 'args[0]' must be a string without null bytes. Received 'a\\x00b'",
    );
  });

  test("execFile inherits spawn-level option validation", () => {
    const e = throwsCode(() => cp.execFile("f", [], { uid: "a" }));
    expect(e.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(e.message).toBe(
      "The \"options.uid\" property must be int32. Received type string ('a')",
    );
    const e2 = throwsCode(() => cp.execFile("f", [], { shell: 1 }));
    expect(e2.message).toBe(
      'The "options.shell" property must be one of type boolean or string. Received type number (1)',
    );
  });

  test("spawn: file must be a non-empty string", () => {
    const e = throwsCode(() => cp.spawn(123));
    expect(e.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(e.message).toBe(
      'The "file" argument must be of type string. Received type number (123)',
    );
    const e2 = throwsCode(() => cp.spawn(""));
    expect(e2.code).toBe("ERR_INVALID_ARG_VALUE");
  });

  test("spawn: args type errors", () => {
    const e = throwsCode(() => cp.spawn("x", "str"));
    expect(e.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(e.message).toBe(
      "The \"args\" argument must be of type object. Received type string ('str')",
    );
    const e2 = throwsCode(() => cp.spawn("x", ["a\0"]));
    expect(e2.code).toBe("ERR_INVALID_ARG_VALUE");
  });

  test("spawn: options type errors", () => {
    expect(throwsCode(() => cp.spawn("x", null, 5)).code).toBe(
      "ERR_INVALID_ARG_TYPE",
    );
    const e = throwsCode(() => cp.spawn("x", [], []));
    expect(e.message).toBe(
      'The "options" argument must be of type object. Received an instance of Array',
    );
    const e2 = throwsCode(() => cp.spawn("x", [], { detached: "y" }));
    expect(e2.message).toBe(
      "The \"options.detached\" property must be of type boolean. Received type string ('y')",
    );
    const e3 = throwsCode(() => cp.spawn("x", [], { cwd: 1 }));
    expect(e3.message).toBe(
      'The "options.cwd" property must be of type string or an instance of Buffer or URL. Received type number (1)',
    );
    const e4 = throwsCode(() => cp.spawn("x", [], { stdio: "bogus" }));
    expect(e4.code).toBe("ERR_INVALID_ARG_VALUE");
    expect(e4.message).toBe(
      "The argument 'stdio' is invalid. Received 'bogus'",
    );
  });

  test("fork: modulePath validation", () => {
    const e = throwsCode(() => cp.fork(123));
    expect(e.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(e.message).toBe(
      'The "modulePath" argument must be of type string or an instance of Buffer or URL. Received type number (123)',
    );
    const e2 = throwsCode(() => cp.fork());
    expect(e2.message).toBe(
      'The "modulePath" argument must be of type string or an instance of Buffer or URL. Received undefined',
    );
    const e3 = throwsCode(() => cp.fork("m", "notarray"));
    expect(e3.code).toBe("ERR_INVALID_ARG_TYPE");
    expect(e3.message).toBe(
      "The \"args\" argument must be an instance of Array. Received type string ('notarray')",
    );
    const e4 = throwsCode(() => cp.fork("m", [], 5));
    expect(e4.message).toBe(
      'The "options" argument must be of type object. Received type number (5)',
    );
  });

  test("spawnSync/execSync/execFileSync validation", () => {
    expect(throwsCode(() => cp.spawnSync(123)).code).toBe(
      "ERR_INVALID_ARG_TYPE",
    );
    expect(throwsCode(() => cp.spawnSync("x", "s")).message).toBe(
      "The \"args\" argument must be of type object. Received type string ('s')",
    );
    expect(throwsCode(() => cp.spawnSync("x", [], { timeout: -1 })).code).toBe(
      "ERR_OUT_OF_RANGE",
    );
    expect(throwsCode(() => cp.execSync(123)).code).toBe(
      "ERR_INVALID_ARG_TYPE",
    );
    expect(throwsCode(() => cp.execSync("a\0b")).code).toBe(
      "ERR_INVALID_ARG_VALUE",
    );
    expect(throwsCode(() => cp.execFileSync(null)).code).toBe(
      "ERR_INVALID_ARG_TYPE",
    );
  });

  test("null bytes rejected with exact Node messages", () => {
    const cases = [
      [() => cp.spawn("a\0b"), "'file'"],
      [() => cp.spawn("x", ["a\0b"]), "'args[0]'"],
      [() => cp.spawn("x", { argv0: "a\0b" }), "'options.argv0'"],
      [() => cp.spawn("x", { shell: "a\0b" }), "'options.shell'"],
      [() => cp.spawn("x", { env: { A: "a\0b" } }), "options.env['A']"],
      [() => cp.exec("a\0b", () => {}), "'command'"],
      [() => cp.execFile("a\0b", () => {}), "'file'"],
      [() => cp.execFile("x", ["a\0b"], () => {}), "'args[0]'"],
      [() => cp.execFileSync("a\0b"), "'file'"],
    ];
    for (const [fn, frag] of cases) {
      const e = throwsCode(fn);
      expect(e.code).toBe("ERR_INVALID_ARG_VALUE");
      expect(e.message).toContain(frag);
      expect(e.message).toContain("must be a string without null bytes");
    }
    // getValidatedPath reason phrase (exact Node wording)
    const cwdErr = throwsCode(() => cp.spawn("x", { cwd: "a\0b" }));
    expect(cwdErr.message).toBe(
      "The property 'options.cwd' must be a string, Uint8Array, or URL without null bytes. Received 'a\\x00b'",
    );
    const bufErr = throwsCode(() =>
      cp.spawn("x", { cwd: Buffer.from([97, 0, 98]) }),
    );
    expect(bufErr.code).toBe("ERR_INVALID_ARG_VALUE");
    expect(bufErr.message).toContain("<Buffer 61 00 62>");
    // non-string env values are fine
    expect(() => cp.spawnSync("x", { env: { A: 123 } })).not.toThrow();
  });
});

// ─── ChildProcess shape ─────────────────────────────────────────────────────

describe("ChildProcess shape", () => {
  test("spawn child matches Node observable shape", () => {
    const c = cp.spawn("echo", ["hi"]);
    c.on("error", () => {});
    expect(c).toBeInstanceOf(cp.ChildProcess);
    expect(typeof c.pid).toBe("number");
    expect(c.connected).toBe(false);
    expect(c.killed).toBe(false);
    expect(c.exitCode).toBeNull();
    expect(c.signalCode).toBeNull();
    expect(c.spawnfile).toBe("echo");
    expect(c.spawnargs).toEqual(["echo", "hi"]);
    expect(Array.isArray(c.stdio)).toBe(true);
    expect(c.stdio).toHaveLength(3);
    expect(c.stdio[0]).toBe(c.stdin);
    expect(c.stdio[1]).toBe(c.stdout);
    expect(c.stdio[2]).toBe(c.stderr);
    // Node: send/disconnect exist ONLY on fork/IPC children.
    expect(c.send).toBeUndefined();
    expect(c.disconnect).toBeUndefined();
    expect(typeof c.kill).toBe("function");
    // Node's ref()/unref() return undefined.
    expect(c.ref()).toBeUndefined();
    expect(c.unref()).toBeUndefined();
  });

  test("spawn with shell:true rewrites to /bin/sh -c", () => {
    const c = cp.spawn("echo", ["hi"], { shell: true });
    c.on("error", () => {});
    expect(c.spawnfile).toBe("/bin/sh");
    expect(c.spawnargs).toEqual(["/bin/sh", "-c", "echo hi"]);
  });

  test("spawn with shell string uses it", () => {
    const c = cp.spawn("echo", ["hi"], { shell: "/bin/bash" });
    c.on("error", () => {});
    expect(c.spawnfile).toBe("/bin/bash");
    expect(c.spawnargs).toEqual(["/bin/bash", "-c", "echo hi"]);
  });

  test("exec child uses /bin/sh -c", () => {
    const c = cp.exec("echo hi", () => {});
    c.on("error", () => {});
    expect(c.spawnfile).toBe("/bin/sh");
    expect(c.spawnargs).toEqual(["/bin/sh", "-c", "echo hi"]);
  });

  test('spawn emits "spawn" asynchronously', async () => {
    const c = cp.spawn("echo");
    c.on("error", () => {});
    let spawned = false;
    c.on("spawn", () => {
      spawned = true;
    });
    expect(spawned).toBe(false);
    await tick();
    expect(spawned).toBe(true);
  });
});

// ─── kill() semantics ───────────────────────────────────────────────────────

describe("kill() semantics", () => {
  test("kill validates the signal, even on a dead child", async () => {
    withFakeParent();
    const c = cp.spawn("x");
    c.on("error", () => {});
    c.kill();
    await tick();
    await tick();
    expect(throwsCode(() => c.kill("BOGUS")).code).toBe("ERR_UNKNOWN_SIGNAL");
    expect(throwsCode(() => c.kill(999)).message).toBe("Unknown signal: 999");
    expect(throwsCode(() => c.kill(null)).code).toBe("ERR_UNKNOWN_SIGNAL");
    // Unknown signal on a dead child still throws; a valid one returns false.
    expect(c.kill("SIGTERM")).toBe(false);
  });

  test("kill() returns true while alive, emits exit/close async", async () => {
    withFakeParent();
    const c = cp.spawn("sleep", ["5"]);
    c.on("error", () => {});
    const events = [];
    c.on("exit", (code, sig) => events.push(["exit", code, sig]));
    c.on("close", (code, sig) => events.push(["close", code, sig]));

    expect(c.kill()).toBe(true);
    expect(c.killed).toBe(true);
    // Node: exitCode is still null until the async exit lands.
    expect(c.exitCode).toBeNull();
    expect(events).toEqual([]);
    // Node: a second kill() before the exit event still returns true.
    expect(c.kill()).toBe(true);

    await tick();
    await tick();
    expect(events).toEqual([
      ["exit", null, "SIGTERM"],
      ["close", null, "SIGTERM"],
    ]);
    expect(c.exitCode).toBeNull();
    expect(c.signalCode).toBe("SIGTERM");
    expect(c.kill()).toBe(false);
  });

  test("kill(0) tests existence without terminating", async () => {
    withFakeParent();
    const c = cp.spawn("x");
    c.on("error", () => {});
    expect(c.kill(0)).toBe(true);
    expect(c.killed).toBe(true);
    await tick();
    await tick();
    // Not finalized — exit/close never fired.
    expect(c.exitCode).toBeNull();
    expect(c.signalCode).toBeNull();
    expect(c.kill("SIGTERM")).toBe(true);
  });

  test('kill("sigterm") is case-insensitive like Node', async () => {
    withFakeParent();
    const c = cp.spawn("x");
    c.on("error", () => {});
    expect(c.kill("sigterm")).toBe(true);
    await tick();
    await tick();
    expect(c.signalCode).toBe("SIGTERM");
  });
});

// ─── fork() noop ────────────────────────────────────────────────────────────

describe("fork() (browser noop)", () => {
  test("fork child has the IPC surface and starts connected", () => {
    const c = cp.fork("worker.js");
    c.on("error", () => {});
    expect(c).toBeInstanceOf(cp.ChildProcess);
    expect(c.connected).toBe(true);
    expect(typeof c.send).toBe("function");
    expect(typeof c.disconnect).toBe("function");
    // Node's fork(): spawnfile is the execPath, spawnargs is
    // [execPath, ...execArgv, modulePath, ...args].
    expect(c.spawnfile).toBe(process.execPath);
    expect(c.spawnargs[0]).toBe(process.execPath);
    expect(c.spawnargs[c.spawnargs.length - 1]).toBe("worker.js");
    c.kill("SIGKILL");
  });

  test("fork validates null bytes like Node", () => {
    expect(() => cp.fork("a\0b")).toThrow(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_VALUE",
        message: expect.stringContaining("'modulePath'"),
      }),
    );
    // 'args[i]' position shifts with execArgv: spawn() sees
    // [...execArgv, modulePath, ...args] — the bad user arg is at
    // execArgv.length + 2.
    const badArgIndex = process.execArgv.length + 2;
    expect(() => cp.fork("ok.js", ["a", "b\0c"])).toThrow(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_VALUE",
        message: expect.stringContaining(`'args[${badArgIndex}]'`),
      }),
    );
    expect(() => cp.fork("ok.js", { execPath: "x\0y" })).toThrow(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_VALUE",
        message: expect.stringContaining("'options.execPath'"),
      }),
    );
    expect(() => cp.fork("ok.js", { execArgv: ["ok", "x\0y"] })).toThrow(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_VALUE",
        message: expect.stringContaining("'options.execArgv[1]'"),
      }),
    );
    expect(() => cp.fork("ok.js", { execPath: 123 })).toThrow(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_TYPE",
        message: expect.stringContaining('"file"'),
      }),
    );
  });

  test("fork send() delivers when connected; ERR_IPC_CHANNEL_CLOSED when disconnected", async () => {
    const c = cp.fork("worker.js");
    c.on("error", () => {}); // Swallow MODULE_NOT_FOUND from missing worker.js fixture
    // In-realm fork has real IPC (like Node): send() succeeds when connected
    const cbErr = await new Promise((resolve) => c.send("hello", resolve));
    expect(cbErr).toBeNull();
    expect(c.send("hello")).toBe(true);

    // After disconnect, send() reports ERR_IPC_CHANNEL_CLOSED (matches Node)
    c.disconnect();
    const cbErr2 = await new Promise((resolve) => c.send("hello", resolve));
    expect(cbErr2.code).toBe("ERR_IPC_CHANNEL_CLOSED");

    const emitted = await new Promise((resolve) => {
      const handler = (e) => {
        if (e.code === "ERR_IPC_CHANNEL_CLOSED") {
          c.off("error", handler);
          resolve(e);
        }
      };
      c.on("error", handler);
      c.send("hello");
    });
    expect(emitted.code).toBe("ERR_IPC_CHANNEL_CLOSED");
    expect(c.send("hello")).toBe(false);
    c.kill("SIGKILL");
  });

  test("fork disconnect() emits disconnect; twice errors", async () => {
    const c = cp.fork("worker.js");
    c.on("error", () => {}); // Swallow MODULE_NOT_FOUND from missing worker.js fixture
    const disc = new Promise((resolve) => c.once("disconnect", resolve));
    c.disconnect();
    await disc;
    expect(c.connected).toBe(false);

    // Second disconnect() emits 'error' with ERR_IPC_DISCONNECTED (matches Node.js
    // lib/internal/child_process.js: emits, does not throw). Filter by code to
    // avoid catching MODULE_NOT_FOUND from the missing worker.js fixture.
    const err = await new Promise((resolve) => {
      const handler = (e) => {
        if (e.code === "ERR_IPC_DISCONNECTED") {
          c.off("error", handler);
          resolve(e);
        }
      };
      c.on("error", handler);
      c.disconnect();
    });
    expect(err.code).toBe("ERR_IPC_DISCONNECTED");
    c.kill("SIGKILL");
  });
});

// ─── Sync noops ─────────────────────────────────────────────────────────────

describe("sync noops (validated, honest shapes)", () => {
  test("spawnSync returns Node key order and shapes", () => {
    const r = cp.spawnSync("echo", ["hi"]);
    expect(Object.keys(r)).toEqual([
      "status",
      "signal",
      "output",
      "pid",
      "stdout",
      "stderr",
    ]);
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.output[0]).toBeNull();
    expect(r.output[1]).toBe(r.stdout);
    expect(r.output[2]).toBe(r.stderr);
    expect(typeof r.pid).toBe("number");
    // Node's spawnSync defaults to Buffer output.
    expect(Buffer.isBuffer(r.stdout)).toBe(true);
    expect(Buffer.isBuffer(r.stderr)).toBe(true);
  });

  test("spawnSync honors encoding", () => {
    const r = cp.spawnSync("echo", [], { encoding: "utf8" });
    expect(typeof r.stdout).toBe("string");
  });

  test("execSync/execFileSync return empty stdout (Buffer by default)", () => {
    expect(Buffer.isBuffer(cp.execSync("echo hi"))).toBe(true);
    expect(cp.execSync("echo hi").length).toBe(0);
    expect(Buffer.isBuffer(cp.execFileSync("echo", ["hi"]))).toBe(true);
    expect(cp.execSync("echo hi", { encoding: "utf8" })).toBe("");
  });
});

// ─── Host postMessage protocol (fake window/parent, zero native) ────────────

describe("host postMessage protocol", () => {
  test("exec posts PARENT_EXEC_REQUEST and resolves the callback", async () => {
    const { sent, respond } = withFakeParent();
    const done = new Promise((resolve) => {
      const child = cp.exec("echo hi", (err, stdout, stderr) => {
        resolve({ err, stdout, stderr, child });
      });
      child.on("error", () => {});
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("PARENT_EXEC_REQUEST");
    expect(sent[0].payload.command).toBe("echo hi");
    expect(typeof sent[0].requestId).toBe("string");
    expect(sent[0].requestId).toMatch(/^cp_/);

    respond({ stdout: "hi\n", stderr: "", exitCode: 0, signal: null });
    const { err, stdout, stderr, child } = await done;
    expect(err).toBeNull();
    expect(stdout).toBe("hi\n");
    expect(stderr).toBe("");
    expect(child.exitCode).toBe(0);
  });

  test("exec failure: callback gets the error, child does NOT emit error", async () => {
    const { respond } = withFakeParent();
    let childError = null;
    const done = new Promise((resolve) => {
      const child = cp.exec("exit 42", (err, stdout, stderr) =>
        resolve({ err, stdout, stderr }),
      );
      child.on("error", (e) => {
        childError = e;
      });
    });

    respond({ stdout: "out\n", stderr: "boom\n", exitCode: 42, signal: null });
    const { err, stdout, stderr } = await done;
    expect(err).not.toBeNull();
    expect(err.message).toBe("Command failed: exit 42\nboom\n");
    expect(err.code).toBe(42);
    expect(err.cmd).toBe("exit 42");
    expect(err.killed).toBe(false);
    expect(err.signal).toBeNull();
    expect(stdout).toBe("out\n");
    expect(stderr).toBe("boom\n");
    // Node parity: no 'error' on the child for a failed command.
    await tick();
    expect(childError).toBeNull();
  });

  test("execFile quotes args into the command string", async () => {
    const { sent } = withFakeParent();
    const child = cp.execFile("ls", ["-l", "it's"], () => {});
    child.on("error", () => {});
    expect(sent[0].type).toBe("PARENT_EXEC_REQUEST");
    expect(sent[0].payload.command).toBe(`'ls' '-l' 'it'\\''s'`);
  });

  test("spawn posts PARENT_SPAWN_REQUEST and finalizes on response", async () => {
    const { sent, respond } = withFakeParent();
    const child = cp.spawn("echo", ["hi"], { timeout: 1000 });
    const events = [];
    child.on("error", (e) => events.push(["error", e.code]));
    child.on("exit", (code, sig) => events.push(["exit", code, sig]));
    child.on("close", (code, sig) => events.push(["close", code, sig]));

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("PARENT_SPAWN_REQUEST");
    expect(sent[0].payload.command).toBe("echo");
    expect(sent[0].payload.args).toEqual(["hi"]);

    // A response for another requestId is ignored.
    respond({ stdout: "nope", exitCode: 0 }, "cp_other_1");
    expect(child.exitCode).toBeNull();

    respond({ stdout: "hi\n", stderr: "", exitCode: 0, signal: null });
    await tick();
    expect(child.exitCode).toBe(0);
    expect(events).toEqual([
      ["exit", 0, null],
      ["close", 0, null],
    ]);
  });

  test("kill() before the parent responds finalizes without error", async () => {
    withFakeParent();
    const child = cp.spawn("sleep", ["5"]);
    const errors = [];
    const events = [];
    child.on("error", (e) => errors.push(e));
    child.on("exit", (code, sig) => events.push(["exit", code, sig]));
    child.kill();
    await tick();
    await tick();
    // Node parity: kill() itself never emits 'error' on the child — the
    // aborted parent request is an internal transport detail.
    expect(errors).toHaveLength(0);
    expect(events).toEqual([["exit", null, "SIGTERM"]]);
    expect(child.killed).toBe(true);
    expect(child.signalCode).toBe("SIGTERM");
  });

  test("options.signal abort kills the child with AbortError", async () => {
    withFakeParent();
    const ac = new AbortController();
    const child = cp.spawn("sleep", ["5"], { signal: ac.signal });
    const errors = [];
    child.on("error", (e) => errors.push(e));
    ac.abort(new Error("stop it"));
    await tick();
    await tick();
    expect(child.killed).toBe(true);
    expect(child.signalCode).toBe("SIGTERM");
    const abortErr = errors.find((e) => e.code === "ABORT_ERR");
    expect(abortErr).toBeDefined();
    expect(abortErr.name).toBe("AbortError");
    expect(abortErr.cause.message).toBe("stop it");
  });

  test("exec timeout rejects with ETIMEDOUT", async () => {
    withFakeParent();
    const errors = [];
    const done = new Promise((resolve) => {
      const child = cp.exec("sleep 5", { timeout: 30 }, (err) => resolve(err));
      child.on("error", (e) => errors.push(e));
    });
    const err = await done;
    expect(err.code).toBe("ETIMEDOUT");
    expect(errors[0].code).toBe("ETIMEDOUT");
  });

  test("exec maxBuffer reports ERR_CHILD_PROCESS_STDIO_MAXBUFFER", async () => {
    const { respond } = withFakeParent();
    const done = new Promise((resolve) => {
      const child = cp.exec("yes", { maxBuffer: 4 }, (err, stdout) =>
        resolve({ err, stdout, child }),
      );
      child.on("error", () => {});
    });
    respond({ stdout: "123456789", stderr: "", exitCode: 0, signal: null });
    const { err, stdout, child } = await done;
    expect(err.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(err.message).toBe("stdout maxBuffer length exceeded");
    expect(stdout).toBe("1234");
    expect(child.killed).toBe(true);
    expect(child.signalCode).toBe("SIGTERM");
  });

  test('exec encoding "buffer" yields Buffers', async () => {
    const { respond } = withFakeParent();
    const done = new Promise((resolve) => {
      cp.exec("echo hi", { encoding: "buffer" }, (err, stdout) =>
        resolve({ err, stdout }),
      );
    });
    respond({ stdout: "hi\n", stderr: "", exitCode: 0, signal: null });
    const { err, stdout } = await done;
    expect(err).toBeNull();
    expect(Buffer.isBuffer(stdout)).toBe(true);
    expect(stdout.toString()).toBe("hi\n");
  });
});

// ─── promisify ──────────────────────────────────────────────────────────────

describe("promisify.custom", () => {
  test("exec and execFile expose promisify.custom with .child", async () => {
    const { respond } = withFakeParent();
    const key = Symbol.for("nodejs.util.promisify.custom");
    expect(typeof cp.exec[key]).toBe("function");
    expect(typeof cp.execFile[key]).toBe("function");

    const p = cp.exec[key]("echo hi");
    expect(p.child).toBeInstanceOf(cp.ChildProcess);
    p.child.on("error", () => {});
    respond({ stdout: "hi\n", stderr: "", exitCode: 0, signal: null });
    await expect(p).resolves.toEqual({ stdout: "hi\n", stderr: "" });
  });

  test("promisified exec rejects with stdout/stderr attached", async () => {
    const { respond } = withFakeParent();
    const key = Symbol.for("nodejs.util.promisify.custom");
    const p = cp.exec[key]("exit 3");
    p.child.on("error", () => {});
    const assertion = expect(p).rejects.toMatchObject({
      code: 3,
      stdout: "out\n",
      stderr: "bad\n",
    });
    respond({ stdout: "out\n", stderr: "bad\n", exitCode: 3, signal: null });
    await assertion;
  });
});

// ─── Standalone degradation (no window) ─────────────────────────────────────

describe("standalone degradation (no window)", () => {
  test("spawn without a window emits ERR_NO_WINDOW and finalizes", async () => {
    const child = cp.spawn("echo");
    const err = await new Promise((resolve) => child.once("error", resolve));
    expect(err.code).toBe("ERR_NO_WINDOW");
    await tick();
    expect(child.exitCode).toBe(1);
  });

  test("spawn without a parent frame emits ERR_NO_PARENT", async () => {
    globalThis.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    // No globalThis.parent with postMessage.
    const child = cp.spawn("echo");
    const err = await new Promise((resolve) => child.once("error", resolve));
    expect(err.code).toBe("ERR_NO_PARENT");
  });
});

// ─── VFS sync (snapshot before, three-way diff-merge after) ─────────────────

describe("VFS sync", () => {
  // Fake the runtime singleton FS: __FS__._vol with toJSON() for path
  // enumeration (values are lossy strings in real memfs — the shim must
  // never read bytes from them) and the public readFileSync/writeFileSync/
  // mkdirSync/unlinkSync API for faithful byte access.
  function withFakeVfs(initial) {
    const store = {};
    for (const [k, v] of Object.entries(initial)) {
      store[k] = Buffer.isBuffer(v) ? v : Buffer.from(String(v));
    }
    const written = [];
    const unlinked = [];
    const vol = {
      toJSON() {
        const out = {};
        for (const k of Object.keys(store)) out[k] = "";
        return out;
      },
    };
    const enoent = (p, op) =>
      Object.assign(
        new Error(`ENOENT: no such file or directory, ${op} '${p}'`),
        {
          code: "ENOENT",
        },
      );
    globalThis._RUNTIME_ = {
      __FS__: {
        _vol: vol,
        readFileSync(p) {
          if (!Object.prototype.hasOwnProperty.call(store, p))
            throw enoent(p, "open");
          return store[p];
        },
        writeFileSync(p, data) {
          written.push(p);
          store[p] = Buffer.isBuffer(data)
            ? data
            : Uint8Array.prototype.isPrototypeOf(data)
              ? Buffer.from(data)
              : Buffer.from(String(data));
        },
        mkdirSync() {},
        unlinkSync(p) {
          if (!Object.prototype.hasOwnProperty.call(store, p))
            throw enoent(p, "unlink");
          unlinked.push(p);
          delete store[p];
        },
      },
    };
    return { store, written, unlinked };
  }

  afterEach(() => {
    delete globalThis._RUNTIME_;
  });

  function sendRaw(listeners, data) {
    for (const h of listeners.message || []) h({ data });
  }

  test("exec includes a vfs snapshot in the request payload", async () => {
    const { sent } = withFakeParent();
    withFakeVfs({ "/a.txt": "hello", "/d/b.txt": "world" });
    const child = cp.exec("true", () => {});
    child.on("error", () => {});
    expect(sent[0].type).toBe("PARENT_EXEC_REQUEST");
    expect(sent[0].payload.vfs["/a.txt"]).toEqual(Buffer.from("hello"));
    expect(sent[0].payload.vfs["/d/b.txt"]).toEqual(Buffer.from("world"));
  });

  test("exec merges only child-changed files; parent writes win conflicts", async () => {
    const { sent, respond } = withFakeParent();
    const { store, written } = withFakeVfs({
      "/a.txt": "base-a",
      "/b.txt": "base-b",
      "/img.bin": Buffer.from([1, 2, 3]),
    });
    const done = new Promise((resolve) => {
      const child = cp.exec("true", (err) => resolve(err));
      child.on("error", () => {});
    });
    const requestId = sent[0].requestId;

    // Parent writes /b.txt while the child runs (after the snapshot).
    store["/b.txt"] = Buffer.from("parent-write");

    // Child changed /a.txt, also "changed" /b.txt, left /img.bin identical.
    respond(
      {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        vfs: {
          "/a.txt": Buffer.from("child-write-a"),
          "/b.txt": Buffer.from("child-write-b"),
          "/img.bin": Buffer.from([1, 2, 3]),
        },
      },
      requestId,
    );
    await done;
    await tick();
    // Child's change to an untouched file applies.
    expect(store["/a.txt"].toString()).toBe("child-write-a");
    // Parent's concurrent write wins the conflict.
    expect(store["/b.txt"].toString()).toBe("parent-write");
    // Byte-identical binary file is not rewritten.
    expect(written).not.toContain("/img.bin");
  });

  test("exec propagates child deletions when the parent did not touch the file", async () => {
    const { sent, respond } = withFakeParent();
    const { store, unlinked } = withFakeVfs({
      "/del.txt": "bye",
      "/keep.txt": "hi",
    });
    const done = new Promise((resolve) => {
      const child = cp.exec("true", (err) => resolve(err));
      child.on("error", () => {});
    });
    respond(
      {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        vfs: { "/keep.txt": Buffer.from("hi") },
      },
      sent[0].requestId,
    );
    await done;
    await tick();
    expect(unlinked).toContain("/del.txt");
    expect(store["/keep.txt"].toString()).toBe("hi");
  });

  test("exec keeps the parent file when the child deleted a parent-modified file", async () => {
    const { sent, respond } = withFakeParent();
    const { store, unlinked } = withFakeVfs({ "/f.txt": "base" });
    const done = new Promise((resolve) => {
      const child = cp.exec("true", (err) => resolve(err));
      child.on("error", () => {});
    });
    // Parent modifies the file while the child runs; the child deletes it.
    store["/f.txt"] = Buffer.from("parent-new");
    respond(
      { stdout: "", stderr: "", exitCode: 0, signal: null, vfs: {} },
      sent[0].requestId,
    );
    await done;
    await tick();
    expect(unlinked).not.toContain("/f.txt");
    expect(store["/f.txt"].toString()).toBe("parent-new");
  });

  test("exec without a host vfs in the response skips the merge silently", async () => {
    const { respond } = withFakeParent();
    const { store, written } = withFakeVfs({ "/a.txt": "base" });
    const done = new Promise((resolve) => {
      const child = cp.exec("true", (err, stdout) => resolve({ err, stdout }));
      child.on("error", () => {});
    });
    // Legacy host: no vfs key at all.
    respond({ stdout: "ok", stderr: "", exitCode: 0, signal: null });
    const { err } = await done;
    expect(err).toBeNull();
    expect(written).toHaveLength(0);
    expect(store["/a.txt"].toString()).toBe("base");
  });

  test("exec without a runtime FS sends no vfs key", async () => {
    const { sent } = withFakeParent();
    // No globalThis._RUNTIME_ here.
    const child = cp.exec("true", () => {});
    child.on("error", () => {});
    expect("vfs" in sent[0].payload).toBe(false);
  });

  test("spawn merges vfs on PARENT_SPAWN_CLOSE", async () => {
    const listeners = {};
    globalThis.window = {
      addEventListener: (t, h) => {
        (listeners[t] ??= []).push(h);
      },
      removeEventListener: (t, h) => {
        listeners[t] = (listeners[t] || []).filter((x) => x !== h);
      },
    };
    const sent = [];
    globalThis.parent = { postMessage: (m) => sent.push(m) };
    const { store } = withFakeVfs({ "/a.txt": "base" });
    const child = cp.spawn("true", []);
    child.on("error", () => {});
    const closed = new Promise((resolve) => child.on("close", resolve));
    const requestId = sent[0].requestId;
    sendRaw(listeners, {
      type: "PARENT_SPAWN_CLOSE",
      requestId,
      payload: {
        exitCode: 0,
        signal: null,
        vfs: {
          "/a.txt": Buffer.from("child-new"),
          "/new.txt": Buffer.from("created"),
        },
      },
    });
    await closed;
    expect(store["/a.txt"].toString()).toBe("child-new");
    expect(store["/new.txt"].toString()).toBe("created");
  });
});

// ─── Spawn live streaming ────────────────────────────────────────────────────

describe("spawn live streaming", () => {
  let listeners;
  let sent;

  beforeEach(() => {
    listeners = {};
    sent = [];
    globalThis.window = {
      addEventListener: (t, h) => {
        (listeners[t] ??= []).push(h);
      },
      removeEventListener: (t, h) => {
        listeners[t] = (listeners[t] || []).filter((x) => x !== h);
      },
    };
    globalThis.parent = { postMessage: (m) => sent.push(m) };
  });

  function sendRaw(data) {
    for (const h of listeners.message || []) h({ data });
  }

  test("PARENT_SPAWN_DATA chunks arrive live on stdout/stderr before close", async () => {
    const child = cp.spawn("yes", []);
    child.on("error", () => {});
    const out = [];
    const errOut = [];
    child.stdout.on("data", (c) => out.push(String(c)));
    child.stderr.on("data", (c) => errOut.push(String(c)));
    const requestId = sent[0].requestId;

    sendRaw({
      type: "PARENT_SPAWN_DATA",
      requestId,
      payload: { stream: "stdout", chunk: "hel" },
    });
    sendRaw({
      type: "PARENT_SPAWN_DATA",
      requestId,
      payload: { stream: "stderr", chunk: "oops" },
    });
    sendRaw({
      type: "PARENT_SPAWN_DATA",
      requestId,
      payload: { stream: "stdout", chunk: "lo" },
    });
    await tick();
    // Live: data is visible before the process closes.
    expect(out.join("")).toBe("hello");
    expect(errOut.join("")).toBe("oops");
    expect(child.exitCode).toBeNull();

    const closed = new Promise((resolve) =>
      child.on("close", (code) => resolve(code)),
    );
    sendRaw({
      type: "PARENT_SPAWN_CLOSE",
      requestId,
      payload: { exitCode: 0, signal: null },
    });
    await expect(closed).resolves.toBe(0);
    expect(child.exitCode).toBe(0);
  });

  test("chunks for other requestIds are ignored", async () => {
    const child = cp.spawn("yes", []);
    child.on("error", () => {});
    const out = [];
    child.stdout.on("data", (c) => out.push(String(c)));
    sendRaw({
      type: "PARENT_SPAWN_DATA",
      requestId: "cp_other_9",
      payload: { stream: "stdout", chunk: "x" },
    });
    await tick();
    expect(out).toHaveLength(0);
    child.kill();
  });

  test("non-zero close after streaming emits error and finalizes", async () => {
    const child = cp.spawn("cmd", []);
    const errors = [];
    child.on("error", (e) => errors.push(e));
    const requestId = sent[0].requestId;
    sendRaw({
      type: "PARENT_SPAWN_DATA",
      requestId,
      payload: { stream: "stdout", chunk: "partial" },
    });
    sendRaw({
      type: "PARENT_SPAWN_CLOSE",
      requestId,
      payload: { exitCode: 3, signal: null },
    });
    await tick();
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(3);
    expect(child.exitCode).toBe(3);
  });
});

// ─── kill() notifies the parent ──────────────────────────────────────────────

describe("kill() parent notification", () => {
  test("kill() posts PARENT_CHILD_KILL so the host can stop the child", async () => {
    const { sent } = withFakeParent();
    const child = cp.spawn("sleep", ["5"]);
    child.on("error", () => {});
    const requestId = sent[0].requestId;
    child.kill("SIGTERM");
    expect(sent).toHaveLength(2);
    expect(sent[1].type).toBe("PARENT_CHILD_KILL");
    expect(sent[1].requestId).toBe(requestId);
    expect(sent[1].payload.signal).toBe("SIGTERM");
    await tick();
    await tick();
    expect(child.signalCode).toBe("SIGTERM");
  });

  test("kill() without a parent frame still finalizes (best effort)", async () => {
    globalThis.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    // No globalThis.parent.
    const child = cp.spawn("sleep", ["5"]);
    child.on("error", () => {});
    child.kill();
    await tick();
    await tick();
    expect(child.killed).toBe(true);
    expect(child.signalCode).toBe("SIGTERM");
  });
});

// ─── stdin forwarding ────────────────────────────────────────────────────────

describe("spawn stdin forwarding", () => {
  test("writes to child.stdin are forwarded to the parent", async () => {
    const { sent } = withFakeParent();
    const child = cp.spawn("cat", []);
    child.on("error", () => {});
    const requestId = sent[0].requestId;
    child.stdin.write("hello ");
    child.stdin.write("world");
    await tick();
    const stdinMsgs = sent.filter((m) => m.type === "PARENT_SPAWN_STDIN");
    expect(stdinMsgs).toHaveLength(2);
    expect(stdinMsgs[0].requestId).toBe(requestId);
    expect(String(stdinMsgs[0].payload.chunk)).toContain("hello");
    child.kill();
  });

  test("ending stdin sends PARENT_SPAWN_STDIN_END", async () => {
    const { sent } = withFakeParent();
    const child = cp.spawn("cat", []);
    child.on("error", () => {});
    const requestId = sent[0].requestId;
    child.stdin.end("last");
    await tick();
    await tick();
    const endMsgs = sent.filter((m) => m.type === "PARENT_SPAWN_STDIN_END");
    expect(endMsgs).toHaveLength(1);
    expect(endMsgs[0].requestId).toBe(requestId);
    child.kill();
  });

  test("stdin stays a dev-null sink without a parent frame", async () => {
    globalThis.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const child = cp.spawn("cat", []);
    child.on("error", () => {});
    // Must not throw even though the request itself will fail closed.
    expect(() => child.stdin.write("x")).not.toThrow();
    expect(() => child.stdin.end()).not.toThrow();
    child.kill();
  });
});

describe("VFS sync edge cases", () => {
  function withFakeVfs(initial) {
    const store = {};
    for (const [k, v] of Object.entries(initial)) {
      store[k] = Buffer.isBuffer(v) ? v : Buffer.from(String(v));
    }
    const written = [];
    const vol = {
      toJSON() {
        const out = {};
        for (const k of Object.keys(store)) out[k] = "";
        return out;
      },
    };
    globalThis._RUNTIME_ = {
      __FS__: {
        _vol: vol,
        readFileSync: (p) => store[p],
        writeFileSync: (p, data) => {
          written.push(p);
          store[p] = Buffer.isBuffer(data) ? data : Buffer.from(data);
        },
        mkdirSync: () => {},
        unlinkSync: (p) => {
          delete store[p];
        },
      },
    };
    return { store, written };
  }

  afterEach(() => {
    delete globalThis._RUNTIME_;
  });

  test("child-created files in new directories are materialized", async () => {
    const { sent, respond } = withFakeParent();
    const { store } = withFakeVfs({ "/a.txt": "base" });
    const done = new Promise((resolve) => {
      const child = cp.exec("true", (err) => resolve(err));
      child.on("error", () => {});
    });
    const snap = sent[0].payload.vfs;
    respond(
      {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        vfs: { ...snap, "/newdir/sub/f.txt": Buffer.from("deep") },
      },
      sent[0].requestId,
    );
    await done;
    await tick();
    expect(store["/newdir/sub/f.txt"].toString()).toBe("deep");
  });

  test("binary files with high bytes survive snapshot and merge", async () => {
    const { sent, respond } = withFakeParent();
    const bytes = Buffer.from([0, 127, 128, 255, 254, 1]);
    const { store, written } = withFakeVfs({ "/b.bin": bytes });
    const done = new Promise((resolve) => {
      const child = cp.exec("true", (err) => resolve(err));
      child.on("error", () => {});
    });
    const snap = sent[0].payload.vfs;
    // Snapshot must carry faithful bytes, not the lossy toJSON string.
    expect(Buffer.from(snap["/b.bin"])).toEqual(bytes);
    // Child leaves it identical: no rewrite.
    respond(
      { stdout: "", stderr: "", exitCode: 0, signal: null, vfs: { ...snap } },
      sent[0].requestId,
    );
    await done;
    await tick();
    expect(written).not.toContain("/b.bin");
    expect(store["/b.bin"]).toEqual(bytes);
  });
});

describe("spawn timeout and late messages", () => {
  test("spawn timeout notifies the parent and finalizes with ETIMEDOUT", async () => {
    const { sent } = withFakeParent();
    const child = cp.spawn("sleep", ["5"], { timeout: 30 });
    const errors = [];
    child.on("error", (e) => errors.push(e));
    const requestId = sent[0].requestId;
    await new Promise((r) => setTimeout(r, 80));
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("ETIMEDOUT");
    expect(child.killed).toBe(true);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe("SIGTERM");
    const kills = sent.filter((m) => m.type === "PARENT_CHILD_KILL");
    expect(kills).toHaveLength(1);
    expect(kills[0].requestId).toBe(requestId);
    expect(kills[0].payload.signal).toBe("SIGTERM");
  });

  test("late PARENT_SPAWN_CLOSE after kill is ignored and the listener is removed", async () => {
    const listeners = {};
    globalThis.window = {
      addEventListener: (t, h) => {
        (listeners[t] ??= []).push(h);
      },
      removeEventListener: (t, h) => {
        listeners[t] = (listeners[t] || []).filter((x) => x !== h);
      },
    };
    const sent = [];
    globalThis.parent = { postMessage: (m) => sent.push(m) };
    const child = cp.spawn("sleep", ["5"]);
    child.on("error", () => {});
    const exits = [];
    child.on("exit", (c, s) => exits.push([c, s]));
    const requestId = sent[0].requestId;
    const handler = listeners.message[0];
    child.kill("SIGKILL");
    await tick();
    await tick();
    expect(child.signalCode).toBe("SIGKILL");
    // Listener removed on finalization: no window listener leak.
    expect(listeners.message || []).toHaveLength(0);
    // Even a direct late CLOSE is ignored.
    handler({
      data: {
        type: "PARENT_SPAWN_CLOSE",
        requestId,
        payload: { exitCode: 0, signal: null },
      },
    });
    await tick();
    expect(exits).toEqual([[null, "SIGKILL"]]);
    expect(child.exitCode).toBeNull();
  });
});
