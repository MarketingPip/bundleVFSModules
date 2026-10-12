// @ts-self-types="./readline.d.ts"
/**
 * readline shim for browser / edge / bundler environments.
 * Mirrors the Node.js `readline` module API surface.
 *
 * @module readline
 * @since Node.js v0.1.98
 */

// ─── Safe Noop Stream Fallback ───────────────────────────────────────────────
const noopStream = {
  write: () => {},
  on: () => {},
  once: () => {},
  off: () => {},
  removeListener: () => {},
  pause: () => {},
  resume: () => {},
  isTTY: false,
  columns: 80,
  rows: 24,
};

// ─── Interface class (internal) ─────────────────────────────────────────────
// Node's public `Interface` is a factory function (callable with or without
// `new`); the class below is the implementation. See the `Interface`
// function further down.

class InterfaceImpl {
  // Public properties matching Node.js readline API surface
  input;
  output;

  #terminal;
  #promptStr;
  #closed = false;
  #lineBuffer = "";
  #crSeen = false;
  #pendingOps = null;
  #boundHandleChunk;
  #boundOnInputClose;
  #ev = Object.create(null);
  #paused = false;
  #history = [];
  #historyIndex = -1;
  #historySize = 30;
  #crlfDelay = 100;

  // async-iterator state
  #lineQueue = [];
  #lineResolve = null;
  #lineDone = false;

