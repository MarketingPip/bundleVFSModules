/**
 * Toolchain plugin registration API (roadmap §1).
 *
 * Philosophy (non-negotiable): core NEVER ships a toolchain and never knows
 * what clang is. Core only knows "compile sources → wasm bytes" and "run
 * wasm bytes on my VFS". A *toolchain plugin* is written by library USERS
 * (host developers), not by us — it adapts any compiler (clang, rustc, …)
 * to the compile contract below. No esbuild-wasm. No N-API promises.
 *
 * This module is HOST-SIDE ONLY, mirroring src/plugins.js: `registerPlugin`
 * is the precedent this API follows (module-global registry, string-name
 * uniqueness, unregister by name). Registration cannot live on the
 * sandbox-side `globalThis._RUNTIME_` object: the sandbox↔host channel is
 * postMessage, and a JS `compile` function cannot cross it (structured
 * clone rejects functions). Compilation is also heavy host-side work
 * (lazy-loaded WASI toolchain builds, tens of MB) — per docs/PLUGINS.md,
 * plugins run parent-side. A sandbox-side registerToolchain would
 * silently fail to affect the host pipeline, which violates the
 * no-silent-fakes rule (AGENTS.md rule 7), so it is deliberately absent.
 *
 * What a toolchain is:
 *   {
 *     name: string,                    // required, unique (e.g. "wasi-clang")
 *     compile: async (files, opts) =>  // required; the compile contract
 *       result,
 *     sysroot?: string |              // VFS path (lazy-mount follow-up seam)
 *       Record<string, string|Uint8Array>, // …or file map (supported now)
 *     extensions?: string[],          // e.g. [".c",".h"]; drives the
 *                                      // module-resolution bridge
 *     target?: string,                // default target triple ("wasm32-wasi")
 *     matchBareSpecifier?: boolean,   // probe "./x"+ext for bare "./x"
 *                                      // (default: true when extensions set)
 *     readFile?: (absPath) =>          // host VFS accessor for multi-file
 *       Promise<string|Uint8Array|null>,// builds (optional)
 *     exists?: (absPath) =>           // host VFS accessor for bare-specifier
 *       Promise<boolean>,             // probing (optional)
 *   }
 *
 * Registering a toolchain auto-installs a resolution bridge plugin
 * (docs/PLUGINS.md Part B onResolve/onLoad) named
 * `__toolchain_bridge:<name>`, so `import "./add.c"` /
 * `require("./native-addon")` compiles via the toolchain and instantiates
 * the result through the existing "wasm" loader. Unregistering removes the
 * bridge. Spec: docs/TOOLCHAIN.md.
 */

import { registerPlugin, unregisterPlugin } from "./plugins.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error thrown by (or on behalf of) a toolchain. Mirrors PluginError:
 * carries the toolchain name and source location so the pipeline can
 * attribute failures.
 */
export class ToolchainError extends Error {
  constructor(toolchain, message, { file, line, column } = {}) {
    const loc = file
      ? ` (${file}${line != null ? `:${line}` : ""}${column != null ? `:${column}` : ""})`
      : "";
    super(`[toolchain:${toolchain}] ${message}${loc}`);
    this.name = "ToolchainError";
    this.toolchain = toolchain;
    this.file = file;
    this.line = line;
    this.column = column;
  }
}

// ---------------------------------------------------------------------------
// Registry (mirrors src/plugins.js)
// ---------------------------------------------------------------------------

const toolchains = new Map();

/** Bridge plugin name for a toolchain (deterministic, for removal). */
export function toolchainBridgeName(name) {
  return `__toolchain_bridge:${name}`;
}

/** Namespace tag the bridge claims resolved paths with. */
export function toolchainNamespace(name) {
  return `toolchain:${name}`;
}

/**
 * Validate a toolchain record's shape. Returns true when valid; throws
 * TypeError otherwise. Used by registerToolchain and by hosts that build
 * records programmatically.
 */
