/**
 * node-test-browser.js
 * Drop-in browser ESM port of Node.js `node:test`
 * Same named exports as the native module.
 *
 * Spec parity target: node:test @ Node.js v22+
 */

import _assert from './assert.js';



import {
  dot   as _dot,
  spec  as _spec,
  tap   as _tap,
  junit as _junit,
  lcov  as _lcov,
} from './test/reporters.js';

// ─── Reporter registry ───────────────────────────────────────────────────────
const REPORTERS = { dot: _dot, spec: _spec, tap: _tap, junit: _junit, lcov: _lcov };

/** Read the run-level reporter from the global hook, mirroring --test-reporter. */
function _getConfiguredReporter() {
  const name = globalThis._RUNTIME_TEST_RUNNER_?.REPORTER_TYPE;
  return name ? (_resolveReporter(name) ?? _spec) : _spec;
}

let _activeReporter  = _getConfiguredReporter();
const _defaultReporter = _spec;

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

// ─── Internal error types ────────────────────────────────────────────────────
export class SkipError      extends Error { constructor(m=''){super(m);this.name='SkipError';} }
export class TodoError      extends Error { constructor(m=''){super(m);this.name='TodoError';} }
export class AssertionError extends Error { constructor(m=''){super(m);this.name='AssertionError';} }

// ─── Deep equality ───────────────────────────────────────────────────────────
function deepEq(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEq(v, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => deepEq(a[k], b[k]));
}

// ─── MockFunctionContext ──────────────────────────────────────────────────────
class MockFunctionContext {
  #calls = [];
  #impl;

