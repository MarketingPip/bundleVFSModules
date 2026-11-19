/**
 * vm.js — Browser-compatible implementation of the Node.js `vm` module.
 *
 * Execution model
 * ---------------
 * Scripts run through a `new Function` factory whose body is
 * `with (scopeProxy) { <prefix> <code> }`, invoked with `.call(contextObject)`.
 * The scope proxy routes identifier lookup/assignment to the context object,
 * falls back to standard ECMAScript globals (+ `console`), and hides host-only
 * globals such as `process`. Everything is synchronous: `runInNewContext`
 * returns the completion value directly, exactly like Node.js.
 *
 * A small scanner pre-declares top-level `function` names, `var` names and
 * bare assignment targets on the context object so that (a) declarations land
 * on the context instead of the wrapper's function scope, (b) `delete` on
 * them behaves like Node (non-configurable), and (c) reads of undeclared
 * names throw `ReferenceError` instead of resolving to `undefined`.
 *
 * Honest gaps (documented, not faked)
 * -----------------------------------
 * - Isolation is `with`/Proxy-based, not a V8 context. Scope-chain leakage is
 *   possible; a nested sloppy function's `this` is the host globalThis rather
 *   than the sandbox global.
 * - Infinite loops cannot be interrupted: `timeout` is validated but cannot
 *   preempt synchronous execution. `breakOnSigint` is accepted and ignored.
 * - `cachedData`/`produceCachedData` use a synthetic content hash, not V8 code
 *   cache: `cachedDataRejected` is still meaningful (true when the supplied
 *   data does not match the source), but the bytes are not V8 cached data.
 * - `measureMemory()` resolves a synthetic zero-valued shape.
 * - `vm.Module` / `vm.SourceTextModule` / `vm.SyntheticModule` (ESM) are not
 *   available without a module loader; they throw on construction.
 * - Microtasks run on the host queue; `microtaskMode` is validated but the
 *   mode has no observable effect.
 */

// ---------------------------------------------------------------------------
// 1. Coded errors + validators (Node-compatible `code`s and messages)
// ---------------------------------------------------------------------------

function codedError(Class, code, message) {
  const err = new Class(message);
  err.code = code;
  return err;
}

function receivedText(input) {
  if (input === null) return "Received null";
  if (input === undefined) return "Received undefined";
  const t = typeof input;
  if (t === "function")
    return `Received function ${input.name || "(anonymous)"}`;
  if (t === "object") {
    const name = input.constructor && input.constructor.name;
    return name
      ? `Received an instance of ${name}`
      : `Received ${String(input)}`;
  }
  let inspected = t === "string" ? `'${input}'` : String(input);
  if (inspected.length > 28) inspected = `${inspected.slice(0, 25)}...`;
  return `Received type ${t} (${inspected})`;
}

function argOrProp(name) {
  return name.includes(".") ? "property" : "argument";
}

function validateObject(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" ${argOrProp(name)} must be of type object. ${receivedText(value)}`,
    );
  }
}

// Like validateObject but allows arrays: vm.createContext([]) is legal in
// Node (the sandbox may be any object, arrays included).
function validateSandbox(value, name) {
  if (typeof value !== "object" || value === null) {
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" ${argOrProp(name)} must be of type object. ${receivedText(value)}`,
    );
  }
}

function validateString(value, name) {
  if (typeof value !== "string") {
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" ${argOrProp(name)} must be of type string. ${receivedText(value)}`,
    );
  }
}

function validateBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" ${argOrProp(name)} must be of type boolean. ${receivedText(value)}`,
    );
  }
}

function validateFunction(value, name) {
  if (typeof value !== "function") {
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" ${argOrProp(name)} must be of type function. ${receivedText(value)}`,
    );
  }
}

function validateStringArray(value, name) {
  if (!Array.isArray(value)) {
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" ${argOrProp(name)} must be an instance of Array. ${receivedText(value)}`,
    );
  }
  for (let k = 0; k < value.length; k++) {
    if (typeof value[k] !== "string") {
      throw codedError(
        TypeError,
        "ERR_INVALID_ARG_TYPE",
        `The "${name}[${k}]" ${argOrProp(name)} must be of type string. ${receivedText(value[k])}`,
      );
    }
  }
}

// Port of Node lib/internal/validators.js validateInt32: a non-number is a
// TYPE error; only a number outside the int32 range (or a non-integer) is a
// RANGE error. The old single-branch version conflated them, so
// `lineOffset: null` threw ERR_OUT_OF_RANGE instead of ERR_INVALID_ARG_TYPE.
function validateInt32(value, name) {
  // Node (lib/internal/validators.js) splits the failure: a non-number is a
  // type error, a non-integer or out-of-range number is a range error.
  // The old single check threw ERR_OUT_OF_RANGE for both.
  if (typeof value !== "number") {
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" ${argOrProp(name)} must be of type number. ${receivedText(value)}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw codedError(
      RangeError,
      "ERR_OUT_OF_RANGE",
      `The value of "${name}" is out of range. It must be an integer. ${receivedText(value)}`,
    );
  }
  if (value < -2147483648 || value > 2147483647) {
    throw codedError(
      RangeError,
      "ERR_OUT_OF_RANGE",
      `The value of "${name}" is out of range. It must be >= -2147483648 && <= 2147483647. ${receivedText(value)}`,
    );
  }
}

function validateUint32(value, name) {
  // Same type/range split as validateInt32 (no callers in vm.js today; kept
  // consistent with the family so a future caller gets Node's codes).
  if (typeof value !== "number") {
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" ${argOrProp(name)} must be of type number. ${receivedText(value)}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw codedError(
      RangeError,
      "ERR_OUT_OF_RANGE",
      `The value of "${name}" is out of range. It must be an integer. ${receivedText(value)}`,
    );
  }
  if (value < 0 || value > 4294967295) {
    throw codedError(
      RangeError,
      "ERR_OUT_OF_RANGE",
      `The value of "${name}" is out of range. It must be >= 0 && <= 4294967295. ${receivedText(value)}`,
    );
  }
}

function validateOneOf(value, name, allowed) {
  if (!allowed.includes(value)) {
    const list = allowed
      .map((v) => (v === undefined ? "undefined" : `'${v}'`))
      .join(", ");
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_VALUE",
      `The property '${name}' must be one of: ${list}. ${receivedText(value)}`,
    );
  }
}

