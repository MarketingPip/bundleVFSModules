#!/usr/bin/env node
// Differential test: compares the stream port against real Node's stream.
// Runs the same scenarios against both and diffs observable behavior.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nodeStream = require('stream');
const nodePromises = require('stream/promises');
const nodeConsumers = require('stream/consumers');

const port = await import('../../src/stream.js');
const portPromises = await import('../../src/stream/promises.js');
const portConsumers = await import('../../src/stream/consumers.js');

let pass = 0, fail = 0;
const failures = [];
function check(name, a, b) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa === sb) { pass++; }
  else { fail++; failures.push(`${name}: port=${sa} node=${sb}`); }
}
async function scenario(name, fn) {
  try {
    const [a, b] = await Promise.all([fn(port), fn(nodeStream)]);
    check(name, a, b);
  } catch (e) {
    fail++; failures.push(`${name}: threw ${e.message}`);
  }
}

// --- export inventory ---
{
  const pk = Object.keys(port.default).sort();
  const nk = Object.keys(nodeStream).sort();
  check('export keys', pk, nk);
  for (const k of ['Readable', 'Writable', 'Duplex', 'Transform', 'PassThrough']) {
    check(`typeof ${k}`, typeof port.default[k], typeof nodeStream[k]);
  }
}

// --- basic pipe ---
await scenario('pipe data', async (s) => {
  const seen = [];
  await new Promise((res, rej) => {
    s.pipeline(
      s.Readable.from([1, 2, 3]),
      new s.Writable({ objectMode: true, write(c, e, cb) { seen.push(c); cb(); } }),
      (e) => e ? rej(e) : res()
    );
  });
  return seen;
});

// --- async iteration order ---
await scenario('async iter', async (s) => {
  const out = [];
  for await (const x of s.Readable.from(['a', 'b', 'c'])) out.push(String(x));
  return out;
});

// --- transform ---
await scenario('transform', async (s) => {
  const t = new s.Transform({ transform(c, e, cb) { cb(null, String(c).toUpperCase()); } });
  t.end('hello');
  const out = [];
  for await (const x of t) out.push(x.toString());
  return out;
});

// --- finished callback style ---
await scenario('finished ok', async (s) => {
  const r = s.Readable.from([1]); r.resume();
  await new Promise((res, rej) => s.finished(r, (e) => e ? rej(e) : res()));
  return 'ok';
});

// --- finished error ---
await scenario('finished error code', async (s) => {
  const r = new s.Readable({ read() {} });
  const p = new Promise((res) => s.finished(r, (e) => res(e && e.code)));
  r.destroy(new Error('boom'));
  return p;
});

// --- pipeline error propagation ---
await scenario('pipeline error', async (s) => {
  const err = await new Promise((res) => {
    const bad = new s.Readable({ read() { this.destroy(new Error('x')); } });
    const w = new s.Writable({ write(c, e, cb) { cb(); } });
    s.pipeline(bad, w, (e) => res(e && e.message));
  });
  return err;
});

// --- promises.pipeline ---
{
  const [a, b] = await Promise.all([
    (async () => {
      const seen = [];
      await portPromises.pipeline(
        port.default.Readable.from([1, 2]),
        new port.default.Writable({ objectMode: true, write(c, e, cb) { seen.push(c); cb(); } })
      );
      return seen;
    })(),
    (async () => {
      const seen = [];
      await nodePromises.pipeline(
        nodeStream.Readable.from([1, 2]),
        new nodeStream.Writable({ objectMode: true, write(c, e, cb) { seen.push(c); cb(); } })
      );
      return seen;
    })(),
  ]);
  check('promises.pipeline', a, b);
}

// --- consumers ---
for (const fn of ['text', 'json', 'arrayBuffer', 'buffer', 'blob']) {
  const [a, b] = await Promise.all([
    (async () => {
      const v = await portConsumers[fn](port.default.Readable.from(['{"a":1}']));
      return fn === 'arrayBuffer' ? v.byteLength : fn === 'blob' ? v.size : String(v);
    })(),
    (async () => {
      const v = await nodeConsumers[fn](nodeStream.Readable.from(['{"a":1}']));
      return fn === 'arrayBuffer' ? v.byteLength : fn === 'blob' ? v.size : String(v);
    })(),
  ]);
  check(`consumers.${fn}`, a, b);
}

// --- error codes/messages ---
await scenario('ERR_STREAM_PUSH_AFTER_EOF', async (s) => {
  const r = new s.Readable({ read() {} });
  const code = await new Promise((res) => {
    r.on('error', (e) => res(e.code));
    r.push(null);
    try { r.push('x'); } catch (e) { res('sync:' + e.code); }
  });
  return code;
});

await scenario('write after end code', async (s) => {
  const w = new s.Writable({ write(c, e, cb) { cb(); } });
  w.end('x');
  return new Promise((res) => {
    w.on('error', (e) => res(e.code));
    w.write('y');
    setTimeout(() => res('no-error'), 100);
  });
});

// --- duplex ---
await scenario('duplex', async (s) => {
  const d = new s.Duplex({
    read() { this.push('hi'); this.push(null); },
    write(c, e, cb) { cb(); },
  });
  const out = [];
  for await (const x of d) out.push(x.toString());
  return out;
});

// --- compose ---
await scenario('compose', async (s) => {
  const t1 = new s.Transform({ transform(c, e, cb) { cb(null, String(c) + '1'); } });
  const t2 = new s.Transform({ transform(c, e, cb) { cb(null, String(c) + '2'); } });
  const c = s.compose(t1, t2);
  c.end('a');
  const out = [];
  for await (const x of c) out.push(x.toString());
  return out;
});

// --- toWeb/fromWeb roundtrip ---
await scenario('toWeb/fromWeb', async (s) => {
  const web = s.Readable.toWeb(s.Readable.from(['z']));
  const back = s.Readable.fromWeb(web);
  const out = [];
  for await (const x of back) out.push(x.toString());
  return out;
});

// --- isDisturbed/isReadable/isWritable ---
await scenario('isDisturbed', async (s) => {
  const r = s.Readable.from([1]);
  const before = s.isDisturbed(r);
  r.read();
  return [before, s.isDisturbed(r)];
});

// --- high water mark ---
await scenario('defaultHWM', async (s) => {
  const before = s.getDefaultHighWaterMark(false);
  s.setDefaultHighWaterMark(false, 12345);
  const after = s.getDefaultHighWaterMark(false);
  s.setDefaultHighWaterMark(false, before);
  return [before, after];
});

console.log(`\nDifferential: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log('  FAIL:', f);
process.exit(fail ? 1 : 0);
