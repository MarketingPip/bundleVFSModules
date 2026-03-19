import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// Mock globals for browser shim tests
const mockGlobals = (overrides = {}) => {
  const defaultNav = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    platform: 'MacIntel',
    hardwareConcurrency: 8,
    deviceMemory: 16
  };

  Object.defineProperty(globalThis, 'navigator', {
    value: { ...defaultNav, ...overrides },
    configurable: true
  });

  Object.defineProperty(globalThis, 'performance', {
    value: { now: jest.fn(() => 123450) },
    configurable: true
  });

  Object.defineProperty(globalThis, 'location', {
    value: { hostname: 'test.local' },
    configurable: true
  });
};

describe('os-web Browser Shim', () => {
  let os;

  beforeEach(async () => {
    jest.resetModules();
    mockGlobals();
    os = (await import('../src/os.js')).default;
  });

  describe('Hardware & Memory', () => {
    test('endianness() returns LE or BE using typed arrays', () => {
      expect(['LE', 'BE']).toContain(os.endianness());
    });

    test('totalmem() uses navigator.deviceMemory', () => {
      expect(os.totalmem()).toBe(16 * 1024 * 1024 * 1024);
    });

    test('availableParallelism() and cpus() match hardwareConcurrency', () => {
      expect(os.availableParallelism()).toBe(8);
      expect(os.cpus().length).toBe(8);
      expect(os.cpus()[0].times.user).toBe(0);
    });
  });

  describe('System Heuristics (Darwin Mock)', () => {
    test('identifies darwin/mac correctly', () => {
      expect(os.platform()).toBe('darwin');
      expect(os.type()).toBe('Darwin');
      expect(os.EOL).toBe('\n');
    });

    test('uptime() converts performance.now to seconds', () => {
      expect(os.uptime()).toBe(123);
    });
  });

  describe('Windows Heuristics', () => {
    test('identifies win32 from UserAgent', async () => {
      jest.resetModules();
      mockGlobals({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        platform: 'Win32'
      });
      const winOs = (await import('../src/os.js')).default;

      expect(winOs.platform()).toBe('win32');
      expect(winOs.EOL).toBe('\r\n');
      expect(winOs.devNull).toBe('\\\\.\\nul');
    });
  });

  describe('Stubs & Constants', () => {
    test('networkInterfaces() returns loopback stub', () => {
      const interfaces = os.networkInterfaces();
      expect(interfaces.lo).toBeDefined();
      expect(interfaces.lo[0].address).toBe('127.0.0.1');
    });

    test('loadavg() always returns zeros', () => {
      expect(os.loadavg()).toEqual([0, 0, 0]);
    });

    test('constants are frozen and match Node values', () => {
      expect(os.constants.signals.SIGINT).toBe(2);
      expect(Object.isFrozen(os.constants)).toBe(true);
    });

    test('userInfo() returns plausible stub', () => {
      const user = os.userInfo();
      expect(user.uid).toBe(-1);
      expect(user.username).toBe('user');
    });
  });
});

// Node.js os module compatibility tests
import os, {
  hostname,
  platform,
  arch,
  type,
  release,
  version,
  machine,
  tmpdir,
  homedir,
  cpus,
  totalmem,
  freemem,
  uptime,
  loadavg,
  networkInterfaces,
  userInfo,
  endianness,
  getPriority,
  setPriority,
  EOL,
  constants,
  devNull,
} from '../src/os';

describe('os module (Node.js compat)', () => {
  test('os.hostname() returns a string', () => {
    const result = hostname();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('os.platform() returns a valid platform string', () => {
    const result = platform();
    expect(typeof result).toBe('string');
    const validPlatforms = ['aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32'];
    expect(validPlatforms).toContain(result);
  });

  test('os.arch() returns a valid architecture string', () => {
    const result = arch();
    expect(typeof result).toBe('string');
    const validArchs = ['arm', 'arm64', 'ia32', 'mips', 'mipsel', 'ppc', 'ppc64', 's390', 's390x', 'x64'];
    expect(validArchs).toContain(result);
  });

  test('os.type() returns a string', () => {
    const result = type();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('os.release() returns a string', () => {
    const result = release();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('os.version() returns a string', () => {
    const result = version();
    expect(typeof result).toBe('string');
  });

  test('os.machine() returns a string', () => {
    const result = machine();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('os.tmpdir() returns an absolute path', () => {
    const result = tmpdir();
    expect(typeof result).toBe('string');
    expect(result.startsWith('/')).toBe(true);
  });

  test('os.homedir() returns an absolute path', () => {
    const result = homedir();
    expect(typeof result).toBe('string');
    expect(result.startsWith('/')).toBe(true);
  });

  test('os.cpus() returns array with CPU info objects', () => {
    const result = cpus();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    for (const cpu of result) {
      expect(cpu).toHaveProperty('model');
      expect(cpu).toHaveProperty('speed');
      expect(cpu).toHaveProperty('times');
    }
  });

  test('os.totalmem() and os.freemem() return positive numbers', () => {
    expect(totalmem()).toBeGreaterThan(0);
    expect(freemem()).toBeGreaterThan(0);
    expect(freemem()).toBeLessThanOrEqual(totalmem());
  });

  test('os.uptime() returns non-negative number', () => {
    expect(uptime()).toBeGreaterThanOrEqual(0);
  });

  test('os.loadavg() returns array of 3 numbers', () => {
    const result = loadavg();
    expect(result.length).toBe(3);
    for (const avg of result) expect(avg).toBeGreaterThanOrEqual(0);
  });

  test('os.networkInterfaces() returns correct object shape', () => {
    const result = networkInterfaces();
    for (const [name, interfaces] of Object.entries(result)) {
      expect(typeof name).toBe('string');
      for (const iface of interfaces) {
        expect(iface).toHaveProperty('address');
        expect(iface).toHaveProperty('netmask');
        expect(iface).toHaveProperty('family');
        expect(iface).toHaveProperty('mac');
        expect(iface).toHaveProperty('internal');
        expect(iface).toHaveProperty('cidr');
      }
    }
  });

  test('os.userInfo() returns correct object shape', () => {
    const user = userInfo();
    expect(user).toHaveProperty('username');
    expect(user).toHaveProperty('uid');
    expect(user).toHaveProperty('gid');
    expect(user).toHaveProperty('shell');
    expect(user).toHaveProperty('homedir');
  });

  test('os.endianness() returns BE or LE', () => {
    expect(['BE', 'LE']).toContain(endianness());
  });

  test('os.getPriority() and os.setPriority() do not throw', () => {
    expect(() => getPriority()).not.toThrow();
    expect(() => setPriority(0, 0)).not.toThrow();
  });

  test('os.EOL is valid', () => {
    expect(['\n', '\r\n']).toContain(EOL);
  });

  test('os.constants contain expected values', () => {
    expect(constants.signals.SIGINT).toBeDefined();
    expect(constants.priority.PRIORITY_LOW).toBeDefined();
  });

  test('os.devNull is valid', () => {
    expect(['/dev/null', '\\\\.\\nul']).toContain(devNull);
  });
});
