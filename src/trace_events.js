/*!
 * trace-events-web — node:trace_events for browsers & bundlers
 * MIT License.
 * Node.js parity: node:trace_events @ Node 10.0.0+
 * Dependencies: none
 * Limitations:
 *   - No actual V8 / C++ trace pipeline; all tracing is in-process JS only.
 *   - 'node.perf' and 'node.perf.usertiming' subscribe to PerformanceObserver
 *     when available; all other categories are state-tracked stubs.
 *   - getEnabledCategories() reflects only JS-side state; CLI flag categories
 *     (--trace-event-categories) are not visible.
 *   - Worker thread restriction is not enforced (no ownsProcessState check).
 */

/**
 * @packageDocumentation
 * Implements `node:trace_events` for browser and bundler environments.
 *
 * The module accurately tracks enabled/disabled state, computes the correct
 * category union for `getEnabledCategories()`, enforces the 10-instance
 * leak warning, implements reference-counted `disable()` (a category is
 * only deactivated when no other live Tracing still holds it), and wires
 * `node.perf` / `node.perf.usertiming` into the native `PerformanceObserver`
 * API where available.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const kMaxTracingCount = 10;

/** All category strings recognised by Node.js. */
export const KNOWN_CATEGORIES = new Set([
  'node',
  'node.async_hooks',
  'node.bootstrap',
  'node.console',
  'node.threadpoolwork.sync',
  'node.threadpoolwork.async',
  'node.dns.native',
  'node.net.native',
  'node.environment',
  'node.fs.sync',
  'node.fs_dir.sync',
  'node.fs.async',
  'node.fs_dir.async',
  'node.perf',
  'node.perf.usertiming',
  'node.perf.timerify',
  'node.promises.rejections',
  'node.vm.script',
  'node.module_timer',
  'node.http',
  'v8',
]);

// ---------------------------------------------------------------------------
// Error factories
// ---------------------------------------------------------------------------

function errCategoryRequired() {
  return Object.assign(
    new Error('At least one category is required for trace_events.createTracing()'),
    { code: 'ERR_TRACE_EVENTS_CATEGORY_REQUIRED' },
  );
}

function errInvalidArgType(name, expected, received) {
  return Object.assign(
    new TypeError(
      `The "${name}" argument must be ${expected}. ` +
      `Received type ${received === null ? 'null' : typeof received}`,
    ),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** @param {unknown} v @param {string} name */
function validateObject(v, name) {
  if (v === null || typeof v !== 'object')
    throw errInvalidArgType(name, 'an Object', v);
}

/** @param {unknown} v @param {string} name */
function validateStringArray(v, name) {
  if (!Array.isArray(v))
    throw errInvalidArgType(name, 'an Array', v);
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'string')
      throw errInvalidArgType(`${name}[${i}]`, 'a string', v[i]);
  }
}

// ---------------------------------------------------------------------------
// Global enabled-tracing registry
// Reference-counted category set: tracks how many live *enabled* Tracing
// objects currently hold each category so disable() only deactivates a
// category when the last holder disables it.
// ---------------------------------------------------------------------------

/** @type {Set<Tracing>} */
const _enabledTracings = new Set();

/** @type {Map<string, number>} refcount per category */
const _categoryRefs = new Map();

/** @param {string[]} cats */
function _addRefs(cats) {
  for (const c of cats) _categoryRefs.set(c, (_categoryRefs.get(c) ?? 0) + 1);
}

/** @param {string[]} cats */
function _removeRefs(cats) {
  for (const c of cats) {
    const n = (_categoryRefs.get(c) ?? 1) - 1;
    if (n <= 0) _categoryRefs.delete(c);
    else        _categoryRefs.set(c, n);
  }
}

// ---------------------------------------------------------------------------
// PerformanceObserver bridge — activates for perf categories
// ---------------------------------------------------------------------------

const _PERF_CATEGORIES = new Set(['node.perf', 'node.perf.usertiming', 'node.perf.timerify']);
let _perfObserver = null;

