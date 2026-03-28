// npm install events readable-stream

/*!
 * repl-web — node:repl for browsers & bundlers
 * MIT License.
 * Node.js parity: node:repl @ Node 0.1.91+
 * Dependencies: events (EventEmitter), readline shim, vm shim, fs shim (optional)
 * Limitations:
 *   - History is in-memory only (no .node_repl_history persistence)
 *   - .save/.load map to VFS via fs shim; silently fail if unavailable
 *   - No inspector/debugger protocol (kContextId is a stub)
 *   - No SIGINT watchdog (breakEvalOnSigint is accepted but inert)
 *   - No ANSI completion preview (terminal preview: false always)
 *   - domain option throws (removed in Node 24, mirrored here)
 *   - toDynamicImport() hint on static-import-in-REPL error is best-effort
 */

/**
 * @packageDocumentation
 * Drop-in implementation of `node:repl` for browser / almostnode environments.
 * REPLServer extends readline.Interface and evaluates input via the vm shim.
 * Supports: top-level await, custom eval, custom writer, context isolation,
 * defineCommand, .break/.clear/.exit/.help/.save/.load/.editor,
 * _, _error magic variables, Recoverable multi-line accumulation.
 */

import { Interface } from './readline-polyfill.js';
import vm from './vm';
import { inspect } from './util';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REPL_MODE_SLOPPY = Symbol('repl.sloppy');
export const REPL_MODE_STRICT = Symbol('repl.strict');

// Internal symbols — match Node's internal shape so duck-typed code works
const kBufferedCommand = Symbol('bufferedCommand');
const kLoading         = Symbol('loading');
const kContextId       = Symbol('contextId');     // stub — no inspector

// ---------------------------------------------------------------------------
// Recoverable — signals that a SyntaxError might complete with more input
// ---------------------------------------------------------------------------

/**
 * Wraps a SyntaxError to signal the REPL should prompt for more input
 * rather than printing an error.
 *
 * @example
 * function myEval(code, ctx, file, cb) {
 *   try { result = eval(code); } catch (e) {
 *     if (isRecoverable(e)) return cb(new repl.Recoverable(e));
 *     return cb(e);
 *   }
 *   cb(null, result);
 * }
 */
export class Recoverable extends SyntaxError {
  /** @param {SyntaxError} err */
  constructor(err) {
    super();
    this.err = err;
  }
}

// ---------------------------------------------------------------------------
// isRecoverableError
// Heuristic identical to Node's: SyntaxError whose message suggests the
// expression is incomplete (unexpected end / unexpected token at EOF).
// ---------------------------------------------------------------------------

const RECOVERABLE_RE = /^(Unexpected end of input|Unexpected token)/;

/**
 * @param {unknown} err
 * @param {string} [code]
 * @returns {boolean}
 */
