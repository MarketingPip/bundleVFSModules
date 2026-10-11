// tests/worker-spawn.test.js — worker-backed spawn (opt-in plugin).
//
// Unit tests for the plugin shape, the pure script builder, and the
// sandbox-serialization constraint. The fake Worker below executes the
// REAL worker entry source inside a node:vm context (not a simulation of
// it), and the shell under test is re-materialized from
// workerBackedShell.toString() with NO access to module scope -- proving
// the assembled shell is genuinely self-contained for .toString()
// serialization into the sandbox. Real-OS-thread proof lives in
// tests/worker-spawn-real.test.js; browser proof in tests/worker-spawn-e2e.py.

import vm from "node:vm";
import {
  workerSpawnPlugin,
  buildWorkerScript,
  workerBackedShell,
  spawnWorkerProcess,
  createProcessManager,
  nodeWorkerFactory,
  WORKER_ENTRY_SOURCE,
} from "../src/plugins/worker-spawn.js";

// ─── vm-backed fake Worker ───────────────────────────────────────────────
// Executes the REAL entry script in a vm context. `self`/`postMessage` are
// wired to the browser Worker message shape; console/timers are sandbox
// locals so the entry's overrides can't leak into the test process.

class VmWorker {
  constructor(script) {
    this.script = script;
    this.terminated = false;
    this._hostOnMessage = null;
    this._workerOnMessage = null;
    const worker = this;
    const self = {};
    Object.defineProperty(self, "onmessage", {
      configurable: true,
      get: () => worker._workerOnMessage,
      set: (fn) => {
        worker._workerOnMessage = fn;
      },
    });
    const sandbox = {
      self,
      postMessage: (msg) => {
        const h = worker._hostOnMessage;
        if (h && !worker.terminated) h({ data: msg });
      },
      console: {
        log: () => {},
        info: () => {},
        error: () => {},
        warn: () => {},
      },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    };
    sandbox.globalThis = sandbox;
    this._ctx = vm.createContext(sandbox);
    vm.runInContext(script, this._ctx);
  }
  postMessage(msg) {
    if (this.terminated) return;
    // Deferred like a real worker: lets kill()/abort() win the race.
    setTimeout(() => {
      if (this.terminated) return;
      const fn = this._workerOnMessage;
      if (fn) fn({ data: msg });
    }, 0);
  }
  terminate() {
    this.terminated = true;
  }
  set onmessage(fn) {
    this._hostOnMessage = fn;
  }
  get onmessage() {
    return this._hostOnMessage;
  }
}

// Fake Blob/URL/Worker globals for the re-materialized shell. The shell is
// re-created from its .toString() with zero module scope -- if it referenced
// anything outside itself, this throws.
function installFakes() {
  const store = new Map();
  let nextId = 0;
  globalThis.Blob = class FakeBlob {
    constructor(parts) {
      this._text = parts.map(String).join("");
    }
  };
  globalThis.URL.createObjectURL = (blob) => {
    const url = `blob:fake-${++nextId}`;
    store.set(url, blob._text);
    return url;
  };
  globalThis.URL.revokeObjectURL = (url) => {
    store.delete(url);
  };
  globalThis.Worker = class FakeWorker extends VmWorker {
    constructor(url) {
      super(store.get(url) || "");
      this.url = url;
    }
  };
}

const origBlob = globalThis.Blob;
const origCreateObjectURL = globalThis.URL.createObjectURL;
const origRevokeObjectURL = globalThis.URL.revokeObjectURL;
const origWorker = globalThis.Worker;

beforeEach(() => {
  installFakes();
});
afterEach(() => {
  globalThis.Blob = origBlob;
  globalThis.URL.createObjectURL = origCreateObjectURL;
  globalThis.URL.revokeObjectURL = origRevokeObjectURL;
  if (origWorker === undefined) delete globalThis.Worker;
  else globalThis.Worker = origWorker;
});

// Re-materialize the shell from its serialized source with no module scope.
function freshShell() {
  const src = workerBackedShell.toString();
  return new Function(`return (${src});`)();
}

// ─── Plugin shape ───────────────────────────────────────────────────────

test("workerSpawnPlugin has the opt-in plugin shape", () => {
  expect(workerSpawnPlugin.name).toBe("worker-spawn");
  expect(workerSpawnPlugin.builtIn).toBe(true);
});

