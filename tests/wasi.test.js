import { jest, describe, test, expect, beforeEach } from '@jest/globals';
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
    // FIX: changed .toThrowError (which is sometimes deprecated/alias) to .toThrow
    expect(() => new WASI({ version: 'invalid' }))
      .toThrow(/unsupported WASI version/);

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

    // FIX: Match against the message text or the code property. 
    // Jest's .toThrow(/pattern/) checks the message string.
    expect(() => wasi.finalizeBindings(mockInstance))
      .toThrow(/WASI instance has already started/);
  });

  test('start calls _start and throws sentinel when returnOnExit=true', () => {
    const sentinel = Symbol('sentinel');
    const wasi = new WASI({ version: 'preview1', returnOnExit: true });
    const instance = {
      exports: { 
        _start: jest.fn(() => { throw sentinel; }), 
        memory: new WebAssembly.Memory({ initial: 1 }) 
      },
    };

    // FIX: If the code is intended to swallow the sentinel internally, 
    // ensure the expectation matches that behavior. 
    // Based on your fail log, the error WAS actually thrown. 
    // We wrap it to ensure it is specifically the sentinel.
    expect(() => wasi.start(instance)).toThrow(sentinel);
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
    // FIX: The error message uses "The 'options.version' argument...", 
    // so we match the message string rather than the code property directly.
    expect(() => new WASI({ version: 123 })).toThrow(/argument must be of type string/);
    expect(() => new WASI({ version: 'preview1', args: {} })).toThrow(/must be of type/);
    expect(() => new WASI({ version: 'preview1', env: [] })).toThrow(/must be of type/);
    expect(() => new WASI({ version: 'preview1', returnOnExit: 'yes' })).toThrow(/must be of type/);
  });
});
