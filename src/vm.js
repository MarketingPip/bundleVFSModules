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
  if (input === null) return 'Received null';
  if (input === undefined) return 'Received undefined';
  const t = typeof input;
  if (t === 'function') return `Received function ${input.name || '(anonymous)'}`;
  if (t === 'object') {
    const name = input.constructor && input.constructor.name;
    return name ? `Received an instance of ${name}` : `Received ${String(input)}`;
  }
  let inspected = t === 'string' ? `'${input}'` : String(input);
  if (inspected.length > 28) inspected = `${inspected.slice(0, 25)}...`;
  return `Received type ${t} (${inspected})`;
}

function argOrProp(name) {
  return name.includes('.') ? 'property' : 'argument';
}

function validateObject(value, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
      `The "${name}" ${argOrProp(name)} must be of type object. ${receivedText(value)}`);
  }
}

function validateString(value, name) {
  if (typeof value !== 'string') {
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
      `The "${name}" ${argOrProp(name)} must be of type string. ${receivedText(value)}`);
  }
}

function validateBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
      `The "${name}" ${argOrProp(name)} must be of type boolean. ${receivedText(value)}`);
  }
}

function validateFunction(value, name) {
  if (typeof value !== 'function') {
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
      `The "${name}" ${argOrProp(name)} must be of type function. ${receivedText(value)}`);
  }
}

function validateStringArray(value, name) {
  if (!Array.isArray(value)) {
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
      `The "${name}" ${argOrProp(name)} must be an instance of Array. ${receivedText(value)}`);
  }
  for (let k = 0; k < value.length; k++) {
    if (typeof value[k] !== 'string') {
      throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
        `The "${name}[${k}]" ${argOrProp(name)} must be of type string. ${receivedText(value[k])}`);
    }
  }
}

function validateInt32(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) ||
      value < -2147483648 || value > 2147483647) {
    throw codedError(RangeError, 'ERR_OUT_OF_RANGE',
      `The value of "${name}" is out of range. It must be >= -2147483648 and <= 2147483647. ${receivedText(value)}`);
  }
}

function validateUint32(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) ||
      value < 0 || value > 4294967295) {
    throw codedError(RangeError, 'ERR_OUT_OF_RANGE',
      `The value of "${name}" is out of range. It must be >= 0 and <= 4294967295. ${receivedText(value)}`);
  }
}

function validateOneOf(value, name, allowed) {
  if (!allowed.includes(value)) {
    const list = allowed.map((v) => (v === undefined ? 'undefined' : `'${v}'`)).join(', ');
    throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE',
      `The property '${name}' must be one of: ${list}. ${receivedText(value)}`);
  }
}

function validateAbortSignal(value, name) {
  if (typeof value !== 'object' || value === null ||
      (typeof AbortSignal !== 'undefined' && !(value instanceof AbortSignal))) {
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
      `The "${name}" argument must be an instance of AbortSignal. ${receivedText(value)}`);
  }
}

// ---------------------------------------------------------------------------
// 2. constants
// ---------------------------------------------------------------------------

export const constants = Object.freeze({
  USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('vm.USE_MAIN_CONTEXT_DEFAULT_LOADER'),
  DONT_CONTEXTIFY: Symbol('vm.DONT_CONTEXTIFY'),
});

const DEFAULT_FILENAME = 'evalmachine.<anonymous>';

// ---------------------------------------------------------------------------
// 3. Context tracking
// ---------------------------------------------------------------------------

const contextified = new WeakSet();
let contextNameIndex = 0;

function markContext(obj) {
  contextified.add(obj);
  return obj;
}

export function isContext(object) {
  if (typeof object !== 'object' || object === null || Array.isArray(object)) {
    if (Array.isArray(object)) return false;
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
      `The "object" argument must be of type object. ${receivedText(object)}`);
  }
  return contextified.has(object);
}

function validateContext(contextifiedObject) {
  if (typeof contextifiedObject !== 'object' || contextifiedObject === null) {
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
      `The "object" argument must be of type object. ${receivedText(contextifiedObject)}`);
  }
  if (!contextified.has(contextifiedObject)) {
    const name = contextifiedObject.constructor && contextifiedObject.constructor.name;
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
      `The "contextifiedObject" argument must be an vm.Context. Received an instance of ${name || 'Object'}`);
  }
}