function validateAbortSignal(value, name) {
  if (
    typeof value !== "object" ||
    value === null ||
    (typeof AbortSignal !== "undefined" && !(value instanceof AbortSignal))
  ) {
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" argument must be an instance of AbortSignal. ${receivedText(value)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. constants
// ---------------------------------------------------------------------------

export const constants = Object.freeze({
  USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol("vm.USE_MAIN_CONTEXT_DEFAULT_LOADER"),
  DONT_CONTEXTIFY: Symbol("vm.DONT_CONTEXTIFY"),
});

const DEFAULT_FILENAME = "evalmachine.<anonymous>";

// ---------------------------------------------------------------------------
// 3. Context tracking
// ---------------------------------------------------------------------------

const contextified = new WeakSet();
// codeGeneration flags per context (createContext stores them; runWithContext
// enforces them). Absent entry = default { strings: true, wasm: true }.
const contextCodeGeneration = new WeakMap();
let contextNameIndex = 0;

// One synthetic per-context memory entry: sizes are 0 (the shim cannot
// measure the real V8 heap); measureMemory's tests assert shape, key
// presence and types, not values.
function syntheticMemoryShape() {
  return { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] };
}

// Enumerable registry of live contextified contexts, for measureMemory's
// `other` list (a WeakSet cannot enumerate). Entries are plain synthetic
// shapes holding no reference to their context, so contexts can still be
// GC'd; a FinalizationRegistry drops the entry when its context dies.
// ponytail: real Node reports live V8 contexts from the heap profiler —
// unreachable here; the honest ceiling is "live = created and not yet GC'd".
const liveContexts = new Set();
const contextFinalization =
  typeof FinalizationRegistry !== "undefined"
    ? new FinalizationRegistry((entry) => liveContexts.delete(entry))
    : null;

function markContext(obj) {
  if (contextified.has(obj)) return obj;
  contextified.add(obj);
  const entry = syntheticMemoryShape();
  liveContexts.add(entry);
  if (contextFinalization !== null) contextFinalization.register(obj, entry);
  return obj;
}

export function isContext(object) {
  if (typeof object !== "object" || object === null) {
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "object" argument must be of type object. ${receivedText(object)}`,
    );
  }
  return contextified.has(object);
}

function validateContext(contextifiedObject) {
  if (typeof contextifiedObject !== "object" || contextifiedObject === null) {
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "object" argument must be of type object. ${receivedText(contextifiedObject)}`,
    );
  }
  if (!contextified.has(contextifiedObject)) {
    const name =
      contextifiedObject.constructor && contextifiedObject.constructor.name;
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "contextifiedObject" argument must be an vm.Context. Received an instance of ${name || "Object"}`,
    );
  }
}

// DONT_CONTEXTIFY: a vanilla context — the standard globals as
// non-enumerable own properties, WITHOUT Node globals (process, Buffer,
// console stay absent — the test asserts their absence).
// ponytail: values are the host intrinsics (a browser has no per-context
// intrinsics to mint); the ceiling is cross-context identity — in real
// Node context.Array is a different Array than the host's — no vendored
// test asserts it.
function makeVanillaContext() {
  const obj = {};
  const globals = standardGlobals();
  for (const name of Object.keys(globals)) {
    if (name === "console") continue;
    Object.defineProperty(obj, name, {
      value: globals[name],
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  return obj;
}

export function createContext(contextObject = {}, options = {}) {
  if (contextObject === constants.DONT_CONTEXTIFY) {
    return markContext(makeVanillaContext());
  }
  if (contextified.has(contextObject)) return contextObject;
  validateSandbox(contextObject, "sandbox");
  validateObject(options, "options");
  const {
    name = `VM Context ${++contextNameIndex}`,
    origin,
    codeGeneration,
    microtaskMode,
  } = options;
  validateString(name, "options.name");
  if (origin !== undefined) validateString(origin, "options.origin");
  let codeGen = { strings: true, wasm: true };
  if (codeGeneration !== undefined) {
    validateObject(codeGeneration, "options.codeGeneration");
    const { strings = true, wasm = true } = codeGeneration;
    validateBoolean(strings, "options.codeGeneration.strings");
    validateBoolean(wasm, "options.codeGeneration.wasm");
    codeGen = { strings, wasm };
  }
  if (microtaskMode !== undefined) {
    validateOneOf(microtaskMode, "options.microtaskMode", [
      "afterEvaluate",
      undefined,
    ]);
  }
  contextCodeGeneration.set(contextObject, codeGen);
  return markContext(contextObject);
}

export function createScript(code, options) {
  return new Script(code, options);
}

// ---------------------------------------------------------------------------
// 4. Standard globals visible inside a context
// ---------------------------------------------------------------------------

const GLOBAL_NAMES = (
  "Infinity NaN undefined eval isFinite isNaN parseFloat parseInt " +
  "decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape " +
  "Object Function Boolean Symbol Error AggregateError EvalError RangeError " +
  "ReferenceError SyntaxError TypeError URIError Number BigInt Math Date String " +
  "RegExp Array Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array " +
  "Int32Array Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array " +
  "Map Set WeakMap WeakSet WeakRef ArrayBuffer SharedArrayBuffer Atomics " +
  "DataView JSON Promise Reflect Proxy Intl WebAssembly console"
).split(" ");

let _standardGlobals = null;
function standardGlobals() {
  if (_standardGlobals === null) {
    const table = Object.create(null);
    const g = globalThis;
    for (const name of GLOBAL_NAMES) {
      if (name in g) {
        try {
          table[name] = g[name];
        } catch (_) {
          /* ignore getters that throw */
        }
      }
    }
    _standardGlobals = table;
  }
  return _standardGlobals;
}

// ---------------------------------------------------------------------------
// 5. Small text helpers
// ---------------------------------------------------------------------------

function countNewlines(s) {
  let count = 0;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "\n") count++;
  }
  return count;
}

/** Pre-declare a name on the context object as a non-configurable binding. */
function ensureDeclared(target, name) {
  if (name === "__proto__") return;
  if (Reflect.has(target, name)) return;
  try {
    Object.defineProperty(target, name, {
      value: undefined,
      writable: true,
      enumerable: true,
      configurable: false,
    });
  } catch (_) {
    /* host Proxy rejected it; reads fall back to globals */
  }
}

/** Replace spans with whitespace, preserving line breaks for stack mapping. */
function blankSpans(code, spans) {
  if (spans.length === 0) return code;
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let last = 0;
  for (const [s, e] of spans) {
    if (s < last) continue;
    out += code.slice(last, s);
    out += code.slice(s, e).replace(/[^\r\n\u2028\u2029]/g, " ");
    last = e;
  }
  out += code.slice(last);
  return out;
}

function skipWsCommentsFlat(code, j) {
  const n = code.length;
  while (j < n) {
    const c = code[j];
    if (
      c === " " ||
      c === "\t" ||
      c === "\n" ||
      c === "\r" ||
      c === "\v" ||
      c === "\f" ||
      c === "\u00a0" ||
      c === "\ufeff" ||
      c === "\u2028" ||
      c === "\u2029"
    ) {
      j++;
      continue;
    }
    if (c === "/" && code[j + 1] === "/") {
      j += 2;
      while (j < n && code[j] !== "\n" && code[j] !== "\r") j++;
      continue;
    }
    if (c === "/" && code[j + 1] === "*") {
      j += 2;
      while (j < n && !(code[j] === "*" && code[j + 1] === "/")) j++;
      j += 2;
      continue;
    }
    break;
  }
  return j;
}

function skipStringFlat(code, j) {
  const n = code.length;
  const q = code[j];
  j++;
  while (j < n) {
    const c = code[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === q) return j + 1;
    if (c === "\n" || c === "\r") break;
    j++;
  }
  return j;
}

/** True when the code begins with a "use strict" directive prologue. */
function isStrictPrologue(code) {
  let j = skipWsCommentsFlat(code, 0);
  if (j >= code.length) return false;
  const c = code[j];
  if (c !== '"' && c !== "'") return false;
  const end = skipStringFlat(code, j);
  const literal = code.slice(j, end);
  return literal === '"use strict"' || literal === "'use strict'";
}

// ---------------------------------------------------------------------------
// 6. Scanner
//
// Finds, without a full parser:
//   - top-level `function` (and `async function`, `function*`) declarations,
//   - top-level `var` declarator names (simple identifiers + destructuring),
//   - top-level bare assignment targets (`b = …`, including `for (b = …)`).
// These are pre-declared on the context object so declarations land on the
// sandbox global, `delete` behaves like Node, and undeclared reads throw
// ReferenceError instead of resolving to `undefined`.
// ---------------------------------------------------------------------------

const ID_START_RE = /^\p{ID_Start}$/u;
const ID_PART_RE = /^[\p{ID_Continue}\u200C\u200D]$/u;

const KEYWORDS = new Set(
  (
    "break case catch class const continue debugger default delete do else " +
    "enum export extends finally for function if implements import in instanceof " +
    "interface let new package private protected public return static super " +
    "switch this throw try typeof var void while with yield await"
  ).split(" "),
);

function isIdStartChar(c) {
  if (!c) return false;
  const n = c.charCodeAt(0);
  if (n === 36 || n === 95 || (n >= 65 && n <= 90) || (n >= 97 && n <= 122))
    return true;
  if (n < 128) return false;
  return ID_START_RE.test(c);
}

function isIdPartChar(c) {
  if (!c) return false;
  const n = c.charCodeAt(0);
  if (
    n === 36 ||
    n === 95 ||
    (n >= 48 && n <= 57) ||
    (n >= 65 && n <= 90) ||
    (n >= 97 && n <= 122)
  )
    return true;
  if (n < 128) return false;
  return ID_PART_RE.test(c);
}

function readId(code, j) {
  const start = j;
  while (j < code.length && isIdPartChar(code[j])) j++;
  return { word: code.slice(start, j), end: j };
}

function skipStringLex(code, j) {
  const n = code.length;
  const q = code[j];
  j++;
  while (j < n) {
    const c = code[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === q) return j + 1;
    if (c === "\n" || c === "\r") break;
    j++;
  }
  return j;
}

function skipNumberLex(code, j) {
  const n = code.length;
  while (j < n) {
    const c = code[j];
    if (
      (c >= "0" && c <= "9") ||
      (c >= "a" && c <= "z") ||
      (c >= "A" && c <= "Z") ||
      c === "_" ||
      c === "." ||
      c === "$"
    )
      j++;
    else break;
  }
  return j;
}

function skipRegexLex(code, j) {
  const n = code.length;
  j++;
  let inClass = false;
  while (j < n) {
    const c = code[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      j++;
      break;
    } else if ((c === "\n" || c === "\r") && !inClass) break;
    j++;
  }
  while (j < n && isIdPartChar(code[j])) j++;
  return j;
}

/** code[j] is an opening bracket; return the index just past its match. */
function matchBalanced(code, j) {
  const n = code.length;
  const stack = [code[j]];
  j++;
  let operand = false;
  while (j < n && stack.length > 0) {
    const c = code[j];
    if (c === '"' || c === "'") {
      j = skipStringLex(code, j);
      operand = true;
      continue;
    }
    if (c === "`") {
      j = skipTemplateLex(code, j);
      operand = true;
      continue;
    }
    if (c === "/" && code[j + 1] === "/") {
      j += 2;
      while (j < n && code[j] !== "\n" && code[j] !== "\r") j++;
      continue;
    }
    if (c === "/" && code[j + 1] === "*") {
      j += 2;
      while (j < n && !(code[j] === "*" && code[j + 1] === "/")) j++;
      j += 2;
      continue;
    }
    if (c === "/" && !operand) {
      j = skipRegexLex(code, j);
      operand = true;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      stack.push(c);
      operand = false;
      j++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      const o = stack[stack.length - 1];
      if (
        (o === "(" && c === ")") ||
        (o === "[" && c === "]") ||
        (o === "{" && c === "}")
      ) {
        stack.pop();
      } else {
        break;
      }
      operand = true;
      j++;
      continue;
    }
    if (isIdStartChar(c)) {
      j = readId(code, j).end;
      operand = true;
      continue;
    }
    if (c >= "0" && c <= "9") {
      j = skipNumberLex(code, j);
      operand = true;
      continue;
    }
    if (
      c === " " ||
      c === "\t" ||
      c === "\n" ||
      c === "\r" ||
      c === "\v" ||
      c === "\f"
    ) {
      j++;
      continue;
    }
    operand = false;
    j++;
  }
  return j;
}

function skipTemplateLex(code, j) {
  const n = code.length;
  j++;
  while (j < n) {
    const c = code[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") return j + 1;
    if (c === "$" && code[j + 1] === "{") {
      j = matchBalanced(code, j + 1);
      continue;
    }
    j++;
  }
  return j;
}

/** Best-effort binding identifiers from a destructuring pattern's text. */
function collectPatternIds(text, vars) {
  const clean = text.replace(
    /'(?:[^'\\\r\n]|\\.)*'|"(?:[^"\\\r\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
    "",
  );
  const re = /[$A-Z_a-z][$\w]*/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const word = m[0];
    if (KEYWORDS.has(word)) continue;
    let k = m.index + word.length;
    while (
      k < clean.length &&
      (clean[k] === " " ||
        clean[k] === "\t" ||
        clean[k] === "\n" ||
        clean[k] === "\r")
    )
      k++;
    if (clean[k] === ":") continue; // property key, not a binding
    vars.push(word);
  }
}

