/**
 * tests/process.test.js — repo tests for src/process.js (browser port of node:process).
 *
 * Every assertion below was verified against the real Node v24.20.0 builtin
 * first (see the worker's verification log): exact error codes/messages,
 * hrtime semantics, umask validation, feature key set, etc. For values that
 * legitimately differ by platform/host (memory sizes, uptime), we assert
 * shapes and ranges, not exact numbers.
 *
 * The shim replaces globalThis.process on import (like real Node, where the
 * module IS the global). We capture the real process first and restore it
 * after every import so the jest runner itself is unaffected.
 */
import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';

const realProcess = globalThis.process;
const SHIM = '../src/process.js';

let shimSeq = 0;
/** Freshly import the shim, capturing/restoring the host global process. */
async function freshShim(rtProcess) {
  if (rtProcess === undefined) {
    delete globalThis._RUNTIME_;
  } else {
    globalThis._RUNTIME_ = { process: rtProcess };
  }
  jest.resetModules();
  const ns = await import(`${SHIM}?fresh=${++shimSeq}`);
  const installed = globalThis.process; // what the module installed
  globalThis.process = realProcess;     // give the runner its process back
  delete globalThis._RUNTIME_;
  return { ns, def: ns.default, installed };
}

afterAll(() => {
  globalThis.process = realProcess;
  delete globalThis._RUNTIME_;
  jest.resetModules();
});

describe('process shim — identity & exports', () => {
  let def, ns, installed;
  beforeAll(async () => {
    ({ def, ns, installed } = await freshShim(undefined));
  });

  test('Symbol.toStringTag is "process" (matches real node:process)', () => {
    expect(def[Symbol.toStringTag]).toBe('process');
    expect(Object.prototype.toString.call(def)).toBe('[object process]');
  });

  test('module installs itself as globalThis.process during import', () => {
    expect(installed).toBe(def);
  });

  test('named exports agree with the default export (data)', () => {
    expect(ns.arch).toBe(def.arch);
    expect(ns.platform).toBe(def.platform);
    expect(ns.title).toBe(def.title);
    expect(ns.pid).toBe(def.pid);
    expect(ns.ppid).toBe(def.ppid);
    expect(ns.argv).toBe(def.argv);
    expect(ns.argv0).toBe(def.argv0);
    expect(ns.execPath).toBe(def.execPath);
    expect(ns.execArgv).toBe(def.execArgv);
    expect(ns.version).toBe(def.version);
    expect(ns.versions).toBe(def.versions);
    expect(ns.release).toBe(def.release);
    expect(ns.config).toBe(def.config);
    expect(ns.features).toBe(def.features);
    expect(ns.debugPort).toBe(def.debugPort);
    expect(ns.domain).toBe(def.domain);
    expect(ns.moduleLoadList).toBe(def.moduleLoadList);
    expect(ns.stdin).toBe(def.stdin);
    expect(ns.stdout).toBe(def.stdout);
    expect(ns.stderr).toBe(def.stderr);
    expect(ns.report).toBe(def.report);
    expect(ns.env).toBe(def.env);
    expect(ns.exitCode).toBe(def.exitCode);
  });

  test('named exports agree with the default export (methods exist & behave)', () => {
    for (const name of ['cwd', 'chdir', 'exit', 'reallyExit', 'abort', 'umask',
        'uptime', 'hrtime', 'memoryUsage', 'cpuUsage', 'availableMemory',
        'constrainedMemory', 'resourceUsage', 'getActiveResourcesInfo', 'kill',
        'nextTick', 'on', 'off', 'once', 'addListener', 'removeListener',
        'removeAllListeners', 'prependListener', 'prependOnceListener', 'emit',
        'listenerCount', 'emitWarning', 'emitWarningSync', 'getuid', 'geteuid',
        'setuid', 'seteuid', 'getgid', 'getegid', 'setgid', 'setegid',
        'getgroups', 'setgroups', 'initgroups', 'binding', 'dlopen',
        'getBuiltinModule', 'openStdin', 'ref', 'unref', 'setSourceMapsEnabled',
        'setUncaughtExceptionCaptureCallback', 'hasUncaughtExceptionCaptureCallback',
        'loadEnvFile', 'execve']) {
      expect(typeof ns[name]).toBe('function');
      expect(typeof def[name]).toBe('function');
    }
    expect(ns.hrtime.bigint).toBeInstanceOf(Function);
    expect(typeof ns.hrtime.bigint()).toBe('bigint');
  });

  test('standalone fallbacks are sane with no _RUNTIME_', () => {
    expect(def.title).toBe('node');
    expect(def.arch).toBe('x64');
    expect(def.platform).toBe('browser');
    expect(def.pid).toBe(1);
    expect(def.ppid).toBe(0);
    expect(def.argv).toEqual([]);
    expect(def.argv0).toBe('');
    expect(def.execPath).toBe('');
    expect(def.execArgv).toEqual([]);
    expect(def.version).toBe('v0.0.0-shim');
    expect(def.exitCode).toBeUndefined();
    expect(def.domain).toBeNull();
    expect(def.debugPort).toBe(9229);
    expect(def.sourceMapsEnabled).toBe(false);
    expect(def.moduleLoadList).toEqual([]);
    expect(typeof def.env).toBe('object');
    expect(def.versions.node).toBe('0.0.0-shim');
    expect(def.release).toMatchObject({ name: 'node', lts: false });
  });

  test('features has exactly the key set real Node v24.20.0 exposes', () => {
    expect(Object.keys(def.features).sort()).toEqual([
      'cached_builtins', 'debug', 'inspector', 'ipv6', 'openssl_is_boringssl',
      'quic', 'require_module', 'tls', 'tls_alpn', 'tls_ocsp', 'tls_sni',
      'typescript', 'uv',
    ].sort());
  });

  test('allowedNodeEnvironmentFlags is a Set (empty: no NODE_OPTIONS in browser)', () => {
    expect(def.allowedNodeEnvironmentFlags).toBeInstanceOf(Set);
  });

  test('config has Node-shaped target_defaults/variables', () => {
    expect(Object.keys(def.config).sort()).toEqual(['target_defaults', 'variables']);
    expect(def.config.target_defaults.default_configuration).toBe('Release');
  });

  test('report has Node\'s exact key set', () => {
    expect(Object.keys(def.report).sort()).toEqual([
      'compact', 'directory', 'excludeEnv', 'excludeNetwork', 'filename',
      'getReport', 'reportOnFatalError', 'reportOnSignal',
      'reportOnUncaughtException', 'signal', 'writeReport',
    ].sort());
  });
});

