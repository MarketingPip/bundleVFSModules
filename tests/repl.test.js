/**
 * tests/repl.test.js — repo tests for the node:repl browser shim.
 *
 * These tests exercise OUR implementation (src/repl.js), not native Node's
 * repl: they drive a real REPLServer over streams and assert on its output.
 */
import { PassThrough } from 'node:stream';
import replDefault, {
  start,
  writer,
  isValidSyntax,
  REPLServer,
  REPL_MODE_SLOPPY,
  REPL_MODE_STRICT,
  Recoverable,
} from '../src/repl.js';

function makeRepl(options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let acc = '';
  output.on('data', (d) => { acc += d; });
  const r = start({
    prompt: '> ',
    input,
    output,
    terminal: false,
    ...options,
  });
  return {
    r,
    input,
    output,
    text: () => acc,
    clear: () => { acc = ''; },
    async write(line) {
      input.write(line.endsWith('\n') ? line : line + '\n');
      await tick(20);
    },
    async waitFor(pred, ms = 2000) {
      const startT = Date.now();
      while (!pred()) {
        if (Date.now() - startT > ms) {
          throw new Error(`timed out waiting for output; got: ${JSON.stringify(acc)}`);
        }
        await tick(10);
      }
    },
    close() { r.close(); },
  };
}

const tick = (ms) => new Promise((res) => setTimeout(res, ms));

describe('repl export surface', () => {
  test('named and default exports exist', () => {
    expect(typeof start).toBe('function');
    expect(typeof writer).toBe('function');
    expect(typeof isValidSyntax).toBe('function');
    expect(typeof REPLServer).toBe('function');
    expect(typeof Recoverable).toBe('function');
    expect(REPL_MODE_SLOPPY).toBeDefined();
    expect(REPL_MODE_STRICT).toBeDefined();
    // builtinModules is NOT a named export in real node:repl — it lives only
    // on the default export as a deprecated getter (DEP0191).
    expect(Array.isArray(replDefault.builtinModules)).toBe(true);
    expect(replDefault.start).toBe(start);
    expect(replDefault.REPLServer).toBe(REPLServer);
    expect(replDefault.Recoverable).toBe(Recoverable);
  });

  test('isValidSyntax', () => {
    expect(isValidSyntax('1+1')).toBe(true);
    expect(isValidSyntax('function f() {')).toBe(false);
    expect(isValidSyntax('{a: 1}')).toBe(true);
  });

  test('Recoverable is a SyntaxError subclass', () => {
    const e = new Recoverable(new SyntaxError('x'));
    expect(e).toBeInstanceOf(SyntaxError);
    expect(e).toBeInstanceOf(Recoverable);
  });
});

describe('basic evaluation over streams', () => {
  test('1+1 evaluates to 2 with a synchronous initial prompt', async () => {
    const t = makeRepl();
    // The initial prompt is displayed synchronously at construction.
    expect(t.text()).toBe('> ');
    await t.write('1+1');
    await t.waitFor(() => t.text().includes('2\n'));
    expect(t.text()).toBe('> 2\n> ');
    t.close();
  });

  test('statements, var, and function declarations persist across evals', async () => {
    const t = makeRepl();
    t.clear();
    await t.write('var answer = 41');
    await t.waitFor(() => t.text().includes('undefined\n'));
    await t.write('answer + 1');
    await t.waitFor(() => t.text().includes('42\n'));
    await t.write('function double(n) { return n * 2; }');
    await t.waitFor(() => t.text().includes('undefined\n'));
    await t.write('double(21)');
    await t.waitFor(() => t.text().includes('42', 1) && t.text().split('42').length > 2);
    t.close();
  });

  test('let and const bindings persist across evals', async () => {
    const t = makeRepl();
    t.clear();
    await t.write('let counter = 7');
    await t.waitFor(() => t.text().includes('undefined\n'));
    await t.write('counter * 2');
    await t.waitFor(() => t.text().includes('14\n'));
    await t.write('const name = "repl"');
    await t.waitFor(() => t.text().split('undefined\n').length > 2);
    await t.write('name');
    await t.waitFor(() => t.text().includes("'repl'"));
    t.close();
  });

  test('custom writer is used for results', async () => {
    const t = makeRepl({ writer: (v) => `<<${v}>>` });
    t.clear();
    await t.write('40 + 2');
    await t.waitFor(() => t.text().includes('<<42>>'));
    t.close();
  });

  test('_ holds the last result and r.last tracks it', async () => {
    const t = makeRepl();
    t.clear();
    await t.write('6 * 7');
    await t.waitFor(() => t.text().includes('42\n'));
    expect(t.r.last).toBe(42);
    await t.write('_ + 1');
    await t.waitFor(() => t.text().includes('43\n'));
    t.close();
  });

  test('runtime errors print as Uncaught', async () => {
    const t = makeRepl();
    t.clear();
    await t.write('throw new Error("boom")');
    await t.waitFor(() => t.text().includes('Uncaught Error: boom'));
    await t.write('null.doesNotExist');
    await t.waitFor(() => t.text().includes('Uncaught TypeError'));
    t.close();
  });

  test('ignoreUndefined suppresses undefined results', async () => {
    const t = makeRepl({ ignoreUndefined: true });
    t.clear();
    await t.write('var x = 1');
    await tick(50);
    expect(t.text()).toBe('> ');
    await t.write('x');
    await t.waitFor(() => t.text().includes('1\n'));
    t.close();
  });
});

