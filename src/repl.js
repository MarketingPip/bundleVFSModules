/*!
 * src/repl.js — node:repl for the browser runtime.
 *
 * Faithful port of Node.js v24.20.0 lib/repl.js to dependency-free ESM.
 * Runs inside Jared's sandboxed browser iframe (via dist/vfs.js) and under
 * real Node (parity lane). See docs/RUNTIME.md and docs/SHIM_AUTHORING.md.
 *
 * How evaluation works here:
 * - The default eval compiles with the project's vm port (src/vm.js), which
 *   executes code through `new Function` + direct `eval` inside a `with`
 *   scope. The sandbox CSP allows 'unsafe-eval', so this genuinely runs in
 *   the target runtime.
 * - Isolation is WEAKER than Node's vm contexts: code runs in the host realm
 *   (no separate V8 context, no memory/CPU limits, `process`/`fetch` etc.
 *   remain reachable unless the embedder removes them). Documented honestly;
 *   do not rely on it as a security boundary.
 * - `useGlobal: true` evaluates directly on globalThis (like Node).
 * - Top-level `let`/`const` are rewritten to `var` for the sandboxed context
 *   so bindings persist across evals (our vm port gives each eval a fresh
 *   declarative scope; Node's vm contexts keep one persistent lexical scope).
 *   Redeclaration and const-reassignment semantics differ slightly — see
 *   the honest-gaps list in the PR.
 *
 * Gaps vs Node (all deliberate, none throw):
 * - No inspector integration (no `sendInspectorCommand`; preview off).
 * - `.save`/`.load` use the runtime VFS (`_RUNTIME_.__FS__`); without it they
 *   report failure instead of touching a real filesystem.
 * - `breakEvalOnSigint` is accepted but inert (no SIGINT watchdog in browser).
 * - `require`/`module` are NOT injected into the sandboxed context: CJS
 *   resolution from a browser iframe cannot match Node semantics.
 * - Top-level await: single-expression and trailing-expression forms are
 *   awaited; exotic declaration hoisting inside awaited blocks is best-effort.
 */

import { Interface } from './readline.js';
import * as vm from './vm.js';
import * as util from './util.js';
import { Console } from './console.js';

// ---------------------------------------------------------------------------
// Minimal `_domain` facade (Node parity surface only).
//
// We deliberately do NOT import the project's domain module here: it patches
// process/EventEmitter globals at load time, which is an unacceptable side
// effect for the REPL. The REPL only needs sync-throw capture (`bind`) and
// an 'error' channel (`on`/`emit`).
// ---------------------------------------------------------------------------

function createReplDomain() {
  const listeners = Object.create(null);
  const domain = {
    on(ev, fn) {
      (listeners[ev] ||= []).push(fn);
      return domain;
    },
    once(ev, fn) {
      const wrap = (...a) => { domain.off(ev, wrap); fn(...a); };
      return domain.on(ev, wrap);
    },
    off(ev, fn) {
      if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== fn);
      return domain;
    },
    emit(ev, ...args) {
      for (const fn of (listeners[ev] || []).slice()) fn(...args);
      return true;
    },
    bind(fn) {
      return function bound(...args) {
        try {
          return fn.apply(this, args);
        } catch (err) {
          domain.emit('error', err);
        }
      };
    },
    // Domain API surface used nowhere by the REPL, present for shape parity.
    enter() {},
    exit() {},
    add() {},
    remove() {},
    run(fn, ...args) { return domain.bind(fn)(...args); },
  };
  return domain;
}

// ---------------------------------------------------------------------------
// Runtime bridge (guarded: rewritten to the sandbox scope at load time,
// undefined under real Node / direct import).
// ---------------------------------------------------------------------------

function getRuntime() {
  return (typeof globalThis._RUNTIME_ !== 'undefined')
    ? globalThis._RUNTIME_
    : undefined;
}

function getProcess() {
  // `typeof` guard: `process` may not exist as a bare global (bare browser).
  return (typeof process !== 'undefined') ? process : undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REPL_MODE_SLOPPY = Symbol('repl.sloppy');
export const REPL_MODE_STRICT = Symbol('repl.strict');

const kBufferedCommand = Symbol('bufferedCommand');
const kLoading = Symbol('loading');
const kEvalActive = Symbol('evalActive'); // true while inside domain-bound eval
const kAwaitQueue = Symbol('awaitQueue'); // lines queued while awaiting TLA
const kContextId = Symbol('contextId'); // inspector stub — no-op
const kTLALexical = Symbol('tlaLexical'); // let/const names hoisted by the TLA transform

const kMultilinePrompt = '| ';

// ---------------------------------------------------------------------------
// NullStream — satisfies the readline input/output contract when no streams
// are available (bare browser without the runtime terminal).
// ---------------------------------------------------------------------------

class NullStream {
  constructor() {
    this._ev = Object.create(null);
    this.isTTY = false;
    this.readable = true;
    this.writable = true;
  }
  write() { return true; }
  read() { return null; }
  resume() { return this; }
  pause() { return this; }
  setEncoding() { return this; }
  setRawMode() { return this; }
  pipe(d) { return d; }
  unpipe() { return this; }
  on(ev, fn) { (this._ev[ev] ||= []).push(fn); return this; }
  once(ev, fn) { const w = (...a) => { this.off(ev, w); fn(...a); }; return this.on(ev, w); }
  off(ev, fn) { if (this._ev[ev]) this._ev[ev] = this._ev[ev].filter((f) => f !== fn); return this; }
  removeListener(ev, fn) { return this.off(ev, fn); }
  removeAllListeners(ev) {
    if (ev) delete this._ev[ev]; else this._ev = Object.create(null); return this;
  }
  emit(ev, ...a) { for (const fn of (this._ev[ev] || [])) fn(...a); return true; }
}

// ---------------------------------------------------------------------------
// Recoverable — wraps a SyntaxError to signal the REPL should buffer the
// line and prompt for more input.
// ---------------------------------------------------------------------------

export class Recoverable extends SyntaxError {
  constructor(err) {
    super();
    this.err = err;
  }
}

// ---------------------------------------------------------------------------
// Default writer
// ---------------------------------------------------------------------------

const writer = (obj) => util.inspect(obj, writer.options);
writer.options = { ...util.inspect.defaultOptions, showProxy: true };

// ---------------------------------------------------------------------------
// Deprecation helper (warn-once, like Node's internal deprecate)
// ---------------------------------------------------------------------------

const warnedDeprecations = new Set();
function emitDeprecation(code, message) {
  if (warnedDeprecations.has(code)) return;
  warnedDeprecations.add(code);
  const proc = getProcess();
  if (proc && typeof proc.emitWarning === 'function') {
    proc.emitWarning(message, { type: 'DeprecationWarning', code });
  }
}

// The list Node exposes as the deprecated `repl.builtinModules`.
const replBuiltinLibs = [
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'https',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys',
  'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
];

// ---------------------------------------------------------------------------
// Syntax helpers (mirrors Node's internal/repl/utils, V8-flavoured)
// ---------------------------------------------------------------------------

export function isValidSyntax(input) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(input);
    return true;
  } catch { /* fall through */ }
  try {
    // Expression position: `_ = <input>`.
    // eslint-disable-next-line no-new-func
    new Function(`_=(${input})`);
    return true;
  } catch {
    return false;
  }
}

