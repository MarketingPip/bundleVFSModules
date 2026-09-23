import { jest, describe, test, expect, beforeAll } from '@jest/globals';
import { WASI } from '../src/wasi.js';
import { WASI as NodeWASI } from 'wasi';

const throwsCode = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected function to throw');
};

// Differential helper: the shim must raise the same code AND message as
// real Node v24's node:wasi for pure-validation inputs.
function expectSameAsNode(makeShimCall, makeNodeCall) {
  const shimErr = throwsCode(makeShimCall);
  const nodeErr = throwsCode(makeNodeCall);
  expect(shimErr.code).toBe(nodeErr.code);
  expect(shimErr.message).toBe(nodeErr.message);
  expect(shimErr.constructor.name).toBe(nodeErr.constructor.name);
}

function mockInstance(exports) {
  return { exports };
}

describe('export shape', () => {
  test('WASI is exported by name and as the default export', async () => {
    expect(typeof WASI).toBe('function');
    const ns = await import('../src/wasi.js');
    expect(ns.default).toEqual({ WASI });
    expect(new WASI({ version: 'preview1' })).toBeInstanceOf(WASI);
  });
});

describe('constructor validation (mirrors test-wasi-options-validation.js)', () => {
  test('version is required', () => {
    expectSameAsNode(() => new WASI(), () => new NodeWASI());
  });

  test.each([null, 'foo', '', 0, NaN, Symbol('s'), true, false, () => {}])(
    'options=%p throws ERR_INVALID_ARG_TYPE',
    (options) => {
      expectSameAsNode(() => new WASI(options), () => new NodeWASI(options));
    },
  );

  test('version must be a string', () => {
    expectSameAsNode(
      () => new WASI({ version: 123 }),
      () => new NodeWASI({ version: 123 }),
    );
  });

  test('unsupported version throws ERR_INVALID_ARG_VALUE', () => {
    expectSameAsNode(
      () => new WASI({ version: 'not_a_version' }),
      () => new NodeWASI({ version: 'not_a_version' }),
    );
  });

  test('both supported versions construct', () => {
    expect(() => new WASI({ version: 'preview1' })).not.toThrow();
    expect(() => new WASI({ version: 'unstable' })).not.toThrow();
  });

  test('args defaults to [] and must be an Array', () => {
    expect(() => new WASI({ version: 'preview1' })).not.toThrow();
    expectSameAsNode(
      () => new WASI({ version: 'preview1', args: 'fhqwhgads' }),
      () => new NodeWASI({ version: 'preview1', args: 'fhqwhgads' }),
    );
  });

  test('env must be an Object', () => {
    expectSameAsNode(
      () => new WASI({ version: 'preview1', env: 'fhqwhgads' }),
      () => new NodeWASI({ version: 'preview1', env: 'fhqwhgads' }),
    );
    expectSameAsNode(
      () => new WASI({ version: 'preview1', env: 123 }),
      () => new NodeWASI({ version: 'preview1', env: 123 }),
    );
  });

  test('preopens must be an Object', () => {
    expectSameAsNode(
      () => new WASI({ version: 'preview1', preopens: 'fhqwhgads' }),
      () => new NodeWASI({ version: 'preview1', preopens: 'fhqwhgads' }),
    );
  });

  test('returnOnExit must be a boolean', () => {
    expectSameAsNode(
      () => new WASI({ version: 'preview1', returnOnExit: 'fhqwhgads' }),
      () => new NodeWASI({ version: 'preview1', returnOnExit: 'fhqwhgads' }),
    );
  });

  test.each(['stdin', 'stdout', 'stderr'])('%s must be an int32 >= 0', (fd) => {
    expectSameAsNode(
      () => new WASI({ version: 'preview1', [fd]: 'fhqwhgads' }),
      () => new NodeWASI({ version: 'preview1', [fd]: 'fhqwhgads' }),
    );
    expectSameAsNode(
      () => new WASI({ version: 'preview1', [fd]: 1.5 }),
      () => new NodeWASI({ version: 'preview1', [fd]: 1.5 }),
    );
    expectSameAsNode(
      () => new WASI({ version: 'preview1', [fd]: -1 }),
      () => new NodeWASI({ version: 'preview1', [fd]: -1 }),
    );
    expect(() => new WASI({ version: 'preview1', [fd]: 2 })).not.toThrow();
  });
});

describe('getImportObject', () => {
  test('preview1 uses wasi_snapshot_preview1', () => {
    const wasi = new WASI({ version: 'preview1' });
    const obj = wasi.getImportObject();
    expect(Object.keys(obj)).toEqual(['wasi_snapshot_preview1']);
    expect(obj.wasi_snapshot_preview1).toBe(wasi.wasiImport);
  });

  test('unstable uses wasi_unstable', () => {
    const wasi = new WASI({ version: 'unstable' });
    expect(Object.keys(wasi.getImportObject())).toEqual(['wasi_unstable']);
  });
});

