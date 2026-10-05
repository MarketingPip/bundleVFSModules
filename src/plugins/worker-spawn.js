// src/plugins/worker-spawn.js — worker-backed child_process implementation.
//
// Opt-in plugin (Jared 2026-10-04): the runtime's OWN honest process story.
// Register via `registerPlugin(workerSpawnPlugin)` from `src/plugins.js`.
//
// Why this exists: PR #180 landed BYO shell (`new CodeSandbox({shell})` —
// developers provide their own function). This is the runtime's own process
// implementation for hosts that don't bring one: real child processes backed
// by Web Workers (CSP allows `worker-src blob:`), booting from a VFS
// snapshot, with stdio streaming, signals, and exit codes.
//
// This is NOT a shell emulator (AGENTS.md rule 11: no shell as product).
// The worker executes JavaScript: `node -e '<code>'` runs inline code,
// `node <file>` runs a file from the VFS snapshot. Non-JS commands get an
// honest 127 "command not found" — never a fake success (rule 7).
//
// Reference: Nodepod's `process-manager.ts` + `process-worker-entry.ts`
// (see docs/COMPETITOR_TECHNIQUES.md) — workers boot from a VFS snapshot
// and receive changes over a VFS bridge.

export const workerSpawnPlugin = {
  name: "worker-spawn",
  builtIn: true,
  // The shell function and helpers are exported at module scope below;
  // the plugin object itself is the registration token. Hosts opt in via:
  //   import { workerSpawnPlugin, workerBackedShell } from "./src/plugins/worker-spawn.js";
  //   import { registerPlugin } from "./src/plugins.js";
  //   registerPlugin(workerSpawnPlugin);
  //   const sb = new CodeSandbox({ shell: workerBackedShell });
};

/**
 * Build the worker script as a string. Pure function — testable in Node.
 *
 * NOTE: The template below is DUPLICATED inside `workerBackedShell`
 * (self-contained for `.toString()` serialization into the sandbox —
 * the shell function cannot reference module-scope helpers). The test
 * "buildWorkerScript matches the inlined template" guards the sync.
 *
 * The worker:
 * 1. Captures console.log/error → posts {type:"stdout"|"stderr", data}
 * 2. Receives {type:"init", command, args, vfs} via postMessage
 * 3. Executes the command (node -e / node <file>)
 * 4. Posts {type:"exit", code} when done
 *
 * @param {string} command — shell command string (e.g. "node -e '...'")
 * @param {string[]} args — args array (informational; command carries the semantics)
 * @param {object|null} vfs — VFS snapshot {path: contents} or null
 * @returns {string} the worker script source
 */
export function buildWorkerScript(command, args, vfs) {
  return _workerScriptTemplate(command, args, vfs);
}

