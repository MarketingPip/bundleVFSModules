// tests/domain.test.js — repo tests for the Node v24.20.0 `domain` port.
//
// Every behavioral assertion below was first verified against real
// `node:domain`; the differential section at the bottom runs the same
// scenarios against both implementations in child processes and compares.
//
// The deprecated `domain` module has no `dispose()` upstream — the port
// matches that (there is intentionally no `dispose`/`_disposed`).
import domain, { Domain, createDomain, create } from '../src/domain.js';
import { EventEmitter } from '../src/events.js';
import { execFileSync } from 'node:child_process';

// Drain the domain stack between tests so no test observes another's active
// domain. exit() on the top domain pops it; updateExceptionCapture clears the
// uncaught capture and syncTimerPatches restores pristine globals.
function drain() {
  while (domain._stack.length > 0) {
    const top = domain._stack[domain._stack.length - 1];
    try { top.removeAllListeners('error'); } catch { /* ignore */ }
    top.exit();
  }
}
beforeEach(drain);
afterEach(drain);

describe('module shape (matches node:domain)', () => {
  test('create === createDomain', () => {
    expect(domain.create).toBe(domain.createDomain);
    expect(create).toBe(domain.create);
    expect(createDomain).toBe(domain.create);
  });

  test('exports Domain, active, _stack', () => {
    expect(typeof domain.Domain).toBe('function');
    expect(Array.isArray(domain._stack)).toBe(true);
  });

  test('no dispose() upstream — the port does not add one', () => {
    const d = domain.create();
    expect(typeof d.dispose).toBe('undefined');
    expect('_disposed' in d).toBe(false);
  });

  test('Domain instances are EventEmitters with a members list', () => {
    const d = domain.create();
    expect(d).toBeInstanceOf(Domain);
    expect(d).toBeInstanceOf(EventEmitter);
    expect(typeof d.on).toBe('function');
    expect(d.members).toEqual([]);
  });

  test('setUncaughtExceptionCaptureCallback throws after load', () => {
    expect(() => process.setUncaughtExceptionCaptureCallback(() => {}))
      .toThrow(
        expect.objectContaining({
          code: 'ERR_DOMAIN_CANNOT_SET_UNCAUGHT_EXCEPTION_CAPTURE',
        }),
      );
  });
});

describe('enter/exit/active/_stack', () => {
  test('stack push/pop shape', () => {
    const a = domain.create();
    const b = domain.create();
    const c = domain.create();

    a.enter();
    expect(domain._stack).toEqual([a]);
    expect(domain.active).toBe(a);
    expect(process.domain).toBe(a);

    b.enter();
    expect(domain._stack).toEqual([a, b]);
    c.enter();
    expect(domain._stack).toEqual([a, b, c]);

    b.exit(); // pops b and everything above it (c)
    expect(domain._stack).toEqual([a]);
    expect(domain.active).toBe(a);
    expect(process.domain).toBe(a);

    b.enter();
    expect(domain._stack).toEqual([a, b]);
  });

  test('active transitions: domain while entered, undefined after final exit', () => {
    const d = domain.create();
    d.enter();
    expect(domain.active).toBe(d);
    expect(process.domain).toBe(d);
    d.exit();
    expect(domain.active).toBeUndefined();
    expect(process.domain).toBeUndefined();
    expect(domain._stack).toHaveLength(0);
  });

  test('exit() on a non-entered domain is a no-op', () => {
    const d = domain.create();
    expect(() => d.exit()).not.toThrow();
    expect(domain._stack).toHaveLength(0);
    expect(domain.active).toBeUndefined();
  });
});

describe('run()', () => {
  test('returns the callback result and forwards arguments', () => {
    const d = domain.create();
    expect(d.run((a, b) => a + b, 2, 3)).toBe(5);
  });

  test('calls back with the domain as `this`', () => {
    const d = domain.create();
    let seen = null;
    d.run(function () { seen = this; });
    expect(seen).toBe(d);
  });

  test('active domain is set inside run and cleared after', () => {
    const d = domain.create();
    let inside = null;
    d.run(() => { inside = domain.active; });
    expect(inside).toBe(d);
    expect(domain.active).toBeUndefined();
  });
});

