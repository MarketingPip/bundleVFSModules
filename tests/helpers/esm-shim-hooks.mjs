// ESM loader hooks: remap https://esm.sh/* to npm packages
// Registered via tests/helpers/esm-shim-loader.mjs

const ESM_SH_MAP = {
  'https://esm.sh/acorn': 'acorn',
  'https://esm.sh/acorn-import-assertions': 'acorn-import-assertions',
  'https://esm.sh/uuid': 'uuid',
  'https://esm.sh/builtin-modules': 'builtin-modules',
  'https://esm.sh/acorn-walk': 'acorn-walk',
  'https://esm.sh/typescript@5.4.5': 'typescript',
  'https://esm.sh/magic-string': 'magic-string',
  'https://esm.sh/@ampproject/remapping': '@ampproject/remapping',
  'https://esm.sh/@jridgewell/trace-mapping': '@jridgewell/trace-mapping',
  'https://esm.sh/memfs': 'memfs',
  'https://esm.sh/estree-walker': 'estree-walker',
};

export async function resolve(specifier, context, nextResolve) {
  // Stub acorn-import-assertions (not critical for basic parsing)
  if (specifier === 'https://esm.sh/acorn-import-assertions' || specifier === 'acorn-import-assertions') {
    return { url: 'node:acorn-import-assertions-stub', shortCircuit: true };
  }
  // Stub uuid (simple v4 implementation)
  if (specifier === 'https://esm.sh/uuid' || specifier === 'uuid') {
    return { url: 'node:uuid-stub', shortCircuit: true };
  }
  // Stub builtin-modules (use Node's built-in list)
  if (specifier === 'https://esm.sh/builtin-modules' || specifier === 'builtin-modules') {
    return { url: 'node:builtin-modules-stub', shortCircuit: true };
  }
  // Stub @ampproject/remapping (sourcemaps, not critical for testing)
  if (specifier === 'https://esm.sh/@ampproject/remapping' || specifier === '@ampproject/remapping') {
    return { url: 'node:remapping-stub', shortCircuit: true };
  }
  // Check exact match first
  if (ESM_SH_MAP[specifier]) {
    return nextResolve(ESM_SH_MAP[specifier], context);
  }
  // Check prefix match for versioned URLs like https://esm.sh/pkg@1.2.3
  for (const [url, pkg] of Object.entries(ESM_SH_MAP)) {
    if (specifier.startsWith(url + '@') || specifier.startsWith(url + '/')) {
      // Extract the package name without version
      const pkgName = pkg.split('@')[0];
      return nextResolve(pkgName, context);
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  // Stub for acorn-import-assertions
  if (url === 'node:acorn-import-assertions-stub') {
    return {
      format: 'module',
      source: 'export const importAssertions = () => {};',
      shortCircuit: true,
    };
  }
  // Stub for uuid
  if (url === 'node:uuid-stub') {
    return {
      format: 'module',
      source: `export function v4() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      }`,
      shortCircuit: true,
    };
  }
  // Stub for builtin-modules
  if (url === 'node:builtin-modules-stub') {
    return {
      format: 'module',
      source: `import { builtinModules } from 'node:module';
        export default builtinModules;`,
      shortCircuit: true,
    };
  }
  // Stub for @ampproject/remapping
  if (url === 'node:remapping-stub') {
    return {
      format: 'module',
      source: `export default function remapping() { return { mappings: '' }; }`,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
