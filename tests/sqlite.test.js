// tests/sqlite.test.js — repo tests for src/sqlite.js.
//
// `node:sqlite` has no SQLite engine in a browser, so src/sqlite.js is an
// honest stub: exact export shapes, Node-identical argument validation and
// lifecycle errors, but every method that would need a live engine (or would
// fabricate database data) throws
//   Error('node:sqlite is not available in this browser runtime')
// with `err.code === 'ERR_SQLITE_UNAVAILABLE'`.

import {
  DatabaseSync,
  StatementSync,
  Session,
  constants,
  backup,
} from '../src/sqlite.js';
import * as sqliteNS from '../src/sqlite.js';
import sqliteDefault from '../src/sqlite.js';

const UNAVAILABLE = 'node:sqlite is not available in this browser runtime';

function expectUnavailable(fn) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toBe(UNAVAILABLE);
  expect(err.code).toBe('ERR_SQLITE_UNAVAILABLE');
}

describe('module shape', () => {
  test('named exports exist', () => {
    expect(typeof DatabaseSync).toBe('function');
    expect(typeof StatementSync).toBe('function');
    expect(typeof Session).toBe('function');
    expect(typeof constants).toBe('object');
    expect(typeof backup).toBe('function');
  });

  test('default export carries the named exports (CJS require interop)', () => {
    for (const name of ['DatabaseSync', 'StatementSync', 'Session', 'constants', 'backup']) {
      expect(sqliteDefault[name]).toBe(sqliteNS[name]);
    }
  });

  test('DatabaseSync has the full Node v24 method surface', () => {
    const methods = [
      'open', 'close', 'prepare', 'exec', 'function', 'createTagStore',
      'location', 'aggregate', 'createSession', 'applyChangeset',
      'enableLoadExtension', 'enableDefensive', 'loadExtension',
      'serialize', 'deserialize', 'setAuthorizer',
    ];
    for (const m of methods) {
      expect(typeof DatabaseSync.prototype[m]).toBe('function');
    }
    expect(typeof DatabaseSync.prototype[Symbol.dispose]).toBe('function');
  });

  test('StatementSync has the full Node v24 method surface', () => {
    for (const m of [
      'iterate', 'all', 'get', 'run', 'columns',
      'setAllowBareNamedParameters', 'setAllowUnknownNamedParameters',
      'setReadBigInts', 'setReturnArrays',
    ]) {
      expect(typeof StatementSync.prototype[m]).toBe('function');
    }
  });

  test('Session has the full Node v24 method surface', () => {
    for (const m of ['changeset', 'patchset', 'close']) {
      expect(typeof Session.prototype[m]).toBe('function');
    }
  });

  test('constants match Node v24.20.0 values (spot check)', () => {
    expect(constants.SQLITE_OK).toBe(0);
    expect(constants.SQLITE_DENY).toBe(1);
    expect(constants.SQLITE_IGNORE).toBe(2);
    expect(constants.SQLITE_CHANGESET_OMIT).toBe(0);
    expect(constants.SQLITE_CHANGESET_REPLACE).toBe(1);
    expect(constants.SQLITE_CHANGESET_ABORT).toBe(2);
    expect(constants.SQLITE_CHANGESET_DATA).toBe(1);
    expect(constants.SQLITE_CHANGESET_NOTFOUND).toBe(2);
    expect(constants.SQLITE_CHANGESET_CONFLICT).toBe(3);
    expect(constants.SQLITE_CHANGESET_CONSTRAINT).toBe(4);
    expect(constants.SQLITE_CHANGESET_FOREIGN_KEY).toBe(5);
    expect(constants.SQLITE_CREATE_TABLE).toBe(2);
    expect(constants.SQLITE_INSERT).toBe(18);
    expect(constants.SQLITE_SELECT).toBe(21);
    expect(constants.SQLITE_COPY).toBe(0);
    expect(constants.SQLITE_RECURSIVE).toBe(33);
    expect(constants.SQLITE_SAVEPOINT).toBe(32);
  });

  test('toString tags match real Node ([object Object])', () => {
    const db = new DatabaseSync(':memory:');
    expect(Object.prototype.toString.call(db)).toBe('[object Object]');
    expect(Object.prototype.toString.call(db.prepare('SELECT 1'))).toBe('[object Object]');
    db.close();
  });
});

