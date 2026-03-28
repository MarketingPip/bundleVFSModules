// npm install events readable-stream

/*!
 * repl-web — node:repl for browsers & bundlers
 * MIT License.
 * Node.js parity: node:repl @ Node 0.1.91+
 * Dependencies: readline shim, vm shim, util shim, fs shim (optional)
 * Limitations:
 *   - History is in-memory only (no .node_repl_history persistence)
 *   - .save/.load map to VFS via fs shim; silently fail if unavailable
 *   - No inspector/debugger protocol (kContextId is a stub)
 *   - breakEvalOnSigint is accepted but inert
 *   - domain option throws (removed in Node 24, mirrored here)
 *   - No SIGINT watchdog (breakEvalOnSigint is accepted but inert)
 *   - breakEvalOnSigint is accepted but inert
 *   - No ANSI completion preview (terminal preview: false always)
 *   - domain option throws (removed in Node 24, mirrored here)
 *   - toDynamicImport() hint on static-import-in-REPL error is best-effort

*/
 
 
/**
import { Interface } from 'readline';
 * @packageDocumentation
import vm from 'vm';
 * Drop-in implementation of `node:repl` for browser / almostnode environments.
import { inspect } from 'util';
 * REPLServer extends readline.Interface and evaluates input via the vm shim.
 * Supports: top-level await, custom eval, custom writer, context isolation,
 * defineCommand, .break/.clear/.exit/.help/.save/.load/.editor,
 * _, _error magic variables, Recoverable multi-line accumulation.
 */

import { Interface } from './readline';
import vm from './vm';
import { inspect } from './util';
// ---------------------------------------------------------------------------
// Constants / Symbols
// ---------------------------------------------------------------------------

export const REPL_MODE_SLOPPY = Symbol('repl.sloppy');
export const REPL_MODE_STRICT  = Symbol('repl.strict');

const kBufferedCommand = Symbol('bufferedCommand');
const kLoading         = Symbol('loading');
const kContextId       = Symbol('contextId'); // inspector stub

// ---------------------------------------------------------------------------
// NullStream — a minimal Readable/Writable stub for headless use
// Used when no input/output streams are supplied.
// ---------------------------------------------------------------------------

class NullStream {
  constructor() {
    this._listeners = Object.create(null);
    this.isTTY      = false;
    this.readable   = true;
    this.writable   = true;
  }
  write()      { return true; }
  read()       { return null; }
  resume()     { return this; }
  pause()      { return this; }
  pipe(dest)   { return dest; }
  unpipe()     { return this; }
  setEncoding(){ return this; }
  setRawMode() { return this; }
  on(ev, fn)   { (this._listeners[ev] ||= []).push(fn); return this; }
  off(ev, fn)  {
    if (this._listeners[ev])
      this._listeners[ev] = this._listeners[ev].filter(f => f !== fn);
    return this;
  }
  once(ev, fn) {
    const wrap = (...a) => { this.off(ev, wrap); fn(...a); };
    return this.on(ev, wrap);
  }
  emit(ev, ...a) {
    for (const fn of (this._listeners[ev] || [])) fn(...a);
    return true;
  }
  removeListener(ev, fn) { return this.off(ev, fn); }
  removeAllListeners(ev) {
    if (ev) this._listeners[ev] = [];
    else    this._listeners = Object.create(null);
    return this;
  }
}

// ---------------------------------------------------------------------------
// Recoverable
// ---------------------------------------------------------------------------

/**
 * Wrap a SyntaxError to signal the REPL should prompt for more input.
 * @example
 *   if (isRecoverable(e)) return cb(new repl.Recoverable(e));
 */
export class Recoverable extends SyntaxError {
  /** @param {SyntaxError} err */
  constructor(err) { super(); this.err = err; }
}

// ---------------------------------------------------------------------------
// isRecoverableError
// ---------------------------------------------------------------------------

const RECOVERABLE_RE = /^(Unexpected end of input|Unexpected token)/;

/**
 * @param {unknown} err
 * @param {string}  [code]
 * @returns {boolean}
 */
