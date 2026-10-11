// src/plugins/worker-spawn.js — worker-backed child_process implementation.
//
// Opt-in plugin (Jared 2026-10-04): the runtime's OWN honest process story.
// Register via `registerPlugin(workerSpawnPlugin)` from `src/plugins.js`.
//
// Why this exists: PR #180 landed BYO shell (`new CodeSandbox({shell})` —
// developers provide their own function). This is the runtime's own process
// implementation for hosts that don't bring one: real child processes backed
// by workers (Web Workers in the browser, worker_threads under Node),
// booting from a VFS snapshot, with stdio streaming, signals, and exit codes.
//
// This is NOT a shell emulator (AGENTS.md rule 11: no shell as product).
// The worker executes JavaScript: `node -e '<code>'` runs inline code,
// `node <file>` runs a file from the VFS snapshot. Non-JS commands get an
// honest 127 "command not found" — never a fake success (rule 7).
//
// Reference: Nodepod's `process-manager.ts` + `process-worker-entry.ts`
// (see docs/COMPETITOR_TECHNIQUES.md) — workers boot from a VFS snapshot
// and receive changes over a VFS bridge. Technique only; all code here is
// original.
//
// Lanes:
//   - Browser lane (default): `defaultBrowserWorkerFactory` builds the entry
//     from a Blob URL and spawns a Web Worker.
//   - Node lane: `nodeWorkerFactory` writes the entry to a temp file and
//     spawns a real `worker_threads` Worker. Used by the real-execution
//     tests and by Node hosts; pass as `options.createWorker`.
//
// Sandbox-serialization constraint: the BYO shell function is serialized
// via `.toString()` into the sandbox (`src/runtime/sandbox-runtime.js`
// embeds `config.shell.toString()`), so it cannot reference module scope.
// `workerBackedShell` is therefore ASSEMBLED at module load from the
// canonical pieces below (WORKER_ENTRY_SOURCE + the pure helpers +
// spawnWorkerProcessCore), each embedded by `.toString()` / JSON. There is
// exactly one copy of every piece — no drift. The embedded helpers are
// declared WITHOUT `export` (an `export` keyword would be a syntax error
// inside the assembled function body) and re-exported by name below.

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

