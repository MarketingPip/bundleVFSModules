const virtualFs = (globalThis._RUNTIME_ && globalThis._RUNTIME_.__FS__) || {};

// Wire up process.binding for natives lookup
globalThis.process = globalThis.process || {};
globalThis.process.binding = globalThis.process.binding || function (name) {
  if (name === "natives") {
    return builtinModules.reduce((acc, mod) => {
      acc[mod] = true;
      return acc;
    }, {});
  }
  return {};
};

export function createRequire(filename) {
  return function require(id) {
    // If virtualFs can resolve/load, you can hook it here too
    throw new Error(`Cannot find module '${id}' from '${filename}'`);
  };
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
];

export function isBuiltin(id) {
  const stripped = id.startsWith("node:") ? id.slice(5) : id;
  if (builtinModules.includes(stripped)) return true;
  const slash = stripped.indexOf("/");
  if (slash !== -1) {
    return builtinModules.includes(stripped.slice(0, slash));
  }
  return false;
}

export const _cache = {};
export const _extensions = {
  ".js": (module, filename) => {
    if (virtualFs && typeof virtualFs.readFileSync === "function") {
      const content = virtualFs.readFileSync(filename, "utf8");
      module._compile(content, filename);
    }
  },
  ".json": (module, filename) => {
    if (virtualFs && typeof virtualFs.readFileSync === "function") {
      const content = virtualFs.readFileSync(filename, "utf8");
      module.exports = JSON.parse(content);
    }
  },
  ".node": () => {}
};
export const _pathCache = {};

export function syncBuiltinESMExports() {
  // No-op in browser
}

export function _resolveFilename(request, parent, isMain, options) {
  const resolved = _findPath(request, parent && parent.paths);
  if (!resolved) {
    throw new Error(`Cannot find module '${request}'`);
  }
  return resolved;
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

export function _load(request, parent, isMain) {
  const filename = _resolveFilename(request, parent, isMain);
  
  if (_cache[filename]) {
    return _cache[filename].exports;
  }

  const module = new Module(filename, parent);
  _cache[filename] = module;

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

export function _findPath(request, paths, _isMain) {
  // If virtualFs isn't fully implemented with sync methods, fall back
  if (!virtualFs || typeof virtualFs.existsSync !== "function") {
    return request;
  }

  const extensions = Object.keys(_extensions);
  const candidates = [];

  // Direct check or absolute path
  candidates.push(request);
  for (const ext of extensions) {
    candidates.push(request + ext);
  }

  // Check search paths if provided
  if (paths && Array.isArray(paths)) {
    for (const p of paths) {
      const base = p + "/" + request;
      candidates.push(base);
      for (const ext of extensions) {
        candidates.push(base + ext);
      }
    }
  }

  for (const candidate of candidates) {
    try {
      if (virtualFs.existsSync(candidate)) {
        const stat = virtualFs.statSync ? virtualFs.statSync(candidate) : null;
        if (!stat || !stat.isDirectory()) {
          return candidate;
        }
      }
    } catch (e) {
      // Ignore filesystem access errors during probing
    }
  }

  return false;
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
  return _load(specifier, this, false);
};

Module.prototype.load = function (filename) {
  this.filename = filename;
  this.paths = _nodeModulePaths(filename);

  const extension = filename.substring(filename.lastIndexOf("."));
  const loader = _extensions[extension] || _extensions[".js"];
  loader(this, filename);
  this.loaded = true;
};

Module.prototype._compile = function (content, filename) {
  const wrapperFn = new Function(
    "exports",
    "require",
    "module",
    "__filename",
    "__dirname",
    content
  );
  
  const dirname = filename.substring(0, filename.lastIndexOf("/")) || "/";
  const req = createRequire(filename);
  
  wrapperFn(this.exports, req, this, filename, dirname);
};

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

Module.fs = virtualFs;

export default Module;
