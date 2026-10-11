// tests/worker-spawn-real.test.js — worker-backed spawn, REAL execution.
//
// Every test here runs the genuine worker entry source inside a REAL
// Node.js worker_threads Worker (via nodeWorkerFactory) -- no mocks, no
// vm simulation. This is the proof that spawnWorkerProcess delivers the
// honest process story: spawn, stdio streaming, signals, exit codes, the
// VFS snapshot boot, and the VFS bridge to a running worker.
//
// Browser-lane proof (real Web Workers): tests/worker-spawn-e2e.py.

import {
  spawnWorkerProcess,
  workerBackedShell,
  createProcessManager,
  nodeWorkerFactory,
} from "../src/plugins/worker-spawn.js";

const F = nodeWorkerFactory;

function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      let v;
      try {
        v = fn();
      } catch (e) {
        reject(e);
        return;
      }
      if (v) {
        resolve(v);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for: " + label));
        return;
      }
      setTimeout(poll, 25);
    })();
  });
}

// Every spawned handle is tracked so a failing test can't leak threads.
let liveHandles = [];
function track(h) {
  liveHandles.push(h);
  return h;
}
afterEach(async () => {
  const hs = liveHandles;
  liveHandles = [];
  for (const h of hs) {
    try {
      h.kill("SIGKILL");
    } catch (e) {
      /* ignore */
    }
  }
  await Promise.all(hs.map((h) => h.result().catch(() => null)));
});

// ─── spawn + stdio + exit codes ─────────────────────────────────────────

test("real: spawn runs node -e, streams stdout, exit 0", async () => {
  const p = track(
    spawnWorkerProcess("node", ["-e", 'console.log("hello")'], {
      createWorker: F,
    }),
  );
  const r = await p.result();
  expect(r.stdout).toBe("hello\n");
  expect(r.stderr).toBe("");
  expect(r.exitCode).toBe(0);
  expect(r.signal).toBeNull();
  expect(typeof r.pid).toBe("number");
});

test("real: exec-style command string also works", async () => {
  const p = track(
    spawnWorkerProcess("node -e 'console.log(1 + 1)'", [], {
      createWorker: F,
    }),
  );
  const r = await p.result();
  expect(r.stdout).toBe("2\n");
  expect(r.exitCode).toBe(0);
});

test("real: stderr streams as ordered chunks via on()", async () => {
  const p = track(
    spawnWorkerProcess(
      "node",
      [
        "-e",
        'console.error("e1"); setTimeout(() => console.error("e2"), 50); setTimeout(() => console.error("e3"), 100);',
      ],
      { createWorker: F },
    ),
  );
  const chunks = [];
  p.on("stderr", (c) => chunks.push(c));
  const r = await p.result();
  expect(chunks).toEqual(["e1\n", "e2\n", "e3\n"]);
  expect(r.stderr).toBe("e1\ne2\ne3\n");
  expect(r.exitCode).toBe(0);
});

test("real: process.exit(42) reports exit code 42", async () => {
  const p = track(
    spawnWorkerProcess("node", ["-e", "process.exit(42)"], {
      createWorker: F,
    }),
  );
  const r = await p.result();
  expect(r.exitCode).toBe(42);
  expect(r.signal).toBeNull();
});

test("real: process.exitCode without explicit exit is honored", async () => {
  const p = track(
    spawnWorkerProcess("node", ["-e", "process.exitCode = 7;"], {
      createWorker: F,
    }),
  );
  const r = await p.result();
  expect(r.exitCode).toBe(7);
});

test("real: uncaught throw -> exit 1 with the error on stderr", async () => {
  const p = track(
    spawnWorkerProcess("node", ["-e", 'throw new Error("boom")'], {
      createWorker: F,
    }),
  );
  const r = await p.result();
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain("boom");
});

test("real: unknown command -> honest 127, never a fake success", async () => {
  const p = track(
    spawnWorkerProcess('ruby -e "puts 1"', [], { createWorker: F }),
  );
  const r = await p.result();
  expect(r.exitCode).toBe(127);
  expect(r.stderr).toContain("command not found");
  expect(r.stdout).toBe("");
});