describe('bind()', () => {
  test('forwards `this` and arguments, returns the result', () => {
    const d = domain.create();
    let seenThis = null;
    let seenArgs = null;
    const fn = d.bind(function (a, b) {
      seenThis = this;
      seenArgs = [a, b];
      return 'ret';
    });
    const ctx = { tag: 1 };
    expect(fn.call(ctx, 'x', 'y')).toBe('ret');
    expect(seenThis).toBe(ctx);
    expect(seenArgs).toEqual(['x', 'y']);
  });

  test('bound function carries a non-enumerable .domain', () => {
    const d = domain.create();
    const fn = d.bind(() => {});
    expect(fn.domain).toBe(d);
    expect(Object.prototype.propertyIsEnumerable.call(fn, 'domain')).toBe(false);
  });

  test('throw inside bound function routes to the domain error handler', (done) => {
    const d = domain.create();
    d.on('error', (er) => {
      try {
        expect(er.message).toBe('bound-boom');
        expect(er.domain).toBe(d);
        expect(er.domainThrown).toBe(true);
        done();
      } catch (e) { done(e); }
    });
    const fn = d.bind(() => { throw new Error('bound-boom'); });
    // Deferred so the throw escapes jest's sync try/catch and becomes a
    // real uncaught exception; the bind's enter() installs the capture.
    setTimeout(fn, 5);
  });
});

describe('intercept()', () => {
  test('passes through non-error calls with args/`this`/return', () => {
    const d = domain.create();
    let seenThis = null;
    const fn = d.intercept(function (a, b) {
      seenThis = this;
      return a * b;
    });
    const ctx = {};
    expect(fn.call(ctx, null, 6, 7)).toBe(42);
    expect(seenThis).toBe(ctx);
  });

  test('routes Error first-args to the error handler with annotations', (done) => {
    const d = domain.create();
    const cb = (v) => v;
    const fn = d.intercept(cb);
    d.on('error', (er) => {
      try {
        expect(er.message).toBe('intercept-boom');
        expect(er.domain).toBe(d);
        expect(er.domainThrown).toBe(false);
        expect(er.domainBound).toBe(cb);
        expect(Object.prototype.propertyIsEnumerable.call(er, 'domain')).toBe(false);
        done();
      } catch (e) { done(e); }
    });
    fn(new Error('intercept-boom'));
  });

  test('non-Error first-arg is treated as data, not an error', () => {
    const d = domain.create();
    let routed = null;
    d.on('error', (er) => { routed = er; });
    // intercept() strips the error slot: the callback sees ('data', 1).
    const fn = d.intercept((a, b) => [a, b]);
    expect(fn(null, 'data', 1)).toEqual(['data', 1]);
    expect(routed).toBeNull();
  });
});

describe('add()/remove()', () => {
  test('add assigns ee.domain (non-enumerable) and tracks members', () => {
    const d = domain.create();
    const ee = new EventEmitter();
    d.add(ee);
    expect(ee.domain).toBe(d);
    expect(Object.prototype.propertyIsEnumerable.call(ee, 'domain')).toBe(false);
    expect(d.members).toContain(ee);
  });

  test('add is idempotent for the same domain', () => {
    const d = domain.create();
    const ee = new EventEmitter();
    d.add(ee);
    d.add(ee);
    expect(d.members.filter((m) => m === ee)).toHaveLength(1);
  });

  test('add moves an emitter from another domain', () => {
    const d1 = domain.create();
    const d2 = domain.create();
    const ee = new EventEmitter();
    d1.add(ee);
    d2.add(ee);
    expect(ee.domain).toBe(d2);
    expect(d1.members).not.toContain(ee);
    expect(d2.members).toContain(ee);
  });

  test('remove clears ee.domain to null and drops the member', () => {
    const d = domain.create();
    const ee = new EventEmitter();
    d.add(ee);
    d.remove(ee);
    expect(ee.domain).toBeNull();
    expect(d.members).not.toContain(ee);
  });

  test('emitter errors are routed to the owning domain', (done) => {
    const d = domain.create();
    const ee = new EventEmitter();
    d.add(ee);
    d.on('error', (er) => {
      try {
        expect(er.message).toBe('ee-boom');
        expect(er.domain).toBe(d);
        done();
      } catch (e) { done(e); }
    });
    ee.emit('error', new Error('ee-boom'));
  });
});

