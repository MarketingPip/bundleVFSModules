import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import util from '../src/sys.js'; // adjust path if needed

describe('sys shim (util)', () => {
  let originalEmitWarning;

  beforeAll(() => {
    // Backup the original process.emitWarning
    originalEmitWarning = process.emitWarning;
    process.emitWarning = jest.fn();
  });

  afterAll(() => {
    // Restore original emitWarning
    process.emitWarning = originalEmitWarning;
  });

  test('exports util module', () => {
    expect(util).toBeDefined();
    expect(util).toHaveProperty('format');
    expect(util).toHaveProperty('promisify');
  });


  test('does not fail if process is undefined', () => {
    const originalProcess = globalThis.process;
    // @ts-ignore
    globalThis.process = undefined;

    expect(() => import('../src/sys.js')).not.toThrow();

    globalThis.process = originalProcess;
  });
});
