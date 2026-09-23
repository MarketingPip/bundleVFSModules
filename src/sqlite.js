// src/sqlite.js — Honest browser stub for `node:sqlite` (Node.js v24.20.0).
//
// There is no SQLite native binding in a browser, and this project forbids
// heavy dependencies (no sql.js, no WASM bundles), so a real embedded
// database is impossible here. This module therefore exports the exact
// `node:sqlite` surface — `DatabaseSync`, `StatementSync`, `Session`,
// `constants`, `backup` — with correct shapes, constructor signatures, and
// Node-identical argument validation.
//
// Design decision (see also docs): anything that only needs local
// bookkeeping behaves normally (constructor validation, open/close state,
// `isOpen`/`isTransaction`/`limits`/`location`, SQL-text getters,
// `Symbol.dispose`). Anything that would require a live SQLite engine
// throws a clear, catchable error instead of silently succeeding:
//
//   Error('node:sqlite is not available in this browser runtime')
//   with `err.code === 'ERR_SQLITE_UNAVAILABLE'`
//
// Silently succeeding (e.g. returning fake rows from `get()`/`all()` or
// pretending `exec('INSERT …')` ran) would corrupt user data, which is worse
// than a clear error. Pure noops are used only where nothing is fabricated
// (e.g. `Symbol.dispose` on an already-closed database).
//
// Runtime contract: this module needs no `_RUNTIME_` services (no FS, no
// network, no process values), so it references no runtime variables at all.
// No `window`/`document` at module scope; dependency-free ESM.

const UNAVAILABLE_MESSAGE = 'node:sqlite is not available in this browser runtime';
const UNAVAILABLE_CODE = 'ERR_SQLITE_UNAVAILABLE';

function unavailable(method) {
  const err = new Error(UNAVAILABLE_MESSAGE);
  err.code = UNAVAILABLE_CODE;
  err.method = method;
  return err;
}

// --- Node-identical validation errors -------------------------------------

function invalidArgType(message) {
  const err = new TypeError(message);
  err.code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

function invalidState(message) {
  const err = new Error(message);
  err.code = 'ERR_INVALID_STATE';
  return err;
}

function validatePath(path, name = 'path') {
  const isValid =
    (typeof path === 'string' && !path.includes('\0')) ||
    (typeof Uint8Array !== 'undefined' && path instanceof Uint8Array && !hasNullByte(path)) ||
    (typeof URL !== 'undefined' && path instanceof URL);
  if (!isValid) {
    throw invalidArgType(
      `The "${name}" argument must be a string, Uint8Array, or URL without null bytes.`,
    );
  }
}

function hasNullByte(u8) {
  for (let i = 0; i < u8.length; i++) {
    if (u8[i] === 0) return true;
  }
  return false;
}

function validateOptionsObject(options, name = 'options') {
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    throw invalidArgType(`The "${name}" argument must be an object.`);
  }
}

function validateBooleanOption(options, key) {
  if (options[key] !== undefined && typeof options[key] !== 'boolean') {
    throw invalidArgType(`The "options.${key}" argument must be a boolean.`);
  }
}