test("module exports the process-manager surface", () => {
  expect(typeof spawnWorkerProcess).toBe("function");
  expect(typeof createProcessManager).toBe("function");
  expect(typeof nodeWorkerFactory).toBe("function");
  expect(typeof buildWorkerScript).toBe("function");
  expect(typeof workerBackedShell).toBe("function");
  expect(typeof WORKER_ENTRY_SOURCE).toBe("string");
});

// ─── buildWorkerScript (pure) ───────────────────────────────────────────

test("buildWorkerScript bakes command, args, vfs and env as JSON", () => {
  const script = buildWorkerScript(
    "node -e 'a\"b\nc'",
    ["--flag"],
    { "/a.js": "console.log(1);" },
    { FOO: "bar" },
  );
  expect(typeof script).toBe("string");
  expect(script).toContain("worker-spawn entry");
  expect(script).not.toMatch(/__WORKER_(COMMAND|ARGS|VFS|ENV)__/);
  // The baked values round-trip through JSON.parse (proves safe embedding).
  for (const m of script.matchAll(
    /var (COMMAND|ARGS|VFS_SNAPSHOT|ENV) = (null|\{[\s\S]*?\}|"(?:[^"\\]|\\.)*"|\[[^\]]*\]);/g,
  )) {
    expect(() => JSON.parse(m[2])).not.toThrow();
  }
});

test("buildWorkerScript embeds the VFS snapshot", () => {
  const script = buildWorkerScript("node /app.js", [], {
    "/app.js": "console.log('vfs');",
  });
  expect(script).toContain("/app.js");
});

// ─── Self-containment: the assembled shell embeds the canonical entry ──

test("workerBackedShell embeds WORKER_ENTRY_SOURCE byte-for-byte (no drift)", () => {
  const src = workerBackedShell.toString();
  expect(src).toContain("worker-spawn entry");
  const m = src.match(/var WORKER_ENTRY_SOURCE = ("(?:[^"\\]|\\.)*");/);
  expect(m).not.toBeNull();
  expect(JSON.parse(m[1])).toBe(WORKER_ENTRY_SOURCE);
});

// ─── Re-materialized shell runs the REAL entry with no module scope ─────

test("re-materialized shell executes node -e in a real vm worker", async () => {
  const shell = freshShell();
  const result = await shell("node -e 'console.log(\"hi\")'", [], {});
  expect(result.stdout).toBe("hi\n");
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.signal).toBeNull();
});

test("re-materialized shell reports exit codes and stderr", async () => {
  const shell = freshShell();
  const r1 = await shell("node --version", [], {});
  expect(r1.stdout).toContain("v24.0.0-worker");
  expect(r1.exitCode).toBe(0);
  const r2 = await shell(
    "node",
    ["-e", 'console.error("boom"); process.exit(3);'],
    {},
  );
  expect(r2.stderr).toBe("boom\n");
  expect(r2.exitCode).toBe(3);
});

test("re-materialized shell reports 127 for unknown commands", async () => {
  const shell = freshShell();
  const result = await shell("nonexistent-cmd --flag", [], {});
  expect(result.exitCode).toBe(127);
  expect(result.stderr).toContain("command not found");
});

test("re-materialized shell runs files from the VFS snapshot", async () => {
  const shell = freshShell();
  const result = await shell("node", ["/app.js"], {
    vfs: { "/app.js": 'console.log("from-vfs");' },
  });
  expect(result.stdout).toBe("from-vfs\n");
  expect(result.exitCode).toBe(0);
});

test("re-materialized shell kill() wins the race before init", async () => {
  const shell = freshShell();
  const promise = shell("node -e 'while(true){}'", [], {});
  expect(typeof promise.kill).toBe("function");
  promise.kill("SIGKILL");
  const result = await promise;
  expect(result.signal).toBe("SIGKILL");
  expect(result.exitCode).toBeNull();
});

test("re-materialized shell terminates on AbortSignal", async () => {
  const shell = freshShell();
  const controller = new AbortController();
  const promise = shell("node -e 'while(true){}'", [], {
    signal: controller.signal,
  });
  controller.abort();
  const result = await promise;
  expect(result.signal).toBe("SIGTERM");
  expect(result.exitCode).toBeNull();
});
