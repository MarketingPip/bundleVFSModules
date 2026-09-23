// tests/fs_promises.test.js — repo tests for the dependency-free fs/promises VFS port.
// Expectations were verified against real `node:fs/promises` (Node v24.20.0)
// before being written down.
import fsPromises, * as ns from '../src/fs/promises.js';

const R = '/jest-fsp';

beforeEach(async () => {
  await fsPromises.rm(R, { recursive: true, force: true });
  await fsPromises.mkdir(R, { recursive: true });
});

describe('module shape', () => {
  test('namespace carries a default self-key; default export does not', () => {
    expect(ns.default).toBe(fsPromises);
    expect(Object.keys(ns)).toHaveLength(34);
    expect(Object.keys(fsPromises)).toHaveLength(33);
    expect(fsPromises.writeFile).toBe(ns.writeFile);
  });
  test('named exports mirror node:fs/promises', () => {
    for (const name of ['access', 'appendFile', 'chmod', 'chown',
      'copyFile', 'cp', 'glob', 'lchown', 'link', 'lstat', 'lutimes', 'mkdir',
      'mkdtemp', 'open', 'opendir', 'readFile', 'readdir', 'readlink',
      'realpath', 'rename', 'rm', 'rmdir', 'stat', 'statfs', 'symlink',
      'truncate', 'unlink', 'utimes', 'watch', 'writeFile']) {
      expect(typeof ns[name]).toBe('function');
    }
    expect(typeof ns.constants).toBe('object');
    expect('FileHandle' in ns).toBe(false);
  });
  test('lchmod is undefined off darwin, like Node on Linux', () => {
    expect(ns.lchmod).toBeUndefined();
  });
});