test("real: node --version reports the worker label", async () => {
  const p = track(
    spawnWorkerProcess("node", ["--version"], { createWorker: F }),
  );
  const r = await p.result();
  expect(r.stdout).toContain("v24.0.0-worker");
  expect(r.exitCode).toBe(0);
});

test("real: missing file -> exit 1 with node-style error", async () => {
  const p = track(
    spawnWorkerProcess("node", ["/nope.js"], {
      createWorker: F,
      vfs: { "/other.js": "x" },
    }),
  );
  const r = await p.result();
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain("can't open '/nope.js'");
});

// ─── VFS snapshot boot ──────────────────────────────────────────────────

test("real: worker boots from the VFS snapshot, require() resolves relatively", async () => {
  const p = track(
    spawnWorkerProcess("node", ["/app/main.js"], {
      createWorker: F,
      vfs: {
        "/app/main.js":
          'const u = require("./util.js");\nconsole.log("main:" + u());',
        "/app/util.js": "module.exports = function () { return 42; };",
      },
    }),
  );
  const r = await p.result();
  expect(r.stdout).toBe("main:42\n");
  expect(r.exitCode).toBe(0);
});

test("real: require resolves ../ and absolute paths, __dirname/__filename set", async () => {
  const p = track(
    spawnWorkerProcess("node", ["/a/b/c.js"], {
      createWorker: F,
      vfs: {
        "/a/b/c.js":
          'console.log(__dirname + "|" + __filename + "|" + require("../d.js"));',
        "/a/d.js": 'module.exports = "deep";',
      },
    }),
  );
  const r = await p.result();
  expect(r.stdout).toBe("/a/b|/a/b/c.js|deep\n");
  expect(r.exitCode).toBe(0);
});

test("real: env and argv reach the worker", async () => {
  const p = track(
    spawnWorkerProcess(
      "node",
      ["-e", 'console.log(process.env.FOO + "/" + process.argv[0])'],
      { createWorker: F, env: { FOO: "bar" } },
    ),
  );
  const r = await p.result();
  expect(r.stdout).toBe("bar/node\n");
  expect(r.exitCode).toBe(0);
});

// ─── signals: kill mid-run ──────────────────────────────────────────────

test("real: kill(SIGTERM) mid-run -> exitCode null, signal SIGTERM", async () => {
  const p = track(
    spawnWorkerProcess(
      "node",
      ["-e", 'let n = 0; setInterval(() => console.log("tick" + ++n), 30);'],
      { createWorker: F },
    ),
  );
  // The interval program stays alive (timer tracking) until we kill it.
  await waitFor(
    () => (p.stdout.match(/tick/g) || []).length >= 3,
    8000,
    "three ticks",
  );
  expect(p.kill("SIGTERM")).toBe(true);
  const r = await p.result();
  expect(r.exitCode).toBeNull();
  expect(r.signal).toBe("SIGTERM");
  expect(r.stdout).toContain("tick");
  // Second kill is a no-op once settled.
  expect(p.kill("SIGTERM")).toBe(false);
});

test("real: kill(SIGKILL) is recorded distinctly from SIGTERM", async () => {
  const p = track(
    spawnWorkerProcess("node", ["-e", "setInterval(() => {}, 1000);"], {
      createWorker: F,
    }),
  );
  await waitFor(() => p.settled === false, 1000, "spawned");
  p.kill("SIGKILL");
  const r = await p.result();
  expect(r.exitCode).toBeNull();
  expect(r.signal).toBe("SIGKILL");
});

test("real: AbortSignal aborts the worker", async () => {
  const controller = new AbortController();
  const p = track(
    spawnWorkerProcess("node", ["-e", "setInterval(() => {}, 1000);"], {
      createWorker: F,
      signal: controller.signal,
    }),
  );
  controller.abort();
  const r = await p.result();
  expect(r.signal).toBe("SIGTERM");
  expect(r.exitCode).toBeNull();
});