// The canonical template. Also inlined in workerBackedShell below.
function _workerScriptTemplate(command, args, vfs) {
  const vfsJson = vfs ? JSON.stringify(vfs) : "null";
  // JSON-stringify the command/args so they're safely embedded.
  const commandJson = JSON.stringify(command);
  const argsJson = JSON.stringify(args || []);

  return `
"use strict";
// ─── worker-spawn entry ───────────────────────────────────────────────────
// Booted from a blob URL by workerBackedShell. Captures stdio, runs the
// command, reports the exit code. No DOM, no window — worker scope only.

const VFS_SNAPSHOT = ${vfsJson};
const COMMAND = ${commandJson};
const ARGS = ${argsJson};

let stdoutBuf = "";
let stderrBuf = "";

// Capture console → postMessage (streaming) + buffer (final result).
const origLog = console.log.bind(console);
const origError = console.error.bind(console);
console.log = (...a) => {
  const line = a.map(String).join(" ") + "\\n";
  stdoutBuf += line;
  postMessage({ type: "stdout", data: line });
};
console.error = (...a) => {
  const line = a.map(String).join(" ") + "\\n";
  stderrBuf += line;
  postMessage({ type: "stderr", data: line });
};
console.warn = console.error;
console.info = console.log;

// Minimal process shim for the executed code.
const processShim = {
  argv: ["node", ...ARGS],
  env: {},
  exitCode: 0,
  exit(code) {
    processShim.exitCode = code == null ? 0 : code;
    // Throw a sentinel to unwind the stack; the runner catches it.
    throw { __workerExit: true, code: processShim.exitCode };
  },
};

// Minimal require: resolves from the VFS snapshot.
function makeRequire(vfs) {
  return function require(id) {
    if (id === "assert") {
      // Tiny assert shim — enough for smoke tests.
      return {
        strictEqual(a, b, msg) {
          if (a !== b) throw new Error(msg || ("Expected " + a + " === " + b));
        },
        ok(v, msg) {
          if (!v) throw new Error(msg || "Assertion failed");
        },
      };
    }
    const path = id.startsWith("/") ? id : "/" + id;
    const src = vfs && vfs[path];
    if (src == null) {
      throw new Error("Cannot find module '" + id + "'");
    }
    const module = { exports: {} };
    const fn = new Function("require", "module", "exports", "process", "console", src);
    fn(makeRequire(vfs), module, module.exports, processShim, console);
    return module.exports;
  };
}

function runCode(code, label) {
  try {
    const fn = new Function(
      "require", "process", "console", "__dirname", "__filename",
      code + "\\n//# sourceURL=" + label
    );
    fn(makeRequire(VFS_SNAPSHOT), processShim, console, "/", label || "eval");
    postMessage({ type: "exit", code: processShim.exitCode || 0 });
  } catch (err) {
    if (err && err.__workerExit) {
      postMessage({ type: "exit", code: err.code || 0 });
      return;
    }
    console.error(err && err.stack ? err.stack : String(err));
    postMessage({ type: "exit", code: 1 });
  }
}

// ─── Command dispatch ────────────────────────────────────────────────────
// Honest scope: we execute JavaScript. Anything else is a loud 127,
// not a fake shell (AGENTS.md rule 7: no silent fakes).
//
// The worker waits for the init message before running. This avoids a race
// where the worker posts exit before the host sets onmessage.

function main() {
  const cmd = COMMAND.trim();

  // node -e '<code>' — inline JavaScript.
  let m = cmd.match(/^node\\s+-e\\s+(['"])([\\s\\S]*)\\1$/);
  if (m) {
    runCode(m[2], "node -e");
    return;
  }
  // node --version — report the host's version string honestly.
  if (cmd === "node --version" || cmd === "node -v") {
    console.log("v24.0.0-worker");
    postMessage({ type: "exit", code: 0 });
    return;
  }
  // node <file> — run a file from the VFS snapshot.
  m = cmd.match(/^node\\s+([^\\s]+)(\\s+[\\s\\S]*)?$/);
  if (m) {
    const file = m[1].startsWith("/") ? m[1] : "/" + m[1];
    const src = VFS_SNAPSHOT && VFS_SNAPSHOT[file];
    if (src == null) {
      console.error("node: can't open '" + m[1] + "': No such file");
      postMessage({ type: "exit", code: 1 });
      return;
    }
    runCode(typeof src === "string" ? src : String(src), file);
    return;
  }
  // Anything else: honest 127, not a fake shell.
  console.error(cmd.split(/\\s+/)[0] + ": command not found");
  postMessage({ type: "exit", code: 127 });
}

// Wait for the host's init message (avoids the post-before-onmessage race).
// The command is baked into the script; the message is just a start signal.
self.onmessage = (event) => {
  if (event && event.data && event.data.type === "init") {
    main();
  }
};
`;
}

/**
 * Worker-backed shell function matching the BYO shell contract:
 *   shell(command, args, options) => Promise<{stdout, stderr, exitCode, signal?}>
 *
 * Spawns a Web Worker from a blob URL, boots it with the command,
 * streams stdout/stderr via postMessage, and resolves with the result.
 *
 * Kill support: the returned Promise carries a `.kill(signal)` method that
 * terminates the worker. `options.signal` (AbortSignal) also terminates.
 * This matches the ChildProcess semantics: kill → SIGTERM, exitCode null.
 *
 * Requires a browser Worker (or a compatible global). In Node without a
 * Worker global, throws a clear error.
 */
