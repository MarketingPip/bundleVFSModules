// ESM loader hook: remaps https://esm.sh/<pkg> to npm-installed <pkg>
// This lets runtime.js (which uses esm.sh imports) load in Node.js for testing.
// Usage: node --import ./tests/helpers/esm-shim-loader.mjs ...
import { register } from 'node:module';

// Map esm.sh URLs to npm package names
const ESM_SH_MAP = {
  'https://esm.sh/acorn': 'acorn',
  'https://esm.sh/acorn-import-assertions': 'acorn-import-assertions',
  'https://esm.sh/uuid': 'uuid',
  'https://esm.sh/builtin-modules': 'builtin-modules',
  'https://esm.sh/acorn-walk': 'acorn-walk',
  'https://esm.sh/typescript@5.4.5': 'typescript',
  'https://esm.sh/magic-string': 'magic-string',
  'https://esm.sh/@ampproject/remapping': '@ampproject/remapping',
  'https://esm.sh/memfs': 'memfs',
  'https://esm.sh/estree-walker': 'estree-walker',
};

register('./esm-shim-hooks.mjs', import.meta.url);