describe('process shim — _RUNTIME_ mirroring', () => {
  test('mirrors a fake globalThis._RUNTIME_.process with zero native delegation', async () => {
    const fakeEnv = { FOO: 'bar' };
    const { def, ns } = await freshShim({
      title: 'faketitle', arch: 'arm64', platform: 'fakeos',
      pid: 4242, ppid: 100, argv: ['a', 'b'], argv0: 'a0',
      execPath: '/fake/node', execArgv: ['--flag'], version: 'v9.9.9',
      versions: { node: '9.9.9' }, env: fakeEnv, debugPort: 1234,
    });
    expect(def.title).toBe('faketitle');
    expect(def.arch).toBe('arm64');
    expect(def.platform).toBe('fakeos');
    expect(def.pid).toBe(4242);
    expect(def.ppid).toBe(100);
    expect(def.argv).toEqual(['a', 'b']);
    expect(def.argv0).toBe('a0');
    expect(def.execPath).toBe('/fake/node');
    expect(def.execArgv).toEqual(['--flag']);
    expect(def.version).toBe('v9.9.9');
    expect(def.versions).toEqual({ node: '9.9.9' });
    expect(def.debugPort).toBe(1234);
    // env is live-linked: same object, mutations visible both ways
    expect(def.env).toBe(fakeEnv);
    expect(ns.env).toBe(fakeEnv);
    def.env.ADDED = '1';
    expect(fakeEnv.ADDED).toBe('1');
    // non-mirrored API still works off the fake values
    expect(def.hrtime()).toHaveLength(2);
    expect(def.cwd()).toBe('/');
  });

  test('does not consult native process.getBuiltinModule (stubbed to throw)', async () => {
    const nativeGBM = realProcess.getBuiltinModule;
    realProcess.getBuiltinModule = () => { throw new Error('native delegation!'); };
    try {
      const { def } = await freshShim(undefined);
      // Exercise the whole surface; none of it may reach the native stub.
      expect(def.getBuiltinModule('fs')).toBeUndefined();
      expect(def.hrtime.bigint()).toBeGreaterThan(0n);
      expect(def.memoryUsage().heapTotal).toBeGreaterThanOrEqual(0);
      expect(def.uptime()).toBeGreaterThanOrEqual(0);
      def.nextTick(() => {});
      expect(def.cwd()).toBe('/');
      def.chdir('/tmp');
      expect(def.cwd()).toBe('/tmp');
      expect(def.umask(0o027)).toBe(0o022);
    } finally {
      realProcess.getBuiltinModule = nativeGBM;
    }
  });
});

