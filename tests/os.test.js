import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// We need to mock globals before importing the shim because EOL and 
// other constants are calculated at module evaluation time.
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
  // Use a dynamic import or reset modules to test different UA strings
  let os;

  beforeEach(async () => {
    jest.resetModules();
    mockGlobals();
    os = (await import('../src/os.js')).default;
  });

  describe('Hardware & Memory', () => {
    test('endianness() returns LE or BE using typed arrays', () => {
      // Most modern browsers/CPUs are Little Endian
      expect(['LE', 'BE']).toContain(os.endianness());
    });

    test('totalmem() uses navigator.deviceMemory', () => {
      // 16GB mock -> bytes
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