export function validateToolchain(tc) {
  if (!tc || typeof tc !== "object" || Array.isArray(tc)) {
    throw new TypeError(
      "Toolchain must be an object { name, compile(files, opts), sysroot? }",
    );
  }
  if (typeof tc.name !== "string" || tc.name.length === 0) {
    throw new TypeError("Toolchain must have a non-empty string 'name'");
  }
  if (typeof tc.compile !== "function") {
    throw new TypeError(
      `Toolchain '${tc.name}' must provide a 'compile(files, opts)' function`,
    );
  }
  if (tc.sysroot !== undefined && tc.sysroot !== null) {
    const s = tc.sysroot;
    const isMap =
      typeof s === "object" && !Array.isArray(s) && !(s instanceof Uint8Array);
    if (typeof s !== "string" && !isMap) {
      throw new TypeError(
        `Toolchain '${tc.name}': 'sysroot' must be a VFS path string or a file map { "/path": contents }`,
      );
    }
    if (typeof s === "string" && !s.startsWith("/")) {
      throw new TypeError(
        `Toolchain '${tc.name}': string 'sysroot' must be an absolute VFS path`,
      );
    }
    if (isMap) {
      for (const [k, v] of Object.entries(s)) {
        if (typeof v !== "string" && !(v instanceof Uint8Array)) {
          throw new TypeError(
            `Toolchain '${tc.name}': sysroot file '${k}' must be a string or Uint8Array`,
          );
        }
      }
    }
  }
  if (tc.extensions !== undefined) {
    if (
      !Array.isArray(tc.extensions) ||
      tc.extensions.some((e) => typeof e !== "string" || !e.startsWith("."))
    ) {
      throw new TypeError(
        `Toolchain '${tc.name}': 'extensions' must be an array of dot-prefixed strings like [".c"]`,
      );
    }
  }
  if (tc.target !== undefined && typeof tc.target !== "string") {
    throw new TypeError(`Toolchain '${tc.name}': 'target' must be a string`);
  }
  for (const key of ["readFile", "exists"]) {
    if (tc[key] !== undefined && typeof tc[key] !== "function") {
      throw new TypeError(
        `Toolchain '${tc.name}': '${key}' must be a function`,
      );
    }
  }
  return true;
}

/**
 * Register a toolchain. Validates shape, rejects duplicate names (same
 * precedent as registerPlugin), and auto-installs the module-resolution
 * bridge plugin. Returns an unregister handle
 * `{ name, unregister() }`; `unregisterToolchain(name)` also works.
 */
export function registerToolchain(tc) {
  validateToolchain(tc);
  if (toolchains.has(tc.name)) {
    throw new Error(`Toolchain '${tc.name}' is already registered`);
  }
  toolchains.set(tc.name, tc);
  try {
    registerPlugin(toolchainBridgePlugin(tc));
  } catch (err) {
    toolchains.delete(tc.name); // all-or-nothing: never half-registered
    throw err;
  }
  return { name: tc.name, unregister: () => unregisterToolchain(tc.name) };
}

/**
 * Remove a toolchain and its resolution bridge. Returns true when a
 * toolchain by that name existed.
 */
export function unregisterToolchain(name) {
  const existed = toolchains.delete(name);
  unregisterPlugin(toolchainBridgeName(name));
  return existed;
}

/** Look up a toolchain by name (undefined when absent). */
export function getToolchain(name) {
  return toolchains.get(name);
}

/** Throw ToolchainError when the toolchain is unknown. */
export function requireToolchain(name) {
  const tc = toolchains.get(name);
  if (!tc) throw new ToolchainError(name, `unknown toolchain '${name}'`);
  return tc;
}

/** Snapshot of registered toolchains, in registration order. */
export function getToolchains() {
  return [...toolchains.values()];
}

/** Remove all toolchains and their bridges (tests use this in beforeEach). */
export function clearToolchains() {
  for (const name of [...toolchains.keys()]) unregisterToolchain(name);
}

// ---------------------------------------------------------------------------
// The compile contract
// ---------------------------------------------------------------------------

function toWasmBytes(bytes, toolchainName) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    bytes instanceof SharedArrayBuffer
  ) {
    return new Uint8Array(bytes);
  }
  throw new ToolchainError(
    toolchainName,
    "compile result 'bytes' must be a Uint8Array (or ArrayBuffer)",
  );
}

function defaultEntry(files, extensions) {
  const keys = Object.keys(files);
  const exts = (extensions ?? []).map((e) => e.toLowerCase());
  return (
    keys.find((k) => exts.some((e) => k.toLowerCase().endsWith(e))) ?? keys[0]
  );
}

/**
 * Compile sources with a registered toolchain.
 *
 * `files`: `{ "main.c": "...", "lib/util.c": <Uint8Array> }` — keys are
 * project-relative POSIX paths, values are UTF-8 source text or raw bytes.
 *
 * `opts` (toolchain-agnostic; a rustc plugin maps these onto its own
 * flags — see docs/TOOLCHAIN.md):
 *   {
 *     entry?: string,          // entry source file (default: first file
 *                              // matching the toolchain's extensions)
 *     cflags?: string[],       // raw compiler flags, e.g. ["-O2","-Wall"]
 *     ldflags?: string[],      // raw linker flags
 *     target?: string,         // target triple (default: toolchain.target
 *                              // ?? "wasm32-wasi")
 *     output?: string,        // desired output name (default "a.out.wasm")
 *     env?: Record<string,string>,
 *     sysroot?: ...,          // override the registered sysroot
 *     sysrootMount?: string,   // where the host mounted it (set by
 *                              // CodeSandbox.compileToolchain)
 *     toolchainOpts?: object,  // escape hatch for toolchain-specific knobs
 *   }
 *
 * Returns `{ bytes, warnings, errors: [], stdout, stderr, elapsedMs }`.
 * `bytes` is the linked wasm module (wasm32-wasi preview1 for C-like
 * toolchains). When compilation fails, the toolchain reports
 * `{ errors: [{file?,line?,column?,message}] }` and this function throws
 * ToolchainError carrying the full `errors` array on `err.errors`.
 */