describe('error routing', () => {
  test('throw inside run() reaches the domain error handler', (done) => {
    const d = domain.create();
    d.on('error', (er) => {
      try {
        expect(er.message).toBe('run-boom');
        expect(er.domain).toBe(d);
        expect(er.domainThrown).toBe(true);
        done();
      } catch (e) { done(e); }
    });
    // Deferred so the throw escapes jest's sync try/catch and becomes a
    // real uncaught exception instead of a test failure.
    setTimeout(() => { d.run(() => { throw new Error('run-boom'); }); }, 5);
  });

  test('throw in a nextTick scheduled inside run() is routed', (done) => {
    const d = domain.create();
    d.on('error', (er) => {
      try {
        expect(er.message).toBe('tick-boom');
        expect(er.domain).toBe(d);
        expect(er.domainThrown).toBe(true);
        // Matches real node:domain — the stack is drained before 'error'
        // emits, so active is undefined during the handler (null after).
        expect(domain._stack).toHaveLength(0);
        expect(domain.active).toBeUndefined();
        done();
      } catch (e) { done(e); }
    });
    d.run(() => {
      process.nextTick(() => { throw new Error('tick-boom'); });
    });
  });

  // Note: the no-error-listener uncaught path is covered by the ten
  // official test-domain-no-error-handler-abort-on-uncaught-* tests (all
  // passing); driving a real uncaughtException inside jest fights the
  // runner's own uncaught handling, so it is not duplicated here.
});

describe('implicit binding', () => {
  test('setTimeout scheduled while entered runs with the domain active', (done) => {
    const d = domain.create();
    d.run(() => {
      setTimeout(() => {
        try {
          expect(domain.active).toBe(d);
          expect(process.domain).toBe(d);
          done();
        } catch (e) { done(e); }
      }, 5);
    });
  });

  test('setTimeout scheduled outside any domain stays unbound', (done) => {
    setTimeout(() => {
      try {
        expect(domain.active == null).toBe(true);
        done();
      } catch (e) { done(e); }
    }, 5);
  });

  test('promise reactions created while entered observe the domain', (done) => {
    const d = domain.create();
    d.run(() => {
      Promise.resolve(1).then((v) => {
        try {
          expect(v).toBe(1);
          expect(domain.active).toBe(d);
          done();
        } catch (e) { done(e); }
      });
    });
  });

  test('global timers are pristine when no domain is active', () => {
    // The lazy timer patching must not leak wrapper identities: with an
    // empty stack the globals are the original host functions.
    expect(domain._stack).toHaveLength(0);
    const d = domain.create();
    d.enter();
    const wrapped = globalThis.setTimeout;
    d.exit();
    expect(globalThis.setTimeout).not.toBe(wrapped);
  });
});

describe('explicit require-time behavior', () => {
  test('domain module exposes the documented API surface only', () => {
    expect(Object.keys(domain).sort()).toEqual(
      ['Domain', '_stack', 'active', 'create', 'createDomain'].sort(),
    );
  });
});