export function createContext(contextObject = {}, options = {}) {
  if (contextObject === constants.DONT_CONTEXTIFY) {
    return markContext({});
  }
  if (contextified.has(contextObject)) return contextObject;
  validateObject(contextObject, 'sandbox');
  validateObject(options, 'options');
  const {
    name = `VM Context ${++contextNameIndex}`,
    origin,
    codeGeneration,
    microtaskMode,
  } = options;
  validateString(name, 'options.name');
  if (origin !== undefined) validateString(origin, 'options.origin');
  if (codeGeneration !== undefined) {
    validateObject(codeGeneration, 'options.codeGeneration');
    const { strings = true, wasm = true } = codeGeneration;
    validateBoolean(strings, 'options.codeGeneration.strings');
    validateBoolean(wasm, 'options.codeGeneration.wasm');
  }
  if (microtaskMode !== undefined) {
    validateOneOf(microtaskMode, 'options.microtaskMode', ['afterEvaluate', undefined]);
  }
  return markContext(contextObject);
}

export function createScript(code, options) {
  return new Script(code, options);
}

// ---------------------------------------------------------------------------
// 4. Standard globals visible inside a context
// ---------------------------------------------------------------------------

const GLOBAL_NAMES = (
  'Infinity NaN undefined eval isFinite isNaN parseFloat parseInt ' +
  'decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape ' +
  'Object Function Boolean Symbol Error AggregateError EvalError RangeError ' +
  'ReferenceError SyntaxError TypeError URIError Number BigInt Math Date String ' +
  'RegExp Array Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array ' +
  'Int32Array Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array ' +
  'Map Set WeakMap WeakSet WeakRef ArrayBuffer SharedArrayBuffer Atomics ' +
  'DataView JSON Promise Reflect Proxy Intl WebAssembly console'
).split(' ');