export async function compileWithToolchain(nameOrTc, files, opts = {}) {
  const tc =
    typeof nameOrTc === "object" && nameOrTc !== null
      ? nameOrTc
      : requireToolchain(nameOrTc);
  validateToolchain(tc);

  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new ToolchainError(
      tc.name,
      "compile files must be an object map of path -> source",
    );
  }
  const keys = Object.keys(files);
  if (keys.length === 0) {
    throw new ToolchainError(tc.name, "compile files must not be empty");
  }
  for (const k of keys) {
    const v = files[k];
    if (typeof v !== "string" && !(v instanceof Uint8Array)) {
      throw new ToolchainError(
        tc.name,
        `file '${k}' must be a string or Uint8Array`,
        { file: k },
      );
    }
  }

  const entry = opts.entry ?? defaultEntry(files, tc.extensions);
  const mergedOpts = {
    target: tc.target ?? "wasm32-wasi",
    ...opts,
    entry,
    sysroot: opts.sysroot ?? tc.sysroot,
  };

  let result;
  try {
    result = await tc.compile(files, mergedOpts);
  } catch (err) {
    if (err instanceof ToolchainError) throw err;
    throw new ToolchainError(
      tc.name,
      `compile threw: ${err && err.message ? err.message : String(err)}`,
    );
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new ToolchainError(
      tc.name,
      "compile must resolve to a result object { bytes, warnings?, errors? }",
    );
  }
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (errors.length > 0) {
    const first = errors[0] ?? {};
    const err = new ToolchainError(
      tc.name,
      first.message ? String(first.message) : "compilation failed",
      { file: first.file, line: first.line, column: first.column },
    );
    err.errors = errors;
    err.warnings = warnings;
    throw err;
  }
  return {
    bytes: toWasmBytes(result.bytes, tc.name),
    warnings,
    errors: [],
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    elapsedMs:
      typeof result.elapsedMs === "number" ? result.elapsedMs : undefined,
  };
}

// ---------------------------------------------------------------------------
// Sysroot
// ---------------------------------------------------------------------------

/**
 * Mount prefix for toolchain sysroots inside the sandbox VFS.
 * A toolchain named "wasi-clang" mounts at "/.sysroot/wasi-clang/...".
 */
export const SYSROOT_MOUNT_PREFIX = "/.sysroot";

/**
 * Normalize a toolchain's sysroot to a flat file map
 * `{ "/usr/include/stdio.h": contents }`.
 *
 * File-map sysroots are supported now. A string (VFS path) sysroot needs
 * the read-only lazy mount seam (roadmap follow-up — see docs/TOOLCHAIN.md
 * § "Sysroot mounting" for the interface it must satisfy) and throws a
 * clear ToolchainError until that seam lands. No silent partial mounts.
 */
export function resolveSysrootFileMap(tc) {
  validateToolchain(tc);
  const sysroot = tc.sysroot;
  if (sysroot == null) return {};
  if (typeof sysroot === "string") {
    throw new ToolchainError(
      tc.name,
      `string sysroot '${sysroot}' requires the read-only lazy mount seam ` +
        `(roadmap follow-up); provide sysroot as a file map ` +
        `{ "/path": contents } for now`,
    );
  }
  const out = {};
  for (const [k, v] of Object.entries(sysroot)) {
    out[k.startsWith("/") ? k : `/${k}`] = v;
  }
  return out;
}

// seed object -> Set<toolchain name> (idempotent mounts)
const mountedSysroots = new WeakMap();

/**
 * Merge a toolchain's sysroot file map into a VFS seed object (e.g.
 * `sandbox.config.fs`) under `/.sysroot/<name>/...`. Idempotent per
 * (seed, toolchain) pair. The mount is READ-ONLY BY CONVENTION: hosts
 * must not write under the prefix, and the lazy-mount follow-up seam
 * will enforce it. Returns the mount prefix.
 */
