/**
 * node-test-browser.js
 * Drop-in browser ESM port of Node.js `node:test`
 * Same named exports as the native module.
 *
 * Spec parity target: node:test @ Node.js v22+
 *
 * node:test named exports (Node 24):
 *   test, it, suite, describe,
 *   before, after, beforeEach, afterEach,
 *   only, skip, todo, expectFailure, getTestContext,
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

// Reporter selection is resolved lazily (per run/execute call), because the
// host may set globalThis._RUNTIME_._TEST_RUNNER_.REPORTER_TYPE after this
// module is imported. _reporterOverride is set by execute({ reporter }).
let _reporterOverride = null;

function _getConfiguredReporter() {
  const RT = (typeof globalThis._RUNTIME_ !== 'undefined') ? globalThis._RUNTIME_ : undefined;
  const name = RT?._TEST_RUNNER_?.REPORTER_TYPE;
  return name ? (_resolveReporter(name) ?? _spec) : _spec;
}

function _resolveActiveReporter() {
  return _reporterOverride ?? _getConfiguredReporter();
}

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
  deepStrictEqual(a, b, m)    { this.#record(!!deepEq(a, b, true), m ?? 'Deep strict equality failed'); }
  notDeepStrictEqual(a,b,m)   { this.#record(!deepEq(a, b, true), m ?? 'Expected deep strict not equal'); }
  doesNotThrow(fn, m) {
    this.#count++;
    try { fn(); } catch (e) { throw new AssertionError(m ?? `Got unexpected throw: ${e}`); }
  }
  partialDeepStrictEqual(a, b, m) { this.#record(!!deepEq(a, b, true), m ?? 'Partial deep strict equality failed'); }

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
    // Node-shaped event fields: skip/todo hold the reason (string) or true.
    // Like real node:test, skipped/todo tests are reported as PASSES carrying
    // these flags — there are no separate 'skip'/'todo' result states.
    this.skip = undefined;
    this.todo = undefined;
    this._testId = ++_testIdCounter;      // numeric, like real node:test
    this._testNumber = ++_testNumberCounter; // stable across start/complete/pass/fail
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

  skip(msg = '')  { this.#node.skip = msg || true; this.#node.todo = undefined; }
  todo(msg = '')  { if (this.#node.skip === undefined) this.#node.todo = msg || true; }
  diagnostic(msg) { _emit('diagnostic', { message: String(msg), node: this.#node }); }

  runOnly(shouldRunOnlyTests) {
    this.#node._runOnly = !!shouldRunOnlyTests;
    // Mirrors Node: runOnly only takes effect with --test-only (here: the
    // testOnly run() option). Otherwise it is ignored with a diagnostic.
    if (shouldRunOnlyTests && !_onlyMode) {
      this.diagnostic(`'only' and 'runOnly' require the testOnly run() option.`);
    }
  }

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
// Events are delivered to listeners as { type, data } — the same shape as
// the stream returned by run() in real Node.js.
const _listeners = {};
function _on(event, fn)  { (_listeners[event] ??= []).push(fn); }
function _emit(type, data) {
  const evt = { type, data };
  (_listeners[type] ?? []).forEach(fn => fn(evt));
}

// ─── Root suite singleton (internal) ─────────────────────────────────────────
let _root    = null;
let _current = null;
let _running = false;
let _testNamePattern = null;
// _onlyMode mirrors node's --test-only: when true, only tests marked with
// `only` (or covered by an only-marked ancestor) execute; everything else is
// silently skipped. Without it, `only` marks are ignored (matches Node).
let _onlyMode = false;
// Stack of TestContexts for getTestContext().
const _contextStack = [];

function _getRoot() {
  if (!_root) { _root = new TestNode('<root>', null, {}, null); _root._isSuite = true; }
  return _root;
}

function _reset() {
  _root = null; _current = null; _running = false;
  _onlyMode = false;
  _reporterOverride = null;
  _contextStack.length = 0;
  for (const k of Object.keys(_listeners)) delete _listeners[k];
  _mockInstance.restoreAll();
}

// ─── only-mode helpers (internal) ────────────────────────────────────────────
function _subtreeHasOnly(node) {
  return (node.children ?? []).some(c => c.opts.only || _subtreeHasOnly(c));
}

// A node is eligible in only-mode when it is marked only itself, has an
// only-marked ancestor, or has an only-marked descendant (suites that merely
// contain an only test still run as containers).
function _onlyEligible(node) {
  for (let n = node; n; n = n.parent) {
    if (n.opts.only) return true;
  }
  return _subtreeHasOnly(node);
}

// ─── Execution (internal) ─────────────────────────────────────────────────────
async function _scheduleSubtest(parent, name, opts, fn) {
  const { name: n, opts: o, fn: f } = _resolveArgs(name, opts, fn);
  const node = new TestNode(n, f, o, parent);
  // t.runOnly(true) narrows this subtree to only-marked subtests — but only
  // when the runner is in only-mode (mirrors Node: runOnly needs --test-only).
  if (parent._runOnly && _onlyMode && !o.only) node._runOnlySkipped = true;
  parent.children.push(node);
  const done = await _runNode(node, parent._beforeEach, parent._afterEach);
  return new TestContext(done);
}

// ─── Node-shaped test events ─────────────────────────────────────────────────
// Real node:test emits `test:complete` BEFORE `test:pass`/`test:fail`, with
// event data shaped like:
//   { name, nesting, testNumber, testId, parentId,
//     details: { duration_ms, type: 'test', error? },
//     skip?, todo?, failureType? }
// The tree node is attached as a NON-enumerable `node` property so reporters
// can recover the tree without polluting the event's visible shape.
let _testIdCounter = 0;
let _testNumberCounter = 0;

function _nodeNesting(node) {
  let d = 0, p = node.parent;
  const root = _getRoot();
  while (p && p !== root) { d++; p = p.parent; }
  return d;
}

function _testEventData(node) {
  const data = {
    name: node.name,
    nesting: _nodeNesting(node),
    testNumber: node._testNumber,
    testId: node._testId,
    parentId: node.parent ? node.parent._testId : 0,
    details: { duration_ms: node.duration ?? 0, type: node.isSuite ? 'suite' : 'test' },
  };
  if (node.skip !== undefined) data.skip = node.skip;
  if (node.todo !== undefined) data.todo = node.todo;
  if (node.error) {
    data.details.error = node.error;
    if (node.error.failureType) data.failureType = node.error.failureType;
  }
  Object.defineProperty(data, 'node', { value: node, enumerable: false });
  return data;
}


// Suite events carry the node non-enumerably, like test events.
function _suiteEventData(s) {
  const data = { name: s.name, nesting: _nodeNesting(s) };
  Object.defineProperty(data, 'node', { value: s, enumerable: false });
  return data;
}

function _emitTestResult(node) {
  const data = _testEventData(node);
  _emit('test:complete', data);
  _emit(node.result === 'fail' ? 'test:fail' : 'test:pass', data);
}

async function _runNode(node, iBefore = [], iAfter = []) {
  if (_testNamePattern && !_testNamePattern.test(_buildFull(node))) {
    // Pattern-mismatched tests are silently dropped (Node behaviour):
    // no events, not counted, invisible to reporters.
    node.result = 'skip';
    node.duration = 0;
    const sibs = node.parent?.children;
    if (sibs) { const i = sibs.indexOf(node); if (i >= 0) sibs.splice(i, 1); }
    return node;
  }
  // Only-mode (--test-only equivalent): ineligible nodes are silently
  // skipped, exactly like real Node (no TAP lines, not counted).
  if (_onlyMode && (node._runOnlySkipped || !_onlyEligible(node))) {
    node.result = 'skip';
    node.duration = 0;
    // Detach so reporters never see the node.
    const sibs = node.parent?.children;
    if (sibs) { const i = sibs.indexOf(node); if (i >= 0) sibs.splice(i, 1); }
    return node;
  }
  const ctx = new TestContext(node);
  // AbortSignal for the test timeout (t.signal).
  const aborter = typeof AbortController !== 'undefined' ? new AbortController() : null;
  if (aborter) ctx.signal = aborter.signal;
  const t0  = performance.now();
  // Real node:test emits test:start when a test begins (before its result).
  _emit('test:start', _testEventData(node));

  if (node.opts.skip) {
    // Skip option: the body never runs. Skip wins over todo, so any todo
    // flag is cleared. Reported as a pass carrying the skip flag.
    node.skip = node.opts.skip;
    node.todo = undefined;
    node.result = 'pass';
    node._passed = true;
    node.duration = performance.now() - t0;
    _emitTestResult(node);
    return node;
  }
  // Todo option: the body RUNS (unlike skip); the todo flag is preset so it
  // is reported even if the body never calls t.todo().
  if (node.opts.todo && node.todo === undefined) node.todo = node.opts.todo;

  for (const h of [...iBefore, ...node._before]) {
    try { await h.fn(ctx); } catch (e) { if (!node.error) node.error = e; }
  }

  _contextStack.push(ctx);
  try {
    if (node.fn) {
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = globalThis.setTimeout(
          () => {
            if (aborter) { try { aborter.abort(); } catch (_) {} }
            reject(new Error(`Test "${node.name}" timed out after ${node.opts.timeout}ms`));
          },
          node.opts.timeout
        );
      });
      try {
        await Promise.race([Promise.resolve().then(() => node.fn(ctx)), timeoutPromise]);
      } finally {
        globalThis.clearTimeout(timeoutId);
      }
    }
    if (node.opts.expectFailure) {
      // The test was expected to fail but it passed.
      node._passed = false;
      node.result  = 'fail';
      node.error   = _cleanStack(Object.assign(
        new Error('test was expected to fail but passed'),
        { code: 'ERR_TEST_FAILURE', failureType: 'expectedFailure' }
      ));
    } else {
      node._passed = true;
      node.result  = 'pass';
    }
  } catch (e) {
    if (e instanceof SkipError) {
      node.skip = node.opts.skip || true;
      node._passed = true;
      node.result  = 'pass';
    } else if (e instanceof TodoError) {
      node.todo = node.opts.todo || true;
      node._passed = true;
      node.result  = 'pass';
    } else if (node.opts.expectFailure) {
      // Failed as expected: reported as a pass with an EXPECTED FAILURE note.
      node._passed = true;
      node.result  = 'pass';
      node._expectedFailure = true;
    } else {
      node._passed = false;
      node.result  = 'fail';
      node.error   = _cleanStack(e);
    }
  } finally {
    _contextStack.pop();
  }

  for (const h of [...node._after, ...iAfter].reverse()) {
    try { await h.fn(ctx); } catch (e) { if (!node.error) node.error = e; }
  }

  node.mockTracker.reset();
  node.duration = performance.now() - t0;
  _emitTestResult(node);
  return node;
}

async function _runSuite(s) {
  // Skipped/todo suites never run their body; real node:test reports them
  // as a pass carrying the flag (details.type 'suite'). Skip wins over todo.
  if (s.opts.skip || s.opts.todo) {
    const t0 = performance.now();
    _emit('test:start', _testEventData(s));
    if (s.opts.skip) { s.skip = s.opts.skip; s.todo = undefined; }
    else { s.todo = s.opts.todo; s.skip = undefined; }
    s.result = 'pass';
    s._passed = true;
    s.duration = performance.now() - t0;
    _emitTestResult(s);
    return;
  }
  // Only-mode: ineligible children are detached so reporters never see them;
  // a suite that neither is marked only nor contains an only-marked
  // descendant is silently skipped (mirrors node's --test-only TAP output).
  if (_onlyMode) {
    for (const c of [...s.children]) {
      if (!_onlyEligible(c)) {
        c.result = 'skip';
        s.children.splice(s.children.indexOf(c), 1);
      }
    }
    if (s !== _getRoot() && !_onlyEligible(s)) return;
  }
  _emit('suite:start', _suiteEventData(s));
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
  _emit('suite:end', _suiteEventData(s));
}

// ─── Public harness: register tests ─────────────────────────────────────────
function _makeTest(name, opts, fn) {
  const { name: n, opts: o, fn: f } = _resolveArgs(name, opts, fn);
  const parent = _current ?? _getRoot();
  const node   = new TestNode(n, f, o, parent);
  parent.children.push(node);
  _maybeAutoRun();
  // Real node:test resolves test() with the TestContext.
  return Promise.resolve(new TestContext(node));
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

// ─── it ──────────────────────────────────────────────────────────────────────
// `it` is an alias for `test`: the SAME function object, matching Node
// (`test.it === test`, and `import { it } from 'node:test'` is `test`).
export const it = test;

// ─── only / skip / todo (top-level, schedule a marked test) ──────────────────
// Real node:test exposes these as top-level functions (require('node:test').only …).
export function only(name, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return _makeTest(name, { ...(opts ?? {}), only: true }, fn);
}
export function skip(name, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return _makeTest(name, { ...(opts ?? {}), skip: true }, fn);
}
export function todo(name, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return _makeTest(name, { ...(opts ?? {}), todo: true }, fn);
}

// ─── expectFailure ───────────────────────────────────────────────────────────
// Schedules a test that is expected to fail: a failure is reported as a pass
// (`# EXPECTED FAILURE`), an unexpected pass is reported as a failure.
export function expectFailure(name, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  return _makeTest(name, { ...(opts ?? {}), expectFailure: true }, fn);
}

// ─── getTestContext ──────────────────────────────────────────────────────────
// Returns the TestContext of the currently executing test, or undefined
// when called outside of a running test.
export function getTestContext() {
  return _contextStack.length ? _contextStack[_contextStack.length - 1] : undefined;
}

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
  // Real node:test resolves suite() with the SuiteContext.
  return Promise.resolve(new SuiteContext(node));
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

// ─── describe ────────────────────────────────────────────────────────────────
// `describe` is an alias for `suite`: the SAME function object, matching Node
// (`test.describe === test.suite`).
export const describe = suite;

// ─── Lifecycle hooks ─────────────────────────────────────────────────────────
export const before     = (fn, o) => (_current ?? _getRoot())._before.push({ fn, o });
export const after      = (fn, o) => (_current ?? _getRoot())._after.push({ fn, o });
export const beforeEach = (fn, o) => (_current ?? _getRoot())._beforeEach.push({ fn, o });
export const afterEach  = (fn, o) => (_current ?? _getRoot())._afterEach.push({ fn, o });

// ─── run ─────────────────────────────────────────────────────────────────────
// Returns a TestsStream-like facade: an async iterable of { type, data }
// events (live as the run progresses), plus .on()/.collect()/.drain().
// Feed it straight into a reporter: `for await (const c of tap(run())) …`
// A user-invoked run() disables the auto-run (see _maybeAutoRun).
export function run(opts = {}) {
  _userInvokedRun = true;
  return _runImpl(opts);
}

function _runImpl(opts = {}) {
  // run({ files }) executes each file in a fresh child process (like Node's
  // process isolation) and re-emits the child's test events on this stream.
  if (opts.files && opts.files.length) return _runFiles(opts);
  _running = true;
  _onlyMode = !!opts.testOnly;
  _testNamePattern = opts.testNamePatterns ?? null;
  const root = _getRoot();
  const evts = [];
  const waiters = [];
  let finished = false;

  const types = ['test:pass','test:fail','test:skip','test:todo','test:start','test:complete','suite:start','suite:end','diagnostic'];
  for (const t of types) _on(t, evt => {
    evts.push(evt);
    while (waiters.length) { const w = waiters.shift(); try { w(); } catch (_) {} }
  });

  let _resolve;
  const done = new Promise(r => { _resolve = r; });

  queueMicrotask(() => {
    _runSuite(root).then(() => {
      _running = false;
      finished = true;
      while (waiters.length) { const w = waiters.shift(); try { w(); } catch (_) {} }
      _resolve(evts);
    });
  });

  function summarize(events) {
    const s = { passed: 0, failed: 0, skipped: 0, todo: 0 };
    for (const e of events) {
      // Node reports skips/todos as passes carrying skip/todo flags.
      if (e.type === 'test:pass') {
        s.passed++;
        if (e.data?.skip) s.skipped++;
        if (e.data?.todo) s.todo++;
      }
      else if (e.type === 'test:fail') s.failed++;
    }
    return s;
  }

  return {
    async *[Symbol.asyncIterator]() {
      let i = 0;
      for (;;) {
        while (i < evts.length) yield evts[i++];
        if (finished) return;
        await new Promise(r => waiters.push(r));
      }
    },
    async collect() { return done; },
    async drain() {
      const events = await done;
      return { root, events, reporter: _resolveActiveReporter(), ...summarize(events) };
    },
    on(event, cb) {
      // Real node:test streams deliver the event DATA to listeners.
      const wrapped = (evt) => { try { cb(evt.data); } catch (_) {} };
      _on(event, wrapped);
      for (const e of evts) { if (e.type === event) { try { cb(e.data); } catch (_) {} } }
      return this;
    },
  };
}

// ─── run({ files }) — child-process test execution ──────────────────────────
// Each file runs in a fresh Node child preloaded with a tiny data: URL loader
// that redirects `node:test` / `node:test/reporters` to this shim (works
// standalone, no parity harness needed). The child — via _maybeAutoRun —
// streams its test events back as marker-prefixed JSON lines on stdout; the
// parent re-emits them on the returned stream. Files run sequentially.
// Path to a generated ESM loader file that redirects `node:test` and
// `node:test/reporters` to this shim inside run({ files }) children.
// Written to the OS temp dir at runtime (never to the repo).
let _loaderURL = null;
async function _shimLoaderURL() {
  // Generates a --import preload (in the OS temp dir, never in the repo)
  // that redirects `node:test` / `node:test/reporters` to this shim inside
  // run({ files }) children, for BOTH module systems:
  //   - ESM `import` via a module.register() resolve hook, and
  //   - CJS `require()` via a Module._load patch (require() short-circuits
  //     ESM resolve hooks for builtins, so the hook alone is not enough).
  if (_loaderURL) return _loaderURL;
  // Acquire builtins via process.getBuiltinModule (never literal node:*
  // imports) so the browser bundle (platform:'browser') does not try to
  // resolve them. This path only runs under real Node anyway.
  const _gbm = (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function')
    ? (id) => process.getBuiltinModule(id)
    : () => null;
  const _fs = _gbm('fs'); const _os = _gbm('os');
  const _path = _gbm('path'); const _url = _gbm('url');
  if (!_fs || !_os || !_path || !_url) throw new Error('run({ files }) requires Node builtins');
  const { writeFileSync } = _fs; const { tmpdir } = _os;
  const { join } = _path; const { pathToFileURL } = _url;
  const NL = String.fromCharCode(10);
  const testURL = import.meta.url;
  const reportersURL = new URL('./test/reporters.js', testURL).href;
  const q = (u) => JSON.stringify(u);
  const hooksSrc =
    'export async function resolve(s, c, n) {' + NL +
    "  if (s === 'node:test') return { url: " + q(testURL) + ", shortCircuit: true };" + NL +
    "  if (s === 'node:test/reporters') return { url: " + q(reportersURL) + ", shortCircuit: true };" + NL +
    '  return n(s, c);' + NL + '}' + NL;
  const preloadSrc =
    "import { register } from 'node:module';" + NL +
    "import Module from 'node:module';" + NL +
    "import testDefault from " + q(testURL) + ";" + NL +
    "import reportersDefault from " + q(reportersURL) + ";" + NL +
    "register('./${HOOKS}', import.meta.url);" + NL +
    "const __origLoad = Module._load;" + NL +
    "Module._load = function (request, parent, isMain) {" + NL +
    "  const bare = request.startsWith('node:') ? request : 'node:' + request;" + NL +
    "  if (bare === 'node:test') return testDefault;" + NL +
    "  if (bare === 'node:test/reporters') return reportersDefault;" + NL +
    "  return __origLoad.call(this, request, parent, isMain);" + NL +
    "};" + NL;
  // Filenames keyed by the shim URL so concurrent checkouts don't collide.
  let digest = 'x';
  try {
    const _crypto = _gbm('crypto');
    if (_crypto) digest = _crypto.createHash('sha1').update(testURL).digest('hex').slice(0, 12);
  } catch (_) {}
  const hooksName = `bundlevfs-node-test-hooks-${digest}.mjs`;
  const preloadName = `bundlevfs-node-test-preload-${digest}.mjs`;
  writeFileSync(join(tmpdir(), hooksName), hooksSrc);
  writeFileSync(join(tmpdir(), preloadName), preloadSrc.replace('${HOOKS}', hooksName));
  _loaderURL = pathToFileURL(join(tmpdir(), preloadName)).href;
  return _loaderURL;
}

function _runFiles(opts) {
  const files = [...opts.files];
  const evts = [];
  const waiters = [];
  const listeners = new Map();
  let finished = false;

  function emitLocal(type, data) {
    const evt = { type, data };
    evts.push(evt);
    const cbs = listeners.get(type);
    if (cbs) for (const cb of [...cbs]) { try { cb(data); } catch (_) {} }
    while (waiters.length) { const w = waiters.shift(); try { w(); } catch (_) {} }
  }

  function summarize() {
    const s = { passed: 0, failed: 0, skipped: 0, todo: 0 };
    for (const e of evts) {
      if (e.type === 'test:pass') {
        s.passed++;
        if (e.data?.skip) s.skipped++;
        if (e.data?.todo) s.todo++;
      } else if (e.type === 'test:fail') s.failed++;
    }
    return s;
  }

  async function runAll() {
    if (typeof process === 'undefined' || !process.versions?.node) {
      // Browser lane: no child processes — honest diagnostic, no throw.
      emitLocal('diagnostic', { message: 'run({ files }) needs a Node.js process; skipping files.' });
    } else {
      let loaderURL = null;
      try { loaderURL = await _shimLoaderURL(); } catch (_) {}
      for (const file of files) {
        // File-level enqueue/dequeue carry a numeric testId like real node:test.
        const fileTestId = ++_testIdCounter;
        emitLocal('test:enqueue', { file, name: file, testId: fileTestId });
        if (loaderURL) await _runOneFile(file, emitLocal, loaderURL, fileTestId);
        else emitLocal('diagnostic', { message: `cannot build child loader for ${file}` });
        emitLocal('test:dequeue', { file, name: file, testId: fileTestId });
      }
    }
    finished = true;
    while (waiters.length) { const w = waiters.shift(); try { w(); } catch (_) {} }
  }

  const done = runAll();

  return {
    async *[Symbol.asyncIterator]() {
      let i = 0;
      for (;;) {
        while (i < evts.length) yield evts[i++];
        if (finished) return;
        await new Promise(r => waiters.push(r));
      }
    },
    async collect() { await done; return evts; },
    async drain() { await done; return { events: evts, files, ...summarize() }; },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      for (const e of evts) { if (e.type === event) { try { cb(e.data); } catch (_) {} } }
      return this;
    },
  };
}

async function _runOneFile(file, emitLocal, loaderURL, fileTestId) {
  // Browser-safe spawn acquisition: `process.getBuiltinModule` bypasses the
  // parity harness's redirection (real Node lane) and is absent/stubbed in
  // the browser lane, where spawning is impossible. A literal
  // `import('node:child_process')` would break the browser bundle, so it is
  // deliberately avoided here.
  let spawnFn;
  try {
    const proc = typeof process !== 'undefined' ? process : undefined;
    const gbm = proc && typeof proc.getBuiltinModule === 'function' ? proc.getBuiltinModule : undefined;
    const cpMod = gbm ? gbm.call(proc, 'child_process') : undefined;
    if (cpMod && typeof cpMod.spawn === 'function') spawnFn = cpMod.spawn;
  } catch (_) { /* fall through to the diagnostic below */ }
  if (!spawnFn) {
    emitLocal('diagnostic', { message: `child_process unavailable; cannot run ${file}` });
    return;
  }
  await new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(process.execPath, ['--import', loaderURL, file], {
        env: { ...process.env, NODE_TEST_CONTEXT: '1', NODE_TEST_CHILD: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (_) { resolve(); return; }
    let outBuf = '';
    let stderr = '';
    let sawTestEvent = false;
    const flushLines = (final) => {
      let idx;
      while ((idx = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, idx);
        outBuf = outBuf.slice(idx + 1);
        if (line.startsWith(_CHILD_EVENT_MARKER)) {
          try {
            const evt = JSON.parse(line.slice(_CHILD_EVENT_MARKER.length));
            if (evt.type === 'test:child:done') continue;
            sawTestEvent = true;
            emitLocal(evt.type, _reviveEvent(evt.data));
          } catch (_) {}
        } else if (line.length) {
          try { process.stdout.write(line + '\n'); } catch (_) {}
        }
      }
      if (final && outBuf.length) {
        try { process.stdout.write(outBuf); } catch (_) {}
        outBuf = '';
      }
    };
    child.stdout.on('data', (chunk) => { outBuf += chunk; flushLines(false); });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', () => resolve());
    child.on('close', (code) => {
      flushLines(true);
      if (code !== 0 && !sawTestEvent) {
        // The file never emitted tests (load/syntax error…): synthesize the
        // file-level failure Node reports.
        const err = new Error(
          `test file failed to run: ${file}\n${stderr.trim().split('\n').slice(0, 8).join('\n')}`);
        err.code = 'ERR_TEST_FAILURE';
        const data = { name: file, file, testId: fileTestId, details: { duration_ms: 0, type: 'test', error: err } };
        emitLocal('test:complete', data);
        emitLocal('test:fail', data);
      }
      resolve();
    });
  });
}