// ─── Canonical worker entry ─────────────────────────────────────────────
// Single source of truth for the code that runs INSIDE the worker.
// Rendered by renderWorkerEntry() with the command/args/VFS/env baked in
// as JSON. Placeholders: __WORKER_COMMAND__ __WORKER_ARGS__
// __WORKER_VFS__ __WORKER_ENV__.
//
// Written as string-concat (no backticks, no ${}) so it survives both the
// outer template literal AND JSON.stringify into the assembled shell body.
//
// Host<->worker protocol:
//   host -> worker: {type:"init"}                       start execution
//   host -> worker: {type:"vfs-patch", files:{p:src}}   VFS bridge (null=delete)
//   worker -> host: {type:"stdout"|"stderr", data}       stdio streaming
//   worker -> host: {type:"exit", code}                 process exit
//   worker -> host: {type:"vfs-ack", applied:n}         bridge acknowledgement
var WORKER_ENTRY_SOURCE = [
  '"use strict";',
  "// --- worker-spawn entry ---",
  "// Boots from a VFS snapshot (Nodepod process-worker-entry pattern).",
  "// Captures stdio, runs the command, reports the exit code.",
  "// No DOM, no window, no syscalls -- a JS sandbox, not an OS process.",
  "",
  "// Node lane: under Node worker_threads there is no `self`; wire parentPort",
  "// to the browser Worker message shape so the SAME entry runs in both lanes.",
  "// (In a browser worker `self` exists and this block is skipped -- `require'",
  "// is never evaluated there.)",
  "if (typeof self === 'undefined' && typeof process !== 'undefined' && process.versions && process.versions.node) {",
  "  var __pp = require('worker_threads').parentPort;",
  "  var __onmessage = null;",
  "  __pp.on('message', function (data) { if (__onmessage) { try { __onmessage({ data: data }); } catch (e) {} } });",
  "  var __self = { postMessage: function (msg) { __pp.postMessage(msg); } };",
  "  Object.defineProperty(__self, 'onmessage', {",
  "    configurable: true,",
  "    get: function () { return __onmessage; },",
  "    set: function (fn) { __onmessage = fn; }",
  "  });",
  "  globalThis.self = __self;",
  "  globalThis.postMessage = function (msg) { __pp.postMessage(msg); };",
  "}",
  "",
  "var VFS_SNAPSHOT = __WORKER_VFS__;",
  "var COMMAND = __WORKER_COMMAND__;",
  "var ARGS = __WORKER_ARGS__;",
  "var ENV = __WORKER_ENV__;",
  "if (VFS_SNAPSHOT == null) VFS_SNAPSHOT = {};",
  "if (ENV == null) ENV = {};",
  "",
  "// --- stdio capture: stream each chunk to the host, buffer for the result ---",
  "var __stdoutBuf = '';",
  "var __stderrBuf = '';",
  "console.log = function () {",
  "  var line = Array.prototype.map.call(arguments, String).join(' ') + '\\n';",
  "  __stdoutBuf += line;",
  "  postMessage({ type: 'stdout', data: line });",
  "};",
  "console.info = console.log;",
  "console.error = function () {",
  "  var line = Array.prototype.map.call(arguments, String).join(' ') + '\\n';",
  "  __stderrBuf += line;",
  "  postMessage({ type: 'stderr', data: line });",
  "};",
  "console.warn = console.error;",
  "",
  "// --- liveness: the worker exits when the event loop drains ---",
  "// A real process exits when there is nothing left to do. We track the",
  "// timers the program creates; once main() has returned and none are",
  "// pending, we report the exit code. process.exit() exits immediately,",
  "// like the real thing. Honest gap: bare promise chains with no timer",
  "// cannot be tracked -- a program that only awaits a promise may be cut",
  "// short. Keep the worker alive with a timer or call process.exit().",
  "var __mainDone = false;",
  "var __exited = false;",
  "var __pendingTimers = 0;",
  "var __timerKind = new Map();",
  "function __maybeExit() {",
  "  if (__exited || !__mainDone) return;",
  "  if (__pendingTimers !== 0) return;",
  "  __exited = true;",
  "  postMessage({ type: 'exit', code: processShim.exitCode || 0 });",
  "}",
  "function __wrapTimer(orig, kind) {",
  "  return function (fn, ms) {",
  "    var rest = Array.prototype.slice.call(arguments, 2);",
  "    var nativeId = orig(function () {",
  "      if (kind === 'timeout' && __timerKind.get(nativeId) === 'timeout') {",
  "        __timerKind.delete(nativeId);",
  "        __pendingTimers--;",
  "      }",
  "      try { fn.apply(null, rest); } finally { __maybeExit(); }",
  "    }, ms);",
  "    __timerKind.set(nativeId, kind);",
  "    __pendingTimers++;",
  "    return nativeId;",
  "  };",
  "}",
  "var __origSetTimeout = setTimeout;",
  "var __origSetInterval = setInterval;",
  "var __origClearTimeout = clearTimeout;",
  "var __origClearInterval = clearInterval;",
  "setTimeout = __wrapTimer(__origSetTimeout, 'timeout');",
  "setInterval = __wrapTimer(__origSetInterval, 'interval');",
  "clearTimeout = function (id) {",
  "  if (__timerKind.get(id) === 'timeout') { __timerKind.delete(id); __pendingTimers--; }",
  "  __origClearTimeout(id);",
  "  __maybeExit();",
  "};",
  "clearInterval = function (id) {",
  "  if (__timerKind.get(id) === 'interval') { __timerKind.delete(id); __pendingTimers--; }",
  "  __origClearInterval(id);",
  "  __maybeExit();",
  "};",
  "",
  "// --- process shim (honest labels: this is a worker, not an OS process) ---",
  "var processShim = {",
  "  argv: ['node'].concat(ARGS),",
  "  env: ENV,",
  "  exitCode: 0,",
  "  version: 'v24.0.0-worker',",
  "  versions: { node: '24.0.0-worker' },",
  "  platform: 'browser-worker',",
  "  exit: function (code) {",
  "    processShim.exitCode = code == null ? 0 : code;",
  "    __exited = true;",
  "    postMessage({ type: 'exit', code: processShim.exitCode });",
  "    throw { __workerExit: true, code: processShim.exitCode };",
  "  }",
  "};",
  "",
  "// --- require(): resolves from the VFS snapshot ---",
  "// No module cache: the VFS bridge may replace files under a running",
  "// worker, and re-require must observe the patch.",
  "function __normalizePath(p) {",
  "  var parts = String(p).split('/');",
  "  var out = [];",
  "  for (var i = 0; i < parts.length; i++) {",
  "    var s = parts[i];",
  "    if (s === '' || s === '.') continue;",
  "    if (s === '..') { out.pop(); continue; }",
  "    out.push(s);",
  "  }",
  "  return '/' + out.join('/');",
  "}",
  "function __resolvePath(parentPath, id) {",
  "  if (id.charAt(0) === '/') return __normalizePath(id);",
  "  if (id.charAt(0) === '.') {",
  "    var slash = parentPath.lastIndexOf('/');",
  "    var dir = slash <= 0 ? '/' : parentPath.slice(0, slash);",
  "    return __normalizePath(dir + '/' + id);",
  "  }",
  "  return '/' + id;",
  "}",
  "function makeRequire(vfs, parentPath) {",
  "  return function require(id) {",
  "    if (id === 'assert') {",
  "      return {",
  '        strictEqual: function (a, b, msg) { if (a !== b) throw new Error(msg || ("Expected " + a + " === " + b)); },',
  "        ok: function (v, msg) { if (!v) throw new Error(msg || 'Assertion failed'); }",
  "      };",
  "    }",
  "    var p = __resolvePath(parentPath, id);",
  "    var src = vfs ? vfs[p] : null;",
  '    if (src == null) throw new Error("Cannot find module \'" + id + "\'");',
  "    var module = { exports: {} };",
  "    var fn = new Function('require', 'module', 'exports', 'process', 'console', '__dirname', '__filename', String(src) + '\\n//# sourceURL=' + p);",
  '    var d = p.slice(0, p.lastIndexOf("/"));',
  '    fn(makeRequire(vfs, p), module, module.exports, processShim, console, d === "" ? "/" : d, p);',
  "    return module.exports;",
  "  };",
  "}",
  "",
  "function runCode(code, label, filename) {",
  "  try {",
  "    var fn = new Function('require', 'process', 'console', '__dirname', '__filename', code + '\\n//# sourceURL=' + label);",
  "    var fp = filename || '/<entry>';",
  "    var ds = fp.slice(0, fp.lastIndexOf('/'));",
  "    fn(makeRequire(VFS_SNAPSHOT, fp), processShim, console, ds === '' ? '/' : ds, fp);",
  "    __mainDone = true;",
  "    __maybeExit();",
  "  } catch (err) {",
  "    if (err && err.__workerExit) return; // exit() already posted",
  "    __exited = true;",
  "    try { console.error(err && err.stack ? err.stack : String(err)); } catch (e) {}",
  "    postMessage({ type: 'exit', code: 1 });",
  "  }",
  "}",
  "",
  "// --- command dispatch: we execute JavaScript; anything else is a loud 127,",
  "// not a fake shell (AGENTS.md rule 7: no silent fakes) ---",
  "function main() {",
  "  var code = null;",
  "  var file = null;",
  "  if (COMMAND === 'node' && ARGS.length > 0) {",
  '    // spawn-style: shell("node", args) -- args carry the semantics',
  "    if (ARGS[0] === '-e' || ARGS[0] === '--eval') { code = ARGS.slice(1).join(' '); }",
  "    else if (ARGS[0] === '--version' || ARGS[0] === '-v') {",
  "      console.log(processShim.version);",
  "      __exited = true;",
  "      postMessage({ type: 'exit', code: 0 });",
  "      return;",
  "    }",
  "    else { file = ARGS[0]; }",
  "  } else {",
  "    var cmd = String(COMMAND).trim();",
  "    var m = cmd.match(/^node\\s+-e\\s+(['\"])([\\s\\S]*)\\1$/);",
  "    if (m) { code = m[2]; }",
  "    else if (cmd === 'node --version' || cmd === 'node -v') {",
  "      console.log(processShim.version);",
  "      __exited = true;",
  "      postMessage({ type: 'exit', code: 0 });",
  "      return;",
  "    }",
  "    else {",
  "      m = cmd.match(/^node\\s+(\\S+)(\\s+[\\s\\S]*)?$/);",
  "      if (m) { file = m[1]; }",
  "      else { console.error(cmd.split(/\\s+/)[0] + ': command not found'); __exited = true; postMessage({ type: 'exit', code: 127 }); return; }",
  "    }",
  "  }",
  "  if (code !== null) { runCode(code, 'node -e'); return; }",
  "  if (file !== null) {",
  "    var p = file.charAt(0) === '/' ? file : '/' + file;",
  "    var src = VFS_SNAPSHOT ? VFS_SNAPSHOT[p] : null;",
  "    if (src == null) { console.error(\"node: can't open '\" + file + \"': No such file\"); __exited = true; postMessage({ type: 'exit', code: 1 }); return; }",
  "    runCode(typeof src === 'string' ? src : String(src), p, p);",
  "    return;",
  "  }",
  "  console.error(String(COMMAND).split(/\\s+/)[0] + ': command not found');",
  "  __exited = true;",
  "  postMessage({ type: 'exit', code: 127 });",
  "}",
  "",
  "// --- message loop: init starts main(); vfs-patch is the VFS bridge ---",
  "// The worker waits for init before running: avoids the race where it posts",
  "// exit before the host has installed onmessage.",
  "var __started = false;",
  "self.onmessage = function (event) {",
  "  var msg = event && event.data;",
  "  if (!msg) return;",
  "  if (msg.type === 'init') {",
  "    if (!__started) { __started = true; main(); }",
  "  } else if (msg.type === 'vfs-patch') {",
  "    var files = msg.files || {};",
  "    var n = 0;",
  "    for (var p in files) {",
  "      if (!Object.prototype.hasOwnProperty.call(files, p)) continue;",
  "      if (files[p] === null || files[p] === undefined) { delete VFS_SNAPSHOT[p]; }",
  "      else { VFS_SNAPSHOT[p] = files[p]; }",
  "      n++;",
  "    }",
  "    postMessage({ type: 'vfs-ack', applied: n });",
  "  }",
  "};",
].join("\n");

