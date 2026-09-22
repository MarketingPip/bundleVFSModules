// src/module.js — browser port of `node:module` (Node.js v24.20.0).
//
// What this is: the public `node:module` surface (Module class, createRequire,
// isBuiltin, builtinModules, resolution helpers, compile-cache/source-map
// stubs, customization-hook stubs) implemented in dependency-free ESM so it
// runs inside Jared's browser sandbox as well as under real Node.
//
// Layering (browser-first):
//   1. `globalThis._RUNTIME_.__FS__` — the runtime's virtual filesystem
//      singleton (set by our src/fs.js). Used when present.
//   2. Real `fs` via `process.getBuiltinModule('fs')` — ONLY when running
//      under real Node with no runtime attached (parity lane / direct import).
//      Never consulted in a browser: the browser-fallback lane stubs
//      `process.getBuiltinModule` to throw, which drops us to layer 3.
//   3. A tiny in-memory filesystem (standalone browser use; seed it through
//      `globalThis._RUNTIME_.__FS__`).
// File *bytes* come from one of those layers; every algorithm (resolution,
// lookup paths, extension probing, package.json "main" handling, source-map
// VLQ decoding) is ported from Node's lib/ and runs identically everywhere.
//
// Deliberate gaps (documented, not faked):
//   - `register()` installs ESM loader hooks in Node; there is no loader
//     chain in the browser, so it validates its argument and noops.
//   - `registerHooks()` validates hook shape like Node but the hooks never
//     fire in the browser (no CJS loader pipeline to hook into).
//   - `enableCompileCache()` always reports FAILED: V8 code cache cannot be
//     produced from inside the sandbox.
//   - `stripTypeScriptTypes()` validates arguments exactly like Node but
//     returns the code unchanged: real type-stripping needs a TS parser
//     (amaro) that cannot be dependency-free.
//   - `Module._compile` compiles CommonJS only; ESM-syntax detection
//     (`ERR_REQUIRE_ESM`) is implemented via the nearest package.json
//     `type` field where the virtual FS provides it.
//   - `require()` of a builtin inside the sandbox uses
//     `globalThis._RUNTIME_.loadModule` when it can be satisfied
//     synchronously; `loadModule` is async in the host, so async results
//     fall back to MODULE_NOT_FOUND (the host rewrites `import`s itself).

// ---------------------------------------------------------------------------
// Runtime bridge (guarded: rewritten to the sandbox scope at load time,
// undefined under real Node / direct import).
// ---------------------------------------------------------------------------
function getRT() {
  return (typeof globalThis._RUNTIME_ !== 'undefined')
    ? globalThis._RUNTIME_
    : undefined;
}

// ---------------------------------------------------------------------------
// Minimal POSIX path helpers (dependency-free; differential-tested against
// node:path in tests/module.test.js).
// ---------------------------------------------------------------------------
function getCwd() {
  try {
    if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
      const cwd = process.cwd();
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    }
  } catch { /* fall through to '/' */ }
  return '/';
}

function validatePathArg(part, i) {
  if (typeof part !== 'string') {
    throw errInvalidArgType(`paths[${i}]`, 'string', part);
  }
}

function posixNormalize(p) {
  validatePathArg(p, 0);
  const isAbs = p.charAt(0) === '/';
  const segs = p.split('/');
  const out = [];
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
    } else {
      out.push(s);
    }
  }
  // Like Node's path.normalize, trailing slashes are stripped (except root).
  const res = (isAbs ? '/' : '') + out.join('/');
  return res || (isAbs ? '/' : '.');
}

function posixResolve(...parts) {
  let resolved = '';
  let abs = false;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    validatePathArg(p, i);
    if (p.length === 0) continue;
    resolved = resolved ? `${p}/${resolved}` : p;
    if (p.charAt(0) === '/') { abs = true; break; }
  }
  if (!abs) resolved = `${getCwd()}/${resolved}`;
  return posixNormalize(resolved);
}

function posixDirname(p) {
  validatePathArg(p, 0);
  if (p === '/') return '/';
  let end = p.length;
  while (end > 1 && p.charAt(end - 1) === '/') end--;
  const slash = p.lastIndexOf('/', end - 1);
  if (slash === -1) return '.';
  if (slash === 0) return '/';
  return p.slice(0, slash);
}

function posixBasename(p) {
  validatePathArg(p, 0);
  let end = p.length;
  while (end > 1 && p.charAt(end - 1) === '/') end--;
  const slash = p.lastIndexOf('/', end - 1);
  return p.slice(slash + 1, end);
}

function posixIsAbsolute(p) {
  return typeof p === 'string' && p.charAt(0) === '/';
}

function posixJoin(...parts) {
  return posixNormalize(parts.filter((p) => typeof p === 'string' && p.length > 0).join('/'));
}

function isRelative(request) {
  return request === '.' || request === '..' ||
    request.startsWith('./') || request.startsWith('../');
}

function isURLObject(v) {
  return v !== null && typeof v === 'object' && typeof v.href === 'string' &&
    typeof v.protocol === 'string';
}

// ---------------------------------------------------------------------------
// Error factories — same codes and message shapes as Node's internal/errors.
// ---------------------------------------------------------------------------
function inspectValue(v) {
  if (typeof v === 'string') return `'${v}'`;
  if (typeof v === 'undefined') return 'undefined';
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'symbol') return String(v);
  if (typeof v === 'function') return `[Function: ${v.name || 'anonymous'}]`;
  if (v === null) return 'null';
  if (typeof v === 'object') {
    if (Object.getPrototypeOf(v) === null) return '[Object: null prototype] {}';
    try {
      const j = JSON.stringify(v);
      return j === undefined ? String(v) : j;
    } catch { return String(v); }
  }
  return String(v);
}

// 'Received …' rendering, mirroring Node's ERR_INVALID_ARG_TYPE message
// builder (lib/internal/errors.js).
function receivedSuffix(actual) {
  if (actual === null || actual === undefined) return ` Received ${actual}`;
  if (typeof actual === 'function') return ` Received function ${actual.name}`;
  if (typeof actual === 'object') {
    const ctor = actual.constructor;
    if (typeof ctor === 'function' && ctor.name) {
      return ` Received an instance of ${ctor.name}`;
    }
    return ` Received ${inspectValue(actual)}`;
  }
  return ` Received type ${typeof actual} (${inspectValue(actual)})`;
}

// Node's internal coded errors render as `TypeError [ERR_FOO]: message`
// (their toString includes the code), while plain errors that merely carry
// a `.code` property (the CJS loader's MODULE_NOT_FOUND, native URL parse
// errors) render without it. Match that distinction.
function stampCode(err, includeInToString) {
  if (includeInToString) {
    const name = err.name;
    const code = err.code;
    Object.defineProperty(err, 'toString', {
      __proto__: null,
      value() {
        return `${name} [${code}]: ${err.message}`;
      },
      writable: true,
      configurable: true,
    });
  }
  return err;
}