describe('multiline / recoverable input', () => {
  test('incomplete input buffers and prompts with "| "', async () => {
    const t = makeRepl();
    t.clear();
    await t.write('function add(a, b) {');
    await t.waitFor(() => t.text().endsWith('| '));
    await t.write('return a + b;');
    await t.waitFor(() => t.text().endsWith('| '));
    await t.write('}');
    await t.waitFor(() => t.text().includes('undefined\n'));
    await t.write('add(2, 3)');
    await t.waitFor(() => t.text().includes('5\n'));
    t.close();
  });

  test('.break discards the buffered command', async () => {
    const t = makeRepl();
    t.clear();
    await t.write('function broken() {');
    await t.waitFor(() => t.text().endsWith('| '));
    await t.write('.break');
    await t.waitFor(() => t.text().endsWith('> ') && !t.text().endsWith('| '));
    expect(t.r.bufferedCommand).toBe('');
    t.close();
  });
});

describe('dot commands', () => {
  test('.exit closes the repl and emits exit', async () => {
    const t = makeRepl();
    let exited = false;
    t.r.on('exit', () => { exited = true; });
    await t.write('.exit');
    await t.waitFor(() => exited);
    expect(t.r.closed).toBe(true);
  });

  test('.help lists the default commands', async () => {
    const t = makeRepl();
    t.clear();
    await t.write('.help');
    await t.waitFor(() => t.text().includes('.exit'));
    const out = t.text();
    for (const cmd of ['.break', '.clear', '.editor', '.exit', '.help', '.load', '.save']) {
      expect(out).toContain(cmd);
    }
    t.close();
  });

  test('defineCommand registers a custom command', async () => {
    const t = makeRepl();
    t.r.defineCommand('shout', {
      help: 'shout it back',
      action(text) {
        this.output.write(`YOU SAID: ${text.toUpperCase()}\n`);
        this.displayPrompt();
      },
    });
    t.clear();
    await t.write('.shout hello there');
    await t.waitFor(() => t.text().includes('YOU SAID: HELLO THERE'));
    t.close();
  });

  test('defineCommand with a bare function works too', async () => {
    const t = makeRepl();
    t.r.defineCommand('ping', function () {
      this.output.write('pong\n');
      this.displayPrompt();
    });
    t.clear();
    await t.write('.ping');
    await t.waitFor(() => t.text().includes('pong'));
    t.close();
  });

  test('defineCommand validates the action', () => {
    const t = makeRepl();
    expect(() => t.r.defineCommand('nope', {})).toThrow(/Invalid REPL keyword/);
    t.close();
  });

  test('unknown command prints Invalid REPL keyword', async () => {
    const t = makeRepl();
    t.clear();
    await t.write('.frobnicate');
    await t.waitFor(() => t.text().includes('Invalid REPL keyword'));
    t.close();
  });

  test('.clear resets the context', async () => {
    const t = makeRepl();
    t.clear();
    await t.write('var wiped = 123');
    await t.waitFor(() => t.text().includes('undefined\n'));
    await t.write('.clear');
    await t.waitFor(() => t.text().includes('Clearing context...'));
    await t.write('typeof wiped');
    await t.waitFor(() => t.text().includes("'undefined'"));
    t.close();
  });
});