describe('DatabaseSync constructor', () => {
  test('requires a path (Node-identical TypeError)', () => {
    expect(() => new DatabaseSync()).toThrow(expect.objectContaining({
      code: 'ERR_INVALID_ARG_TYPE',
    }));
    expect(() => new DatabaseSync()).toThrow(/"path" argument must be a string, Uint8Array, or URL/);
    expect(() => new DatabaseSync(123)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });

  test('accepts string, Uint8Array, URL paths', () => {
    expect(() => new DatabaseSync(':memory:')).not.toThrow();
    expect(() => new DatabaseSync(new Uint8Array([1, 2]))).not.toThrow();
    expect(() => new DatabaseSync(new URL('file:///tmp/x.db'))).not.toThrow();
  });

  test('options must be an object; boolean options are validated', () => {
    expect(() => new DatabaseSync(':memory:', 42)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => new DatabaseSync(':memory:', { readOnly: 'yes' })).toThrow(/"options.readOnly" argument must be a boolean/);
    expect(() => new DatabaseSync(':memory:', { open: 1 })).toThrow(/"options.open" argument must be a boolean/);
    expect(() => new DatabaseSync(':memory:', { enableForeignKeyConstraints: 0 })).toThrow(/must be a boolean/);
    expect(() => new DatabaseSync(':memory:', { enableDoubleQuotedStringLiterals: null })).toThrow(/must be a boolean/);
    expect(() => new DatabaseSync(':memory:', { timeout: 1.5 })).toThrow(/"options.timeout" argument must be an integer/);
  });

  test('unknown options are ignored (like Node)', () => {
    expect(() => new DatabaseSync(':memory:', { bogus: 1 })).not.toThrow();
  });

  test('open defaults to true; open:false stays closed without opening anything', () => {
    const db = new DatabaseSync(':memory:');
    expect(db.isOpen).toBe(true);
    const closed = new DatabaseSync(':memory:', { open: false });
    expect(closed.isOpen).toBe(false);
  });

  test('isTransaction is false; limits carry SQLite defaults', () => {
    const db = new DatabaseSync(':memory:');
    expect(db.isTransaction).toBe(false);
    expect(db.limits.length).toBe(1000000000);
    expect(db.limits.variableNumber).toBe(32766);
    expect(Object.keys(db.limits)).toHaveLength(11);
    db.close();
  });

  test('location() echoes the path, null for :memory:', () => {
    const mem = new DatabaseSync(':memory:');
    expect(mem.location()).toBeNull();
    mem.close();
    const file = new DatabaseSync('/tmp/x.db');
    expect(file.location()).toBe('/tmp/x.db');
    file.close();
  });
});

describe('open/close lifecycle mirrors Node', () => {
  test('close() then open() then close()', () => {
    const db = new DatabaseSync(':memory:', { open: false });
    expect(() => db.close()).toThrow(expect.objectContaining({ code: 'ERR_INVALID_STATE' }));
    expect(() => db.close()).toThrow('database is not open');
    db.open();
    expect(db.isOpen).toBe(true);
    expect(() => db.open()).toThrow('database is already open');
    db.close();
    expect(db.isOpen).toBe(false);
  });

  test('Symbol.dispose closes an open database, noops when closed', () => {
    const db = new DatabaseSync(':memory:');
    db[Symbol.dispose]();
    expect(db.isOpen).toBe(false);
    expect(() => db[Symbol.dispose]()).not.toThrow();
  });

  test('engine methods on a closed db throw ERR_INVALID_STATE (not unavailable)', () => {
    const db = new DatabaseSync(':memory:', { open: false });
    expect(() => db.exec('SELECT 1')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_STATE' }));
    expect(() => db.prepare('SELECT 1')).toThrow('database is not open');
    expect(() => db.location()).toThrow('database is not open');
  });
});

describe('data methods throw the documented unavailable error', () => {
  let db;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
  });
  afterEach(() => {
    if (db.isOpen) db.close();
  });

  test('exec() validates args, then throws unavailable (never pretends to run)', () => {
    expect(() => db.exec(123)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expectUnavailable(() => db.exec('CREATE TABLE t (x)'));
  });

  test('prepare() returns a StatementSync shape; SQL text getters work', () => {
    expect(() => db.prepare()).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    const stmt = db.prepare('SELECT 1 AS one');
    expect(stmt).toBeInstanceOf(StatementSync);
    expect(stmt.sourceSQL).toBe('SELECT 1 AS one');
    expect(stmt.expandedSQL).toBe('SELECT 1 AS one');
    expect(Object.getOwnPropertyNames(stmt)).toContain('sourceSQL');
  });

  test('statement data methods throw unavailable, never fake rows', () => {
    const stmt = db.prepare('SELECT 1');
    expectUnavailable(() => stmt.get());
    expectUnavailable(() => stmt.all());
    expectUnavailable(() => stmt.run());
    expectUnavailable(() => stmt.iterate().next());
    expectUnavailable(() => stmt.columns());
  });

  test('statement config setters throw unavailable', () => {
    const stmt = db.prepare('SELECT 1');
    expectUnavailable(() => stmt.setReadBigInts(true));
    expectUnavailable(() => stmt.setReturnArrays(true));
    expectUnavailable(() => stmt.setAllowBareNamedParameters(true));
    expectUnavailable(() => stmt.setAllowUnknownNamedParameters(true));
  });

  test('statements are finalized when the db closes (Node-identical state error)', () => {
    const stmt = db.prepare('SELECT 1');
    db.close();
    expect(() => stmt.get()).toThrow(expect.objectContaining({ code: 'ERR_INVALID_STATE' }));
    expect(() => stmt.get()).toThrow('statement has been finalized');
  });

  test('direct construction of StatementSync/Session is illegal (like Node)', () => {
    expect(() => new StatementSync()).toThrow(expect.objectContaining({ code: 'ERR_ILLEGAL_CONSTRUCTOR' }));
    expect(() => new StatementSync()).toThrow('Illegal constructor');
    expect(() => new Session()).toThrow(expect.objectContaining({ code: 'ERR_ILLEGAL_CONSTRUCTOR' }));
  });

  test('calling DatabaseSync without new throws ERR_CONSTRUCT_CALL_REQUIRED', () => {
    expect(() => DatabaseSync(':memory:')).toThrow(expect.objectContaining({
      code: 'ERR_CONSTRUCT_CALL_REQUIRED',
    }));
    expect(() => DatabaseSync(':memory:')).toThrow(/Cannot call constructor without `new`/);
  });

  test('instances carry the sqlite-type symbol tag', () => {
    const db = new DatabaseSync(':memory:');
    expect(db[Symbol.for('sqlite-type')]).toBe('node:sqlite');
    db.close();
  });

  test('statement/data option flags are boolean-validated', () => {
    for (const key of ['readBigInts', 'returnArrays', 'allowBareNamedParameters', 'allowUnknownNamedParameters']) {
      expect(() => new DatabaseSync(':memory:', { [key]: 42 })).toThrow(
        `"options.${key}" argument must be a boolean`,
      );
    }
    expect(() => new DatabaseSync(':memory:', {
      readBigInts: true, returnArrays: true,
      allowBareNamedParameters: true, allowUnknownNamedParameters: true,
    })).not.toThrow();
  });

  test('engine config methods throw unavailable after validation', () => {
    expect(() => db.function()).toThrow(/"name" argument must be a string/);
    expect(() => db.function('f', 42)).toThrow(/"function" argument must be a function/);
    expectUnavailable(() => db.function('f', () => {}));
    expectUnavailable(() => db.aggregate('a', { start: 0, step: () => 0 }));
    expectUnavailable(() => db.createTagStore(10).run`SELECT 1`);
    expectUnavailable(() => db.enableLoadExtension(true));
    expectUnavailable(() => db.enableDefensive(true));
    expectUnavailable(() => db.loadExtension('/tmp/ext.so'));
    expectUnavailable(() => db.serialize());
    expectUnavailable(() => db.deserialize(new Uint8Array([1])));
    expectUnavailable(() => db.setAuthorizer(() => 0));
    expect(() => db.setAuthorizer('x')).toThrow(/"callback" argument must be a function or null/);
  });

  test('createSession returns a Session shape; changeset/patchset throw unavailable', () => {
    expect(() => db.createSession(42)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    const session = db.createSession();
    expect(session).toBeInstanceOf(Session);
    expectUnavailable(() => session.changeset());
    expectUnavailable(() => session.patchset());
    expect(() => session.close()).not.toThrow();
  });

  test('applyChangeset validates, then throws unavailable', () => {
    expect(() => db.applyChangeset('x')).toThrow(/"changeset" argument must be a Uint8Array/);
    expectUnavailable(() => db.applyChangeset(new Uint8Array([1, 2, 3])));
  });

  test('backup() validates args, then throws unavailable (never a fake backup)', () => {
    expect(() => backup(42, 'x')).toThrow(/"sourceDb" argument must be an object/);
    expect(() => backup(db)).toThrow(/"path" argument must be a string, Uint8Array, or URL/);
    expectUnavailable(() => backup(db, ':memory:'));
  });
});

// Browser fallback lane: prove the shim needs no native Node builtins.
// Hide process.getBuiltinModule and the host Buffer, then import a
// cache-busted copy and re-run the critical assertions.
describe('browser fallback (no native delegation)', () => {
  let fb;
  let realGbm;
  let realBuffer;
  beforeAll(async () => {
    realGbm = process.getBuiltinModule;
    process.getBuiltinModule = () => {
      throw new Error('native builtins disabled in fallback lane');
    };
    realBuffer = globalThis.Buffer;
    globalThis.Buffer = undefined;
    try {
      fb = await import('../src/sqlite.js?fallback=browser');
    } finally {
      process.getBuiltinModule = realGbm;
      globalThis.Buffer = realBuffer;
    }
  });

  test('module loads with no native builtins', () => {
    expect(typeof fb.DatabaseSync).toBe('function');
    expect(typeof fb.backup).toBe('function');
    expect(fb.constants.SQLITE_OK).toBe(0);
  });

  test('constructor validation works without natives', () => {
    expect(() => new fb.DatabaseSync()).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    const db = new fb.DatabaseSync(':memory:');
    expect(db.isOpen).toBe(true);
    const stmt = db.prepare('SELECT 1');
    expect(stmt.sourceSQL).toBe('SELECT 1');
    let err;
    try {
      stmt.all();
    } catch (e) {
      err = e;
    }
    expect(err && err.code).toBe('ERR_SQLITE_UNAVAILABLE');
    expect(err && err.message).toBe(UNAVAILABLE);
    db.close();
    expect(db.isOpen).toBe(false);
  });

  test('backup validates and throws unavailable without natives', () => {
    const db = new fb.DatabaseSync(':memory:');
    let err;
    try {
      fb.backup(db, ':memory:');
    } catch (e) {
      err = e;
    }
    expect(err && err.code).toBe('ERR_SQLITE_UNAVAILABLE');
    db.close();
  });
});
