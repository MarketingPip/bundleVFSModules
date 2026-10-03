/**
 * Minimal plugin API for bundleVFSModules.
 *
 * Plugins extend the module loading pipeline with custom transforms.
 * This enables language support (TypeScript, etc.) without hardcoding
 * into the core runtime.
 *
 * Plugin interface:
 *   {
 *     name: string,           // unique plugin name
 *     transform?(code, id)     // transform source, return new code or undefined
 *   }
 *
 * The transform hook runs after _build_file and before module evaluation.
 * Return undefined to passthrough, or a string to replace the source.
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
