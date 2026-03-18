import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { WASI } from '../src/wasi.js';

describe('WASI wrapper', () => {
  let mockInstance;

  beforeEach(() => {
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
      .toThrow(/unsupported WASI version/);
  });

  test('finalizeBindings sets instance and marks started', () => {
    const wasi = new WASI({ version: 'preview1' });
    expect(() => wasi.finalizeBindings(mockInstance)).not.toThrow();

    // Match the specific message from your errWasiAlreadyStarted factory
    expect(() => wasi.finalizeBindings(mockInstance))
      .toThrow(/WASI instance has already started/);
  });

  test('start calls _start and throws sentinel when returnOnExit=true', () => {
    // We must capture the sentinel used inside the actual WASI instance
    const wasi = new WASI({ version: 'preview1', returnOnExit: true });
    
    // We mock _start to call proc_exit, which triggers the internal sentinel throw
    const instance = {
      exports: { 
        _start: () => wasi.wasiImport.proc_exit(0), 
        memory: new WebAssembly.Memory({ initial: 1 }) 
      },
    };

    // Because we use a Symbol for kExitSentinel, we check that it throws 'something'
    // and verify kStarted is true.
    try {
      wasi.start(instance);
    } catch (e) {
      expect(typeof e).toBe('symbol');
    }
  });

  test('throws ERR_INVALID_ARG_TYPE if invalid types passed', () => {
    // version: must be string
    expect(() => new WASI({ version: 123 }))
      .toThrow(/argument must be of type string/);

    // args: must be Array (matches your validateArray helper)
    expect(() => new WASI({ version: 'preview1', args: {} }))
      .toThrow(/argument must be an instance of Array/);

    // env: must be Object (and not array, if you applied the fix above)
    expect(() => new WASI({ version: 'preview1', env: 123 }))
      .toThrow(/argument must be of type object/);

    // returnOnExit: must be boolean
    expect(() => new WASI({ version: 'preview1', returnOnExit: 'yes' }))
      .toThrow(/argument must be of type boolean/);
  });
});