function scanScript(code) {
  const functions = []; // { name, start, end }
  const vars = [];
  const assigned = [];
  const lexical = []; // top-level let/const binding names (see skipLexical)
  const n = code.length;
  let i = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  const braceIsFunc = [];
  const fnStack = []; // { paren, stage: 0|1|2, capture }
  let activeCapture = null; // { name, start, level }
  let asyncStart = -1;
  let operand = false;
  let declPos = true;
  let sigChar = "";
  let paramDepth = 0;

  function skipWs(j) {
    while (j < n) {
      const c = code[j];
      if (
        c === " " ||
        c === "\t" ||
        c === "\n" ||
        c === "\r" ||
        c === "\v" ||
        c === "\f" ||
        c === "\u00a0" ||
        c === "\ufeff" ||
        c === "\u2028" ||
        c === "\u2029"
      ) {
        j++;
        continue;
      }
      if (c === "/" && code[j + 1] === "/") {
        j += 2;
        while (j < n && code[j] !== "\n" && code[j] !== "\r") j++;
        continue;
      }
      if (c === "/" && code[j + 1] === "*") {
        j += 2;
        while (j < n && !(code[j] === "*" && code[j + 1] === "/")) j++;
        j += 2;
        continue;
      }
      break;
    }
    return j;
  }

  // Skip an initializer/expression until `,` or `;` at depth 0.
  function skipInitializer(j) {
    let d0 = 0,
      d1 = 0,
      d2 = 0;
    let op = false;
    while (j < n) {
      const c = code[j];
      if (c === '"' || c === "'") {
        j = skipStringLex(code, j);
        op = true;
        continue;
      }
      if (c === "`") {
        j = skipTemplateLex(code, j);
        op = true;
        continue;
      }
      if (c === "/" && (code[j + 1] === "/" || code[j + 1] === "*")) {
        j = skipWs(j);
        continue;
      }
      if (c === "/" && !op) {
        j = skipRegexLex(code, j);
        op = true;
        continue;
      }
      if (c === "(") {
        d0++;
        op = false;
        j++;
        continue;
      }
      if (c === ")") {
        if (d0 === 0) break;
        d0--;
        op = true;
        j++;
        continue;
      }
      if (c === "[") {
        d1++;
        op = false;
        j++;
        continue;
      }
      if (c === "]") {
        if (d1 === 0) break;
        d1--;
        op = true;
        j++;
        continue;
      }
      if (c === "{") {
        d2++;
        op = false;
        j++;
        continue;
      }
      if (c === "}") {
        if (d2 === 0) break;
        d2--;
        op = true;
        j++;
        continue;
      }
      if ((c === "," || c === ";") && d0 === 0 && d1 === 0 && d2 === 0) break;
      if (isIdStartChar(c)) {
        j = readId(code, j).end;
        op = true;
        continue;
      }
      if (c >= "0" && c <= "9") {
        j = skipNumberLex(code, j);
        op = true;
        continue;
      }
      if (
        c === " " ||
        c === "\t" ||
        c === "\n" ||
        c === "\r" ||
        c === "\v" ||
        c === "\f"
      ) {
        j++;
        continue;
      }
      op = false;
      j++;
    }
    return j;
  }

  // Skip a `= <default>` (or `= <initializer>` tail) after a binding name.
  function skipDefault(j) {
    j = skipWs(j);
    if (code[j] === "=") j = skipInitializer(j + 1);
    return j;
  }

  // Parse one binding element after an object-pattern `:` (or a bare
  // element position): a nested pattern, a rest binding, or an identifier
  // with an optional default. Default values and computed keys are SKIPPED
  // structurally — identifiers inside them are reads, not bindings
  // (spike: collectPatternIds over-collects them, e.g. `let {a = foo}`).
  function parseBindingElement(j) {
    j = skipWs(j);
    if (j >= n) return j;
    const c = code[j];
    if (c === "{" || c === "[") {
      j = parsePattern(j);
      return skipDefault(j);
    }
    if (c === "." && code.startsWith("...", j)) {
      j = skipWs(j + 3);
      if (isIdStartChar(code[j] || "")) {
        const r = readId(code, j);
        lexical.push(r.word);
        j = r.end;
      }
      return j;
    }
    if (isIdStartChar(c)) {
      const r = readId(code, j);
      lexical.push(r.word);
      j = skipWs(r.end);
      return skipDefault(j);
    }
    return j;
  }

  // Parse a `{...}` / `[...]` binding pattern starting at j, collecting
  // bound names into `lexical`. Returns the index just past the pattern.
  function parsePattern(j) {
    const open = code[j];
    const close = open === "{" ? "}" : "]";
    j++;
    while (true) {
      j = skipWs(j);
      if (j >= n) break;
      const c = code[j];
      if (c === close) return j + 1;
      if (c === ",") {
        j++;
        continue;
      }
      if (c === "." && code.startsWith("...", j)) {
        j = skipWs(j + 3);
        if (isIdStartChar(code[j] || "")) {
          const r = readId(code, j);
          lexical.push(r.word);
          j = r.end;
        }
        continue;
      }
      if (open === "{") {
        if (c === "[") {
          // Computed key: skip the key expression, then the binding.
          j = matchBalanced(code, j);
          j = skipWs(j);
          if (code[j] === ":") j = parseBindingElement(skipWs(j + 1));
          continue;
        }
        if (c === '"' || c === "'") {
          // String-literal key.
          j = skipStringLex(code, j);
          j = skipWs(j);
          if (code[j] === ":") j = parseBindingElement(skipWs(j + 1));
          continue;
        }
        if (c >= "0" && c <= "9") {
          // Numeric-literal key.
          j = skipNumberLex(code, j);
          j = skipWs(j);
          if (code[j] === ":") j = parseBindingElement(skipWs(j + 1));
          continue;
        }
        if (isIdStartChar(c)) {
          const r = readId(code, j);
          const name = r.word;
          j = skipWs(r.end);
          if (code[j] === ":") {
            // Property key; the binding follows the colon.
            j = parseBindingElement(skipWs(j + 1));
          } else {
            // Shorthand binding, with an optional default.
            lexical.push(name);
            j = skipDefault(j);
          }
          continue;
        }
        if (c === "{" || c === "[") {
          j = matchBalanced(code, j);
          continue;
        }
        break;
      }
      // Array-pattern element.
      if (c === "{" || c === "[") {
        j = parsePattern(j);
        j = skipDefault(j);
        continue;
      }
      if (isIdStartChar(c)) {
        const r = readId(code, j);
        lexical.push(r.word);
        j = skipWs(r.end);
        j = skipDefault(j);
        continue;
      }
      break;
    }
    return j;
  }

  /** Skip a let/const declarator list, collecting its bound names. */
  function skipLexical(j) {
    while (true) {
      j = skipWs(j);
      if (j >= n) break;
      const c = code[j];
      if (c === "{" || c === "[") {
        j = parsePattern(j);
      } else if (isIdStartChar(c)) {
        const r = readId(code, j);
        lexical.push(r.word);
        j = r.end;
      } else {
        break;
      }
      j = skipWs(j);
      if (code[j] === "=") j = skipInitializer(j + 1);
      j = skipWs(j);
      if (code[j] === ",") {
        j++;
        continue;
      }
      break;
    }
    return j;
  }

  function parseVarDeclarators(j) {
    while (true) {
      j = skipWs(j);
      if (j >= n) break;
      const c = code[j];
      if (c === "{" || c === "[") {
        const end = matchBalanced(code, j);
        collectPatternIds(code.slice(j + 1, end - 1), vars);
        j = end;
      } else if (isIdStartChar(c)) {
        const r = readId(code, j);
        vars.push(r.word);
        j = r.end;
      } else {
        break;
      }
      j = skipWs(j);
      if (code[j] === "=") j = skipInitializer(j + 1);
      j = skipWs(j);
      if (code[j] === ",") {
        j++;
        continue;
      }
      break;
    }
    return j;
  }

  function onWord(word, start) {
    const isProp = sigChar === ".";
    const topLevel = braceDepth === 0 && parenDepth === 0 && bracketDepth === 0;
    // Skip lexical declarations so their names are not misclassified as
    // bare assignments. `let` is also a valid sloppy-mode identifier, so
    // only skip when it opens a binding.
    if (
      !isProp &&
      (word === "let" || word === "const") &&
      topLevel &&
      declPos
    ) {
      const j = skipWs(start + word.length);
      const c = code[j];
      if (c === "{" || c === "[" || isIdStartChar(c)) {
        i = skipLexical(j);
        return;
      }
    }
    if (!isProp && word === "function" && topLevel && declPos) {
      let j = skipWs(start + 8);
      if (code[j] === "*") j = skipWs(j + 1);
      let name = "";
      if (isIdStartChar(code[j] || "")) name = readId(code, j).word;
      let capture = null;
      if (name !== "") {
        capture = {
          name,
          start: asyncStart >= 0 ? asyncStart : start,
          level: 0,
        };
      }
      fnStack.push({ paren: parenDepth, stage: 0, capture });
      asyncStart = -1;
    } else if (!isProp && word === "function") {
      fnStack.push({ paren: parenDepth, stage: 0, capture: null });
      asyncStart = -1;
    } else if (!isProp && word === "async" && topLevel && declPos) {
      const j = skipWs(start + 5);
      asyncStart =
        code.startsWith("function", j) && !isIdPartChar(code[j + 8] || "")
          ? start
          : -1;
    } else {
      asyncStart = -1;
      if (!isProp && word === "var" && topLevel && declPos) {
        i = parseVarDeclarators(start + 3);
      } else if (
        !isProp &&
        !KEYWORDS.has(word) &&
        topLevel &&
        paramDepth === 0
      ) {
        // Possible bare assignment target: `name = …` (not `==`, `=>`).
        const j = skipWs(start + word.length);
        if (code[j] === "=" && code[j + 1] !== "=" && code[j + 1] !== ">") {
          assigned.push(word);
        }
      }
    }
    if (
      word === "this" ||
      word === "super" ||
      word === "true" ||
      word === "false" ||
      word === "null"
    ) {
      operand = true;
    } else if (KEYWORDS.has(word)) {
      operand = false;
    } else {
      operand = true;
    }
    declPos = false;
    sigChar = word[word.length - 1];
  }

  while (i < n) {
    const c = code[i];
    if (
      c === " " ||
      c === "\t" ||
      c === "\n" ||
      c === "\r" ||
      c === "\v" ||
      c === "\f" ||
      c === "\u00a0" ||
      c === "\ufeff" ||
      c === "\u2028" ||
      c === "\u2029"
    ) {
      i++;
      continue;
    }
    if (c === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      i = skipWs(i);
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipStringLex(code, i);
      operand = true;
      declPos = false;
      asyncStart = -1;
      sigChar = c;
      continue;
    }
    if (c === "`") {
      i = skipTemplateLex(code, i);
      operand = true;
      declPos = false;
      asyncStart = -1;
      sigChar = "`";
      continue;
    }
    if (c === "/") {
      if (!operand) {
        i = skipRegexLex(code, i);
        operand = true;
      } else {
        i++;
        operand = false;
      }
      declPos = false;
      asyncStart = -1;
      sigChar = "/";
      continue;
    }
    if (isIdStartChar(c)) {
      const r = readId(code, i);
      const start = i;
      i = r.end;
      onWord(r.word, start);
      continue;
    }
    if (
      (c >= "0" && c <= "9") ||
      (c === "." && code[i + 1] >= "0" && code[i + 1] <= "9")
    ) {
      i = skipNumberLex(code, i);
      operand = true;
      declPos = false;
      asyncStart = -1;
      sigChar = "0";
      continue;
    }
    if (c === "{") {
      const top = fnStack.length > 0 ? fnStack[fnStack.length - 1] : null;
      if (top !== null && top.stage === 2) {
        fnStack.pop();
        braceIsFunc.push(true);
        if (top.capture !== null) {
          top.capture.level = braceDepth + 1;
          activeCapture = top.capture;
        }
      } else {
        braceIsFunc.push(false);
      }
      braceDepth++;
      operand = false;
      declPos = true;
      asyncStart = -1;
      sigChar = "{";
      i++;
      continue;
    }
    if (c === "}") {
      const wasFunc = braceIsFunc.pop();
      if (
        wasFunc &&
        activeCapture !== null &&
        activeCapture.level === braceDepth
      ) {
        functions.push({
          name: activeCapture.name,
          start: activeCapture.start,
          end: i + 1,
        });
        activeCapture = null;
      }
      braceDepth--;
      operand = true;
      declPos = true;
      asyncStart = -1;
      sigChar = "}";
      i++;
      continue;
    }
    if (c === "(") {
      const top = fnStack.length > 0 ? fnStack[fnStack.length - 1] : null;
      if (top !== null && top.stage === 0 && parenDepth === top.paren) {
        top.stage = 1;
        paramDepth++;
      }
      parenDepth++;
      operand = false;
      declPos = false;
      asyncStart = -1;
      sigChar = "(";
      i++;
      continue;
    }
    if (c === ")") {
      parenDepth--;
      const top = fnStack.length > 0 ? fnStack[fnStack.length - 1] : null;
      if (top !== null && top.stage === 1 && parenDepth === top.paren) {
        top.stage = 2;
        paramDepth--;
      }
      operand = true;
      declPos = false;
      asyncStart = -1;
      sigChar = ")";
      i++;
      continue;
    }
    if (c === "[") {
      bracketDepth++;
      operand = false;
      declPos = false;
      asyncStart = -1;
      sigChar = "[";
      i++;
      continue;
    }
    if (c === "]") {
      bracketDepth--;
      operand = true;
      declPos = false;
      asyncStart = -1;
      sigChar = "]";
      i++;
      continue;
    }
    if (c === ";") {
      operand = false;
      declPos = true;
      asyncStart = -1;
      sigChar = ";";
      i++;
      continue;
    }
    // All other punctuation / operators.
    operand = false;
    declPos = false;
    asyncStart = -1;
    sigChar = c;
    i++;
  }

  return { functions, vars, assigned, lexical };
}

