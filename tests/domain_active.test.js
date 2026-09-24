// domain.active live binding (Node v24.20.0 parity).
import domain, { active, create, createDomain, Domain } from '../src/domain.js';
import * as ns from '../src/domain.js';
import { describe, test, expect } from '@jest/globals';

describe('domain.active', () => {
  test('active is present in the module namespace and starts null', () => {
    expect('active' in ns).toBe(true);
    // After any prior enter/exit dance from other suites the safest check is
    // that the binding agrees with the default export.
    expect(active).toBe(domain.active);
  });

  test('binding tracks enter()/exit()', () => {
    const d = create();
    d.enter();
    expect(active).toBe(d);
    expect(domain.active).toBe(d);
    d.exit();
    expect(active).toBe(domain.active);
    expect(active).not.toBe(d);
    // Matches real Node: after exiting the last domain, active is undefined.
    expect(domain.active).toBe(undefined);
  });

  test('binding tracks the default-export setter', () => {
    const d = createDomain();
    domain.active = d;
    expect(active).toBe(d);
    domain.active = null;
    expect(active).toBe(null);
    expect(domain.active).toBe(null);
  });

  test('nested domains track the innermost', () => {
    const a = create();
    const b = create();
    a.enter();
    expect(active).toBe(a);
    b.enter();
    expect(active).toBe(b);
    b.exit();
    expect(active).toBe(a);
    a.exit();
    expect(active).toBe(domain.active);
  });

  test('Domain class is still exported and usable', () => {
    expect(Domain).toBe(domain.Domain);
    const d = new Domain();
    d.enter();
    expect(active).toBe(d);
    d.exit();
  });
});