describe('modes and options', () => {
  test('strict mode prefixes code', async () => {
    const t = makeRepl({ replMode: REPL_MODE_STRICT });
    t.clear();
    await t.write('1 + 2');
    await t.waitFor(() => t.text().includes('3\n'));
    expect(t.r.replMode).toBe(REPL_MODE_STRICT);
    t.close();
  });

  test('useGlobal evaluates on globalThis', async () => {
    const t = makeRepl({ useGlobal: true });
    expect(t.r.context).toBe(globalThis);
    t.clear();
    await t.write('var __replGlobalProbe = 4242');
    await t.waitFor(() => t.text().includes('undefined\n'));
    expect(globalThis.__replGlobalProbe).toBe(4242);
    delete globalThis.__replGlobalProbe;
    t.close();
  });

  test('breakEvalOnSigint with a custom eval is rejected', () => {
    expect(() => start({
      prompt: '> ',
      input: new PassThrough(),
      output: new PassThrough(),
      terminal: false,
      eval: () => {},
      breakEvalOnSigint: true,
    })).toThrow(expect.objectContaining({ code: 'ERR_INVALID_REPL_EVAL_CONFIG' }));
  });

  test('inputStream/outputStream alias input/output', () => {
    const t = makeRepl();
    expect(t.r.inputStream).toBe(t.r.input);
    expect(t.r.outputStream).toBe(t.r.output);
    expect(t.r.terminal).toBe(false);
    expect(t.r.historySize).toBe(30);
    t.close();
  });

  test('_domain exposes on/emit/bind', () => {
    const t = makeRepl();
    expect(typeof t.r._domain.on).toBe('function');
    expect(typeof t.r._domain.emit).toBe('function');
    expect(typeof t.r._domain.bind).toBe('function');
    t.close();
  });

  test('custom eval functions are supported', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let acc = '';
    output.on('data', (d) => { acc += d; });
    const r = start({
      prompt: '> ',
      input,
      output,
      terminal: false,
      eval: (cmd, _ctx, _file, cb) => cb(null, `echo:${cmd.trim()}`),
    });
    input.write('hello\n');
    await tick(50);
    expect(acc).toContain("echo:hello");
    r.close();
  });
});

describe('top-level await', () => {
  test('awaited expressions resolve to their value', async () => {
    const t = makeRepl();
    t.clear();
    await t.write('await Promise.resolve(11)');
    await t.waitFor(() => t.text().includes('11\n'));
    t.close();
  });

  test('let declarations with await persist across evals', async () => {
    const t = makeRepl();
    t.clear();
    await t.write('let later = await Promise.resolve(99)');
    await t.waitFor(() => t.text().includes('undefined\n'));
    await t.write('later');
    await t.waitFor(() => t.text().includes('99\n'));
    t.close();
  });

  test.each([false, true])(
    'TLA declarations/functions/classes persist (useGlobal: %s)',
    async (useGlobal) => {
      const r = start({ prompt: '', terminal: false, useGlobal });
      const run = (cmd) => new Promise((resolve) => {
        r.eval(cmd, r.context, 'repl', (e, ret) =>
          resolve(e ? 'ERR:' + String(e && e.message).split('\n')[0]
                    : 'OK:' + String(ret).slice(0, 40)));
      });
      // Each entry: [input, expected output prefix].
      const cases = [
        ['class Foo {}; await 1;', 'OK:1'],
        ['Foo', 'OK:class Foo'],
        ['await 0; function foo() {}', 'OK:undefined'],
        ['foo', 'OK:function foo'],
        ['if (await true) { function bar() {}; }', 'OK:undefined'],
        ['bar', 'OK:function bar'],
        ['for (var i = 0; i < 3; ++i) { await i; }', 'OK:undefined'],
        ['i', 'OK:3'],
        ['let { aa, bb } = await Promise.resolve({ aa: 1, bb: 2 }), f = 5;', 'OK:undefined'],
        ['aa', 'OK:1'],
        ['bb', 'OK:2'],
        ['f', 'OK:5'],
        ['const k = await Promise.resolve(123)', 'OK:undefined'],
        ['k', 'OK:123'],
        ['k = await Promise.resolve(234)', 'OK:234'],
        ['const k = await Promise.resolve(345)', "ERR:Identifier 'k' has already been declared"],
        ['let o = await 1, p', 'OK:undefined'],
        ['p', 'OK:undefined'],
        ['await Promise.resolve(42)', 'OK:42'],
        ['return 42; await 5;', 'ERR:Illegal return statement'],
      ];
      for (const [input, expected] of cases) {
        const got = await run(input);
        expect(got.startsWith(expected)).toBe(true);
      }
      r.close();
    },
  );

  test('.clear resets TLA lexical bindings', async () => {
    const r = start({ prompt: '', terminal: false, useGlobal: false });
    const run = (cmd) => new Promise((resolve) => {
      r.eval(cmd, r.context, 'repl', (e, ret) =>
        resolve(e ? 'ERR:' + String(e && e.message).split('\n')[0]
                  : 'OK:' + String(ret).slice(0, 40)));
    });
    expect(await run('const zz = await Promise.resolve(7)')).toBe('OK:undefined');
    expect(await run('const zz = await Promise.resolve(8)'))
      .toBe("ERR:Identifier 'zz' has already been declared");
    r.resetContext();
    expect(await run('const zz = await Promise.resolve(8)')).toBe('OK:undefined');
    r.close();
  });
});