function codedError(code, message, includeInToString = true) {
  const e = new Error(message);
  e.code = code;
  return stampCode(e, includeInToString);
}
function typeError(code, message, includeInToString = true) {
  const e = new TypeError(message);
  e.code = code;
  return stampCode(e, includeInToString);
}

function errInvalidArgType(name, expected, actual) {
  // Node uses "property" when the name contains a dot (e.g. options.foo).
  const kind = name.includes('.') ? 'property' : 'argument';
  const list = Array.isArray(expected) ? expected : [expected];
  const exp = list.map((e) => `of type ${e}`).join(' or ');
  return typeError(
    'ERR_INVALID_ARG_TYPE',
    `The "${name}" ${kind} must be ${exp}.${receivedSuffix(actual)}`,
  );
}
function errInvalidPropertyType(name, expected, actual) {
  return errInvalidArgType(name, expected, actual);
}
function errInvalidArgValue(name, actual, reason = 'is invalid') {
  // Node says "property" when the name is dotted (e.g. 'options.paths').
  const kind = String(name).includes('.') ? 'property' : 'argument';
  return typeError(
    'ERR_INVALID_ARG_VALUE',
    `The ${kind} '${name}' ${reason}. Received ${inspectValue(actual)}`,
  );
}
function errMissingArgs(name) {
  return typeError(
    'ERR_MISSING_ARGS',
    `The "${name}" argument must be specified`,
  );
}
function validateString(v, name) {
  if (typeof v !== 'string') throw errInvalidArgType(name, 'string', v);
}
function validateBoolean(v, name) {
  if (typeof v !== 'boolean') throw errInvalidArgType(name, 'boolean', v);
}
function validateObject(v, name) {
  if (v === null || typeof v !== 'object') throw errInvalidArgType(name, 'object', v);
}
function validateFunction(v, name) {
  if (typeof v !== 'function') throw errInvalidPropertyType(name, 'function', v);
}
function moduleNotFound(request, requireStack) {
  let message = `Cannot find module '${request}'`;
  if (requireStack && requireStack.length > 0) {
    message += `\nRequire stack:\n- ${requireStack.join('\n- ')}`;
  }
  const e = new Error(message);
  e.code = 'MODULE_NOT_FOUND';
  e.requireStack = requireStack || [];
  return stampCode(e, false);
}

function emitDeprecationWarning(code, message) {
  try {
    if (typeof process !== 'undefined' &&
        typeof process.emitWarning === 'function') {
      process.emitWarning(message, 'DeprecationWarning', code);
    }
  } catch { /* warning is best-effort */ }
}

// ---------------------------------------------------------------------------
// Filesystem backend. Order: runtime VFS -> real fs (Node, no runtime) ->
// in-memory (browser standalone). Never throws at lookup time.
// ---------------------------------------------------------------------------
function createMemoryFs() {
  const files = new Map();
  const dirs = new Set(['/']);
  const norm = (p) => posixNormalize(String(p));
  function ensureParentDirs(p) {
    let d = posixDirname(p);
    while (d !== '/' && d !== '.' && !dirs.has(d)) {
      dirs.add(d);
      d = posixDirname(d);
    }
  }
  function enoent(op, p) {
    const e = new Error(`ENOENT: no such file or directory, ${op} '${p}'`);
    e.code = 'ENOENT';
    return e;
  }
  return {
    readFileSync(p, encoding) {
      p = norm(p);
      if (!files.has(p)) throw enoent('open', p);
      return files.get(p);
    },
    writeFileSync(p, data) {
      p = norm(p);
      ensureParentDirs(p);
      files.set(p, String(data));
    },
    existsSync(p) {
      p = norm(p);
      return files.has(p) || dirs.has(p);
    },
    statSync(p) {
      p = norm(p);
      const f = files.has(p);
      const d = dirs.has(p);
      if (!f && !d) throw enoent('stat', p);
      return { isFile: () => f, isDirectory: () => d && !f };
    },
    mkdirSync(p) {
      p = norm(p);
      ensureParentDirs(p);
      dirs.add(p);
    },
  };
}
let memoryFs;
function getMemoryFs() {
  if (!memoryFs) memoryFs = createMemoryFs();
  return memoryFs;
}

let realFsAdapter; // caches only a successful probe; failures re-probe so a
// temporarily-disabled getBuiltinModule (browser-fallback lane) does not
// poison later lookups.
function getRealFsAdapter() {
  if (realFsAdapter) return realFsAdapter;
  try {
    if (typeof process !== 'undefined' &&
        typeof process.getBuiltinModule === 'function') {
      const fs = process.getBuiltinModule('fs');
      if (fs && typeof fs.readFileSync === 'function' &&
          typeof fs.existsSync === 'function' &&
          typeof fs.statSync === 'function') {
        realFsAdapter = {
          readFileSync: (p, enc) => fs.readFileSync(p, enc),
          existsSync: (p) => {
            try { return fs.existsSync(p); } catch { return false; }
          },
          statSync: (p) => fs.statSync(p),
          realpathSync: (p) => (typeof fs.realpathSync === 'function'
            ? fs.realpathSync(p)
            : posixResolve(p)),
        };
      }
    }
  } catch { /* unavailable: fall through to memory FS */ }
  return realFsAdapter;
}

function getFS() {
  const RT = getRT();
  const vfs = RT && RT.__FS__;
  if (vfs && typeof vfs === 'object') return vfs;
  return getRealFsAdapter() || getMemoryFs();
}

// _stat: 0 = file, 1 = directory, negative = missing/other.
function _stat(p) {
  try {
    const st = getFS().statSync(p);
    if (st.isDirectory()) return 1;
    if (st.isFile()) return 0;
    return -1;
  } catch { return -1; }
}

function readFileText(p) {
  const fs = getFS();
  if (!fs || typeof fs.readFileSync !== 'function') {
    const e = new Error(`ENOENT: no such file or directory, open '${p}'`);
    e.code = 'ENOENT';
    throw e;
  }
  const data = fs.readFileSync(p, 'utf8');
  return typeof data === 'string' ? data : String(data);
}

function toRealPath(p) {
  const fs = getFS();
  try {
    if (fs && typeof fs.realpathSync === 'function') return fs.realpathSync(p);
  } catch { /* fall through */ }
  return posixResolve(p);
}

function stripBOM(content) {
  if (content.charCodeAt(0) === 0xFEFF) return content.slice(1);
  return content;
}

// ---------------------------------------------------------------------------
// builtinModules / isBuiltin — exact v24.20.0 list and semantics.
// ---------------------------------------------------------------------------
const builtinModules = Object.freeze([
  '_http_agent',
  '_http_client',
  '_http_common',
  '_http_incoming',
  '_http_outgoing',
  '_http_server',
  '_stream_duplex',
  '_stream_passthrough',
  '_stream_readable',
  '_stream_transform',
  '_stream_wrap',
  '_stream_writable',
  '_tls_common',
  '_tls_wrap',
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'inspector/promises',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
  'node:sea',
  'node:sqlite',
  'node:test',
  'node:test/reporters',
]);