describe('browser fallback (no native delegation)', () => {
  let fb;
  const realGbm = process.getBuiltinModule;
  const sharedState = globalThis[Symbol.for('bundleVFSModules.domain.shared')];

  beforeAll(async () => {
    // Any native-delegation attempt throws: the import and every operation
    // below must work with zero native delegation.
    process.getBuiltinModule = () => {
      throw new Error('native delegation attempted');
    };
    try {
      // Force this instance through the full installHostPatches path so the
      // guarded native bridge is genuinely exercised (and skipped).
      sharedState.installed = false;
      fb = (await import('../src/domain.js?fallback=domain')).default;
    } finally {
      process.getBuiltinModule = realGbm;
    }
  });

  afterAll(() => {
    process.getBuiltinModule = realGbm;
  });

  test('module loads with the native bridge disabled', () => {
    expect(typeof fb.create).toBe('function');
    expect(fb.create).toBe(fb.createDomain);
  });

  test('core domain tracking works without natives', () => {
    const d = fb.create();
    d.enter();
    try {
      expect(fb.active).toBe(d);
      expect(fb._stack).toContain(d);
    } finally {
      d.exit();
    }
    expect(fb._stack).not.toContain(d);
  });

  test('run/bind/intercept work without natives', () => {
    const d = fb.create();
    expect(d.run((a, b) => a + b, 20, 22)).toBe(42);
    let seenThis = null;
    const ctx = {};
    d.bind(function () { seenThis = this; }).call(ctx);
    expect(seenThis).toBe(ctx);
    expect(d.intercept((x) => x * 2)(null, 21)).toBe(42);
  });

  test('explicit emitter errors route without natives', () => {
    const d = fb.create();
    const ee = new EventEmitter();
    d.add(ee);
    let routed = null;
    d.on('error', (er) => { routed = er; });
    ee.emit('error', new Error('fb-ee-boom'));
    expect(routed && routed.message).toBe('fb-ee-boom');
    expect(routed.domain).toBe(d);
    d.removeAllListeners('error');
  });

  test('implicit timer binding works without natives', (done) => {
    const d = fb.create();
    d.run(() => {
      setTimeout(() => {
        try {
          expect(fb.active).toBe(d);
          done();
        } catch (e) { done(e); }
      }, 5);
    });
  });

  test('without uncaught capture, a synchronous throw propagates (browser semantic)', () => {
    // Under this lane the uncaught-exception capture callback is unavailable
    // (in a real browser there is no process at all), so a throw inside run()
    // propagates to the caller instead of being routed. The window 'error'
    // hook is the browser's routing mechanism for truly uncaught errors.
    const d = fb.create();
    d.on('error', () => { throw new Error('should not route without capture'); });
    expect(() => d.run(() => { throw new Error('fb-sync-boom'); }))
      .toThrow('fb-sync-boom');
    d.removeAllListeners('error');
  });
});