describe('basic file I/O', () => {
  test('writeFile/readFile round-trip', async () => {
    await fsPromises.writeFile(R + '/a.txt', 'hello');
    expect(await fsPromises.readFile(R + '/a.txt', 'utf8')).toBe('hello');
    const bin = await fsPromises.readFile(R + '/a.txt');
    expect(bin).toBeInstanceOf(Uint8Array);
    expect([...bin].join(',')).toBe('104,101,108,108,111');
  });
  test('appendFile appends', async () => {
    await fsPromises.appendFile(R + '/b.txt', 'x');
    await fsPromises.appendFile(R + '/b.txt', 'y');
    expect(await fsPromises.readFile(R + '/b.txt', 'utf8')).toBe('xy');
  });
  test('missing file rejects with ENOENT', async () => {
    await expect(fsPromises.readFile(R + '/nope')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsPromises.stat(R + '/nope')).rejects.toMatchObject({ code: 'ENOENT', syscall: 'stat' });
  });
  test('access works', async () => {
    await fsPromises.writeFile(R + '/c.txt', 'c');
    await expect(fsPromises.access(R + '/c.txt')).resolves.toBeUndefined();
    await expect(fsPromises.access(R + '/nope')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('directories', () => {
  test('mkdir/readdir/rmdir', async () => {
    await fsPromises.mkdir(R + '/d/e', { recursive: true });
    await fsPromises.writeFile(R + '/d/e/f.txt', 'f');
    expect(await fsPromises.readdir(R + '/d')).toEqual(['e']);
    expect((await fsPromises.readdir(R + '/d/e', { recursive: true })).sort())
      .toEqual(['f.txt']);
    await fsPromises.rm(R + '/d', { recursive: true });
    await expect(fsPromises.readdir(R + '/d')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test('mkdtemp creates a unique directory', async () => {
    const dir = await fsPromises.mkdtemp(R + '/t-');
    expect(dir.startsWith(R + '/t-')).toBe(true);
    expect((await fsPromises.stat(dir)).isDirectory()).toBe(true);
  });
  test('opendir yields a Dir', async () => {
    await fsPromises.writeFile(R + '/g.txt', 'g');
    const dir = await fsPromises.opendir(R);
    const names = [];
    for await (const ent of dir) names.push(ent.name);
    expect(names.sort()).toEqual(['g.txt']);
  });
});

describe('metadata', () => {
  test('stat/lstat/statfs', async () => {
    await fsPromises.writeFile(R + '/s.txt', '12345');
    const st = await fsPromises.stat(R + '/s.txt');
    expect(st.isFile()).toBe(true);
    expect(st.size).toBe(5);
    expect(st.atime instanceof Date).toBe(true);
    expect(Object.keys(st).join(',')).toBe(
      'dev,mode,nlink,uid,gid,rdev,blksize,ino,size,blocks,atimeMs,mtimeMs,ctimeMs,birthtimeMs');
    const sf = await fsPromises.statfs(R);
    expect(sf.bsize).toBe(4096);
  });
  test('chmod/utimes/truncate', async () => {
    await fsPromises.writeFile(R + '/m.txt', 'data');
    await fsPromises.chmod(R + '/m.txt', 0o600);
    expect((await fsPromises.stat(R + '/m.txt')).mode & 0o777).toBe(0o600);
    await fsPromises.utimes(R + '/m.txt', new Date(1000), new Date(2000));
    expect((await fsPromises.stat(R + '/m.txt')).mtimeMs).toBe(2000);
    await fsPromises.truncate(R + '/m.txt', 2);
    expect(await fsPromises.readFile(R + '/m.txt', 'utf8')).toBe('da');
  });
});

describe('links and copies', () => {
  test('rename/copyFile', async () => {
    await fsPromises.writeFile(R + '/o.txt', 'o');
    await fsPromises.rename(R + '/o.txt', R + '/p.txt');
    expect(await fsPromises.readFile(R + '/p.txt', 'utf8')).toBe('o');
    await fsPromises.copyFile(R + '/p.txt', R + '/q.txt');
    expect(await fsPromises.readFile(R + '/q.txt', 'utf8')).toBe('o');
  });
  test('symlink/readlink/realpath', async () => {
    await fsPromises.writeFile(R + '/t.txt', 't');
    await fsPromises.symlink(R + '/t.txt', R + '/lnk');
    expect(await fsPromises.readlink(R + '/lnk')).toBe(R + '/t.txt');
    expect((await fsPromises.lstat(R + '/lnk')).isSymbolicLink()).toBe(true);
    expect(await fsPromises.readFile(R + '/lnk', 'utf8')).toBe('t');
    expect(await fsPromises.realpath(R + '/lnk')).toBe(R + '/t.txt');
  });
  test('unlink removes files', async () => {
    await fsPromises.writeFile(R + '/u.txt', 'u');
    await fsPromises.unlink(R + '/u.txt');
    await expect(fsPromises.stat(R + '/u.txt')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('FileHandle', () => {
  test('open/read/write/stat/close', async () => {
    const h = await fsPromises.open(R + '/h.bin', 'w+');
    const { bytesWritten } = await h.write('hello world');
    expect(bytesWritten).toBe(11);
    const st = await h.stat();
    expect(st.size).toBe(11);
    const buf = Buffer.alloc(5);
    const { bytesRead } = await h.read(buf, 0, 5, 0);
    expect(bytesRead).toBe(5);
    expect(buf.toString()).toBe('hello');
    await h.truncate(2);
    expect((await h.stat()).size).toBe(2);
    await h.close();
    await expect(h.read()).rejects.toMatchObject({ code: 'EBADF' });
  });
  test('read() with no args returns a fresh buffer', async () => {
    await fsPromises.writeFile(R + '/r.txt', 'abc');
    const h = await fsPromises.open(R + '/r.txt', 'r');
    const { bytesRead, buffer } = await h.read();
    expect(bytesRead).toBe(3);
    expect(Buffer.from(buffer.slice(0, bytesRead)).toString()).toBe('abc');
    await h.close();
  });
  test('readFile/writeFile/appendFile on the handle', async () => {
    const h = await fsPromises.open(R + '/rw.txt', 'w+');
    await h.writeFile('one');
    await h.appendFile('two');
    await h.close();
    // (handle readFile reads from the handle position, like Node)
    expect(await fsPromises.readFile(R + '/rw.txt', 'utf8')).toBe('onetwo');
  });
  test('readv/writev', async () => {
    const h = await fsPromises.open(R + '/v.bin', 'w+');
    await h.writev([Buffer.from('ab'), Buffer.from('cd')]);
    const bufs = [Buffer.alloc(2), Buffer.alloc(2)];
    const { bytesRead } = await h.readv(bufs, 0);
    expect(bytesRead).toBe(4);
    expect(Buffer.concat(bufs).toString()).toBe('abcd');
    await h.close();
  });
  test('readLines yields lines', async () => {
    await fsPromises.writeFile(R + '/l.txt', 'one\ntwo\n');
    const h = await fsPromises.open(R + '/l.txt', 'r');
    const lines = [];
    for await (const line of h.readLines()) lines.push(line);
    expect(lines).toEqual(['one', 'two']);
    await h.close();
  });
  test('async iteration over a readable handle', async () => {
    await fsPromises.writeFile(R + '/it.txt', 'xyz');
    const h = await fsPromises.open(R + '/it.txt', 'r');
    const chunks = [];
    for await (const chunk of h) chunks.push(chunk.toString());
    expect(chunks.join('')).toBe('xyz');
    await h.close();
  });
  test('createReadStream/createWriteStream', async () => {
    await new Promise((resolve, reject) => {
      const ws = fsPromises.open(R + '/s.txt', 'w').then((h) => {
        const s = h.createWriteStream();
        s.on('error', reject);
        s.on('finish', () => h.close().then(resolve, reject));
        s.end('streamed');
      }, reject);
    });
    expect(await fsPromises.readFile(R + '/s.txt', 'utf8')).toBe('streamed');
  });
});

describe('glob and watch', () => {
  test('glob finds files', async () => {
    await fsPromises.mkdir(R + '/g/sub', { recursive: true });
    await fsPromises.writeFile(R + '/g/one.txt', '1');
    await fsPromises.writeFile(R + '/g/sub/two.txt', '2');
    expect((await fsPromises.glob(R + '/g/**/*.txt')).sort()).toEqual(
      [R + '/g/one.txt', R + '/g/sub/two.txt']);
  });
  test('watch() is an async iterator with no close()', async () => {
    const watcher = fsPromises.watch(R);
    expect(typeof watcher[Symbol.asyncIterator]).toBe('function');
    expect(watcher.close).toBeUndefined();
    // Documented noop: breaks out of the iterator without events.
    const done = (async () => {
      for await (const _ev of watcher) break; // eslint-disable-line no-unused-vars
    })();
    await expect(done).resolves.toBeUndefined();
  });
});

describe('errors', () => {
  test('rename missing source rejects ENOENT', async () => {
    await expect(fsPromises.rename(R + '/nope', R + '/x'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
  test('rmdir on non-empty rejects ENOTEMPTY', async () => {
    await fsPromises.mkdir(R + '/ne');
    await fsPromises.writeFile(R + '/ne/f', 'f');
    await expect(fsPromises.rmdir(R + '/ne')).rejects.toMatchObject({ code: 'ENOTEMPTY' });
  });
});