// --- constants ------------------------------------------------------------
// Exact values from Node v24.20.0's `node:sqlite` (static reference data,
// verified against the real builtin; safe to hardcode).
const constants = {
  SQLITE_CHANGESET_OMIT: 0,
  SQLITE_CHANGESET_REPLACE: 1,
  SQLITE_CHANGESET_ABORT: 2,
  SQLITE_CHANGESET_DATA: 1,
  SQLITE_CHANGESET_NOTFOUND: 2,
  SQLITE_CHANGESET_CONFLICT: 3,
  SQLITE_CHANGESET_CONSTRAINT: 4,
  SQLITE_CHANGESET_FOREIGN_KEY: 5,
  SQLITE_OK: 0,
  SQLITE_DENY: 1,
  SQLITE_IGNORE: 2,
  SQLITE_CREATE_INDEX: 1,
  SQLITE_CREATE_TABLE: 2,
  SQLITE_CREATE_TEMP_INDEX: 3,
  SQLITE_CREATE_TEMP_TABLE: 4,
  SQLITE_CREATE_TEMP_TRIGGER: 5,
  SQLITE_CREATE_TEMP_VIEW: 6,
  SQLITE_CREATE_TRIGGER: 7,
  SQLITE_CREATE_VIEW: 8,
  SQLITE_DELETE: 9,
  SQLITE_DROP_INDEX: 10,
  SQLITE_DROP_TABLE: 11,
  SQLITE_DROP_TEMP_INDEX: 12,
  SQLITE_DROP_TEMP_TABLE: 13,
  SQLITE_DROP_TEMP_TRIGGER: 14,
  SQLITE_DROP_TEMP_VIEW: 15,
  SQLITE_DROP_TRIGGER: 16,
  SQLITE_DROP_VIEW: 17,
  SQLITE_INSERT: 18,
  SQLITE_PRAGMA: 19,
  SQLITE_READ: 20,
  SQLITE_SELECT: 21,
  SQLITE_TRANSACTION: 22,
  SQLITE_UPDATE: 23,
  SQLITE_ATTACH: 24,
  SQLITE_DETACH: 25,
  SQLITE_ALTER_TABLE: 26,
  SQLITE_REINDEX: 27,
  SQLITE_ANALYZE: 28,
  SQLITE_CREATE_VTABLE: 29,
  SQLITE_DROP_VTABLE: 30,
  SQLITE_FUNCTION: 31,
  SQLITE_SAVEPOINT: 32,
  SQLITE_COPY: 0,
  SQLITE_RECURSIVE: 33,
};

// SQLite compile-time default limits (as reported by Node v24.20.0's
// `db.limits` on a fresh `:memory:` database). Static reference data.
const DEFAULT_LIMITS = {
  length: 1000000000,
  sqlLength: 1000000000,
  column: 2000,
  exprDepth: 1000,
  compoundSelect: 500,
  vdbeOp: 250000000,
  functionArg: 1000,
  attach: 10,
  likePatternLength: 50000,
  variableNumber: 32766,
  triggerDepth: 1000,
};

function displayPath(path) {
  if (typeof path === 'string') return path;
  if (typeof URL !== 'undefined' && path instanceof URL) return path.href;
  return '[Uint8Array path]';
}

// --- StatementSync ---------------------------------------------------------

class StatementSync {
  constructor() {
    // Mirrors Node: statements can only be created via `db.prepare()`.
    const err = new Error('Illegal constructor');
    err.code = 'ERR_ILLEGAL_CONSTRUCTOR';
    throw err;
  }

  _assertActive() {
    if (this._finalized || !this._db._isOpen) {
      throw invalidState('statement has been finalized');
    }
  }

  iterate(..._args) {
    this._assertActive();
    throw unavailable('StatementSync#iterate');
  }

  all(..._args) {
    this._assertActive();
    throw unavailable('StatementSync#all');
  }

  get(..._args) {
    this._assertActive();
    throw unavailable('StatementSync#get');
  }

  run(..._args) {
    this._assertActive();
    throw unavailable('StatementSync#run');
  }

  columns() {
    this._assertActive();
    throw unavailable('StatementSync#columns');
  }

  setAllowBareNamedParameters(_allow) {
    this._assertActive();
    throw unavailable('StatementSync#setAllowBareNamedParameters');
  }

  setAllowUnknownNamedParameters(_allow) {
    this._assertActive();
    throw unavailable('StatementSync#setAllowUnknownNamedParameters');
  }

  setReadBigInts(_allow) {
    this._assertActive();
    throw unavailable('StatementSync#setReadBigInts');
  }

  setReturnArrays(_allow) {
    this._assertActive();
    throw unavailable('StatementSync#setReturnArrays');
  }
}

function createStatement(db, sql) {
  const stmt = Object.create(StatementSync.prototype);
  stmt._db = db;
  stmt._sql = sql;
  stmt._finalized = false;
  // Own accessor props, like the native object (`sourceSQL`, `expandedSQL`).
  Object.defineProperties(stmt, {
    sourceSQL: { enumerable: true, get: () => stmt._sql },
    expandedSQL: { enumerable: true, get: () => stmt._sql },
  });
  db._statements.add(stmt);
  return stmt;
}

