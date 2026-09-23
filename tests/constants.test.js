import { describe, test, expect } from '@jest/globals';
import { createRequire } from 'node:module';
import * as shimNs from '../src/constants.js';
import shimDefault from '../src/constants.js';

// Real Node v24.20.0 builtin for differential comparison.
const require = createRequire(import.meta.url);
const real = require('node:constants');

describe('constants — port of node:constants (values captured from Node v24.20.0)', () => {
  // defaultCipherList is documented by Node as the *active* (runtime) cipher
  // list — unlike defaultCoreCipherList (compile-time) its presence and value
  // depend on the OpenSSL build and --tls-cipher-list, so a host may omit it
  // even on the same Node version. Tolerate exactly that key; everything else
  // must match the host builtin exactly.
  const RUNTIME_DEPENDENT_KEYS = new Set(['defaultCipherList']);

  test('exports the same key set as the real builtin (236 keys + ESM default)', () => {
    const realKeys = Object.keys(real).sort();
    const shimKeys = Object.keys(shimNs)
      .filter((k) => k !== 'default')
      .filter((k) => realKeys.includes(k) || !RUNTIME_DEPENDENT_KEYS.has(k))
      .sort();
    expect(shimKeys).toEqual(realKeys);
    expect(Object.keys(shimNs)).toHaveLength(237); // 236 named + default
  });

  test('differential: every key matches the real node:constants value', () => {
    for (const k of Object.keys(real)) {
      expect(shimNs[k]).toStrictEqual(real[k]);
    }
  });

  test('default export is the full namespace object and is frozen', () => {
    expect(shimDefault).toBeDefined();
    expect(typeof shimDefault).toBe('object');
    for (const k of Object.keys(real)) {
      expect(shimDefault[k]).toStrictEqual(real[k]);
    }
    // The real module freezes its exports object; we mirror that.
    expect(Object.isFrozen(real)).toBe(true);
    expect(Object.isFrozen(shimDefault)).toBe(true);
  });

  test('spot-checks of well-known values', () => {
    expect(shimNs.EACCES).toBe(13);
    expect(shimNs.ENOENT).toBe(2);
    expect(shimNs.SIGINT).toBe(2);
    expect(shimNs.SIGKILL).toBe(9);
    expect(shimNs.O_RDONLY).toBe(0);
    expect(shimNs.O_WRONLY).toBe(1);
    expect(shimNs.O_RDWR).toBe(2);
    expect(shimNs.S_IFREG).toBe(32768);
    expect(shimNs.F_OK).toBe(0);
    expect(shimNs.R_OK).toBe(4);
    expect(shimNs.W_OK).toBe(2);
    expect(shimNs.X_OK).toBe(1);
    expect(shimNs.RTLD_LAZY).toBe(1);
    expect(shimNs.PRIORITY_NORMAL).toBe(0);
  });

  test('cipher list strings are preserved verbatim', () => {
    expect(typeof shimNs.defaultCipherList).toBe('string');
    expect(typeof shimNs.defaultCoreCipherList).toBe('string');
    expect(shimNs.defaultCipherList).toContain('TLS_AES_256_GCM_SHA384');
    // defaultCipherList is the *active* cipher list (Node docs): the host may
    // omit it depending on its OpenSSL build, so compare values only when the
    // host defines it. defaultCoreCipherList is compile-time and covered by the
    // differential test above.
    if (real.defaultCipherList !== undefined) {
      expect(shimNs.defaultCipherList).toBe(real.defaultCipherList);
    }
  });
});