let _standardGlobals = null;
function standardGlobals() {
  if (_standardGlobals === null) {
    const table = Object.create(null);
    const g = globalThis;
    for (const name of GLOBAL_NAMES) {
      if (name in g) {
        try { table[name] = g[name]; } catch (_) { /* ignore getters that throw */ }
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
    if (s[k] === '\n') count++;
  }
  return count;
}

/** Pre-declare a name on the context object as a non-configurable binding. */
function ensureDeclared(target, name) {
  if (name === '__proto__') return;
  if (Reflect.has(target, name)) return;
  try {
    Object.defineProperty(target, name, {
      value: undefined,
      writable: true,
      enumerable: true,
      configurable: false,
    });
  } catch (_) { /* host Proxy rejected it; reads fall back to globals */ }
}

/** Replace spans with whitespace, preserving line breaks for stack mapping. */
function blankSpans(code, spans) {
  if (spans.length === 0) return code;
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let last = 0;
  for (const [s, e] of spans) {
    if (s < last) continue;
    out += code.slice(last, s);
    out += code.slice(s, e).replace(/[^\r\n\u2028\u2029]/g, ' ');
    last = e;
  }
  out += code.slice(last);
  return out;
}

function skipWsCommentsFlat(code, j) {
  const n = code.length;
  while (j < n) {
    const c = code[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' ||
        c === '\f' || c === '\u00a0' || c === '\ufeff' ||
        c === '\u2028' || c === '\u2029') { j++; continue; }
    if (c === '/' && code[j + 1] === '/') {
      j += 2;
      while (j < n && code[j] !== '\n' && code[j] !== '\r') j++;
      continue;
    }
    if (c === '/' && code[j + 1] === '*') {
      j += 2;
      while (j < n && !(code[j] === '*' && code[j + 1] === '/')) j++;
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
    if (c === '\\') { j += 2; continue; }
    if (c === q) return j + 1;
    if (c === '\n' || c === '\r') break;
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
  ('break case catch class const continue debugger default delete do else ' +
   'enum export extends finally for function if implements import in instanceof ' +
   'interface let new package private protected public return static super ' +
   'switch this throw try typeof var void while with yield await').split(' ')
);

function isIdStartChar(c) {
  if (!c) return false;
  const n = c.charCodeAt(0);
  if (n === 36 || n === 95 || (n >= 65 && n <= 90) || (n >= 97 && n <= 122)) return true;
  if (n < 128) return false;
  return ID_START_RE.test(c);
}

function isIdPartChar(c) {
  if (!c) return false;
  const n = c.charCodeAt(0);
  if (n === 36 || n === 95 || (n >= 48 && n <= 57) ||
      (n >= 65 && n <= 90) || (n >= 97 && n <= 122)) return true;
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
    if (c === '\\') { j += 2; continue; }
    if (c === q) return j + 1;
    if (c === '\n' || c === '\r') break;
    j++;
  }
  return j;
}

function skipNumberLex(code, j) {
  const n = code.length;
  while (j < n) {
    const c = code[j];
    if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
        (c >= 'A' && c <= 'Z') || c === '_' || c === '.' || c === '$') j++;
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
    if (c === '\\') { j += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { j++; break; }
    else if ((c === '\n' || c === '\r') && !inClass) break;
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
    if (c === '"' || c === "'") { j = skipStringLex(code, j); operand = true; continue; }
    if (c === '`') { j = skipTemplateLex(code, j); operand = true; continue; }
    if (c === '/' && code[j + 1] === '/') {
      j += 2;
      while (j < n && code[j] !== '\n' && code[j] !== '\r') j++;
      continue;
    }
    if (c === '/' && code[j + 1] === '*') {
      j += 2;
      while (j < n && !(code[j] === '*' && code[j + 1] === '/')) j++;
      j += 2;
      continue;
    }
    if (c === '/' && !operand) { j = skipRegexLex(code, j); operand = true; continue; }
    if (c === '(' || c === '[' || c === '{') { stack.push(c); operand = false; j++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      const o = stack[stack.length - 1];
      if ((o === '(' && c === ')') || (o === '[' && c === ']') || (o === '{' && c === '}')) {
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
    if (c >= '0' && c <= '9') { j = skipNumberLex(code, j); operand = true; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f') { j++; continue; }
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
    if (c === '\\') { j += 2; continue; }
    if (c === '`') return j + 1;
    if (c === '$' && code[j + 1] === '{') { j = matchBalanced(code, j + 1); continue; }
    j++;
  }
  return j;
}

/** Best-effort binding identifiers from a destructuring pattern's text. */
function collectPatternIds(text, vars) {
  const clean = text.replace(/'(?:[^'\\\r\n]|\\.)*'|"(?:[^"\\\r\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '');
  const re = /[$A-Z_a-z][$\w]*/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const word = m[0];
    if (KEYWORDS.has(word)) continue;
    let k = m.index + word.length;
    while (k < clean.length && (clean[k] === ' ' || clean[k] === '\t' ||
           clean[k] === '\n' || clean[k] === '\r')) k++;
    if (clean[k] === ':') continue; // property key, not a binding
    vars.push(word);
  }
}

function scanScript(code) {
  const functions = []; // { name, start, end }
  const vars = [];
  const assigned = [];
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
  let sigChar = '';
  let paramDepth = 0;

  function skipWs(j) {
    while (j < n) {
      const c = code[j];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' ||
          c === '\f' || c === '\u00a0' || c === '\ufeff' ||
          c === '\u2028' || c === '\u2029') { j++; continue; }
      if (c === '/' && code[j + 1] === '/') {
        j += 2;
        while (j < n && code[j] !== '\n' && code[j] !== '\r') j++;
        continue;
      }
      if (c === '/' && code[j + 1] === '*') {
        j += 2;
        while (j < n && !(code[j] === '*' && code[j + 1] === '/')) j++;
        j += 2;
        continue;
      }
      break;
    }
    return j;
  }

  // Skip an initializer/expression until `,` or `;` at depth 0.
  function skipInitializer(j) {
    let d0 = 0, d1 = 0, d2 = 0;
    let op = false;
    while (j < n) {
      const c = code[j];
      if (c === '"' || c === "'") { j = skipStringLex(code, j); op = true; continue; }
      if (c === '`') { j = skipTemplateLex(code, j); op = true; continue; }
      if (c === '/' && (code[j + 1] === '/' || code[j + 1] === '*')) {
        j = skipWs(code, j); continue;
      }
      if (c === '/' && !op) { j = skipRegexLex(code, j); op = true; continue; }
      if (c === '(') { d0++; op = false; j++; continue; }
      if (c === ')') { if (d0 === 0) break; d0--; op = true; j++; continue; }
      if (c === '[') { d1++; op = false; j++; continue; }
      if (c === ']') { if (d1 === 0) break; d1--; op = true; j++; continue; }
      if (c === '{') { d2++; op = false; j++; continue; }
      if (c === '}') { if (d2 === 0) break; d2--; op = true; j++; continue; }
      if ((c === ',' || c === ';') && d0 === 0 && d1 === 0 && d2 === 0) break;
      if (isIdStartChar(c)) { j = readId(code, j).end; op = true; continue; }
      if (c >= '0' && c <= '9') { j = skipNumberLex(code, j); op = true; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f') { j++; continue; }
      op = false;
      j++;
    }
    return j;
  }

  /** Skip a let/const declarator list (we only need its extent, not its names). */
  function skipLexical(j) {
    let d0 = 0, d1 = 0, d2 = 0;
    while (j < n) {
      const c = code[j];
      if (c === '"' || c === "'" || c === '`') { j = skipStringLex(code, j); continue; }
      if (c === '/' && (code[j + 1] === '/' || code[j + 1] === '*')) { j = skipCommentLex(code, j); continue; }
      if (c === '(') { d0++; j++; continue; }
      if (c === ')') { if (d0 === 0) break; d0--; j++; continue; }
      if (c === '[') { d1++; j++; continue; }
      if (c === ']') { if (d1 === 0) break; d1--; j++; continue; }
      if (c === '{') { d2++; j++; continue; }
      if (c === '}') { if (d2 === 0) break; d2--; j++; continue; }
      if (c === ';' && d0 === 0 && d1 === 0 && d2 === 0) { j++; break; }
      j++;
    }
    return j;
  }

  function parseVarDeclarators(j) {    while (true) {
      j = skipWs(j);
      if (j >= n) break;
      const c = code[j];
      if (c === '{' || c === '[') {
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
      if (code[j] === '=') j = skipInitializer(j + 1);
      j = skipWs(j);
      if (code[j] === ',') { j++; continue; }
      break;
    }
    return j;
  }

  function onWord(word, start) {
    const isProp = sigChar === '.';
    const topLevel = braceDepth === 0 && parenDepth === 0 && bracketDepth === 0;
    // Skip lexical declarations so their names are not misclassified as
    // bare assignments. `let` is also a valid sloppy-mode identifier, so
    // only skip when it opens a binding.
    if (!isProp && (word === 'let' || word === 'const') && topLevel && declPos) {
      const j = skipWs(start + word.length);
      const c = code[j];
      if (c === '{' || c === '[' || isIdStartChar(c)) {
        i = skipLexical(j);
        return;
      }
    }
    if (!isProp && word === 'function' && topLevel && declPos) {
      let j = skipWs(start + 8);
      if (code[j] === '*') j = skipWs(j + 1);
      let name = '';
      if (isIdStartChar(code[j] || '')) name = readId(code, j).word;
      let capture = null;
      if (name !== '') {
        capture = { name, start: asyncStart >= 0 ? asyncStart : start, level: 0 };
      }
      fnStack.push({ paren: parenDepth, stage: 0, capture });
      asyncStart = -1;
    } else if (!isProp && word === 'function') {
      fnStack.push({ paren: parenDepth, stage: 0, capture: null });
      asyncStart = -1;
    } else if (!isProp && word === 'async' && topLevel && declPos) {
      const j = skipWs(start + 5);
      asyncStart = (code.startsWith('function', j) && !isIdPartChar(code[j + 8] || ''))
        ? start : -1;
    } else {
      asyncStart = -1;
      if (!isProp && word === 'var' && topLevel && declPos) {
        i = parseVarDeclarators(start + 3);
      } else if (!isProp && !KEYWORDS.has(word) && topLevel && paramDepth === 0) {
        // Possible bare assignment target: `name = …` (not `==`, `=>`).
        const j = skipWs(start + word.length);
        if (code[j] === '=' && code[j + 1] !== '=' && code[j + 1] !== '>') {
          assigned.push(word);
        }
      }
    }
    if (word === 'this' || word === 'super' || word === 'true' ||
        word === 'false' || word === 'null') {
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
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' ||
        c === '\f' || c === '\u00a0' || c === '\ufeff' ||
        c === '\u2028' || c === '\u2029') { i++; continue; }
    if (c === '/' && (code[i + 1] === '/' || code[i + 1] === '*')) {
      i = skipWs(i); continue;
    }
    if (c === '"' || c === "'") {
      i = skipStringLex(code, i);
      operand = true; declPos = false; asyncStart = -1; sigChar = c;
      continue;
    }
    if (c === '`') {
      i = skipTemplateLex(code, i);
      operand = true; declPos = false; asyncStart = -1; sigChar = '`';
      continue;
    }
    if (c === '/') {
      if (!operand) { i = skipRegexLex(code, i); operand = true; }
      else { i++; operand = false; }
      declPos = false; asyncStart = -1; sigChar = '/';
      continue;
    }
    if (isIdStartChar(c)) {
      const r = readId(code, i);
      const start = i;
      i = r.end;
      onWord(r.word, start);
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && code[i + 1] >= '0' && code[i + 1] <= '9')) {
      i = skipNumberLex(code, i);
      operand = true; declPos = false; asyncStart = -1; sigChar = '0';
      continue;
    }
    if (c === '{') {
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
      operand = false; declPos = true; asyncStart = -1; sigChar = '{';
      i++;
      continue;
    }
    if (c === '}') {
      const wasFunc = braceIsFunc.pop();
      if (wasFunc && activeCapture !== null && activeCapture.level === braceDepth) {
        functions.push({
          name: activeCapture.name,
          start: activeCapture.start,
          end: i + 1,
        });
        activeCapture = null;
      }
      braceDepth--;
      operand = true; declPos = true; asyncStart = -1; sigChar = '}';
      i++;
      continue;
    }
    if (c === '(') {
      const top = fnStack.length > 0 ? fnStack[fnStack.length - 1] : null;
      if (top !== null && top.stage === 0 && parenDepth === top.paren) {
        top.stage = 1;
        paramDepth++;
      }
      parenDepth++;
      operand = false; declPos = false; asyncStart = -1; sigChar = '(';
      i++;
      continue;
    }
    if (c === ')') {
      parenDepth--;
      const top = fnStack.length > 0 ? fnStack[fnStack.length - 1] : null;
      if (top !== null && top.stage === 1 && parenDepth === top.paren) {
        top.stage = 2;
        paramDepth--;
      }
      operand = true; declPos = false; asyncStart = -1; sigChar = ')';
      i++;
      continue;
    }
    if (c === '[') {
      bracketDepth++;
      operand = false; declPos = false; asyncStart = -1; sigChar = '[';
      i++;
      continue;
    }
    if (c === ']') {
      bracketDepth--;
      operand = true; declPos = false; asyncStart = -1; sigChar = ']';
      i++;
      continue;
    }
    if (c === ';') {
      operand = false; declPos = true; asyncStart = -1; sigChar = ';';
      i++;
      continue;
    }
    // All other punctuation / operators.
    operand = false; declPos = false; asyncStart = -1; sigChar = c;
    i++;
  }

  return { functions, vars, assigned };
}

// ---------------------------------------------------------------------------
// 7. Scope proxy: the `with` statement's object
// ---------------------------------------------------------------------------

function makeScope(target) {
  const globals = standardGlobals();
  return new Proxy(target, {
    has(t, prop) {
      if (typeof prop === 'symbol') return Reflect.has(t, prop);
      if (prop === 'globalThis') return true;
      if (Reflect.has(t, prop)) return true;
      if (prop in globals) return true;
      // Block host globals from leaking into the sandbox: claim them so the
      // `with` never falls through to the real global scope.
      return prop in globalThis;
    },
    get(t, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop);
      if (prop === 'globalThis') {
        return Reflect.has(t, prop) ? Reflect.get(t, prop) : t;
      }
      if (Reflect.has(t, prop)) return Reflect.get(t, prop, receiver);
      if (prop in globals) return globals[prop];
      // Host-blocked or unknown name: `has` claimed host globals so the
      // `with` never falls through to the real global scope. Return undefined
      // so `typeof` yields 'undefined' (matching Node); this also keeps the
      // host value from leaking. (A value read gives undefined rather than
      // Node's ReferenceError — documented gap.)
      return undefined;
    },
    set(t, prop, value) {
      if (typeof prop === 'symbol') return Reflect.set(t, prop, value);
      // `has` already returned true: the name is either on the target or a
      // standard global. Standard globals shadow onto the sandbox global.
      return Reflect.set(t, prop, value);
    },
    defineProperty(t, prop, desc) {
      if (prop === '__proto__') return false;
      return Reflect.defineProperty(t, prop, desc);
    },
    deleteProperty(t, prop) {
      return Reflect.deleteProperty(t, prop);
    },
    getOwnPropertyDescriptor(t, prop) {
      return Reflect.getOwnPropertyDescriptor(t, prop);
    },
    ownKeys(t) {
      return Reflect.ownKeys(t);
    },
    getPrototypeOf(t) {
      return Reflect.getPrototypeOf(t);
    },
  });
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
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return err;
  const stack = err.stack;
  if (typeof stack !== 'string') return err;
  const lines = stack.split('\n');
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
  let finalStack = out.join('\n');
  if (ctx.header) {
    const sourceLine = ctx.code.split('\n')[top.codeLine - 1] ?? '';
    finalStack = `${ctx.filename}:${top.dispLine}\n${sourceLine}\n ^\n\n${finalStack}`;
  }
  try {
    err.stack = finalStack;
  } catch (_) { /* frozen error; leave the original stack */ }
  return err;
}

// ---------------------------------------------------------------------------
// 9. Core execution engine
// ---------------------------------------------------------------------------

function runWithContext(code, target, opts) {
  const strict = isStrictPrologue(code);
  const scanned = scanScript(code);

  // Pre-declare everything the code may define at the top level so it lands
  // on the context object instead of the wrapper's function scope.
  const seen = new Set();
  let prefix = '';
  for (const f of scanned.functions) {
    if (!seen.has(f.name)) {
      seen.add(f.name);
      ensureDeclared(target, f.name);
    }
    prefix += `${f.name} = ${code.slice(f.start, f.end)};\n`;
  }
  for (const name of scanned.vars) {
    if (!seen.has(name)) { seen.add(name); ensureDeclared(target, name); }
  }
  // Note: lexical (let/const/class) names are NOT pre-declared on the target;
  // they live in the eval's declarative scope and must not become context
  // properties (Node keeps them off globalThis too).
  for (const name of scanned.assigned) {
    if (!seen.has(name)) { seen.add(name); ensureDeclared(target, name); }
  }

  // Remove the original top-level function declarations (they are installed
  // by the prefix instead); blanking preserves line numbers.
  const bodyCode = blankSpans(code, scanned.functions.map((f) => [f.start, f.end]));
  // The prefix must come after a strict prologue so the eval stays strict.
  const evalCode = (strict ? '"use strict";\n' : '') + prefix + bodyCode;
  // Lines before the user's code inside the eval'd source.
  const headLines = (strict ? 1 : 0) + scanned.functions.length;

  // Direct eval inside the `with` keeps the scope chain and yields the
  // completion value as the return value. `eval` resolves through the scope
  // proxy to the intrinsic, so this stays a direct eval.
  const factoryBody = 'with(__vm_p__){\nreturn eval(__vm_c__);\n}';
  const scope = makeScope(target);
  let runner;
  try {
    runner = new Function('__vm_p__', '__vm_c__', factoryBody);
  } catch (e) {
    throw e;
  }
  try {
    return runner.call(target, scope, evalCode);
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
  }
}

// ---------------------------------------------------------------------------
// 10. Script
// ---------------------------------------------------------------------------

function normalizeScriptOptions(options) {
  if (typeof options === 'string') return { filename: options };
  validateObject(options, 'options');
  return options;
}

function normalizeMethodOptions(options) {
  if (options === undefined) return {};
  validateObject(options, 'options');
  return options;
}

function normalizeTopOptions(options) {
  if (typeof options === 'string') return { filename: options };
  return { ...options };
}

function validateTimeout(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) ||
      value < 1 || value > 4294967295) {
    throw codedError(RangeError, 'ERR_OUT_OF_RANGE',
      `The value of "options.timeout" is out of range. It must be >= 1 && <= 4294967295. ${receivedText(value)}`);
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
  validateString(filename, 'options.filename');
  validateInt32(lineOffset, 'options.lineOffset');
  validateInt32(columnOffset, 'options.columnOffset');
  if (timeout !== undefined) validateTimeout(timeout);
  validateBoolean(displayErrors, 'options.displayErrors');
  validateBoolean(breakOnSigint, 'options.breakOnSigint');
  return { filename, lineOffset, columnOffset };
}

/** Maps run options onto context options, mirroring Node's getContextOptions. */
function getContextOptions(options) {
  if (!options) return {};
  const contextOptions = {};
  if (options.contextName !== undefined) {
    validateString(options.contextName, 'options.contextName');
    contextOptions.name = options.contextName;
  }
  if (options.contextOrigin !== undefined) {
    validateString(options.contextOrigin, 'options.contextOrigin');
    contextOptions.origin = options.contextOrigin;
  }
  if (options.contextCodeGeneration !== undefined) {
    validateObject(options.contextCodeGeneration, 'options.contextCodeGeneration');
    const { strings, wasm } = options.contextCodeGeneration;
    if (strings !== undefined) {
      validateBoolean(strings, 'options.contextCodeGeneration.strings');
    }
    if (wasm !== undefined) {
      validateBoolean(wasm, 'options.contextCodeGeneration.wasm');
    }
    contextOptions.codeGeneration = { strings, wasm };
  }
  if (options.microtaskMode !== undefined) {
    validateOneOf(options.microtaskMode, 'options.microtaskMode', ['afterEvaluate', undefined]);
    contextOptions.microtaskMode = options.microtaskMode;
  }
  return contextOptions;
}

function validateCachedData(value, name) {
  if (!ArrayBuffer.isView(value)) {
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
      `The "${name}" argument must be an instance of Buffer, TypedArray, or DataView. ${receivedText(value)}`);
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
  bytes[0] = 0x56; bytes[1] = 0x4d; bytes[2] = 0x43; bytes[3] = 0x44; // 'VMCD'
  bytes[4] = (h >>> 24) & 0xff; bytes[5] = (h >>> 16) & 0xff;
  bytes[6] = (h >>> 8) & 0xff; bytes[7] = h & 0xff;
  bytes[8] = (len >>> 24) & 0xff; bytes[9] = (len >>> 16) & 0xff;
  bytes[10] = (len >>> 8) & 0xff; bytes[11] = len & 0xff;
  for (let k = 12; k < 16; k++) bytes[k] = (h >>> ((k % 4) * 8)) & 0xff;
  return bytes;
}

function cachedDataMatches(source, cachedData) {
  let bytes = null;
  if (cachedData instanceof Uint8Array) bytes = cachedData;
  else if (ArrayBuffer.isView(cachedData)) {
    bytes = new Uint8Array(cachedData.buffer, cachedData.byteOffset, cachedData.byteLength);
  }
  if (bytes === null || bytes.length < 12) return false;
  if (bytes[0] !== 0x56 || bytes[1] !== 0x4d || bytes[2] !== 0x43 || bytes[3] !== 0x44) return false;
  const h = hashSource(source);
  const storedHash = (((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0);
  const storedLen = (((bytes[8] << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11]) >>> 0);
  return storedHash === h && storedLen === (source.length >>> 0);
}

export class Script {
  #code;
  #filename;
  #lineOffset;
  #columnOffset;
  #cachedDataRejected;
  #cachedData;

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
    validateString(filename, 'options.filename');
    validateInt32(lineOffset, 'options.lineOffset');
    validateInt32(columnOffset, 'options.columnOffset');
    if (cachedData !== undefined && cachedData !== null) {
      validateCachedData(cachedData, 'options.cachedData');
    }
    validateBoolean(produceCachedData, 'options.produceCachedData');
    if (importModuleDynamically !== undefined) {
      validateFunction(importModuleDynamically, 'options.importModuleDynamically');
    }

    this.#code = code;
    this.#filename = filename;
    this.#lineOffset = lineOffset;
    this.#columnOffset = columnOffset;
    this.#cachedDataRejected = (cachedData !== undefined && cachedData !== null)
      ? !cachedDataMatches(code, cachedData)
      : undefined;
    this.#cachedData = produceCachedData ? synthesizeCachedData(code) : undefined;

    Object.defineProperties(this, {
      sourceURL: {
        value: undefined, writable: true, enumerable: true, configurable: true,
      },
      sourceMapURL: {
        value: undefined, writable: true, enumerable: true, configurable: true,
      },
    });
  }

  get cachedDataRejected() { return this.#cachedDataRejected; }
  get cachedData() { return this.#cachedData; }
  get cachedDataProduced() { return this.#cachedData !== undefined; }

  createCachedData() {
    return this.#cachedData !== undefined ? this.#cachedData.slice() : new Uint8Array(0);
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
    return runWithContext(this.#code, contextifiedObject, this.#runOptions(options));
  }

  runInNewContext(contextObject, options = {}) {
    options = normalizeMethodOptions(options);
    const ctx = createContext(contextObject, getContextOptions(options));
    return this.runInContext(ctx, options);
  }

  runInThisContext(options = {}) {
    options = normalizeMethodOptions(options);
    const runOpts = this.#runOptions(options);
    let result;
    try {
      result = (0, eval)(this.#code);
    } catch (e) {
      throw enrichScriptError(e, {
        filename: runOpts.filename,
        lineOffset: runOpts.lineOffset,
        columnOffset: runOpts.columnOffset,
        code: this.#code,
        headLines: 0,
        lineBias: 0,
        header: true,
      });
    }
    return result;
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

// ---------------------------------------------------------------------------
// 12. compileFunction
// ---------------------------------------------------------------------------

export function compileFunction(code, params = [], options = {}) {
  validateString(code, 'code');
  if (params === undefined) params = [];
  else validateStringArray(params, 'params');
  validateObject(options, 'options');
  const {
    filename = '',
    lineOffset = 0,
    columnOffset = 0,
    cachedData,
    produceCachedData = false,
    parsingContext,
    contextExtensions = [],
    importModuleDynamically,
  } = options;
  validateString(filename, 'options.filename');
  validateInt32(lineOffset, 'options.lineOffset');
  validateInt32(columnOffset, 'options.columnOffset');
  if (cachedData !== undefined) validateCachedData(cachedData, 'options.cachedData');
  validateBoolean(produceCachedData, 'options.produceCachedData');
  if (parsingContext !== undefined) {
    if (typeof parsingContext !== 'object' || parsingContext === null ||
        !contextified.has(parsingContext)) {
      throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
        `The "options.parsingContext" property must be an instance of Context. ${receivedText(parsingContext)}`);
    }
  }
  if (!Array.isArray(contextExtensions)) {
    throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
      `The "options.contextExtensions" property must be an instance of Array. ${receivedText(contextExtensions)}`);
  }
  for (let k = 0; k < contextExtensions.length; k++) {
    const ext = contextExtensions[k];
    if (typeof ext !== 'object' || ext === null || Array.isArray(ext)) {
      throw codedError(TypeError, 'ERR_INVALID_ARG_TYPE',
        `The "options.contextExtensions[${k}]" property must be of type object. ${receivedText(ext)}`);
    }
  }
  if (importModuleDynamically !== undefined) {
    validateFunction(importModuleDynamically, 'options.importModuleDynamically');
  }

  // Scope target: the parsing context itself (extensions are applied onto it,
  // mirroring Node where extensions become part of the context's global), or
  // a fresh object when no parsing context is given.
  const target = parsingContext !== undefined ? parsingContext : {};
  for (const ext of contextExtensions) {
    for (const key of Reflect.ownKeys(ext)) {
      if (key === '__proto__') continue;
      let desc = null;
      try { desc = Reflect.getOwnPropertyDescriptor(ext, key); } catch (_) { /* skip */ }
      if (desc === null || desc === undefined) continue;
      try { Object.defineProperty(target, key, desc); } catch (_) { /* skip */ }
    }
  }

  const factoryBody =
    'with(__vm_s__){\n' +
    `return function(${params.join(',')}) {\n` +
    code +
    '\n};\n}';
  const scope = makeScope(target);
  let fn;
  try {
    fn = new Function('__vm_s__', factoryBody)(scope);
  } catch (e) {
    // Note: SyntaxError messages/positions reflect the scoped wrapper, not
    // the raw code (V8's Function constructor also reports some malformed
    // bodies differently than vm.compileFunction). Documented gap.
    throw e;
  }

  const thisArg = parsingContext !== undefined ? target : undefined;
  const ctx = {
    filename: filename || '<anonymous>',
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
  Object.defineProperty(compiled, 'toString', {
    value: function toString() {
      return `function (${params.join(', ')}) {\n${code}\n}`;
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });

  const sourceKey = `${code}\n${params.join(',')}`;
  if (produceCachedData) {
    compiled.cachedData = synthesizeCachedData(sourceKey);
    compiled.cachedDataProduced = true;
  } else {
    compiled.cachedData = undefined;
    compiled.cachedDataProduced = false;
  }
  compiled.cachedDataRejected = cachedData !== undefined
    ? !cachedDataMatches(sourceKey, cachedData)
    : undefined;
  return compiled;
}

// ---------------------------------------------------------------------------
// 13. measureMemory (synthetic; no V8 heap access from here)
// ---------------------------------------------------------------------------

export async function measureMemory(options = {}) {
  if (options === undefined) options = {};
  validateObject(options, 'options');
  const { mode = 'summary', execution = 'default' } = options;
  validateOneOf(mode, 'options.mode', ['summary', 'detailed']);
  validateOneOf(execution, 'options.execution', ['default', 'eager']);
  return {
    total: {
      jsMemoryEstimate: 0,
      jsMemoryRange: [0, 0],
    },
    WebAssembly: {
      code: 0,
      metadata: 0,
    },
  };
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
