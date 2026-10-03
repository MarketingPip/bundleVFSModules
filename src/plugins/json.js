/**
 * Built-in JSON plugin for bundleVFSModules.
 *
 * Proves the Part B hooks cover what used to be hardcoded: `.json`
 * modules resolve/load through onResolve/onLoad instead of a special
 * branch in the module pipeline.
 *
 * Registered with `builtIn: true` so it always has the LOWEST priority —
 * a user plugin registered later for /\.json$/ wins (first-match-wins
 * among user plugins, built-ins last).
 *
 * The loader dispatch in _build_file converts the JSON text to
 * `export default {...};`, which is behavior-identical to the old
 * hardcoded `module.exports = JSON.parse(source)` for ESM imports.
 */

export const jsonPlugin = {
  name: "json",
  builtIn: true,

  onResolve: [
    {
      filter: /\.json$/,
      namespace: "json",
      resolve(args) {
        return { path: args.path, namespace: "json" };
      },
    },
  ],

  onLoad: [
    {
      filter: /\.json$/,
      namespace: "json",
      load(args) {
        // args.source is the JSON text loaded by _dynamic_import from VFS.
        return { contents: args.source, loader: "json" };
      },
    },
  ],
};
