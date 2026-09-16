/**
 * Browser-compatible child_process shim (pure JS)
 *
 * Delegates exec/spawn to the parent frame via postMessage.
 * Provides a Node.js-compatible API surface where possible.
 *
 * Important:
 * - A child can only be finalized once.
 * - stdout/stderr are ended exactly once.
 * - kill() and parent responses cannot finalize the same child twice.
 * - Output arriving after finalization is ignored.
 */

import { EventEmitter } from './events';
import { Readable, Writable } from './stream';

// ─── Helpers ────────────────────────────────────────────────────────────────

let _reqCounter = 0;

function makeRequestId() {
  return `cp_${Date.now()}_${++_reqCounter}`;
}

const DEFAULT_TIMEOUT = 0;

function getRuntime() {
  return globalThis._RUNTIME_ || null;
}

function getTaskTracker() {
  return getRuntime()?.taskTracker || null;
}

/**
 * Send a child-process request to the parent frame.
 *
 * The AbortSignal is optional. This is important because a kill() can happen
 * before the parent responds.
 */
function postToParent(
  type,
  requestId,
  payload,
  timeoutMs = DEFAULT_TIMEOUT,
  signal = null,
) {
  return new Promise((resolve, reject) => {
    let tid;
    let settled = false;

    const cleanup = () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('message', handler);
      }

      if (tid !== undefined) {
        clearTimeout(tid);
        tid = undefined;
      }

      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const handler = (event) => {
      const data = event?.data;

      if (
        data?.requestId !== requestId ||
        data?.type !== 'PARENT_CHILD_EXEC_RESPONSE'
      ) {
        return;
      }

      finishResolve(data.payload || {});
    };

    const onAbort = () => {
      finishReject(
        Object.assign(
          new Error('Process killed'),
          {
            code: 'SIGTERM',
            signal: 'SIGTERM',
            killed: true,
          },
        ),
      );
    };

    if (typeof window === 'undefined') {
      finishReject(
        Object.assign(
          new Error('child_process requires a window environment'),
          { code: 'ERR_NO_WINDOW' },
        ),
      );
      return;
    }

    window.addEventListener('message', handler);

    if (timeoutMs > 0) {
      tid = setTimeout(() => {
        finishReject(
          Object.assign(
            new Error('Process timed out'),
            {
              code: 'ETIMEDOUT',
              signal: 'SIGTERM',
            },
          ),
        );
      }, Math.max(0, Number(timeoutMs) || 0));
    }

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });
    }

    const target = globalThis.parent;

    if (!target || typeof target.postMessage !== 'function') {
      finishReject(
        Object.assign(
          new Error('Parent frame messaging is unavailable'),
          { code: 'ERR_NO_PARENT' },
        ),
      );
      return;
    }

    target.postMessage(
      {
        type,
        requestId,
        payload,
      },
      '*',
    );
  });
}

// ─── ChildProcess ───────────────────────────────────────────────────────────

export class ChildProcess extends EventEmitter {
  constructor() {
    super();

    this.pid = Math.floor(Math.random() * 32768) + 1024;

    this.connected = false;
    this.killed = false;

    this.exitCode = null;
    this.signalCode = null;

    this.spawnargs = [];
    this.spawnfile = '';

    this.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    this.stdout = new Readable({
      read() {},
    });

    this.stderr = new Readable({
      read() {},
    });

    this._ac = new AbortController();

    // ── Lifecycle state ──────────────────────────────────────────────────

    this._finalised = false;
    this._stdoutEnded = false;
    this._stderrEnded = false;
    this._exitEmitted = false;
    this._closeEmitted = false;
  }

  // ── Output handling ─────────────────────────────────────────────────────

  _pushStdout(data) {
    if (this._finalised || this._stdoutEnded) {
      return false;
    }

    if (data === undefined || data === null || data === '') {
      return true;
    }

    try {
      this.stdout.push(data, 'utf8');
      return true;
    } catch (err) {
      // A defensive guard for custom Readable implementations.
      if (/after EOF/i.test(String(err?.message))) {
        this._stdoutEnded = true;
        return false;
      }

      throw err;
    }
  }

  _pushStderr(data) {
    if (this._finalised || this._stderrEnded) {
      return false;
    }

    if (data === undefined || data === null || data === '') {
      return true;
    }

    try {
      this.stderr.push(data, 'utf8');
      return true;
    } catch (err) {
      if (/after EOF/i.test(String(err?.message))) {
        this._stderrEnded = true;
        return false;
      }

      throw err;
    }
  }

  _endStdout() {
    if (this._stdoutEnded) {
      return;
    }

    this._stdoutEnded = true;

    try {
      this.stdout.push(null);
    } catch (err) {
      // Custom stream implementations may throw if already ended.
      if (!/after EOF/i.test(String(err?.message))) {
        throw err;
      }
    }
  }

  _endStderr() {
    if (this._stderrEnded) {
      return;
    }

    this._stderrEnded = true;

    try {
      this.stderr.push(null);
    } catch (err) {
      if (!/after EOF/i.test(String(err?.message))) {
        throw err;
      }
    }
  }

