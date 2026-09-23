import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests for the runtime.js error-stack pipeline.
//
// __parseStackLocation lives at module scope in runtime.js (exported) and is
// inlined into the sandbox iframe template via ${__parseStackLocation.toString()}
// — a single source of truth. runtime.js itself cannot be imported under Node
// (it wires a demo DOM and constructs a CodeSandbox at module scope), so the
// tests below extract the exact shipped function source and evaluate it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(path.join(__dirname, '..', 'runtime.js'), 'utf8');

function loadParser() {
  const marker = 'export function __parseStackLocation(frame)';
  const start = RUNTIME_SRC.indexOf(marker);
  if (start === -1) throw new Error('__parseStackLocation not found in runtime.js');
  let i = RUNTIME_SRC.indexOf('{', start);
  let depth = 0;
  for (; i < RUNTIME_SRC.length; i++) {
    if (RUNTIME_SRC[i] === '{') depth++;
    else if (RUNTIME_SRC[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error('unbalanced braces extracting __parseStackLocation');
  const fnSrc = RUNTIME_SRC.slice(start, i + 1).replace(/^export\s+/, '');
  return new Function(`${fnSrc}; return __parseStackLocation;`)();
}

const parse = loadParser();

describe('__parseStackLocation (URL-safe V8 frame parser)', () => {
  test('parses "at fn (https://host/app.js:10:15)"', () => {
    expect(parse('    at myFunction (https://example.com/app.js:10:15)')).toEqual({
      file: 'https://example.com/app.js', line: 10, column: 15,
    });
  });

  test('parses async frames', () => {
    expect(parse('    at async myFunction (https://example.com/app.js:10:15)')).toEqual({
      file: 'https://example.com/app.js', line: 10, column: 15,
    });
  });

  test('parses bare-location frames', () => {
    expect(parse('    at https://example.com/app.js:10:15')).toEqual({
      file: 'https://example.com/app.js', line: 10, column: 15,
    });
  });

  test('does not mistake the URL scheme for line/column separators', () => {
    // The old naive split(':') turned "https:" into a bogus file/line split.
    expect(parse('    at boom (https://example.com/app.js:10:15)')).toEqual({
      file: 'https://example.com/app.js', line: 10, column: 15,
    });
  });

  test('survives URLs with ports', () => {
    expect(parse('    at serve (https://example.com:8080/app.js:3:7)')).toEqual({
      file: 'https://example.com:8080/app.js', line: 3, column: 7,
    });
  });

  test('parses http://localhost frames', () => {
    expect(parse('    at handler (http://localhost:3000/app.js:10:15)')).toEqual({
      file: 'http://localhost:3000/app.js', line: 10, column: 15,
    });
  });

  test('parses file:// frames', () => {
    expect(parse('    at main (file:///home/user/app.js:5:3)')).toEqual({
      file: 'file:///home/user/app.js', line: 5, column: 3,
    });
  });

  test('returns null for native/anonymous frames', () => {
    expect(parse('    at Array.forEach (<anonymous>)')).toBeNull();
    expect(parse('    at native')).toBeNull();
  });

  test('returns null for empty/garbage input', () => {
    expect(parse('')).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse('not a stack frame')).toBeNull();
  });

  test('inlined template copy stays in sync (single source of truth)', () => {
    // The sandbox template must inline the module-scope function, not carry
    // a second hand-written copy that can drift.
    expect(RUNTIME_SRC).toContain('${__parseStackLocation.toString()}');
    const fnSrc = parse.toString();
    expect(fnSrc).not.toContain('`');
    expect(fnSrc).not.toContain('${');
  });
});