const startsWithBrace = /^\s*\{/;
const endsWithSemicolon = /;\s*$/;
function isObjectLiteral(code) {
  return startsWithBrace.test(code) && !endsWithSemicolon.test(code);
}

// Recoverability: like Node's acorn-based check, but with a dependency-free
// lexer. Input is recoverable when the parse error is at EOF — signalled by
// V8's "unexpected end of input"/"unterminated" messages, or by unclosed
// brackets / unterminated strings/comments/templates at the end of input.
const RECOVERABLE_MESSAGE = /unexpected end of input|unterminated/i;
function isRecoverableError(err, code) {
  if (!(err instanceof SyntaxError)) return false;
  if (RECOVERABLE_MESSAGE.test(err.message)) return true;
  if (!code) return false;
  const scan = scanTopLevel(code);
  return scan.unterminated || scan.unclosed;
}

// Converts a static import statement to its dynamic-import suggestion for
// the "Cannot use import statement" error message.
function toDynamicImport(line) {
  if (!line) return '';
  const m = line.match(/^\s*import\s+(\S+)\s+from\s+(["'`][^"'`]+["'`])/);
  if (m) return `const ${m[1]} = await import(${m[2]});`;
  const m2 = line.match(/^\s*import\s+(["'`][^"'`]+["'`])/);
  if (m2) return `await import(${m2[1]});`;
  return `await import(/* ${line.trim()} */);`;
}

const HAS_AWAIT = /(?:^|[^.\w$])await[\s(]/;
const HAS_FOR_AWAIT = /for\s+await\s*\(/;

// ---------------------------------------------------------------------------
// Top-level statement scanner.
//
// Finds top-level `let`/`const` declaration keywords (so they can be rewritten
// to `var` — our vm port gives each eval a fresh declarative scope, while
// Node's vm contexts keep one persistent lexical scope) and records statement
// boundaries for the top-level-await transform.
// ---------------------------------------------------------------------------

// Keywords that can never start a bare expression statement (used by the
// top-level-await transform to find a trailing printable expression).
const TLA_NON_EXPRESSION_START = new Set([
  'let', 'const', 'var', 'function', 'class', 'if', 'for', 'while',
  'do', 'switch', 'try', 'catch', 'finally', 'return', 'throw', 'break',
  'continue', 'debugger', 'import', 'export', 'default', 'extends',
]);

function isBareExpressionStart(stmt, src) {
  const { firstWord } = stmt;
  if (TLA_NON_EXPRESSION_START.has(firstWord)) return false;
  if (firstWord === 'async') {
    // `async function f() {}` is a declaration; `async () => {}` is an expr.
    const text = src.slice(stmt.start, stmt.start + 64);
    if (/^\s*async\s+function\b/.test(text)) return false;
  }
  return true;
}

const DECL_KEYWORDS = new Set(['let', 'const', 'var']);

function isIdStart(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
}
function isIdChar(c) {
  return isIdStart(c) || (c >= '0' && c <= '9');
}

// Returns { decls: [{start, end, kind, names}], statements: [{start, firstWord}] }
// for top-level (brace/paren/bracket depth 0) declarations/statements.
// Bound names of a destructuring pattern (or a single identifier).
// Handles nested object/array patterns, defaults, rest elements, renames
// (`{a: b}`), string keys, and computed keys (`{[k]: v}` — `k` is an
// expression, not a binding). Best-effort scanner, not a full parser.
function patternBoundNames(pattern) {
  const names = [];
  const n = pattern.length;
  let i = 0;
  const stack = []; // 'obj' | 'arr'
  const skipWs = () => { while (i < n && ' \t\n\r'.includes(pattern[i])) i++; };
  const skipString = () => {
    const q = pattern[i]; i++;
    while (i < n) {
      const ch = pattern[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === q) { i++; return; }
      i++;
    }
  };
  // Skip a balanced bracket segment starting at its opener.
  const skipBalanced = () => {
    const pairs = { '(': ')', '[': ']', '{': '}' };
    const closers = { ')': '(', ']': '[', '}': '{' };
    const st = [pattern[i]]; i++;
    while (i < n && st.length > 0) {
      const ch = pattern[i];
      if (ch === '"' || ch === "'" || ch === '`') { skipString(); continue; }
      if (ch === '\\') { i += 2; continue; }
      if (pairs[ch]) st.push(ch);
      else if (closers[ch] && st[st.length - 1] === closers[ch]) st.pop();
      i++;
    }
  };
  while (i < n) {
    skipWs();
    if (i >= n) break;
    const c = pattern[i];
    if (c === '"' || c === "'" || c === '`') { skipString(); continue; }
    if (c === '{') { stack.push('obj'); i++; continue; }
    if (c === '[') {
      // A `[` at key position inside an object pattern (`{` or `,` before
      // it) starts a computed key — an expression, not a binding pattern.
      let j = i - 1;
      while (j >= 0 && ' \t\n\r'.includes(pattern[j])) j--;
      const prev = pattern[j] || '';
      if (stack[stack.length - 1] === 'obj' && (prev === '{' || prev === ',')) {
        skipBalanced();
        skipWs();
        if (pattern[i] === ':') i++;
        continue;
      }
      stack.push('arr'); i++; continue;
    }
    if (c === '}' || c === ']') { stack.pop(); i++; continue; }
    if (c === '.' && pattern.startsWith('...', i)) { i += 3; continue; }
    if (isIdStart(c)) {
      let e = i + 1;
      while (e < n && isIdChar(pattern[e])) e++;
      const id = pattern.slice(i, e);
      i = e;
      skipWs();
      if (pattern[i] === ':') { i++; continue; } // property key; value follows
      names.push(id);
      skipWs();
      if (pattern[i] === '=') {
        // Default value: skip the expression (no bound names inside).
        i++;
        let depth = 0;
        while (i < n) {
          const ch = pattern[i];
          if (ch === '"' || ch === "'" || ch === '`') { skipString(); continue; }
          if (ch === '\\') { i += 2; continue; }
          if ('([{'.includes(ch)) depth++;
          else if (')]}'.includes(ch)) {
            if (depth === 0) break;
            depth--;
          } else if (ch === ',' && depth === 0) break;
          i++;
        }
      }
      continue;
    }
    i++;
  }
  return names;
}

// Parse `pattern (= init)? (, pattern (= init)?)*` starting at index k.
// Patterns are identifiers or balanced { } / [ ] segments. Returns
// { declarators: [{patternStart, patternEnd, initStart, initEnd}], end }
// with end just past the last declarator. Shared by scanTopLevel and the
// TLA for-head `var` handling.
function parseDeclarators(code, k) {
  const n = code.length;
  const declarators = [];
  let d = k;
  const skipWsD = () => {
    while (d < n && (code[d] === ' ' || code[d] === '\t' ||
                     code[d] === '\n' || code[d] === '\r')) d++;
  };
  const skipStringD = () => {
    const q = code[d]; d++;
    while (d < n) {
      if (code[d] === '\\') { d += 2; continue; }
      if (code[d] === q) { d++; break; }
      d++;
    }
  };
  const skipRegexD = () => {
    // Conservative: skip /.../ when the previous significant char cannot
    // end an expression.
    let p = d - 1;
    while (p >= 0 && ' \t\n\r'.includes(code[p])) p--;
    const pc = code[p] || '';
    if (!isIdChar(pc) && pc !== ')' && pc !== ']') {
      d++;
      let inClass = false;
      while (d < n) {
        const r = code[d];
        if (r === '\\') { d += 2; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) { d++; break; }
        else if (r === '\n') break;
        d++;
      }
      while (d < n && isIdChar(code[d])) d++;
      return true;
    }
    return false;
  };
  while (d < n) {
    skipWsD();
    if (d >= n) break;
    const pStart = d;
    let pEnd = d;
    const pc = code[d];
    if (isIdStart(pc)) {
      let e = d + 1;
      while (e < n && isIdChar(code[e])) e++;
      pEnd = e; d = e;
    } else if (pc === '{' || pc === '[') {
      const want = pc === '{' ? '}' : ']';
      let depth = 0; d++;
      while (d < n) {
        const ch = code[d];
        if (ch === '"' || ch === "'" || ch === '`') { skipStringD(); continue; }
        if (ch === '\\') { d += 2; continue; }
        if (ch === pc) depth++;
        else if (ch === want) {
          if (depth === 0) { d++; break; }
          depth--;
        }
        d++;
      }
      pEnd = d;
    } else break;
    skipWsD();
    let iStart = -1, iEnd = -1;
    if (code[d] === '=' && code[d + 1] !== '=' && code[d + 1] !== '>') {
      d++;
      iStart = d;
      let depth = 0;
      while (d < n) {
        const ch = code[d];
        if (ch === '"' || ch === "'" || ch === '`') { skipStringD(); continue; }
        if (ch === '\\') { d += 2; continue; }
        if (ch === '/' && code[d + 1] !== '/' && code[d + 1] !== '*') {
          if (skipRegexD()) continue;
        }
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        else if ((ch === ',' || ch === ';') && depth === 0) break;
        d++;
      }
      iEnd = d;
    }
    declarators.push({
      patternStart: pStart, patternEnd: pEnd,
      initStart: iStart, initEnd: iEnd,
    });
    skipWsD();
    if (code[d] === ',') { d++; continue; }
    break;
  }
  return { declarators, end: d };
}

// All bound names of a declarator list (simple + destructured).
function declaratorBoundNames(code, declarators) {
  const names = [];
  for (const dec of declarators) {
    names.push(...patternBoundNames(code.slice(dec.patternStart, dec.patternEnd)));
  }
  return names;
}

function scanTopLevel(code) {
  const decls = [];
  const statements = [];
  const n = code.length;
  let i = 0;
  let brace = 0, paren = 0, bracket = 0;
  let unterminated = false; // EOF inside a string/template/block comment
  let stmtStart = 0;      // index where the current top-level statement began
  let inStatement = false;

  const pushStatement = (end) => {
    if (!inStatement) return;
    const head = code.slice(stmtStart, Math.min(end, stmtStart + 64));
    const m = head.match(/^\s*([A-Za-z_$][\w$]*)/);
    statements.push({ start: stmtStart, firstWord: m ? m[1] : '' });
    inStatement = false;
  };

  while (i < n) {
    const c = code[i];

    // Whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' ||
        c === '\f' || c === ' ' || c === '﻿') {
      i++;
      continue;
    }
    // Comments
    if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      i += 2;
      let closed = false;
      while (i < n) {
        if (code[i] === '*' && code[i + 1] === '/') { closed = true; break; }
        i++;
      }
      if (closed) i += 2;
      else unterminated = true;
      continue;
    }
    // Track statement starts at top level BEFORE string/template/regex
    // skipping, so a statement beginning with a string, template literal,
    // or regex still counts (e.g. `` `a${await x}b` `` as a TLA expression).
    if (brace === 0 && paren === 0 && bracket === 0 &&
        !inStatement && c !== ';') {
      inStatement = true;
      stmtStart = i;
    }
    // Strings
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      let closed = false;
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === q) { i++; closed = true; break; }
        i++;
      }
      if (!closed) unterminated = true;
      continue;
    }
    // Template literals (with ${} nesting)
    if (c === '`') {
      let depth = 0;
      let closed = false;
      i++;
      while (i < n) {
        const t = code[i];
        if (t === '\\') { i += 2; continue; }
        if (t === '`' && depth === 0) { i++; closed = true; break; }
        if (t === '$' && code[i + 1] === '{') { depth++; i += 2; continue; }
        if (t === '}' && depth > 0) { depth--; i++; continue; }
        i++;
      }
      if (!closed) unterminated = true;
      continue;
    }
    // Regex vs division: conservative — skip /.../ when it looks like a regex
    // (previous significant char is not an identifier char, digit, ) or ]).
    if (c === '/' && code[i + 1] !== '/' && code[i + 1] !== '*') {
      let j = i - 1;
      while (j >= 0 && ' \t\n\r'.includes(code[j])) j--;
      const p = code[j] || '';
      if (!isIdChar(p) && p !== ')' && p !== ']') {
        i++;
        let inClass = false;
        while (i < n) {
          const r = code[i];
          if (r === '\\') { i += 2; continue; }
          if (r === '[') inClass = true;
          else if (r === ']') inClass = false;
          else if (r === '/' && !inClass) { i++; break; }
          else if (r === '\n') break;
          i++;
        }
        while (i < n && isIdChar(code[i])) i++; // flags
        continue;
      }
    }

    if (brace === 0 && paren === 0 && bracket === 0) {
      if (c === ';') {
        pushStatement(i);
        i++;
        continue;
      }
      // Declaration keywords at top level.
      if (isIdStart(c)) {
        let j = i;
        while (j < n && isIdChar(code[j])) j++;
        const word = code.slice(i, j);
        if ((word === 'let' || word === 'const' || word === 'var') &&
            (j >= n || !isIdChar(code[j]))) {
          // Exclude member access (`x.let`, `x.var[y]`): the previous
          // significant character must not be a dot.
          let p = i - 1;
          while (p >= 0 && ' \t\n\r'.includes(code[p])) p--;
          const notMemberAccess = code[p] !== '.';
          let k = j;
          while (k < n && (code[k] === ' ' || code[k] === '\t')) k++;
          const nk = code[k];
          const after = code[k + 1] || '';
          // `let`/`const` <name> | `{` | `[` → declaration. Exclude
          // `let.x`, `let[0]`, `let = 5`. (`var` is always a declaration.)
          const isDecl = notMemberAccess && (word === 'var' ||
            isIdStart(nk) || nk === '{' ||
            (nk === '[' && !(after >= '0' && after <= '9') && after !== '"' && after !== "'"));
          if (isDecl) {
            // Parse declarators: pattern (= init)? (, pattern (= init)?)*
            // (shared helper; also used for for-head `var` parsing).
            const { declarators } = parseDeclarators(code, k);
            // All bound names (simple identifiers + destructured).
            const names = declaratorBoundNames(code, declarators);
            const simple = declarators.length > 0 && declarators.every((dec) =>
              /^[A-Za-z_$][\w$]*$/.test(code.slice(dec.patternStart, dec.patternEnd)));
            decls.push({ start: i, end: j, kind: word, names, simple, declarators });
          }
        }
        i = j;
        continue;
      }
    }

    if (c === '{') brace++;
    else if (c === '}') { brace--; if (brace === 0 && paren === 0 && bracket === 0) pushStatement(i + 1); }
    else if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    i++;
  }
  pushStatement(n);
  return {
    decls,
    statements,
    // Unclosed brackets at EOF usually mean "more input coming".
    unclosed: brace > 0 || paren > 0 || bracket > 0,
    unterminated,
  };
}

// ---------------------------------------------------------------------------
// Persistify: rewrite top-level `let`/`const` to `var` for the sandboxed
// context so bindings survive across evals (our vm port re-creates the
// declarative scope per eval). Column-preserving: `let`→`var` (same length),
// `const`→`var  ` (padded).
// ---------------------------------------------------------------------------

function persistify(code, scan) {
  let out = code;
  // Apply from the end so earlier spans stay valid.
  const decls = [...scan.decls].sort((a, b) => b.start - a.start);
  for (const d of decls) {
    if (d.kind === 'let') out = out.slice(0, d.start) + 'var' + out.slice(d.end);
    else if (d.kind === 'const') out = out.slice(0, d.start) + 'var  ' + out.slice(d.end);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Top-level await transform (mirrors lib/internal/repl/await.js).
//
// Returns { code, extractsValue } | null (no transform) .
// Throws Recoverable for unterminated input, SyntaxError for hard errors.
// ---------------------------------------------------------------------------

// Finds `function name(` / `async function name(` / `function* name(` at
// statement positions, at any depth (mirrors Node's TLA visitor, which
// rewrites every FunctionDeclaration so the binding persists via
// `this.name = name`). A `function` keyword starts a declaration iff the
// previous significant token is start-of-input, `;`, `{` or `}`.
function findFunctionDeclarations(code) {
  const out = [];
  const n = code.length;
  let i = 0;
  let prev = ''; // '' | ';' | '{' | '}' | 'other'
  const skipWsComments = () => {
    while (i < n) {
      const c = code[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f') { i++; continue; }
      if (c === '/' && code[i + 1] === '/') {
        i += 2;
        while (i < n && code[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && code[i + 1] === '*') {
        i += 2;
        while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      break;
    }
  };
  const skipString = () => {
    const q = code[i]; i++;
    while (i < n) {
      if (code[i] === '\\') { i += 2; continue; }
      if (code[i] === q) { i++; return; }
      // (templates with ${} are skipped whole; a declaration cannot hide
      // inside an expression hole)
      i++;
    }
  };
  const atStmtPos = () => prev === '' || prev === ';' || prev === '{' || prev === '}';
  while (i < n) {
    skipWsComments();
    if (i >= n) break;
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') { skipString(); prev = 'other'; continue; }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdChar(code[j])) j++;
      const word = code.slice(i, j);
      if ((word === 'function' || word === 'async') && atStmtPos() &&
          (j >= n || !isIdChar(code[j]))) {
        let k = j;
        if (word === 'async') {
          let kk = k;
          while (kk < n && ' \t\n\r'.includes(code[kk])) kk++;
          if (!(code.startsWith('function', kk) && !isIdChar(code[kk + 8] || ''))) {
            prev = 'other'; i = j; continue;
          }
          k = kk + 8;
        }
        let kk = k;
        while (kk < n && ' \t\n\r'.includes(code[kk])) kk++;
        if (code[kk] === '*') {
          kk++;
          while (kk < n && ' \t\n\r'.includes(code[kk])) kk++;
        }
        if (isIdStart(code[kk] || '')) {
          let e = kk + 1;
          while (e < n && isIdChar(code[e])) e++;
          out.push({ name: code.slice(kk, e), start: i });
        }
      }
      prev = 'other'; i = j; continue;
    }
    if (c === ';' || c === '{' || c === '}') prev = c;
    else if (!' \t\n\r\v\f'.includes(c)) prev = 'other';
    i++;
  }
  return out;
}

// Top-level `class Name` declarations (statement position). Returns
// [{name, start}] with start at the `class` keyword.
function findClassDeclarations(src) {
  const out = [];
  const scan = scanTopLevel(src);
  const stmts = scan.statements;
  for (let si = 0; si < stmts.length; si++) {
    const s = stmts[si];
    if (s.firstWord !== 'class') continue;
    const nextStart = si + 1 < stmts.length ? stmts[si + 1].start : src.length;
    const head = src.slice(s.start, Math.min(nextStart, s.start + 128));
    const m = /^\s*class\s+([A-Za-z_$][\w$]*)/.exec(head);
    if (m) out.push({ name: m[1], start: s.start + m[0].indexOf('class') });
  }
  return out;
}

// Top-level `for` heads declaring `var`: `for (var i = 0;;)`,
// `for (var x of y)`. Returns [{kwStart, kwEnd, declarators, forOf}] with
// absolute indices. (`let`/`const` heads are block-scoped; Node leaves them.)
function findForHeadVars(src) {
  const out = [];
  const scan = scanTopLevel(src);
  const stmts = scan.statements;
  for (let si = 0; si < stmts.length; si++) {
    const s = stmts[si];
    if (s.firstWord !== 'for') continue;
    const nextStart = si + 1 < stmts.length ? stmts[si + 1].start : src.length;
    let h = s.start + 3;
    while (h < nextStart && ' \t\n\r'.includes(src[h])) h++;
    if (src[h] !== '(') continue; // `for await (` — no var to hoist
    // Find the matching ')', skipping strings/templates.
    let depth = 0, headEnd = -1, q = h;
    while (q < nextStart) {
      const c = src[q];
      if (c === '"' || c === "'" || c === '`') {
        const qq = c; q++;
        while (q < nextStart) {
          if (src[q] === '\\') { q += 2; continue; }
          if (src[q] === qq) { q++; break; }
          q++;
        }
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { headEnd = q; break; } }
      q++;
    }
    if (headEnd < 0) continue;
    // Find a `var` keyword at head depth 0.
    let d0 = 0, vPos = -1, r = h + 1;
    while (r < headEnd) {
      const c = src[r];
      if (c === '"' || c === "'" || c === '`') {
        const qq = c; r++;
        while (r < headEnd) {
          if (src[r] === '\\') { r += 2; continue; }
          if (src[r] === qq) { r++; break; }
          r++;
        }
        continue;
      }
      if (c === '(' || c === '[' || c === '{') d0++;
      else if (c === ')' || c === ']' || c === '}') d0--;
      else if (d0 === 0 && isIdStart(c)) {
        let e = r + 1;
        while (e < headEnd && isIdChar(src[e])) e++;
        if (src.slice(r, e) === 'var' && !isIdChar(src[e] || '')) { vPos = r; break; }
        r = e;
        continue;
      }
      r++;
    }
    if (vPos < 0) continue;
    const { declarators, end } = parseDeclarators(src, vPos + 3);
    if (declarators.length === 0) continue;
    let w = end;
    while (w < headEnd && ' \t\n\r'.includes(src[w])) w++;
    let we = w;
    while (we < headEnd && isIdChar(src[we])) we++;
    const after = src.slice(w, we);
    out.push({
      kwStart: vPos, kwEnd: vPos + 3,
      declarators, forOf: after === 'of' || after === 'in',
    });
  }
  return out;
}

// Top-level await transform, mirroring Node's lib/internal/repl/await.js
// (which uses acorn; we use our scanner instead):
//   - function declarations (any depth): prepend `this.name = name;`,
//     hoist `var name;`  → the binding persists across evals.
//   - top-level class declarations: `Name=class Name`, hoist `Name`.
//   - top-level let/const/var + top-level for-head `var`: rewrite the
//     declaration as `void (...)` assignments, hoist the bound names as
//     `var` (the vm port needs `var` for cross-eval persistence; the
//     "already been declared" error for let/const is enforced separately).
//   - a trailing expression statement becomes `return { value: (...) }`
//     so the awaited value prints without double-unwrapping thenables.
// For the sandboxed context the hoisted names use `var` (the vm port only
// pre-declares `var` on the context object); the redeclare error for
// let/const is enforced by the caller via kTLALexical.
function processTopLevelAwait(src, { forSandbox }) {
  const wrapPrefix = '(async () => { ';
  const wrapped = `${wrapPrefix}${src} })()`;
  try {
    // eslint-disable-next-line no-new-func
    new Function(wrapped); // parse check only
  } catch (e) {
    if (/unterminated/i.test(e.message)) throw new Recoverable(e);
    // A syntax error here is a syntax error in src (the wrapper only adds
    // `async`, which makes `await` legal so the real error surfaces).
    // Throw so the caller reports this instead of a misleading
    // `new Function` error.
    throw e;
  }

  if (!HAS_AWAIT.test(src) && !HAS_FOR_AWAIT.test(src)) return null;

  const scan = scanTopLevel(src);
  // Like Node's containsReturn: a top-level `return` disables the transform.
  if (scan.statements.some((s) => s.firstWord === 'return')) return null;
  // Whether the last statement is an expression statement (decided on the
  // ORIGINAL source: declarations complete to undefined in Node).
  const stmts0 = scan.statements.filter((s) => src.slice(s.start).trim().length > 0);
  const last0 = stmts0[stmts0.length - 1];
  const lastIsExpression = !!last0 && isBareExpressionStart(last0, src);

  const hoisted = [];
  const edits = [];
  // NB: always hoist as `var`, even for let/const/class. The vm port's
  // runInThisContext is an indirect eval, and under Node ESM a global
  // lexical `let` does not survive across separate evals (only `var`
  // properties on globalThis do). The "already been declared" error for
  // TLA let/const is enforced by the caller via kTLALexical.

  // Rewrite one variable declaration (top-level or for-head `var`).
  const rewriteVarDecl = (d, { forHead = false, forOf = false } = {}) => {
    const names = declaratorBoundNames(src, d.declarators);
    if (names.length === 0) return;
    hoisted.push(`var ${names.join(', ')}; `);
    if (forHead && forOf) {
      // `for (var x of y)` → `for (x of y)` (drop `var ` incl. the space).
      edits.push({ start: d.kwStart, end: d.kwEnd + 1, text: '' });
      return;
    }
    const multi = d.declarators.length > 1;
    edits.push({
      start: d.kwStart, end: d.kwEnd,
      text: 'void' + (multi ? ' (' : ''),
    });
    d.declarators.forEach((dec, idx) => {
      const pat = src.slice(dec.patternStart, dec.patternEnd);
      const init = dec.initStart >= 0
        ? src.slice(dec.initStart, dec.initEnd).replace(/\s+$/, '')
        : null;
      let text = `(${pat}${init === null ? '=undefined' : ` = ${init}`})`;
      if (multi && idx === d.declarators.length - 1) text += ')';
      edits.push({
        start: dec.patternStart,
        end: dec.initEnd >= 0 ? dec.initEnd : dec.patternEnd,
        text,
      });
    });
  };

  // Function declarations (any depth): `this.name = name;` + `var name;`.
  // `this` is the context global (vm) or the sandbox target (our vm port
  // calls the runner with the target as `this`, and arrows inherit it).
  for (const fn of findFunctionDeclarations(src)) {
    hoisted.push(`var ${fn.name}; `);
    edits.push({ start: fn.start, end: fn.start, text: `this.${fn.name} = ${fn.name}; ` });
  }

  // Top-level class declarations: `Name=class Name` + hoisted `Name`.
  for (const cls of findClassDeclarations(src)) {
    hoisted.push(`var ${cls.name}; `);
    edits.push({ start: cls.start, end: cls.start, text: `${cls.name}=` });
  }

  // Top-level let/const/var declarations.
  for (const d of scan.decls) {
    rewriteVarDecl({ kind: d.kind, kwStart: d.start, kwEnd: d.end, declarators: d.declarators });
  }

  // Top-level for-head `var` declarations.
  for (const fh of findForHeadVars(src)) {
    rewriteVarDecl({ kind: 'var', ...fh }, { forHead: true, forOf: fh.forOf });
  }

  // Apply edits from the end so earlier spans stay valid.
  let body = src;
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    body = body.slice(0, e.start) + e.text + body.slice(e.end);
  }

  // Trailing expression statement → `return { value: (...) };`.
  let extractsValue = false;
  if (lastIsExpression) {
    const stmts = scanTopLevel(body).statements
      .filter((s) => body.slice(s.start).trim().length > 0);
    const last = stmts[stmts.length - 1];
    if (last) {
      const stmtText = body.slice(last.start).replace(/;?\s*$/, '');
      body = body.slice(0, last.start) + 'return { value: (' + stmtText + ') };';
      extractsValue = true;
    }
  }

  // Persistify any surviving non-top-level let/const for the sandbox.
  const inner = forSandbox ? persistify(body, scanTopLevel(body)) : body;

  const code = [...new Set(hoisted)].join('') + `${wrapPrefix}${inner} })()`;

  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
  } catch (e) {
    if (/unterminated/i.test(e.message)) throw new Recoverable(e);
    return null;
  }
  return { code, extractsValue };
}

function tryParse(code) {
  // eslint-disable-next-line no-new-func
  new Function(code);
}

// ---------------------------------------------------------------------------
// Default eval — mirrors Node's repl.js defaultEval.
// ---------------------------------------------------------------------------

function getREPLResourceName() {
  return 'repl';
}

function defaultEval(code, context, file, cb) {
  const self = this;
  const { replMode, useGlobal } = self;
  let err = null;
  let wrappedErr = null;
  let awaitPromise = false;
  let extractsValue = false;
  let result;

  const input = code;

  // 1. `{ a: 1 }` at statement position is parsed as a block in scripts;
  //    wrap it so it evaluates as an object literal (Node parity).
  let wrappedCmd = false;
  if (isObjectLiteral(code) && isValidSyntax(code)) {
    code = `(${code.trim()})\n`;
    wrappedCmd = true;
  }

  // Empty line: nothing to do.
  if (code === '\n') {
    cb(null);
    return;
  }

  // 2. Top-level await.
  if ((HAS_AWAIT.test(code) || HAS_FOR_AWAIT.test(code)) && err === null) {
    const preScan = scanTopLevel(code);
    // A top-level `return` disables the TLA transform (Node's containsReturn)
    // and is a SyntaxError.
    if (preScan.statements.some((s) => s.firstWord === 'return')) {
      err = new SyntaxError('Illegal return statement');
      // Mimic the vm's code frame, which native includes for SyntaxErrors:
      // source line, carets under `return`, blank, message.
      const retIdx = code.search(/\breturn\b/);
      const firstLine = code.slice(0, code.includes('\n') ? code.indexOf('\n') : code.length);
      const carets = ' '.repeat(Math.max(0, retIdx)) + '^^^^^^';
      const rest = err.stack.includes('\n') ? err.stack.slice(err.stack.indexOf('\n')) : '';
      err.stack = `${firstLine}\n${carets}\n\nSyntaxError: Illegal return statement${rest}`;
      decorateErrorStack(err);
    } else {
    // Node hoists TLA let/const as `let`, so redeclaring one is a
    // SyntaxError. The sandboxed context hoists as `var` (the vm port only
    // pre-declares `var`), so enforce it here for both lanes.
    let redeclared = null;
    for (const d of preScan.decls) {
      if (d.kind !== 'let' && d.kind !== 'const') continue;
      for (const name of d.names) {
        if (self[kTLALexical].has(name)) { redeclared = name; break; }
      }
      if (redeclared) break;
    }
    if (redeclared !== null) {
      err = new SyntaxError(`Identifier '${redeclared}' has already been declared`);
      decorateErrorStack(err);
    } else {
      try {
        const tla = processTopLevelAwait(code, { forSandbox: !useGlobal });
        if (tla !== null) {
          for (const d of preScan.decls) {
            if (d.kind === 'let' || d.kind === 'const') {
              for (const name of d.names) self[kTLALexical].add(name);
            }
          }
          code = tla.code;
          awaitPromise = true;
          extractsValue = tla.extractsValue;
          wrappedCmd = true;
        }
      } catch (e) {
        let recoverableError = false;
        if (e.name === 'SyntaxError') {
          // Fall back: is the code (sans awaits) merely incomplete?
          const fallbackCode = code.replace(/\bawait\b/g, '');
          try {
            tryParse(fallbackCode);
          } catch (fallbackError) {
            if (isRecoverableError(fallbackError, fallbackCode)) {
              recoverableError = true;
              err = new Recoverable(e);
            }
          }
        }
        if (!recoverableError) {
          decorateErrorStack(err);
          err = e;
        }
      }
    }
    }
  }

  if (err === null) {
    // 3. Strict-mode prefix.
    if (replMode === REPL_MODE_STRICT && /\S/.test(code)) {
      code = `'use strict'; void 0;\n${code}`;
    } else if (!awaitPromise) {
      // 4. Persist top-level lexical bindings across evals. The sandboxed
      //    context needs let/const rewritten as `var` (the vm port only
      //    pre-declares `var`); useGlobal needs it too, because the port's
      //    runInThisContext is an indirect eval where a global lexical `let`
      //    does not survive across evals (only `var` on globalThis does).
      code = persistify(code, scanTopLevel(code));
    }

    // 5. Parse check.
    try {
      tryParse(code);
    } catch (e) {
      err = e;
      if (wrappedCmd) {
        wrappedErr = e;
        try {
          // Retry with the original input (e.g. `{a:1}` reported against input).
          let retry = input;
          if (replMode === REPL_MODE_STRICT && /\S/.test(retry)) {
            retry = `'use strict'; void 0;\n${retry}`;
          }
          tryParse(retry);
        } catch (retryErr) {
          err = retryErr;
        }
      }
      if (isRecoverableError(err, wrappedCmd ? input : code)) {
        err = new Recoverable(err);
      } else {
        decorateErrorStack(err);
      }
    }
  }

  if (err && err instanceof Recoverable) {
    cb(err);
    return;
  }

  // 6. Run.
  if (err === null) {
    self[kEvalActive] = true;
    try {
      if (useGlobal) {
        result = vm.runInThisContext(code, { filename: getREPLResourceName() });
      } else {
        result = vm.runInContext(code, context, { filename: getREPLResourceName() });
      }
    } catch (e) {
      err = e;
      if (!(err instanceof Recoverable)) decorateErrorStack(err);
      // Like Node: errors thrown synchronously during eval are delivered via
      // the domain, and cb is never invoked for them.
      if (self[kEvalActive]) {
        self._domain.emit('error', err);
        return;
      }
    } finally {
      self[kEvalActive] = false;
    }
  }

  // Normalize the vm port's completion value for a lone top-level function
  // declaration: native vm yields undefined (empty completion value), but
  // the port's indirect eval yields the function object.
  if (typeof result === 'function' && err === null && !awaitPromise) {
    const inScan = scanTopLevel(input);
    if (inScan.statements.length === 1 &&
        inScan.statements[0].firstWord === 'function') {
      result = undefined;
    }
  }

  if (awaitPromise && err === null) {
    // Queue input while awaiting so output stays sequential (Node pauses
    // input during the await).
    self[kAwaitingTLA] = true;
    Promise.resolve(result).then(
      (v) => {
        self[kAwaitingTLA] = false;
        const value = extractsValue && v !== null &&
          (typeof v === 'object' || typeof v === 'function') && 'value' in v
          ? v.value
          : v;
        cb(null, value);
        self.drainAwaitQueue();
      },
      (e) => {
        self[kAwaitingTLA] = false;
        if (!(e instanceof Recoverable)) decorateErrorStack(e);
        cb(e);
        self.drainAwaitQueue();
      },
    );
    return;
  }

  if (err !== null) cb(err);
  else cb(null, result);
}

function decorateErrorStack(e) {
  if (!e || typeof e.stack !== 'string') return;
  const lines = e.stack.split('\n');
  const out = [lines[0]];
  for (let k = 1; k < lines.length; k++) {
    const line = lines[k];
    // Simplify `at Proxy.name (eval at <anonymous> (eval at runWithContext …),
    // <anonymous>:L:C)` chains to `at name (repl:L:C)`.
    const m = /^\s*at\s+(?:Proxy\.)?([^\s(]+)\s+\(eval at <anonymous> \(eval at runWithContext \(.*?\), <anonymous>:(\d+):(\d+)\)$/
      .exec(line);
    if (m) {
      out.push(`    at ${m[1]} (repl:${m[2]}:${m[3]})`);
      continue;
    }
    // Drop our own wrapper frames (module file or function-name match, so
    // this also works when bundled for the browser).
    if (/^\s*at\s+(runWithContext|bound|runBound|defaultEval|Script\.runInContext|Module\.runInContext|REPLServer\.|ModuleJob\.run|asyncRunEntryPointWithESMLoader)\b/.test(line) ||
        /\[kNormalWrite\]|_normalWrite/.test(line) ||
        /node:internal/.test(line) ||
        /\/src\/(vm|domain|repl|readline|util)\.js/.test(line)) {
      continue;
    }
    out.push(line);
  }
  e.stack = out.join('\n');
  // Clean `at` noise for SyntaxErrors like Node does (the vm port already
  // prepends a `repl:LINE` source header).
  if (e.name === 'SyntaxError') {
    e.stack = e.stack.replace(/^\s*at\s.*(\r?\n|$)/gm, '').replace(/\n{3,}/g, '\n\n');
  }
}

// ---------------------------------------------------------------------------
// Tab completion (basic but honest): completes the trailing identifier
// against the REPL context, dot-commands, and builtin module names.
// ---------------------------------------------------------------------------

function completer(line, callback) {
  const self = this;
  if (line.startsWith('.')) {
    const prefix = line.slice(1).split(/\s/)[0];
    const matches = Object.keys(self.commands)
      .filter((c) => c.startsWith(prefix))
      .map((c) => `.${c}`);
    callback(null, [matches, line]);
    return;
  }
  const m = line.match(/([A-Za-z_$][\w$]*)$/);
  const prefix = m ? m[1] : '';
  const seen = new Set();
  const matches = [];
  const add = (name) => {
    if (name.startsWith(prefix) && !seen.has(name)) {
      seen.add(name);
      matches.push(name);
    }
  };
  try {
    if (self.useGlobal) {
      for (const k of Object.getOwnPropertyNames(globalThis)) add(k);
    } else if (self.context) {
      // vm contexts are Proxies over the sandbox; enumerate carefully.
      for (const k of Object.getOwnPropertyNames(self.context)) add(k);
    }
  } catch { /* non-enumerable context — skip */ }
  for (const name of replBuiltinLibs) add(name);
  callback(null, [matches, prefix]);
}

// ---------------------------------------------------------------------------
// REPLServer
// ---------------------------------------------------------------------------

const kAwaitingTLA = Symbol('awaitingTLA');

function shouldColorize(stream) {
  if (!stream) return false;
  if (typeof stream.hasColors === 'function') {
    try {
      return !!stream.hasColors();
    } catch { /* fall through */ }
  }
  return !!stream.isTTY;
}

// Node's REPLServer is a function constructor (callable with or without
// `new`), not an ES class. We mirror that so `repl.REPLServer()` warns
// DEP0185 and self-instantiates instead of throwing.
export function REPLServer(prompt, stream, eval_, useGlobal, ignoreUndefined, replMode) {
  if (!(this instanceof REPLServer)) {
    emitDeprecation('DEP0185',
      "Instantiating REPLServer without the 'new' keyword has been deprecated.");
    return new REPLServer(prompt, stream, eval_, useGlobal, ignoreUndefined, replMode);
  }

  let options;
  if (prompt !== null && typeof prompt === 'object') {
    options = { ...prompt };
    stream = options.stream ?? options.socket;
    eval_ = options.eval;
    useGlobal = options.useGlobal;
    ignoreUndefined = options.ignoreUndefined;
    replMode = options.replMode;
  } else {
    options = {};
  }

  // --- input / output resolution ---------------------------------------
  let input = options.input ?? stream;
  let output = options.output ?? stream;

  // Browser terminal: when the caller supplied no streams, prefer the
  // runtime's DOM-terminal streams, then process stdio, then a null stream.
  if (!input || !output) {
    const rt = getRuntime();
    const proc = getProcess();
    if (!input && rt && typeof rt.getStdin === 'function') {
      input = safeCall(rt.getStdin, rt);
    }
    if (!output && rt && typeof rt.makeOutputShim === 'function') {
      output = safeCall(rt.makeOutputShim, rt);
    }
    input = input || proc?.stdin || new NullStream();
    output = output || proc?.stdout || new NullStream();
  }

  if (typeof input.resume === 'function') {
    input.resume();
  }

  let terminal = options.terminal;
  if (terminal === undefined) {
    terminal = !!(output && output.isTTY);
  }
  terminal = !!terminal;

  if (terminal && options.useColors === undefined) {
    options.useColors = shouldColorize(output);
  }

  const historySize = options.historySize ?? 30;
  // NB: when called with an options object, `prompt` (the parameter) IS that
  // object — only use it as the prompt string when it actually is a string.
  const initialPrompt = options.prompt ??
    (typeof prompt === 'string' ? prompt : '> ');

  // Construct the readline Interface with REPLServer.prototype as the
  // prototype (mirrors Node's ObjectSetPrototypeOf wiring).
  const self = Reflect.construct(Interface, [{
    input,
    output,
    completer: options.completer || completer,
    terminal,
    historySize,
    prompt: initialPrompt,
  }], REPLServer);

  self[kBufferedCommand] = '';
  self[kEvalActive] = false;
  self[kAwaitingTLA] = false;
  self[kAwaitQueue] = [];
  self._initialPrompt = initialPrompt;

  // Public state (Node parity).
  self.replMode = replMode || REPL_MODE_SLOPPY;
  self.useGlobal = !!useGlobal;
  self.ignoreUndefined = !!ignoreUndefined;
  self.terminal = terminal;
  // historySize is exposed by the Interface prototype (getter over the
  // history manager); it was configured through the constructor above.
  self.useColors = !!options.useColors;
  self.editorMode = false;
  self.underscoreAssigned = false;
  self.underscoreErrAssigned = false;
  self.last = undefined;
  self.lastError = undefined;
  self._error = undefined;
  self.lines = [];
  self.lines.level = [];
  self[kContextId] = 0;

  // Deprecated aliases (own properties, warn-once like Node's deprecate).
  Object.defineProperties(self, {
    inputStream: {
      enumerable: false,
      configurable: true,
      get() {
        emitDeprecation('DEP0141',
          'repl.inputStream and repl.outputStream are deprecated. ' +
          'Use repl.input and repl.output instead.');
        return self.input;
      },
      set(val) {
        emitDeprecation('DEP0141',
          'repl.inputStream and repl.outputStream are deprecated. ' +
          'Use repl.input and repl.output instead.');
        self.input = val;
      },
    },
    outputStream: {
      enumerable: false,
      configurable: true,
      get() {
        emitDeprecation('DEP0141',
          'repl.inputStream and repl.outputStream are deprecated. ' +
          'Use repl.input and repl.output instead.');
        return self.output;
      },
      set(val) {
        emitDeprecation('DEP0141',
          'repl.inputStream and repl.outputStream are deprecated. ' +
          'Use repl.input and repl.output instead.');
        self.output = val;
      },
    },
  });

  // Domain for eval error routing (Node parity). A minimal local facade —
  // importing the full domain module would patch globals as a side effect.
  self._domain = createReplDomain();
  self._domain.on('error', function domainError(e) {
    onDomainError(self, e);
  });

  // `this.eval` is the domain-bound eval.
  if (typeof eval_ === 'function') {
    if (options.breakEvalOnSigint) {
      throw Object.assign(
        new Error('Cannot specify both breakEvalOnSigint and eval for REPL'),
        { code: 'ERR_INVALID_REPL_EVAL_CONFIG' },
      );
    }
    self.eval = self._domain.bind(eval_);
  } else {
    self.eval = self._domain.bind(defaultEval);
  }
  self.breakEvalOnSigint = !!options.breakEvalOnSigint;
  self.allowBlockingCompletions = !!options.allowBlockingCompletions;
  if (options.preview !== undefined) {
    self.preview = !!options.preview;
  }

  self.writer = options.writer || writer;
  if (self.writer === writer) {
    writer.options.colors = self.useColors;
  }

  // Context setup.
  if (self.useGlobal) {
    self.context = globalThis;
  } else {
    self.context = vm.createContext();
  }
  self.resetContext();

  // Commands.
  self.commands = Object.create(null);
  defineDefaultCommands(self);

  // Event wiring.
  let sawSIGINT = false;
  self.on('SIGINT', () => {
    if (self.editorMode) {
      // Evaluate the accumulated editor buffer, like Node.
      const buf = self[kBufferedCommand];
      self.editorMode = false;
      self.setPrompt(self._initialPrompt);
      self[kBufferedCommand] = '';
      if (buf) {
        self.eval(buf, self.context, 'repl', (e, ret) => finishCommand(self, buf, e, ret, true));
        return;
      }
    }
    const empty = !self.line || self.line.length === 0;
    if (typeof self.clearLine === 'function') self.clearLine();
    const cmd = self[kBufferedCommand];
    if (!(cmd && cmd.length > 0) && empty) {
      if (sawSIGINT) {
        self.close();
        sawSIGINT = false;
        return;
      }
      self.output.write('(To exit, press Ctrl+C again or Ctrl+D or type .exit)\n');
      sawSIGINT = true;
    } else {
      sawSIGINT = false;
    }
    self.clearBufferedCommand();
    self.lines.level = [];
    self.displayPrompt();
  });

  self.on('line', (cmd) => {
    sawSIGINT = false;
    self._onLine(cmd);
  });
  if (typeof self.input?.on === 'function') {
    self.input.on('error', () => self.close());
  }
  // Like Node: the 'close' event surfaces as 'exit'.
  self.on('close', () => self.emit('exit'));

  // Node displays the initial prompt synchronously.
  self.displayPrompt();

  return self;
}
Object.setPrototypeOf(REPLServer.prototype, Interface.prototype);
Object.setPrototypeOf(REPLServer, Interface);

REPLServer.prototype.createContext = function createContext() {
  return this.useGlobal ? globalThis : vm.createContext();
};

REPLServer.prototype.resetContext = function resetContext() {
  this.context = this.createContext();
  this.underscoreAssigned = false;
  this.underscoreErrAssigned = false;
  this.lines = [];
  this.lines.level = [];
  this[kTLALexical] = new Set();

  // Like Node: the sandboxed context gets its own `console` wired to the
  // repl output, so `console.log()` inside eval lands in the repl stream.
  // (useGlobal shares the real global console, like native.)
  if (!this.useGlobal && this.output) {
    try {
      const replConsole = new Console({ stdout: this.output, stderr: this.output });
      Object.defineProperty(this.context, 'console', {
        configurable: true,
        writable: true,
        enumerable: true,
        value: replConsole,
      });
    } catch { /* keep the host console */ }
  }

  // `_` / `_error` are accessor pairs on the context, like Node.
  const self = this;
  Object.defineProperty(this.context, '_', {
    configurable: true,
    enumerable: true,
    get: () => self.last,
    set: (value) => {
      self.last = value;
      if (!self.underscoreAssigned) {
        self.underscoreAssigned = true;
        self.output.write('Expression assignment to _ now disabled.\n');
      }
    },
  });
  Object.defineProperty(this.context, '_error', {
    configurable: true,
    enumerable: true,
    get: () => self.lastError,
    set: (value) => {
      self.lastError = value;
      if (!self.underscoreErrAssigned) {
        self.underscoreErrAssigned = true;
        self.output.write('Expression assignment to _error now disabled.\n');
      }
    },
  });

  this.emit('reset', this.context);
};

// When invoked as an API method, overwrite _initialPrompt (Node parity).
REPLServer.prototype.setPrompt = function setPrompt(prompt) {
  this._initialPrompt = prompt;
  Interface.prototype.setPrompt.call(this, prompt);
};

REPLServer.prototype.displayPrompt = function displayPrompt(preserveCursor) {
  const prompt = this[kBufferedCommand].length > 0
    ? kMultilinePrompt
    : this._initialPrompt;
  // Do not overwrite `_initialPrompt` here.
  Interface.prototype.setPrompt.call(this, prompt);
  this.prompt(preserveCursor);
};

REPLServer.prototype._onLine = function _onLine(cmd) {
  const self = this;
  cmd ||= '';

  // Lines arriving while a top-level await is in flight are queued so
  // output stays sequential (Node pauses input during the await).
  if (self[kAwaitingTLA]) {
    self[kAwaitQueue].push(cmd);
    return;
  }

  if (self.editorMode) {
    self[kBufferedCommand] += cmd + '\n';
    _memory(self, cmd);
    return;
  }

  // Check REPL keywords against the trimmed line (`.5` is a number, not a
  // command — hence the parseFloat guard, like Node).
  const trimmedCmd = cmd.trim();
  if (trimmedCmd &&
      trimmedCmd.charAt(0) === '.' &&
      trimmedCmd.charAt(1) !== '.' &&
      Number.isNaN(Number.parseFloat(trimmedCmd))) {
    const m = /^\.([^\s]+)\s*(.*)$/.exec(trimmedCmd);
    const keyword = m?.[1];
    const rest = m?.[2] ?? '';
    const command = keyword && self.commands[keyword];
    if (command) {
      command.action.call(self, rest);
      return;
    }
    if (!self[kBufferedCommand]) {
      self.output.write('Invalid REPL keyword\n');
      finishCommand(self, cmd, null, undefined, false);
      return;
    }
  }

  // Note: the buffer is intentionally NOT cleared here; finishCommand
  // appends `cmd` on Recoverable and clears on success (Node parity).
  const evalCmd = self[kBufferedCommand] + cmd + '\n';
  self.eval(evalCmd, self.context, 'repl',
    (e, ret) => finishCommand(self, cmd, e, ret, true));
};

REPLServer.prototype.drainAwaitQueue = function drainAwaitQueue() {
  const q = this[kAwaitQueue];
  if (q.length === 0) return;
  for (const line of q.splice(0)) this._onLine(line);
};

REPLServer.prototype.defineCommand = function defineCommand(keyword, cmd) {
  if (typeof cmd === 'function') {
    cmd = { action: cmd };
  } else if (typeof cmd.action !== 'function') {
    throw new ERR_INVALID_REPL_INPUT(keyword);
  }
  this.commands[keyword] = cmd;
};

REPLServer.prototype.close = function close() {
  Interface.prototype.close.call(this);
};

REPLServer.prototype.clearBufferedCommand = function clearBufferedCommand() {
  this[kBufferedCommand] = '';
};

Object.defineProperties(REPLServer.prototype, {
  history: {
    configurable: true,
    enumerable: true,
    get() {
      return this._history || (this._history = []);
    },
  },
  bufferedCommand: {
    configurable: true,
    enumerable: true,
    get() {
      return this[kBufferedCommand];
    },
  },
});

function safeCall(fn, thisArg) {
  try {
    return fn.call(thisArg);
  } catch {
    return undefined;
  }
}

class ERR_INVALID_REPL_INPUT extends TypeError {
  constructor(keyword) {
    super(`Invalid REPL keyword: "${keyword}". ` +
      'The `action` property must be a function.');
    this.code = 'ERR_INVALID_REPL_INPUT';
  }
}

// Simplified _memory: records lines for tooling; the depth bookkeeping only
// matters for the inspector-integrated completer, which we don't have.
function _memory(self, cmd) {
  self.lines ||= [];
  if (cmd) {
    self.lines.push(cmd);
  } else {
    self.lines.push('');
  }
}

// -- finish: mirrors Node's finish() -------------------------------------------

function finishCommand(self, cmd, e, ret, hasRet) {
  _memory(self, cmd);

  if (e) {
    self._error = e;
    // Recoverable SyntaxError: buffer the line and prompt for more.
    if (e instanceof Recoverable) {
      self[kBufferedCommand] += cmd + '\n';
      self.displayPrompt();
      return;
    }
    self._domain.emit('error', e.err || e);
    return;
  }

  // Clear buffer if no SyntaxErrors.
  self.clearBufferedCommand();

  // If we got any output - print it (if no error). `hasRet` mirrors Node's
  // `arguments.length === 2` check (invalid-keyword path prints nothing).
  if (hasRet && (!self.ignoreUndefined || ret !== undefined)) {
    if (!self.underscoreAssigned) {
      self.last = ret;
    }
    self.output.write(`${self.writer(ret)}\n`);
  }

  if (!self.closed) {
    self.displayPrompt();
  }
}

// -- domain error display: mirrors Node's debugDomainError ---------------------

function onDomainError(self, e) {
  let errStack = '';

  if (e && typeof e === 'object') {
    decorateErrorStack(e);

    const importErrorStr = 'Cannot use import statement outside a module';
    if (e.name === 'SyntaxError') {
      if (typeof e.message === 'string' && e.message.includes(importErrorStr)) {
        const lastLine = self.lines[self.lines.length - 1] || '';
        e.message = 'Cannot use import statement inside the Node.js REPL, ' +
          `alternatively use dynamic import: ${toDynamicImport(lastLine)}`;
      }
    }

    if (e instanceof Error) {
      if (e.name === 'SyntaxError') {
        errStack = self.writer(e);
        // If the SyntaxError has no code frame (e.g. synthesized), add one
        // in native style: `SyntaxError: `, source, carets, blank,
        // message. Only for parse errors (not scope errors like
        // "already been declared", which native prints without a frame).
        // Heuristic caret: last occurrence of the unexpected token.
        if (!/^\S.*\n.*\^/m.test(errStack) &&
            !/already been declared/.test(e.message)) {
          const lastLine = self.lines[self.lines.length - 1] || '';
          const tokenMatch = /Unexpected token '([^']+)'/.exec(e.message);
          let carets = '^';
          if (tokenMatch) {
            const idx = lastLine.lastIndexOf(tokenMatch[1]);
            if (idx >= 0) carets = ' '.repeat(idx) + '^'.repeat(tokenMatch[1].length);
          }
          errStack = `SyntaxError: \n${lastLine}\n${carets}\n\n${e.message}`;
        }
      } else {
        // Like Node's repl: runtime errors print just `Name: message` —
        // no code frame, no stack. (The vm port prepends a `repl:LINE`
        // code frame to e.stack; find the message line past it.)
        const msgLine = String(e.stack || '').split('\n')
          .find((l) => l.startsWith(`${e.name}:`));
        errStack = msgLine || `${e.name}: ${e.message}`;
      }
      // Remove one-line error braces to keep the old style in place.
      if (errStack.startsWith('[') && errStack.endsWith(']')) {
        errStack = errStack.slice(1, -1);
      }
    }
  }

  if (!self.underscoreErrAssigned) {
    self.lastError = e;
  }

  if (errStack === '') {
    errStack = self.writer(e);
  }
  const lines = errStack.split(/(?<=\n)/);
  let matched = false;
  errStack = '';
  for (const line of lines) {
    if (!matched && /^\[?([A-Z][a-z0-9_]*)*Error/.test(line)) {
      errStack += writer.options.breakLength >= line.length ?
        `Uncaught ${line}` :
        `Uncaught:\n${line}`;
      matched = true;
    } else {
      errStack += line;
    }
  }
  if (!matched) {
    const ln = lines.length === 1 ? ' ' : ':\n';
    errStack = `Uncaught${ln}${errStack}`;
  }
  // Normalize line endings.
  errStack += errStack.endsWith('\n') ? '' : '\n';
  self.output.write(errStack);
  self.clearBufferedCommand();
  self.lines.level = [];
  if (!self.closed) {
    self.displayPrompt();
  }
}

// ---------------------------------------------------------------------------
// Default dot-commands (help text matches Node)
// ---------------------------------------------------------------------------

function defineDefaultCommands(repl) {
  repl.defineCommand('break', {
    help: 'Sometimes you get stuck, this gets you out',
    action() {
      this.clearBufferedCommand();
      this.displayPrompt();
    },
  });

  repl.defineCommand('clear', {
    help: repl.useGlobal ? 'Alias for .break' : 'Break, and also clear the local context',
    action() {
      this.clearBufferedCommand();
      if (!this.useGlobal) {
        this.output.write('Clearing context...\n');
        this.resetContext();
      }
      this.displayPrompt();
    },
  });

  repl.defineCommand('exit', {
    help: 'Exit the REPL',
    action() {
      this.close();
    },
  });

  repl.defineCommand('help', {
    help: 'Print this help message',
    action() {
      const names = Object.keys(this.commands).sort();
      const longest = Math.max(...names.map((n) => n.length));
      for (const name of names) {
        const cmd = this.commands[name];
        const spaces = ' '.repeat(longest - name.length + 3);
        this.output.write(`.${name}${cmd.help ? spaces + cmd.help : ''}\n`);
      }
      this.output.write('\nPress Ctrl+C to abort current expression, ' +
        'Ctrl+D to exit the REPL\n');
      this.displayPrompt();
    },
  });

  repl.defineCommand('save', {
    help: 'Save all evaluated commands in this REPL session to a file',
    action(file) {
      try {
        if (file === '') throw new Error('Missing file argument');
        const rt = getRuntime();
        const fs = rt && rt.__FS__;
        if (!fs || typeof fs.writeFileSync !== 'function') {
          throw new Error('No filesystem available in this runtime');
        }
        fs.writeFileSync(file, this.lines.join('\n'));
        this.output.write(`Session saved to:${file}\n`);
      } catch (e) {
        this.output.write(`Failed to save:${e.message}\n`);
      }
      this.displayPrompt();
    },
  });

  repl.defineCommand('load', {
    help: 'Load JS from a file into the REPL session',
    action(file) {
      const rt = getRuntime();
      const fs = rt && rt.__FS__;
      const load = (content) => {
        this[kLoading] = true;
        this.eval(content, this.context, file, (e) => {
          this[kLoading] = false;
          if (e) this.emit('error', e);
          this.displayPrompt();
        });
      };
      try {
        if (file === '') throw new Error('Missing file argument');
        if (fs && typeof fs.readFileSync === 'function') {
          load(fs.readFileSync(file, 'utf8'));
        } else {
          throw new Error('No filesystem available in this runtime');
        }
      } catch (e) {
        this.output.write(`Failed to load:${e.message}\n`);
        this.displayPrompt();
      }
    },
  });

  repl.defineCommand('editor', {
    help: 'Enter editor mode',
    action() {
      this.editorMode = true;
      // Bypass our setPrompt override so _initialPrompt is preserved.
      Interface.prototype.setPrompt.call(this, '');
      this.prompt();
    },
  });
}

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

export function start(options) {
  if (typeof options === 'string') {
    return new REPLServer(options);
  }
  return new REPLServer(options ?? {});
}

// `repl.writer` — the shared default writer.
export { writer };

// Named export without the deprecation warning (mirrors Node's dual export).
export const builtinModules = replBuiltinLibs;

// ---------------------------------------------------------------------------
// Module namespace (default export) with deprecated getters.
// ---------------------------------------------------------------------------

const replNamespace = {
  start,
  writer,
  isValidSyntax,
  REPLServer,
  REPL_MODE_SLOPPY,
  REPL_MODE_STRICT,
  Recoverable,
};

Object.defineProperties(replNamespace, {
  builtinModules: {
    enumerable: false,
    configurable: true,
    get() {
      emitDeprecation('DEP0191',
        'repl.builtinModules is deprecated. Check module.builtinModules instead.');
      return replBuiltinLibs;
    },
  },
  _builtinLibs: {
    enumerable: false,
    configurable: true,
    get() {
      emitDeprecation('DEP0142',
        'repl._builtinLibs is deprecated. Check module.builtinModules instead.');
      return replBuiltinLibs;
    },
  },
});

export default replNamespace;