// ─── Pure helpers (no `export` keyword: embedded by .toString() below) ───

/**
 * Render the worker entry with the spawn parameters baked in as JSON.
 * Pure and self-contained: only references its arguments.
 */
function renderWorkerEntry(template, command, args, vfs, env) {
  return template
    .split("__WORKER_COMMAND__")
    .join(JSON.stringify(command))
    .split("__WORKER_ARGS__")
    .join(JSON.stringify(args || []))
    .split("__WORKER_VFS__")
    .join(JSON.stringify(vfs == null ? null : vfs))
    .split("__WORKER_ENV__")
    .join(JSON.stringify(env || {}));
}

/**
 * Browser worker factory: script -> Blob URL -> Web Worker, adapted to the
 * minimal worker interface the core needs. Self-contained (browser globals).
 *
 * Adapter contract: { postMessage(msg), terminate(),
 *   set/get onmessage, set/get onerror, set/get onunexpectedexit }
 * `onunexpectedexit(code)` is invoked when the worker dies WITHOUT the host
 * terminating it and WITHOUT posting {type:"exit"} (Node lane only; the
 * browser has no such event, so the property is simply never invoked there).
 */
function defaultBrowserWorkerFactory(script) {
  var blob = new Blob([script], { type: "text/javascript" });
  var url = URL.createObjectURL(blob);
  var w = new Worker(url);
  var adapter = {
    postMessage: function (msg) {
      w.postMessage(msg);
    },
    terminate: function () {
      try {
        w.terminate();
      } catch (e) {
        /* already gone */
      }
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        /* ignore */
      }
    },
    _onmessage: null,
    _onerror: null,
    _onexit: null,
  };
  Object.defineProperties(adapter, {
    onmessage: {
      configurable: true,
      get: function () {
        return adapter._onmessage;
      },
      set: function (fn) {
        adapter._onmessage = fn;
        w.onmessage = fn;
      },
    },
    onerror: {
      configurable: true,
      get: function () {
        return adapter._onerror;
      },
      set: function (fn) {
        adapter._onerror = fn;
        w.onerror = fn;
      },
    },
    onunexpectedexit: {
      configurable: true,
      get: function () {
        return adapter._onexit;
      },
      set: function (fn) {
        adapter._onexit = fn;
      },
    },
  });
  return adapter;
}