export function mountSysrootIntoSeed(tc, seed) {
  validateToolchain(tc);
  if (!seed || typeof seed !== "object" || Array.isArray(seed)) {
    throw new TypeError("mountSysrootIntoSeed: seed must be an object");
  }
  const prefix = `${SYSROOT_MOUNT_PREFIX}/${tc.name}`;
  let mounted = mountedSysroots.get(seed);
  if (!mounted) {
    mounted = new Set();
    mountedSysroots.set(seed, mounted);
  }
  if (mounted.has(tc.name)) return prefix;
  const files = resolveSysrootFileMap(tc);
  for (const [p, contents] of Object.entries(files)) {
    seed[`${prefix}${p}`] = contents;
  }
  mounted.add(tc.name);
  return prefix;
}

/** Whether the toolchain's sysroot is already mounted into the seed. */
export function isSysrootMounted(name, seed) {
  const mounted = mountedSysroots.get(seed);
  return !!mounted && mounted.has(name);
}

// ---------------------------------------------------------------------------
// Module-resolution bridge (docs/PLUGINS.md Part B)
// ---------------------------------------------------------------------------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toAbsolute(p, importer) {
  if (p.startsWith("/")) return p;
  if (importer && (p.startsWith("./") || p.startsWith("../"))) {
    const parts = importer.split("/").slice(0, -1);
    for (const seg of p.split("/")) {
      if (seg === "" || seg === ".") continue;
      else if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return `/${parts.filter(Boolean).join("/")}`;
  }
  return p;
}

/**
 * Build the Part B plugin that wires a toolchain into module resolution.
 * Exported so hosts with per-sandbox plugin lists (which shadow the global
 * registry) can install it explicitly.
 *
 * Decision flow per specifier:
 *   1. Ends with a registered extension (e.g. "./add.c") → claim with
 *      namespace `toolchain:<name>`; onLoad compiles via the toolchain and
 *      returns `{ contents: <wasm bytes>, loader: "wasm" }`.
 *   2. Bare specifier with no extension (e.g. require("./native-addon")) →
 *      probe `<specifier><ext>` for each extension through the toolchain's
 *      `exists(absPath)` accessor; first hit is claimed (path rewritten to
 *      the hit). No `exists` accessor → pass through untouched so the
 *      default resolver raises an honest MODULE_NOT_FOUND instead of a
 *      late, confusing compile error.
 *   3. No claim → default VFS → node_modules → CDN resolution proceeds.
 */
export function toolchainBridgePlugin(tc) {
  validateToolchain(tc);
  const ns = toolchainNamespace(tc.name);
  const exts = [...(tc.extensions ?? [])];
  const extFilter = exts.length
    ? new RegExp(`(?:${exts.map(escapeRegExp).join("|")})$`, "i")
    : null;

  const onResolve = [];
  if (extFilter) {
    onResolve.push({
      filter: extFilter,
      namespace: ns,
      resolve: (args) => ({ path: args.path, namespace: ns }),
    });
  }
  if (exts.length && tc.matchBareSpecifier !== false) {
    onResolve.push({
      namespace: ns,
      resolve: async (args) => {
        const spec = args.path;
        const base = spec.split("/").pop();
        // Only probe bare specifiers: no extension on the final segment.
        if (
          !base ||
          base === "." ||
          base === ".." ||
          /\.[A-Za-z0-9]+$/.test(base)
        ) {
          return undefined;
        }
        if (typeof tc.exists !== "function") return undefined;
        for (const ext of exts) {
          const candidate = `${spec}${ext}`;
          let hit = false;
          try {
            hit = await tc.exists(toAbsolute(candidate, args.importer));
          } catch {
            hit = false;
          }
          if (hit) return { path: candidate, namespace: ns };
        }
        return undefined;
      },
    });
  }

  return {
    name: toolchainBridgeName(tc.name),
    onResolve,
    onLoad: [
      {
        // No extensions → never match (toolchain is compile-only then).
        filter: extFilter ?? /$^/,
        namespace: ns,
        load: async (args) => {
          const entryBase = args.path.split("/").pop();
          let source = args.source;
          if (typeof source !== "string" || source.length === 0) {
            if (typeof tc.readFile === "function") {
              try {
                source = await tc.readFile(toAbsolute(args.path, null));
              } catch {
                source = null;
              }
            }
          }
          if (typeof source !== "string" || source.length === 0) {
            throw new ToolchainError(
              tc.name,
              `cannot load sources for '${args.path}': no text source reached ` +
                `onLoad and no readFile accessor is configured`,
              { file: args.path },
            );
          }
          const { bytes } = await compileWithToolchain(
            tc,
            { [entryBase]: source },
            { entry: entryBase },
          );
          return { contents: bytes, loader: "wasm" };
        },
      },
    ],
  };
}
