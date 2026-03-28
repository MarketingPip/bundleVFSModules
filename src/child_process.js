/**
 * Browser-compatible child_process shim (pure JS)
 * Delegates exec/spawn to the parent frame via postMessage.
 * Matches Node.js child_process API surface.
 */

import { EventEmitter } from './events';
import { Readable, Writable } from './stream';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _reqCounter = 0;
function makeRequestId() {
  return `cp_${Date.now()}_${++_reqCounter}`;
}

const DEFAULT_TIMEOUT = 0;

function postToParent(type, requestId, payload, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let tid;

    const cleanup = () => {
      window.removeEventListener('message', handler);
      if (tid !== undefined) clearTimeout(tid);
    };

    const handler = (e) => {
      if (
        e.data?.requestId !== requestId ||
        e.data?.type !== 'PARENT_CHILD_EXEC_RESPONSE'
      ) return;
      cleanup();
      resolve(e.data.payload);
    };

    window.addEventListener('message', handler);

    if (timeoutMs > 0) {
      tid = setTimeout(() => {
        cleanup();
        reject(Object.assign(new Error('Process timed out'), { code: 'ETIMEDOUT' }));
      }, timeoutMs);
    }

    signal.addEventListener('abort', () => {
      cleanup();
      reject(Object.assign(new Error('Process killed'), { code: 'SIGTERM' }));
    }, { once: true });

    parent.postMessage({ type, requestId, payload }, '*');
  });
}

// ─── ChildProcess ─────────────────────────────────────────────────────────────

export class ChildProcess extends EventEmitter {
  constructor() {
    super();
    this.pid        = Math.floor(Math.random() * 32768) + 1024;
    this.connected  = false;
    this.killed     = false;
    this.exitCode   = null;
    this.signalCode = null;
    this.spawnargs  = [];
    this.spawnfile  = '';
    this.stdin      = new Writable({ write(_c, _e, cb) { cb(); } });
    this.stdout     = new Readable({ read() {} });
    this.stderr     = new Readable({ read() {} });
    this._ac        = new AbortController();
  }

  _finalise(stdout, stderr, code, sig) {
    if (stdout) this.stdout.push(stdout, 'utf8');
    if (stderr) this.stderr.push(stderr, 'utf8');
    this.stdout.push(null);
    this.stderr.push(null);
    this.exitCode   = code;
    this.signalCode = sig;
    this.emit('exit', code, sig);
    this.emit('close', code, sig);
  }

  kill(signal = 'SIGTERM') {
    if (this.killed) return false;
    this.killed = true;
    this._ac.abort();
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
    return true;
  }

  disconnect() {
    this.connected = false;
    this.emit('disconnect');
  }

  send(_msg, callback) {
    const err = new Error('IPC not supported in this environment.');
    if (callback) callback(err);
    else this.emit('error', err);
    return false;
  }

  ref()   { return this; }
  unref() { return this; }
}

// ─── exec ─────────────────────────────────────────────────────────────────────

function _exec(command, optionsOrCb, callback) {
  const cb   = typeof optionsOrCb === 'function' ? optionsOrCb : callback;
  const opts = (typeof optionsOrCb === 'object' && optionsOrCb !== null) ? optionsOrCb : {};

  const child      = new ChildProcess();
  child.spawnfile  = '/bin/sh';
  child.spawnargs  = ['/bin/sh', '-c', command];

  postToParent(
    'PARENT_EXEC_REQUEST',
    makeRequestId(),
    { command, options: opts },
    opts.timeout ?? DEFAULT_TIMEOUT,
    child._ac.signal,
  )
    .then(({ stdout, stderr, exitCode, signal }) => {
      let execError = null;

      if ((exitCode !== null && exitCode !== 0) || signal) {
        execError          = new Error(`Command failed: ${command}\n${stderr ?? ''}`);
        execError.code     = exitCode ?? undefined;
        execError.killed   = child.killed;
        execError.signal   = signal ?? null;
        execError.cmd      = command;
        child.emit('error', execError);
      }

      child._finalise(stdout ?? '', stderr ?? '', exitCode ?? null, signal ?? null);
      cb?.(execError, stdout ?? '', stderr ?? '');
    })
    .catch(err => {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      child.emit('error', wrapped);
      child._finalise('', wrapped.message, 1, null);
      cb?.(wrapped, '', wrapped.message);
    });

  return child;
}