  constructor(input, output, completer, terminal) {
    // Node supports both `Interface({ input, output, ... })` (options object)
    // and `Interface(input, output, completer, terminal)` (positional).
    let options;
    if (input != null && typeof input === "object" && "input" in input) {
      options = input;
    } else {
      options = { input, output, completer, terminal };
    }

    const inStream =
      options.input ||
      (typeof globalThis.process !== "undefined"
        ? globalThis.process.stdin
        : null) ||
      noopStream;
    const outStream =
      options.output ||
      (typeof globalThis.process !== "undefined"
        ? globalThis.process.stdout
        : null) ||
      noopStream;
    const isTerminal =
      options.terminal != null ? !!options.terminal : !!outStream?.isTTY;

    this.input = inStream;
    this.output = outStream;
    this.#terminal = isTerminal;
    this.#promptStr = options.prompt ?? (isTerminal ? "> " : "");
    // crlfDelay: Node defaults to 100, clamps to minimum 100
    const cd = options.crlfDelay;
    this.#crlfDelay = Math.max(cd == null ? 100 : Number(cd) || 100, 100);
    if (options.historySize != null) this.#historySize = options.historySize;

    // Node throws if completer is defined but not a function
    if (options.completer !== undefined && typeof options.completer !== "function") {
      const err = new TypeError(
        `The "completer" argument must be of type function. Received type ${typeof options.completer}`
      );
      err.code = "ERR_INVALID_ARG_VALUE";
      throw err;
    }

    // wire line/close to the async-iterator queues
    this.#_on("line", (line) => {
      if (this.#lineResolve) {
        const r = this.#lineResolve;
        this.#lineResolve = null;
        r({ value: line, done: false });
      } else {
        this.#lineQueue.push(line);
      }
    });
    this.#_on("close", () => {
      this.#lineDone = true;
      if (this.#lineResolve) {
        this.#lineResolve({ value: undefined, done: true });
        this.#lineResolve = null;
      }
    });

    this.#boundHandleChunk = (chunk) => this.#handleChunk(chunk);
    this.#boundOnInputClose = () => {
      if (!this.#closed) this.close();
    };

    this.input?.on?.("data", this.#boundHandleChunk);
    this.input?.on?.("close", this.#boundOnInputClose);

    // In terminal mode, input emits keypress events (Node behavior).
    if (isTerminal) {
      emitKeypressEvents(inStream, this);
    }
  }

  // ── private event helpers ──────────────────────────────────────────────

  #_on(ev, fn, once = false) {
    if (!this.#ev[ev]) this.#ev[ev] = [];
    this.#ev[ev].push({ fn, once });
  }

  #_off(ev, fn) {
    if (this.#ev[ev]) this.#ev[ev] = this.#ev[ev].filter((e) => e.fn !== fn);
  }

  #_emit(ev, ...args) {
    const list = this.#ev[ev];
    if (!list) return false;
    const snap = [...list];
    this.#ev[ev] = list.filter((e) => !e.once);
    for (const e of snap) e.fn(...args);
    return true;
  }

  #_listenerCount(ev) {
    return (this.#ev[ev] || []).length;
  }

  // ── input handling ────────────────────────────────────────────────────

  #handleChunk(chunk) {
    const str = typeof chunk === "string" ? chunk : chunk.toString();
    if (this.input?.isRaw || this.#terminal) {
      const line = str.replace(/[\r\n]+$/, "");
      if (line === "\u0003") {
        this.#_emit("SIGINT");
        return;
      }
      this.#_emit("line", line);
    } else {
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === "\r") {
          this.#crSeen = true;
          this.#flushLine();
          continue;
        }
        if (ch === "\n") {
          if (!this.#crSeen) this.#flushLine();
          this.#crSeen = false;
          continue;
        }
        this.#crSeen = false;
        this.#lineBuffer += ch;
      }
    }
  }

  #flushLine() {
    const line = this.#lineBuffer;
    this.#lineBuffer = "";
    if (line === "\u0003") {
      this.#_emit("SIGINT");
      return;
    }
    this.#_emit("line", line);
  }

  // ── public EventEmitter-like API ──────────────────────────────────────

  get terminal() {
    return this.#terminal;
  }

  /** Current line buffer contents (mirrors Node's `rl.line`). @since Node.js v0.1.98 */
  get line() {
    return this.#lineBuffer;
  }
  /** Current cursor position within `rl.line`. @since Node.js v0.1.98 */
  get cursor() {
    return this.#lineBuffer.length;
  }

  /** Whether the interface is closed. */
  get closed() {
    return this.#closed;
  }

  /** Whether the input is paused. */
  get paused() {
    return this.#paused;
  }

  /** CRLF delay in milliseconds (Node defaults/clamps to 100). */
  get crlfDelay() {
    return this.#crlfDelay;
  }

  /** Command history. */
  get history() {
    return this.#history;
  }
  set history(v) {
    this.#history = v;
  }

  get historyIndex() {
    return this.#historyIndex;
  }

  get historySize() {
    return this.#historySize;
  }
  set historySize(v) {
    this.#historySize = v;
  }

  on(ev, fn) {
    this.#_on(ev, fn, false);
    return this;
  }
  once(ev, fn) {
    this.#_on(ev, fn, true);
    return this;
  }
  off(ev, fn) {
    this.#_off(ev, fn);
    return this;
  }
  removeListener(ev, fn) {
    this.#_off(ev, fn);
    return this;
  }
  removeAllListeners(ev) {
    if (ev) delete this.#ev[ev];
    else Object.keys(this.#ev).forEach((k) => delete this.#ev[k]);
    return this;
  }
  listenerCount(ev) {
    return this.#_listenerCount(ev);
  }
  emit(ev, ...a) {
    return this.#_emit(ev, ...a);
  }

  // ── prompt / pause / resume / close ──────────────────────────────────

  setPrompt(str) {
    this.#promptStr = str;
    return this;
  }
  getPrompt() {
    return this.#promptStr;
  }
  prompt(/*preserveCursor*/) {
    if (this.output?.write) this.output.write(this.#promptStr);
    return this;
  }

  pause() {
    this.#paused = true;
    this.input?.pause?.();
    this.#_emit("pause");
    return this;
  }
  resume() {
    this.#paused = false;
    this.input?.resume?.();
    this.#_emit("resume");
    return this;
  }

  close() {
    if (this.#closed) return this;
    this.#closed = true;
    this.input?.removeListener?.("data", this.#boundHandleChunk);
    this.input?.removeListener?.("close", this.#boundOnInputClose);
    if (this.#lineBuffer.length) this.#flushLine();
    this.#_emit("close");
    return this;
  }

  write(data /*, key */) {
    if (this.#closed) return this;
    if (typeof data === "string" && data.length)
      this.#_emit("line", data.replace(/[\r\n]+$/, ""));
    return this;
  }

  // ── cursor / screen helpers ──────────────────────────────────────────

  getCursorPos() {
    const columns = this.output?.columns || 80;
    const totalLength = this.#promptStr.length + this.#lineBuffer.length;
    const rows = Math.floor(totalLength / columns);
    const cols = totalLength % columns;
    return { rows, cols };
  }

  cursorTo(x, y, cb) {
    if (this.output) cursorTo(this.output, x, y, cb);
    return this;
  }

  moveCursor(dx, dy, cb) {
    if (this.output) moveCursor(this.output, dx, dy, cb);
    return this;
  }

  clearLine(dir, cb) {
    if (this.output) clearLine(this.output, dir, cb);
    return this;
  }

  clearScreenDown(cb) {
    if (this.output) clearScreenDown(this.output, cb);
    return this;
  }

  rollback() {
    this.#pendingOps = [];
    return this;
  }

  commit() {
    if (this.#pendingOps) {
      for (const op of this.#pendingOps) op();
      this.#pendingOps = null;
    }
    return this;
  }

  question(query, optionsOrCb, cb) {
    if (this.#closed) {
      return typeof cb === "function" || typeof optionsOrCb === "function"
        ? void 0
        : Promise.reject(new Error("readline was closed"));
    }

    let opts = {},
      callback;
    if (typeof optionsOrCb === "function") {
      callback = optionsOrCb;
    } else {
      opts = optionsOrCb || {};
      callback = cb;
    }

    if (this.output?.write) this.output.write(query);
    const signal = opts.signal;

    if (typeof callback === "function") {
      let called = false;
      const onLine = (answer) => {
        if (called) return;
        called = true;
        this.#_off("line", onLine);
        callback(answer);
      };
      this.#_on("line", onLine);
      signal?.addEventListener(
        "abort",
        () => {
          if (called) return;
          called = true;
          this.#_off("line", onLine);
        },
        { once: true },
      );
      return this;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const onLine = (answer) => {
        if (settled) return;
        settled = true;
        this.#_off("line", onLine);
        resolve(answer);
      };
      this.#_on("line", onLine);
      signal?.addEventListener(
        "abort",
        () => {
          if (settled) return;
          settled = true;
          this.#_off("line", onLine);
          const err = new Error("The question was aborted");
          err.code = "ABORT_ERR";
          reject(err);
        },
        { once: true },
      );
    });
  }

  [Symbol.asyncIterator]() {
    const self = this;
    return {
      next() {
        if (self.#lineQueue.length)
          return Promise.resolve({
            value: self.#lineQueue.shift(),
            done: false,
          });
        if (self.#lineDone)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => {
          self.#lineResolve = res;
        });
      },
      return() {
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

// ─── Public Interface factory (Node-compatible) ─────────────────────────────
// Node's `readline.Interface` is a function callable with or without `new`,
// and accepts both `Interface({ input, ... })` and
// `Interface(input, output, completer, terminal)`. We delegate to the class
// and re-prototype so `instanceof Interface` holds either way.
function Interface(input, output, completer, terminal) {
  const inst = new InterfaceImpl(input, output, completer, terminal);
  Object.setPrototypeOf(inst, Interface.prototype);
  return inst;
}
Object.setPrototypeOf(Interface.prototype, InterfaceImpl.prototype);
Object.setPrototypeOf(Interface, InterfaceImpl);

// ─── Module exports & Helpers ───────────────────────────────────────────────
const Readline = Interface;

function createInterface(options = {}) {
  return new Interface(options);
}

function emitKeypressEvents(stream, iface = {}) {
  if (!stream || stream._keypressAttached) return;
  stream._keypressAttached = true;

  // Parse a single character/sequence into a key object.
  // Matches Node's key shape: { sequence, name?, ctrl, meta, shift }
  // (name is omitted entirely for characters without a name, e.g. '.')
  function parseKey(s) {
    const key = {
      sequence: s,
      name: undefined,
      ctrl: false,
      meta: false,
      shift: false,
    };

    if (s === "\r") {
      key.name = "return";
    } else if (s === "\n") {
      key.name = "enter";
    } else if (s === "\t") {
      key.name = "tab";
    } else if (s === "\x7f" || s === "\b") {
      key.name = "backspace";
    } else if (s === "\x03") {
      key.name = "c";
      key.ctrl = true;
    } else if (s === "\x1a") {
      key.name = "z";
      key.ctrl = true;
    } else if (s.length === 1 && s >= "\x01" && s <= "\x1a") {
      // Ctrl+A through Ctrl+Z
      key.name = String.fromCharCode(s.charCodeAt(0) + 96);
      key.ctrl = true;
    } else if (s === "\x1b") {
      key.name = "escape";
    } else if (s === " ") {
      key.name = "space";
    } else if (s.length === 1) {
      const code = s.charCodeAt(0);
      if (code >= 65 && code <= 90) {
        // Uppercase A-Z: shift implied
        key.name = s.toLowerCase();
        key.shift = true;
      } else if (
        (code >= 97 && code <= 122) || // a-z
        (code >= 48 && code <= 57) // 0-9
      ) {
        key.name = s;
      } else {
        // Other single chars (e.g. '.'): name is explicitly undefined
        key.name = undefined;
      }
    } else if (s.startsWith("\x1b")) {
      // Escape sequences: arrows, home/end, etc.
      const seq = s.slice(1);
      if (seq === "[A") key.name = "up";
      else if (seq === "[B") key.name = "down";
      else if (seq === "[C") key.name = "right";
      else if (seq === "[D") key.name = "left";
      else if (seq === "[H") key.name = "home";
      else if (seq === "[F") key.name = "end";
      else if (seq === "[3~") key.name = "delete";
      else if (seq === "OA") key.name = "up";
      else if (seq === "OB") key.name = "down";
      else if (seq === "OC") key.name = "right";
      else if (seq === "OD") key.name = "left";
      else key.name = undefined;
      // Meta + key: ESC followed by char — parse the inner char for its name
      if (key.name === undefined && seq.length === 1) {
        const inner = parseKey(seq);
        key.name = inner.name;
        key.meta = true;
        // shift/ctrl from inner don't apply to meta combo; keep them false
      }
    }

    return key;
  }

  // Split input into key sequences, handling escape sequences.
  function* splitSequences(str) {
    let i = 0;
    while (i < str.length) {
      if (str[i] === "\x1b" && i + 1 < str.length) {
        // Potential escape sequence: consume ESC + following chars
        let j = i + 1;
        if (str[j] === "[") {
          j++;
          while (j < str.length && /[0-9;]/.test(str[j])) j++;
          if (j < str.length) j++; // the final letter (~, A-D, H, F, etc.)
        } else if (str[j] === "O") {
          j += 2; // O + letter
        } else {
          j++; // ESC + single char (meta)
        }
        yield str.slice(i, j);
        i = j;
      } else {
        // Single character (may be multi-byte, but we treat as one unit
        // for simplicity; full Unicode handling would use StringDecoder)
        yield str[i];
        i++;
      }
    }
  }

  const onData = (chunk) => {
    const str = typeof chunk === "string" ? chunk : chunk.toString();
    for (const seq of splitSequences(str)) {
      const key = parseKey(seq);
      stream.emit("keypress", seq, key);
    }
  };

  stream.on("data", onData);
}

function cursorTo(stream, x, y, cb) {
  const target = stream || noopStream;
  if (y == null) target.write(`\u001b[${x + 1}G`);
  else target.write(`\u001b[${y + 1};${x + 1}H`);
  cb?.();
  return true;
}

function moveCursor(stream, dx, dy, cb) {
  const target = stream || noopStream;
  if (dx > 0) target.write(`\u001b[${dx}C`);
  if (dx < 0) target.write(`\u001b[${-dx}D`);
  if (dy > 0) target.write(`\u001b[${dy}B`);
  if (dy < 0) target.write(`\u001b[${-dy}A`);
  cb?.();
  return true;
}

function clearLine(stream, dir, cb) {
  const target = stream || noopStream;
  const code = dir === 0 ? 2 : dir === -1 ? 1 : 0;
  target.write(`\u001b[${code}K`);
  cb?.();
  return true;
}

function clearScreenDown(stream, cb) {
  const target = stream || noopStream;
  target.write("\u001b[0J");
  cb?.();
  return true;
}

const promises = {
  Interface,
  Readline,
  createInterface,
};

export {
  createInterface,
  emitKeypressEvents,
  cursorTo,
  moveCursor,
  clearLine,
  clearScreenDown,
  Interface,
  Readline,
  promises,
};

export default {
  createInterface,
  emitKeypressEvents,
  cursorTo,
  moveCursor,
  clearLine,
  clearScreenDown,
  Interface,
  Readline,
  promises,
};