describe('process shim — hrtime', () => {
  let def;
  beforeAll(async () => { ({ def } = await freshShim(undefined)); });

  test('hrtime() returns [seconds, nanoseconds]', () => {
    const [s, n] = def.hrtime();
    expect(Number.isInteger(s) && s >= 0).toBe(true);
    expect(Number.isInteger(n) && n >= 0 && n < 1e9).toBe(true);
  });

  test('hrtime(prev) returns the diff', () => {
    const t = def.hrtime();
    const [s, n] = def.hrtime(t);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThan(1e9);
  });

  test('hrtime.bigint() returns a positive bigint', () => {
    const a = def.hrtime.bigint();
    const b = def.hrtime.bigint();
    expect(typeof a).toBe('bigint');
    expect(b).toBeGreaterThanOrEqual(a);
  });

  test('hrtime validation matches Node', () => {
    expect(() => def.hrtime('x')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => def.hrtime('x')).toThrow('The "time" argument must be an instance of Array');
    expect(() => def.hrtime([1])).toThrow(
      expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
  });
});

describe('process shim — nextTick', () => {
  let def;
  beforeAll(async () => { ({ def } = await freshShim(undefined)); });

  test('throws ERR_INVALID_ARG_TYPE without a function', () => {
    expect(() => def.nextTick()).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => def.nextTick()).toThrow('The "callback" argument must be of type function');
  });

  test('runs callback with args on the microtask queue', async () => {
    const order = [];
    const seen = [];
    def.nextTick((a, b) => { order.push('tick'); seen.push(a, b); }, 1, 2);
    order.push('sync');
    await Promise.resolve();
    expect(order).toEqual(['sync', 'tick']);
    expect(seen).toEqual([1, 2]);
    function checkArgs() {}
    def.nextTick(checkArgs);
    await Promise.resolve();
  });

  test('callback args are passed through', async () => {
    const got = await new Promise((res) => def.nextTick((...a) => res(a)));
    expect(got).toEqual([]);
    const got2 = await new Promise((res) => def.nextTick((...a) => res(a), 'x', 7));
    expect(got2).toEqual(['x', 7]);
  });

  test('throwing callback routes to uncaughtException listeners', async () => {
    const errs = [];
    const boom = new Error('boom');
    def.on('uncaughtException', (e) => errs.push(e));
    def.nextTick(() => { throw boom; });
    await new Promise((r) => setTimeout(r, 20));
    expect(errs).toEqual([boom]);
    def.removeAllListeners('uncaughtException');
  });

  test('throwing callback routes to the capture callback when set', async () => {
    const errs = [];
    def.setUncaughtExceptionCaptureCallback((e) => errs.push(e));
    expect(def.hasUncaughtExceptionCaptureCallback()).toBe(true);
    def.nextTick(() => { throw new Error('captured'); });
    await new Promise((r) => setTimeout(r, 20));
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toBe('captured');
    def.setUncaughtExceptionCaptureCallback(null);
    expect(def.hasUncaughtExceptionCaptureCallback()).toBe(false);
  });

  test('setUncaughtExceptionCaptureCallback validates like Node', () => {
    expect(() => def.setUncaughtExceptionCaptureCallback(5)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => def.setUncaughtExceptionCaptureCallback(5)).toThrow(
      'The "fn" argument must be of type function or null');
  });
});

describe('process shim — exit / reallyExit / kill / abort', () => {
  test('exit(code) sets exitCode, emits exit synchronously, returns undefined', async () => {
    const { def } = await freshShim(undefined);
    const seen = [];
    def.on('exit', (c) => seen.push(c));
    expect(def.exit(3)).toBeUndefined();
    expect(def.exitCode).toBe(3);
    expect(seen).toEqual([3]); // synchronous, like Node
  });

  test('exit() with no args uses exitCode, defaulting to 0', async () => {
    const { def } = await freshShim(undefined);
    def.exit();
    expect(def.exitCode).toBe(0);
  });

  test('exit() picks up a preset exitCode', async () => {
    const { def } = await freshShim(undefined);
    def.exitCode = 7;
    def.exit();
    expect(def.exitCode).toBe(7);
  });

  test('exit validation matches Node', async () => {
    const { def } = await freshShim(undefined);
    expect(() => def.exit('x')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => def.exit('x')).toThrow('The "code" argument must be of type number');
    expect(() => def.exit(1.5)).toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
  });

  test('reallyExit skips listeners but records the code', async () => {
    const { def } = await freshShim(undefined);
    let fired = false;
    def.on('exit', () => { fired = true; });
    def.reallyExit(9);
    expect(def.exitCode).toBe(9);
    expect(fired).toBe(false);
  });

  test('kill validates like Node and is otherwise a host-notifying noop', async () => {
    const { def } = await freshShim(undefined);
    expect(() => def.kill('x')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => def.kill('x')).toThrow('The "pid" argument must be of type number');
    expect(() => def.kill(1, 5)).toThrow('The "signal" argument must be of type string');
    expect(def.kill(99999)).toBeUndefined();
    expect(def.kill(99999, 'SIGKILL')).toBeUndefined();
  });

  test('abort() is a noop that never throws', async () => {
    const { def } = await freshShim(undefined);
    expect(def.abort()).toBeUndefined();
  });
});