// ─── execFile ────────────────────────────────────────────────────────────────

function _execFile(file, argsOrOptsOrCb, optsOrCb, callback) {
  let args = [], opts = {}, cb;

  if (Array.isArray(argsOrOptsOrCb)) {
    args = argsOrOptsOrCb;
    if (typeof optsOrCb === 'function') cb = optsOrCb;
    else { opts = optsOrCb ?? {}; cb = callback; }
  } else if (typeof argsOrOptsOrCb === 'function') {
    cb = argsOrOptsOrCb;
  } else if (argsOrOptsOrCb) {
    opts = argsOrOptsOrCb;
    cb = typeof optsOrCb === 'function' ? optsOrCb : callback;
  }

  return exec([file, ...args].join(' '), opts, cb);
}

// ─── spawn ────────────────────────────────────────────────────────────────────

function _spawn(command, args = [], options = {}) {
  const child      = new ChildProcess();
  child.spawnfile  = command;
  child.spawnargs  = [command, ...args];

  Promise.resolve().then(() => child.emit('spawn'));

  postToParent(
    'PARENT_SPAWN_REQUEST',
    makeRequestId(),
    { command, args, options },
    options.timeout ?? DEFAULT_TIMEOUT,
    child._ac.signal,
  )
    .then(({ stdout, stderr, exitCode, signal }) => {
      if ((exitCode !== null && exitCode !== 0) || signal) {
        const err    = new Error(`spawn ${command} failed`);
        err.code     = exitCode ?? undefined;
        err.killed   = child.killed;
        child.emit('error', err);
      }
      child._finalise(stdout ?? '', stderr ?? '', exitCode ?? null, signal ?? null);
    })
    .catch(err => {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      child.emit('error', wrapped);
      child._finalise('', wrapped.message, 1, null);
    });

  return child;
}

// ─── fork / *Sync ─────────────────────────────────────────────────────────────

export function fork() {
  throw Object.assign(
    new Error('fork is not supported in the browser child_process shim'),
    { code: 'ERR_NOT_IMPLEMENTED' },
  );
}

export function execSync(command) {
  throw Object.assign(
    new Error(`execSync is not supported in this environment: ${command}`),
    { code: 'ERR_NOT_IMPLEMENTED' },
  );
}

export function spawnSync(command) {
  throw Object.assign(
    new Error(`spawnSync is not supported in this environment: ${command}`),
    { code: 'ERR_NOT_IMPLEMENTED' },
  );
}

export function execFileSync(file) {
  throw Object.assign(
    new Error(`execFileSync is not supported in this environment: ${file}`),
    { code: 'ERR_NOT_IMPLEMENTED' },
  );
}


const originalExec = _exec;
const originalExecFile = _execFile;
const originalSpawn = _spawn;

export const exec = GlobalTracker.patchChildProcess(originalExec);
export const execFile = GlobalTracker.patchChildProcess(originalExecFile);
export const spawn = GlobalTracker.patchChildProcess(originalSpawn);

// For the sync/not-implemented versions, we can just use a standard tracker
// though they throw anyway, it keeps the counter clean.
const standardTrack = (fn) => (...args) => {
  globalThis._RUNTIME_.taskTracker.start();
  try { return fn(...args); }
  finally { GlobalTracker.stop(); }
};


export const execSync = standardTrack(execSync_orig);
export const spawnSync = standardTrack(spawnSync_orig);
export const execFileSync = standardTrack(execFileSync_orig);

// ─── Default export ───────────────────────────────────────────────────────────

export default {
  ChildProcess,
  exec,
  execFile,
  execFileSync,
  execSync,
  fork,
  spawn,
  spawnSync,
};
