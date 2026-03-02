
/**
 * node-test-browser.js
 * Drop-in browser ESM port of Node.js `node:test`
 * Same named exports as the native module.
 */

// ─── Internal error types ────────────────────────────────────────────────────
export class SkipError    extends Error { constructor(m=''){super(m);this.name='SkipError';} }
export class TodoError    extends Error { constructor(m=''){super(m);this.name='TodoError';} }
export class AssertionError extends Error { constructor(m=''){super(m);this.name='AssertionError';} }

// ─── Deep equality ───────────────────────────────────────────────────────────
function deepEq(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v,i) => deepEq(v, b[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => deepEq(a[k], b[k]));
}

// ─── assert namespace (matches node:assert interface on t.assert) ─────────────
class CtxAssert {
  ok(v, m)           { if (!v) throw new AssertionError(m ?? `Expected truthy, got ${v}`); }
  fail(m)            { throw new AssertionError(m ?? 'Explicit fail'); }
  equal(a, b, m)     { if (a !== b) throw new AssertionError(m ?? `${a} !== ${b}`); }
  notEqual(a, b, m)  { if (a === b) throw new AssertionError(m ?? `Expected not equal`); }
  strictEqual(a,b,m) { if (!Object.is(a,b)) throw new AssertionError(m ?? `${String(a)} !== ${String(b)} (strict)`); }
  notStrictEqual(a,b,m){ if (Object.is(a,b)) throw new AssertionError(m ?? `Expected not strict equal`); }
  deepEqual(a,b,m)   { if (!deepEq(a,b)) throw new AssertionError(m ?? `Deep equality failed`); }
  notDeepEqual(a,b,m){ if ( deepEq(a,b)) throw new AssertionError(m ?? `Expected deep not equal`); }
  throws(fn, expected, m) {
    try { fn(); }
    catch(e) {
      if (expected instanceof RegExp && !expected.test(e.message))
        throw new AssertionError(m ?? `Error message did not match ${expected}`);
      return;
    }
    throw new AssertionError(m ?? 'Expected function to throw');
  }
  doesNotThrow(fn, m){ try { fn(); } catch(e) { throw new AssertionError(m ?? `Got: ${e}`); } }
  rejects(fn, m)     { return Promise.resolve().then(()=>fn()).then(()=>{ throw new AssertionError(m??'Expected rejection'); },()=>{}); }
  doesNotReject(fn,m){ return Promise.resolve().then(()=>fn()).catch(e=>{ throw new AssertionError(m??`Got rejection: ${e}`); }); }
  ifError(e)         { if (e != null) throw new AssertionError(`ifError got ${e}`); }
  match(s,re,m)      { if (!re.test(s)) throw new AssertionError(m ?? `${s} did not match ${re}`); }
  doesNotMatch(s,re,m){ if (re.test(s)) throw new AssertionError(m ?? `${s} matched ${re}`); }
}

// ─── TestNode ────────────────────────────────────────────────────────────────
class TestNode {
  constructor(name, fn, opts, parent) {
    this.name     = name;
    this.fn       = fn;
    this.parent   = parent;
    this.opts     = { skip: false, todo: false, timeout: 5000, concurrency: false, ...opts };
    this.children = [];
    this.result   = null;   // 'pass' | 'fail' | 'skip' | 'todo'
    this.error    = null;
    this.duration = 0;
    this._isSuite   = false;
    this._before    = [];
    this._after     = [];
    this._beforeEach = [];
    this._afterEach  = [];
  }
  get isSuite() { return this._isSuite || !this.fn; }
}

// ─── TestContext (the `t` argument) ─────────────────────────────────────────
class TestContext {
  #node;
  constructor(node) {
    this.#node    = node;
    this.name     = node.name;
    this.fullName = _buildFull(node);
    this.assert   = new CtxAssert();
    this.signal   = null; // AbortSignal could go here
  }