describe('wasiImport shape', () => {
  test('contains the full preview1 syscall surface as functions', () => {
    const wasi = new WASI({ version: 'preview1' });
    const names = Object.keys(wasi.wasiImport);
    for (const name of [
      'args_get', 'args_sizes_get', 'environ_get', 'environ_sizes_get',
      'clock_res_get', 'clock_time_get', 'fd_read', 'fd_write',
      'path_open', 'poll_oneoff', 'proc_exit', 'proc_raise',
      'random_get', 'sched_yield', 'sock_accept',
    ]) {
      expect(names).toContain(name);
      expect(typeof wasi.wasiImport[name]).toBe('function');
    }
    expect(names.length).toBe(46);
  });

  test('unimplemented syscalls return __WASI_ERRNO_NOSYS (52), never throw', () => {
    const wasi = new WASI({ version: 'preview1' });
    for (const name of ['path_open', 'poll_oneoff', 'proc_raise', 'sock_accept', 'fd_seek']) {
      expect(wasi.wasiImport[name]()).toBe(52);
    }
  });
});

describe('finalizeBindings / start / initialize validation', () => {
  const mem = () => new WebAssembly.Memory({ initial: 1 });

  test('start() with no instance throws like Node', () => {
    expectSameAsNode(
      () => new WASI({ version: 'preview1' }).start(),
      () => new NodeWASI({ version: 'preview1' }).start(),
    );
  });

  test('start() rejects null exports like Node', () => {
    const mk = (Cls) => {
      const wasi = new Cls({ version: 'preview1' });
      const instance = mockInstance(null);
      Object.defineProperty(instance, 'exports', { get: () => null });
      return () => wasi.start(instance);
    };
    // Shim-vs-shim message shape is covered by the official vendored tests;
    // here just assert the code.
    expect(throwsCode(mk(WASI)).code).toBe('ERR_INVALID_ARG_TYPE');
    expect(throwsCode(mk(WASI)).message).toMatch(/"instance\.exports" property must be of type object/);
  });

  test('start() requires a _start function', () => {
    const wasi = new WASI({ version: 'preview1' });
    const err = throwsCode(() => wasi.start(mockInstance({ memory: mem() })));
    expect(err.code).toBe('ERR_INVALID_ARG_TYPE');
    expect(err.message).toMatch(/"instance\.exports\._start" property must be of type function/);
  });

  test('start() rejects an _initialize export with Node\u2019s exact message', () => {
    const wasi = new WASI({ version: 'preview1' });
    const err = throwsCode(() =>
      wasi.start(mockInstance({ _start() {}, _initialize() {}, memory: mem() })));
    expect(err.code).toBe('ERR_INVALID_ARG_TYPE');
    expect(err.message).toBe(
      'The "instance.exports._initialize" property must be undefined. Received function _initialize',
    );
  });

  test('start() requires a real WebAssembly.Memory with the native message', () => {
    const wasi = new WASI({ version: 'preview1' });
    const err = throwsCode(() => wasi.start(mockInstance({ _start() {} })));
    expect(err.code).toBe('ERR_INVALID_ARG_TYPE');
    expect(err.message).toBe(
      '"instance.exports.memory" property must be a WebAssembly.Memory object',
    );
  });

  test('start() can only be called once', () => {
    const wasi = new WASI({ version: 'preview1' });
    const instance = mockInstance({ _start() {}, memory: mem() });
    wasi.start(instance);
    const err = throwsCode(() => wasi.start(instance));
    expect(err.code).toBe('ERR_WASI_ALREADY_STARTED');
    expect(err.message).toBe('WASI instance has already started');
  });

  test('initialize() rejects a _start export', () => {
    const wasi = new WASI({ version: 'preview1' });
    const err = throwsCode(() =>
      wasi.initialize(mockInstance({ _start() {}, _initialize() {}, memory: mem() })));
    expect(err.code).toBe('ERR_INVALID_ARG_TYPE');
    expect(err.message).toBe(
      'The "instance.exports._start" property must be undefined. Received function _start',
    );
  });

  test('initialize() calls _initialize when present, ok when absent', () => {
    const fn = jest.fn();
    new WASI({ version: 'preview1' })
      .initialize(mockInstance({ _initialize: fn, memory: mem() }));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(() =>
      new WASI({ version: 'preview1' }).initialize(mockInstance({ memory: mem() })),
    ).not.toThrow();
  });

  test('finalizeBindings twice throws ERR_WASI_ALREADY_STARTED', () => {
    const wasi = new WASI({ version: 'preview1' });
    const instance = mockInstance({ memory: mem() });
    wasi.finalizeBindings(instance);
    const err = throwsCode(() => wasi.finalizeBindings(instance));
    expect(err.code).toBe('ERR_WASI_ALREADY_STARTED');
  });
});