// ─── Auto-run (real-Node lane only) ──────────────────────────────────────────
// Real node:test executes scheduled tests automatically when the file runs
// (`node file.js`). Our browser lane is host-driven (_RUNTIME_ present) and
// must NOT auto-run; the parity lane (real Node, no host) needs it so
// official test files that just call test()/describe() at top level actually
// execute. Scheduling is debounced: every test() call re-arms a setImmediate,
// so tests scheduled across top-level awaits are still picked up. An explicit
// run()/execute() disables auto-run permanently for the instance.
let _userInvokedRun = false;
let _autoScheduled = false;
let _runInFlight = false;

function _maybeAutoRun() {
  if (_autoScheduled || _userInvokedRun || _runInFlight) return;
  if (typeof globalThis._RUNTIME_ !== 'undefined') return; // host-driven lane
  if (typeof process === 'undefined' || typeof setImmediate === 'undefined') return;
  if (process.env.JEST_WORKER_ID) return; // under a test runner, running is its job
  _autoScheduled = true;
  setImmediate(() => {
    _autoScheduled = false;
    if (_userInvokedRun || _runInFlight) return;
    if (typeof globalThis._RUNTIME_ !== 'undefined') return;
    // Child-test-process mode (spawned by run({ files })): forward every
    // event to the parent over stdout as marker-prefixed JSON lines.
    const forwarding = typeof process !== 'undefined' && process.env.NODE_TEST_CHILD === '1';
    if (!_getRoot().children.length) {
      if (forwarding) _forwardEvent({ type: 'test:child:done', data: {} });
      return;
    }
    _runInFlight = true;
    const stream = _runImpl();
    (async () => {
      let failed = 0;
      try {
        for await (const evt of stream) {
          if (evt.type === 'test:fail') failed++;
          if (forwarding) _forwardEvent(evt);
        }
      } catch (_) { failed++; }
      _runInFlight = false;
      if (forwarding) _forwardEvent({ type: 'test:child:done', data: {} });
      if (failed > 0 && typeof process !== 'undefined') process.exitCode = 1;
    })();
  });
}

