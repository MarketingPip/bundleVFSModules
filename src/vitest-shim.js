// Vitest-compatible test runner shim for bundleVFSModules browser sandbox.
// Provides test/describe/it/expect/beforeEach/afterEach with a working runner,
// compatible with the Vitest API surface used in failing.md.
// The real Vitest runner requires a Node.js worker context; this shim provides
// the minimal suite management so tests can define and run in the browser.

// Minimal expect implementation (Chai-compatible subset)
function createExpect(actual) {
  const matchers = {
    toBe(expected) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`);
      }
    },
    toEqual(expected) {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) {
        throw new Error(`Expected ${a} to equal ${b}`);
      }
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected ${JSON.stringify(actual)} to be truthy`);
    },
    toBeFalsy() {
      if (actual) throw new Error(`Expected ${JSON.stringify(actual)} to be falsy`);
    },
    toBeNull() {
      if (actual !== null) throw new Error(`Expected ${JSON.stringify(actual)} to be null`);
    },
    toBeUndefined() {
      if (actual !== undefined) throw new Error(`Expected ${JSON.stringify(actual)} to be undefined`);
    },
    toBeDefined() {
      if (actual === undefined) throw new Error(`Expected value to be defined`);
    },
    toContain(item) {
      if (Array.isArray(actual)) {
        if (!actual.includes(item)) throw new Error(`Expected array to contain ${JSON.stringify(item)}`);
      } else if (typeof actual === 'string') {
        if (!actual.includes(item)) throw new Error(`Expected string to contain ${JSON.stringify(item)}`);
      } else {
        throw new Error(`toContain not supported for ${typeof actual}`);
      }
    },
    toThrow(expected) {
      if (typeof actual !== 'function') throw new Error(`Expected a function for toThrow`);
      try {
        actual();
      } catch (e) {
        if (expected && !String(e.message).includes(String(expected))) {
          throw new Error(`Expected error to contain ${expected}, got ${e.message}`);
        }
        return;
      }
      throw new Error(`Expected function to throw`);
    },
  };
  // .not variants
  const not = {};
  for (const [k, fn] of Object.entries(matchers)) {
    not[k] = (...args) => {
      try {
        fn(...args);
      } catch {
        return; // Original threw, so .not passes
      }
      throw new Error(`Expected .not.${k} to pass (original assertion succeeded)`);
    };
  }
  return { ...matchers, not };
}

export function expect(actual) {
  return createExpect(actual);
}

// Test suite management
const suites = [];
let currentSuite = null;
const rootSuite = { name: 'root', tests: [], suites: [], beforeEach: [], afterEach: [] };
currentSuite = rootSuite;

export function describe(name, fn) {
  const suite = { name, tests: [], suites: [], beforeEach: [], afterEach: [], parent: currentSuite };
  currentSuite.suites.push(suite);
  const prev = currentSuite;
  currentSuite = suite;
  try {
    fn();
  } finally {
    currentSuite = prev;
  }
}

export function test(name, fn) {
  if (typeof name === 'function') {
    fn = name;
    name = 'anonymous';
  }
  currentSuite.tests.push({ name, fn });
}

export const it = test;

export function beforeEach(fn) {
  currentSuite.beforeEach.push(fn);
}

export function afterEach(fn) {
  currentSuite.afterEach.push(fn);
}

export function beforeAll(fn) {
  // Simplified: run immediately
  fn();
}

export function afterAll(fn) {
  // Simplified: store for later
  rootSuite._afterAll = rootSuite._afterAll || [];
  rootSuite._afterAll.push(fn);
}

// Test runner - executes collected tests and reports results
export async function runTests() {
  const results = { passed: 0, failed: 0, failures: [] };
  
  async function runSuite(suite, prefix = '') {
    const suiteName = prefix ? `${prefix} > ${suite.name}` : suite.name;
    // Run tests in this suite
    for (const t of suite.tests) {
      // Run beforeEach hooks (from parent suites too)
      const hooks = [];
      let s = suite;
      while (s) {
        hooks.unshift(...s.beforeEach);
        s = s.parent;
      }
      try {
        for (const h of hooks) await h();
        await t.fn();
        // Run afterEach hooks
        const afterHooks = [];
        s = suite;
        while (s) {
          afterHooks.push(...s.afterEach);
          s = s.parent;
        }
        for (const h of afterHooks) await h();
        results.passed++;
        console.log(`✓ ${suiteName} > ${t.name}`);
      } catch (e) {
        results.failed++;
        results.failures.push({ suite: suiteName, test: t.name, error: e.message });
        console.error(`✗ ${suiteName} > ${t.name}: ${e.message}`);
      }
    }
    // Run nested suites
    for (const sub of suite.suites) {
      await runSuite(sub, suiteName === 'root' ? '' : suiteName);
    }
  }
  
  await runSuite(rootSuite);
  
  // Run afterAll
  if (rootSuite._afterAll) {
    for (const fn of rootSuite._afterAll) {
      try { await fn(); } catch (e) { console.error('afterAll failed:', e.message); }
    }
  }
  
  console.log(`\nTest Results: ${results.passed} passed, ${results.failed} failed`);
  return results;
}

// Auto-run tests when the module is done loading (microtask)
// This allows the simple `import { test } from 'vitest'` pattern to work
// without explicit runTests() call, matching Vitest's behavior.
if (typeof globalThis !== 'undefined' && !globalThis.__VITEST_SHIM_MANUAL__) {
  queueMicrotask(async () => {
    // Wait a tick for all test definitions to register
    await new Promise(r => setTimeout(r, 100));
    if (rootSuite.tests.length > 0 || rootSuite.suites.length > 0) {
      await runTests();
    }
  });
}