function isRecoverableError(err, code) {
  if (!(err instanceof SyntaxError)) return false;
  if (RECOVERABLE_RE.test(err.message)) return true;
  // Additional check: if last non-whitespace char opens a bracket, likely incomplete
  if (code) {
    const trimmed = code.trimEnd();
    const last = trimmed[trimmed.length - 1];
    if (last === '{' || last === '(' || last === '[') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// toDynamicImport — best-effort hint when static import is used in REPL
// ---------------------------------------------------------------------------

/**
 * Rewrites a static import line into a dynamic import expression hint.
 * Used only in the error message shown to the user.
 * @param {string} line
 * @returns {string}
 */
function toDynamicImport(line) {
  if (!line) return '';
  // e.g. import foo from 'bar'  →  const foo = await import('bar')
  const m = line.match(/^\s*import\s+(\S+)\s+from\s+(['"`][^'"`]+['"`])/);
  if (m) return `const ${m[1]} = await import(${m[2]});`;
  const m2 = line.match(/^\s*import\s+(['"`][^'"`]+['"`])/);
  if (m2) return `await import(${m2[1]});`;
  return `await import(/* ${line.trim()} */);`;
}

// ---------------------------------------------------------------------------
// processTopLevelAwait
// Wraps a code string in an async IIFE so top-level await is legal,
// returning null if the code does not appear to contain top-level await.
// ---------------------------------------------------------------------------

const HAS_AWAIT = /(?:^|[^.\w$])await[\s(]/;

/**
 * @param {string} code
 * @returns {string|null}
 */
function processTopLevelAwait(code) {
  if (!HAS_AWAIT.test(code)) return null;
  // Validate that it parses as a module (rough check)
  try {
    // Attempt a quick syntax check by wrapping — if it fails we fall through
    new Function(`return (async () => {\n${code}\n})()`); // eslint-disable-line no-new-func
  } catch (e) {
    if (e instanceof SyntaxError) return null;
  }
  return `(async () => {\n${code}\n})()`;
}

// ---------------------------------------------------------------------------
// Default writer — util.inspect with ANSI colours when useColors is set
// ---------------------------------------------------------------------------

/**
 * @param {unknown} obj
 * @returns {string}
 */
const writer = (obj) => inspect(obj, writer.options);
writer.options = { ...inspect.defaultOptions, showProxy: true, colors: false };

// ---------------------------------------------------------------------------
// REPLServer
// ---------------------------------------------------------------------------

/**
 * Read-Eval-Print-Loop server.
 * Extends readline.Interface exactly as Node does.
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
   * @param {NodeJS.ReadWriteStream} [stream]
   * @param {Function} [eval_]
   * @param {boolean} [useGlobal]
   * @param {boolean} [ignoreUndefined]
   * @param {symbol}  [replMode]
   */
  constructor(prompt, stream, eval_, useGlobal, ignoreUndefined, replMode) {
    // ---- Normalise options ------------------------------------------------
    let options;
    if (prompt !== null && typeof prompt === 'object') {
      options       = { ...prompt };
      stream        = options.stream || options.socket;
      eval_         = options.eval;
      useGlobal     = options.useGlobal;
      ignoreUndefined = options.ignoreUndefined;
      prompt        = options.prompt;
      replMode      = options.replMode;
    } else {
      options = {};
    }

    if (options.domain !== undefined) {
      throw new TypeError(
        'options.domain is no longer supported (removed in Node 24)');
    }

    if (!options.input && !options.output) {
      stream      = stream || (typeof process !== 'undefined' ? process : null);
      options.input  = (stream && stream.stdin)  || (stream && stream.input)  || stream;
      options.output = (stream && stream.stdout) || (stream && stream.output) || stream;
    }

    if (options.terminal === undefined) {
      options.terminal = !!(options.output && options.output.isTTY);
    }

    // ---- Super (readline.Interface) --------------------------------------
    super({
      input:    options.input,
      output:   options.output,
      terminal: options.terminal,
      prompt:   typeof prompt === 'string' ? prompt : '> ',
      historySize: options.historySize ?? 30,
      removeHistoryDuplicates: true,
    });

    // ---- Public properties -----------------------------------------------
    this.useColors       = !!(options.useColors ?? options.terminal);
    this.useGlobal       = !!useGlobal;
    this.ignoreUndefined = !!ignoreUndefined;
    this.replMode        = replMode || REPL_MODE_SLOPPY;
    this.writer          = options.writer || writer;
    this.editorMode      = false;
    this.commands        = Object.create(null);

    // Node compat properties
    this.underscoreAssigned    = false;
    this.underscoreErrAssigned = false;
    this.last                  = undefined;
    this.lastError             = undefined;
    this.lines                 = [];
    this.lines.level           = [];
    this.breakEvalOnSigint     = !!options.breakEvalOnSigint; // accepted, inert
    this[kContextId]           = undefined; // inspector stub
    this._initialPrompt        = typeof prompt === 'string' ? prompt : '> ';

    // ---- Writer colour ----------------------------------------------------
    if (this.writer === writer) {
      writer.options.colors = this.useColors;
    }

    // ---- Internal state --------------------------------------------------
    this[kBufferedCommand] = '';
    this[kLoading]         = false;

    // ---- Eval function ---------------------------------------------------
    if (eval_) {
      this.eval = eval_;
    } else {
      this.eval = this._defaultEval.bind(this);
    }

    // ---- Context ---------------------------------------------------------
    this.resetContext();

    // ---- Default commands ------------------------------------------------
    this._defineDefaultCommands();

    // ---- Wire up readline 'line' event -----------------------------------
    this.on('line', (cmd) => this._onLine(cmd));
    this.on('close', () => this.emit('exit'));

    // ---- Display initial prompt ------------------------------------------
    this.displayPrompt();
  }

  // -------------------------------------------------------------------------
  // Context management
  // -------------------------------------------------------------------------

  /**
   * Creates and returns a new sandboxed context for this REPL.
   * @returns {object}
   */
  createContext() {
    let context;

    if (this.useGlobal) {
      context = globalThis;
    } else {
      context = vm.createContext(Object.create(null));
      // Populate with host globals so user code sees standard builtins
      const globals = [
        'Object','Function','Array','Number','Boolean','String','Symbol',
        'BigInt','Math','Date','RegExp','Error','EvalError','RangeError',
        'ReferenceError','SyntaxError','TypeError','URIError','JSON',
        'Promise','Proxy','Reflect','Map','Set','WeakMap','WeakRef','WeakSet',
        'ArrayBuffer','DataView','Int8Array','Uint8Array','Uint8ClampedArray',
        'Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array',
        'Float64Array','BigInt64Array','BigUint64Array',
        'Atomics','SharedArrayBuffer',
        'Intl','WebAssembly',
        'console','crypto',
        'setTimeout','clearTimeout','setInterval','clearInterval','queueMicrotask',
        'fetch','URL','URLSearchParams','Headers','Request','Response','Blob',
        'TextEncoder','TextDecoder','ReadableStream','WritableStream','TransformStream',
        'AbortController','AbortSignal',
        'isFinite','isNaN','parseFloat','parseInt',
        'decodeURI','decodeURIComponent','encodeURI','encodeURIComponent',
        'undefined','Infinity','NaN',
      ];
      for (const name of globals) {
        if (name in globalThis) {
          try { context[name] = globalThis[name]; } catch (_) {}
        }
      }
      context.global = context;
    }

    // _ and _error magic properties
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

  /**
   * Resets the REPL context to a fresh sandbox.
   */
  resetContext() {
    this.context                = this.createContext();
    this.underscoreAssigned     = false;
    this.underscoreErrAssigned  = false;
    this.lines                  = [];
    this.lines.level            = [];
  }

  // -------------------------------------------------------------------------
  // Default eval
  // -------------------------------------------------------------------------

  /**
   * Node-spec default eval: handles strict mode prefix, top-level await,
   * recoverable SyntaxErrors, and static-import hints.
   *
   * @param {string} code
   * @param {object} context
   * @param {string} file
   * @param {Function} cb  (err, result) => void
   */
  async _defaultEval(code, context, file, cb) {
    let err  = null;
    let result;
    const input = code;

    // Wrap object literals so `{ a: 1 }` doesn't parse as a block
    let wrappedCmd = false;
    if (/^\s*\{/.test(code) && /\}\s*$/.test(code.trimEnd())) {
      const candidate = `(${code.trim()})`;
      try { new Function(candidate); code = candidate; wrappedCmd = true; } // eslint-disable-line no-new-func
      catch (_) { code = input; wrappedCmd = false; }
    }

    // Strict mode prefix
    if (this.replMode === REPL_MODE_STRICT && code.trim() !== '') {
      code = `'use strict'; void 0;\n${code}`;
    }

    // Empty line
    if (code === '\n') return cb(null);

    // Top-level await wrapping
    let awaitPromise = false;
    const wrapped = processTopLevelAwait(code);
    if (wrapped) {
      code = wrapped;
      wrappedCmd  = true;
      awaitPromise = true;
    }

    // Run via vm shim
    try {
      const runFn = this.useGlobal
        ? (c) => vm.runInThisContext(c, { filename: file })
        : (c) => vm.runInContext(c, this.context, { filename: file });

      const syncResult = runFn(code);

      if (awaitPromise) {
        // Must await to unwrap the async IIFE result
        try {
          result = await syncResult;
          // If the result itself is a SyncPromise / Promise from user code, unwrap
          if (result && typeof result.then === 'function') {
            result = await result;
          }
        } catch (e) {
          err = e;
        }
      } else {
        // SyncPromise — grab .value for pure-sync code
        if (syncResult && typeof syncResult === 'object' && 'value' in syncResult) {
          result = syncResult.value;
          if (syncResult.syncError) err = syncResult.syncError;
        } else {
          result = syncResult;
        }
      }
    } catch (e) {
      err = e;
      // Un-wrap if we wrapped an object literal or added strict prefix
      if (wrappedCmd && e instanceof SyntaxError) {
        code = input;
        // Retry without wrapper
        try {
          const r2 = this.useGlobal
            ? vm.runInThisContext(code, { filename: file })
            : vm.runInContext(code, this.context, { filename: file });
          err    = null;
          result = (r2 && typeof r2 === 'object' && 'value' in r2) ? r2.value : r2;
          if (r2 && r2.syncError) err = r2.syncError;
        } catch (e2) {
          err = e2;
        }
      }
    }

    if (err) {
      // Static import hint
      if (err instanceof SyntaxError &&
          err.message.includes('Cannot use import statement')) {
        const lastLine = this.lines[this.lines.length - 1] || '';
        err.message =
          'Cannot use import statement inside the Node.js REPL, ' +
          'alternatively use dynamic import: ' +
          toDynamicImport(lastLine);
      }

      // Recoverable?
      if (isRecoverableError(err, input)) {
        return cb(new Recoverable(err));
      }
      return cb(err);
    }

    cb(null, result);
  }

  // -------------------------------------------------------------------------
  // Line handler
  // -------------------------------------------------------------------------

  /**
   * @param {string} cmd
   */
  _onLine(cmd) {
    cmd = cmd || '';

    if (this.editorMode) {
      this[kBufferedCommand] += cmd + '\n';
      this._memoryUpdate(cmd);
      return;
    }

    const trimmed = cmd.trim();

    // REPL dot-commands
    if (trimmed && trimmed[0] === '.' && trimmed[1] !== '.' && isNaN(parseFloat(trimmed))) {
      const m = trimmed.match(/^\.([^\s]+)\s*(.*)?$/);
      if (m) {
        const [, keyword, rest = ''] = m;
        if (this._parseREPLKeyword(keyword, rest)) return;
        if (!this[kBufferedCommand]) {
          this._write('Invalid REPL keyword\n');
          this._finish(null);
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

  /**
   * @param {unknown} e
   * @param {unknown} [ret]
   * @param {string}  [cmd]
   */
  _finish(e, ret, cmd = '') {
    // npm hint
    if (e && !this[kBufferedCommand] &&
        cmd.trimStart().startsWith('npm ') &&
        !(e instanceof Recoverable)) {
      this._write(
        'npm should be run outside of the Node.js REPL, in your normal shell.\n' +
        '(Press Ctrl+D to exit.)\n'
      );
      this.displayPrompt();
      return;
    }

    // Recoverable multi-line
    if (e instanceof Recoverable) {
      this[kBufferedCommand] += (cmd || '') + '\n';
      this.displayPrompt();
      return;
    }

    if (e) {
      this._handleError(e.err || e);
    }

    // Clear buffer on success
    this.clearBufferedCommand();

    if (!e &&
        arguments.length >= 2 &&
        (!this.ignoreUndefined || ret !== undefined)) {
      if (!this.underscoreAssigned) this.last = ret;
      this._write(this.writer(ret) + '\n');
    }

    if (!this.closed) this.displayPrompt();
  }

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  /**
   * Prints an error to output, matching Node's "Uncaught …" prefix format.
   * @param {unknown} e
   */
  _handleError(e) {
    if (!this.underscoreErrAssigned) this.lastError = e;

    let errStack = '';
    if (typeof e === 'object' && e !== null && e.stack) {
      errStack = this.writer(e);
      if (errStack[0] === '[' && errStack[errStack.length - 1] === ']') {
        errStack = errStack.slice(1, -1);
      }
    } else {
      errStack = this.writer(e);
    }

    // Prefix with "Uncaught" like Node does
    const lines  = errStack.split(/(?<=\n)/);
    let matched  = false;
    let prefixed = '';
    for (const line of lines) {
      if (!matched && /^\[?([A-Z][a-z0-9_]*)*Error/.test(line)) {
        prefixed += `Uncaught ${line}`;
        matched   = true;
      } else {
        prefixed += line;
      }
    }
    if (!matched) prefixed = `Uncaught:\n${errStack}`;
    if (!prefixed.endsWith('\n')) prefixed += '\n';

    this._write(prefixed);
    this.clearBufferedCommand();
    this.lines.level = [];
    if (!this.closed) this.displayPrompt();
  }

  // -------------------------------------------------------------------------
  // Dot-command dispatch
  // -------------------------------------------------------------------------

  /**
   * @param {string} keyword
   * @param {string} rest
   * @returns {boolean}
   */
  _parseREPLKeyword(keyword, rest) {
    const cmd = this.commands[keyword];
    if (cmd) {
      cmd.action.call(this, rest);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Default built-in commands
  // -------------------------------------------------------------------------

  _defineDefaultCommands() {
    this.defineCommand('break', {
      help: 'Sometimes you get stuck, this gets you out',
      action() {
        this.clearBufferedCommand();
        this.displayPrompt();
      },
    });

    this.defineCommand('clear', {
      help: this.useGlobal
        ? 'Alias for .break'
        : 'Break, and also clear the local context',
      action() {
        this.clearBufferedCommand();
        if (!this.useGlobal) {
          this._write('Clearing context...\n');
          this.resetContext();
        }
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
          const cmd   = this.commands[name];
          const pad   = ' '.repeat(max - name.length + 3);
          this._write(`.${name}${cmd.help ? pad + cmd.help : ''}\n`);
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
          // Try VFS-backed fs shim
          const fs = _tryRequireFs();
          fs.writeFileSync(file, this.lines.join('\n'));
          this._write(`Session saved to: ${file}\n`);
        } catch (err) {
          this._write(`Failed to save: ${file}\n`);
        }
        this.displayPrompt();
      },
    });

    this.defineCommand('load', {
      help: 'Load JS from a file into the REPL session',
      action(file) {
        if (!file) { this._write('Missing filename\n'); this.displayPrompt(); return; }
        try {
          const fs   = _tryRequireFs();
          const data = fs.readFileSync(file, 'utf8');
          this._turnOnEditorMode();
          this[kLoading] = true;
          // Feed each line as if the user typed it
          for (const line of data.split('\n')) this.write(line + '\n');
          this[kLoading] = false;
          this._turnOffEditorMode();
          this.write('\n');
        } catch (err) {
          this._write(`Failed to load: ${file}\n`);
        }
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
    // Call super's setPrompt so _initialPrompt is not overwritten
    Interface.prototype.setPrompt.call(this, '');
  }

  _turnOffEditorMode() {
    this.editorMode = false;
    this.setPrompt(this._initialPrompt);
  }

  // -------------------------------------------------------------------------
  // Public API — matches Node's REPLServer surface
  // -------------------------------------------------------------------------

  /**
   * Display the REPL prompt.
   * @param {boolean} [preserveCursor]
   */
  displayPrompt(preserveCursor) {
    const promptStr = this[kBufferedCommand].length ? '|' : this._initialPrompt;
    Interface.prototype.setPrompt.call(this, promptStr);
    this.prompt(preserveCursor);
  }

  /**
   * Override setPrompt to also update _initialPrompt.
   * @param {string} prompt
   */
  setPrompt(prompt) {
    this._initialPrompt = prompt;
    Interface.prototype.setPrompt.call(this, prompt);
  }

  /**
   * Clear the multi-line command buffer.
   */
  clearBufferedCommand() {
    this[kBufferedCommand] = '';
  }

  /**
   * Register a dot-command.
   * @param {string} keyword
   * @param {Function|{help?: string, action: Function}} cmd
   */
  defineCommand(keyword, cmd) {
    if (typeof cmd === 'function') cmd = { action: cmd };
    if (typeof cmd.action !== 'function')
      throw new TypeError('cmd.action must be a function');
    this.commands[keyword] = cmd;
  }

  /**
   * setupHistory — in-memory only (no fs persistence in browser).
   * @param {string|object} historyConfig
   * @param {Function} [cb]
   */
  setupHistory(historyConfig, cb) {
    const callback = typeof historyConfig === 'object' && historyConfig !== null
      ? historyConfig.onHistoryFileLoaded || cb
      : cb;
    // No-op — history is already in-memory via readline Interface
    if (typeof callback === 'function') {
      Promise.resolve().then(() => callback(null, this));
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Write to output stream without triggering readline redraw issues.
   * @param {string} str
   */
  _write(str) {
    if (this.output && typeof this.output.write === 'function') {
      this.output.write(str);
    }
  }

  /**
   * Track depth of braces/parens for the .save command's line memory.
   * Mirrors Node's _memory() logic.
   * @param {string} cmd
   */
  _memoryUpdate(cmd) {
    if (cmd) {
      const len = this.lines.level.length ? this.lines.level.length - 1 : 0;
      this.lines.push('  '.repeat(len) + cmd);
    } else {
      this.lines.push('');
    }

    if (!cmd) { this.lines.level = []; return; }

    let depth = 0;
    for (const ch of cmd) {
      if (ch === '{' || ch === '(') depth++;
      else if (ch === '}' || ch === ')') depth--;
    }

    if (depth > 0) {
      this.lines.level.push({ line: this.lines.length - 1, depth });
    } else if (depth < 0 && this.lines.level.length) {
      this.lines.level.pop();
    }
  }
}

// ---------------------------------------------------------------------------
// Lazy fs helper for .save/.load (maps to VFS shim if available)
// ---------------------------------------------------------------------------

function _tryRequireFs() {
  // Works whether the caller uses the VFS fs shim or native Node fs
  if (typeof require === 'function') {
    return require('fs');
  }
  // If no require, throw — .save/.load will report "Failed to save/load"
  throw new Error('fs not available');
}

// ---------------------------------------------------------------------------
// start() — factory function, mirrors repl.start()
// ---------------------------------------------------------------------------

/**
 * Creates and starts a REPLServer instance.
 *
 * @param {string|object} [options='> ']  Prompt string or options object.
 * @returns {REPLServer}
 *
 * @example
 * import { start } from 'repl';
 * const r = start({ prompt: '> ', useColors: true });
 * r.context.x = 10;
 */
export function start(options = '> ') {
  return new REPLServer(options);
}

// ---------------------------------------------------------------------------
// builtinModules (deprecated in Node 24 but still exported for compat)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `module.builtinModules` instead.
 * @type {string[]}
 */
export const builtinModules = [
  'assert','buffer','child_process','cluster','console','constants','crypto',
  'dgram','dns','domain','events','fs','http','https','module','net','os',
  'path','perf_hooks','process','punycode','querystring','readline','repl',
  'stream','string_decoder','sys','timers','tls','tty','url','util','v8','vm',
  'worker_threads','zlib',
];

// ---------------------------------------------------------------------------
// isValidSyntax — exported because some Node tooling imports it from repl
// ---------------------------------------------------------------------------

/**
 * @param {string} src
 * @returns {boolean}
 */
export function isValidSyntax(src) {
  try { new Function(src); return true; } // eslint-disable-line no-new-func
  catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// Default export — matches Node's module.exports shape
// ---------------------------------------------------------------------------

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
// // 1. Basic REPL on custom streams (e.g. xterm.js)
// import { start } from 'repl';
// const r = start({ prompt: '> ', input: termIn, output: termOut, useColors: true });
// r.context.fetch = customFetch;
//
// // 2. Custom eval — square numbers only
// const r2 = start({
//   prompt: 'square> ',
//   eval(code, ctx, file, cb) {
//     const n = parseFloat(code);
//     if (isNaN(n)) return cb(new Error(`${code.trim()} is not a number`));
//     cb(null, n * n);
//   },
// });
//
// // 3. Multi-line / top-level await (works out of the box)
// // User types:
// //   > const res = await fetch('https://api.example.com/data')
// //   > res.json()
// // Both lines work — await is detected and code is wrapped in async IIFE.
//
// // 4. Custom dot-command
// r.defineCommand('greet', {
//   help: 'Say hello',
//   action(name) {
//     this.clearBufferedCommand();
//     this._write(`Hello, ${name || 'world'}!\n`);
//     this.displayPrompt();
//   },
// });
// // User types: .greet Rick  →  Hello, Rick!
//
// // 5. Recoverable multi-line (automatic)
// // User types:
// //   > function add(a, b) {     ← Ctrl+Enter or Enter
// //   |   return a + b           ← REPL buffers, shows |
// //   | }                        ← closes — executes whole block
//
// // 6. reset event
// r.on('reset', (ctx) => { ctx.myLib = myLib; });
// r.defineCommand('clear', { help: 'reset', action() { this.resetContext(); } });
