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

export function isBuiltin(moduleName) {
  // Strip node: prefix if present
  const name = moduleName.startsWith("node:") ? moduleName.slice(5) : moduleName
  return builtinModules.includes(name)
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

export const Module = {
  createRequire,
  builtinModules,
  isBuiltin,
  _cache,
  _extensions,
  _pathCache,
  syncBuiltinESMExports
}

export default Module