// --- Session ---------------------------------------------------------------

class Session {
  constructor() {
    // Mirrors Node: sessions can only be created via `db.createSession()`.
    const err = new Error('Illegal constructor');
    err.code = 'ERR_ILLEGAL_CONSTRUCTOR';
    throw err;
  }

  _assertActive() {
    if (this._closed || !this._db._isOpen) {
      throw invalidState('session is not open');
    }
  }

  changeset() {
    this._assertActive();
    throw unavailable('Session#changeset');
  }

  patchset() {
    this._assertActive();
    throw unavailable('Session#patchset');
  }

  close() {
    this._closed = true;
  }
}

function createSession(db, _options) {
  const session = Object.create(Session.prototype);
  session._db = db;
  session._closed = false;
  return session;
}

// --- DatabaseSync ----------------------------------------------------------
// A plain function (not `class`) so calling it without `new` can throw
// Node's ERR_CONSTRUCT_CALL_REQUIRED, exactly like the native constructor.
function DatabaseSync(path = undefined, options = undefined) {
  if (new.target === undefined) {
    const err = new TypeError('Cannot call constructor without `new`');
    err.code = 'ERR_CONSTRUCT_CALL_REQUIRED';
    throw err;
  }
  {
    validatePath(path);
    validateOptionsObject(options);
    const opts = options ?? {};
    validateBooleanOption(opts, 'open');
    validateBooleanOption(opts, 'readOnly');
    validateBooleanOption(opts, 'enableForeignKeyConstraints');
    validateBooleanOption(opts, 'enableDoubleQuotedStringLiterals');
    validateBooleanOption(opts, 'readBigInts');
    validateBooleanOption(opts, 'returnArrays');
    validateBooleanOption(opts, 'allowBareNamedParameters');
    validateBooleanOption(opts, 'allowUnknownNamedParameters');
    if (opts.timeout !== undefined && !Number.isInteger(opts.timeout)) {
      throw invalidArgType('The "options.timeout" argument must be an integer.');
    }

    this._path = path;
    this._options = { ...opts };
    this._isOpen = opts.open !== false;
    this._location = path === ':memory:' ? null : displayPath(path);
    this._statements = new Set();
    // Type tag used by the ecosystem to identify node:sqlite databases.
    this[Symbol.for('sqlite-type')] = 'node:sqlite';

    // Own accessor props, like the native object.
    const self = this;
    Object.defineProperties(this, {
      isOpen: { enumerable: true, get: () => self._isOpen },
      isTransaction: { enumerable: true, get: () => false },
      limits: { enumerable: true, get: () => ({ ...DEFAULT_LIMITS }) },
    });
  }
}

DatabaseSync.prototype._assertOpen = function () {
  if (!this._isOpen) {
    throw invalidState('database is not open');
  }
};

DatabaseSync.prototype.open = function () {
  if (this._isOpen) {
    throw invalidState('database is already open');
  }
  this._isOpen = true;
};

DatabaseSync.prototype.close = function () {
  this._assertOpen();
  for (const stmt of this._statements) {
    stmt._finalized = true;
  }
  this._statements.clear();
  this._isOpen = false;
};

DatabaseSync.prototype.prepare = function (sql) {
  if (typeof sql !== 'string') {
    throw invalidArgType('The "sql" argument must be a string.');
  }
  this._assertOpen();
  // Returning the statement shape is honest: in real SQLite, `prepare`
  // only parses — no rows are produced or fabricated here.
  return createStatement(this, sql);
};

DatabaseSync.prototype.exec = function (sql) {
  if (typeof sql !== 'string') {
    throw invalidArgType('The "sql" argument must be a string.');
  }
  this._assertOpen();
  // Executing SQL has real effects; pretending it ran would corrupt data.
  throw unavailable('DatabaseSync#exec');
};