function isRecoverableError(err, code) {
  if (!(err instanceof SyntaxError)) return false;
  if (RECOVERABLE_RE.test(err.message)) return true;
  if (code) {
    const last = code.trimEnd().slice(-1);
    if (last === '{' || last === '(' || last === '[') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// toDynamicImport — hint shown when static import is used inside the REPL
// ---------------------------------------------------------------------------

/**
 * @param {string} line
 * @returns {string}
 */
function toDynamicImport(line) {
  if (!line) return '';
  const m = line.match(/^\s*import\s+(\S+)\s+from\s+(['"`][^'"`]+['"`])/);
  if (m) return `const ${m[1]} = await import(${m[2]});`;
  const m2 = line.match(/^\s*import\s+(['"`][^'"`]+['"`])/);
  if (m2) return `await import(${m2[1]});`;
  return `await import(/* ${line.trim()} */);`;
}

// ---------------------------------------------------------------------------
// processTopLevelAwait — wraps code in async IIFE when await is present
// ---------------------------------------------------------------------------

const HAS_AWAIT = /(?:^|[^.\w$])await[\s(]/;

/**
 * @param {string} code
 * @returns {string|null} wrapped code, or null if no top-level await found
 */
function processTopLevelAwait(code) {
  if (!HAS_AWAIT.test(code)) return null;
  try { new Function(`return (async () => {\n${code}\n})()`); } // eslint-disable-line no-new-func
  catch (e) { if (e instanceof SyntaxError) return null; }
  return `(async () => {\n${code}\n})()`;
}

// ---------------------------------------------------------------------------
// Default writer
// ---------------------------------------------------------------------------

const writer = (obj) => inspect(obj, writer.options);
writer.options = { ...inspect.defaultOptions, showProxy: true, colors: false };

// ---------------------------------------------------------------------------
// REPLServer
// ---------------------------------------------------------------------------

/**
 * Read-Eval-Print-Loop server, extending readline.Interface.
 *
 * @extends {Interface}
 *
 * @example
 * import { start } from 'repl';
 * const r = start('> ');
 * r.context.myVar = 42;
 */
export class REPLServer extends Interface {
  /**
   * @param {string|object} prompt
   * @param {object}   [stream]
   * @param {Function} [eval_]
   * @param {boolean}  [useGlobal]
   * @param {boolean}  [ignoreUndefined]
   * @param {symbol}   [replMode]
   */
  constructor(prompt, stream, eval_, useGlobal, ignoreUndefined, replMode) {
    // ---- Normalise arguments ---------------------------------------------
    let options;
    if (prompt !== null && typeof prompt === 'object') {
      options         = { ...prompt };
      stream          = options.stream || options.socket;
      eval_           = options.eval;
      useGlobal       = options.useGlobal;
      ignoreUndefined = options.ignoreUndefined;
      prompt          = options.prompt;
      replMode        = options.replMode;
    } else {
      options = {};
    }

    if (options.domain !== undefined) {
      throw new TypeError(
        'options.domain is no longer supported (removed in Node 24)');
    }

    // ---- Resolve input / output streams ----------------------------------
    // Priority: explicit options.input/output → stream.stdin/stdout → NullStream
    let input  = options.input;
    let output = options.output;

    if (!input || !output) {
      const s = stream
        || (typeof process !== 'undefined' && process && process.stdin ? process : null);
      input  = input  || (s && (s.stdin  || s.input))  || new NullStream();
      output = output || (s && (s.stdout || s.output)) || new NullStream();
    }

    const terminal = options.terminal !== undefined
      ? !!options.terminal
      : !!(output.isTTY);

    // ---- Super (readline.Interface) --------------------------------------
    super({
      input,
      output,
      terminal,
      prompt:              typeof prompt === 'string' ? prompt : '> ',
      historySize:         options.historySize ?? 30,
      removeHistoryDuplicates: true,
    });

    // ---- Store resolved streams for our own _write helper ----------------
    this._output = output;

    // ---- Public properties -----------------------------------------------
    this.useColors       = !!(options.useColors ?? terminal);
    this.useGlobal       = !!useGlobal;
    this.ignoreUndefined = !!ignoreUndefined;
    this.replMode        = replMode || REPL_MODE_SLOPPY;
    this.writer          = options.writer || writer;
    this.editorMode      = false;
    this.commands        = Object.create(null);

    this.underscoreAssigned    = false;
    this.underscoreErrAssigned = false;
    this.last                  = undefined;
    this.lastError             = undefined;
    this.lines                 = [];
    this.lines.level           = [];
    this.breakEvalOnSigint     = !!options.breakEvalOnSigint; // accepted, inert
    this[kContextId]           = undefined;
    this._initialPrompt        = typeof prompt === 'string' ? prompt : '> ';

    // ---- Writer colour ---------------------------------------------------
    if (this.writer === writer) writer.options.colors = this.useColors;

    // ---- Internal state --------------------------------------------------
    this[kBufferedCommand] = '';
    this[kLoading]         = false;

    // ---- Eval ------------------------------------------------------------
    this.eval = typeof eval_ === 'function'
      ? eval_
      : this._defaultEval.bind(this);

    // ---- Context ---------------------------------------------------------
    this.resetContext();

    // ---- Default commands ------------------------------------------------
    this._defineDefaultCommands();

    // ---- Wire readline events --------------------------------------------
    this.on('line',  (cmd) => this._onLine(cmd));
    this.on('close', ()    => this.emit('exit'));

    // ---- Initial prompt --------------------------------------------------
    this.displayPrompt();
  }

  // -------------------------------------------------------------------------
  // Context
  // -------------------------------------------------------------------------

  createContext() {
    let context;

    if (this.useGlobal) {
      context = globalThis;
    } else {
      context = vm.createContext(Object.create(null));
      // Seed with standard browser / Node globals
      const GLOBALS = [
        'Object','Function','Array','Number','Boolean','String','Symbol',
        'BigInt','Math','Date','RegExp','Error','EvalError','RangeError',
        'ReferenceError','SyntaxError','TypeError','URIError','JSON',
        'Promise','Proxy','Reflect','Map','Set','WeakMap','WeakRef','WeakSet',
        'ArrayBuffer','DataView','Int8Array','Uint8Array','Uint8ClampedArray',
        'Int16Array','Uint16Array','Int32Array','Uint32Array',
        'Float32Array','Float64Array','BigInt64Array','BigUint64Array',
        'Atomics','SharedArrayBuffer','Intl','WebAssembly',
        'console','crypto',
        'setTimeout','clearTimeout','setInterval','clearInterval','queueMicrotask',
        'fetch','URL','URLSearchParams','Headers','Request','Response','Blob',
        'TextEncoder','TextDecoder',
        'ReadableStream','WritableStream','TransformStream',
        'AbortController','AbortSignal',
        'isFinite','isNaN','parseFloat','parseInt',
        'decodeURI','decodeURIComponent','encodeURI','encodeURIComponent',
        'undefined','Infinity','NaN',
      ];
      for (const name of GLOBALS) {
        if (name in globalThis) {
          try { context[name] = globalThis[name]; } catch (_) {}
        }
      }
      context.global = context;
    }

    // _ and _error magic
    Object.defineProperty(context, '_', {
      configurable: true,
      get: () => this.last,
      set: (v) => {
        this.last = v;
        if (!this.underscoreAssigned) {
          this.underscoreAssigned = true;
          this._write('Expression assignment to _ now disabled.\n');
        }
      },
    });
    Object.defineProperty(context, '_error', {
      configurable: true,
      get: () => this.lastError,
      set: (v) => {
        this.lastError = v;
        if (!this.underscoreErrAssigned) {
          this.underscoreErrAssigned = true;
          this._write('Expression assignment to _error now disabled.\n');
        }
      },
    });

    this.emit('reset', context);
    return context;
  }

  resetContext() {
    this.context               = this.createContext();
    this.underscoreAssigned    = false;
    this.underscoreErrAssigned = false;
    this.lines                 = [];
    this.lines.level           = [];
  }

  // -------------------------------------------------------------------------
  // Default eval
  // -------------------------------------------------------------------------

  async _defaultEval(code, context, file, cb) {
    const input = code;
    let err     = null;
    let result;

    // Wrap bare object literals: { a: 1 } → ({ a: 1 })
    let wrappedCmd = false;
    if (/^\s*\{/.test(code) && /\}\s*\n$/.test(code)) {
      const candidate = `(${code.trim()})`;
      try { new Function(candidate); code = candidate; wrappedCmd = true; } // eslint-disable-line no-new-func
      catch (_) { code = input; wrappedCmd = false; }
    }

    // Strict mode prefix
    if (this.replMode === REPL_MODE_STRICT && code.trim() !== '') {
      code = `'use strict'; void 0;\n${code}`;
    }

    // Empty line
    if (code.trim() === '') return cb(null);

    // Top-level await
    let awaitPromise = false;
    const wrapped = processTopLevelAwait(code);
    if (wrapped) { code = wrapped; wrappedCmd = true; awaitPromise = true; }

    // Execute via vm shim
    try {
      const runFn = this.useGlobal
        ? (c) => vm.runInThisContext(c, { filename: file })
        : (c) => vm.runInContext(c, this.context, { filename: file });

      const raw = runFn(code);

      if (awaitPromise) {
        try {
          result = await raw;
          if (result && typeof result.then === 'function') result = await result;
        } catch (e) { err = e; }
      } else {
        // SyncPromise — .value is populated synchronously for pure-sync code
        result = (raw && typeof raw === 'object' && 'value' in raw)
          ? raw.value : raw;
        if (raw && raw.syncError) err = raw.syncError;
      }
    } catch (e) {
      err = e;
      // Retry without wrapper on SyntaxError
      if (wrappedCmd && e instanceof SyntaxError) {
        code = input;
        try {
          const r2 = this.useGlobal
            ? vm.runInThisContext(code, { filename: file })
            : vm.runInContext(code, this.context, { filename: file });
          err    = null;
          result = (r2 && typeof r2 === 'object' && 'value' in r2) ? r2.value : r2;
          if (r2 && r2.syncError) err = r2.syncError;
        } catch (e2) { err = e2; }
      }
    }

    if (err) {
      // Static import hint
      if (err instanceof SyntaxError &&
          err.message.includes('Cannot use import statement')) {
        const lastLine = this.lines[this.lines.length - 1] || '';
        err.message =
          'Cannot use import statement inside the Node.js REPL, ' +
          'alternatively use dynamic import: ' + toDynamicImport(lastLine);
      }
      return cb(isRecoverableError(err, input) ? new Recoverable(err) : err);
    }

    cb(null, result);
  }

  // -------------------------------------------------------------------------
  // Line handler
  // -------------------------------------------------------------------------

  _onLine(cmd) {
    cmd = cmd || '';

    if (this.editorMode) {
      this[kBufferedCommand] += cmd + '\n';
      this._memoryUpdate(cmd);
      return;
    }

    const trimmed = cmd.trim();

    // Dot-commands
    if (trimmed &&
        trimmed[0] === '.' &&
        trimmed[1] !== '.' &&
        isNaN(parseFloat(trimmed))) {
      const m = trimmed.match(/^\.([^\s]+)\s*(.*)?$/);
      if (m) {
        const [, keyword, rest = ''] = m;
        if (this._parseREPLKeyword(keyword, rest)) return;
        if (!this[kBufferedCommand]) {
          this._write('Invalid REPL keyword\n');
          this._finish(null, undefined, cmd);
          return;
        }
      }
    }

    const evalCmd = this[kBufferedCommand] + cmd + '\n';
    this._memoryUpdate(cmd);

    this.eval(evalCmd, this.context, 'repl', (e, ret) => {
      this._finish(e, ret, cmd);
    });
  }

  _finish(e, ret, cmd = '') {
    // npm hint
    if (e && !this[kBufferedCommand] &&
        typeof cmd === 'string' && cmd.trimStart().startsWith('npm ') &&
        !(e instanceof Recoverable)) {
      this._write(
        'npm should be run outside of the Node.js REPL, in your normal shell.\n' +
        '(Press Ctrl+D to exit.)\n');
      this.displayPrompt();
      return;
    }

    // Recoverable — accumulate and re-prompt
    if (e instanceof Recoverable) {
      this[kBufferedCommand] += (cmd || '') + '\n';
      this.displayPrompt();
      return;
    }

    if (e) {
      this._handleError(e.err || e);
      return;
    }

    this.clearBufferedCommand();

    if (arguments.length >= 2 &&
        (!this.ignoreUndefined || ret !== undefined)) {
      if (!this.underscoreAssigned) this.last = ret;
      this._write(this.writer(ret) + '\n');
    }

    if (!this.closed) this.displayPrompt();
  }

  // -------------------------------------------------------------------------
  // Error display
  // -------------------------------------------------------------------------

  _handleError(e) {
    if (!this.underscoreErrAssigned) this.lastError = e;

    let errStack = (typeof e === 'object' && e !== null && e.stack)
      ? this.writer(e)
      : this.writer(e);

    if (errStack[0] === '[' && errStack[errStack.length - 1] === ']')
      errStack = errStack.slice(1, -1);

    const lines = errStack.split(/(?<=\n)/);
    let matched = false, prefixed = '';
    for (const line of lines) {
      if (!matched && /^\[?([A-Z][a-z0-9_]*)*Error/.test(line)) {
        prefixed += `Uncaught ${line}`; matched = true;
      } else { prefixed += line; }
    }
    if (!matched) prefixed = `Uncaught:\n${errStack}`;
    if (!prefixed.endsWith('\n')) prefixed += '\n';

    this._write(prefixed);
    this.clearBufferedCommand();
    this.lines.level = [];
    if (!this.closed) this.displayPrompt();
  }

  // -------------------------------------------------------------------------
  // Command dispatch
  // -------------------------------------------------------------------------

  _parseREPLKeyword(keyword, rest) {
    const cmd = this.commands[keyword];
    if (cmd) { cmd.action.call(this, rest); return true; }
    return false;
  }

  _defineDefaultCommands() {
    this.defineCommand('break', {
      help: 'Sometimes you get stuck, this gets you out',
      action() { this.clearBufferedCommand(); this.displayPrompt(); },
    });

    this.defineCommand('clear', {
      help: this.useGlobal ? 'Alias for .break' : 'Break, and also clear the local context',
      action() {
        this.clearBufferedCommand();
        if (!this.useGlobal) { this._write('Clearing context...\n'); this.resetContext(); }
        this.displayPrompt();
      },
    });

    this.defineCommand('exit', {
      help: 'Exit the REPL',
      action() { this.close(); },
    });

    this.defineCommand('help', {
      help: 'Print this help message',
      action() {
        const names = Object.keys(this.commands).sort();
        const max   = Math.max(...names.map(n => n.length));
        for (const name of names) {
          const c   = this.commands[name];
          const pad = ' '.repeat(max - name.length + 3);
          this._write(`.${name}${c.help ? pad + c.help : ''}\n`);
        }
        this._write('\nPress Ctrl+C to abort current expression, Ctrl+D to exit the REPL\n');
        this.displayPrompt();
      },
    });

    this.defineCommand('save', {
      help: 'Save all evaluated commands in this REPL session to a file',
      action(file) {
        if (!file) { this._write('Missing filename\n'); this.displayPrompt(); return; }
        try {
          _tryRequireFs().writeFileSync(file, this.lines.join('\n'));
          this._write(`Session saved to: ${file}\n`);
        } catch (_) { this._write(`Failed to save: ${file}\n`); }
        this.displayPrompt();
      },
    });

    this.defineCommand('load', {
      help: 'Load JS from a file into the REPL session',
      action(file) {
        if (!file) { this._write('Missing filename\n'); this.displayPrompt(); return; }
        try {
          const data = _tryRequireFs().readFileSync(file, 'utf8');
          this._turnOnEditorMode();
          this[kLoading] = true;
          for (const line of data.split('\n')) this.write(line + '\n');
          this[kLoading] = false;
          this._turnOffEditorMode();
          this.write('\n');
        } catch (_) { this._write(`Failed to load: ${file}\n`); }
        this.displayPrompt();
      },
    });

    this.defineCommand('editor', {
      help: 'Enter editor mode',
      action() {
        this._turnOnEditorMode();
        this._write('// Entering editor mode (Ctrl+D to finish, Ctrl+C to cancel)\n');
      },
    });
  }

  // -------------------------------------------------------------------------
  // Editor mode
  // -------------------------------------------------------------------------

  _turnOnEditorMode() {
    this.editorMode = true;
    Interface.prototype.setPrompt.call(this, '');
  }

  _turnOffEditorMode() {
    this.editorMode = false;
    this.setPrompt(this._initialPrompt);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  displayPrompt(preserveCursor) {
    const p = this[kBufferedCommand].length ? '|' : this._initialPrompt;
    Interface.prototype.setPrompt.call(this, p);
    this.prompt(preserveCursor);
  }

  setPrompt(prompt) {
    this._initialPrompt = prompt;
    Interface.prototype.setPrompt.call(this, prompt);
  }

  clearBufferedCommand() {
    this[kBufferedCommand] = '';
  }

  defineCommand(keyword, cmd) {
    if (typeof cmd === 'function') cmd = { action: cmd };
    if (typeof cmd.action !== 'function')
      throw new TypeError('cmd.action must be a function');
    this.commands[keyword] = cmd;
  }

  setupHistory(historyConfig, cb) {
    const callback = (typeof historyConfig === 'object' && historyConfig !== null)
      ? (historyConfig.onHistoryFileLoaded || cb)
      : cb;
    if (typeof callback === 'function')
      Promise.resolve().then(() => callback(null, this));
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Write to output, bypassing readline's prompt redraw.
   * Uses the stored _output reference so it works even if readline
   * hasn't wired everything yet.
   * @param {string} str
   */
  _write(str) {
    // Prefer the output stream readline was constructed with
    const out = this._output || (this.output);
    if (out && typeof out.write === 'function') out.write(str);
  }

  _memoryUpdate(cmd) {
    if (cmd) {
      const indent = '  '.repeat(Math.max(0, this.lines.level.length - 1));
      this.lines.push(indent + cmd);
    } else {
      this.lines.push('');
    }
    if (!cmd) { this.lines.level = []; return; }

    let depth = 0;
    for (const ch of cmd) {
      if (ch === '{' || ch === '(') depth++;
      else if (ch === '}' || ch === ')') depth--;
    }
    if (depth > 0)
      this.lines.level.push({ line: this.lines.length - 1, depth });
    else if (depth < 0 && this.lines.level.length)
      this.lines.level.pop();
  }
}

// ---------------------------------------------------------------------------
// Lazy fs helper — maps to VFS fs shim if available
// ---------------------------------------------------------------------------

function _tryRequireFs() {
  if (typeof require === 'function') return require('fs');
  throw new Error('fs not available');
}

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

/**
 * Creates and starts a REPLServer.
 *
 * @param {string|object} [options='> ']
 * @returns {REPLServer}
 *
 * @example
 * import { start } from 'repl';
 * const r = start({ prompt: '> ', useColors: true });
 */
export function start(options = '> ') {
  return new REPLServer(options);
}

// ---------------------------------------------------------------------------
// Misc exports
// ---------------------------------------------------------------------------

/** @deprecated Use module.builtinModules */
export const builtinModules = [
  'assert','buffer','child_process','cluster','console','constants','crypto',
  'dgram','dns','domain','events','fs','http','https','module','net','os',
  'path','perf_hooks','process','punycode','querystring','readline','repl',
  'stream','string_decoder','sys','timers','tls','tty','url','util','v8','vm',
  'worker_threads','zlib',
];

/**
 * @param {string} src
 * @returns {boolean}
 */
export function isValidSyntax(src) {
  try { new Function(src); return true; } // eslint-disable-line no-new-func
  catch (_) { return false; }
}

export default {
  start,
  writer,
  REPLServer,
  Recoverable,
  REPL_MODE_SLOPPY,
  REPL_MODE_STRICT,
  builtinModules,
  isValidSyntax,
};

// ---------------------------------------------------------------------------
// --- Usage ---
// ---------------------------------------------------------------------------
//
// // 1. No streams needed — works headless (NullStream) or with xterm.js
// import { start } from 'repl';
// const r = start({ prompt: '> ', input: xtermInput, output: xtermOutput });
// r.context.hello = 'world';
//
// // 2. Zero-arg start — uses NullStream, useful for programmatic driving
// const r = start();
// r.eval('1 + 1', r.context, 'test', (err, val) => console.log(val)); // 2
//
// // 3. Custom dot-command
// r.defineCommand('sayhi', {
//   help: 'Say hello',
//   action() {
//     this._write('Hi there 👋\n');
//     this.displayPrompt();
//   },
// });
//
// // 4. Top-level await (automatic)
// // User types: const res = await fetch('https://api.example.com/data')
// // Works — detected and wrapped in async IIFE transparently.
//
// // 5. reset event — re-seed context after .clear
// r.on('reset', (ctx) => { ctx.myLib = myLib; });
