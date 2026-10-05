// tests/worker-spawn.test.js — worker-backed spawn (opt-in plugin).
//
// TDD red-first: these tests define the contract before the implementation.
// The Worker is mocked in Node; the real browser proof is tests/worker-spawn-e2e.py.

import {
  workerSpawnPlugin,
  buildWorkerScript,
  workerBackedShell,
} from "../src/plugins/worker-spawn.js";

// ─── Mock Worker ────────────────────────────────────────────────────────────
// Simulates a browser Worker: receives a blob URL, executes the script
// in a fake scope, posts messages back.

class MockWorker {
  constructor(url) {
    this.url = url;
    this.terminated = false;
    this.onmessage = null;
    MockWorker.instances.push(this);
    // Extract the script from the blob URL (test-only: we store it)
    this.script = MockWorker.blobStore[url] || "";
  }

  postMessage(msg) {
    if (this.terminated) return;
    // Simulate the worker receiving the init message. Deferred to a
    // macrotask so kill()/abort() can win the race (like a real worker).
    if (msg.type === "init") {
      setTimeout(() => this._run(msg), 0);
    }
  }

  terminate() {
    this.terminated = true;
  }

  _emit(data) {
    if (this.onmessage && !this.terminated) {
      this.onmessage({ data });
    }
  }

  _run(initMsg) {
    if (this.terminated) return;
    // Very simplified worker simulation: parse the command from the script
    // and simulate execution. The real logic is in buildWorkerScript;
    // here we just verify the plumbing.
    const { command } = initMsg;
    if (command.startsWith("node -e ")) {
      // Extract and "run" — for the mock, we simulate console.log output
      this._emit({ type: "stdout", data: "hi\n" });
      this._emit({ type: "exit", code: 0 });
    } else if (command === "node --version") {
      this._emit({ type: "stdout", data: "v24.0.0\n" });
      this._emit({ type: "exit", code: 0 });
    } else if (command.startsWith("fail")) {
      this._emit({ type: "stderr", data: "boom\n" });
      this._emit({ type: "exit", code: 1 });
    } else {
      this._emit({ type: "stderr", data: `${command}: command not found\n` });
      this._emit({ type: "exit", code: 127 });
    }
  }

  static reset() {
    MockWorker.instances = [];
    MockWorker.blobStore = {};
  }
}
MockWorker.instances = [];
MockWorker.blobStore = {};

// Mock URL.createObjectURL / revokeObjectURL
const origCreateObjectURL = globalThis.URL?.createObjectURL;
const origRevokeObjectURL = globalThis.URL?.revokeObjectURL;

beforeEach(() => {
  MockWorker.reset();
  globalThis.Worker = MockWorker;
  let blobId = 0;
  globalThis.URL.createObjectURL = (blob) => {
    const url = `blob:mock-${++blobId}`;
    // Store the blob content for the mock worker to "execute"
    if (blob && typeof blob.text === "function") {
      // async — store synchronously for the mock via a sync read hack
      MockWorker.blobStore[url] = "[blob content]";
    } else {
      MockWorker.blobStore[url] = String(blob);
    }
    return url;
  };
  globalThis.URL.revokeObjectURL = () => {};
});

afterEach(() => {
  delete globalThis.Worker;
  if (origCreateObjectURL) {
    globalThis.URL.createObjectURL = origCreateObjectURL;
  }
  if (origRevokeObjectURL) {
    globalThis.URL.revokeObjectURL = origRevokeObjectURL;
  }
});

// ─── Plugin shape ───────────────────────────────────────────────────────────

test("workerSpawnPlugin has the opt-in plugin shape", () => {
  expect(workerSpawnPlugin.name).toBe("worker-spawn");
  expect(workerSpawnPlugin.builtIn).toBe(true);
});

test("workerBackedShell is a function matching the shell contract", () => {
  expect(typeof workerBackedShell).toBe("function");
});

// ─── buildWorkerScript (pure, testable) ─────────────────────────────────────

test("buildWorkerScript matches the inlined template in workerBackedShell", () => {
  // The shell is serialized via .toString() — it cannot reference the
  // module-scope builder. This test guards that the inlined copy stays
  // in sync with the canonical _workerScriptTemplate.
  const src = workerBackedShell.toString();
  // The inlined template must contain the key markers from the canonical.
  const canonical = buildWorkerScript("node -e 'x'", [], null);
  expect(canonical).toContain("worker-spawn entry");
  expect(src).toContain("worker-spawn entry");
  expect(src).toContain("VFS_SNAPSHOT");
  expect(src).toContain("command not found");
  // Spot-check: the inlined version handles node -e (regex present).
  expect(src).toContain("node\\\\s+-e");
});

test("buildWorkerScript returns a string containing the command", () => {
  const script = buildWorkerScript("node -e 'console.log(1)'", [], null);
  expect(typeof script).toBe("string");
  expect(script).toContain("node -e");
});

test("buildWorkerScript embeds the VFS snapshot when provided", () => {
  const vfs = { "/app.js": "console.log('vfs');" };
  const script = buildWorkerScript("node /app.js", [], vfs);
  expect(script).toContain("/app.js");
});

test("buildWorkerScript sets up console capture", () => {
  const script = buildWorkerScript("node -e '1'", [], null);
  expect(script).toContain("postMessage");
  expect(script).toContain("stdout");
});

// ─── workerBackedShell (mocked Worker) ──────────────────────────────────────

test("workerBackedShell resolves with stdout on success", async () => {
  const result = await workerBackedShell("node -e 'console.log(\"hi\")'", [], {});
  expect(result.stdout).toBe("hi\n");
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});

test("workerBackedShell reports non-zero exit codes", async () => {
  const result = await workerBackedShell("fail-command", [], {});
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("boom\n");
});

test("workerBackedShell reports 127 for unknown commands", async () => {
  const result = await workerBackedShell("nonexistent-cmd", [], {});
  expect(result.exitCode).toBe(127);
  expect(result.stderr).toContain("command not found");
});

test("workerBackedShell returns a Promise (async contract)", () => {
  const result = workerBackedShell("node -e '1'", [], {});
  expect(typeof result.then).toBe("function");
  return result; // ensure it resolves
});

test("workerBackedShell exposes kill() on the returned promise", async () => {
  const promise = workerBackedShell("node -e 'while(true){}'", [], {});
  expect(typeof promise.kill).toBe("function");
  // Kill before it resolves
  promise.kill("SIGTERM");
  const result = await promise;
  expect(result.signal).toBe("SIGTERM");
  expect(result.exitCode).toBeNull();
});

test("workerBackedShell terminates on AbortSignal", async () => {
  const controller = new AbortController();
  const promise = workerBackedShell("node -e 'while(true){}'", [], {
    signal: controller.signal,
  });
  controller.abort();
  const result = await promise;
  expect(result.signal).toBe("SIGTERM");
});

test("workerBackedShell passes args to the worker", async () => {
  const result = await workerBackedShell("node --version", ["--version"], {});
  expect(result.stdout).toContain("v24");
});
