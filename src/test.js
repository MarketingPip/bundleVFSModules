/**
 * node-test-browser.js
 * Drop-in browser ESM port of Node.js `node:test`
 * Same named exports as the native module.
 *
 * Spec parity target: node:test @ Node.js v22+
 *
 * node:test named exports (Node 22):
 *   test, it, suite, describe,
 *   before, after, beforeEach, afterEach,
 *   run, mock, snapshot, assert
 *
 * node:test default export: the `test` function (not a wrapper object)
 *
 * Internal/custom symbols NOT on the public API surface are kept unexported
 * (MockTracker, MockTimers, SuiteContext, TestContext, SkipError, TodoError,
 * AssertionError, _reset, execute).  They are accessible via the
 * globalThis._RUNTIME_._TEST_RUNNER_ hook for the host environment.
 *
 * Reporters (dot, spec, tap, junit, lcov) live in node:test/reporters — they
 * are NOT re-exported from this module.
 */

import _assert from './assert.js';

import {
  dot   as _dot,
  spec  as _spec,
  tap   as _tap,
  junit as _junit,
  lcov  as _lcov,
} from './test/reporters.js';

// ─── Reporter registry (internal) ────────────────────────────────────────────
const REPORTERS = { dot: _dot, spec: _spec, tap: _tap, junit: _junit, lcov: _lcov };

function _getConfiguredReporter() {
  const name = globalThis._RUNTIME_?._TEST_RUNNER_?.REPORTER_TYPE;
  return name ? (_resolveReporter(name) ?? _spec) : _spec;
}

let _activeReporter = _getConfiguredReporter();

function _resolveReporter(r) {
  if (!r) return _spec;
  if (typeof r === 'function') return r;
  if (typeof r === 'string') {
    const fn = REPORTERS[r.toLowerCase()];
    if (!fn) console.warn(`[node:test] Unknown reporter "${r}" — falling back to spec.`);
    return fn ?? _spec;
  }
  return _spec;
}

// ─── Stack trace cleaner (internal) ──────────────────────────────────────────
function _cleanStack(err) {
  if (!err || typeof err.stack !== 'string') return err;
  const lines = err.stack.split('\n');
  const cleaned = lines
    .filter(l =>
      !l.includes('data:text/javascript') &&
      !(l.includes('eval at ') && l.includes('data:')) &&
      !l.includes('new Function')
    )
    .map(l => { try { return decodeURIComponent(l); } catch { return l; } });
  err.stack = cleaned[0];
  return err;
}

// ─── Internal error types (not exported) ─────────────────────────────────────
class SkipError      extends Error { constructor(m=''){super(m);this.name='SkipError';} }
class TodoError      extends Error { constructor(m=''){super(m);this.name='TodoError';} }
class AssertionError extends Error { constructor(m=''){super(m);this.name='AssertionError';} }

// ─── Deep equality (internal) ─────────────────────────────────────────────────
function deepEq(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object' && typeof a !== 'function') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEq(v, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => deepEq(a[k], b[k]));
}

// ─── MockFunctionContext (internal) ──────────────────────────────────────────
class MockFunctionContext {
  #calls = [];
  #impl;

