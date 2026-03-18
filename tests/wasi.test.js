import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { WASI } from '../src/wasi.js';

describe('WASI wrapper', () => {
  let mockInstance;

  beforeEach(() => {
    // Minimal WebAssembly instance mock
    mockInstance = {
      exports: {
        _start: jest.fn(),
        _initialize: undefined,
        memory: new WebAssembly.Memory({ initial: 1 }),
      },
    };
  });

  test('constructor validates version', () => {
    expect(() => new WASI({ version: 'invalid' }))
      .toThrowError(/unsupported WASI version/);

    expect(() => new WASI({ version: 'preview1' })).not.toThrow();
    expect(() => new WASI({ version: 'unstable' })).not.toThrow();
  });

  test('constructor accepts optional args, env, preopens, fds', () => {
    expect(() => new WASI({
      version: 'preview1',
      args: ['app.wasm'],
      env: { PATH: '/usr/bin', HOME: undefined },
      preopens: { '/sandbox': '/irrelevant' },
      stdin: 0,
      stdout: 1,
      stderr: 2,
      returnOnExit: true,
    })).not.toThrow();
  });

  test('getImportObject returns correct binding key', () => {
    const wasi = new WASI({ version: 'preview1' });
    const obj = wasi.getImportObject();
    expect(obj).toHaveProperty('wasi_snapshot_preview1');
  });

  test('finalizeBindings sets instance and marks started', () => {
    const wasi = new WASI({ version: 'preview1' });
    expect(() => wasi.finalizeBindings(mockInstance)).not.toThrow();

    // Cannot finalize twice
    expect(() => wasi.finalizeBindings(mockInstance)).toThrow(/ERR_WASI_ALREADY_STARTED/);
  });

  test('start calls _start and throws sentinel when returnOnExit=true', () => {
    const wasi = new WASI({ version: 'preview1', returnOnExit: true });
    const instance = {
      exports: { _start: jest.fn(() => { throw Symbol('sentinel'); }), memory: new WebAssembly.Memory({ initial: 1 }) },
    };

    expect(() => wasi.start(instance)).not.toThrow(); // swallow sentinel
    expect(wasi.getImportObject()).toBeDefined();
  });

  test('start throws error if _start missing or _initialize present', () => {
    const wasi = new WASI({ version: 'preview1' });
    const badInst = {
      exports: { _initialize: () => {}, memory: new WebAssembly.Memory({ initial: 1 }) },
    };
    expect(() => wasi.start(badInst)).toThrow();
  });

  test('initialize calls _initialize if present and _start absent', () => {
    const wasi = new WASI({ version: 'preview1' });
    const inst = {
      exports: { _initialize: jest.fn(), memory: new WebAssembly.Memory({ initial: 1 }) },
    };
    expect(() => wasi.initialize(inst)).not.toThrow();
    expect(inst.exports._initialize).toHaveBeenCalled();
  });

  test('throws ERR_INVALID_ARG_TYPE if invalid types passed', () => {
    expect(() => new WASI({ version: 123 })).toThrow(/ERR_INVALID_ARG_TYPE/);
    expect(() => new WASI({ version: 'preview1', args: {} })).toThrow(/ERR_INVALID_ARG_TYPE/);
    expect(() => new WASI({ version: 'preview1', env: [] })).toThrow(/ERR_INVALID_ARG_TYPE/);
    expect(() => new WASI({ version: 'preview1', returnOnExit: 'yes' })).toThrow(/ERR_INVALID_ARG_TYPE/);
  });
});