DatabaseSync.prototype.function = function (name, maybeOptions, maybeFn) {
  if (typeof name !== 'string') {
    throw invalidArgType('The "name" argument must be a string.');
  }
  const fn = typeof maybeOptions === 'function' ? maybeOptions : maybeFn;
  if (typeof fn !== 'function') {
    throw invalidArgType('The "function" argument must be a function.');
  }
  this._assertOpen();
  throw unavailable('DatabaseSync#function');
};

DatabaseSync.prototype.aggregate = function (name, options) {
  if (typeof name !== 'string') {
    throw invalidArgType('The "name" argument must be a string.');
  }
  if (typeof options !== 'object' || options === null) {
    throw invalidArgType('The "options" argument must be an object.');
  }
  this._assertOpen();
  throw unavailable('DatabaseSync#aggregate');
};

DatabaseSync.prototype.createSession = function (options) {
  validateOptionsObject(options);
  this._assertOpen();
  return createSession(this, options ?? {});
};

DatabaseSync.prototype.applyChangeset = function (changeset, options) {
  if (!(typeof Uint8Array !== 'undefined' && changeset instanceof Uint8Array)) {
    throw invalidArgType('The "changeset" argument must be a Uint8Array.');
  }
  validateOptionsObject(options);
  this._assertOpen();
  throw unavailable('DatabaseSync#applyChangeset');
};

DatabaseSync.prototype.createTagStore = function (_maxSize) {
  this._assertOpen();
  // Template-tag store shape; the tag methods would produce fabricated
  // rows, so they throw. `clear()` is pure bookkeeping (a noop here).
  const tagUnavailable = (method) => () => {
    throw unavailable(`TagStore#${method}`);
  };
  return {
    run: tagUnavailable('run'),
    get: tagUnavailable('get'),
    all: tagUnavailable('all'),
    iterate: tagUnavailable('iterate'),
    clear() {},
  };
};

DatabaseSync.prototype.location = function () {
  this._assertOpen();
  return this._location;
};

DatabaseSync.prototype.enableLoadExtension = function (allow) {
  if (typeof allow !== 'boolean') {
    throw invalidArgType('The "allow" argument must be a boolean.');
  }
  this._assertOpen();
  throw unavailable('DatabaseSync#enableLoadExtension');
};

DatabaseSync.prototype.enableDefensive = function (active) {
  if (typeof active !== 'boolean') {
    throw invalidArgType('The "active" argument must be a boolean.');
  }
  this._assertOpen();
  throw unavailable('DatabaseSync#enableDefensive');
};

DatabaseSync.prototype.loadExtension = function (path, _entryPoint) {
  validatePath(path);
  this._assertOpen();
  throw unavailable('DatabaseSync#loadExtension');
};

DatabaseSync.prototype.serialize = function () {
  this._assertOpen();
  throw unavailable('DatabaseSync#serialize');
};

DatabaseSync.prototype.deserialize = function (buffer) {
  if (!(typeof Uint8Array !== 'undefined' && buffer instanceof Uint8Array)) {
    throw invalidArgType('The "buffer" argument must be a Uint8Array.');
  }
  this._assertOpen();
  throw unavailable('DatabaseSync#deserialize');
};

DatabaseSync.prototype.setAuthorizer = function (callback) {
  if (callback !== null && callback !== undefined && typeof callback !== 'function') {
    throw invalidArgType('The "callback" argument must be a function or null.');
  }
  this._assertOpen();
  throw unavailable('DatabaseSync#setAuthorizer');
};

DatabaseSync.prototype[Symbol.dispose] = function () {
  if (this._isOpen) {
    this.close();
  }
};

// --- backup ----------------------------------------------------------------

function backup(sourceDb, targetPath) {
  if (!(sourceDb instanceof DatabaseSync)) {
    throw invalidArgType('The "sourceDb" argument must be an object.');
  }
  validatePath(targetPath);
  sourceDb._assertOpen();
  throw unavailable('backup');
}

export { DatabaseSync, StatementSync, Session, constants, backup };
export default { DatabaseSync, StatementSync, Session, constants, backup };
