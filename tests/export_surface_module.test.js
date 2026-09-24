// Export-surface parity: src/module.js  <->  node:module
// captured from real Node v24.20.0 (node:module)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/module.js';

const EXPECTED = ["Module","SourceMap","_cache","_debug","_extensions","_findPath","_initPaths","_load","_nodeModulePaths","_pathCache","_preloadModules","_resolveFilename","_resolveLookupPaths","builtinModules","constants","createRequire","default","enableCompileCache","findPackageJSON","findSourceMap","flushCompileCache","getCompileCacheDir","getSourceMapsSupport","globalPaths","isBuiltin","register","registerHooks","runMain","setSourceMapsSupport","stripTypeScriptTypes","syncBuiltinESMExports"];

test('node:module export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