describe('differential vs real node:domain', () => {
  const SHIM_URL = new URL('../src/domain.js', import.meta.url).href;

  function runCase(impl, body) {
    const load =
      impl === 'real'
        ? `const ns = await import('node:domain');`
        : `const ns = await import(${JSON.stringify(SHIM_URL)});`;
    const code = `${load}\nconst domain = ns.default ?? ns;\n${body}`;
    return execFileSync(
      process.execPath,
      ['--input-type=module', '-e', code],
      { timeout: 15000, encoding: 'utf8' },
    ).trim();
  }

  function expectSameOutput(name, body) {
    const realOut = runCase('real', body);
    const shimOut = runCase('shim', body);
    expect({ name, shimOut }).toEqual({ name, shimOut: realOut });
  }

  test('module shape and initial state', () => {
    expectSameOutput('shape', `
      console.log(JSON.stringify({
        createIsCreateDomain: domain.create === domain.createDomain,
        activeNull: domain.active === null,
        procNull: process.domain === null,
        stackIsArray: Array.isArray(domain._stack),
        stackEmpty: domain._stack.length === 0,
      }));
    `);
  }, 30000);

  test('enter/exit/active/process.domain/_stack tracking', () => {
    expectSameOutput('tracking', `
      const out = [];
      const a = domain.create();
      const b = domain.create();
      a.enter();
      out.push(domain.active === a, process.domain === a, domain._stack.length);
      b.enter();
      out.push(domain.active === b, process.domain === b, domain._stack.length);
      b.exit();
      out.push(domain.active === a, domain._stack.length);
      a.exit();
      out.push(domain.active === undefined, process.domain === undefined,
               domain._stack.length);
      console.log(JSON.stringify(out));
    `);
  }, 30000);

  test('run/bind/intercept argument and this forwarding', () => {
    expectSameOutput('forwarding', `
      const out = [];
      const dom = domain.create();
      out.push(dom.run((x, y) => x + y, 2, 3));
      let runThis = null;
      dom.run(function () { runThis = this; });
      out.push(runThis === dom);
      let bindThis = null;
      const bindArgs = [];
      const bound = dom.bind(function (p, q) {
        bindThis = this; bindArgs.push(p, q); return 'ret';
      });
      const ctx = { tag: 1 };
      out.push(bound.call(ctx, 'a', 'b'));
      out.push(bindThis === ctx, JSON.stringify(bindArgs));
      out.push(bound.domain === dom);
      let intThis = null;
      const ic = dom.intercept(function (x) { intThis = this; return x * 2; });
      const ictx = {};
      out.push(ic.call(ictx, null, 21), intThis === ictx);
      console.log(JSON.stringify(out));
    `);
  }, 30000);

  test('intercept error annotations', () => {
    expectSameOutput('intercept-annotations', `
      const dom = domain.create();
      const cb = (v) => v;
      const fn = dom.intercept(cb);
      let routed = null;
      dom.on('error', (er) => {
        routed = {
          msg: er.message,
          domainIsDom: er.domain === dom,
          thrown: er.domainThrown,
          boundIsCb: er.domainBound === cb,
          domainNonEnumerable:
            !Object.prototype.propertyIsEnumerable.call(er, 'domain'),
        };
      });
      fn(new Error('boom'));
      console.log(JSON.stringify(routed));
    `);
  }, 30000);

  test('error routing: throw in run with an error listener', () => {
    expectSameOutput('error-routing', `
      const dom = domain.create();
      let got = null;
      dom.on('error', (er) => {
        got = {
          msg: er.message,
          domainIsDom: er.domain === dom,
          thrown: er.domainThrown,
        };
      });
      dom.run(() => { throw new Error('run-boom'); });
      setTimeout(() => {
        console.log(JSON.stringify({
          got,
          stackEmpty: domain._stack.length === 0,
          activeNull: domain.active === null,
        }));
      }, 20);
    `);
  }, 30000);

  test('add/remove member bookkeeping', () => {
    expectSameOutput('add-remove', `
      const { EventEmitter } = await import('node:events');
      const out = [];
      const dom = domain.create();
      const ee = new EventEmitter();
      dom.add(ee);
      out.push(ee.domain === dom, dom.members.includes(ee));
      out.push(!Object.prototype.propertyIsEnumerable.call(ee, 'domain'));
      dom.add(ee);
      out.push(dom.members.filter((m) => m === ee).length);
      dom.remove(ee);
      out.push(ee.domain === null, !dom.members.includes(ee));
      console.log(JSON.stringify(out));
    `);
  }, 30000);

  test('implicit nextTick binding', () => {
    expectSameOutput('nexttick', `
      const dom = domain.create();
      dom.run(() => {
        process.nextTick(() => {
          console.log(JSON.stringify({
            activeIsDom: domain.active === dom,
            procIsDom: process.domain === dom,
          }));
        });
      });
    `);
  }, 30000);

  test('implicit setTimeout binding', () => {
    expectSameOutput('timer', `
      const dom = domain.create();
      dom.run(() => {
        setTimeout(() => {
          console.log(JSON.stringify({
            activeIsDom: domain.active === dom,
            procIsDom: process.domain === dom,
          }));
        }, 5);
      });
    `);
  }, 30000);
});