export function workerBackedShell(command, args, options = {}) {
  if (typeof Worker === "undefined") {
    throw new Error(
      "worker-spawn: Web Worker is not available in this environment. " +
        "This shell requires a browser (or a Worker-compatible global)."
    );
  }

  let worker = null;
  let settled = false;
  let stdout = "";
  let stderr = "";
  let killFn = null;

  const promise = new Promise((resolve) => {
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        if (worker) worker.terminate();
      } catch {
        /* already gone */
      }
      if (blobUrl) {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
          /* ignore */
        }
      }
      resolve(result);
    };

    // VFS snapshot: prefer options.vfs (set by execCore/spawn), else null.
    const vfs = options && options.vfs ? options.vfs : null;

    // Self-contained worker script. DUPLICATED from _workerScriptTemplate
    // above — the shell is serialized via .toString() into the sandbox and
    // cannot reference module-scope helpers. The test
    // "buildWorkerScript matches the inlined template" guards the sync.
    const vfsJson = vfs ? JSON.stringify(vfs) : "null";
    const commandJson = JSON.stringify(command);
    const argsJson = JSON.stringify(args || []);
    const script = `
"use strict";
// ─── worker-spawn entry ───────────────────────────────────────────────────
// Booted from a blob URL by workerBackedShell. Captures stdio, runs the
// command, reports the exit code. No DOM, no window — worker scope only.

const VFS_SNAPSHOT = ${vfsJson};
const COMMAND = ${commandJson};
const ARGS = ${argsJson};

let stdoutBuf = "";
let stderrBuf = "";

// Capture console → postMessage (streaming) + buffer (final result).
const origLog = console.log.bind(console);
const origError = console.error.bind(console);
console.log = (...a) => {
  const line = a.map(String).join(" ") + "\\n";
  stdoutBuf += line;
  postMessage({ type: "stdout", data: line });
};
console.error = (...a) => {
  const line = a.map(String).join(" ") + "\\n";
  stderrBuf += line;
  postMessage({ type: "stderr", data: line });
};
console.warn = console.error;
console.info = console.log;

// Minimal process shim for the executed code.
const processShim = {
  argv: ["node", ...ARGS],
  env: {},
  exitCode: 0,
  exit(code) {
    processShim.exitCode = code == null ? 0 : code;
    throw { __workerExit: true, code: processShim.exitCode };
  },
};

// Minimal require: resolves from the VFS snapshot.
function makeRequire(vfs) {
  return function require(id) {
    if (id === "assert") {
      return {
        strictEqual(a, b, msg) {
          if (a !== b) throw new Error(msg || ("Expected " + a + " === " + b));
        },
        ok(v, msg) {
          if (!v) throw new Error(msg || "Assertion failed");
        },
      };
    }
    const path = id.startsWith("/") ? id : "/" + id;
    const src = vfs && vfs[path];
    if (src == null) {
      throw new Error("Cannot find module '" + id + "'");
    }
    const module = { exports: {} };
    const fn = new Function("require", "module", "exports", "process", "console", src);
    fn(makeRequire(vfs), module, module.exports, processShim, console);
    return module.exports;
  };
}

function runCode(code, label) {
  try {
    const fn = new Function(
      "require", "process", "console", "__dirname", "__filename",
      code + "\\n//# sourceURL=" + label
    );
    fn(makeRequire(VFS_SNAPSHOT), processShim, console, "/", label || "eval");
    postMessage({ type: "exit", code: processShim.exitCode || 0 });
  } catch (err) {
    if (err && err.__workerExit) {
      postMessage({ type: "exit", code: err.code || 0 });
      return;
    }
    console.error(err && err.stack ? err.stack : String(err));
    postMessage({ type: "exit", code: 1 });
  }
}

function main() {
  const cmd = COMMAND.trim();
  let m = cmd.match(/^node\\s+-e\\s+(['"])([\\s\\S]*)\\1$/);
  if (m) {
    runCode(m[2], "node -e");
    return;
  }
  if (cmd === "node --version" || cmd === "node -v") {
    console.log("v24.0.0-worker");
    postMessage({ type: "exit", code: 0 });
    return;
  }
  m = cmd.match(/^node\\s+([^\\s]+)(\\s+[\\s\\S]*)?$/);
  if (m) {
    const file = m[1].startsWith("/") ? m[1] : "/" + m[1];
    const src = VFS_SNAPSHOT && VFS_SNAPSHOT[file];
    if (src == null) {
      console.error("node: can't open '" + m[1] + "': No such file");
      postMessage({ type: "exit", code: 1 });
      return;
    }
    runCode(typeof src === "string" ? src : String(src), file);
    return;
  }
  console.error(cmd.split(/\\s+/)[0] + ": command not found");
  postMessage({ type: "exit", code: 127 });
}

// Wait for the host's init message (avoids the post-before-onmessage race).
self.onmessage = (event) => {
  if (event && event.data && event.data.type === "init") {
    main();
  }
};
`;
    const blob = new Blob([script], { type: "text/javascript" });
    const blobUrl = URL.createObjectURL(blob);

    worker = new Worker(blobUrl);

    killFn = (signal = "SIGTERM") => {
      if (settled) return;
      finish({ stdout, stderr, exitCode: null, signal });
    };

    worker.onmessage = (event) => {
      const msg = event && event.data;
      if (!msg || settled) return;
      if (msg.type === "stdout") {
        stdout += msg.data;
      } else if (msg.type === "stderr") {
        stderr += msg.data;
      } else if (msg.type === "exit") {
        finish({
          stdout,
          stderr,
          exitCode: msg.code,
          signal: null,
        });
      }
    };

    worker.onerror = (event) => {
      const message =
        (event && (event.message || event.error)) || "worker error";
      stderr += String(message) + "\n";
      finish({ stdout, stderr, exitCode: 1, signal: null });
    };

    // AbortSignal → terminate (matches ChildProcess kill semantics).
    const signal = options && options.signal;
    if (signal && typeof signal.addEventListener === "function") {
      if (signal.aborted) {
        killFn("SIGTERM");
        return;
      }
      signal.addEventListener(
        "abort",
        () => killFn("SIGTERM"),
        { once: true }
      );
    }

    // Boot the worker. The command is baked into the script; the init
    // message is a formality that also lets mocks hook in.
    worker.postMessage({ type: "init", command, args: args || [] });
  });

  // Kill handle on the promise (extra, contract-compatible).
  promise.kill = (...a) => {
    if (killFn) killFn(...a);
  };

  return promise;
}