/**
 * The process-manager core: spawn one worker-backed process.
 *
 * Self-contained: references only its arguments, the embedded pieces above,
 * and language/browser globals -- so the assembled `workerBackedShell`
 * (serialized via .toString() into the sandbox) can embed it verbatim.
 *
 * @param {string} command -- e.g. "node" (spawn-style) or "node -e '...'" (exec-style)
 * @param {string[]} args
 * @param {object} [options]
 *   { vfs, env, signal (AbortSignal), createWorker(script)->adapter }
 * @returns handle { pid, on(ev,fn), kill(signal), applyVfsDiff(diff),
 *   result(), settled, exitCode, signal, stdout, stderr }
 *
 * Exit semantics match Node child_process: normal exit ->
 * {exitCode: code, signal: null}; killed -> {exitCode: null, signal}.
 * Synthetic pids start at 4097 (documented as synthetic, not OS pids).
 */
function spawnWorkerProcessCore(command, args, options) {
  options = options || {};
  var createWorker = options.createWorker || defaultBrowserWorkerFactory;
  var script = renderWorkerEntry(
    WORKER_ENTRY_SOURCE,
    command,
    args || [],
    options.vfs || null,
    options.env || {},
  );
  var worker = createWorker(script);

  var pid = (spawnWorkerProcessCore._nextPid =
    (spawnWorkerProcessCore._nextPid || 4096) + 1);
  var settled = false;
  var finalResult = null;
  var stdout = "";
  var stderr = "";
  var listeners = {};
  var exitWaiters = [];
  var pendingAcks = [];

  function on(ev, fn) {
    (listeners[ev] = listeners[ev] || []).push(fn);
    return handle;
  }
  function emit(ev, data) {
    var arr = listeners[ev] || [];
    for (var i = 0; i < arr.length; i++) {
      try {
        arr[i](data);
      } catch (e) {
        /* listener errors never break the process */
      }
    }
  }
  function finish(result) {
    if (settled) return;
    settled = true;
    finalResult = result;
    try {
      worker.terminate();
    } catch (e) {
      /* already gone */
    }
    for (var i = 0; i < exitWaiters.length; i++) {
      try {
        exitWaiters[i](result);
      } catch (e) {
        /* ignore */
      }
    }
    emit("exit", result);
  }
  // kill() is the signal story: SIGTERM/SIGKILL terminate the worker.
  // Termination is abrupt -- like SIGKILL, there are no cleanup hooks
  // (documented in docs/WORKER_SPAWN.md).
  function kill(signal) {
    if (settled) return false;
    var sig = signal || "SIGTERM";
    finish({
      stdout: stdout,
      stderr: stderr,
      exitCode: null,
      signal: sig,
      pid: pid,
    });
    return true;
  }

  worker.onmessage = function (event) {
    var msg = event && event.data;
    if (!msg || settled) return;
    if (msg.type === "stdout") {
      stdout += msg.data;
      emit("stdout", msg.data);
    } else if (msg.type === "stderr") {
      stderr += msg.data;
      emit("stderr", msg.data);
    } else if (msg.type === "exit") {
      finish({
        stdout: stdout,
        stderr: stderr,
        exitCode: msg.code,
        signal: null,
        pid: pid,
      });
    } else if (msg.type === "vfs-ack") {
      var ack = pendingAcks.shift();
      if (ack) ack(true);
    }
  };
  worker.onerror = function (event) {
    var message =
      (event && (event.message || (event.error && event.error.message))) ||
      "worker error";
    stderr += String(message) + "\n";
    emit("stderr", String(message) + "\n");
    finish({
      stdout: stdout,
      stderr: stderr,
      exitCode: 1,
      signal: null,
      pid: pid,
    });
  };
  // Safety net for abnormal worker death (Node lane: worker_threads "exit"
  // without an {type:"exit"} message, e.g. the entry itself threw).
  try {
    worker.onunexpectedexit = function (code) {
      if (!settled) {
        finish({
          stdout: stdout,
          stderr: stderr,
          exitCode: code === 0 ? 0 : 1,
          signal: null,
          pid: pid,
        });
      }
    };
  } catch (e) {
    /* adapters without the hook ignore it */
  }

  // AbortSignal -> terminate (composes with ChildProcess options.signal).
  var abortSignal = options.signal;
  if (abortSignal && typeof abortSignal.addEventListener === "function") {
    if (abortSignal.aborted) {
      kill("SIGTERM");
    } else {
      abortSignal.addEventListener(
        "abort",
        function () {
          kill("SIGTERM");
        },
        { once: true },
      );
    }
  }

  // VFS bridge: patch the RUNNING worker's snapshot. Resolves true when the
  // worker acknowledges, false on timeout (a worker stuck in sync code can't
  // process messages) or after the process settled.
  function applyVfsDiff(diff) {
    return new Promise(function (resolve) {
      if (settled || !diff) {
        resolve(false);
        return;
      }
      var done = false;
      var timer = setTimeout(function () {
        if (!done) {
          done = true;
          resolve(false);
        }
      }, 2000);
      pendingAcks.push(function () {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(true);
        }
      });
      try {
        worker.postMessage({ type: "vfs-patch", files: diff });
      } catch (e) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(false);
        }
      }
    });
  }

  function result() {
    return new Promise(function (resolve) {
      if (finalResult) resolve(finalResult);
      else exitWaiters.push(resolve);
    });
  }

  var handle = {
    pid: pid,
    on: on,
    kill: kill,
    applyVfsDiff: applyVfsDiff,
    result: result,
    get settled() {
      return settled;
    },
    get exitCode() {
      return finalResult ? finalResult.exitCode : null;
    },
    get signal() {
      return finalResult ? finalResult.signal : null;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };

  // Boot the worker. The command is baked into the script; init is the
  // start signal (avoids the post-before-onmessage race).
  try {
    worker.postMessage({ type: "init", command: command, args: args || [] });
  } catch (e) {
    finish({
      stdout: stdout,
      stderr: stderr,
      exitCode: 1,
      signal: null,
      pid: pid,
    });
  }

  return handle;
}