  _endStreams() {
    this._endStdout();
    this._endStderr();
  }

  // ── Process lifecycle ───────────────────────────────────────────────────

  _finalise(stdout = '', stderr = '', code = null, sig = null) {
    /*
     * This is the ONLY method allowed to finish a child.
     *
     * kill(), timeout, parent response, and errors can all converge here.
     */
    if (this._finalised) {
      return false;
    }

    /*
     * Do NOT set _finalised until after the final output is delivered.
     *
     * _pushStdout/_pushStderr intentionally ignore output when _finalised
     * is true, so the final output is pushed directly here.
     */
    if (!this._stdoutEnded && stdout) {
      try {
        this.stdout.push(stdout, 'utf8');
      } catch (err) {
        if (!/after EOF/i.test(String(err?.message))) {
          throw err;
        }
        this._stdoutEnded = true;
      }
    }

    if (!this._stderrEnded && stderr) {
      try {
        this.stderr.push(stderr, 'utf8');
      } catch (err) {
        if (!/after EOF/i.test(String(err?.message))) {
          throw err;
        }
        this._stderrEnded = true;
      }
    }

    this._finalised = true;

    this.exitCode = code;
    this.signalCode = sig;

    /*
     * Abort any pending parent request.
     *
     * The promise may already be settled; AbortController is safe here.
     */
    if (!this._ac.signal.aborted) {
      this._ac.abort();
    }

    this._endStreams();

    if (!this._exitEmitted) {
      this._exitEmitted = true;
      this.emit('exit', code, sig);
    }

    if (!this._closeEmitted) {
      this._closeEmitted = true;
      this.emit('close', code, sig);
    }

    return true;
  }

  kill(signal = 'SIGTERM') {
    /*
     * A child that has already exited cannot be killed again.
     */
    if (this.killed || this._finalised) {
      return false;
    }

    this.killed = true;

    /*
     * _finalise() owns exit/close and stream EOF.
     * Do NOT emit exit/close directly here.
     */
    this._finalise('', '', null, signal);

    return true;
  }

  disconnect() {
    if (!this.connected) {
      return;
    }

    this.connected = false;
    this.emit('disconnect');
  }

  send(_message, callback) {
    const err = Object.assign(
      new Error('IPC not supported in this environment.'),
      { code: 'ERR_IPC_CHANNEL_CLOSED' },
    );

    if (typeof callback === 'function') {
      callback(err);
    } else {
      this.emit('error', err);
    }

    return false;
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }
}

// ─── exec ───────────────────────────────────────────────────────────────────

function _exec(command, optionsOrCallback, callback) {
  const cb =
    typeof optionsOrCallback === 'function'
      ? optionsOrCallback
      : callback;

  const opts =
    optionsOrCallback &&
    typeof optionsOrCallback === 'object'
      ? optionsOrCallback
      : {};

  const child = new ChildProcess();

  child.spawnfile = '/bin/sh';
  child.spawnargs = ['/bin/sh', '-c', command];

  const requestId = makeRequestId();

  postToParent(
    'PARENT_EXEC_REQUEST',
    requestId,
    {
      command,
      options: opts,
    },
    opts.timeout ?? DEFAULT_TIMEOUT,
    child._ac.signal,
  )
    .then((result = {}) => {
      /*
       * kill() or timeout may have already finalized the child.
       */
      if (child._finalised) {
        return;
      }

      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      const exitCode = result.exitCode ?? 0;
      const signal = result.signal ?? null;

      let execError = null;

      if (
        (exitCode !== null && exitCode !== 0) ||
        signal
      ) {
        execError = new Error(
          `Command failed: ${command}\n${stderr}`,
        );

        execError.code = exitCode ?? undefined;
        execError.killed = child.killed;
        execError.signal = signal;
        execError.cmd = command;

        child.emit('error', execError);
      }

      child._finalise(
        stdout,
        stderr,
        exitCode,
        signal,
      );

      cb?.(
        execError,
        stdout,
        stderr,
      );
    })
    .catch((err) => {
      /*
       * Abort caused by kill() is expected.
       * kill() has already finalized the child.
       */
      if (child._finalised) {
        return;
      }

      const wrapped =
        err instanceof Error
          ? err
          : new Error(String(err));

      if (wrapped.code === 'ETIMEDOUT') {
        child.killed = true;
      }

      /*
       * Don't emit error twice if this is an expected abort.
       */
      child.emit('error', wrapped);

      child._finalise(
        '',
        wrapped.message,
        wrapped.code === 'ETIMEDOUT' ? null : 1,
        wrapped.signal ?? null,
      );

      cb?.(
        wrapped,
        '',
        wrapped.message,
      );
    });

  return child;
}

// ─── execFile ───────────────────────────────────────────────────────────────

