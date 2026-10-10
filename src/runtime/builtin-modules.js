// Dual-lane import (pattern from src/plugins/typescript.js):
// - Under Node (tests, direct import): Node's own builtin list via
//   node:module (the npm `builtin-modules` package is not a dependency).
// - In the browser host page: https://esm.sh/builtin-modules — the exact
//   specifier runtime.js used.
function isNodeLane() {
  return (
    typeof process !== "undefined" &&
    process.versions &&
    typeof process.versions.node === "string"
  );
}

const _builtinModules = isNodeLane()
  ? (await import("node:module")).builtinModules
  : (await import("https://esm.sh/builtin-modules")).default;

export const builtinModules = [
  ..._builtinModules,
  ...[
    "_http_agent",
    "_http_client",
    "_http_common",
    "_http_incoming",
    "_http_outgoing",
    "_http_server",
    "_stream_duplex",
    "_stream_passthrough",
    "_stream_readable",
    "_stream_transform",
    "_stream_wrap",
    "_stream_writable",
    "_tls_common",
    "_tls_wrap",
    "assert",
    "assert/strict",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "dns/promises",
    "domain",
    "events",
    "fs",
    "fs/promises",
    "http",
    "http2",
    "https",
    "inspector",
    "inspector/promises",
    "module",
    "net",
    "os",
    "path",
    "path/posix",
    "path/win32",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "readline/promises",
    "repl",
    "stream",
    "stream/consumers",
    "stream/promises",
    "stream/web",
    "string_decoder",
    "sys",
    "timers",
    "timers/promises",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "util/types",
    "v8",
    "vm",
    "wasi",
    "worker_threads",
    "zlib",
    "node:sea",
    "node:sqlite",
    "node:test",
    "node:test/reporters",
  ],
];

builtinModules.push("RUNTIME:NODE_GLOBALS");

/* TODO 
- Add support for Workers etc to use 'file:///worker.js' etc. (intercept all methods that needs fs.)
- Fix util/types to match current spec
- Fix timers/promises
- Fix fs/promises (to write fs out)
- Fix Requires Under Imports
  
- Use Format Error On All Error (Persisent Errors)  

- Possible handler for dynamic imports (relative path)
*/