// ─── Public module API ──────────────────────────────────────────────────

// Re-export the canonical pieces (declared without `export` above so their
// .toString() stays embeddable in the assembled shell).
export { WORKER_ENTRY_SOURCE, renderWorkerEntry, defaultBrowserWorkerFactory };

/**
 * Build the worker script as a string. Pure function — testable in Node.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} vfs -- VFS snapshot {path: contents} or null
 * @param {object} [env]
 * @returns {string} the worker script source
 */
export function buildWorkerScript(command, args, vfs, env) {
  return renderWorkerEntry(WORKER_ENTRY_SOURCE, command, args, vfs, env);
}

/**
 * Spawn one worker-backed process. The process-manager primitive: call it
 * once per child; each call boots an independent worker from its own VFS
 * snapshot. For managing groups, see createProcessManager().
 *
 * options: { vfs, env, signal (AbortSignal),
 *            createWorker(script)->adapter } -- defaults to the browser lane;
 *            pass nodeWorkerFactory for the Node worker_threads lane.
 */
export function spawnWorkerProcess(command, args, options) {
  return spawnWorkerProcessCore(command, args, options);
}

/**
 * Minimal process manager (the Nodepod process-manager.ts idea): tracks
 * live worker-backed children, lists them, kills them all.
 */
export function createProcessManager() {
  var live = [];
  function prune() {
    live = live.filter(function (h) {
      return !h.settled;
    });
  }
  return {
    spawn: function (command, args, options) {
      var h = spawnWorkerProcess(command, args, options);
      live.push(h);
      h.result().then(prune, prune);
      return h;
    },
    list: function () {
      prune();
      return live.slice();
    },
    killAll: function (signal) {
      prune();
      var n = 0;
      live.slice().forEach(function (h) {
        if (h.kill(signal || "SIGKILL")) n++;
      });
      return n;
    },
  };
}

