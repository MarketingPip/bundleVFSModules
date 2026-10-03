/**
 * Plugin API for bundleVFSModules.
 *
 * Part A (v1): `transform` hook — see below.
 * Part B: `onResolve`/`onLoad` extension hooks (esbuild-style), namespaces,
 * loaders, and the PluginError contract. Spec: docs/PLUGINS.md Part B.
 *
 * Plugin interface:
 *   {
 *     name: string,                 // unique plugin name (required)
 *     builtIn?: boolean,            // built-in plugins run LAST (lowest priority)
 *     transform?(code, id),         // v1: transform source, return string|undefined
 *     onResolve?: [{                // Part B: claim specifiers at resolve time
 *       filter?: RegExp,            // tested against the specifier; no filter = match all
 *       namespace?: string,         // namespace to tag the match with
 *       resolve(args),              // ({path, importer}) => {path?, namespace?}|undefined
 *     }],
 *     onLoad?: [{                   // Part B: decide how a resolved path loads
 *       filter?: RegExp,            // tested against the resolved path
 *       namespace?: string,         // must equal the resolved namespace to match
 *       load(args),                // ({path, namespace, source}) => {contents, loader?}
 *     }],
 *   }
 *
 * Hook order per module: onResolve (first match wins) → onLoad (first
 * match wins; default = text load as "js") → transform chain (v1, "js"
 * loader only) → loader dispatch (json/text/wasm produce final ESM).
 */

const plugins = [];

export function registerPlugin(plugin) {
  if (!plugin || typeof plugin.name !== "string") {
    throw new TypeError("Plugin must have a string 'name'");
  }
  if (plugins.some((p) => p.name === plugin.name)) {
    throw new Error(`Plugin '${plugin.name}' is already registered`);
  }
  plugins.push(plugin);
  return plugin;
}

export function unregisterPlugin(name) {
  const idx = plugins.findIndex((p) => p.name === name);
  if (idx >= 0) {
    plugins.splice(idx, 1);
    return true;
  }
  return false;
}

export function getPlugins() {
  return [...plugins];
}

export function clearPlugins() {
  plugins.length = 0;
}

/**
 * Run all plugin transform hooks in registration order.
 * @param {string} code - source code
 * @param {string} id - module identifier (path/URL)
 * @returns {string} transformed code
 */