const schemelessBuiltinSet = new Set(
  builtinModules.filter((id) => !id.startsWith('node:')),
);
const requirableByUsersSet = new Set(
  builtinModules.map((id) => (id.startsWith('node:') ? id.slice(5) : id)),
);

function canBeRequiredWithoutScheme(id) {
  return schemelessBuiltinSet.has(id);
}
function canBeRequiredByUsers(id) {
  return requirableByUsersSet.has(id);
}
// Mirrors BuiltinModule.normalizeRequirableId: returns the bare id for
// requirable builtins, undefined otherwise.
function normalizeRequirableId(id) {
  if (typeof id === 'string' && id.startsWith('node:')) {
    const normalized = id.slice(5);
    if (canBeRequiredByUsers(normalized)) return normalized;
  } else if (canBeRequiredWithoutScheme(id)) {
    return id;
  }
  return undefined;
}

function isBuiltin(id) {
  return canBeRequiredWithoutScheme(id) ||
    (typeof id === 'string' &&
      id.startsWith('node:') &&
      canBeRequiredByUsers(id.slice(5)));
}

// ---------------------------------------------------------------------------
// Module class.
// ---------------------------------------------------------------------------
const kFirstModuleParent = Symbol('kFirstModuleParent');
let isPreloading = false;

function updateChildren(parent, child, scan) {
  if (!parent || !child || !Array.isArray(parent.children)) return;
  if (scan && parent.children.includes(child)) return;
  parent.children.push(child);
}

function Module(id = '', parent) {
  this.id = id;
  this.path = posixDirname(String(id));
  this.exports = {};
  this[kFirstModuleParent] = parent === undefined ? null : parent;
  updateChildren(parent, this, false);
  this.filename = null;
  this.loaded = false;
  this.children = [];
}

Object.defineProperty(Module.prototype, 'isPreloading', {
  __proto__: null,
  get() { return isPreloading; },
  configurable: true,
});

// DEP0144: module.parent is deprecated; kept as an accessor like Node's.
Object.defineProperty(Module.prototype, 'parent', {
  __proto__: null,
  get() {
    emitDeprecationWarning(
      'DEP0144',
      'module.parent is deprecated due to accuracy issues. Please use ' +
      'require.main to find program entry point instead.',
    );
    return this[kFirstModuleParent];
  },
  set(value) {
    emitDeprecationWarning(
      'DEP0144',
      'module.parent is deprecated due to accuracy issues. Please use ' +
      'require.main to find program entry point instead.',
    );
    this[kFirstModuleParent] = value;
  },
  configurable: true,
});

Module.prototype.require = function require(id) {
  validateString(id, 'id');
  if (id === '') {
    throw errInvalidArgValue('id', id, 'must be a non-empty string');
  }
  return Module._load(id, this, /* isMain */ false);
};

Module.prototype.load = function load(filename) {
  this.filename = filename;
  this.paths = Module._nodeModulePaths(posixDirname(filename));
  const extension = findLongestRegisteredExtension(filename);
  Module._extensions[extension](this, filename);
  this.loaded = true;
};

Module.prototype._compile = function _compile(content, filename) {
  content = stripBOM(String(content));
  maybeRegisterSourceMap(filename, content);
  // new Function's parameter list IS the CommonJS wrapper
  // (exports, require, module, __filename, __dirname); the body is the
  // module source itself. (Passing Module.wrap(content) as the body would
  // merely evaluate and discard the wrapper expression.)
  const compiled = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    content,
  );
  const dirname = posixDirname(filename);
  const require = makeRequireFunction(this);
  compiled.call(this.exports, this.exports, require, this, filename, dirname);
  return this.exports;
};

// ---------------------------------------------------------------------------
// Caches, extensions, wrapper.
// ---------------------------------------------------------------------------
// _cache uses a null-prototype object, like Node's.
const _cache = Object.create(null);
const _pathCache = Object.create(null);

const _extensions = {
  __proto__: null,
  '.js'(module, filename) {
    const content = readFileText(filename);
    maybeThrowRequireESM(module, filename, content);
    module._compile(content, filename);
  },
  '.json'(module, filename) {
    const content = readFileText(filename);
    try {
      module.exports = JSON.parse(stripBOM(content));
    } catch (err) {
      err.message = `${filename}: ${err.message}`;
      throw err;
    }
  },
  // Native addons cannot load in the browser; honest noop (Node would dlopen).
  '.node'() {},
};

function wrap(script) {
  return (
    `(function (exports, require, module, __filename, __dirname) { ${script}` +
    '\n});'
  );
}

const wrapper = [
  '(function (exports, require, module, __filename, __dirname) { ',
  '\n});',
];

// Find the longest registered extension (supports multi-dot like ".foo.js").
function findLongestRegisteredExtension(filename) {
  const name = posixBasename(filename);
  let startIndex = 0;
  let index;
  while ((index = name.indexOf('.', startIndex)) !== -1) {
    startIndex = index + 1;
    if (index === 0) continue; // Skip dotfiles like .gitignore
    const currentExtension = name.slice(index);
    if (_extensions[currentExtension]) return currentExtension;
  }
  return '.js';
}

// package.json lookup through the FS backend: { exists, main, pjsonPath, data }.
function readPackageJson(requestPath) {
  const pjsonPath = posixResolve(requestPath, 'package.json');
  try {
    const data = JSON.parse(stripBOM(readFileText(pjsonPath)));
    return {
      exists: true,
      pjsonPath,
      data,
      main: data && typeof data.main === 'string' ? data.main : undefined,
      type: data && data.type,
      name: data && data.name,
    };
  } catch {
    return { exists: false, pjsonPath };
  }
}
Module._readPackage = readPackageJson;

