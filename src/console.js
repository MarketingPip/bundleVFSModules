// Console class matching Node.js constructor (accepts stdout/stderr streams)

/* ------------------------------------------------------------------ */
/*  Console class                                                     */
/* ------------------------------------------------------------------ */

export const Console = function Console(stdout, stderr) {
  if (!this) return;

  const o = stdout;

  if (o && typeof o === "object" && "write" in o) {
    // new Console(stream) or new Console(stdout, stderr)
    this._out = o;
    this._err = stderr || this._out;
  } else if (o && typeof o === "object" && "stdout" in o) {
    // new Console({ stdout, stderr })
    this._out = o.stdout || null;
    this._err = o.stderr || this._out;
  } else {
    this._out = null;
    this._err = null;
  }
};

Console.prototype._emit = function (target, args) {
  const text =
    args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ") + "\n";

  const dest = target === "err" ? this._err : this._out;

  if (dest) dest.write(text);
  else if (target === "err") globalThis.console.error(...args);
  else globalThis.console.log(...args);
};

Console.prototype.log = function (...a) {
  this._emit("out", a);
};

Console.prototype.error = function (...a) {
  this._emit("err", a);
};

Console.prototype.warn = function (...a) {
  this._emit("err", a);
};

Console.prototype.info = function (...a) {
  this._emit("out", a);
};

Console.prototype.debug = function (...a) {
  this._emit("out", a);
};

Console.prototype.trace = function (...a) {
  this._emit("err", a);
};

Console.prototype.dir = function (o) {
  this._emit("out", [o]);
};

Console.prototype.time = function () {};
Console.prototype.timeEnd = function () {};
Console.prototype.timeLog = function () {};

Console.prototype.assert = function (v, ...a) {
  if (!v) this._emit("err", ["Assertion failed:", ...a]);
};

Console.prototype.clear = function () {};
Console.prototype.count = function () {};
Console.prototype.countReset = function () {};
Console.prototype.group = function () {};
Console.prototype.groupCollapsed = function () {};
Console.prototype.groupEnd = function () {};

Console.prototype.table = function (d) {
  this._emit("out", [d]);
};

/* ------------------------------------------------------------------ */
/*  Named re-exports from global console                              */
/* ------------------------------------------------------------------ */

const _gc = globalThis.console;

export const log = _gc.log.bind(_gc);
export const error = _gc.error.bind(_gc);
export const warn = _gc.warn.bind(_gc);
export const info = _gc.info.bind(_gc);
export const debug = _gc.debug.bind(_gc);
export const trace = _gc.trace.bind(_gc);
export const dir = _gc.dir.bind(_gc);
export const time = _gc.time.bind(_gc);
export const timeEnd = _gc.timeEnd.bind(_gc);
export const timeLog = _gc.timeLog.bind(_gc);
export const clear = _gc.clear.bind(_gc);
export const count = _gc.count.bind(_gc);
export const countReset = _gc.countReset.bind(_gc);
export const group = _gc.group.bind(_gc);
export const groupCollapsed = _gc.groupCollapsed.bind(_gc);
export const groupEnd = _gc.groupEnd.bind(_gc);
export const table = _gc.table.bind(_gc);

/* ------------------------------------------------------------------ */
/*  Default export                                                    */
/* ------------------------------------------------------------------ */

export default {
  Console,
  log,
  error,
  warn,
  info,
  debug,
  trace,
  dir,
  time,
  timeEnd,
  timeLog,
  assert: _gc.assert.bind(_gc),
  clear,
  count,
  countReset,
  group,
  groupCollapsed,
  groupEnd,
  table,
};