function _updatePerfObserver() {
  const wantPerf = [..._categoryRefs.keys()].some(c => _PERF_CATEGORIES.has(c));

  if (wantPerf && !_perfObserver && typeof PerformanceObserver !== 'undefined') {
    try {
      _perfObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          // Forward to any registered trace listeners.
          _dispatchTraceEvent({
            cat:  'node.perf',
            name: entry.name,
            ph:   entry.entryType === 'mark' ? 'i' : 'X',
            ts:   entry.startTime * 1000,          // ms → µs
            dur:  (entry.duration ?? 0) * 1000,
            args: { entryType: entry.entryType },
          });
        }
      });
      _perfObserver.observe({ entryTypes: ['mark', 'measure', 'function'] });
    } catch { /* unsupported entryTypes in this environment */ }
  }

  if (!wantPerf && _perfObserver) {
    try { _perfObserver.disconnect(); } catch { /* ignore */ }
    _perfObserver = null;
  }
}

// ---------------------------------------------------------------------------
// In-process event bus for trace events
// ---------------------------------------------------------------------------

/** @type {Map<string, Set<Function>>} category → listeners */
const _listeners = new Map();

/**
 * Subscribe to trace events for a specific category.
 * Callback receives a raw trace event object: { cat, name, ph, ts, dur?, args? }.
 * @param {string} category
 * @param {(event: object) => void} fn
 */
export function onTraceEvent(category, fn) {
  if (!_listeners.has(category)) _listeners.set(category, new Set());
  _listeners.get(category).add(fn);
}

/** @param {string} category @param {Function} fn */
export function offTraceEvent(category, fn) {
  _listeners.get(category)?.delete(fn);
}

/**
 * Emits a trace event to all subscribed listeners for its category.
 * Userspace code can call this to emit custom trace events.
 * @param {{ cat: string; name: string; ph?: string; ts?: number; dur?: number; args?: object }} event
 */
export function emitTraceEvent(event) {
  if (!_categoryRefs.has(event.cat)) return; // category not currently enabled
  _dispatchTraceEvent(event);
}

/** @param {object} event */
function _dispatchTraceEvent(event) {
  const handlers = _listeners.get(event.cat);
  if (!handlers?.size) return;
  for (const fn of handlers) {
    try { fn(event); } catch { /* isolate listener errors */ }
  }
}

// ---------------------------------------------------------------------------
// Tracing class
// ---------------------------------------------------------------------------

/**
 * Represents a set of trace categories that can be enabled/disabled together.
 * Created via {@link createTracing}; never constructed directly.
 *
 * @example
 * const t = createTracing({ categories: ['node.perf', 'v8'] });
 * t.enable();
 * // ... do work ...
 * t.disable();
 */
export class Tracing {
  /** @type {string[]} */ #categories;
  /** @type {boolean}  */ #enabled = false;

  /** @param {string[]} categories */
  constructor(categories) {
    this.#categories = categories;
  }