/**
 * Node lane worker factory: runs the SAME worker entry source under Node's
 * worker_threads (the "real-Node test lane"). Writes the script to a temp
 * file (worker_threads cannot boot from a blob URL), spawns the thread,
 * and adapts it to the worker interface the core expects. Temp files are
 * removed on terminate and on thread exit.
 *
 * Not embeddable in the sandbox shell (Node-only); pass explicitly:
 *   spawnWorkerProcess("node -e '...'", [], { createWorker: nodeWorkerFactory })
 */
export function nodeWorkerFactory(scriptSource) {
  var proc =
    typeof process !== "undefined"
      ? process
      : typeof globalThis !== "undefined"
        ? globalThis.process
        : undefined;
  var getBuiltin =
    proc && typeof proc.getBuiltinModule === "function"
      ? proc.getBuiltinModule.bind(proc)
      : null;
  var cjsRequire = null;
  if (!getBuiltin) {
    try {
      cjsRequire = new Function(
        "return typeof require === 'function' ? require : null;",
      )();
    } catch (e) {
      cjsRequire = null;
    }
  }
  function need(name) {
    if (getBuiltin) return getBuiltin(name);
    if (cjsRequire) return cjsRequire(name);
    throw new Error(
      "worker-spawn: nodeWorkerFactory needs Node.js builtins " +
        "(worker_threads, fs, os, path).",
    );
  }
  var wt = need("worker_threads");
  var fs = need("fs");
  var os = need("os");
  var path = need("path");

  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-spawn-"));
  var file = path.join(dir, "entry.cjs");
  fs.writeFileSync(file, scriptSource, "utf8");
  var w = new wt.Worker(file);
  // Don't keep the host process alive for a worker we forgot to terminate.
  if (typeof w.unref === "function") w.unref();

  var cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  }

  var adapter = {
    _onmessage: null,
    _onerror: null,
    _onexit: null,
    postMessage: function (msg) {
      w.postMessage(msg);
    },
    terminate: function () {
      try {
        w.terminate();
      } catch (e) {
        /* already gone */
      }
      cleanup();
    },
  };
  Object.defineProperties(adapter, {
    onmessage: {
      configurable: true,
      get: function () {
        return adapter._onmessage;
      },
      set: function (fn) {
        adapter._onmessage = fn;
      },
    },
    onerror: {
      configurable: true,
      get: function () {
        return adapter._onerror;
      },
      set: function (fn) {
        adapter._onerror = fn;
      },
    },
    onunexpectedexit: {
      configurable: true,
      get: function () {
        return adapter._onexit;
      },
      set: function (fn) {
        adapter._onexit = fn;
      },
    },
  });
  w.on("message", function (data) {
    var fn = adapter._onmessage;
    if (fn) {
      try {
        fn({ data: data });
      } catch (e) {
        /* ignore */
      }
    }
  });
  w.on("error", function (err) {
    var fn = adapter._onerror;
    if (fn) fn({ message: String((err && err.message) || err) });
  });
  w.on("exit", function (code) {
    var fn = adapter._onexit;
    if (fn) {
      try {
        fn(code);
      } catch (e) {
        /* ignore */
      }
    }
    cleanup();
  });
  return adapter;
}