describe('process shim — umask / cwd / chdir', () => {
  test('umask round-trips and accepts octal strings', async () => {
    const { def } = await freshShim(undefined);
    expect(def.umask()).toBe(0o022);
    expect(def.umask(0o027)).toBe(0o022);
    expect(def.umask()).toBe(0o027);
    expect(def.umask('077')).toBe(0o027);
    expect(def.umask()).toBe(0o077);
    def.umask(0o022);
  });

  test('umask validation matches Node', async () => {
    const { def } = await freshShim(undefined);
    expect(() => def.umask('xx')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
    expect(() => def.umask('xx')).toThrow("The argument 'mask' must be a 32-bit unsigned integer or an octal string");
    expect(() => def.umask(-1)).toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
    expect(() => def.umask(1.5)).toThrow('It must be an integer');
  });

  test('cwd/chdir work standalone', async () => {
    const { def } = await freshShim(undefined);
    expect(def.cwd()).toBe('/');
    def.chdir('/foo');
    expect(def.cwd()).toBe('/foo');
    def.chdir('bar');
    expect(def.cwd()).toBe('/foo/bar');
    def.chdir('/a/./b/../c');
    expect(def.cwd()).toBe('/a/c');
  });

  test('chdir validates like Node', async () => {
    const { def } = await freshShim(undefined);
    expect(() => def.chdir(5)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => def.chdir(5)).toThrow('The "directory" argument must be of type string');
  });

  test('chdir validates against the virtual FS when present', async () => {
    const missing = new Error("ENOENT: no such file or directory, chdir '/nope'");
    missing.code = 'ENOENT';
    const rt = { __FS__: {
      cwd: '/vfs',
      lookup: (p, syscall) => {
        if (p === '/vfs' || p === '/vfs/sub') return { node: { kind: 'dir' }, path: p };
        throw Object.assign(missing, { syscall });
      },
    } };
    globalThis._RUNTIME_ = rt;
    jest.resetModules();
    let def;
    try {
      def = (await import(`${SHIM}?fresh=${++shimSeq}`)).default;
    } finally {
      globalThis.process = realProcess;
      delete globalThis._RUNTIME_;
    }
    expect(def.cwd()).toBe('/vfs'); // reads the volume's cwd
    def.chdir('/vfs/sub');
    expect(rt.__FS__.cwd).toBe('/vfs/sub');
    expect(() => def.chdir('/nope')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});

describe('process shim — resource info', () => {
  let def;
  beforeAll(async () => { ({ def } = await freshShim(undefined)); });

  test('memoryUsage has Node\'s keys with numeric values', () => {
    const m = def.memoryUsage();
    expect(Object.keys(m).sort()).toEqual(
      ['arrayBuffers', 'external', 'heapTotal', 'heapUsed', 'rss'].sort());
    for (const v of Object.values(m)) expect(typeof v).toBe('number');
  });

  test('cpuUsage returns zeros and validates prevValue', () => {
    expect(def.cpuUsage()).toEqual({ user: 0, system: 0 });
    expect(def.cpuUsage({ user: 1, system: 2 })).toEqual({ user: 0, system: 0 });
    expect(() => def.cpuUsage(5)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => def.cpuUsage(5)).toThrow('The "prevValue" argument must be of type object');
  });

  test('uptime is a non-negative number', () => {
    expect(typeof def.uptime()).toBe('number');
    expect(def.uptime()).toBeGreaterThanOrEqual(0);
  });

  test('resourceUsage has all 16 Node keys', () => {
    expect(Object.keys(def.resourceUsage()).sort()).toEqual([
      'userCPUTime', 'systemCPUTime', 'maxRSS', 'sharedMemorySize',
      'unsharedDataSize', 'unsharedStackSize', 'minorPageFault', 'majorPageFault',
      'swappedOut', 'fsRead', 'fsWrite', 'ipcSent', 'ipcReceived',
      'signalsCount', 'voluntaryContextSwitches', 'involuntaryContextSwitches',
    ].sort());
  });

  test('availableMemory/constrainedMemory/getActiveResourcesInfo shapes', () => {
    expect(typeof def.availableMemory()).toBe('number');
    expect(typeof def.constrainedMemory()).toBe('number');
    expect(def.getActiveResourcesInfo()).toEqual([]);
  });
});

describe('process shim — posix, stubs, events', () => {
  let def;
  beforeAll(async () => { ({ def } = await freshShim(undefined)); });

  test('uid/gid are root-like noops', () => {
    expect(def.getuid()).toBe(0);
    expect(def.geteuid()).toBe(0);
    expect(def.getgid()).toBe(0);
    expect(def.getegid()).toBe(0);
    expect(def.getgroups()).toEqual([]);
    expect(def.setuid(1000)).toBeUndefined();
    expect(def.seteuid(1000)).toBeUndefined();
    expect(def.setgid(1000)).toBeUndefined();
    expect(def.setegid(1000)).toBeUndefined();
    expect(def.setgroups([1])).toBeUndefined();
    expect(def.initgroups('u', 'g')).toBeUndefined();
  });

  test('impossible APIs are noops with correct shapes', () => {
    expect(def.binding('natives')).toBeUndefined();
    expect(def.dlopen({}, 'x.node')).toBeUndefined();
    expect(def.getBuiltinModule('fs')).toBeUndefined();
    expect(def.ref()).toBeUndefined();
    expect(def.unref()).toBeUndefined();
    expect(def.loadEnvFile()).toBeUndefined();
    expect(def.loadEnvFile('.env')).toBeUndefined();
    expect(def.execve('/bin/x', [], {})).toBeUndefined();
    expect(def.openStdin()).toBe(def.stdin);
  });

  test('dlopen/getBuiltinModule validate like Node', () => {
    expect(() => def.dlopen(5, 'x')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => def.dlopen({}, 5)).toThrow('The "filename" argument must be of type string');
    expect(() => def.getBuiltinModule(5)).toThrow('The "id" argument must be of type string');
  });

  test('setSourceMapsEnabled toggles sourceMapsEnabled', () => {
    expect(def.sourceMapsEnabled).toBe(false);
    def.setSourceMapsEnabled(true);
    expect(def.sourceMapsEnabled).toBe(true);
    def.setSourceMapsEnabled(false);
    expect(def.sourceMapsEnabled).toBe(false);
  });

  test('EventEmitter basics: on/once/off/emit/listenerCount', () => {
    const calls = [];
    const a = (x) => calls.push(['a', x]);
    const b = (x) => calls.push(['b', x]);
    expect(def.emit('nope')).toBe(false);
    def.on('e', a);
    def.once('e', b);
    expect(def.listenerCount('e')).toBe(2);
    expect(def.emit('e', 1)).toBe(true);
    expect(def.emit('e', 2)).toBe(true);
    expect(calls).toEqual([['a', 1], ['b', 1], ['a', 2]]);
    def.off('e', a);
    expect(def.listenerCount('e')).toBe(0);
    def.on('e', a);
    def.prependListener('e', b);
    const order = [];
    def.removeAllListeners('e');
    def.on('e', () => order.push('a'));
    def.prependListener('e', () => order.push('b'));
    def.emit('e');
    expect(order).toEqual(['b', 'a']);
    def.removeAllListeners('e');
  });

  test('on() validates its listener', () => {
    expect(() => def.on('e', 5)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });

  test('emitWarning delivers an Error to warning listeners', async () => {
    const got = [];
    def.on('warning', (w) => got.push(w));
    def.emitWarning('watch out', { code: 'TEST1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toHaveLength(1);
    expect(got[0]).toBeInstanceOf(Error);
    expect(got[0].message).toBe('watch out');
    expect(got[0].code).toBe('TEST1');
    def.removeAllListeners('warning');
  });

  test('emitWarning validates like Node', () => {
    expect(() => def.emitWarning(5)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => def.emitWarningSync(5)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });

  test('stdin/stdout/stderr stream shims exist with expected shape', () => {
    expect(def.openStdin()).toBe(def.stdin);
    expect(typeof def.stdout.write).toBe('function');
    expect(typeof def.stderr.write).toBe('function');
    expect(typeof def.stdin.on).toBe('function');
    expect(def.stdout.writable).toBe(true);
  });
});