describe('honest syscall behaviour', () => {
  const mem = () => new WebAssembly.Memory({ initial: 1 });

  function readU32(view, ptr) {
    return view.getUint32(ptr, true);
  }

  test('start() returns the proc_exit code (returnOnExit=true)', () => {
    const wasi = new WASI({ version: 'preview1', returnOnExit: true });
    let code;
    const instance = mockInstance({
      _start() { wasi.wasiImport.proc_exit(42); },
      memory: mem(),
    });
    code = wasi.start(instance);
    expect(code).toBe(42);
  });

  test('start() returns 0 when _start returns normally', () => {
    const wasi = new WASI({ version: 'preview1' });
    const code = wasi.start(mockInstance({ _start() {}, memory: mem() }));
    expect(code).toBe(0);
  });

  test('proc_exit with returnOnExit=false raises WASI_EXIT instead of exiting', () => {
    const wasi = new WASI({ version: 'preview1', returnOnExit: false });
    const err = throwsCode(() => wasi.wasiImport.proc_exit(3));
    expect(err.code).toBe('WASI_EXIT');
    expect(err.exitCode).toBe(3);
  });

  test('args_get / args_sizes_get round-trip through guest memory', () => {
    const mem2 = new WebAssembly.Memory({ initial: 1 });
    const wasi2 = new WASI({ version: 'preview1', args: ['prog', '--flag', 'x'] });
    wasi2.finalizeBindings(mockInstance({ memory: mem2 }));
    const v = new DataView(mem2.buffer);
    expect(wasi2.wasiImport.args_sizes_get(0, 4)).toBe(0);
    expect(readU32(v, 0)).toBe(3);
    const enc = new TextEncoder();
    const expectedSize = ['prog', '--flag', 'x']
      .reduce((n, s) => n + enc.encode(s).length + 1, 0);
    expect(readU32(v, 4)).toBe(expectedSize);
    expect(wasi2.wasiImport.args_get(16, 64)).toBe(0);
    const dec = new TextDecoder();
    const argv = [0, 1, 2].map((i) => {
      const ptr = readU32(v, 16 + i * 4);
      const bytes = new Uint8Array(mem2.buffer);
      let end = ptr;
      while (bytes[end] !== 0) end++;
      return dec.decode(bytes.subarray(ptr, end));
    });
    expect(argv).toEqual(['prog', '--flag', 'x']);
  });

  test('environ_get / environ_sizes_get serialise KEY=VALUE', () => {
    const mem3 = new WebAssembly.Memory({ initial: 1 });
    const wasi = new WASI({ version: 'preview1', env: { A: '1', B: undefined, C: 'x' } });
    wasi.finalizeBindings(mockInstance({ memory: mem3 }));
    const v = new DataView(mem3.buffer);
    expect(wasi.wasiImport.environ_sizes_get(0, 4)).toBe(0);
    expect(readU32(v, 0)).toBe(2); // B skipped: undefined value
    expect(wasi.wasiImport.environ_get(16, 64)).toBe(0);
    const bytes = new Uint8Array(mem3.buffer);
    const dec = new TextDecoder();
    const vars = [0, 1].map((i) => {
      const ptr = readU32(v, 16 + i * 4);
      let end = ptr;
      while (bytes[end] !== 0) end++;
      return dec.decode(bytes.subarray(ptr, end));
    });
    expect(vars).toEqual(['A=1', 'C=x']);
  });

  test('fd_write to stdout/stderr reaches the console; bad fds give BADF', () => {
    const mem4 = new WebAssembly.Memory({ initial: 1 });
    const wasi = new WASI({ version: 'preview1' });
    wasi.finalizeBindings(mockInstance({ memory: mem4 }));
    const v = new DataView(mem4.buffer);
    const bytes = new Uint8Array(mem4.buffer);
    const msg = new TextEncoder().encode('hello wasi\n');
    bytes.set(msg, 64);
    v.setUint32(16, 64, true); // iov ptr
    v.setUint32(20, msg.length, true); // iov len

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(wasi.wasiImport.fd_write(1, 16, 1, 32)).toBe(0);
      expect(readU32(v, 32)).toBe(msg.length);
      expect(logSpy).toHaveBeenCalledWith('hello wasi');
      expect(wasi.wasiImport.fd_write(2, 16, 1, 32)).toBe(0);
      expect(errSpy).toHaveBeenCalledWith('hello wasi');
      expect(wasi.wasiImport.fd_write(3, 16, 1, 32)).toBe(8); // BADF
      expect(wasi.wasiImport.fd_write(0, 16, 1, 32)).toBe(8); // BADF
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test('fd_read on stdin returns EOF (0 bytes)', () => {
    const mem5 = new WebAssembly.Memory({ initial: 1 });
    const wasi = new WASI({ version: 'preview1' });
    wasi.finalizeBindings(mockInstance({ memory: mem5 }));
    const v = new DataView(mem5.buffer);
    expect(wasi.wasiImport.fd_read(0, 16, 1, 32)).toBe(0);
    expect(readU32(v, 32)).toBe(0);
    expect(wasi.wasiImport.fd_read(1, 16, 1, 32)).toBe(8);
  });

  test('clock_time_get returns plausible realtime/monotonic values', () => {
    const mem6 = new WebAssembly.Memory({ initial: 1 });
    const wasi = new WASI({ version: 'preview1' });
    wasi.finalizeBindings(mockInstance({ memory: mem6 }));
    const v = new DataView(mem6.buffer);
    expect(wasi.wasiImport.clock_time_get(0, 0, 64)).toBe(0);
    const realtime = v.getBigUint64(64, true);
    expect(realtime).toBeGreaterThan(1_700_000_000_000_000_000n);
    expect(wasi.wasiImport.clock_time_get(1, 0, 64)).toBe(0);
    expect(v.getBigUint64(64, true)).toBeGreaterThanOrEqual(0n);
    expect(wasi.wasiImport.clock_time_get(99, 0, 64)).toBe(28); // INVAL
  });

  test('random_get fills the guest buffer with non-trivial bytes', () => {
    const mem7 = new WebAssembly.Memory({ initial: 1 });
    const wasi = new WASI({ version: 'preview1' });
    wasi.finalizeBindings(mockInstance({ memory: mem7 }));
    expect(wasi.wasiImport.random_get(64, 32)).toBe(0);
    const slice = new Uint8Array(mem7.buffer).subarray(64, 96);
    expect(new Set(slice).size).toBeGreaterThan(1);
  });

  test('sched_yield is a successful noop', () => {
    const wasi = new WASI({ version: 'preview1' });
    expect(wasi.wasiImport.sched_yield()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Browser-fallback lane: native builtins disabled, the shim must not care.
// ---------------------------------------------------------------------------
let fb;
beforeAll(async () => {
  const realGbm = process.getBuiltinModule;
  const hadBuffer = 'Buffer' in globalThis;
  const realBuffer = globalThis.Buffer;
  process.getBuiltinModule = () => {
    throw new Error('native builtins disabled (browser-fallback lane)');
  };
  // @ts-expect-error removing the host Buffer like a browser without one
  delete globalThis.Buffer;
  try {
    fb = await import('../src/wasi.js?fallback=jest');
  } finally {
    process.getBuiltinModule = realGbm;
    if (hadBuffer) globalThis.Buffer = realBuffer;
  }
});

describe('browser fallback (no native builtins, no Buffer)', () => {
  test('constructor validation still matches Node exactly', () => {
    const err = (() => {
      try {
        new fb.WASI({ version: 'nope' });
      } catch (e) {
        return e;
      }
      throw new Error('should have thrown');
    })();
    expect(err.code).toBe('ERR_INVALID_ARG_VALUE');
    expect(err.message).toBe(
      "The property 'options.version' unsupported WASI version. Received 'nope'",
    );
  });

  test('start/initialize lifecycle works on mock instances', () => {
    const wasi = new fb.WASI({ version: 'preview1' });
    expect(Object.keys(wasi.getImportObject())).toEqual(['wasi_snapshot_preview1']);
    expect(Object.keys(wasi.wasiImport).length).toBe(46);
    const started = jest.fn();
    const code = wasi.start({
      exports: {
        _start: () => {
          started();
          wasi.wasiImport.proc_exit(7);
        },
        memory: new WebAssembly.Memory({ initial: 1 }),
      },
    });
    expect(started).toHaveBeenCalledTimes(1);
    expect(code).toBe(7);
    const err = (() => {
      try {
        wasi.start({ exports: { _start() {}, memory: new WebAssembly.Memory({ initial: 1 }) } });
      } catch (e) {
        return e;
      }
      throw new Error('should have thrown');
    })();
    expect(err.code).toBe('ERR_WASI_ALREADY_STARTED');
  });

  test('args syscalls work without native delegation', () => {
    const wasi = new fb.WASI({ version: 'preview1', args: ['a'] });
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.finalizeBindings({ exports: { memory } });
    const v = new DataView(memory.buffer);
    expect(wasi.wasiImport.args_sizes_get(0, 4)).toBe(0);
    expect(v.getUint32(0, true)).toBe(1);
  });
});