// ─── Assembled BYO shell ────────────────────────────────────────────────
// workerBackedShell matches the BYO shell contract:
//   shell(command, args, options) => Promise<{stdout, stderr, exitCode, signal?}>
// with a `.kill(signal)` method on the returned promise.
//
// It is ASSEMBLED here from the canonical pieces (single copy, no drift)
// and is self-contained by construction: the sandbox serializes it via
// .toString(), so the body references nothing outside itself.
var SHELL_BODY = [
  '"use strict";',
  "// workerBackedShell -- generated from the canonical worker-spawn pieces.",
  "// Self-contained by construction: safe for .toString() serialization",
  "// into the sandbox (the BYO shell contract). Do not hand-edit this body;",
  "// edit the canonical pieces above and it regenerates at module load.",
  "var WORKER_ENTRY_SOURCE = " + JSON.stringify(WORKER_ENTRY_SOURCE) + ";",
  renderWorkerEntry.toString(),
  defaultBrowserWorkerFactory.toString(),
  spawnWorkerProcessCore.toString(),
  "var __proc = spawnWorkerProcessCore(command, args, options || {});",
  "var __promise = __proc.result();",
  "__promise.kill = function (signal) { return __proc.kill(signal); };",
  "return __promise;",
].join("\n");

export var workerBackedShell = new Function(
  "command",
  "args",
  "options",
  SHELL_BODY,
);