function getNearestParentPackageJSON(from) {
  let dir = posixDirname(posixResolve(from));
  while (true) {
    const pkg = readPackageJson(dir);
    if (pkg.exists) return pkg;
    const parent = posixDirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// require() of a `.js` file inside a `"type": "module"` package scope.
function maybeThrowRequireESM(module, filename, content) {
  const pkg = getNearestParentPackageJSON(filename);
  if (pkg && pkg.type === 'module') {
    const e = new Error(
      `require() of ES Module ${filename} not supported.\n` +
      'Instead change the require of the .js file to a dynamic import() ' +
      'which is available in all CommonJS modules.',
    );
    e.code = 'ERR_REQUIRE_ESM';
    throw e;
  }
}

function tryFile(requestPath, isMain) {
  const rc = _stat(requestPath);
  if (rc !== 0) return undefined;
  return toRealPath(requestPath);
}

function tryExtensions(basePath, exts, isMain) {
  for (let i = 0; i < exts.length; i++) {
    const filename = tryFile(basePath + exts[i], isMain);
    if (filename) return filename;
  }
  return false;
}

function tryPackage(requestPath, exts, isMain, originalPath) {
  const pkg = Module._readPackage(requestPath);
  if (!pkg.exists || !pkg.main) {
    return tryExtensions(posixResolve(requestPath, 'index'), exts, isMain);
  }
  const filename = posixResolve(requestPath, pkg.main);
  let actual = tryFile(filename, isMain) ||
    tryExtensions(filename, exts, isMain) ||
    tryExtensions(posixResolve(filename, 'index'), exts, isMain);
  if (actual === false) {
    actual = tryExtensions(posixResolve(requestPath, 'index'), exts, isMain);
    if (!actual) {
      const err = new Error(
        `Cannot find module '${filename}'. ` +
        'Please verify that the package.json has a valid "main" entry',
      );
      err.code = 'MODULE_NOT_FOUND';
      err.path = pkg.pjsonPath;
      err.requestPath = originalPath;
      throw stampCode(err, false);
    }
    emitDeprecationWarning(
      'DEP0128',
      `Invalid 'main' field in '${pkg.pjsonPath}' of '${pkg.main}'. ` +
      'Please either fix that or report it to the module author',
    );
  }
  return actual;
}

// Self-reference resolution: a package requiring itself by name.
function trySelfParentPath(parent) {
  if (!parent) return false;
  if (parent.filename) return parent.filename;
  return false;
}

function trySelf(parentPath, request) {
  if (!parentPath || normalizeRequirableId(request) !== undefined) return false;
  const pkg = getNearestParentPackageJSON(parentPath);
  if (!pkg || !pkg.exists || typeof pkg.name !== 'string') return false;
  if (request !== pkg.name && !request.startsWith(`${pkg.name}/`)) return false;
  const pkgDir = posixDirname(pkg.pjsonPath);
  const subpath = request === pkg.name ? '.' : request.slice(pkg.name.length);
  const resolved = Module._findPath(subpath === '.' ? pkgDir : posixJoin(pkgDir, subpath), [''], false);
  return resolved || false;
}

// ---------------------------------------------------------------------------
// Resolution — ported from lib/internal/modules/cjs/loader.js (POSIX).
// ---------------------------------------------------------------------------

// `node_modules` char codes, reversed.
const nmChars = [115, 101, 108, 117, 100, 111, 109, 95, 101, 100, 111, 110];
const nmLen = nmChars.length;
const CHAR_FORWARD_SLASH = 47;

function _nodeModulePaths(from) {
  // Guarantee that 'from' is absolute.
  from = posixResolve(from);
  // Return early not only to avoid unnecessary work, but to *avoid* returning
  // an array of two items for a root: [ '//node_modules', '/node_modules' ]
  if (from === '/') return ['/node_modules'];

  const paths = [];
  for (let i = from.length - 1, p = 0, last = from.length; i >= 0; --i) {
    const code = from.charCodeAt(i);
    if (code === CHAR_FORWARD_SLASH) {
      if (p !== nmLen) paths.push(`${from.slice(0, last)}/node_modules`);
      last = i;
      p = 0;
    } else if (p !== -1) {
      if (nmChars[p] === code) ++p;
      else p = -1;
    }
  }

  // Append /node_modules to handle root paths.
  paths.push('/node_modules');
  return paths;
}

// Global lookup paths, mirroring Node's Module._initPaths() ordering:
// NODE_PATH entries first, then home-based paths, then the install prefix's
// lib/node. In the browser sandbox there is no home directory or install
// prefix, so only NODE_PATH (from the sandbox process env) applies there.
let globalPaths = ['/node_modules'];
let modulePaths = globalPaths;

function readEnv(name) {
  try {
    const RT = getRT();
    const env = (RT && RT.process && RT.process.env) ||
      (typeof process !== 'undefined' ? process.env : undefined);
    return env ? env[name] : undefined;
  } catch { return undefined; }
}

function _initPaths() {
  const paths = [];
  const nodePath = readEnv('NODE_PATH');
  if (typeof nodePath === 'string' && nodePath.length > 0) {
    for (const p of nodePath.split(':')) {
      if (p && !paths.includes(p)) paths.push(p);
    }
  }
  const RT = getRT();
  if (!RT && typeof process !== 'undefined') {
    // Real-Node fidelity only: home and install-prefix paths have no
    // meaning inside the browser sandbox.
    const homeDir = readEnv('HOME') || readEnv('USERPROFILE');
    if (homeDir) {
      paths.push(posixResolve(homeDir, '.node_modules'));
      paths.push(posixResolve(homeDir, '.node_libraries'));
    }
    try {
      if (typeof process.execPath === 'string') {
        paths.push(posixResolve(process.execPath, '..', '..', 'lib', 'node'));
      }
    } catch { /* best-effort */ }
  }
  if (paths.length === 0) paths.push('/node_modules');
  globalPaths = paths;
  modulePaths = globalPaths;
  // Keep the Module static in sync, like Node's _initPaths does.
  Module.globalPaths = globalPaths;
}
_initPaths();

function _resolveLookupPaths(request, parent) {
  if (normalizeRequirableId(request) !== undefined) {
    return null;
  }

  // Check for node modules paths.
  if (request.charAt(0) !== '.' ||
      (request.length > 1 &&
        request.charAt(1) !== '.' &&
        request.charAt(1) !== '/')) {
    let paths;
    if (parent && parent.paths && parent.paths.length) {
      paths = modulePaths.slice();
      paths.unshift(...parent.paths);
    } else {
      paths = modulePaths;
    }
    return paths.length > 0 ? paths : null;
  }

  // In REPL, parent.filename is null.
  if (!parent || !parent.id || !parent.filename) {
    // Make require('./path/to/foo') work - normally the path is taken
    // from realpath(__filename) but in REPL there is no filename
    return ['.'];
  }

  return [posixDirname(parent.filename)];
}

function _findPath(request, paths, isMain) {
  const absoluteRequest = posixIsAbsolute(request);
  if (absoluteRequest) {
    paths = [''];
  } else if (!paths || paths.length === 0) {
    return false;
  }

  const cacheKey = `${request}\x00${paths.join('\x00')}`;
  const cached = _pathCache[cacheKey];
  if (cached) return cached;

  let exts;
  const trailingSlash = request.length > 0 &&
    (request.charCodeAt(request.length - 1) === CHAR_FORWARD_SLASH ||
      (request.charCodeAt(request.length - 1) === 46 /* . */ &&
        (request.length === 1 ||
          request.charCodeAt(request.length - 2) === CHAR_FORWARD_SLASH ||
          (request.charCodeAt(request.length - 2) === 46 &&
            (request.length === 2 ||
              request.charCodeAt(request.length - 3) === CHAR_FORWARD_SLASH)))));

  let insidePath = true;
  if (isRelative(request)) {
    const normalizedRequest = posixNormalize(request);
    if (normalizedRequest.startsWith('..')) insidePath = false;
  }

  // For each path
  for (let i = 0; i < paths.length; i++) {
    // Don't search further if path doesn't exist
    const curPath = paths[i];
    if (typeof curPath !== 'string') {
      throw errInvalidArgType('paths', 'array of strings', paths);
    }
    if (insidePath && curPath && _stat(curPath) < 1) {
      continue;
    }

    const basePath = posixResolve(curPath, request);
    let filename;

    const rc = _stat(basePath);
    if (!trailingSlash) {
      if (rc === 0) { // File.
        filename = toRealPath(basePath);
      }

      if (!filename) {
        // Try it with each of the extensions
        if (exts === undefined) exts = Object.keys(_extensions);
        filename = tryExtensions(basePath, exts, isMain);
      }
    }

    if (!filename && rc === 1) { // Directory.
      // try it with each of the extensions at "index"
      if (exts === undefined) exts = Object.keys(_extensions);
      filename = tryPackage(basePath, exts, isMain, request);
    }

    if (filename) {
      _pathCache[cacheKey] = filename;
      return filename;
    }
  }

  return false;
}

function getRequireStack(parent) {
  const stack = [];
  let p = parent;
  const seen = new Set();
  while (p && !seen.has(p)) {
    seen.add(p);
    if (p.filename) stack.push(p.filename);
    else if (p.id && p.id !== '<repl>') stack.push(p.id);
    p = p[kFirstModuleParent];
  }
  return stack;
}

function _resolveFilename(request, parent, isMain, options) {
  const normalized = normalizeRequirableId(request);
  if (normalized !== undefined) {
    return request;
  }

  let paths;

  if (typeof options === 'object' && options !== null) {
    if (Array.isArray(options.paths)) {
      if (isRelative(request)) {
        paths = options.paths;
      } else {
        const fakeParent = new Module('', null);
        paths = [];
        for (let i = 0; i < options.paths.length; i++) {
          const p = options.paths[i];
          fakeParent.paths = _nodeModulePaths(p);
          const lookupPaths = _resolveLookupPaths(request, fakeParent);
          if (lookupPaths) {
            for (const lp of lookupPaths) {
              if (!paths.includes(lp)) paths.push(lp);
            }
          }
        }
      }
    } else if (options.paths === undefined) {
      paths = _resolveLookupPaths(request, parent);
    } else {
      throw errInvalidArgValue('options.paths', options.paths);
    }
  } else {
    paths = _resolveLookupPaths(request, parent);
  }

  const parentPath = trySelfParentPath(parent);

  // Try module self resolution first
  const selfResolved = trySelf(parentPath, request);
  if (selfResolved) {
    const cacheKey = `${request}\x00` +
      (paths.length === 1 ? paths[0] : paths.join('\x00'));
    _pathCache[cacheKey] = selfResolved;
    return selfResolved;
  }

  // Look up the filename first, since that's the cache key.
  const filename = _findPath(request, paths, isMain);
  if (filename) return filename;

  throw moduleNotFound(request, getRequireStack(parent));
}

// ---------------------------------------------------------------------------
// Loading.
// ---------------------------------------------------------------------------

// Bundle-key mapping for the runtime: 'timers/promises' -> 'timers_promises'.
function toBundleKey(id) {
  return id.replace(/\//g, '_');
}

function interopDefault(ns) {
  return (ns && typeof ns === 'object' && 'default' in ns) ? ns.default : ns;
}

// Load a builtin module object synchronously from the available providers:
// the sandbox runtime (guarded), then the real Node builtin when running
// under Node without a runtime. Throws MODULE_NOT_FOUND otherwise.
function loadBuiltinModule(normalizedId, originalRequest) {
  const RT = getRT();
  if (RT && typeof RT.loadModule === 'function') {
    try {
      const loaded = RT.loadModule(toBundleKey(normalizedId));
      if (loaded && typeof loaded.then !== 'function') {
        return interopDefault(loaded);
      }
      // Async result: sync require() cannot wait for it (the host rewrites
      // `import` statements itself); fall through to MODULE_NOT_FOUND.
    } catch { /* fall through */ }
  }
  try {
    if (typeof process !== 'undefined' &&
        typeof process.getBuiltinModule === 'function') {
      const mod = process.getBuiltinModule(normalizedId);
      if (mod !== undefined) return mod;
    }
  } catch { /* browser-fallback lane: no native delegation */ }
  throw moduleNotFound(originalRequest, []);
}

function _load(request, parent, isMain) {
  const normalized = normalizeRequirableId(request);
  if (normalized !== undefined) {
    return loadBuiltinModule(normalized, request);
  }

  const filename = _resolveFilename(request, parent, isMain);

  const cachedModule = _cache[filename];
  if (cachedModule !== undefined) {
    updateChildren(parent, cachedModule, true);
    return cachedModule.exports;
  }

  const module = new Module(filename, parent);
  _cache[filename] = module;

  // Keep the strict-mode-safe pattern: `success` must be declared before
  // the try/finally so the finally block can reference it.
  let success = false;
  try {
    module.load(filename);
    success = true;
  } finally {
    if (!success) {
      delete _cache[filename];
    }
  }

  return module.exports;
}

// ---------------------------------------------------------------------------
// createRequire / makeRequireFunction.
// ---------------------------------------------------------------------------
const createRequireError =
  'must be a file URL object, file URL string, or absolute path string';

function fileURLToPathShim(url) {
  if (url.protocol !== 'file:') {
    const e = new TypeError('The URL must be of scheme file');
    e.code = 'ERR_INVALID_URL_SCHEME';
    throw e;
  }
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    const e = new TypeError('Invalid URL');
    e.code = 'ERR_INVALID_URL';
    throw e;
  }
  return pathname;
}

function createRequireFromPath(filename, fileURL) {
  // Allow a directory to be passed as the filename
  const trailingSlash = filename.endsWith('/');
  const proxyPath = trailingSlash ? posixJoin(filename, 'noop.js') : filename;

  const m = new Module(proxyPath);
  m.filename = proxyPath;
  m.paths = _nodeModulePaths(m.path);
  return makeRequireFunction(m);
}

function createRequire(filenameOrURL) {
  let filepath;
  let fileURL;

  if (isURLObject(filenameOrURL) ||
      (typeof filenameOrURL === 'string' && !posixIsAbsolute(filenameOrURL))) {
    try {
      // It might be a URL, try to convert it.
      // If it's a relative path, it would not parse and would be considered
      // invalid per the documented contract.
      fileURL = new URL(filenameOrURL);
      filepath = fileURLToPathShim(fileURL);
    } catch {
      throw errInvalidArgValue('filename', filenameOrURL, createRequireError);
    }
  } else if (typeof filenameOrURL !== 'string') {
    throw errInvalidArgValue('filename', filenameOrURL, createRequireError);
  } else {
    filepath = filenameOrURL;
  }
  return createRequireFromPath(filepath, fileURL);
}

function makeRequireFunction(mod) {
  function require(path) {
    return mod.require(path);
  }

  function resolve(request, options) {
    validateString(request, 'request');
    const normalized = normalizeRequirableId(request);
    if (normalized !== undefined) return request;
    let resolveOptions;
    if (options !== undefined && options !== null) {
      if (typeof options === 'object' && options.paths !== undefined) {
        resolveOptions = { paths: options.paths };
      }
    }
    return _resolveFilename(request, mod, /* isMain */ false, resolveOptions);
  }

  function paths(request) {
    validateString(request, 'request');
    return _resolveLookupPaths(request, mod);
  }

  require.resolve = resolve;
  resolve.paths = paths;

  // process.mainModule is undefined in modern Node; there is no main-module
  // concept in the sandbox either.
  require.main = undefined;

  // Enable support to add extra extension types.
  require.extensions = _extensions;
  require.cache = _cache;

  return require;
}

// ---------------------------------------------------------------------------
// Compile cache — the browser cannot produce V8 code cache; report FAILED
// honestly instead of throwing.
// ---------------------------------------------------------------------------
const constants = {
  compileCacheStatus: {
    FAILED: 0,
    ENABLED: 1,
    ALREADY_ENABLED: 2,
    DISABLED: 3,
  },
};

function enableCompileCache(cacheDir) {
  if (cacheDir !== undefined && typeof cacheDir !== 'string') {
    throw typeError('ERR_INVALID_ARG_TYPE', 'cacheDir should be a string');
  }
  return { status: constants.compileCacheStatus.FAILED, directory: undefined };
}

function getCompileCacheDir() {
  return undefined;
}

function flushCompileCache() {
  return undefined;
}

// ---------------------------------------------------------------------------
// Source-map support flags.
// ---------------------------------------------------------------------------
let sourceMapsSupport = Object.freeze({
  __proto__: null,
  enabled: false,
  nodeModules: false,
  generatedCode: false,
});

function getSourceMapsSupport() {
  // Return a read-only object, like Node's.
  return sourceMapsSupport;
}

function setSourceMapsSupport(enabled, options = {}) {
  validateBoolean(enabled, 'enabled');
  validateObject(options, 'options');
  const { nodeModules = false, generatedCode = false } = options;
  validateBoolean(nodeModules, 'options.nodeModules');
  validateBoolean(generatedCode, 'options.generatedCode');
  sourceMapsSupport = Object.freeze({
    __proto__: null,
    enabled,
    nodeModules,
    generatedCode,
  });
}

// ---------------------------------------------------------------------------
// SourceMap — pure VLQ decoder ported from
// lib/internal/source_map/source_map.js.
// ---------------------------------------------------------------------------
const base64Digits =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const base64Map = {};
for (let i = 0; i < base64Digits.length; ++i) base64Map[base64Digits[i]] = i;
const VLQ_BASE_SHIFT = 5;
const VLQ_BASE_MASK = (1 << VLQ_BASE_SHIFT) - 1;
const VLQ_CONTINUATION_MASK = 1 << VLQ_BASE_SHIFT;

class StringCharIterator {
  constructor(string) {
    this._string = string;
    this._position = 0;
  }
  next() {
    return this._string.charAt(this._position++);
  }
  peek() {
    return this._string.charAt(this._position);
  }
  hasNext() {
    return this._position < this._string.length;
  }
}

function isSeparator(char) {
  return char === ',' || char === ';';
}

function decodeVLQ(stringCharIterator) {
  let result = 0;
  let shift = 0;
  let digit;
  do {
    digit = base64Map[stringCharIterator.next()];
    result += (digit & VLQ_BASE_MASK) << shift;
    shift += VLQ_BASE_SHIFT;
  } while (digit & VLQ_CONTINUATION_MASK);
  const negative = result & 1;
  result >>= 1;
  return negative ? -result : result;
}

function compareSourceMapEntry(entry1, entry2) {
  if (entry1[0] !== entry2[0]) return entry1[0] - entry2[0];
  return entry1[1] - entry2[1];
}

function cloneSourceMapV3(payload) {
  validateObject(payload, 'payload');
  payload = { ...payload };
  for (const key in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, key) &&
        Array.isArray(payload[key])) {
      payload[key] = payload[key].slice();
    }
  }
  return payload;
}