function _execFile(
  file,
  argsOrOptionsOrCallback,
  optionsOrCallback,
  callback,
) {
  let args = [];
  let opts = {};
  let cb;

  if (Array.isArray(argsOrOptionsOrCallback)) {
    args = argsOrOptionsOrCallback;

    if (typeof optionsOrCallback === 'function') {
      cb = optionsOrCallback;
    } else {
      opts = optionsOrCallback ?? {};
      cb = callback;
    }
  } else if (
    typeof argsOrOptionsOrCallback === 'function'
  ) {
    cb = argsOrOptionsOrCallback;
  } else if (
    argsOrOptionsOrCallback &&
    typeof argsOrOptionsOrCallback === 'object'
  ) {
    opts = argsOrOptionsOrCallback;

    cb =
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : callback;
  }

  /*
   * Preserve arguments as safely as possible.
   *
   * This shim ultimately delegates to a shell/parent runtime, so quote
   * arguments rather than simply joining them.
   */
  const quoteArg = (value) => {
    const string = String(value);

    if (string === '') {
      return "''";
    }

    return `'${string.replace(/'/g, `'\\''`)}'`;
  };

  const command = [
    file,
    ...args,
  ]
    .map(quoteArg)
    .join(' ');

  return _exec(command, opts, cb);
}

// ─── spawn ─────────────────────────────────────────────────────────────────

function _spawn(
  command,
  args = [],
  options = {},
) {
  const child = new ChildProcess();

  child.spawnfile = command;
  child.spawnargs = [command, ...args];

  /*
   * Node emits 'spawn' asynchronously after the child has been created.
   */
  Promise.resolve().then(() => {
    if (!child._finalised) {
      child.emit('spawn');
    }
  });

  const requestId = makeRequestId();

  postToParent(
    'PARENT_SPAWN_REQUEST',
    requestId,
    {
      command,
      args,
      options,
    },
    options.timeout ?? DEFAULT_TIMEOUT,
    child._ac.signal,
  )
    .then((result = {}) => {
      /*
       * kill() may have won the race.
       */
      if (child._finalised) {
        return;
      }

      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      const exitCode = result.exitCode ?? 0;
      const signal = result.signal ?? null;

      if (
        (exitCode !== null && exitCode !== 0) ||
        signal
      ) {
        const err = new Error(
          `spawn ${command} failed`,
        );

        err.code = exitCode ?? undefined;
        err.killed = child.killed;
        err.signal = signal;

        child.emit('error', err);
      }

      child._finalise(
        stdout,
        stderr,
        exitCode,
        signal,
      );
    })
    .catch((err) => {
      /*
       * If kill() already finalized the child, there is nothing left
       * for the rejected request to do.
       */
      if (child._finalised) {
        return;
      }

      const wrapped =
        err instanceof Error
          ? err
          : new Error(String(err));

      if (wrapped.code === 'ETIMEDOUT') {
        child.killed = true;
      }

      child.emit('error', wrapped);

      child._finalise(
        '',
        wrapped.message,
        wrapped.code === 'ETIMEDOUT' ? null : 1,
        wrapped.signal ?? null,
      );
    });

  return child;
}

// ─── fork / *Sync ───────────────────────────────────────────────────────────

export function fork() {
  throw Object.assign(
    new Error(
      'fork is not supported in the browser child_process shim',
    ),
    {
      code: 'ERR_NOT_IMPLEMENTED',
    },
  );
}

export function execSync(command) {
  throw Object.assign(
    new Error(
      `execSync is not supported in this environment: ${command}`,
    ),
    {
      code: 'ERR_NOT_IMPLEMENTED',
    },
  );
}

export function spawnSync(command) {
  throw Object.assign(
    new Error(
      `spawnSync is not supported in this environment: ${command}`,
    ),
    {
      code: 'ERR_NOT_IMPLEMENTED',
    },
  );
}

export function execFileSync(file) {
  throw Object.assign(
    new Error(
      `execFileSync is not supported in this environment: ${file}`,
    ),
    {
      code: 'ERR_NOT_IMPLEMENTED',
    },
  );
}

// ─── Task tracker integration ───────────────────────────────────────────────

const originalExec = _exec;
const originalExecFile = _execFile;
const originalSpawn = _spawn;

function patchChildProcess(fn) {
  const tracker = getTaskTracker();

  if (
    tracker &&
    typeof tracker.patchChildProcess === 'function'
  ) {
    return tracker.patchChildProcess(fn);
  }

  return fn;
}

export const exec = patchChildProcess(originalExec);
export const execFile = patchChildProcess(originalExecFile);
export const spawn = patchChildProcess(originalSpawn);

// ─── Standard tracker ───────────────────────────────────────────────────────

const standardTrack = (fn) => (...args) => {
  const tracker = getTaskTracker();

  if (!tracker) {
    return fn(...args);
  }

  tracker.start();

  try {
    return fn(...args);
  } finally {
    tracker.stop();
  }
};

/*
 * Sync APIs intentionally remain unsupported.
 *
 * If they are enabled later:
 *
 * export const execSyncTracked = standardTrack(execSync);
 * export const spawnSyncTracked = standardTrack(spawnSync);
 * export const execFileSyncTracked = standardTrack(execFileSync);
 */

// ─── Default export ─────────────────────────────────────────────────────────

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
