/*!
 * node:trace_events — honest browser stub.
 *
 * In a browser there is no V8/C++ trace pipeline, no trace-event log files,
 * and no `--trace-event-categories` CLI flags. This shim therefore implements
 * only the observable JavaScript surface of node:trace_events as a pure,
 * dependency-free, in-process state tracker:
 *
 *   - createTracing({ categories }) validates its arguments exactly like
 *     Node (same error codes and TypeError names) and returns a Tracing.
 *   - Tracing exposes `categories`, `enable()`, `disable()`, `enabled`.
 *   - getEnabledCategories() returns the union of the categories of all
 *     currently-enabled Tracing objects, or `undefined` when none are
 *     enabled — matching real Node.
 *   - Enabling more than 10 Tracing objects emits the same memory-leak
 *     warning Node emits (via process.emitWarning where available,
 *     console.warn otherwise).
 *
 * Honest gaps — no tracing backend exists in this lane:
 *   - No trace events are ever recorded, and no `node_trace.*.log` files
 *     are written.
 *   - The internal `internalBinding('trace_events')` API is unavailable.
 *   - CLI flags (`--trace-event-categories`, `--trace-events-enabled`)
 *     have no effect; getEnabledCategories() reflects only this module's
 *     own state.
 *
 * No runtime services are required: the module never touches
 * `globalThis._RUNTIME_`, `window`, `document`, `Buffer`, or any native
 * Node builtin, so it works identically in the sandbox, in workers, and
 * under plain Node.
 */

/**
 * @packageDocumentation
 * Browser stub for `node:trace_events`. Tracks enabled/disabled state with
 * reference-counted categories; records nothing.
 */

// ---------------------------------------------------------------------------
// Error factories (mirror Node's messages and error classes)
// ---------------------------------------------------------------------------

/**
 * Formats the "Received ..." suffix the way Node's internal validators do.
 * @param {unknown} v
 * @returns {string}
 */
function formatReceived(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  switch (t) {
    case 'string':
      return `type string ('${v}')`;
    case 'number':
    case 'boolean':
    case 'bigint':
      return `type ${t} (${String(v)})`;
    case 'symbol':
      return `type symbol (${String(v)})`;
    case 'function':
      return `type function (${v.name || 'anonymous'})`;
    default:
      // Node reports objects as "an instance of <ConstructorName>".
      return `an instance of ${v.constructor?.name ?? 'Object'}`;
  }
}

/**
 * @param {string} name
 * @param {'object' | 'an Array' | 'a string'} expected
 * @param {unknown} received
 */
function errInvalidArgType(name, expected, received) {
  const verb = expected === 'object' ? 'argument must be of type object'
    : expected === 'an Array' ? 'property must be an instance of Array'
    : 'property must be of type string';
  return Object.assign(
    new TypeError(`The "${name}" ${verb}. Received ${formatReceived(received)}`),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
}

function errCategoryRequired() {
  return Object.assign(
    new TypeError('At least one category is required'),
    { code: 'ERR_TRACE_EVENTS_CATEGORY_REQUIRED' },
  );
}

// ---------------------------------------------------------------------------
// Global enabled-tracing registry.
// Reference-counted category set so disable() only deactivates a category
// when no other enabled Tracing still holds it (matches Node). Enabled
// Tracing objects are retained here so they survive garbage collection
// while enabled, exactly like Node's native set.
// ---------------------------------------------------------------------------

/** @type {Set<Tracing>} */
const _enabledTracings = new Set();

/** @type {Map<string, number>} live enabled holders per category */
const _categoryRefs = new Map();

const kMaxTracingCount = 10;

/** @param {string[]} cats */
function _addRefs(cats) {
  for (const c of cats) _categoryRefs.set(c, (_categoryRefs.get(c) ?? 0) + 1);
}

/** @param {string[]} cats */
function _removeRefs(cats) {
  for (const c of cats) {
    const n = (_categoryRefs.get(c) ?? 1) - 1;
    if (n <= 0) _categoryRefs.delete(c);
    else _categoryRefs.set(c, n);
  }
}

function _warnLeak() {
  const msg =
    'Possible trace_events memory leak detected. ' +
    'There are more than 10 enabled Tracing objects.';
  const proc = typeof globalThis.process !== 'undefined'
    ? globalThis.process
    : undefined;
  if (proc && typeof proc.emitWarning === 'function') {
    proc.emitWarning(msg);
  } else if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`Warning: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

/**
 * A set of trace categories that can be enabled/disabled together.
 * Created via {@link createTracing}; starts disabled.
 * (Not exported — matches Node, where the class is not public.)
 */
class Tracing {
  /** @type {string[]} */ #categories;
  /** @type {boolean} */ #enabled = false;

  /** @param {string[]} categories (already validated) */
  constructor(categories) {
    this.#categories = categories;
  }

  /**
   * Enables tracing for this object's categories. Calling `enable()` more
   * than once is a no-op. Records nothing — there is no trace backend in
   * the browser lane.
   */
  enable() {
    if (this.#enabled) return;
    this.#enabled = true;
    _addRefs(this.#categories);
    _enabledTracings.add(this);
    if (_enabledTracings.size > kMaxTracingCount) _warnLeak();
  }

  /**
   * Disables tracing for this object's categories. A category stays enabled
   * while any other enabled Tracing still holds it. Calling `disable()`
   * more than once is a no-op.
   */
  disable() {
    if (!this.#enabled) return;
    this.#enabled = false;
    _removeRefs(this.#categories);
    _enabledTracings.delete(this);
  }

  /** Whether this Tracing is currently enabled. */
  get enabled() { return this.#enabled; }

  /** Comma-separated list of this object's categories. */
  get categories() { return this.#categories.join(','); }

  /** Mirrors Node's `Tracing { enabled: …, categories: '…' }` inspect output. */
  get [Symbol.for('nodejs.util.inspect.custom')]() {
    return () => `Tracing { enabled: ${this.#enabled}, categories: '${this.categories}' }`;
  }
}

// ---------------------------------------------------------------------------
// createTracing / getEnabledCategories
// ---------------------------------------------------------------------------

/**
 * Creates a new {@link Tracing} for the given categories. The object starts
 * disabled; call `.enable()` to activate it.
 *
 * @param {{ categories: string[] }} options
 * @returns {Tracing}
 * @throws {TypeError} with code `ERR_INVALID_ARG_TYPE` on bad arguments,
 *   or code `ERR_TRACE_EVENTS_CATEGORY_REQUIRED` when `categories` is empty.
 */
export function createTracing(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw errInvalidArgType('options', 'object', options);
  }
  const { categories } = options;
  if (!Array.isArray(categories)) {
    throw errInvalidArgType('options.categories', 'an Array', categories);
  }
  for (let i = 0; i < categories.length; i++) {
    if (typeof categories[i] !== 'string') {
      throw errInvalidArgType(`options.categories[${i}]`, 'a string', categories[i]);
    }
  }
  if (categories.length === 0) throw errCategoryRequired();
  return new Tracing(categories.slice());
}

/**
 * Returns a comma-separated string of all currently-enabled trace event
 * categories (the union of every enabled {@link Tracing}'s categories), or
 * `undefined` when none are enabled — matching real Node.
 *
 * @returns {string | undefined}
 */
export function getEnabledCategories() {
  if (_categoryRefs.size === 0) return undefined;
  return [..._categoryRefs.keys()].join(',');
}

export default { createTracing, getEnabledCategories };