export async function applyTransformPlugins(code, id) {
  let result = code;
  for (const plugin of plugins) {
    if (typeof plugin.transform === "function") {
      const transformed = await plugin.transform(result, id);
      if (typeof transformed === "string") {
        result = transformed;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Part B: onResolve / onLoad / loaders / PluginError
// ---------------------------------------------------------------------------

/** Closed loader enum (spec §3, open question 1: closed first). */
export const VALID_LOADERS = new Set(["js", "json", "text", "wasm"]);

/** Namespace for ordinary files (no plugin claimed them). */
export const DEFAULT_NAMESPACE = "file";

/**
 * Error thrown by (or on behalf of) a plugin hook. Carries the plugin
 * name and source location so the pipeline can convert it to the
 * existing function_error result shape ({success:false, error, stack})
 * with the plugin name in the frame.
 */
export class PluginError extends Error {
  constructor(plugin, message, { file, line, column } = {}) {
    const loc = file
      ? ` (${file}${line != null ? `:${line}` : ""}${column != null ? `:${column}` : ""})`
      : "";
    super(`[${plugin}] ${message}${loc}`);
    this.name = "PluginError";
    this.plugin = plugin;
    this.file = file;
    this.line = line;
    this.column = column;
  }
}

/**
 * Wrap a hook's thrown value in a PluginError (pass-through if already
 * one), attributing it to the named plugin and file.
 */
export function toPluginError(pluginName, err, file) {
  if (err instanceof PluginError) return err;
  const message = err && err.message ? err.message : String(err);
  return new PluginError(pluginName, message, { file });
}

/**
 * Plugins in match order: user plugins in registration order, then
 * built-in plugins (builtIn:true) last — built-ins are the fallback,
 * so a user plugin registered later still wins for the same filter.
 */
function orderedPlugins() {
  const user = [];
  const builtin = [];
  for (const p of plugins) (p.builtIn ? builtin : user).push(p);
  return user.concat(builtin);
}

/**
 * Run onResolve entries in order; first match wins (esbuild semantics).
 * @param {string} path - the specifier as written by the importer
 * @param {string} importer - the importing module's resolved path
 * @returns {Promise<{path, namespace, plugin}|undefined>} undefined when
 *   no plugin claims the specifier (default resolution proceeds).
 */
export async function applyResolvePlugins(path, importer) {
  for (const plugin of orderedPlugins()) {
    const entries = plugin.onResolve;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry.filter && !entry.filter.test(path)) continue;
      if (typeof entry.resolve !== "function") continue;
      try {
        const r = await entry.resolve({ path, importer });
        if (r == null) continue; // fall through to next entry
        return {
          path: typeof r.path === "string" ? r.path : path,
          namespace: r.namespace || entry.namespace || DEFAULT_NAMESPACE,
          plugin: plugin.name,
        };
      } catch (err) {
        throw toPluginError(plugin.name, err, path);
      }
    }
  }
  return undefined;
}

/**
 * Run onLoad entries in order; first match on (filter AND namespace) wins.
 * @param {string} path - resolved path
 * @param {string} namespace - resolved namespace (from onResolve)
 * @param {*} source - fallback source (already-loaded text, may be null)
 * @returns {Promise<{contents, loader, plugin}>} — default when no plugin
 *   matches: {contents: source, loader: "js", plugin: null}.
 */
export async function applyLoadPlugins(path, namespace, source) {
  const ns = namespace || DEFAULT_NAMESPACE;
  for (const plugin of orderedPlugins()) {
    const entries = plugin.onLoad;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry.namespace && entry.namespace !== ns) continue;
      if (entry.filter && !entry.filter.test(path)) continue;
      if (typeof entry.load !== "function") continue;
      try {
        const r = await entry.load({ path, namespace: ns, source });
        if (r == null) continue;
        const loader = r.loader || "js";
        if (!VALID_LOADERS.has(loader)) {
          throw new PluginError(plugin.name, `unknown loader "${loader}"`, {
            file: path,
          });
        }
        return { contents: r.contents, loader, plugin: plugin.name };
      } catch (err) {
        throw toPluginError(plugin.name, err, path);
      }
    }
  }
  return { contents: source, loader: "js", plugin: null };
}

/**
 * Dispatch loaded contents by loader to the module source the pipeline
 * executes. Returns {kind:"js", source} for the normal JS pipeline, or
 * {kind:"module", source} with a final ESM source (transform chain is
 * skipped — the contents are not JS).
 */
export function dispatchLoader(contents, loader, fileName) {
  if (!VALID_LOADERS.has(loader)) {
    throw new PluginError("loader", `unknown loader "${loader}"`, {
      file: fileName,
    });
  }
  if (loader === "js") {
    return { kind: "js", source: String(contents) };
  }
  if (loader === "json") {
    const text = String(contents);
    try {
      JSON.parse(text);
    } catch (err) {
      throw new PluginError("loader", `invalid JSON: ${err.message}`, {
        file: fileName,
      });
    }
    return { kind: "module", source: `export default ${text};` };
  }
  if (loader === "text") {
    return {
      kind: "module",
      source: `export default ${JSON.stringify(String(contents))};`,
    };
  }
  // wasm: contents must be bytes; emit a module that instantiates them.
  // (WASI wiring belongs to the runwasi worker; this is the loader shape.)
  if (!(contents instanceof Uint8Array)) {
    throw new PluginError(
      "loader",
      "wasm loader requires Uint8Array contents",
      { file: fileName },
    );
  }
  const bytes = Array.from(contents).join(",");
  const source = [
    `const __wasmBytes = new Uint8Array([${bytes}]);`,
    `const __wasmModule = await WebAssembly.compile(__wasmBytes);`,
    `const __wasmInstance = await WebAssembly.instantiate(__wasmModule, {});`,
    `export default __wasmInstance.exports;`,
  ].join("\n");
  return { kind: "module", source };
}
