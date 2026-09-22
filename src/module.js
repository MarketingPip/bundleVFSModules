export function createRequire(filename) {
  // Return a require function that can be used by modules
  return function require(id) {
    throw new Error(`Cannot find module '${id}' from '${filename}'`)
  }
}

export const builtinModules = [
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib"
]

export function isBuiltin(id) {
  const stripped = id.startsWith("node:") ? id.slice(5) : id;
  if (builtinModules.includes(stripped)) return true;
  const slash = stripped.indexOf("/");
  if (slash !== -1) {
    return builtinModules.includes(stripped.slice(0, slash));
  }
  return false;
}

export const _cache = {}
export const _extensions = {
  ".js": () => {},
  ".json": () => {},
  ".node": () => {}
}
export const _pathCache = {}

export function syncBuiltinESMExports() {
  // No-op in browser
}

export function _resolveFilename(
  request,
  _parent,
  _isMain,
  _options,
) {
  return request;
}


export function _nodeModulePaths(from) {
  const parts = from.split("/").filter(Boolean);
  const paths = [];
  for (let i = parts.length; i > 0; i--) {
    const dir = "/" + parts.slice(0, i).join("/");
    if (parts[i - 1] !== "node_modules") {
      paths.push(dir + "/node_modules");
    }
  }
  paths.push("/node_modules");
  return paths;
}

export function _load(
  request,
  _parent,
  _isMain,
) {
  throw new Error(`Cannot load module '${request}'`);
}

export function _findPath(
  request,
  _paths,
  _isMain,
) {
  return request;
}

export function wrap(script) {
  return (
    "(function (exports, require, module, __filename, __dirname) { " +
    script +
    "\n});"
  );
}

export const wrapper = [
  "(function (exports, require, module, __filename, __dirname) { ",
  "\n});",
];




export function findSourceMap(_path) {
  return undefined;
}

export class SourceMap {
  constructor(payload) {
    this.payload = payload;
  }
  findEntry(_line, _column) {
    return undefined;
  }
}

export function Module(id, parent) {
  this.id = id || "";
  this.filename = id || "";
  this.loaded = false;
  this.parent = parent || null;
  this.children = [];
  this.exports = {};
  this.paths = [];
}

Module.prototype.require = function (specifier) {
  throw new Error(
    `Cannot resolve module '${specifier}' from '${this.filename}'`,
  );
};

Module.prototype.load = function (_filename) {
  this.loaded = true;
};

Module.prototype._compile = function (
  _content,
  _filename,
) {};

Module.createRequire = createRequire;
Module.builtinModules = builtinModules;
Module.isBuiltin = isBuiltin;
Module._cache = _cache;
Module._extensions = _extensions;
Module._pathCache = _pathCache;
Module._resolveFilename = _resolveFilename;
Module._nodeModulePaths = _nodeModulePaths;
Module._load = _load;
Module._findPath = _findPath;
Module.syncBuiltinESMExports = syncBuiltinESMExports;
Module.findSourceMap = findSourceMap;
Module.SourceMap = SourceMap;
Module.wrap = wrap;
Module.wrapper = wrapper;
Module.Module = Module; 
Module.runMain = function () {}; 
Module._preloadModules = function (_requests) {}; 
Module._initPaths = function () {}; 
Module.globalPaths = ["/node_modules"];

export default Module;
