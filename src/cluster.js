// src/cluster.js — honest browser emulation of node:cluster (Node v24.20.0).
//
// A browser tab/iframe is single-process: forking a real OS process is
// impossible. This module therefore ALWAYS identifies as the primary
// (isPrimary/isMaster === true, isWorker === false) and every multi-process
// operation is an honest stub rather than a fabricated simulation:
//
//   fork()              returns a Worker-shaped EventEmitter with an `id` and a
//                       `process` stub exposing `pid`. No OS process is created
//                       and no user code runs in the "worker". The cluster
//                       emits 'fork' with the worker (on a microtask, like
//                       Node). No 'online' / 'message' / 'exit' / 'disconnect'
//                       events are ever fabricated, because no worker runs.
//   worker.send()       noop, returns false (nothing is delivered: there is no
//                       IPC channel). A send callback, if given, is never
//                       invoked.
//   worker.kill() /
//   worker.destroy() /
//   worker.disconnect() noops (there is no OS process to signal and no IPC
//                       channel to close). disconnect() returns the worker,
//                       like Node.
//   cluster.disconnect  noops over the (stub) workers; an optional callback is
//   ([callback])        still invoked asynchronously, per Node's contract, and
//                       never synchronously.
//   worker.isConnected() → false (no IPC channel exists)
//   worker.isDead()      → false (nothing was ever spawned, so nothing died)
//
// `globalThis._RUNTIME_` currently offers no worker-spawn hook, so none is
// wired here. Per project rules we do not invent one; if the runtime ever
// gains one, fork() is the place to attach it.

import { EventEmitter } from "./events.js";

// 1. Runtime bridge (guarded: rewritten to the sandbox scope at load time,
//    undefined under real Node / direct import). Declared for the sandbox
//    contract; intentionally unused — the runtime exposes no spawn/fork hook
//    today, and this module must not invent one.
const RT = (typeof globalThis._RUNTIME_ !== "undefined")
  ? globalThis._RUNTIME_
  : undefined;
void RT;

/* ------------------------------------------------------------------ */
/* Role flags — a browser is always the primary, never a worker.       */
/* ------------------------------------------------------------------ */

export const isPrimary = true;
export const isMaster = true; // deprecated alias of isPrimary
export const isWorker = false;

// Only ever set inside a real worker process; always undefined here.
export let worker = undefined;

/* ------------------------------------------------------------------ */
/* Scheduling policy + settings                                        */
/* ------------------------------------------------------------------ */

export const SCHED_NONE = 1;
export const SCHED_RR = 2;

// Settable, like Node (`cluster.schedulingPolicy = cluster.SCHED_NONE`).
// Scheduling itself cannot happen in a single-process browser; the value is
// stored and observable only.
let schedulingPolicy = SCHED_RR;
export { schedulingPolicy };

// Live registries. `settings` starts empty and is filled by setupPrimary()
// (or implicitly by fork()); `workers` maps stub-worker ids to workers.
export const workers = {};
export const settings = {};

/* ------------------------------------------------------------------ */
/* Worker — mirrors Node's internal/cluster Worker shape.              */
/*                                                                     */
/* Node defines Worker as a plain function (not a class) so that       */
/* `Worker.call({}, { id: 5 })` works; this shim does the same.         */
/* ------------------------------------------------------------------ */

export function Worker(options) {
  // Build on a real EventEmitter (our dependency-free port) and re-point the
  // prototype so `instanceof Worker` / `instanceof EventEmitter` both hold,
  // with or without `new`.
  const self = new EventEmitter();
  Object.setPrototypeOf(self, Worker.prototype);

  if (options === null || typeof options !== "object") options = {};

  // Present but undefined until a real lifecycle event would set it — exactly
  // like Node, where it starts undefined.
  self.exitedAfterDisconnect = undefined;

  self.state = options.state || "none";
  self.id = options.id | 0;

  if (options.process) {
    self.process = options.process;
    // Re-emit process-level events on the worker, like Node. Guarded: a
    // foreign `process`-like object may not be an emitter.
    if (typeof self.process.on === "function") {
      self.process.on("error", (code, signal) => self.emit("error", code, signal));
      self.process.on("message", (message, handle) => self.emit("message", message, handle));
    }
  }

  return self;
}
Object.setPrototypeOf(Worker.prototype, EventEmitter.prototype);

// kill() delegates to destroy(), like Node.
Worker.prototype.kill = function kill() {
  return this.destroy.apply(this, arguments);
};

// Noop: there is no OS process to signal in a browser.
Worker.prototype.destroy = function destroy(/* signal */) {};

// Noop: there is no IPC channel to close in a browser. Returns the worker,
// like Node.
Worker.prototype.disconnect = function disconnect() {
  return this;
};

// Noop: there is no IPC channel, so nothing is ever delivered. Returns
// false, like Node's send() on a closed channel.
Worker.prototype.send = function send() {
  if (!this.process || typeof this.process.send !== "function") return false;
  return this.process.send.apply(this.process, arguments);
};