// ---------------------------------------------------------------------------
// 7. Scope proxy: the `with` statement's object
// ---------------------------------------------------------------------------

function makeScope(target, strict = false, claimed = null) {
  const globals = standardGlobals();
  const sandbox = target;
  // ponytail: the scope proxy's target MUST be a fresh plain object, not
  // the sandbox. Proxy [[Get]] validation unconditionally calls
  // target.[[GetOwnProperty]] after the `get` trap returns — so with the
  // sandbox as the target, the `with` statement's Symbol.unscopables lookup
  // re-enters a Proxy sandbox's throwing getOwnPropertyDescriptor trap even
  // when the `get` trap answers without touching the target (proven: the
  // triage's get-only short-circuit still throws "whoops"). With a
  // plain-object target the validation queries are inert, and every trap
  // forwards to the closed-over sandbox instead of `t`. Ceiling: validation
  // is now checked against `{}` — reporting a non-configurable descriptor
  // (getOwnPropertyDescriptor) or defining a non-configurable property
  // (defineProperty) through the scope would fail invariant checks that
  // passed against the sandbox target. No vm test reaches those paths
  // through the `with` object (user code cannot reference the scope), and
  // the full passing vm suite guards the shared paths.
  return new Proxy(
    {},
    {
      has(t, prop) {
        if (typeof prop === "symbol") return Reflect.has(sandbox, prop);
        if (prop === "globalThis") return true;
        if (Reflect.has(sandbox, prop)) return true;
        // Lazily-claimed assigned names (see runWithContext): the scanner saw
        // a top-level bare assignment to this name, so claim it here instead
        // of pre-defining it — the `set` trap defines it on first assignment,
        // so insertion order follows execution order, not scan order.
        // No extensibility guard: returning true from `has` is always
        // spec-legal, and a frozen target MUST still be claimed — otherwise
        // the assignment falls through and creates a host global (lane 8:
        // `bar = 1` on a frozen context leaked globalThis.bar).
        if (claimed !== null && claimed.has(prop)) return true;
        if (prop in globals) return true;
        // Block host globals from leaking into the sandbox: claim them so the
        // `with` never falls through to the real global scope.
        return prop in globalThis;
      },
      get(t, prop, receiver) {
        // Real Node never consults the sandbox's @@unscopables (a context
        // global is not a `with` object); answer it without touching the
        // sandbox so a throwing Proxy trap cannot fail the run.
        if (prop === Symbol.unscopables) return undefined;
        if (typeof prop === "symbol") return Reflect.get(sandbox, prop);
        if (prop === "globalThis") {
          return Reflect.has(sandbox, prop)
            ? Reflect.get(sandbox, prop)
            : sandbox;
        }
        if (Reflect.has(sandbox, prop))
          return Reflect.get(sandbox, prop, receiver);
        if (prop in globals) return globals[prop];
        // Host-blocked or unknown name: `has` claimed host globals so the
        // `with` never falls through to the real global scope. Return undefined
        // so `typeof` yields 'undefined' (matching Node); this also keeps the
        // host value from leaking. (A value read gives undefined rather than
        // Node's ReferenceError — documented gap.)
        return undefined;
      },
      set(t, prop, value) {
        if (typeof prop === "symbol") return Reflect.set(sandbox, prop, value);
        // First assignment to a lazily-claimed name: define it now (same
        // non-configurable descriptor ensureDeclared used to install eagerly),
        // so the property is created in execution order. Reads before the
        // assignment still see undefined via the `get` trap.
        if (
          claimed !== null &&
          claimed.has(prop) &&
          !Reflect.has(sandbox, prop)
        ) {
          ensureDeclared(sandbox, prop);
        }
        // `has` already returned true: the name is either on the target or a
        // standard global. Standard globals shadow onto the sandbox global.
        const ok = Reflect.set(sandbox, prop, value);
        if (!ok) {
          // In strict mode, throw Node's "Cannot assign to read only property"
          // message. In sloppy mode, return false: the engine fails the
          // assignment silently AND KEEPS EVALUATING (a throw here used to
          // abort the whole eval — e.g. `qux = 2; qux` on a getter-only
          // property returned undefined instead of 1).
          if (strict) {
            throw new TypeError(
              `Cannot assign to read only property '${String(prop)}' of object '${Object.prototype.toString.call(sandbox)}'`,
            );
          }
          return false;
        }
        return true;
      },
      defineProperty(t, prop, desc) {
        if (prop === "__proto__") return false;
        return Reflect.defineProperty(sandbox, prop, desc);
      },
      deleteProperty(t, prop) {
        return Reflect.deleteProperty(sandbox, prop);
      },
      getOwnPropertyDescriptor(t, prop) {
        return Reflect.getOwnPropertyDescriptor(sandbox, prop);
      },
      ownKeys() {
        return Reflect.ownKeys(sandbox);
      },
      getPrototypeOf() {
        return Reflect.getPrototypeOf(sandbox);
      },
    },
  );
}