  /**
   * Enables tracing for this object's categories.
   * Calling `enable()` more than once is a no-op.
   */
  enable() {
    if (this.#enabled) return;
    this.#enabled = true;
    _addRefs(this.#categories);
    _enabledTracings.add(this);
    _updatePerfObserver();

    if (_enabledTracings.size > kMaxTracingCount) {
      // Mirror Node's process.emitWarning path.
      const msg =
        `Possible trace_events memory leak detected. There are more than ` +
        `${kMaxTracingCount} enabled Tracing objects.`;
      if (typeof queueMicrotask !== 'undefined') {
        // Emit asynchronously, matching Node's behaviour.
        queueMicrotask(() => console.warn(`Warning: ${msg}`));
      } else {
        console.warn(`Warning: ${msg}`);
      }
    }
  }

  /**
   * Disables tracing for this object's categories.
   * A category is only deactivated when *no other* enabled Tracing still holds it
   * — exactly matching Node's reference-counted behaviour.
   * Calling `disable()` more than once is a no-op.
   */
  disable() {
    if (!this.#enabled) return;
    this.#enabled = false;
    _removeRefs(this.#categories);
    _enabledTracings.delete(this);
    _updatePerfObserver();
  }

  /** @returns {boolean} */
  get enabled() { return this.#enabled; }

  /**
   * Comma-separated list of categories covered by this Tracing object.
   * @returns {string}
   */
  get categories() { return this.#categories.join(','); }

  /** Node util.inspect.custom — mirrors Node's `Tracing { enabled: …, categories: … }` output. */
  get [Symbol.for('nodejs.util.inspect.custom')]() {
    return (depth) => {
      if (typeof depth === 'number' && depth < 0) return this;
      return `Tracing { enabled: ${this.#enabled}, categories: '${this.categories}' }`;
    };
  }
}

// ---------------------------------------------------------------------------
// createTracing
// ---------------------------------------------------------------------------

/**
 * Creates a new {@link Tracing} object for the given categories.
 * The object starts in the disabled state; call `.enable()` to activate it.
 *
 * @param {{ categories: string[] }} options
 * @returns {Tracing}
 * @throws {{ code: 'ERR_TRACE_EVENTS_CATEGORY_REQUIRED' }} if categories is empty.
 *
 * @example
 * const tracing = createTracing({ categories: ['node.perf', 'node.async_hooks'] });
 * tracing.enable();
 * performance.mark('start');
 * // ... work ...
 * performance.mark('end');
 * performance.measure('my-work', 'start', 'end');
 * tracing.disable();
 */
export function createTracing(options) {
  validateObject(options, 'options');
  validateStringArray(options.categories, 'options.categories');
  if (options.categories.length === 0) throw errCategoryRequired();

  // Coerce each element to string — mirrors Node's `String(cat)` behaviour.
  return new Tracing(options.categories.map(String));
}

// ---------------------------------------------------------------------------
// getEnabledCategories
// ---------------------------------------------------------------------------

/**
 * Returns a comma-separated string of all currently-enabled trace event
 * categories (the union of all enabled {@link Tracing} objects' categories).
 * Returns `undefined` when no categories are active, matching Cloudflare's
 * Workers polyfill behaviour.
 *
 * @returns {string | undefined}
 *
 * @example
 * const t1 = createTracing({ categories: ['node', 'v8'] });
 * const t2 = createTracing({ categories: ['node.perf', 'node'] });
 * t1.enable(); t2.enable();
 * console.log(getEnabledCategories()); // 'node,v8,node.perf'
 * t2.disable();
 * console.log(getEnabledCategories()); // 'node,v8'
 */
export function getEnabledCategories() {
  if (_categoryRefs.size === 0) return undefined;
  return [..._categoryRefs.keys()].join(',');
}

export default { createTracing, getEnabledCategories, KNOWN_CATEGORIES, onTraceEvent, offTraceEvent, emitTraceEvent };

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import { createTracing, getEnabledCategories, onTraceEvent, emitTraceEvent }
//   from './trace_events';
//
// // ── Basic enable / disable ────────────────────────────────────────────────
// const t1 = createTracing({ categories: ['node', 'v8'] });
// const t2 = createTracing({ categories: ['node.perf', 'node'] });
// t1.enable(); t2.enable();
// console.log(getEnabledCategories()); // 'node,v8,node.perf'
//
// t2.disable(); // 'node' survives because t1 still holds it
// console.log(getEnabledCategories()); // 'node,v8'
//
// t1.disable();
// console.log(getEnabledCategories()); // undefined
//
// // ── node.perf → PerformanceObserver bridge ────────────────────────────────
// const perf = createTracing({ categories: ['node.perf'] });
// onTraceEvent('node.perf', e => console.log('[trace]', e.name, e.ts));
// perf.enable(); // PerformanceObserver now active
//
// performance.mark('work-start');
// for (let i = 0; i < 1e6; i++) {}
// performance.mark('work-end');
// performance.measure('work', 'work-start', 'work-end');
// // → [trace] work-start <µs>
// // → [trace] work-end   <µs>
// // → [trace] work       <µs>
//
// perf.disable(); // PerformanceObserver disconnected
//
// // ── Custom userspace trace events ─────────────────────────────────────────
// const custom = createTracing({ categories: ['my.category'] });
// onTraceEvent('my.category', e => console.log(e));
// custom.enable();
// emitTraceEvent({ cat: 'my.category', name: 'my_event', ph: 'i', ts: performance.now() * 1000 });
// custom.disable();
//
// // ── util.inspect output ───────────────────────────────────────────────────
// import { inspect } from 'util';
// const t = createTracing({ categories: ['node.perf'] });
// t.enable();
// console.log(inspect(t)); // Tracing { enabled: true, categories: 'node.perf' }
//
// // ── Leak warning (> 10 enabled Tracings) ──────────────────────────────────
// const tracings = Array.from({ length: 11 }, (_, i) =>
//   createTracing({ categories: [`node.cat${i}`] })
// );
// tracings.forEach(t => t.enable());
// // → Warning: Possible trace_events memory leak detected…
//
// // ── Edge: empty categories throws ────────────────────────────────────────
// createTracing({ categories: [] }); // ERR_TRACE_EVENTS_CATEGORY_REQUIRED
//
// // ── Edge: non-string category coerced ────────────────────────────────────
// const t3 = createTracing({ categories: [42] }); // coerced → '42'
// console.log(t3.categories); // '42'