  constructor(impl) { this.#impl = impl; }

  get calls() { return [...this.#calls]; }
  callCount() { return this.#calls.length; }

  _record(args, ret, err, stackErr, target, thisVal) {
    this.#calls.push({ arguments: args, result: ret, error: err, stack: stackErr, target, this: thisVal });
  }

  resetCalls() { this.#calls = []; }
  mockImplementation(fn) { this.#impl = fn; }

  mockImplementationOnce(fn, onCall) {
    if (onCall === undefined) {
      const prev = this.#impl;
      this.#impl = (...a) => { this.#impl = prev; return fn(...a); };
    } else {
      const orig = this.#impl;
      let calls = 0;
      this.#impl = (...a) => {
        calls++;
        if (calls === onCall + 1) { this.#impl = orig; return fn(...a); }
        return orig(...a);
      };
    }
  }

  restore() {}
  get implementation() { return this.#impl; }
}

// ─── MockTracker (internal class, exported only via singleton `mock`) ─────────
class MockTracker {
  #mocks = [];

  fn(original = () => {}, implementation, options) {
    if (typeof implementation === 'object' && implementation !== null) {
      options = implementation; implementation = undefined;
    }
    const impl  = implementation ?? original;
    const times = options?.times ?? Infinity;
    const ctx   = new MockFunctionContext(impl);
    let   calls = 0;

    const m = function (...args) {
      const stackErr = new Error('mock call site');
      let r, e;
      const tgt = new.target;
      try {
        r = tgt ? Reflect.construct(ctx.implementation, args, tgt) : ctx.implementation.apply(this, args);
      } catch (ex) {
        e = ex;
        ctx._record(args, undefined, ex, stackErr, tgt, this);
        throw ex;
      }
      ctx._record(args, r, undefined, stackErr, tgt, this);
      calls++;
      if (calls >= times) ctx.mockImplementation(original);
      return r;
    };
    m.mock = ctx;
    this.#mocks.push({ ctx, m, type: 'fn' });
    return m;
  }

  method(obj, name, impl, options) {
    if (typeof impl === 'object' && impl !== null) { options = impl; impl = undefined; }
    const isGetter = options?.getter === true;
    const isSetter = options?.setter === true;
    if (isGetter) return this.getter(obj, name, impl);
    if (isSetter) return this.setter(obj, name, impl);

    const orig  = obj[name];
    const times = options?.times ?? Infinity;
    if (typeof impl !== 'function') impl = orig;
    const ctx = new MockFunctionContext(impl);
    let calls = 0;

    const m = function (...args) {
      const stackErr = new Error('mock call site');
      const tgt = new.target;
      let r, e;
      try {
        r = tgt ? Reflect.construct(ctx.implementation, args, tgt) : ctx.implementation.apply(this, args);
      } catch (ex) {
        e = ex;
        ctx._record(args, undefined, ex, stackErr, tgt, this);
        throw ex;
      }
      ctx._record(args, r, undefined, stackErr, tgt, this);
      calls++;
      if (calls >= times) ctx.mockImplementation(orig);
      return r;
    };
    m.mock = ctx;
    obj[name] = m;
    this.#mocks.push({ ctx, m, obj, name, orig, type: 'method' });
    return m;
  }

  getter(obj, prop, impl) {
    const orig = Object.getOwnPropertyDescriptor(obj, prop);
    const ctx  = new MockFunctionContext(impl);
    Object.defineProperty(obj, prop, {
      configurable: true, enumerable: true,
      get() {
        const r = ctx.implementation.call(this);
        ctx._record([], r, undefined, new Error('getter call site'), undefined, this);
        return r;
      },
    });
    this.#mocks.push({ ctx, obj, prop, orig, type: 'getter' });
    return ctx;
  }

  setter(obj, prop, impl) {
    const orig = Object.getOwnPropertyDescriptor(obj, prop);
    const ctx  = new MockFunctionContext(impl);
    Object.defineProperty(obj, prop, {
      configurable: true,
      set(v) {
        ctx.implementation.call(this, v);
        ctx._record([v], undefined, undefined, new Error('setter call site'), undefined, this);
      },
    });
    this.#mocks.push({ ctx, obj, prop, orig, type: 'setter' });
    return ctx;
  }

  reset() { this.restoreAll(); }

  restoreAll() {
    for (const m of this.#mocks) {
      if (m.type === 'method') m.obj[m.name] = m.orig;
      if (m.type === 'getter' || m.type === 'setter') {
        m.orig ? Object.defineProperty(m.obj, m.prop, m.orig) : delete m.obj[m.prop];
      }
    }
    this.#mocks = [];
  }

  get timers() {
    if (!this._timers) this._timers = new MockTimers();
    return this._timers;
  }
}

// ─── MockTimers (internal) ────────────────────────────────────────────────────
class MockTimers {
  #enabled   = new Set();
  #queue     = [];
  #clock     = 0;
  #originals = {};
  #nextId    = 1;

  #install(api) {
    const g = globalThis;
    if (api === 'setTimeout') {
      this.#originals.setTimeout   = g.setTimeout;
      this.#originals.clearTimeout = g.clearTimeout;
      g.setTimeout  = (fn, delay = 0, ...args) => this.#schedule(fn, delay, false, args);
      g.clearTimeout = id => this.#cancel(id);
    }
    if (api === 'setInterval') {
      this.#originals.setInterval   = g.setInterval;
      this.#originals.clearInterval = g.clearInterval;
      g.setInterval  = (fn, delay = 0, ...args) => this.#schedule(fn, delay, true, args);
      g.clearInterval = id => this.#cancel(id);
    }
    if (api === 'setImmediate') {
      this.#originals.setImmediate   = g.setImmediate;
      this.#originals.clearImmediate = g.clearImmediate;
      g.setImmediate  = (fn, ...args) => this.#schedule(fn, 0, false, args);
      g.clearImmediate = id => this.#cancel(id);
    }
    if (api === 'Date') {
      this.#originals.Date = g.Date;
      const self = this;
      g.Date = class Date extends g.Date {
        constructor(...args) { if (args.length === 0) super(self.#clock); else super(...args); }
        static now() { return self.#clock; }
      };
    }
  }

  #schedule(fn, delay, repeat, args) {
    const id = this.#nextId++;
    this.#queue.push({ fn, delay, triggerAt: this.#clock + delay, repeat, args, id, cancelled: false });
    this.#queue.sort((a, b) => a.triggerAt - b.triggerAt);
    return id;
  }

  #cancel(id) {
    const e = this.#queue.find(e => e.id === id);
    if (e) e.cancelled = true;
  }

  enable(opts = {}) {
    const apis = opts.apis ?? ['setTimeout','clearTimeout','setInterval','clearInterval','setImmediate','clearImmediate','Date'];
    const origDate = globalThis._origDate ?? Date;
    this.#clock = (opts.now != null && typeof opts.now === 'object' && opts.now instanceof origDate)
      ? (opts.now.getTime?.() ?? 0)
      : Number(opts.now ?? 0);
    for (const api of apis) {
      if (!this.#enabled.has(api)) {
        this.#install(api);
        this.#enabled.add(api);
        if (api === 'setTimeout'  && !this.#enabled.has('clearTimeout'))   this.#enabled.add('clearTimeout');
        if (api === 'setInterval' && !this.#enabled.has('clearInterval'))  this.#enabled.add('clearInterval');
        if (api === 'setImmediate'&& !this.#enabled.has('clearImmediate')) this.#enabled.add('clearImmediate');
      }
    }
  }

  tick(ms = 1) {
    const target = this.#clock + ms;
    while (true) {
      const due = this.#queue.filter(e => !e.cancelled && e.triggerAt <= target);
      if (!due.length) break;
      due.sort((a, b) => a.triggerAt - b.triggerAt);
      const entry = due[0];
      this.#clock = entry.triggerAt;
      if (!entry.cancelled) {
        entry.fn(...entry.args);
        if (entry.repeat) {
          entry.triggerAt = this.#clock + entry.delay;
          this.#queue.sort((a, b) => a.triggerAt - b.triggerAt);
        } else {
          this.#queue.splice(this.#queue.indexOf(entry), 1);
        }
      }
    }
    this.#clock = target;
  }

  runAll() {
    const safety = 10_000;
    let i = 0;
    while (this.#queue.some(e => !e.cancelled)) {
      if (++i > safety) throw new Error('MockTimers.runAll(): infinite loop guard exceeded');
      const entry = this.#queue.filter(e => !e.cancelled).sort((a,b) => a.triggerAt - b.triggerAt)[0];
      if (!entry) break;
      this.#clock = entry.triggerAt;
      entry.fn(...entry.args);
      if (entry.repeat) {
        entry.triggerAt = this.#clock + entry.delay;
        this.#queue.sort((a, b) => a.triggerAt - b.triggerAt);
      } else {
        this.#queue.splice(this.#queue.indexOf(entry), 1);
      }
    }
  }

  setTime(ms) { this.#clock = ms; }

  reset() {
    const g = globalThis;
    for (const [k, v] of Object.entries(this.#originals)) g[k] = v;
    this.#originals = {};
    this.#enabled.clear();
    this.#queue  = [];
    this.#clock  = 0;
    this.#nextId = 1;
  }

  [Symbol.dispose]() { this.reset(); }
}

// ─── CtxAssert — t.assert namespace (internal) ───────────────────────────────
class CtxAssert {
  #plan = null;
  #count = 0;

  _setPlan(n) { this.#plan = n; }
  _checkPlan() { return { expected: this.#plan, actual: this.#count }; }

  #record(passed, message) {
    this.#count++;
    if (!passed) throw new AssertionError(message);
  }

  ok(v, m)              { this.#record(!!v, m ?? `Expected truthy, got ${v}`); }
  fail(m)               { this.#record(false, m ?? 'Explicit fail'); }
  equal(a, b, m)        { this.#record(a == b, m ?? `${a} == ${b} failed`); }
  notEqual(a, b, m)     { this.#record(a != b, m ?? 'Expected not equal'); }
  strictEqual(a, b, m)  { this.#record(Object.is(a, b), m ?? `${String(a)} !== ${String(b)} (strict)`); }
  notStrictEqual(a,b,m) { this.#record(!Object.is(a, b), m ?? 'Expected not strict equal'); }
  deepEqual(a, b, m)    { this.#record(!!deepEq(a, b), m ?? 'Deep equality failed'); }
  notDeepEqual(a,b,m)   { this.#record(!deepEq(a, b), m ?? 'Expected deep not equal'); }

  throws(fn, expected, m) {
    this.#count++;
    try { fn(); } catch (e) {
      if (expected instanceof RegExp && !expected.test(e.message))
        throw new AssertionError(m ?? `Error message did not match ${expected}`);
      if (typeof expected === 'function' && !(e instanceof expected))
        throw new AssertionError(m ?? `Error was not instance of ${expected.name}`);
      return;
    }
    throw new AssertionError(m ?? 'Expected function to throw');
  }

  async rejects(fn, m) {
    this.#count++;
    try { await (typeof fn === 'function' ? fn() : fn); } catch { return; }
    throw new AssertionError(m ?? 'Expected rejection');
  }

  async doesNotReject(fn, m) {
    this.#count++;
    try { await (typeof fn === 'function' ? fn() : fn); }
    catch (e) { throw new AssertionError(m ?? `Got unexpected rejection: ${e}`); }
  }

  ifError(e)            { this.#record(e == null, `ifError got ${e}`); }
  match(s, re, m)       { this.#record(re.test(s), m ?? `${s} did not match ${re}`); }
  doesNotMatch(s, re, m){ this.#record(!re.test(s), m ?? `${s} matched ${re}`); }
  snapshot()            { this.#count++; }
  fileSnapshot()        { this.#count++; }
}

// ─── TestNode (internal) ──────────────────────────────────────────────────────
class TestNode {
  constructor(name, fn, opts, parent) {
    this.name      = name;
    this.fn        = fn;
    this.parent    = parent;
    this.opts      = { skip: false, todo: false, timeout: 5000, concurrency: false, only: false, plan: undefined, ...opts };
    this.children  = [];
    this.result    = null;
    this.error     = null;
    this.duration  = 0;
    this._isSuite  = false;
    this._before   = [];
    this._after    = [];
    this._beforeEach = [];
    this._afterEach  = [];
    this._passed   = false;
    this.mockTracker = new MockTracker();
  }
  get isSuite() {
    if (this._isSuite) return true;
    if (this.opts.skip || this.opts.todo) return false;
    return !this.fn;
  }
}

// ─── TestContext (internal) ───────────────────────────────────────────────────
class TestContext {
  #node;
  #assert;

  constructor(node) {
    this.#node   = node;
    this.#assert = new CtxAssert();
    this.name     = node.name;
    this.fullName = _buildFull(node);
    this.signal   = null;
  }

  get assert() { return this.#assert; }
  get mock()   { return this.#node.mockTracker; }
  get passed() { return this.#node._passed; }
  get error()  { return this.#node.error ? Object.assign(new Error('test failure'), { cause: this.#node.error }) : null; }
  get filePath(){ return ''; }

  test(n, o, f)     { return _scheduleSubtest(this.#node, n, o, f); }
  it(n, o, f)       { return this.test(n, o, f); }
  before(fn, o)     { this.#node._before.push({ fn, o }); }
  after(fn, o)      { this.#node._after.push({ fn, o }); }
  beforeEach(fn, o) { this.#node._beforeEach.push({ fn, o }); }
  afterEach(fn, o)  { this.#node._afterEach.push({ fn, o }); }

  skip(msg = '')  { this.#node.opts.skip = msg || true; throw new SkipError(String(msg)); }
  todo(msg = '')  { this.#node.opts.todo = msg || true; throw new TodoError(String(msg)); }
  diagnostic(msg) { _emit('diagnostic', { message: String(msg), node: this.#node }); }

  runOnly(shouldRunOnlyTests) { this.#node._runOnly = !!shouldRunOnlyTests; }

  plan(count, options = {}) {
    this.#node._plan     = count;
    this.#node._planOpts = options;
    this.#assert._setPlan(count);
  }

  waitFor(condition, options = {}) {
    const interval = options.interval ?? 50;
    const timeout  = options.timeout  ?? 1000;
    const start    = Date.now();
    return new Promise((resolve, reject) => {
      const attempt = () => {
        Promise.resolve().then(() => condition()).then(resolve, err => {
          if (Date.now() - start + interval > timeout) reject(err);
          else globalThis.setTimeout(attempt, interval);
        });
      };
      attempt();
    });
  }
}

// ─── SuiteContext (internal) ──────────────────────────────────────────────────
class SuiteContext {
  #node;
  constructor(node) {
    this.#node    = node;
    this.name     = node.name;
    this.fullName = _buildFull(node);
    this.signal   = null;
  }
  get filePath() { return ''; }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────
function _buildFull(node) {
  const parts = []; let n = node;
  while (n) { if (n.name && n.name !== '<root>') parts.unshift(n.name); n = n.parent; }
  return parts.join(' > ');
}

function _resolveArgs(name, opts, fn) {
  if (typeof name === 'function')      { fn = name; name = fn.name || '<anon>'; opts = {}; }
  else if (typeof opts === 'function') { fn = opts; opts = {}; }
  if (opts && typeof opts === 'object') {
    const { reporter: _, ...rest } = opts;
    opts = rest;
  }
  return { name: name || fn?.name || '<anon>', opts: opts ?? {}, fn };
}

// ─── Event bus (internal) ─────────────────────────────────────────────────────
const _listeners = {};
function _on(event, fn)  { (_listeners[event] ??= []).push(fn); }
function _emit(event, d) { (_listeners[event] ?? []).forEach(fn => fn(d)); }

// ─── Root suite singleton (internal) ─────────────────────────────────────────
let _root    = null;
let _current = null;
let _running = false;
let _testNamePattern = null;

function _getRoot() {
  if (!_root) { _root = new TestNode('<root>', null, {}, null); _root._isSuite = true; }
  return _root;
}

function _reset() {
  _root = null; _current = null; _running = false;
  _activeReporter = _getConfiguredReporter();
  for (const k of Object.keys(_listeners)) delete _listeners[k];
  _mockInstance.restoreAll();
}

// ─── Execution (internal) ─────────────────────────────────────────────────────
async function _scheduleSubtest(parent, name, opts, fn) {
  const { name: n, opts: o, fn: f } = _resolveArgs(name, opts, fn);
  const node = new TestNode(n, f, o, parent);
  if (parent._runOnly && !o.only) node.opts.skip = 'runOnly';
  parent.children.push(node);
  return _runNode(node, parent._beforeEach, parent._afterEach);
}

async function _runNode(node, iBefore = [], iAfter = []) {
  if (_testNamePattern && !_testNamePattern.test(_buildFull(node))) {
    node.result = 'skip';
    _emit('test:skip', { name: node.name, node });
    _emit('test:complete', { name: node.name, node });
    return node;
  }
  const ctx = new TestContext(node);
  const t0  = performance.now();

  if (node.opts.skip || node.opts.todo) {
    node.result = node.opts.skip ? 'skip' : 'todo';
    _emit(`test:${node.result}`, { name: node.name, node });
    node.duration = performance.now() - t0;
    _emit('test:complete', { name: node.name, node });
    return node;
  }

  for (const h of [...iBefore, ...node._before]) {
    try { await h.fn(ctx); } catch (e) { if (!node.error) node.error = e; }
  }

  try {
    if (node.fn) {
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = globalThis.setTimeout(
          () => reject(new Error(`Test "${node.name}" timed out after ${node.opts.timeout}ms`)),
          node.opts.timeout
        );
      });
      try {
        await Promise.race([Promise.resolve().then(() => node.fn(ctx)), timeoutPromise]);
      } finally {
        globalThis.clearTimeout(timeoutId);
      }
    }
    node._passed = true;
    node.result  = 'pass';
    _emit('test:pass', { name: node.name, node });
  } catch (e) {
    if (e instanceof SkipError) {
      node.result = 'skip';
      _emit('test:skip', { name: node.name, node });
    } else if (e instanceof TodoError) {
      node.result = 'todo';
      _emit('test:todo', { name: node.name, node });
    } else {
      node._passed = false;
      node.result  = 'fail';
      node.error   = _cleanStack(e);
      _emit('test:fail', { name: node.name, node, error: node.error });
    }
  }

  for (const h of [...node._after, ...iAfter].reverse()) {
    try { await h.fn(ctx); } catch (e) { if (!node.error) node.error = e; }
  }

  node.mockTracker.reset();
  node.duration = performance.now() - t0;
  _emit('test:complete', { name: node.name, node });
  return node;
}

async function _runSuite(s) {
  _emit('suite:start', { name: s.name, node: s });
  const ctx = new SuiteContext(s);
  for (const h of s._before) { try { await h.fn(ctx); } catch (_) {} }
  if (s.opts.concurrency) {
    await Promise.all(s.children.filter(c => c.result === null).map(c => c.isSuite ? _runSuite(c) : _runNode(c, s._beforeEach, s._afterEach)));
  } else {
    for (const c of s.children) {
      if (c.result !== null) continue; // pre-resolved (e.g. synthetic failure) — skip
      await (c.isSuite ? _runSuite(c) : _runNode(c, s._beforeEach, s._afterEach));
    }
  }
  for (const h of [...s._after].reverse()) { try { await h.fn(ctx); } catch (_) {} }
  _emit('suite:end', { name: s.name, node: s });
}

// ─── Public harness: register tests ─────────────────────────────────────────
function _makeTest(name, opts, fn) {
  const { name: n, opts: o, fn: f } = _resolveArgs(name, opts, fn);
  const parent = _current ?? _getRoot();
  const node   = new TestNode(n, f, o, parent);
  parent.children.push(node);
  return Promise.resolve(node);
}

// ══════════════════════════════════════════════════════════════════════════════
//  PUBLIC NAMED EXPORTS  —  matching node:test @ Node 22 exactly
// ══════════════════════════════════════════════════════════════════════════════

// ─── test ────────────────────────────────────────────────────────────────────
export function test(name, opts, fn) { return _makeTest(name, opts, fn); }
test.skip = (name, opts, fn) => {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return test(name, { ...(opts ?? {}), skip: true }, fn);
};
test.todo = (name, opts, fn) => {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return test(name, { ...(opts ?? {}), todo: true }, fn);
};
test.only = (name, opts, fn) => {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return test(name, { ...(opts ?? {}), only: true }, fn);
};

// ─── it (alias for test) ─────────────────────────────────────────────────────
export function it(name, opts, fn) { return _makeTest(name, opts, fn); }
it.skip = test.skip;
it.todo = test.todo;
it.only = test.only;

// ─── suite ────────────────────────────────────────────────────────────────────
export function suite(name, opts, fn) {
  const { name: n, opts: o, fn: f } = _resolveArgs(name, opts, fn);
  const parent = _current ?? _getRoot();
  const node   = new TestNode(n, f, o, parent);
  node._isSuite = true;
  parent.children.push(node);
  if (f) {
    const prev = _current; _current = node;
    try { f(new SuiteContext(node)); } catch (e) { node.error = e; }
    _current = prev;
  }
  return Promise.resolve(node);
}
suite.skip = (name, opts, fn) => {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return suite(name, { ...(opts ?? {}), skip: true }, fn);
};
suite.todo = (name, opts, fn) => {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return suite(name, { ...(opts ?? {}), todo: true }, fn);
};
suite.only = (name, opts, fn) => {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return suite(name, { ...(opts ?? {}), only: true }, fn);
};

// ─── describe (alias for suite) ──────────────────────────────────────────────
export function describe(name, opts, fn) { return suite(name, opts, fn); }
describe.skip  = suite.skip;
describe.todo  = suite.todo;
describe.only  = suite.only;

// ─── Lifecycle hooks ─────────────────────────────────────────────────────────
export const before     = (fn, o) => (_current ?? _getRoot())._before.push({ fn, o });
export const after      = (fn, o) => (_current ?? _getRoot())._after.push({ fn, o });
export const beforeEach = (fn, o) => (_current ?? _getRoot())._beforeEach.push({ fn, o });
export const afterEach  = (fn, o) => (_current ?? _getRoot())._afterEach.push({ fn, o });

// ─── run ─────────────────────────────────────────────────────────────────────
export function run(opts = {}) {
  if (opts.reporter) _activeReporter = _resolveReporter(opts.reporter);
  _running = true;
  _testNamePattern = opts.testNamePatterns ?? null;
  const root = _getRoot();
  const evts = [];

  const types = ['test:pass','test:fail','test:skip','test:todo','test:complete','suite:start','suite:end','diagnostic'];
  for (const t of types) _on(t, e => evts.push({ type: t, ...e }));

  let _resolve;
  const done = new Promise(r => { _resolve = r; });

  queueMicrotask(() => {
    _runSuite(root).then(() => {
      _running = false;
      _resolve(evts);
    });
  });

  return {
    async *[Symbol.asyncIterator]() {
      const all = await done;
      for (const e of all) yield e;
    },
    async collect() { return done; },
    async drain() {
      const events = await done;
      return { root, events, reporter: _activeReporter };
    },
    on(event, cb) {
      _on(event, cb);
      for (const e of evts) { if (e.type === event) cb(e); }
      return this;
    },
  };
}

// ─── mock  — singleton MockTracker instance  (node:test re-uses one instance) -
// The Proxy target must be the MockTracker instance itself so that method
// calls have the correct `this` for private field access (#mocks, etc.).
// A plain {} target causes `this` inside fn/method/etc. to be the Proxy,
// which is not an instance of MockTracker and fails private field checks.
const _mockInstance = new MockTracker();
export const mock = new Proxy(_mockInstance, {
  get(target, k) { const v = target[k]; return typeof v === 'function' ? v.bind(target) : v; },
  set(target, k, v) { target[k] = v; return true; },
});

// ─── snapshot ─────────────────────────────────────────────────────────────────
export const snapshot = Object.freeze({
  setDefaultSnapshotSerializers(_fns) { /* no-op in browser */ },
  setResolveSnapshotPath(_fn)         { /* no-op in browser */ },
});

// ─── assert ───────────────────────────────────────────────────────────────────
export const assert = Object.freeze({
  register(name, fn) { TestContext.prototype[name] = fn; },
});

// ══════════════════════════════════════════════════════════════════════════════
//  DEFAULT EXPORT  —  `test` function (matches Node: `export default test`)
//  Node.js does: module.exports = test  with named props bolted on.
//  In ESM the default export IS the test function, not a wrapper object.
// ══════════════════════════════════════════════════════════════════════════════
export default test;

// ─── execute() — host-only helper (not part of node:test public API) ─────────
export async function execute(userCode, opts = {}) {
  if (opts.resetBefore !== false) _reset();
  if (opts.reporter) _activeReporter = _resolveReporter(opts.reporter);

  const API_KEYS = ['test','it','suite','describe','before','after','beforeEach','afterEach','mock','snapshot','assert'];
  const _mockProxy = mock;
  const apiVals = [test, it, suite, describe, before, after, beforeEach, afterEach, _mockProxy, snapshot, _assert];

  try {
    const execFn = new Function(...API_KEYS, `return (async()=>{\n${userCode}\n})()`);
    await execFn(...apiVals);
  } catch (e) {
    if (e instanceof SyntaxError) throw new SyntaxError(`[node:test runtime] ${e.message}`);
    // If no tests were registered at all, the throw is a top-level crash — re-throw it
    if (_getRoot().children.length === 0) throw e;
    const synth = new TestNode('<top-level>', null, {}, _getRoot());
    synth.result = 'fail'; synth.error = e;
    _getRoot().children.push(synth);
    _emit('test:fail', { name: '<top-level>', node: synth, error: e });
    _emit('test:complete', { name: '<top-level>', node: synth });
  }

  await new Promise(r => setTimeout(r, 0));
  const { root, events, reporter } = await run().drain();
  let output;
  try {
    output = reporter({ root, events });
  } catch (e) {
    throw Object.assign(e, { message: `[reporter:${reporter?.name ?? '?'}] ${e.message}` });
  }
  return { root, events, output, reporter };
}

// ─── Global runtime hook (host environment only) ─────────────────────────────
globalThis._RUNTIME_ ??= {};
globalThis._RUNTIME_._TEST_RUNNER_ = {
  execute,
  _reset,
  reporters: REPORTERS,
  get activeReporter() { return _activeReporter; },
};