// Marker line prefix a run({ files }) parent scans for on the child's stdout.
const _CHILD_EVENT_MARKER = '__NODE_TEST_EVENT__';

function _forwardEvent(evt) {
  try {
    process.stdout.write(_CHILD_EVENT_MARKER + _serializeEvent(evt) + '\n');
  } catch (_) {}
}

// JSON-safe event serialization: Error objects (non-enumerable message/stack)
// become plain { $error, name, message, code, stack, failureType } records.
// The non-enumerable `node` tree link is skipped automatically.
function _serializeEvent(evt) {
  return JSON.stringify(evt, (_key, value) => {
    if (value instanceof Error) {
      const e = { $error: true, name: value.name, message: value.message };
      for (const k of ['code', 'failureType']) {
        if (value[k] !== undefined) e[k] = value[k];
      }
      if (value.stack) e.stack = value.stack;
      return e;
    }
    return value;
  });
}

function _reviveEvent(data) {
  return JSON.parse(JSON.stringify(data), (_key, value) => {
    if (value && value.$error === true) {
      const e = new Error(value.message);
      e.name = value.name ?? 'Error';
      if (value.code !== undefined) e.code = value.code;
      if (value.failureType !== undefined) e.failureType = value.failureType;
      if (value.stack !== undefined) e.stack = value.stack;
      return e;
    }
    return value;
  });
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
//  The bolted-on props make CJS `require('node:test')` (and destructuring
//  like `const { beforeEach } = require('node:test')`) work identically.
// ══════════════════════════════════════════════════════════════════════════════
test.test = test;
test.it = it;
test.suite = suite;
test.describe = describe;
test.before = before;
test.after = after;
test.beforeEach = beforeEach;
test.afterEach = afterEach;
test.run = run;
test.mock = mock;
test.snapshot = snapshot;
test.assert = assert;
test.only = only;
test.skip = skip;
test.todo = todo;
test.expectFailure = expectFailure;
test.getTestContext = getTestContext;
export default test;

// ─── execute() — host-only helper (not part of node:test public API) ─────────
export async function execute(userCode, opts = {}) {
  _userInvokedRun = true; // explicit run — disables the auto-run lane
  if (opts.resetBefore !== false) _reset();
  if (opts.reporter) _reporterOverride = _resolveReporter(opts.reporter);

  const API_KEYS = ['test','it','suite','describe','before','after','beforeEach','afterEach',
                    'only','skip','todo','expectFailure','getTestContext',
                    'mock','snapshot','assert'];
  const _mockProxy = mock;
  const apiVals = [test, it, suite, describe, before, after, beforeEach, afterEach,
                   only, skip, todo, expectFailure, getTestContext,
                   _mockProxy, snapshot, _assert];

  try {
    const execFn = new Function(...API_KEYS, `return (async()=>{\n${userCode}\n})()`);
    await execFn(...apiVals);
  } catch (e) {
    if (e instanceof SyntaxError) throw new SyntaxError(`[node:test runtime] ${e.message}`);
    // If no tests were registered at all, the throw is a top-level crash — re-throw it
    if (_getRoot().children.length === 0) throw e;
    const synth = new TestNode('<top-level>', null, {}, _getRoot());
    synth.result = 'fail'; synth.error = e;
    synth.duration = 0;
    _getRoot().children.push(synth);
    _emitTestResult(synth);
  }

  await new Promise(r => setTimeout(r, 0));
  const { root, events } = await run({ testOnly: opts.testOnly }).drain();
  const reporter = _resolveActiveReporter();
  // Reporters are async generators that transform the event stream.
  async function* _eventSource() { for (const e of events) yield e; }
  let output = '';
  try {
    for await (const chunk of reporter(_eventSource())) output += chunk;
  } catch (e) {
    throw Object.assign(e, { message: `[reporter:${reporter?.name ?? '?'}] ${e.message}` });
  }
  return { root, events, output, reporter };
}

// ─── Global runtime hook (host environment only) ─────────────────────────────
// Installs the _TEST_RUNNER_ integration the host runtime consumes. Guarded:
// it only wires up when the host pre-installed globalThis._RUNTIME_ (Jared's
// runtime does this before loading our shims). Under real Node / direct
// import _RUNTIME_ is undefined and nothing is installed — importantly, we
// must NOT create a _RUNTIME_ global ourselves, because Node's test/common
// fails tests that leak new globals.
// When the host pre-installed _TEST_RUNNER_ (e.g. REPORTER_TYPE config), we
// merge so host configuration survives instead of being clobbered.
if (typeof globalThis._RUNTIME_ !== 'undefined') {
  const _tr = (globalThis._RUNTIME_._TEST_RUNNER_ ??= {});
  _tr.execute = execute;
  _tr._reset = _reset;
  _tr.reporters = REPORTERS;
  Object.defineProperty(_tr, 'activeReporter', {
    get() { return _resolveActiveReporter(); },
    configurable: true,
  });
}