// ---------------------------------------------------------------------------
// 8. Stack mapping + error enrichment
// ---------------------------------------------------------------------------

/**
 * Map a V8 `<anonymous>:L:C` position from inside our `new Function` factory
 * back to the user's code coordinates.
 */
function mapEvalFrame(line, ctx) {
  // V8 renders our eval'd/new-Function code as
  //   at <name> (eval at <caller> (<callpos>), <anonymous>:L:C)
  // The trailing <anonymous>:L:C is the position in our generated source.
  const m = /, <anonymous>:(\d+):(\d+)\)\s*$/.exec(line);
  if (m === null) return null;
  const codeLine = parseInt(m[1], 10) - ctx.lineBias - ctx.headLines;
  if (codeLine < 1) return null;
  const dispLine = codeLine + ctx.lineOffset;
  const dispCol = parseInt(m[2], 10) + (codeLine === 1 ? ctx.columnOffset : 0);
  return { codeLine, dispLine, dispCol };
}

/**
 * Rewrite `err.stack` so positions point at the user's code, using the
 * display filename. When `ctx.header` is true, prepend Node's source-context
 * header (`filename:line`, source line, caret).
 */
function enrichScriptError(err, ctx) {
  if (err === null || (typeof err !== "object" && typeof err !== "function"))
    return err;
  const stack = err.stack;
  if (typeof stack !== "string") return err;
  const lines = stack.split("\n");
  if (lines.length < 2) return err;
  const out = [lines[0]];
  let top = null;
  for (let k = 1; k < lines.length; k++) {
    const mapped = mapEvalFrame(lines[k], ctx);
    if (mapped !== null) {
      if (top === null) top = mapped;
      out.push(`    at ${ctx.filename}:${mapped.dispLine}:${mapped.dispCol}`);
    } else {
      out.push(lines[k]);
    }
  }
  if (top === null) return err;
  let finalStack = out.join("\n");
  if (ctx.header) {
    const sourceLine = ctx.code.split("\n")[top.codeLine - 1] ?? "";
    finalStack = `${ctx.filename}:${top.dispLine}\n${sourceLine}\n ^\n\n${finalStack}`;
  }
  try {
    err.stack = finalStack;
  } catch (_) {
    /* frozen error; leave the original stack */
  }
  return err;
}

// ---------------------------------------------------------------------------
// 8b. Dynamic import() interception (Node's rule, lib/internal/modules/esm/
// utils.js importModuleDynamicallyCallback + lib/internal/vm.js
// getHostDefinedOptionId). The host ESM loader must never see a script's
// import() — it resolves instead of rejecting with the coded errors.
// ---------------------------------------------------------------------------

// 6 chars, same length as `import`, so the rewrite below preserves every
// line/column position in the evaluated source.
const DYNIMPORT_HELPER = "__vdim";

/** True when the host was started with --experimental-vm-modules. */
function vmModulesFlagOn() {
  const p = globalThis.process;
  return (
    typeof p === "object" &&
    p !== null &&
    Array.isArray(p.execArgv) &&
    p.execArgv.includes("--experimental-vm-modules")
  );
}

/**
 * Per-script dynamic-import handler. `getReferrer` is a thunk: compileFunction
 * builds its handler before the compiled function exists, so the referrer is
 * only read when a callback is actually invoked.
 */
function makeDynamicImportHandler(callback, getReferrer) {
  return async function __vdim(specifier, options) {
    if (callback === constants.USE_MAIN_CONTEXT_DEFAULT_LOADER) {
      return import(specifier); // host default loader
    }
    if (callback !== undefined) {
      if (!vmModulesFlagOn()) {
        throw codedError(
          TypeError,
          "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG",
          "A dynamic import callback was invoked without --experimental-vm-modules",
        );
      }
      const attributes = options?.with ?? options?.assert ?? {};
      return callback(specifier, getReferrer(), attributes, "evaluation");
    }
    throw codedError(
      TypeError,
      "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
      "A dynamic import callback was not specified.",
    );
  };
}

/** Skip whitespace and //- / /*-comments starting at j. */
function skipWsAndComments(code, j) {
  const n = code.length;
  while (j < n) {
    const c = code[j];
    if (
      c === " " ||
      c === "\t" ||
      c === "\n" ||
      c === "\r" ||
      c === "\v" ||
      c === "\f"
    ) {
      j++;
      continue;
    }
    if (c === "/" && code[j + 1] === "/") {
      j += 2;
      while (j < n && code[j] !== "\n" && code[j] !== "\r") j++;
      continue;
    }
    if (c === "/" && code[j + 1] === "*") {
      j += 2;
      while (j < n && !(code[j] === "*" && code[j + 1] === "/")) j++;
      j += 2;
      continue;
    }
    break;
  }
  return j;
}

/**
 * Rewrites genuine dynamic `import(` calls to `__vdim(`. Strings, templates
 * (recursing into ${} interpolations, where import() is real code), comments,
 * and regexes are skipped via the shared lexer. Left alone: `import.meta`,
 * member calls (`x.import(`), and object methods named `import` (detected by
 * a `{` on the same line after the balanced parens).
 * Returns the input unchanged when there is nothing to rewrite.
 * Known limits (ponytail: a full parser is out of scope): `import("x")`
 * immediately followed by a `{` block on the same line is misread as a
 * method (ASI case); a regex containing the literal text `import(` after an
 * object-literal `}` is misread as a call.
 */