// False: nothing was ever spawned, so nothing can have died. (Mirrors Node's
// exitCode/signalCode check against the stub process, which never exits.)
Worker.prototype.isDead = function isDead() {
  return !!(
    this.process &&
    (this.process.exitCode != null || this.process.signalCode != null)
  );
};

// False: the stub process has no IPC channel.
Worker.prototype.isConnected = function isConnected() {
  return !!(this.process && this.process.connected);
};

/* ------------------------------------------------------------------ */
/* fork() — create a stub worker. No OS process is spawned.             */
/* ------------------------------------------------------------------ */

let nextWorkerId = 1;

export function fork(env) {
  // Like Node, ensure settings defaults exist before forking.
  setupPrimary();

  const id = nextWorkerId++;

  // Minimal ChildProcess-shaped stub. It is an EventEmitter so that
  // worker.process.on('message'|'error') listeners can be attached without
  // throwing; nothing is ever emitted on it.
  const proc = new EventEmitter();
  proc.pid = id;
  // Echo of the requested env (default {}). Node's real ChildProcess has no
  // `.env`; this is a documented convenience so `cluster.fork({FOO: 'x'})`
  // remains introspectable.
  proc.env = env === undefined || env === null ? {} : env;
  proc.connected = false; // no IPC channel exists
  proc.exitCode = undefined; // never exits…
  proc.signalCode = undefined; // …and is never signalled
  proc.kill = function () {}; // noop
  proc.send = function () { return false; }; // noop: nothing delivered
  proc.disconnect = function () {}; // noop

  const w = new Worker({ id, process: proc });

  // Synchronous registration, like Node.
  workers[id] = w;

  // 'fork' is emitted on a microtask in Node (process.nextTick); match that
  // ordering with queueMicrotask, which exists in browsers and Node alike.
  queueMicrotask(() => cluster.emit("fork", w));

  return w;
}

/* ------------------------------------------------------------------ */
/* disconnect() — noop over stub workers; callback stays async.         */
/* ------------------------------------------------------------------ */

export function disconnect(callback) {
  // Structural fidelity with Node: disconnect connected workers. Stub workers
  // are never connected, so this loop is a no-op in practice.
  for (const w of Object.values(workers)) {
    if (w.isConnected()) w.disconnect();
  }

  // Node invokes the callback asynchronously (never synchronously); non-
  // function callbacks are silently ignored, like Node.
  if (typeof callback === "function") queueMicrotask(callback);
}

/* ------------------------------------------------------------------ */
/* setupPrimary() — merge settings, emit 'setup' asynchronously.        */
/* ------------------------------------------------------------------ */

export function setupPrimary(options) {
  const proc =
    typeof globalThis.process !== "undefined" ? globalThis.process : undefined;
  const argv = proc && Array.isArray(proc.argv) ? proc.argv : [];
  const execArgv = proc && Array.isArray(proc.execArgv) ? proc.execArgv : [];

  const merged = {
    args: argv.slice(2),
    exec: typeof argv[1] === "string" ? argv[1] : "",
    execArgv: execArgv.slice(),
    silent: false,
    ...settings,
    ...options,
  };

  // Replace the contents in place so the named `settings` export and
  // `cluster.settings` always reference the same object.
  for (const key of Object.keys(settings)) delete settings[key];
  Object.assign(settings, merged);

  // Node emits 'setup' on process.nextTick; queueMicrotask matches that
  // async ordering in browsers and under Node.
  queueMicrotask(() => cluster.emit("setup", settings));
}

// Deprecated alias — must be the same function object, like Node.
export const setupMaster = setupPrimary;

/* ------------------------------------------------------------------ */
/* The cluster singleton: an EventEmitter carrying the whole API,       */
/* exactly like Node (`require('node:cluster') instanceof EventEmitter`).*/
/* ------------------------------------------------------------------ */

const cluster = new EventEmitter();

cluster.isPrimary = isPrimary;
cluster.isMaster = isMaster;
cluster.isWorker = isWorker;
cluster.worker = worker;
cluster.workers = workers;
cluster.settings = settings;
cluster.SCHED_NONE = SCHED_NONE;
cluster.SCHED_RR = SCHED_RR;

// schedulingPolicy must stay settable through the singleton AND visible via
// the named export, so back it with the module binding via accessors.
Object.defineProperty(cluster, "schedulingPolicy", {
  configurable: true,
  enumerable: true,
  get() {
    return schedulingPolicy;
  },
  set(v) {
    schedulingPolicy = v;
  },
});

cluster.setupPrimary = setupPrimary;
cluster.setupMaster = setupMaster;
cluster.fork = fork;
cluster.disconnect = disconnect;
cluster.Worker = Worker;

// Convenience bound emitter methods (kept from the previous shim).
export const on = cluster.on.bind(cluster);
export const once = cluster.once.bind(cluster);
export const emit = cluster.emit.bind(cluster);
export const removeListener = cluster.removeListener.bind(cluster);

export default cluster;
