#!/usr/bin/env node
/**
 * Vendor official Node.js test files for one builtin module.
 *
 * Usage: node parity/fetch-module-tests.mjs <module> [ref]
 *   e.g. node parity/fetch-module-tests.mjs zlib
 *        node parity/fetch-module-tests.mjs stream/web   (matches test-stream-web*.js)
 *
 * Lists test/parallel at the pinned ref via the repo's recursive git tree
 * (through ~/workspace/skills/github/bin/gh.py, authenticated), downloads
 * every test-<name>*.js/.mjs, and drops them into parity/node-test/parallel/.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(fileURLToPath(import.meta.url), '..', 'node-test', 'parallel');
const GH = '/home/hatch/workspace/skills/github/bin/gh.py';
const moduleArg = process.argv[2];
if (!moduleArg) {
  console.error('usage: fetch-module-tests.mjs <module> [ref]');
  process.exit(2);
}
const REF = process.argv[3] || 'v24.20.0';

const dashName = moduleArg.replace(/_/g, '-').replace(/\//g, '-');
const prefix = `test/parallel/test-${dashName}`;

// Cache the recursive tree per ref in /tmp (it's ~15MB).
const cachePath = `/tmp/node-tree-${REF.replace(/[^a-zA-Z0-9.]/g, '_')}.json`;
let tree;
try {
  tree = JSON.parse(execFileSync('python3', ['-c', `print(open(${JSON.stringify(cachePath)}).read())`], { maxBuffer: 64 * 1024 * 1024 }).toString());
  console.log('using cached tree');
} catch {
  console.log('fetching recursive tree (one-time, ~15MB)…');
  const out = execFileSync(GH, ['GET', `/repos/nodejs/node/git/trees/${REF}?recursive=1`], { maxBuffer: 64 * 1024 * 1024 });
  tree = JSON.parse(out.toString());
  if (tree.truncated) console.log('!! tree truncated — results may be incomplete');
  const { writeFileSync: w } = await import('node:fs');
  w(cachePath, JSON.stringify(tree));
}

const hits = tree.tree
  .filter((e) => e.type === 'blob' && e.path.startsWith(prefix) && /\.(js|mjs)$/.test(e.path))
  .map((e) => e.path.slice('test/parallel/'.length));
console.log(`found ${hits.length} test files for "${moduleArg}" at ${REF}`);

mkdirSync(ROOT, { recursive: true });
let ok = 0;
for (const n of hits) {
  const url = `https://raw.githubusercontent.com/nodejs/node/${REF}/test/parallel/${n}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`  !! ${n}: HTTP ${res.status}`);
    continue;
  }
  writeFileSync(join(ROOT, n), Buffer.from(await res.arrayBuffer()));
  ok++;
}
console.log(`vendored ${ok}/${hits.length} into parity/node-test/parallel/`);
