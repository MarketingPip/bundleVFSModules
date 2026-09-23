// tests/fs_promises.test.js — repo tests for src/fs/promises.js.
import fp from '../src/fs/promises.js';
import fs from '../src/fs.js';

const R = '/ptest-root';

beforeEach(async () => {
  try { fs.rmSync(R, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(R, { recursive: true });
});

describe('promises file I/O', () => {
  test('writeFile/readFile roundtrip', async () => {
    await fp.writeFile(`${R}/a.txt`, 'hello');
    expect(await fp.readFile(`${R}/a.txt`, 'utf8')).toBe('hello');
  });
  test('appendFile', async () => {
    await fp.writeFile(`${R}/a.txt`, 'hello');
    await fp.appendFile(`${R}/a.txt`, ' world');
    expect(await fp.readFile(`${R}/a.txt`, 'utf8')).toBe('hello world');
  });
  test('readFile missing → ENOENT', async () => {
    await expect(fp.readFile(`${R}/nope`)).rejects.toMatchObject({ code: 'ENOENT', errno: -2 });
  });
  test('stat shape', async () => {
    await fp.writeFile(`${R}/a.txt`, 'hello');
    const st = await fp.stat(`${R}/a.txt`);
    expect(Object.keys(st)).toEqual(['dev', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'blksize',
      'ino', 'size', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs']);
    expect(st.isFile()).toBe(true);
  });
  test('constants restored', () => {
    expect(fp.constants.F_OK).toBe(0);
    expect(fp.constants).toBe(fs.constants);
  });
  test('lchmod rejects with ERR_METHOD_NOT_IMPLEMENTED on linux', async () => {
    if (process.platform === 'linux') {
      await expect(fp.lchmod(`${R}/a.txt`, 0o644)).rejects.toMatchObject({ code: 'ERR_METHOD_NOT_IMPLEMENTED' });
    }
  });
});

describe('promises directories', () => {
  test('mkdir/readdir/rmdir', async () => {
    await fp.mkdir(`${R}/d`);
    await fp.writeFile(`${R}/d/f.txt`, 'x');
    expect(await fp.readdir(`${R}/d`)).toEqual(['f.txt']);
    await fp.rm(`${R}/d`, { recursive: true });
    await expect(fp.stat(`${R}/d`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test('mkdtemp', async () => {
    const dir = await fp.mkdtemp(`${R}/tmp-`);
    expect((await fp.stat(dir)).isDirectory()).toBe(true);
  });
  test('cp recursive', async () => {
    await fp.mkdir(`${R}/d`);
    await fp.writeFile(`${R}/d/f.txt`, 'x');
    await fp.cp(`${R}/d`, `${R}/d2`, { recursive: true });
    expect(await fp.readFile(`${R}/d2/f.txt`, 'utf8')).toBe('x');
  });
  test('glob as async iterable', async () => {
    await fp.writeFile(`${R}/a.txt`, 'x');
    await fp.mkdir(`${R}/sub`);
    await fp.writeFile(`${R}/sub/b.txt`, 'x');
    const names = [];
    for await (const p of fp.glob('**/*.txt', { cwd: R })) names.push(p);
    expect(names).toContain('a.txt');
    expect(names).toContain('sub/b.txt');
  });
  test('opendir for-await auto-closes', async () => {
    await fp.writeFile(`${R}/a.txt`, 'x');
    const dir = await fp.opendir(R);
    const names = [];
    for await (const d of dir) names.push(d.name);
    expect(names).toContain('a.txt');
    await expect(dir.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
  });
});

describe('FileHandle', () => {
  test('open/read/close', async () => {
    await fp.writeFile(`${R}/a.txt`, 'hello world');
    const h = await fp.open(`${R}/a.txt`, 'r');
    const { bytesRead, buffer } = await h.read();
    expect(bytesRead).toBe(11);
    expect(buffer.slice(0, bytesRead).toString()).toBe('hello world');
    await h.close();
  });
  test('no-arg read allocates buffer', async () => {
    await fp.writeFile(`${R}/a.txt`, 'hi');
    const h = await fp.open(`${R}/a.txt`, 'r');
    const { bytesRead } = await h.read();
    expect(bytesRead).toBe(2);
    await h.close();
  });
  test('string write', async () => {
    const h = await fp.open(`${R}/a.txt`, 'w');
    const { bytesWritten } = await h.write('hello');
    expect(bytesWritten).toBe(5);
    await h.close();
    expect(await fp.readFile(`${R}/a.txt`, 'utf8')).toBe('hello');
  });
  test('readv/writev', async () => {
    await fp.writeFile(`${R}/a.txt`, 'hello world');
    const h = await fp.open(`${R}/a.txt`, 'r');
    const r = await h.readv([Buffer.alloc(2), Buffer.alloc(3)], 1);
    expect(r.bytesRead).toBe(5);
    await h.close();
    const h2 = await fp.open(`${R}/b.txt`, 'w');
    const w = await h2.writev([Buffer.from('ab'), Buffer.from('cd')]);
    expect(w.bytesWritten).toBe(4);
    await h2.close();
    expect(await fp.readFile(`${R}/b.txt`, 'utf8')).toBe('abcd');
  });
  test('stat shape', async () => {
    await fp.writeFile(`${R}/a.txt`, 'hello');
    const h = await fp.open(`${R}/a.txt`, 'r');
    const st = await h.stat();
    expect(st.isFile()).toBe(true);
    expect(Object.keys(st)).toContain('birthtimeMs');
    await h.close();
  });
  test('readLines', async () => {
    await fp.writeFile(`${R}/a.txt`, 'l1\nl2\nl3');
    const h = await fp.open(`${R}/a.txt`, 'r');
    const lines = [];
    for await (const line of h.readLines()) lines.push(line);
    expect(lines).toEqual(['l1', 'l2', 'l3']);
    await h.close();
  });
  test('async iteration', async () => {
    await fp.writeFile(`${R}/a.txt`, 'hello');
    const h = await fp.open(`${R}/a.txt`, 'r');
    let data = '';
    for await (const chunk of h) data += chunk.toString();
    expect(data).toBe('hello');
    await h.close();
  });
  test('createReadStream from handle with autoClose', async () => {
    await fp.writeFile(`${R}/a.txt`, 'stream-me');
    const h = await fp.open(`${R}/a.txt`, 'r');
    const rs = h.createReadStream();
    let data = '';
    for await (const chunk of rs) data += chunk.toString();
    expect(data).toBe('stream-me');
    await h.close();
  });
  test('readableWebStream', async () => {
    await fp.writeFile(`${R}/a.txt`, 'web');
    const h = await fp.open(`${R}/a.txt`, 'r');
    const ws = await h.readableWebStream();
    const reader = ws.getReader();
    let data = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      data += Buffer.from(value).toString();
    }
    expect(data).toBe('web');
    await h.close();
  });
  test('FileHandle not publicly exposed', () => {
    expect(fp.FileHandle).toBeUndefined();
  });
});

describe('promises watch', () => {
  test('watch yields events via async iteration', async () => {
    await fp.writeFile(`${R}/w.txt`, 'v1');
    const watcher = fp.watch(`${R}/w.txt`);
    const events = [];
    const done = (async () => {
      for await (const ev of watcher) {
        events.push(ev);
        break;
      }
    })();
    setTimeout(() => fs.writeFileSync(`${R}/w.txt`, 'v2'), 300);
    await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
    expect(events.length).toBe(1);
    expect(typeof events[0].eventType).toBe('string');
    await watcher.close();
  }, 15000);
});

describe('promises misc', () => {
  test('lutimes/statfs', async () => {
    await fp.writeFile(`${R}/a.txt`, 'x');
    await fp.lutimes(`${R}/a.txt`, new Date(1000), new Date(2000));
    const s = await fp.statfs(R);
    expect(s).toHaveProperty('frsize');
  });
  test('truncate negative → 0', async () => {
    await fp.writeFile(`${R}/a.txt`, 'hello');
    await fp.truncate(`${R}/a.txt`, -5);
    expect((await fp.stat(`${R}/a.txt`)).size).toBe(0);
  });
  test('rename/unlink', async () => {
    await fp.writeFile(`${R}/a.txt`, 'x');
    await fp.rename(`${R}/a.txt`, `${R}/b.txt`);
    expect(await fp.readFile(`${R}/b.txt`, 'utf8')).toBe('x');
    await fp.unlink(`${R}/b.txt`);
    await expect(fp.stat(`${R}/b.txt`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test('symlink/readlink/realpath', async () => {
    await fp.writeFile(`${R}/a.txt`, 'x');
    await fp.symlink(`${R}/a.txt`, `${R}/link.txt`);
    expect(await fp.readlink(`${R}/link.txt`)).toBe(`${R}/a.txt`);
    expect(await fp.realpath(`${R}/link.txt`)).toBe(`${R}/a.txt`);
  });
});
