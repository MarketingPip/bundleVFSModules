// src/build-sandbox.mjs — build the injectable sandbox template.
//
// The sandbox is authored as ordered fragments in src/sandbox/*.js (real JS
// files with __TOKEN__ placeholders — no escaping). This script concatenates
// them in manifest order, rewrites the tokens to %%TOKEN%% template
// placeholders, inlines a freshly-built cookie-jar IIFE from src/cookieJar.js
// (bundled with esbuild), validates the result with esbuild's parser, and
// writes src/sandbox-template.js:
//
//   export const SANDBOX_TEMPLATE = "<bundle with %%TOKENS%%>";
//
// SandboxRuntime.generate() then does single-pass %%TOKEN%% replacement.
// No hand-maintained escaping, no regex surgery on authored code.
//
// NOTE: sections are ordered fragments of one script (the template wraps
// them in a shared async IIFE scope), so they are NOT individually valid
// modules — only the concatenated bundle is. The build fails loudly if the
// bundle doesn't parse.

import { buildSync, transformSync } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandboxDir = join(root, 'src', 'sandbox');

// Manifest: section files in execution order.
const MANIFEST = [
  '00-runtime-object.js',
  '05-vitest-mocks.js',
  '10-task-tracker.js',
  '20-module-loader.js',
  '21-sync-require.js',
  '30-interop.js',
  '31-node-globals.js',
  '32-path-resolve.js',
  '40-console.js',
  '41-events-warnings.js',
  '50-process.js',
  '60-timers.js',
  '70-fetch.js',
  '71-xhr.js',
  '80-errors.js',
  '85-keydecoder.js',
  '90-server-request.js',
  '95-init.js',
  '96-user-code.js',
  '97-finalize.js',
];

// Section -> template token rewrites, applied to the bundled text.
// (Longest/most specific first.)
const TOKEN_MAP = [
  ['"__PROCESS_JSON__"', '%%PROCESS_JSON%%'],
  ['"__USER_FILES_JSON__"', '%%USER_FILES_JSON%%'],
  ['"__SEA_ASSETS_JSON__"', '%%SEA_ASSETS_JSON%%'],
  ['__INTEROP_VAR__', '%%INTEROP_VAR%%'],
  ['"__BUILTIN_MODULES_JSON__"', '%%BUILTIN_MODULES_JSON%%'],
  ['__STRIP_ANSI_FN__', '%%STRIP_ANSI_FN%%'],
  ['"__PARSE_STACK_LOCATION_FN__"', '%%PARSE_STACK_LOCATION_FN%%'],
  ['__FILENAME__', '%%FILENAME%%'],
  ['"__TEST_IMPORTS__";', '%%TEST_IMPORTS%%;'],
  ['("__ARGV_HAS_TEST__")', '(%%ARGV_HAS_TEST%%)'],
  ['__IMPORTS__', '%%IMPORTS%%'],
  ['__USER_CODE__', '%%USER_CODE%%'],
  ['__UUID__', '%%UUID%%'],
];

// __LOG_<SUFFIX>__ tokens come from the generated log-tokens table.
const { LOG_TOKENS } = await import('./sandbox/log-tokens.js');

function buildCookieIife() {
  const out = buildSync({
    entryPoints: [join(sandboxDir, 'cookie-entry.js')],
    bundle: true,
    format: 'iife',
    minify: true,
    platform: 'browser',
    write: false,
  });
  const code = out.outputFiles[0].text.trim();
  if (code.includes('</script>')) {
    throw new Error('cookie IIFE contains </script>; refusing to inline');
  }
  return code;
}

function readSection(name) {
  const text = readFileSync(join(sandboxDir, name), 'utf8');
  const lines = text.split('\n');
  if (!lines[0].startsWith('// SANDBOX SECTION')) {
    throw new Error(`${name}: missing SANDBOX SECTION header`);
  }
  // Strip the 4-line header comment.
  return lines.slice(4).join('\n').replace(/\s+$/, '');
}

function buildTemplate() {
  const concatenated = MANIFEST.map(readSection).join('\n');

  // The concatenated sections (with __TOKEN__s, all valid JS) must parse.
  // esbuild validates; throws on error.
  transformSync(concatenated, { loader: 'js' });

  let template = concatenated;

  for (const [from] of TOKEN_MAP) {
    if (!template.includes(from)) throw new Error(`token missing: ${from}`);
  }
  for (const [from, to] of TOKEN_MAP) {
    template = template.split(from).join(to);
  }
  for (const suffix of Object.keys(LOG_TOKENS)) {
    // Section files carry "__LOG_X__"; (with ;) so they read as statements;
    // the template keeps %%LOG_X%% bare because the statement already ends in ;.
    template = template.split(`"__LOG_${suffix}__";`).join(`%%LOG_${suffix}%%`);
  }

  // Inline the cookie jar from source (no more hand-pasted IIFE).
  const iife = buildCookieIife();
  const cookieFrom = '"__COOKIE_JAR_IIFE__"';
  const cookieIdx = template.indexOf(cookieFrom);
  if (cookieIdx === -1) throw new Error('cookie jar token missing');
  template = template.slice(0, cookieIdx) + iife + template.slice(cookieIdx + cookieFrom.length);

  // No authored token may survive. (Runtime property names like __FS__,
  // __USER_FILES__, __RUNTIME_RESOLVE__HANDLE are literal and fine.)
  const authoredTokens = /__PROCESS_JSON__|__USER_FILES_JSON__|__SEA_ASSETS_JSON__|__BUILTIN_MODULES_JSON__|__INTEROP_VAR__|__STRIP_ANSI_FN__|__PARSE_STACK_LOCATION_FN__|__FILENAME__|__TEST_IMPORTS__|__ARGV_HAS_TEST__|__IMPORTS__|__USER_CODE__|__COOKIE_JAR_IIFE__|__LOG_[A-Z_]+__|__UUID__(?!_)/g;
  const leftover = template.match(authoredTokens);
  if (leftover) throw new Error(`unreplaced tokens: ${[...new Set(leftover)].join(', ')}`);

  const outPath = join(root, 'src', 'sandbox-template.js');
  const header = [
    '// AUTO-GENERATED by src/build-sandbox.mjs — do not hand-edit.',
    '// Source of truth: src/sandbox/*.js (npm run build:sandbox to regenerate).',
    '// Injectable sandbox template; SandboxRuntime.generate() replaces %%TOKEN%%s.',
    `// Built deterministically by src/build-sandbox.mjs (no timestamp).`,
    'export const SANDBOX_TEMPLATE = ',
  ].join('\n');
  return { outPath, output: header + JSON.stringify(template) + ';\n', template };
}

function main() {
  const check = process.argv.includes('--check');
  const { outPath, output, template } = buildTemplate();
  if (check) {
    const current = readFileSync(outPath, 'utf8');
    if (current !== output) {
      console.error(`CHECK FAILED: ${outPath} differs from a fresh build.`);
      console.error('Run `npm run build:sandbox` and commit the result.');
      process.exit(1);
    }
    console.log(`check ok: ${outPath} matches fresh build (${template.length} chars)`);
    return;
  }
  writeFileSync(outPath, output);
  console.log(`wrote ${outPath} (${template.length} chars)`);
}

await main();
