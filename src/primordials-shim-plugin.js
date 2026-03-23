/**
 * Fetches lib/internal/per_context/primordials.js from the Node.js GitHub repo,
 * parses every identifier it would assign to `primordials`, then synthesises a
 * browser-safe ES-module shim that binds each one against the real JS built-ins.
 *
 * The generated shim is injected as a synthetic module so that both patterns work:
 *   - `var primordials = ...`  (banner global, for raw fetched files)
 *   - `require('internal/per_context/primordials')` (intercepted resolve)
 *
 * Usage:
 *   plugins: [primordialsShimPlugin(), nodeGitHubPlugin()]
 *
 * nodeGitHubPlugin should prepend the following to every node-gh loaded file:
 *   var primordials = globalThis.__primordials__;
 */

const RAW_PRIMORDIALS =
  'https://raw.githubusercontent.com/nodejs/node/main/lib/internal/per_context/primordials.js';

export function primordialsShimPlugin() {
  return {
    name: 'primordials-shim',
    setup(build) {
      // Intercept every spelling Node code uses to require this file
      const ALIASES = [
        /^internal\/per_context\/primordials$/,
        /^internal\/primordials$/,
        /^primordials$/,
      ];
      for (const filter of ALIASES) {
        build.onResolve({ filter }, () => ({
          path: 'primordials',
          namespace: 'primordials-shim',
        }));
      }

      let shimPromise = null; // fetch once, reuse
      build.onLoad({ filter: /.*/, namespace: 'primordials-shim' }, async () => {
        shimPromise ??= buildShim();
        const contents = await shimPromise;
        return { contents, loader: 'js' };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Core: fetch real source → parse identifiers → emit browser bindings
// ---------------------------------------------------------------------------

async function buildShim() {
  const src = await fetchWithRetry(RAW_PRIMORDIALS);
  const names = extractPrimordialNames(src);
  return emitShim(names);
}

/**
 * Parse the primordials source to collect every name that Node assigns.
 *
 * The file uses three patterns:
 *   primordials.FooBar = ...
 *   ObjectDefineProperties(primordials, { FooBar: { ... } })
 *   copyPropsRenamed(Foo, primordials, 'Foo')   ← bulk copy
 *
 * We grab the explicit assignments + the bulk-copy source names so we can
 * re-derive the full set in the shim emitter.
 */
function extractPrimordialNames(src) {
  const explicit = new Set();
  const bulkSources = new Set(); // e.g. 'Array', 'String', 'Object' …

  // Pattern 1: primordials.XYZ =
  for (const [, name] of src.matchAll(/\bprimordials\.([A-Za-z0-9_$]+)\s*=/g)) {
    explicit.add(name);
  }

  // Pattern 2: ObjectDefineProperties(primordials, { XYZ: {
  for (const [, name] of src.matchAll(/\bObjectDefineProperties\s*\(\s*primordials\s*,\s*\{[^}]*?([A-Za-z0-9_$]+)\s*:/gs)) {
    explicit.add(name);
  }

  // Pattern 3: copyProps*(Foo, primordials …) — bulk copies everything off Foo
  for (const [, obj] of src.matchAll(/copyProps\w*\s*\(\s*([A-Za-z0-9_$]+)\s*,\s*primordials/g)) {
    bulkSources.add(obj);
  }

  return { explicit, bulkSources };
}

/**
 * Emit a CJS module (loader: 'js') that:
 *   1. Populates every explicit primordial with a browser-safe binding
 *   2. Bulk-copies remaining own props from each bulk source (Array, Object, …)
 *   3. Freezes the result and mounts it on globalThis for the banner injection
 */
function emitShim({ explicit, bulkSources }) {
  // The explicit set from the parser will contain most names already.
  // We emit a runtime loop for bulk sources so new additions in future Node
  // versions are picked up without touching this file.
  const lines = [
    `'use strict';`,
    `const p = Object.create(null);`,
    ``,
    `// ── explicit bindings derived from per_context/primordials.js ──`,
  ];

  for (const name of [...explicit].sort()) {
    const binding = resolveBinding(name);
    if (binding) lines.push(`p.${name} = ${binding};`);
  }

  lines.push(``, `// ── bulk copies from constructor objects ──`);
  for (const src of [...bulkSources].sort()) {
    // Only copy if the global actually exists in the browser runtime
    lines.push(
      `if (typeof ${src} !== 'undefined') {`,
      `  for (const k of Object.getOwnPropertyNames(${src})) {`,
      `    if (!(k in p)) {`,
      `      const d = Object.getOwnPropertyDescriptor(${src}, k);`,
      `      if (d && typeof d.value !== 'undefined') p[k] = d.value;`,
      `    }`,
      `  }`,
      `}`,
    );
  }

  lines.push(
    ``,
    `Object.freeze(p);`,
    `globalThis.__primordials__ = p;`,
    `module.exports = p;`,
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Binding resolver — maps a primordials name to its browser-side expression
// ---------------------------------------------------------------------------

/**
 * Given a name like `ArrayPrototypePush`, derive the correct JS expression.
 *
 * Naming conventions used by Node:
 *   {Ctor}                       → the constructor itself
 *   {Ctor}Prototype{Method}      → (a, ...r) => Ctor.prototype.method.call(a, ...r)
 *   {Ctor}Prototype{Symbol}      → Ctor.prototype[Symbol.xxx]
 *   {Ctor}{StaticMethod}         → Ctor.staticMethod.bind(Ctor)
 */
function resolveBinding(name) {
  // ── Hardcoded specials that don't fit the naming pattern ──────────────────
  const OVERRIDES = {
    globalThis:                       'globalThis',
    Infinity:                         'Infinity',
    NaN:                              'NaN',
    undefined:                        'undefined',
    queueMicrotask:                   'globalThis.queueMicrotask?.bind(globalThis)',
    setQueueMicrotask:                'globalThis.queueMicrotask?.bind(globalThis)',
    // Symbol well-knowns
    SymbolAsyncIterator:              'Symbol.asyncIterator',
    SymbolHasInstance:                'Symbol.hasInstance',
    SymbolIsConcatSpreadable:         'Symbol.isConcatSpreadable',
    SymbolIterator:                   'Symbol.iterator',
    SymbolMatch:                      'Symbol.match',
    SymbolMatchAll:                   'Symbol.matchAll',
    SymbolReplace:                    'Symbol.replace',
    SymbolSearch:                     'Symbol.search',
    SymbolSpecies:                    'Symbol.species',
    SymbolSplit:                      'Symbol.split',
    SymbolToPrimitive:                'Symbol.toPrimitive',
    SymbolToStringTag:                'Symbol.toStringTag',
    SymbolUnscopables:                'Symbol.unscopables',
    // Error.captureStackTrace is V8-only
    ErrorCaptureStackTrace:           'Error.captureStackTrace ?? (() => {})',
    // These are not in browsers yet
    FinalizationRegistryPrototypeRegister:
      '(typeof FinalizationRegistry!=="undefined") ? (fr,...r)=>FinalizationRegistry.prototype.register.call(fr,...r) : undefined',
  };

  if (name in OVERRIDES) return OVERRIDES[name];

  // ── Pattern: {Ctor}Prototype{Symbol}{Xxx} ────────────────────────────────
  // e.g. ArrayPrototypeSymbolIterator → (a) => a[Symbol.iterator]()
  const protoSymMatch = name.match(/^([A-Z][a-zA-Z0-9]*)PrototypeSymbol([A-Z][a-zA-Z0-9]*)$/);
  if (protoSymMatch) {
    const ctor = protoSymMatch[1];
    const sym  = lcFirst(protoSymMatch[2]);
    if (globalExists(ctor))
      return `(a, ...r) => ${ctor}.prototype[Symbol.${sym}].call(a, ...r)`;
  }

  // ── Pattern: {Ctor}Prototype{Method} ────────────────────────────────────
  const protoMatch = name.match(/^([A-Z][a-zA-Z0-9]*)Prototype([A-Z][a-zA-Z0-9]*)$/);
  if (protoMatch) {
    const ctor    = protoMatch[1];
    const method  = lcFirst(protoMatch[2]);
    if (globalExists(ctor) && method in Object(eval(`${ctor}.prototype`)))  // eslint-disable-line no-eval
      return `(a, ...r) => ${ctor}.prototype.${method}.call(a, ...r)`;
    // Fall through — might be a static that happens to contain "Prototype" in name
  }

  // ── Pattern: {Ctor}{StaticMethod} ───────────────────────────────────────
  // Heuristic: split at first uppercase run that looks like a static method
  const staticMatch = name.match(/^([A-Z][a-zA-Z0-9]*)([A-Z][a-zA-Z0-9]+)$/);
  if (staticMatch) {
    const ctor   = staticMatch[1];
    const method = lcFirst(staticMatch[2]);
    // Prefer the constructor itself if the whole name IS the ctor
    if (KNOWN_CTORS.has(ctor) && method in Object(eval(ctor))) // eslint-disable-line no-eval
      return `${ctor}.${method}.bind(${ctor})`;
  }

  // ── Bare constructor ─────────────────────────────────────────────────────
  if (KNOWN_CTORS.has(name)) return name;

  return null; // unknown — omit rather than emit a broken binding
}

// Known top-level constructors / namespaces present in browsers + Node
const KNOWN_CTORS = new Set([
  'Array','ArrayBuffer','BigInt','BigInt64Array','BigUint64Array','Boolean',
  'DataView','Date','Error','EvalError','FinalizationRegistry',
  'Float32Array','Float64Array','Function','Int8Array','Int16Array','Int32Array',
  'JSON','Map','Math','Number','Object','Promise','Proxy','RangeError',
  'ReferenceError','Reflect','RegExp','Set','SharedArrayBuffer','String',
  'Symbol','SyntaxError','TypeError','URIError','Uint8Array','Uint8ClampedArray',
  'Uint16Array','Uint32Array','WeakMap','WeakRef','WeakSet',
]);

function globalExists(name) { return KNOWN_CTORS.has(name); }
function lcFirst(s) { return s[0].toLowerCase() + s.slice(1); }

// ---------------------------------------------------------------------------
// Shared fetch helper (same signature as the one in nodeGitHubPlugin)
// ---------------------------------------------------------------------------

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url);
    if (res.ok) return res.text();
    if (res.status === 404) throw new Error(`404: ${url}`);
    if (i < retries - 1) await new Promise(r => setTimeout(r, 300 * 2 ** i));
  }
  throw new Error(`Failed to fetch ${url} after ${retries} attempts`);
}