function rewriteDynamicImports(code) {
  if (!code.includes("import")) return code;
  const n = code.length;
  const spans = [];
  // Scan one range, appending rewrite spans; template ${} interiors recurse.
  function scanRange(start, end) {
    let i = start;
    let operand = false;
    let prevSig = "";
    // Walk one template literal starting at i (code[i] === "`").
    function scanTemplate() {
      let j = i + 1;
      while (j < n && j < end) {
        const c = code[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "`") return j + 1;
        if (c === "$" && code[j + 1] === "{") {
          const close = matchBalanced(code, j + 1);
          scanRange(j + 2, Math.min(close - 1, end));
          j = close;
          continue;
        }
        j++;
      }
      return j;
    }
    while (i < end) {
      const c = code[i];
      if (c === '"' || c === "'") {
        i = Math.min(skipStringLex(code, i), end);
        operand = true;
        prevSig = "x";
        continue;
      }
      if (c === "`") {
        i = scanTemplate();
        operand = true;
        prevSig = "x";
        continue;
      }
      if (c === "/" && code[i + 1] === "/") {
        i += 2;
        while (i < end && code[i] !== "\n" && code[i] !== "\r") i++;
        continue;
      }
      if (c === "/" && code[i + 1] === "*") {
        i += 2;
        while (i < end && !(code[i] === "*" && code[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (c === "/" && !operand) {
        i = Math.min(skipRegexLex(code, i), end);
        operand = true;
        prevSig = "x";
        continue;
      }
      if (isIdStartChar(c)) {
        const { word, end: idEnd } = readId(code, i);
        if (word === "import" && prevSig !== ".") {
          const j = skipWsAndComments(code, idEnd);
          if (code[j] === "(") {
            const after = matchBalanced(code, j);
            let k = after;
            while (k < n && (code[k] === " " || code[k] === "\t")) k++;
            if (code[k] !== "{") spans.push([i, i + 6]);
          }
        }
        operand = !KEYWORDS.has(word);
        prevSig = "x";
        i = idEnd;
        continue;
      }
      if (c >= "0" && c <= "9") {
        i = Math.min(skipNumberLex(code, i), end);
        operand = true;
        prevSig = "x";
        continue;
      }
      if (
        c === " " ||
        c === "\t" ||
        c === "\n" ||
        c === "\r" ||
        c === "\v" ||
        c === "\f"
      ) {
        i++;
        continue;
      }
      if (c === ")" || c === "]") operand = true;
      else if (c === "}")
        operand = false; // statement position: / starts a regex
      else operand = false;
      prevSig = c;
      i++;
    }
  }
  scanRange(0, n);
  if (spans.length === 0) return code;
  let out = "";
  let last = 0;
  for (const [s, e] of spans) {
    out += code.slice(last, s) + DYNIMPORT_HELPER;
    last = e;
  }
  return out + code.slice(last);
}

// ---------------------------------------------------------------------------
// 9. Core execution engine
// ---------------------------------------------------------------------------

function runWithContext(code, target, opts, dynImport) {
  const strict = isStrictPrologue(code);
  const scanned = scanScript(code);

  // Restricted globals (spec GlobalDeclarationInstantiation 3.d): a
  // top-level let/const binding over a non-configurable own property of
  // the global must throw SyntaxError before anything runs. The shim runs
  // code as a `new Function` body, so V8 never performs this check for us.
  // ponytail: only let/const are covered — class declarations have no
  // scanner support and top-level `function` capture is incomplete
  // (`async function` at the top level is not captured), so covering them
  // would be partial; no test covers them. Ceiling: semicolon-less
  // consecutive declarations (`let a = 1\nlet b = 2`) are missed — the
  // initializer skipper cannot see the ASI boundary, a pre-existing
  // scanner limitation shared with var/assigned scanning. A throwing
  // descriptor trap is treated as "not restricted" (fail-open, as with
  // the scope proxy's traps elsewhere in this file).
  for (const name of scanned.lexical) {
    let desc = null;
    try {
      desc = Object.getOwnPropertyDescriptor(target, name);
    } catch (_) {
      desc = null;
    }
    if (desc !== undefined && desc !== null && desc.configurable === false) {
      throw new SyntaxError(
        `Identifier '${name}' has already been declared`,
      );
    }
  }

  // Pre-declare everything the code may define at the top level so it lands
  // on the context object instead of the wrapper's function scope.
  const seen = new Set();
  let prefix = "";
  for (const f of scanned.functions) {
    if (!seen.has(f.name)) {
      seen.add(f.name);
      ensureDeclared(target, f.name);
    }
    prefix += `${f.name} = ${code.slice(f.start, f.end)};\n`;
  }
  for (const name of scanned.vars) {
    if (!seen.has(name)) {
      seen.add(name);
      ensureDeclared(target, name);
    }
  }
  // Note: lexical (let/const/class) names are NOT pre-declared on the target;
  // they live in the eval's declarative scope and must not become context
  // properties (Node keeps them off globalThis too).
  // Bare-assignment targets (scanned.assigned) are NOT pre-declared: eager
  // definition fixed their insertion order at scan time (e.g. `g = f`
  // landed before a `defineProperty(this, "f", …)` that runs first).
  // Instead they are lazily claimed in sloppy scripts: the scope proxy's
  // `has` trap claims them, and its `set` trap defines them
  // (non-configurable, as ensureDeclared would have) on first assignment,
  // so insertion order follows execution order. Strict-mode scripts claim
  // nothing: in real Node `"use strict"; z = 42` throws ReferenceError for
  // an undeclared `z`, and an unclaimed `has` lets the strict eval throw
  // before any property is created (test-vm-global-contextual-store, lane 5).
  // ponytail: names already on the target (context properties like `x`, or
  // standard globals claimed by the scope proxy) are unaffected — assignment
  // to them stays legal in both modes, exactly as in Node. A read of a
  // claimed-but-unassigned name still yields undefined via the `get` trap.
  // Host-global passthrough (runInThisContext, lane 7): the host global
  // claims nothing either — implicit globals fall through the `with` to the
  // real global scope, where sloppy assignment creates them configurable,
  // exactly like Node, so `delete globalThis.vmResult` still works. A
  // claimed host-global name would be defined non-configurable by the `set`
  // trap, and `delete` would wrongly fail. Sandbox targets still need the
  // claim: without it the assignment would fall through to the REAL global
  // scope (a leak). ponytail: `new Function` bodies see only the global
  // scope, so the fall-through cannot reach shim internals.
  const claimed =
    !strict && target !== globalThis
      ? new Set(scanned.assigned)
      : new Set();

  // Remove the original top-level function declarations (they are installed
  // by the prefix instead); blanking preserves line numbers.
  const bodyCode = blankSpans(
    code,
    scanned.functions.map((f) => [f.start, f.end]),
  );
  // codeGeneration enforcement: a context created with strings:false /
  // wasm:false must throw its own EvalError / WebAssembly.CompileError when
  // user code calls eval() / new WebAssembly.Module(). The flags live on the
  // context (createContext stores them); the throwing bindings are installed
  // by a prefix INSIDE the evaluated code — the runner's own direct eval()
  // resolves through the same scope proxy, so installing them host-side
  // before the run would break the runner itself. The prefix runs first, so
  // user code sees the throwing bindings; the previous own-property state
  // is restored afterwards, but only if untouched — user code may have
  // overwritten the binding, and that assignment must persist, as in Node.
  // ponytail: the throwing values come from standardGlobals() — the
  // context's own intrinsics (what runInContext("EvalError", ctx) returns),
  // not hardcoded host references. Ceiling: only eval() and
  // WebAssembly.Module are blocked; new Function() and
  // WebAssembly.compile/instantiate are not (no test covers them).
  const codeGen = contextCodeGeneration.get(target) || {
    strings: true,
    wasm: true,
  };
  const globals = standardGlobals();
  const noEval =
    !codeGen.strings &&
    function __vm_noEval() {
      throw new globals.EvalError(
        "Code generation from strings disallowed for this context",
      );
    };
  const noWasm =
    !codeGen.wasm &&
    globals.WebAssembly &&
    (() => {
      const override = Object.create(globals.WebAssembly);
      Object.defineProperty(override, "Module", {
        value: function __vm_noWasmModule() {
          throw new globals.WebAssembly.CompileError(
            "WebAssembly.Module(): Wasm code generation disallowed by embedder",
          );
        },
        writable: true,
        enumerable: false,
        configurable: true,
      });
      return override;
    })();
  let cgPrefix = "";
  if (noEval) cgPrefix += "globalThis.eval = __vm_e__;\n";
  if (noWasm) cgPrefix += "globalThis.WebAssembly = __vm_w__;\n";
  const cgLines = (noEval ? 1 : 0) + (noWasm ? 1 : 0);

  // The prefix must come after a strict prologue so the eval stays strict.
  const evalCode =
    (strict ? '"use strict";\n' : "") + cgPrefix + prefix + bodyCode;
  // Lines before the user's code inside the eval'd source.
  const headLines = (strict ? 1 : 0) + cgLines + scanned.functions.length;

  // Route dynamic import() through the script's handler. The rewrite is
  // column- and line-preserving, so error positions still map to the
  // original code. When nothing was rewritten the helper stays out of scope
  // entirely (a factory parameter would shadow user code that mentions the
  // name).
  const rewritten = rewriteDynamicImports(evalCode);
  const hasDynImport = rewritten !== evalCode;
  // Direct eval inside the `with` keeps the scope chain and yields the
  // completion value as the return value. `eval` resolves through the scope
  // proxy to the intrinsic, so this stays a direct eval.
  const factoryBody = "with(__vm_p__){\nreturn eval(__vm_c__);\n}";
  const scope = makeScope(target, strict, claimed);
  let runner;
  try {
    runner = hasDynImport
      ? new Function(
          "__vm_p__",
          "__vm_c__",
          "__vm_e__",
          "__vm_w__",
          "__vdim",
          factoryBody,
        )
      : new Function(
          "__vm_p__",
          "__vm_c__",
          "__vm_e__",
          "__vm_w__",
          factoryBody,
        );
  } catch (e) {
    throw e;
  }
  // Save the context's own eval/WebAssembly bindings (if any) so the codegen
  // prefix can be undone after the run — but ONLY when an override will
  // actually be installed. Touching the target unconditionally trips
  // throwing Proxy traps (test-vm-proxy-failure-CP: its
  // getOwnPropertyDescriptor trap throws on any access), so a default
  // context must never reach this line. Reflect.* never throws here.
  const savedEval = noEval
    ? Object.getOwnPropertyDescriptor(target, "eval")
    : undefined;
  const savedWasm = noWasm
    ? Object.getOwnPropertyDescriptor(target, "WebAssembly")
    : undefined;
  const restore = (prop, saved, installed) => {
    const current = Object.getOwnPropertyDescriptor(target, prop);
    if (!current || current.value !== installed) return;
    if (saved === undefined) Reflect.deleteProperty(target, prop);
    else Reflect.defineProperty(target, prop, saved);
  };
  try {
    return hasDynImport
      ? runner.call(target, scope, rewritten, noEval, noWasm, dynImport)
      : runner.call(target, scope, evalCode, noEval, noWasm);
  } catch (e) {
    if (e instanceof SyntaxError) throw e; // nothing position-mappable
    throw enrichScriptError(e, {
      filename: opts.filename,
      lineOffset: opts.lineOffset,
      columnOffset: opts.columnOffset,
      code,
      headLines,
      lineBias: 0, // eval positions are relative to the eval'd source
      header: true,
    });
  } finally {
    if (noEval) restore("eval", savedEval, noEval);
    if (noWasm) restore("WebAssembly", savedWasm, noWasm);
  }
}

// ---------------------------------------------------------------------------
// 10. Script
// ---------------------------------------------------------------------------

function normalizeScriptOptions(options) {
  if (typeof options === "string") return { filename: options };
  validateObject(options, "options");
  return options;
}

function normalizeMethodOptions(options) {
  if (options === undefined) return {};
  validateObject(options, "options");
  return options;
}

function normalizeTopOptions(options) {
  if (typeof options === "string") return { filename: options };
  return { ...options };
}

// Port of Node lib/internal/validators.js validateUint32(positive=true),
// which lib/vm.js uses for `options.timeout`: same three-arm split as
// validateInt32 above (non-number -> ERR_INVALID_ARG_TYPE).
function validateTimeout(value) {
  // Node validates vm timeouts with validateUint32(timeout, ..., true)
  // (lib/vm.js:172): a non-number is a type error; a non-integer or a number
  // outside 1..4294967295 is a range error.
  if (typeof value !== "number") {
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "options.timeout" property must be of type number. ${receivedText(value)}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw codedError(
      RangeError,
      "ERR_OUT_OF_RANGE",
      `The value of "options.timeout" is out of range. It must be an integer. ${receivedText(value)}`,
    );
  }
  if (value < 1 || value > 4294967295) {
    throw codedError(
      RangeError,
      "ERR_OUT_OF_RANGE",
      `The value of "options.timeout" is out of range. It must be >= 1 && <= 4294967295. ${receivedText(value)}`,
    );
  }
}

function getRunOptions(options) {
  const {
    filename = DEFAULT_FILENAME,
    lineOffset = 0,
    columnOffset = 0,
    timeout,
    displayErrors = true,
    breakOnSigint = false,
  } = options;
  validateString(filename, "options.filename");
  validateInt32(lineOffset, "options.lineOffset");
  validateInt32(columnOffset, "options.columnOffset");
  if (timeout !== undefined) validateTimeout(timeout);
  validateBoolean(displayErrors, "options.displayErrors");
  validateBoolean(breakOnSigint, "options.breakOnSigint");
  return { filename, lineOffset, columnOffset };
}

/** Maps run options onto context options, mirroring Node's getContextOptions. */
function getContextOptions(options) {
  if (!options) return {};
  const contextOptions = {};
  if (options.contextName !== undefined) {
    validateString(options.contextName, "options.contextName");
    contextOptions.name = options.contextName;
  }
  if (options.contextOrigin !== undefined) {
    validateString(options.contextOrigin, "options.contextOrigin");
    contextOptions.origin = options.contextOrigin;
  }
  if (options.contextCodeGeneration !== undefined) {
    validateObject(
      options.contextCodeGeneration,
      "options.contextCodeGeneration",
    );
    const { strings, wasm } = options.contextCodeGeneration;
    if (strings !== undefined) {
      validateBoolean(strings, "options.contextCodeGeneration.strings");
    }
    if (wasm !== undefined) {
      validateBoolean(wasm, "options.contextCodeGeneration.wasm");
    }
    contextOptions.codeGeneration = { strings, wasm };
  }
  if (options.microtaskMode !== undefined) {
    validateOneOf(options.microtaskMode, "options.microtaskMode", [
      "afterEvaluate",
      undefined,
    ]);
    contextOptions.microtaskMode = options.microtaskMode;
  }
  return contextOptions;
}

function validateCachedData(value, name) {
  if (!ArrayBuffer.isView(value)) {
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" ${argOrProp(name)} must be an instance of Buffer, TypedArray, or DataView. ${receivedText(value)}`,
    );
  }
}

function hashSource(s) {
  let h = 0;
  for (let k = 0; k < s.length; k++) {
    h = (Math.imul(h, 31) + s.charCodeAt(k)) | 0;
  }
  return h >>> 0;
}

/**
 * Synthetic cache marker. This is NOT V8 cached data; it only lets
 * `cachedDataRejected` report whether supplied bytes match this source.
 */
function synthesizeCachedData(source) {
  const h = hashSource(source);
  const len = source.length >>> 0;
  const bytes = new Uint8Array(16);
  bytes[0] = 0x56;
  bytes[1] = 0x4d;
  bytes[2] = 0x43;
  bytes[3] = 0x44; // 'VMCD'
  bytes[4] = (h >>> 24) & 0xff;
  bytes[5] = (h >>> 16) & 0xff;
  bytes[6] = (h >>> 8) & 0xff;
  bytes[7] = h & 0xff;
  bytes[8] = (len >>> 24) & 0xff;
  bytes[9] = (len >>> 16) & 0xff;
  bytes[10] = (len >>> 8) & 0xff;
  bytes[11] = len & 0xff;
  for (let k = 12; k < 16; k++) bytes[k] = (h >>> ((k % 4) * 8)) & 0xff;
  // Node's createCachedData() returns a Buffer; use it when available
  // (parity harness under Node), falling back to Uint8Array in browsers.
  if (typeof globalThis.Buffer === "function") {
    return globalThis.Buffer.from(bytes);
  }
  return bytes;
}

/**
 * Real V8 code-cache magic (the first 8 bytes of what real Node's
 * produceCachedData emits): 89 06 de c0 fa 8c 33 dc. The source length sits
 * as a LE uint32 at offset 8. The full source text is NOT embedded verbatim
 * (only its string constants are), so magic + source length is the
 * validation available here.
 * ponytail: ceiling — a wrong source of the SAME length is not distinguished
 * (V8 stores an internal source hash at offset 12/16 that this shim does
 * not replicate); no vendored test covers that shape. A cache sliced by 4
 * breaks the magic and is rejected deterministically.
 */
const V8_CACHE_MAGIC = [0x89, 0x06, 0xde, 0xc0, 0xfa, 0x8c, 0x33, 0xdc];

function cachedDataMatches(source, cachedData) {
  let bytes = null;
  if (cachedData instanceof Uint8Array) bytes = cachedData;
  else if (ArrayBuffer.isView(cachedData)) {
    bytes = new Uint8Array(
      cachedData.buffer,
      cachedData.byteOffset,
      cachedData.byteLength,
    );
  }
  if (bytes === null || bytes.length < 12) return false;
  // Real V8 cache bytes (the harness's produce() spawns a real Node child,
  // so consume sees genuine V8 bytes, never the synthetic VMCD marker):
  // accept on magic + source-length field.
  let isV8 = true;
  for (let k = 0; k < 8; k++) {
    if (bytes[k] !== V8_CACHE_MAGIC[k]) {
      isV8 = false;
      break;
    }
  }
  if (isV8) {
    const storedLen =
      (bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] << 24)) >>>
      0;
    return storedLen === source.length >>> 0;
  }
  if (
    bytes[0] !== 0x56 ||
    bytes[1] !== 0x4d ||
    bytes[2] !== 0x43 ||
    bytes[3] !== 0x44
  )
    return false;
  const h = hashSource(source);
  const storedHash =
    ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0;
  const storedLen =
    ((bytes[8] << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11]) >>> 0;
  return storedHash === h && storedLen === source.length >>> 0;
}

export class Script {
  #code;
  #filename;
  #lineOffset;
  #columnOffset;
  #cachedDataRejected;
  #cachedData;
  #importModuleDynamically;

  constructor(code, options = {}) {
    code = `${code}`;
    options = normalizeScriptOptions(options);
    const {
      filename = DEFAULT_FILENAME,
      lineOffset = 0,
      columnOffset = 0,
      cachedData,
      produceCachedData = false,
      importModuleDynamically,
    } = options;
    validateString(filename, "options.filename");
    validateInt32(lineOffset, "options.lineOffset");
    validateInt32(columnOffset, "options.columnOffset");
    if (cachedData !== undefined && cachedData !== null) {
      validateCachedData(cachedData, "options.cachedData");
    }
    validateBoolean(produceCachedData, "options.produceCachedData");
    // Node's getHostDefinedOptionId accepts the USE_MAIN_CONTEXT_DEFAULT_LOADER
    // symbol as-is (it is not a function); anything else must be one.
    if (
      importModuleDynamically !== undefined &&
      importModuleDynamically !== constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
    ) {
      validateFunction(
        importModuleDynamically,
        "options.importModuleDynamically",
      );
    }

    this.#code = code;
    this.#filename = filename;
    this.#lineOffset = lineOffset;
    this.#columnOffset = columnOffset;
    this.#cachedDataRejected =
      cachedData !== undefined && cachedData !== null
        ? !cachedDataMatches(code, cachedData)
        : undefined;
    this.#cachedData = produceCachedData
      ? synthesizeCachedData(code)
      : undefined;
    this.#importModuleDynamically = importModuleDynamically;

    // Extract //# sourceMappingURL= magic comment from the end of the source.
    let sourceMapURL;
    const smMatch = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(code);
    if (smMatch) sourceMapURL = smMatch[1];

    Object.defineProperties(this, {
      sourceURL: {
        value: undefined,
        writable: true,
        enumerable: true,
        configurable: true,
      },
      sourceMapURL: {
        value: sourceMapURL,
        writable: true,
        enumerable: true,
        configurable: true,
      },
    });
  }

  get cachedDataRejected() {
    return this.#cachedDataRejected;
  }
  get cachedData() {
    return this.#cachedData;
  }
  get cachedDataProduced() {
    return this.#cachedData !== undefined;
  }

  createCachedData() {
    if (this.#cachedData === undefined) {
      this.#cachedData = synthesizeCachedData(this.#code);
    }
    const out = this.#cachedData.slice();
    // Node returns a Buffer; preserve that when available.
    if (
      typeof globalThis.Buffer === "function" &&
      !(out instanceof globalThis.Buffer)
    ) {
      return globalThis.Buffer.from(out);
    }
    return out;
  }

  #runOptions(options) {
    return getRunOptions({
      filename: this.#filename,
      lineOffset: this.#lineOffset,
      columnOffset: this.#columnOffset,
      ...options,
    });
  }

  runInContext(contextifiedObject, options = {}) {
    validateContext(contextifiedObject);
    options = normalizeMethodOptions(options);
    return runWithContext(
      this.#code,
      contextifiedObject,
      this.#runOptions(options),
      makeDynamicImportHandler(this.#importModuleDynamically, () => this),
    );
  }

  runInNewContext(contextObject, options = {}) {
    options = normalizeMethodOptions(options);
    const ctx = createContext(contextObject, getContextOptions(options));
    return this.runInContext(ctx, options);
  }

  runInThisContext(options = {}) {
    options = normalizeMethodOptions(options);
    const runOpts = this.#runOptions(options);
    // Route through runWithContext with the host global as the target.
    // Indirect eval cannot create the non-configurable global `var`
    // bindings real runInThisContext creates: after `(0, eval)`, `var b`
    // is deletable, so `delete b; data.push(b)` throws ReferenceError
    // (probe P2). The scanner pre-declares top-level `var`/`function` on
    // globalThis as non-configurable, and implicit globals fall through
    // to the real global scope (see the `assigned` skip in
    // runWithContext), so `delete` behaves like Node.
    // Dynamic import() is intercepted by runWithContext via the handler
    // (lane 1): the rewrite happens on the eval code there, so no
    // temporary-global install is needed on this path.
    return runWithContext(
      this.#code,
      globalThis,
      runOpts,
      makeDynamicImportHandler(this.#importModuleDynamically, () => this),
    );
  }
}

// ---------------------------------------------------------------------------
// 11. Public run* API
// ---------------------------------------------------------------------------

export function runInContext(code, contextifiedObject, options) {
  options = normalizeTopOptions(options);
  return createScript(code, options).runInContext(contextifiedObject, options);
}

export function runInNewContext(code, contextObject, options) {
  options = normalizeTopOptions(options);
  return createScript(code, options).runInNewContext(contextObject, options);
}

export function runInThisContext(code, options) {
  options = normalizeTopOptions(options);
  return createScript(code, options).runInThisContext(options);
}

// Pre-parse a compileFunction body as a bare function body, surfacing the
// RAW SyntaxError before the wrapped factory below can shift the token
// context. Real Node parses the raw code as a function body
// (ScriptCompiler::CompileFunction, lib/vm.js compileFunction -> binding),
// while the factory wraps it as `function(params){ code }` — so a malformed
// body reports the WRAPPER's token context (e.g. `});` closes the wrapper
// and V8 reports the `)` instead of the `}`).
//
// Host `new Function(code)` parses the same body grammar and agrees with
// vm.compileFunction on most inputs, but its parser diverges twice: it
// reports "Single function literal required" when the body closes the
// synthetic function early AND trails off unclosed, and it reports the
// wrapper's next token (e.g. `else`) for a leading `}`. In those cases the
// raw program parse ((0, eval)(code)) sees the same first offending token
// vm does, so its SyntaxError is preferred — except "Illegal return
// statement", which only means eval is program-scoped and blind to the
// body's top-level `return`.
// Pre-parse WITHOUT params: with params, a bad param name would fail the
// parse while the code itself is valid, and the eval fallback would then
// EXECUTE the valid code. Params are still validated by the factory parse
// below, exactly as today. The eval is only consulted after new Function
// already failed, i.e. the code is invalid as a body (hence also invalid
// as a program — the body grammar is a superset for syntax purposes), and
// only a SyntaxError from it is ever used, so nothing executes.
// ponytail: ceiling — a body with BOTH a top-level `return` and an
// early-`}` + unclosed tail (e.g. `return 1;\n});\n\n(function() {`)
// still reports "Single function literal required": eval is blind past the
// `return` and new Function hits its quirk. Fixing that needs a real
// parser (acorn is dev-only here, and its messages don't match V8's
// either). Verified matrix: 13/14 probe inputs match vm exactly (see
// NOTES-vm-syntax-error.md).
function preParseFunctionBody(code) {
  let fnErr;
  try {
    new Function(code);
    return; // valid body; the factory below validates params + scope
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    fnErr = e;
  }
  try {
    (0, eval)(code);
  } catch (e) {
    if (e instanceof SyntaxError && e.message !== "Illegal return statement") {
      throw e;
    }
  }
  throw fnErr;
}

// ---------------------------------------------------------------------------
// 12. compileFunction
// ---------------------------------------------------------------------------

export function compileFunction(code, params = [], options = {}) {
  validateString(code, "code");
  if (params === undefined) params = [];
  else validateStringArray(params, "params");
  validateObject(options, "options");
  const {
    filename = "",
    lineOffset = 0,
    columnOffset = 0,
    cachedData,
    produceCachedData = false,
    parsingContext,
    contextExtensions = [],
    importModuleDynamically,
  } = options;
  validateString(filename, "options.filename");
  validateInt32(lineOffset, "options.lineOffset");
  validateInt32(columnOffset, "options.columnOffset");
  if (cachedData !== undefined)
    validateCachedData(cachedData, "options.cachedData");
  validateBoolean(produceCachedData, "options.produceCachedData");
  if (parsingContext !== undefined) {
    if (
      typeof parsingContext !== "object" ||
      parsingContext === null ||
      !contextified.has(parsingContext)
    ) {
      throw codedError(
        TypeError,
        "ERR_INVALID_ARG_TYPE",
        `The "options.parsingContext" property must be an instance of Context. ${receivedText(parsingContext)}`,
      );
    }
  }
  if (!Array.isArray(contextExtensions)) {
    throw codedError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "options.contextExtensions" property must be an instance of Array. ${receivedText(contextExtensions)}`,
    );
  }
  for (let k = 0; k < contextExtensions.length; k++) {
    const ext = contextExtensions[k];
    if (typeof ext !== "object" || ext === null || Array.isArray(ext)) {
      throw codedError(
        TypeError,
        "ERR_INVALID_ARG_TYPE",
        `The "options.contextExtensions[${k}]" property must be of type object. ${receivedText(ext)}`,
      );
    }
  }
  // Node's getHostDefinedOptionId accepts the USE_MAIN_CONTEXT_DEFAULT_LOADER
  // symbol as-is (it is not a function); anything else must be one.
  if (
    importModuleDynamically !== undefined &&
    importModuleDynamically !== constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
  ) {
    validateFunction(
      importModuleDynamically,
      "options.importModuleDynamically",
    );
  }

  // Scope target: the parsing context itself (extensions are applied onto it,
  // mirroring Node where extensions become part of the context's global), or
  // a fresh object when no parsing context is given.
  const target = parsingContext !== undefined ? parsingContext : {};
  if (parsingContext === undefined) {
    // Without a parsing context the compiled function runs in the host realm,
    // so the host global's self-references must resolve: `global` (and
    // `globalThis`) read as the host global object. Without this, makeScope's
    // host-block trap claims `global` (it is a host global) and its getter
    // returns undefined. Extensions below still win if they define `global`.
    target.global = globalThis;
    target.globalThis = globalThis;
  }
  for (const ext of contextExtensions) {
    for (const key of Reflect.ownKeys(ext)) {
      if (key === "__proto__") continue;
      let desc = null;
      try {
        desc = Reflect.getOwnPropertyDescriptor(ext, key);
      } catch (_) {
        /* skip */
      }
      if (desc === null || desc === undefined) continue;
      try {
        Object.defineProperty(target, key, desc);
      } catch (_) {
        /* skip */
      }
    }
  }

  // Route dynamic import() through the script's handler (same rewrite as
  // runWithContext; the compiled function closes over the factory's helper
  // parameter). toString/cachedData/error positions keep the original code.
  const rewritten = rewriteDynamicImports(code);
  const hasDynImport = rewritten !== code;
  const dynImport = hasDynImport
    ? makeDynamicImportHandler(importModuleDynamically, () => compiled)
    : undefined;
  const factoryBody =
    "with(__vm_s__){\n" +
    `return function(${params.join(",")}) {\n` +
    rewritten +
    "\n};\n}";
  const scope = makeScope(target);
  // Surface the raw body's SyntaxError before the wrapper shifts the token
  // context (see preParseFunctionBody). Only after the raw parse succeeds
  // is the wrapped form used.
  preParseFunctionBody(code);
  let fn;
  try {
    fn = hasDynImport
      ? new Function("__vm_s__", "__vdim", factoryBody)(scope, dynImport)
      : new Function("__vm_s__", factoryBody)(scope);
  } catch (e) {
    // Param-name errors surface here (the pre-parse runs without params);
    // body errors are already surfaced above with the raw message.
    throw e;
  }

  const thisArg = parsingContext !== undefined ? target : undefined;
  const ctx = {
    filename: filename || "<anonymous>",
    lineOffset,
    columnOffset,
    code,
    headLines: 2,
    lineBias: 2,
    header: false,
  };
  const compiled = function (...args) {
    try {
      return fn.apply(thisArg, args);
    } catch (e) {
      throw enrichScriptError(e, ctx);
    }
  };
  // Match Node's Function#toString for compiled functions.
  Object.defineProperty(compiled, "toString", {
    value: function toString() {
      return `function (${params.join(", ")}) {\n${code}\n}`;
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });

  const sourceKey = `${code}\n${params.join(",")}`;
  if (produceCachedData) {
    compiled.cachedData = synthesizeCachedData(sourceKey);
    compiled.cachedDataProduced = true;
  } else {
    compiled.cachedData = undefined;
    compiled.cachedDataProduced = false;
  }
  compiled.cachedDataRejected =
    cachedData !== undefined
      ? !cachedDataMatches(sourceKey, cachedData)
      : undefined;
  return compiled;
}

// ---------------------------------------------------------------------------
// 13. measureMemory (synthetic; no V8 heap access from here)
// ---------------------------------------------------------------------------

let measureMemoryWarningEmitted = false;
function emitMeasureMemoryWarning() {
  // Node lib/vm.js:382 emits the experimental warning BEFORE validation,
  // once per process (lib/internal/util.js emitExperimentalWarning).
  if (measureMemoryWarningEmitted) return;
  measureMemoryWarningEmitted = true;
  try {
    if (
      typeof process !== "undefined" &&
      typeof process.emitWarning === "function"
    ) {
      process.emitWarning(
        "vm.measureMemory is an experimental feature and might change at any time",
        "ExperimentalWarning",
      );
    }
  } catch {}
}

export function measureMemory(options = {}) {
  emitMeasureMemoryWarning();
  if (options === undefined) options = {};
  validateObject(options, "options");
  const { mode = "summary", execution = "default" } = options;
  validateOneOf(mode, "options.mode", ["summary", "detailed"]);
  validateOneOf(execution, "options.execution", ["default", "eager"]);
  // NOT async: real Node (lib/vm.js:382) is a plain function returning a
  // promise, so validation throws synchronously (assert.throws relies on
  // it) — the old `async` form turned the throws into rejections.
  const current = syntheticMemoryShape();
  const other = [...liveContexts];
  const total = {
    jsMemoryEstimate:
      current.jsMemoryEstimate +
      other.reduce((sum, entry) => sum + entry.jsMemoryEstimate, 0),
    jsMemoryRange: [
      current.jsMemoryRange[0] +
        other.reduce((sum, entry) => sum + entry.jsMemoryRange[0], 0),
      current.jsMemoryRange[1] +
        other.reduce((sum, entry) => sum + entry.jsMemoryRange[1], 0),
    ],
  };
  // Key order matches real Node: total, WebAssembly, current, other.
  const result = {
    total,
    WebAssembly: { code: 0, metadata: 0 },
  };
  if (mode === "detailed") {
    result.current = current;
    result.other = other;
  }
  return Promise.resolve(result);
}

// ---------------------------------------------------------------------------
// 14. ESM module stubs (honest: not implementable without a module loader)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 15. Default export
// ---------------------------------------------------------------------------

export default {
  Script,
  compileFunction,
  constants,
  createContext,
  createScript,
  isContext,
  measureMemory,
  runInContext,
  runInNewContext,
  runInThisContext,
};