// Module-scope parse helpers (kept off SourceMap.prototype so the public
// surface matches Node's exactly).
function parseMappingPayload(sm) {
  if (sm._payload.sections) {
    for (const section of sm._payload.sections) {
      parseMap(sm, section.map, section.offset.line, section.offset.column);
    }
  } else {
    parseMap(sm, sm._payload, 0, 0);
  }
  sm._mappings.sort(compareSourceMapEntry);
}

function parseMap(sm, map, lineNumber, columnNumber) {
  let sourceIndex = 0;
  let sourceLineNumber = 0;
  let sourceColumnNumber = 0;
  let nameIndex = 0;

  const sources = [];
  for (let i = 0; i < map.sources.length; ++i) {
    const url = map.sources[i];
    sources.push(url);
    sm._sources[url] = true;
    if (map.sourcesContent && map.sourcesContent[i]) {
      sm._sourceContentByURL[url] = map.sourcesContent[i];
    }
  }

  const stringCharIterator = new StringCharIterator(map.mappings || '');
  let sourceURL = sources[sourceIndex];
  while (true) {
    if (stringCharIterator.peek() === ',') {
      stringCharIterator.next();
    } else {
      while (stringCharIterator.peek() === ';') {
        lineNumber += 1;
        columnNumber = 0;
        stringCharIterator.next();
      }
      if (!stringCharIterator.hasNext()) break;
    }

    columnNumber += decodeVLQ(stringCharIterator);
    if (isSeparator(stringCharIterator.peek())) {
      sm._mappings.push([lineNumber, columnNumber]);
      continue;
    }

    const sourceIndexDelta = decodeVLQ(stringCharIterator);
    if (sourceIndexDelta) {
      sourceIndex += sourceIndexDelta;
      sourceURL = sources[sourceIndex];
    }
    sourceLineNumber += decodeVLQ(stringCharIterator);
    sourceColumnNumber += decodeVLQ(stringCharIterator);

    let name;
    if (!isSeparator(stringCharIterator.peek())) {
      nameIndex += decodeVLQ(stringCharIterator);
      name = map.names ? map.names[nameIndex] : undefined;
    }

    sm._mappings.push([
      lineNumber,
      columnNumber,
      sourceURL,
      sourceLineNumber,
      sourceColumnNumber,
      name,
    ]);
  }
}