describe('completion', () => {
  test('completer suggests context names', async () => {
    const t = makeRepl();
    t.clear();
    await t.write('var completeMeTarget = 1');
    await t.waitFor(() => t.text().includes('undefined\n'));
    const matches = await new Promise((resolve, reject) => {
      t.r.completer.call(t.r, 'completeMe', (err, [m]) =>
        err ? reject(err) : resolve(m));
    });
    expect(matches).toContain('completeMeTarget');
    t.close();
  });
});

describe('history and completion methods', () => {
  test('setupHistory exists and accepts the Node call shapes', async () => {
    const t = makeRepl();
    expect(typeof t.r.setupHistory).toBe('function');

    // Bare callback as first arg: Node tolerates it (never fires, no throw).
    let bareFired = false;
    expect(() => t.r.setupHistory(() => { bareFired = true; })).not.toThrow();
    await tick(50);
    expect(bareFired).toBe(false);

    // Options object + callback: callback fires.
    const fired = await new Promise((resolve) => {
      t.r.setupHistory({}, () => resolve(true));
      setTimeout(() => resolve(false), 1000);
    });
    expect(fired).toBe(true);

    // Back-compat string path + callback: accepted, callback fires.
    const strFired = await new Promise((resolve) => {
      t.r.setupHistory('/tmp/repl-history', () => resolve(true));
      setTimeout(() => resolve(false), 1000);
    });
    expect(strFired).toBe(true);

    expect(t.r.setupHistory(() => {})).toBeUndefined();
    t.close();
  });

  test('complete delegates to the instance completer', async () => {
    const t = makeRepl();
    await t.write('var completeMeTarget = 1');
    await t.waitFor(() => t.text().includes('undefined\n'));
    const viaComplete = await new Promise((resolve, reject) => {
      t.r.complete('completeMe', (err, res) => err ? reject(err) : resolve(res));
    });
    const viaCompleter = await new Promise((resolve, reject) => {
      t.r.completer.call(t.r, 'completeMe', (err, res) =>
        err ? reject(err) : resolve(res));
    });
    expect(viaComplete).toEqual(viaCompleter);
    expect(viaComplete[0]).toContain('completeMeTarget');
    t.close();
  });

  test('completeOnEditorMode collapses to the common prefix', async () => {
    const t = makeRepl();
    expect(typeof t.r.completeOnEditorMode).toBe('function');
    const handler = t.r.completeOnEditorMode((err, res) => {
      expect(err).toBeNull();
      expect(res).toEqual([['ab'], 'ab']);
    });
    expect(typeof handler).toBe('function');
    handler(null, [['abc', 'abd', 'abx'], 'ab']);
    const errSeen = await new Promise((resolve) => {
      const h2 = t.r.completeOnEditorMode((err) => resolve(err));
      h2(new Error('boom'));
    });
    expect(errSeen.message).toBe('boom');
    t.close();
  });
});

describe('browser fallback (no runtime terminal)', () => {
  test('works with plain in-memory streams and no _RUNTIME_', async () => {
    expect(globalThis._RUNTIME_).toBeUndefined();
    const { EventEmitter } = await import('node:events');
    class FakeStream extends EventEmitter {
      constructor() { super(); this.chunks = []; this.isTTY = false; }
      write(s) { this.chunks.push(String(s)); return true; }
      resume() { return this; }
      pause() { return this; }
    }
    const input = new FakeStream();
    const output = new FakeStream();
    const r = start({ prompt: 'br> ', input, output, terminal: false });
    expect(output.chunks.join('')).toBe('br> ');
    input.emit('data', '1+1\n');
    await tick(50);
    const text = output.chunks.join('');
    expect(text).toContain('2\n');
    r.close();
  });

  test('falls back to a null stream when no streams are available', async () => {
    // No input/output given; under Node this resolves to process stdio,
    // in a bare browser it would be the NullStream. Either way the
    // constructor must not throw and must show a prompt.
    const { Writable } = await import('node:stream');
    const output = new Writable({ write(_c, _e, cb) { cb(); } });
    const r = start({ prompt: 'x> ', output, terminal: false });
    expect(typeof r.prompt).toBe('function');
    r.close();
  });
});
