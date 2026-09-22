#!/usr/bin/env node
/**
 * Re-fetch the vendored Node.js test files from a pinned nodejs/node ref.
 *
 * Usage: node parity/fetch-node-tests.mjs [ref]   (default: v24.20.0)
 *
 * Re-downloads every file currently under parity/node-test/{parallel,common}/
 * from https://raw.githubusercontent.com/nodejs/node/<ref>/test/... and
 * overwrites local copies that differ. Files that don't exist at the ref
 * are reported and left untouched. No GitHub token needed (public repo).
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', 'node-test');
const REF = process.argv[2] || 'v24.20.0';
const BASE_URL = `https://raw.githubusercontent.com/nodejs/node/${REF}/test`;
// Files we own (not vendored from nodejs/node), keyed by path relative to node-test/.
const OWNED = new Set(['package.json']);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let updated = 0, identical = 0, missing = 0;
for (const local of walk(ROOT)) {
  const repoPath = relative(ROOT, local).split(sep).join('/');
  if (OWNED.has(repoPath)) continue; // our own file, not vendored
  const url = `${BASE_URL}/${repoPath}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`missing at ${REF}: ${repoPath} (HTTP ${res.status})`);
    missing++;
    continue;
  }
  const remote = Buffer.from(await res.arrayBuffer());
  const current = readFileSync(local);
  if (remote.equals(current)) {
    identical++;
  } else {
    writeFileSync(local, remote);
    console.log(`updated: ${repoPath}`);
    updated++;
  }
}
console.log(`\nref ${REF}: ${identical} identical, ${updated} updated, ${missing} missing`);
