import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

// Tests for the terminal-resize feature (setTerminalSize / terminal:resize /
// __terminal_resize__).
//
// runtime.js cannot be imported under Node (it wires a demo DOM and constructs
// a CodeSandbox at module scope), so — following tests/runtime_error_stacks.test.js —
// the tests below extract the exact shipped function sources and evaluate them.
// The full end-to-end path (real Chromium sandbox, guest 'resize' listeners,
// readline reflow) was verified with a Puppeteer harness; see the PR description.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(path.join(__dirname, '..', 'runtime.js'), 'utf8');

function extractBraced(marker) {
  const start = RUNTIME_SRC.indexOf(marker);
  if (start === -1) throw new Error(`${marker} not found in runtime.js`);
  let i = RUNTIME_SRC.indexOf('{', start);
  let depth = 0;
  for (; i < RUNTIME_SRC.length; i++) {
    if (RUNTIME_SRC[i] === '{') depth++;
    else if (RUNTIME_SRC[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`unbalanced braces extracting ${marker}`);
  return RUNTIME_SRC.slice(start, i + 1);
}

// --- parent side: CodeSandbox.setTerminalSize --------------------------------
const setTerminalSizeSrc = extractBraced('async setTerminalSize(cols, rows)')
  .replace('async setTerminalSize(cols, rows)', 'async function setTerminalSize(cols, rows)');
const setTerminalSize = new Function(
  `${setTerminalSizeSrc}; return setTerminalSize;`
)();

function fakeSandbox(invokeImpl) {
  const emitted = [];
  return {
    ctx: {
      _terminalSize: null,
      invoke: invokeImpl,
      emit: (name, payload) => emitted.push([name, payload]),
    },
    emitted,
  };
}

// --- sandbox side: __terminal_resize__ interop handler -----------------------
const handlerSrc = extractBraced(`expose('__terminal_resize__', (args) =>`);
// the extracted text starts at "expose('__terminal_resize__', (args) => {"
const arrowSrc = handlerSrc.slice(handlerSrc.indexOf('(args) =>'));
function makeHandler(fakeProcess) {
  return new Function('process', `"use strict"; return (${arrowSrc});`)(fakeProcess);
}
function fakeStreams() {
  const mk = () => Object.assign(new EventEmitter(), { columns: 80, rows: 24 });
  return { stdout: mk(), stderr: mk() };
}

describe('setTerminalSize (parent side)', () => {
  test('rejects zero / negative / NaN / non-numeric dimensions', async () => {
    for (const [c, r] of [[0, 40], [80, 0], [-1, 40], [80, -5], ['abc', 40], [80, NaN], [Infinity, 40]]) {
      const { ctx } = fakeSandbox(async () => ({ cols: 1, rows: 1 }));
      await expect(setTerminalSize.call(ctx, c, r)).rejects.toThrow(/positive integer/);
    }
  });

  test('truncates floats and invokes __terminal_resize__', async () => {
    const calls = [];
    const { ctx, emitted } = fakeSandbox(async (method, args) => {
      calls.push([method, args]);
      return { cols: 120, rows: 40 };
    });
    const ret = await setTerminalSize.call(ctx, 120.9, 40.2);
    expect(calls).toEqual([['__terminal_resize__', { cols: 120, rows: 40 }]]);
    expect(ret).toEqual({ cols: 120, rows: 40 });
    expect(ctx._terminalSize).toEqual({ cols: 120, rows: 40 });
    expect(emitted).toEqual([[ 'terminal:resize', { cols: 120, rows: 40 } ]]);
  });

  test('propagates "not running" when the sandbox is not live', async () => {
    const { ctx } = fakeSandbox(async () => { throw new Error('Sandbox is not running.'); });
    await expect(setTerminalSize.call(ctx, 80, 24)).rejects.toThrow(/not running/i);
  });
});

describe('__terminal_resize__ (sandbox side)', () => {
  test('updates columns/rows on stdout+stderr and emits resize', () => {
    const streams = fakeStreams();
    const seen = [];
    streams.stdout.on('resize', () => seen.push('out'));
    streams.stderr.on('resize', () => seen.push('err'));
    const ret = makeHandler({ stdout: streams.stdout, stderr: streams.stderr })({ cols: 120, rows: 40 });
    expect(ret).toEqual({ cols: 120, rows: 40 });
    expect(streams.stdout.columns).toBe(120);
    expect(streams.stdout.rows).toBe(40);
    expect(streams.stderr.columns).toBe(120);
    expect(streams.stderr.rows).toBe(40);
    expect(seen).toEqual(['out', 'err']);
  });

  test('rejects invalid dimensions without touching the streams', () => {
    const streams = fakeStreams();
    const handler = makeHandler({ stdout: streams.stdout, stderr: streams.stderr });
    expect(() => handler({ cols: 0, rows: 40 })).toThrow(/positive integer/);
    expect(() => handler({ cols: 80 })).toThrow(/positive integer/);
    expect(streams.stdout.columns).toBe(80);
    expect(streams.stderr.columns).toBe(80);
  });

  test('tolerates a missing stderr', () => {
    const streams = fakeStreams();
    const ret = makeHandler({ stdout: streams.stdout, stderr: null })({ cols: 100, rows: 30 });
    expect(ret).toEqual({ cols: 100, rows: 30 });
    expect(streams.stdout.columns).toBe(100);
  });
});

describe('runtime method registration', () => {
  test('__terminal_resize__ is a runtime method (no interop_registered noise)', () => {
    const m = RUNTIME_SRC.match(/const RUNTIME_METHODS = \[([^\]]+)\]/);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/'__terminal_resize__'/);
  });
});