class SourceMap {
  constructor(payload, { lineLengths } = {}) {
    this._payload = cloneSourceMapV3(payload);
    this._mappings = [];
    this._sources = {};
    this._sourceContentByURL = {};
    this._lineLengths = undefined;
    parseMappingPayload(this);
    if (Array.isArray(lineLengths) && lineLengths.length) {
      this._lineLengths = lineLengths;
    }
  }

  get payload() {
    return cloneSourceMapV3(this._payload);
  }

  get lineLengths() {
    if (this._lineLengths) return this._lineLengths.slice();
    return undefined;
  }

  findEntry(lineOffset, columnOffset) {
    let first = 0;
    let count = this._mappings.length;
    while (count > 1) {
      const step = count >> 1;
      const middle = first + step;
      const mapping = this._mappings[middle];
      if (lineOffset < mapping[0] ||
          (lineOffset === mapping[0] && columnOffset < mapping[1])) {
        count = step;
      } else {
        first = middle;
        count -= step;
      }
    }
    const entry = this._mappings[first];
    if (!first && entry && (lineOffset < entry[0] ||
        (lineOffset === entry[0] && columnOffset < entry[1]))) {
      return {};
    } else if (!entry) {
      return {};
    }
    return {
      generatedLine: entry[0],
      generatedColumn: entry[1],
      originalSource: entry[2],
      originalLine: entry[3],
      originalColumn: entry[4],
      name: entry[5],
    };
  }