  constructor(impl) { this.#impl = impl; }

  /** @returns {Array<{arguments,result,error,stack,target,this}>} */
  get calls() { return [...this.#calls]; }

  /** Node-compatible callCount() method (more efficient than calls.length) */
  callCount() { return this.#calls.length; }

  _record(args, ret, err, stackErr, target, thisVal) {
    this.#calls.push({
      arguments: args,
      result:    ret,
      error:     err,
      stack:     stackErr,   // Error whose .stack identifies call site
      target:    target,     // set when called as constructor, else undefined
      this:      thisVal,
    });
  }

  resetCalls() { this.#calls = []; }

  mockImplementation(fn) { this.#impl = fn; }

  mockImplementationOnce(fn, onCall) {
    if (onCall === undefined) {
      const prev = this.#impl;
      this.#impl = (...a) => { this.#impl = prev; return fn(...a); };
    } else {
      // schedule for a specific call index
      const orig = this.#impl;
      let calls = 0;
      this.#impl = (...a) => {
        calls++;
        if (calls === onCall + 1) {
          this.#impl = orig;
          return fn(...a);
        }
        return orig(...a);
      };
    }
  }

  restore() { /* implementation is restored by MockTracker.restoreAll() */ }

  get implementation() { return this.#impl; }
}

// ─── MockTracker ─────────────────────────────────────────────────────────────
export class MockTracker {
  #mocks = [];

  /**
   * Creates a spy/mock function.
   * @param {Function} [original]
   * @param {Function} [implementation]
   * @param {{ times?: number }} [options]
   */
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
      // detect `new` usage
      const isNew = new.target !== undefined;
      const tgt   = isNew ? new.target : undefined;
      try {
        if (isNew) {
          r = Reflect.construct(ctx.implementation, args, new.target);
        } else {
          r = ctx.implementation.apply(this, args);
        }
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

  /**
   * Mocks an object method.
   * @param {object} obj
   * @param {string|symbol} name
   * @param {Function} [impl]
   * @param {{ getter?: boolean; setter?: boolean; times?: number }} [options]
   */
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
        r = tgt
          ? Reflect.construct(ctx.implementation, args, tgt)
          : ctx.implementation.apply(this, args);
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

  /**
   * Mocks a property getter.
   */
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

  /**
   * Mocks a property setter.
   */
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

  /** Restore all mocks and disassociate from this tracker. */
  reset() { this.restoreAll(); }

  /** Restore original implementations without disassociating. */
  restoreAll() {
    for (const m of this.#mocks) {
      if (m.type === 'method') m.obj[m.name] = m.orig;
      if (m.type === 'getter' || m.type === 'setter') {
        m.orig
          ? Object.defineProperty(m.obj, m.prop, m.orig)
          : delete m.obj[m.prop];
      }
    }
    this.#mocks = [];
  }

  /** Expose timers sub-object (lazy). */
  get timers() {
    if (!this._timers) this._timers = new MockTimers();
    return this._timers;
  }
}

// ─── MockTimers ───────────────────────────────────────────────────────────────
export class MockTimers {
  #enabled   = new Set();
  #queue     = [];   // { fn, delay, id, interval }
  #clock     = 0;
  #originals = {};
  #nextId    = 1;

  #install(api) {
    const g = globalThis;
    if (api === 'setTimeout') {
      this.#originals.setTimeout    = g.setTimeout;
      this.#originals.clearTimeout  = g.clearTimeout;
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
      const FakeDate = class Date extends g.Date {
        constructor(...args) {
          if (args.length === 0) super(self.#clock);
          else super(...args);
        }
        static now() { return self.#clock; }
      };
      g.Date = FakeDate;
    }
  }

  #schedule(fn, delay, repeat, args) {
    const id = this.#nextId++;
    this.#queue.push({ fn, delay, triggerAt: this.#clock + delay, repeat, args, id, cancelled: false });
    this.#queue.sort((a, b) => a.triggerAt - b.triggerAt);
    return id;
  }

  #cancel(id) {
    const entry = this.#queue.find(e => e.id === id);
    if (entry) entry.cancelled = true;
  }

  /**
   * Enable timer mocking.
   * @param {{ apis?: string[], now?: number|Date }} [opts]
   */
  enable(opts = {}) {
    const apis = opts.apis ?? ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'Date'];
    this.#clock = (opts.now instanceof globalThis._origDate ?? Date ? opts.now.getTime?.() ?? 0 : opts.now) ?? 0;
    for (const api of apis) {
      if (!this.#enabled.has(api)) {
        this.#install(api);
        this.#enabled.add(api);
        // implicitly enable paired clear functions
        if (api === 'setTimeout'  && !this.#enabled.has('clearTimeout'))  { this.#enabled.add('clearTimeout'); }
        if (api === 'setInterval' && !this.#enabled.has('clearInterval')) { this.#enabled.add('clearInterval'); }
        if (api === 'setImmediate'&& !this.#enabled.has('clearImmediate')){ this.#enabled.add('clearImmediate'); }
      }
    }
  }

  /**
   * Advance the mock clock by `ms` milliseconds, firing all due timers.
   * @param {number} [ms=1]
   */
  tick(ms = 1) {
    const target = this.#clock + ms;
    while (true) {
      const due = this.#queue.filter(e => !e.cancelled && e.triggerAt <= target);
      if (!due.length) break;
      // fire the earliest
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

  /**
   * Run all pending timers immediately.
   */
  runAll() {
    const safety = 10_000;
    let i = 0;
    while (this.#queue.some(e => !e.cancelled)) {
      if (++i > safety) throw new Error('MockTimers.runAll(): infinite loop guard exceeded');
      const entry = this.#queue.filter(e => !e.cancelled).sort((a, b) => a.triggerAt - b.triggerAt)[0];
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

  /**
   * Manually set the mocked clock to an absolute timestamp.
   * Does NOT fire timers (use tick(0) after to drain).
   * @param {number} ms
   */
  setTime(ms) { this.#clock = ms; }

  /** Restore all real timer implementations. */
  reset() {
    const g = globalThis;
    for (const [k, v] of Object.entries(this.#originals)) g[k] = v;
    this.#originals = {};
    this.#enabled.clear();
    this.#queue   = [];
    this.#clock   = 0;
    this.#nextId  = 1;
  }

  [Symbol.dispose]() { this.reset(); }
}

// ─── CtxAssert — t.assert namespace ──────────────────────────────────────────
class CtxAssert {
  #plan = null;     // set by context.plan()
  #count = 0;

  _setPlan(n) { this.#plan = n; }
  _tick()     { this.#count++; }
  _checkPlan(){ return { expected: this.#plan, actual: this.#count }; }

  #pass() { this.#count++; }
  #fail(m) { this.#count++; throw new AssertionError(m); }

  ok(v, m)            { v ? this.#pass() : this.#fail(m ?? `Expected truthy, got ${v}`); }
  fail(m)             { this.#fail(m ?? 'Explicit fail'); }
  equal(a, b, m)      { a !== b   ? this.#fail(m ?? `${a} !== ${b}`) : this.#pass(); }
  notEqual(a, b, m)   { a === b   ? this.#fail(m ?? 'Expected not equal') : this.#pass(); }
  strictEqual(a, b, m){ !Object.is(a, b) ? this.#fail(m ?? `${String(a)} !== ${String(b)} (strict)`) : this.#pass(); }
  notStrictEqual(a,b,m){ Object.is(a,b) ? this.#fail(m ?? 'Expected not strict equal') : this.#pass(); }
  deepEqual(a, b, m)  { !deepEq(a, b) ? this.#fail(m ?? 'Deep equality failed') : this.#pass(); }
  notDeepEqual(a,b,m) { deepEq(a, b)  ? this.#fail(m ?? 'Expected deep not equal') : this.#pass(); }

  throws(fn, expected, m) {
    try { fn(); }
    catch (e) {
      if (expected instanceof RegExp && !expected.test(e.message))
        this.#fail(m ?? `Error message did not match ${expected}`);
      this.#pass(); return;
    }
    this.#fail(m ?? 'Expected function to throw');
  }

  doesNotThrow(fn, m) {
    try { fn(); this.#pass(); }
    catch (e) { this.#fail(m ?? `Got: ${e}`); }
  }

  rejects(fn, m) {
    return Promise.resolve().then(() => fn())
      .then(() => this.#fail(m ?? 'Expected rejection'), () => this.#pass());
  }

  doesNotReject(fn, m) {
    return Promise.resolve().then(() => fn())
      .then(() => this.#pass())
      .catch(e => this.#fail(m ?? `Got rejection: ${e}`));
  }

  ifError(e)         { e != null ? this.#fail(`ifError got ${e}`) : this.#pass(); }
  match(s, re, m)    { !re.test(s) ? this.#fail(m ?? `${s} did not match ${re}`) : this.#pass(); }
  doesNotMatch(s,re,m){ re.test(s) ? this.#fail(m ?? `${s} matched ${re}`) : this.#pass(); }

  /** Snapshot stub — no file system in browser. */
  snapshot(value, _opts) {
    // In browser we cannot persist snapshots; just pass.
    this.#pass();
  }

  /** File snapshot stub — no file system in browser. */
  fileSnapshot(value, path, _opts) {
    this.#pass();
  }
}

// ─── TestNode ────────────────────────────────────────────────────────────────
class TestNode {
  constructor(name, fn, opts, parent) {
    this.name      = name;
    this.fn        = fn;
    this.parent    = parent;
    this.opts      = {
      skip: false, todo: false, timeout: 5000,
      concurrency: false, only: false, plan: undefined,
      ...opts,
    };
    this.children   = [];
    this.result     = null;   // 'pass' | 'fail' | 'skip' | 'todo'
    this.error      = null;
    this.duration   = 0;
    this._isSuite   = false;
    this._before    = [];
    this._after     = [];
    this._beforeEach = [];
    this._afterEach  = [];
    this._passed    = false;
    // each node gets its own MockTracker (auto-restored after run)
    this.mockTracker = new MockTracker();
  }
  get isSuite() { return this._isSuite || !this.fn; }
}

// ─── TestContext ──────────────────────────────────────────────────────────────
class TestContext {
  #node;
  #assert;

  constructor(node) {
    this.#node    = node;
    this.#assert  = new CtxAssert();
    this.name     = node.name;
    this.fullName = _buildFull(node);
    this.signal   = null;   // AbortSignal placeholder
  }

  // ── Assertions ──────────────────────────────────────────────────────────────
  get assert() { return this.#assert; }

  // ── Per-test mock tracker (auto-reset after test) ──────────────────────────
  get mock() { return this.#node.mockTracker; }

  // ── Lifecycle info ─────────────────────────────────────────────────────────
  /** false before test executes (e.g. in beforeEach), true/false after */
  get passed() { return this.#node._passed; }

  /** The thrown error (wrapped), or null */
  get error()  { return this.#node.error ? Object.assign(new Error('test failure'), { cause: this.#node.error }) : null; }

  /** Absolute test file path — not meaningful in browser, returns empty string */
  get filePath() { return ''; }

  // ── Sub-tests / hooks ──────────────────────────────────────────────────────
  test(n, o, f)      { return _scheduleSubtest(this.#node, n, o, f); }
  it(n, o, f)        { return this.test(n, o, f); }
  before(fn, o)      { this.#node._before.push({ fn, o }); }
  after(fn, o)       { this.#node._after.push({ fn, o }); }
  beforeEach(fn, o)  { this.#node._beforeEach.push({ fn, o }); }
  afterEach(fn, o)   { this.#node._afterEach.push({ fn, o }); }

  // ── Control flow ───────────────────────────────────────────────────────────
  skip(msg = '')  { this.#node.opts.skip = msg || true; throw new SkipError(String(msg)); }
  todo(msg = '')  { this.#node.opts.todo = msg || true; throw new TodoError(String(msg)); }
  diagnostic(msg) { _emit('diagnostic', { message: String(msg), node: this.#node }); }

  /**
   * Restrict sub-test execution to only() tests.
   * @param {boolean} shouldRunOnlyTests
   */
  runOnly(shouldRunOnlyTests) {
    this.#node._runOnly = !!shouldRunOnlyTests;
  }

  /**
   * Assert a fixed number of assertions/sub-tests will run.
   * @param {number} count
   * @param {{ wait?: boolean|number }} [options]
   */
  plan(count, options = {}) {
    this.#node._plan      = count;
    this.#node._planOpts  = options;
    this.#assert._setPlan(count);
  }

  /**
   * Poll condition until it passes or timeout elapses.
   * @param {Function} condition
   * @param {{ interval?: number, timeout?: number }} [options]
   */
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

// ─── SuiteContext ─────────────────────────────────────────────────────────────
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

// ─── Internal helpers ────────────────────────────────────────────────────────
function _buildFull(node) {
  const parts = []; let n = node;
  while (n) { if (n.name && n.name !== '<root>') parts.unshift(n.name); n = n.parent; }
  return parts.join(' > ');
}

function _resolveArgs(name, opts, fn) {
  if (typeof name === 'function')      { fn = name; name = fn.name || '<anon>'; opts = {}; }
  else if (typeof opts === 'function') { fn = opts; opts = {}; }
  // strip reporter from per-node opts (not meaningful on TestNode)
  if (opts && typeof opts === 'object') {
    const { reporter: _, ...rest } = opts;
    opts = rest;
  }
  return { name: name || fn?.name || '<anon>', opts: opts ?? {}, fn };
}

// ─── Event bus ───────────────────────────────────────────────────────────────
const _listeners = {};
function _on(event, fn)  { (_listeners[event] ??= []).push(fn); }
function _emit(event, d) { (_listeners[event] ?? []).forEach(fn => fn(d)); }

// ─── Root suite singleton ────────────────────────────────────────────────────
let _root    = null;
let _current = null;
let _running = false;

function _getRoot() {
  if (!_root) { _root = new TestNode('<root>', null, {}, null); _root._isSuite = true; }
  return _root;
}

/** Reset all state between test runs. */
export function _reset() {
  _root = null; _current = null; _running = false;
  // Re-read REPORTER_TYPE on each reset so the host can change it between runs.
  _activeReporter = _getConfiguredReporter();
  for (const k of Object.keys(_listeners)) delete _listeners[k];
  _lazyMock = undefined; _lazySnapshot = undefined; _lazyAssert = undefined;
}

// ─── Execution ───────────────────────────────────────────────────────────────
async function _scheduleSubtest(parent, name, opts, fn) {
  const { name: n, opts: o, fn: f } = _resolveArgs(name, opts, fn);
  const node = new TestNode(n, f, o, parent);
  // honour parent's runOnly setting
  if (parent._runOnly && !o.only) { node.opts.skip = 'runOnly'; }
  parent.children.push(node);
  return _runNode(node, parent._beforeEach, parent._afterEach);
}

async function _runNode(node, iBefore = [], iAfter = []) {
  const ctx = new TestContext(node);
  const t0  = performance.now();

  if (node.opts.skip) {
    node.result = 'skip';
    _emit('test:skip', { name: node.name, node });
    node.duration = performance.now() - t0;
    _emit('test:complete', { name: node.name, node });
    return node;
  }
  if (node.opts.todo) {
    node.result = 'todo';
    _emit('test:todo', { name: node.name, node });
    node.duration = performance.now() - t0;
    _emit('test:complete', { name: node.name, node });
    return node;
  }

  // before hooks
  for (const h of [...iBefore, ...node._before]) {
    try { await h.fn(ctx); } catch (e) { if (!node.error) node.error = e; }
  }

  try {
    if (node.fn) {
      const timer = new Promise((_, rej) =>
        (node._timerHandle = globalThis.setTimeout(
          () => rej(new Error(`Test "${node.name}" timed out after ${node.opts.timeout}ms`)),
          node.opts.timeout,
        ))
      );
      const _run = new Promise((res, rej) => {
        try { res(node.fn(ctx)); } catch (e) { rej(e); }
      });
      await Promise.race([_run, timer]);
      globalThis.clearTimeout(node._timerHandle);
    }
    node._passed = true;
    node.result  = 'pass';
    _emit('test:pass', { name: node.name, node });
  } catch (e) {
    globalThis.clearTimeout(node._timerHandle);
    if (e instanceof SkipError) {
      node.result = 'skip'; _emit('test:skip', { name: node.name, node });
    } else if (e instanceof TodoError) {
      node.result = 'todo'; _emit('test:todo', { name: node.name, node });
    } else {
      node._passed = false;
      node.result  = 'fail';
      node.error   = e;
      _emit('test:fail', { name: node.name, node, error: e });
    }
  }

  // after hooks (run even on failure, matching Node spec)
  for (const h of [...node._after, ...iAfter].reverse()) {
    try { await h.fn(ctx); } catch (e) { if (!node.error) node.error = e; }
  }

  // auto-restore per-test mocks
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
    await Promise.all(s.children.map(c => c.isSuite ? _runSuite(c) : _runNode(c, s._beforeEach, s._afterEach)));
  } else {
    for (const c of s.children) {
      if (c.isSuite) await _runSuite(c);
      else           await _runNode(c, s._beforeEach, s._afterEach);
    }
  }

  for (const h of [...s._after].reverse()) { try { await h.fn(ctx); } catch (_) {} }
  _emit('suite:end', { name: s.name, node: s });
}

// ─── Public harness API ──────────────────────────────────────────────────────
function _makeTest(name, opts, fn) {
  const { name: n, opts: o, fn: f } = _resolveArgs(name, opts, fn);
  const parent = _current ?? _getRoot();
  const node   = new TestNode(n, f, o, parent);
  parent.children.push(node);
  return Promise.resolve(node);
}

export function test(name, opts, fn) { return _makeTest(name, opts, fn); }
export function it(name, opts, fn)   { return _makeTest(name, opts, fn); }

// ── Static shorthands: test.skip / test.todo / test.only ─────────────────────
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

it.skip = test.skip;
it.todo = test.todo;
it.only = test.only;

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

export const describe = suite;
describe.skip = suite.skip;
describe.todo = suite.todo;
describe.only = suite.only;

export const before      = (fn, o) => (_current ?? _getRoot())._before.push({ fn, o });
export const after       = (fn, o) => (_current ?? _getRoot())._after.push({ fn, o });
export const beforeEach  = (fn, o) => (_current ?? _getRoot())._beforeEach.push({ fn, o });
export const afterEach   = (fn, o) => (_current ?? _getRoot())._afterEach.push({ fn, o });

// ─── run() — returns async-iterator-compatible stream object ─────────────────
export function run(opts = {}) {
  if (opts.reporter) _activeReporter = _resolveReporter(opts.reporter);
  _running = true;

  const root  = _getRoot();
  const evts  = [];
  const types = ['test:pass','test:fail','test:skip','test:todo','test:complete','suite:start','suite:end','diagnostic'];
  for (const t of types) _on(t, e => evts.push({ type: t, ...e }));

  let _resolve;
  const done = new Promise(r => { _resolve = r; });
  _runSuite(root).then(() => { _running = false; _resolve(evts); });

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
    // minimal EventEmitter shim so run().on('test:fail', cb) works
    on(event, cb) {
      _on(event, cb);
      return this;
    },
  };
}

// ─── snapshot / assert module-level objects ───────────────────────────────────
export const snapshot = Object.freeze({
  setDefaultSnapshotSerializers(_fns) { /* no-op in browser */ },
  setResolveSnapshotPath(_fn)         { /* no-op in browser */ },
});

export const assert = Object.freeze({
  register(name, fn) { TestContext.prototype[name] = fn; },
});

// ─── Lazy singletons ──────────────────────────────────────────────────────────
let _lazyMock, _lazySnapshot, _lazyAssert;

// ─── Default export mirrors `module.exports = test` with all props attached ───
const nodeTest = test;
Object.assign(nodeTest, {
  after, afterEach, before, beforeEach, describe, it, run, suite, test,
  snapshot, assert,
  // Reporter names exposed so user code can write { reporter: tap } etc.
  dot: _dot, spec: _spec, tap: _tap, junit: _junit, lcov: _lcov,
  reporters: REPORTERS,
});

Object.defineProperty(nodeTest, 'mock', {
  configurable: true, enumerable: true,
  get() { return (_lazyMock ??= new MockTracker()); },
});
Object.defineProperty(nodeTest, 'snapshot', {
  configurable: true, enumerable: true,
  get() { return (_lazySnapshot ??= snapshot); },
});
Object.defineProperty(nodeTest, 'assert', {
  configurable: true, enumerable: true,
  get() { return (_lazyAssert ??= assert); },
});

export default nodeTest;

// ─── Full API surface injected into execute() scope ───────────────────────────
const API_KEYS = [
  'test','it','suite','describe',
  'before','after','beforeEach','afterEach',
  'mock','snapshot','assert',
  'dot','spec','tap','junit','lcov',
  'reporters',
];

function makeApiValues() {
  let _mock;
  const mockProxy = new Proxy({}, {
    get(_, k) { return (_mock ??= new MockTracker())[k]; },
  });
  return [
    test, it, suite, describe,
    before, after, beforeEach, afterEach,
    mockProxy, snapshot, _assert,
    _dot, _spec, _tap, _junit, _lcov,
    REPORTERS,
  ];
}



// ─── execute() ───────────────────────────────────────────────────────────────
/**
 * Execute user-supplied test code in an isolated function scope.
 *
 * Reporter resolution order (highest → lowest precedence):
 *   1. opts.reporter — passed directly to execute()
 *   2. { reporter } on any test() call in userCode (first occurrence wins)
 *   3. Module default (spec)
 *
 * @param {string} userCode
 * @param {{ resetBefore?: boolean, reporter?: string|Function }} [opts]
 * @returns {Promise<{ root: TestNode, events: object[], output: string, reporter: Function }>}
 */
export async function execute(userCode, opts = {}) {
  if (opts.resetBefore !== false) _reset();

  // Reporter comes from globalThis._RUNTIME_TEST_RUNNER_.REPORTER_TYPE (set by
  // the host before calling execute), or the execute() opts override — never
  // from inside user code, matching Node's --test-reporter CLI semantics.
  // _reset() already re-read REPORTER_TYPE; allow an explicit opts.reporter to
  // further override for programmatic use.
  if (opts.reporter) _activeReporter = _resolveReporter(opts.reporter);

  // test()/it() do not accept a reporter option in real Node.js.
  // Pass through unchanged — no stripping needed.
  const _patchedTest = test;

  let execFn;
  try {
    const patchedValues = makeApiValues();
    const patchedKeys   = [...API_KEYS];
    const testIdx = patchedKeys.indexOf('test');
    const itIdx   = patchedKeys.indexOf('it');
    patchedValues[testIdx] = _patchedTest;
    patchedValues[itIdx]   = _patchedTest;

    execFn = new Function(...patchedKeys, `return (async()=>{\n${userCode}\n})()`);
    await execFn(...patchedValues);
  } catch (e) {
    if (e instanceof SyntaxError) throw new SyntaxError(`[node:test runtime] ${e.message}`);
    throw e;
  }

  const { root, events, reporter } = await run().drain();

  let output;
  try {
    output = reporter({ root, events });
  } catch (e) {
    throw Object.assign(e, { message: `[reporter:${reporter?.name ?? '?'}] ${e.message}` });
  }

  return { root, events, output, reporter };
}

// ─── Global runtime hook ─────────────────────────────────────────────────────
globalThis._RUNTIME_TEST_RUNNER_ = {
  execute,
  reporters: REPORTERS,
  get activeReporter() { return _activeReporter; },
};