// ─── VFS bridge: patch a RUNNING worker ─────────────────────────────────

test("real: applyVfsDiff patches a running worker over the VFS bridge", async () => {
  const p = track(
    spawnWorkerProcess(
      "node",
      [
        "-e",
        "let n = 0;\n" +
          "const t = setInterval(() => {\n" +
          "  n++;\n" +
          "  let v = null;\n" +
          '  try { v = require("/flag.txt"); } catch (e) { /* not yet */ }\n' +
          '  console.log(v === null ? "waiting" : "got:" + v);\n' +
          "  if (n >= 40) clearInterval(t);\n" +
          "}, 40);",
      ],
      { createWorker: F },
    ),
  );
  await waitFor(() => p.stdout.includes("waiting"), 8000, "first waiting tick");
  const acked = await p.applyVfsDiff({
    "/flag.txt": 'module.exports = "flag-value";',
  });
  expect(acked).toBe(true);
  await waitFor(
    () => p.stdout.includes("got:flag-value"),
    8000,
    "bridged value observed",
  );
  const r = await p.result();
  expect(r.exitCode).toBe(0);
  // Deletion over the bridge is honored too: patch a running worker that
  // polls for the file, then delete it and watch the program observe that.
  const p2 = track(
    spawnWorkerProcess(
      "node",
      [
        "-e",
        "let n = 0;\n" +
          "const t = setInterval(() => {\n" +
          "  n++;\n" +
          "  let present = true;\n" +
          '  try { require("/gone.txt"); } catch (e) { present = false; }\n' +
          '  console.log(present ? "present" : "absent");\n' +
          "  if (n >= 30) clearInterval(t);\n" +
          "}, 40);",
      ],
      { createWorker: F, vfs: { "/gone.txt": "module.exports = 1;" } },
    ),
  );
  await waitFor(() => p2.stdout.includes("present"), 8000, "file present");
  const acked2 = await p2.applyVfsDiff({ "/gone.txt": null });
  expect(acked2).toBe(true);
  await waitFor(
    () => p2.stdout.includes("absent"),
    8000,
    "deletion observed over the bridge",
  );
  const r2 = await p2.result();
  expect(r2.exitCode).toBe(0);
});

// ─── workerBackedShell end-to-end (BYO contract) ─────────────────────────

test("real: workerBackedShell resolves {stdout, stderr, exitCode} via the Node lane", async () => {
  const promise = workerBackedShell("node -e 'console.log(40 + 2)'", [], {
    createWorker: F,
  });
  expect(typeof promise.kill).toBe("function");
  const r = await promise;
  expect(r.stdout).toBe("42\n");
  expect(r.exitCode).toBe(0);
});

test("real: workerBackedShell kill() terminates a running program", async () => {
  const promise = workerBackedShell(
    "node",
    ["-e", 'setInterval(() => console.log("x"), 25);'],
    { createWorker: F },
  );
  await new Promise((r) => setTimeout(r, 200));
  promise.kill("SIGTERM");
  const r = await promise;
  expect(r.signal).toBe("SIGTERM");
  expect(r.exitCode).toBeNull();
});

// ─── process manager ────────────────────────────────────────────────────

test("real: createProcessManager tracks, lists and kills groups", async () => {
  const mgr = createProcessManager();
  const mk = () =>
    mgr.spawn("node", ["-e", "setInterval(() => {}, 500);"], {
      createWorker: F,
    });
  const h1 = mk();
  const h2 = mk();
  track(h1);
  track(h2);
  await waitFor(() => mgr.list().length === 2, 8000, "two live children");
  expect(mgr.list().length).toBe(2);
  expect(new Set(mgr.list().map((h) => h.pid)).size).toBe(2);
  expect(mgr.killAll("SIGKILL")).toBe(2);
  const [r1, r2] = await Promise.all([h1.result(), h2.result()]);
  expect(r1.signal).toBe("SIGKILL");
  expect(r2.signal).toBe("SIGKILL");
  expect(mgr.list().length).toBe(0);
});