  findOrigin(lineNumber, columnNumber) {
    const range = this.findEntry(lineNumber - 1, columnNumber - 1);
    if (range.originalSource === undefined ||
        range.originalLine === undefined ||
        range.originalColumn === undefined ||
        range.generatedLine === undefined ||
        range.generatedColumn === undefined) {
      return {};
    }
    const lineOffset = lineNumber - range.generatedLine;
    const columnOffset = columnNumber - range.generatedColumn;
    return {
      name: range.name,
      fileName: range.originalSource,
      lineNumber: range.originalLine + lineOffset,
      columnNumber: range.originalColumn + columnOffset,
    };
  }
}

// Registry of source maps discovered while compiling modules.
const sourceMapRegistry = new Map();

function base64ToUtf8(b64) {
  if (typeof globalThis.atob !== 'function') return undefined;
  try {
    const bin = globalThis.atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch { return undefined; }
}

function maybeRegisterSourceMap(filename, content) {
  try {
    const match = /sourceMappingURL\s*=\s*(\S+)/.exec(content);
    if (!match) return;
    const url = match[1].trim();
    let data;
    if (url.startsWith('data:')) {
      const b64Index = url.indexOf('base64,');
      if (b64Index === -1) return;
      const json = base64ToUtf8(url.slice(b64Index + 'base64,'.length));
      if (json === undefined) return;
      data = JSON.parse(json);
    } else {
      const mapPath = posixResolve(posixDirname(filename), url);
      data = JSON.parse(stripBOM(readFileText(mapPath)));
    }
    const entry = { data, sourceMap: undefined };
    sourceMapRegistry.set(filename, entry);
    sourceMapRegistry.set(`file://${filename}`, entry);
  } catch { /* source maps are best-effort */ }
}

function findSourceMap(sourceURL) {
  if (typeof sourceURL !== 'string') return undefined;
  // No source maps for builtin modules.
  if (sourceURL.startsWith('node:')) return undefined;
  const entry = sourceMapRegistry.get(sourceURL);
  if (!entry || entry.data == null) return undefined;
  if (entry.sourceMap === undefined) {
    entry.sourceMap = new SourceMap(entry.data);
  }
  return entry.sourceMap;
}

// ---------------------------------------------------------------------------
// Module customization hooks — validated like Node's, but there is no CJS
// loader pipeline in the browser for hooks to plug into, so registration is
// a documented noop.
// ---------------------------------------------------------------------------
class ModuleHooks {
  constructor(resolve, load) {
    this.resolve = resolve;
    this.load = load;
  }
}

function registerHooks(hooks) {
  // Destructuring throws a TypeError for undefined/null, like Node's.
  const { resolve, load } = hooks;
  if (resolve) validateFunction(resolve, 'hooks.resolve');
  if (load) validateFunction(load, 'hooks.load');
  return new ModuleHooks(resolve, load);
}

// Node's register() installs ESM loader hooks; unimplementable in the
// sandbox. Validates the specifier, then noops.
function register(specifier, parentURL, options) {
  if (specifier === undefined || specifier === null) {
    // Plain TypeError with a code (matches Node's ESM-resolve error: no
    // [CODE] in the string form).
    const e = new TypeError(
      `Failed to resolve module specifier "${specifier}" from "data:": ` +
      'Invalid relative URL or base scheme is not hierarchical.',
    );
    e.code = 'ERR_UNSUPPORTED_RESOLVE_REQUEST';
    throw stampCode(e, false);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// findPackageJSON — argument validation mirrors Node's; lookup runs against
// the FS backend (virtual FS in the sandbox, real fs under Node).
// ---------------------------------------------------------------------------
function findPackageJSON(specifier, base = 'data:') {
  if (arguments.length === 0) {
    throw errMissingArgs('specifier');
  }
  let spec;
  try {
    spec = `${specifier}`;
  } catch {
    throw errInvalidArgType('specifier', 'string', specifier);
  }

  let basePath;
  let baseHref;
  let baseFileUrl;
  if (isURLObject(base)) {
    baseHref = base.href;
    baseFileUrl = base;
    basePath = fileURLToPathShim(base); // throws ERR_INVALID_URL_SCHEME
  } else {
    validateString(base, 'base');
    baseHref = base;
    if (posixIsAbsolute(base)) {
      basePath = base;
      baseFileUrl = new URL(`file://${base}`);
    } else {
      let url;
      try {
        url = new URL(base);
      } catch {
        // Node's URL parse errors are TypeErrors carrying ERR_INVALID_URL
        // but with no [CODE] in the string form.
        throw typeError('ERR_INVALID_URL', 'Invalid URL', false);
      }
      baseHref = url.href;
      baseFileUrl = url;
      basePath = fileURLToPathShim(url); // throws ERR_INVALID_URL_SCHEME
    }
  }

  if (normalizeRequirableId(spec) !== undefined) {
    // Matches Node's quirk: builtins fail inside defaultResolve with
    // ERR_INVALID_URL_SCHEME.
    throw typeError('ERR_INVALID_URL_SCHEME', 'The URL must be of scheme file');
  }

  const errModuleNotFound = (isPackage, target) => {
    const e = new Error(
      isPackage
        ? `Cannot find package '${spec}' imported from ${baseHref}`
        : `Cannot find module '${target}' imported from ${baseHref}`,
    );
    e.code = 'ERR_MODULE_NOT_FOUND';
    throw e;
  };

  let startDir;
  const bare = spec !== '' && spec.charAt(0) !== '.' && spec.charAt(0) !== '/' &&
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec);
  if (bare) {
    // Walk node_modules folders for the package directory.
    let dir = posixDirname(basePath);
    let pkgDir;
    while (true) {
      const candidate = posixJoin(dir, 'node_modules', spec);
      if (_stat(candidate) === 1) {
        pkgDir = candidate;
        break;
      }
      const parent = posixDirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!pkgDir) errModuleNotFound(true);
    startDir = pkgDir;
  } else {
    // The base acts as a URL: a trailing slash makes it a directory, so a
    // relative specifier resolves against the base itself, not its dirname.
    // (Verified against Node v24.20.0.)
    let targetUrl;
    try {
      targetUrl = new URL(spec, baseFileUrl);
    } catch {
      throw new TypeError('Invalid URL');
    }
    const target = fileURLToPathShim(targetUrl); // throws ERR_INVALID_URL_SCHEME
    if (_stat(target) < 0) errModuleNotFound(false, target);
    startDir = posixDirname(target);
  }

  let dir = startDir;
  while (true) {
    const candidate = posixJoin(dir, 'package.json');
    if (_stat(candidate) === 0) return candidate;
    const parent = posixDirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// stripTypeScriptTypes — validates like Node's; the actual type-stripping
// needs a TS parser (amaro) that cannot be dependency-free, so this is a
// documented passthrough. Emits no ExperimentalWarning in the browser.
// ---------------------------------------------------------------------------
// Like Node, the experimental warning fires once per process on first use.
let stripTypesWarningEmitted = false;
function emitStripTypesWarning() {
  if (stripTypesWarningEmitted) return;
  stripTypesWarningEmitted = true;
  try {
    if (typeof process !== 'undefined' &&
        typeof process.emitWarning === 'function') {
      process.emitWarning(
        'stripTypeScriptTypes is an experimental feature and might ' +
        'change at any time',
        // Real Node: name 'ExperimentalWarning', code undefined.
        'ExperimentalWarning',
      );
    }
  } catch { /* warning is best-effort */ }
}

function stripTypeScriptTypes(code, options = {}) {
  validateString(code, 'code');
  validateObject(options, 'options');
  const { mode = 'strip', sourceMap = false, sourceUrl = undefined } = options;
  if (mode !== 'strip' && mode !== 'transform') {
    throw typeError(
      'ERR_INVALID_ARG_VALUE',
      `The property 'options.mode' must be one of: 'strip', 'transform'. ` +
      `Received ${inspectValue(mode)}`,
    );
  }
  if (sourceMap !== false && sourceMap !== undefined) {
    throw typeError(
      'ERR_INVALID_ARG_VALUE',
      `The property 'options.sourceMap' must be one of: false, undefined. ` +
      `Received ${inspectValue(sourceMap)}`,
    );
  }
  if (sourceUrl !== undefined) {
    validateString(sourceUrl, 'options.sourceUrl');
  }
  // The experimental warning fires after validation, once per process.
  emitStripTypesWarning();
  // GAP: no TypeScript transformation is performed in the browser (that
  // needs a real TS parser); this is a validated passthrough. The
  // sourceUrl comment suffix is still honored.
  if (sourceUrl) {
    return `${code}\n\n//# sourceURL=${sourceUrl}`;
  }
  return code;
}

// ---------------------------------------------------------------------------
// Remaining surface.
// ---------------------------------------------------------------------------
function syncBuiltinESMExports() {
  // No-op in the browser.
}

function _debug() {
  // Deprecated in Node (DEP0077); noop here.
}

function runMain() {
  // No main-module execution concept in the sandbox.
}

function _preloadModules(_requests) {
  // No-op in the browser.
}

// Real Node's Module class when running under Node without a sandbox
// runtime (the parity lane). Used to alias mutable builtin state that
// official tests poke at directly (e.g. Module._pathCache).
function getRealModule() {
  try {
    if (typeof process !== 'undefined' &&
        typeof process.getBuiltinModule === 'function') {
      return process.getBuiltinModule('module');
    }
  } catch { /* browser-fallback lane: no native delegation */ }
  return undefined;
}

// ---------------------------------------------------------------------------
// Statics + exports.
// ---------------------------------------------------------------------------
Module.createRequire = createRequire;
Module.builtinModules = builtinModules;
Module.isBuiltin = isBuiltin;
Module._cache = _cache;
Module._extensions = _extensions;
// Under real Node (parity lane) this static aliases the real builtin's
// `_pathCache`: official tests reassign it to invalidate real resolution
// (`Module._pathCache = { __proto__: null }`). In the browser (or the
// no-delegation lane) it is our own store.
Object.defineProperty(Module, '_pathCache', {
  __proto__: null,
  configurable: true,
  enumerable: true,
  get() {
    const real = getRealModule();
    return real ? real._pathCache : _pathCache;
  },
  set(v) {
    const real = getRealModule();
    if (real) real._pathCache = v;
  },
});
Module._resolveFilename = _resolveFilename;
Module._nodeModulePaths = _nodeModulePaths;
Module._load = _load;
Module._findPath = _findPath;
Module._resolveLookupPaths = _resolveLookupPaths;
Module._initPaths = _initPaths;
Module._preloadModules = _preloadModules;
Module._readPackage = readPackageJson;
Module.syncBuiltinESMExports = syncBuiltinESMExports;
Module.findSourceMap = findSourceMap;
Module.SourceMap = SourceMap;
Module.wrap = wrap;
Module.wrapper = wrapper;
Module.Module = Module;
Module.runMain = runMain;
Module._debug = _debug;
Module._stat = _stat;
Module.globalPaths = globalPaths;
Module.register = register;
Module.registerHooks = registerHooks;
Module.constants = constants;
Module.enableCompileCache = enableCompileCache;
Module.getCompileCacheDir = getCompileCacheDir;
Module.flushCompileCache = flushCompileCache;
Module.getSourceMapsSupport = getSourceMapsSupport;
Module.setSourceMapsSupport = setSourceMapsSupport;
Module.findPackageJSON = findPackageJSON;
Module.stripTypeScriptTypes = stripTypeScriptTypes;
// Back-compat: the previous shim exposed the virtual FS snapshot here.
// Now a live getter so late-attached runtimes are honored.
Object.defineProperty(Module, 'fs', {
  __proto__: null,
  get: getFS,
  configurable: true,
});

export {
  Module,
  SourceMap,
  _cache,
  _debug,
  _extensions,
  _findPath,
  _initPaths,
  _load,
  _nodeModulePaths,
  _pathCache,
  _preloadModules,
  _resolveFilename,
  _resolveLookupPaths,
  builtinModules,
  constants,
  createRequire,
  enableCompileCache,
  findPackageJSON,
  findSourceMap,
  flushCompileCache,
  getCompileCacheDir,
  getSourceMapsSupport,
  globalPaths,
  isBuiltin,
  register,
  registerHooks,
  runMain,
  setSourceMapsSupport,
  stripTypeScriptTypes,
  syncBuiltinESMExports,
};

export default Module;