  // Sub-test / hooks from inside a running test
  test(n, o, f)      { return _scheduleSubtest(this.#node, n, o, f); }
  it(n, o, f)        { return this.test(n, o, f); }
  before(fn, o)      { this.#node._before.push({ fn, o }); }
  after(fn, o)       { this.#node._after.push({ fn, o }); }
  beforeEach(fn, o)  { this.#node._beforeEach.push({ fn, o }); }
  afterEach(fn, o)   { this.#node._afterEach.push({ fn, o }); }
  skip(msg = '')     { this.#node.opts.skip = msg || true; throw new SkipError(msg); }
  todo(msg = '')     { this.#node.opts.todo = msg || true; throw new TodoError(msg); }
  diagnostic(msg)    { _emit('diagnostic', { message: String(msg), node: this.#node }); }
}

// ─── Internal helpers ────────────────────────────────────────────────────────
function _buildFull(node) {
  const p = []; let n = node;
  while (n) { if (n.name && n.name !== '<root>') p.unshift(n.name); n = n.parent; }
  return p.join(' > ');
}

function _resolveArgs(name, opts, fn) {
  if (typeof name === 'function')     { fn = name; name = fn.name || '<anon>'; opts = {}; }
  else if (typeof opts === 'function'){ fn = opts; opts = {}; }
  return { name: name || (fn?.name) || '<anon>', opts: opts ?? {}, fn };
}

// ─── Event bus ───────────────────────────────────────────────────────────────
const _listeners = {};
function _on(event, fn)  { (_listeners[event] ??= []).push(fn); }
function _emit(event, d) { (_listeners[event] ?? []).forEach(fn => fn(d)); }

// ─── Root suite singleton ────────────────────────────────────────────────────
let _root    = null;
let _current = null;   // suite currently being defined
let _running = false;

function _getRoot() {
  if (!_root) { _root = new TestNode('<root>', null, {}, null); _root._isSuite = true; }
  return _root;
}

/** Reset all state — call between test runs */
export function _reset() {
  _root = null; _current = null; _running = false;
  for (const k of Object.keys(_listeners)) delete _listeners[k];
  _lazyMock = undefined; _lazySnapshot = undefined; _lazyAssert = undefined;
}

// ─── Execution ───────────────────────────────────────────────────────────────
async function _scheduleSubtest(parent, name, opts, fn) {
  const { name: n, opts: o, fn: f } = _resolveArgs(name, opts, fn);
  const node = new TestNode(n, f, o, parent);
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
    try { await h.fn(ctx); } catch(e) { node.error = e; }
  }

  try {
    if (node.fn) {
      const timer = new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`Test "${node.name}" timed out after ${node.opts.timeout}ms`)), node.opts.timeout)
      );
      await Promise.race([Promise.resolve(node.fn(ctx)), timer]);
    }
    node.result = 'pass';
    _emit('test:pass', { name: node.name, node });
  } catch(e) {
    if (e instanceof SkipError) {
      node.result = 'skip'; _emit('test:skip', { name: node.name, node });
    } else if (e instanceof TodoError) {
      node.result = 'todo'; _emit('test:todo', { name: node.name, node });
    } else {
      node.result = 'fail'; node.error = e;
      _emit('test:fail', { name: node.name, node, error: e });
    }
  }

  // after hooks
  for (const h of [...node._after, ...iAfter].reverse()) {
    try { await h.fn(ctx); } catch(e) { if (!node.error) node.error = e; }
  }

  node.duration = performance.now() - t0;
  _emit('test:complete', { name: node.name, node });
  return node;
}

async function _runSuite(s) {
  _emit('suite:start', { name: s.name, node: s });
  const ctx = new TestContext(s);

  for (const h of s._before) { try { await h.fn(ctx); } catch(_) {} }

  if (s.opts.concurrency) {
    await Promise.all(s.children.map(c => c.isSuite ? _runSuite(c) : _runNode(c, s._beforeEach, s._afterEach)));
  } else {
    for (const c of s.children) {
      if (c.isSuite) await _runSuite(c);
      else           await _runNode(c, s._beforeEach, s._afterEach);
    }
  }

  for (const h of [...s._after].reverse()) { try { await h.fn(ctx); } catch(_) {} }
  _emit('suite:end', { name: s.name, node: s });
}

// ─── Public harness API ──────────────────────────────────────────────────────
export function test(name, opts, fn) {
  const { name: n, opts: o, fn: f } = _resolveArgs(name, opts, fn);
  const parent = _current ?? _getRoot();
  const node   = new TestNode(n, f, o, parent);
  parent.children.push(node);
  return Promise.resolve(node);
}

export function suite(name, opts, fn) {
  const { name: n, opts: o, fn: f } = _resolveArgs(name, opts, fn);
  const parent = _current ?? _getRoot();
  const node   = new TestNode(n, f, o, parent);
  node._isSuite = true;
  parent.children.push(node);
  if (f) {
    const prev = _current; _current = node;
    try { f(new TestContext(node)); } catch(e) { node.error = e; }
    _current = prev;
  }
  return Promise.resolve(node);
}

export const before      = (fn, o) => (_current ?? _getRoot())._before.push({ fn, o });
export const after       = (fn, o) => (_current ?? _getRoot())._after.push({ fn, o });
export const beforeEach  = (fn, o) => (_current ?? _getRoot())._beforeEach.push({ fn, o });
export const afterEach   = (fn, o) => (_current ?? _getRoot())._afterEach.push({ fn, o });
export const describe    = suite;
export const it          = test;

// ─── run() — returns an async iterator of typed events ───────────────────────
export function run(opts = {}) {
  _running = true;
  const root  = _getRoot();
  const evts  = [];
  const types = ['test:pass','test:fail','test:skip','test:todo','test:complete','suite:start','suite:end','diagnostic'];
  for (const t of types) _on(t, e => evts.push({ type: t, ...e }));

  let _resolve;
  const done = new Promise(r => { _resolve = r; });
  _runSuite(root).then(() => { _running = false; _resolve(evts); });

  // Async iterator (node:test stream-compatible)
  return {
    async *[Symbol.asyncIterator]() {
      const all = await done;
      for (const e of all) yield e;
    },
    /** Collect all events into an array */
    async collect() {
      return done;
    },
    /** Returns { root, events } — convenience for single await */
    async drain() {
      const events = await done;
      return { root, events };
    },
  };
}

// ─── MockTracker ─────────────────────────────────────────────────────────────
class MockFnContext {
  #calls = [];
  #impl;
  constructor(impl) { this.#impl = impl; }
  get calls()             { return [...this.#calls]; }
  _record(args, ret, err) { this.#calls.push({ arguments: args, return: ret, error: err }); }
  resetCalls()            { this.#calls = []; }
  mockImplementation(fn)  { this.#impl = fn; }
  mockImplementationOnce(fn) {
    const prev = this.#impl;
    this.#impl = (...a) => { this.#impl = prev; return fn(...a); };
  }
  get implementation()    { return this.#impl; }
}

export class MockTracker {
  #mocks = [];

  fn(impl = () => {}) {
    const ctx = new MockFnContext(impl);
    const m = (...args) => {
      let r, e;
      try { r = ctx.implementation(...args); }
      catch(ex) { e = ex; ctx._record(args, undefined, ex); throw ex; }
      ctx._record(args, r, undefined);
      return r;
    };
    m.mock = ctx;
    this.#mocks.push({ ctx, m, type: 'fn' });
    return m;
  }

  method(obj, name, impl) {
    const orig = obj[name];
    if (typeof impl !== 'function') impl = orig;
    const ctx = new MockFnContext(impl);
    const m = function(...args) {
      let r, e;
      try { r = ctx.implementation.apply(this, args); }
      catch(ex) { e = ex; ctx._record(args, undefined, ex); throw ex; }
      ctx._record(args, r, undefined);
      return r;
    };
    m.mock = ctx;
    obj[name] = m;
    this.#mocks.push({ ctx, m, obj, name, orig, type: 'method' });
    return m;
  }

  getter(obj, prop, impl) {
    const orig = Object.getOwnPropertyDescriptor(obj, prop);
    const ctx  = new MockFnContext(impl);
    Object.defineProperty(obj, prop, { configurable: true, enumerable: true,
      get() { const r = ctx.implementation.call(this); ctx._record([], r, undefined); return r; }
    });
    this.#mocks.push({ ctx, obj, prop, orig, type: 'getter' });
    return ctx;
  }

  setter(obj, prop, impl) {
    const orig = Object.getOwnPropertyDescriptor(obj, prop);
    const ctx  = new MockFnContext(impl);
    Object.defineProperty(obj, prop, { configurable: true,
      set(v) { ctx.implementation.call(this, v); ctx._record([v], undefined, undefined); }
    });
    this.#mocks.push({ ctx, obj, prop, orig, type: 'setter' });
    return ctx;
  }

  restoreAll() {
    for (const m of this.#mocks) {
      if (m.type === 'method') m.obj[m.name] = m.orig;
      if (m.type === 'getter' || m.type === 'setter') {
        m.orig ? Object.defineProperty(m.obj, m.prop, m.orig) : delete m.obj[m.prop];
      }
    }
    this.#mocks = [];
  }

  reset() { this.restoreAll(); }
}

// ─── Snapshot ────────────────────────────────────────────────────────────────
export const snapshot = Object.freeze({
  setDefaultSnapshotSerializers(_fns) { /* no-op in browser */ },
  setResolveSnapshotPath(_fn)         { /* no-op in browser */ },
});

// ─── assert.register ─────────────────────────────────────────────────────────
export const assert = Object.freeze({
  register(name, fn) { TestContext.prototype[name] = fn; },
});

// ─── Lazy singletons (matching node:test module-level properties) ─────────────
let _lazyMock, _lazySnapshot, _lazyAssert;

// ─── Default export mirrors `module.exports = test` with all props attached ──
const nodeTest = test;
Object.assign(nodeTest, { after, afterEach, before, beforeEach, describe, it, run, suite, test });
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



// Below is for Runtime. 

// ─── Full API injected on every run ──────────────────────────────────────────

const API_KEYS = ['test','it','suite','describe','before','after','beforeEach','afterEach','mock','snapshot','assert'];

function makeApiValues() {
  let _mock;
  const mock = new Proxy({}, {
    get(_, k) { return (_mock ??= new MockTracker())[k]; }
  });
  return [test, it, suite, describe, before, after, beforeEach, afterEach, mock, snapshot, assert];
}


// ─── execute ─────────────────────────────────────────────────────────────────

async function execute(userCode, opts = {}) {
  if (opts.resetBefore !== false) _reset();
  let fn;
  try {
    fn = new Function(...API_KEYS, `return (async()=>{\n${userCode}\n})()`);
  } catch(e) {
    throw new SyntaxError(`[node:test runtime] ${e.message}`);
  }

  await fn(...makeApiValues());
  return await run().drain();  // → { root, events }
}

globalThis._RUNTIME_TEST_RUNNER_ = execute;

// ─── Detect test files (mirrors Node --test heuristic) ───────────────────────
/*
export function isTestFile(src) {
  return (
    /['"]node:test['"]/.test(src)         ||
    /\b(?:test|it|describe)\s*\(/.test(src)
  );
}

execute(`
 
describe('my suite', () => {
  it('works', async (t) => {
    t.assert.equal(1 + 1, 2);
  });
});`)
*/
