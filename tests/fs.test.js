// tests/fs.test.js — repo tests for the memfs-backed src/fs.js.
import fs from '../src/fs.js';

const R = '/test-root';

beforeEach(() => {
  try { fs.rmSync(R, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(R, { recursive: true });
});

describe('basic file I/O', () => {
  test('writeFileSync/readFileSync roundtrip', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello');
    expect(fs.readFileSync(`${R}/a.txt`, 'utf8')).toBe('hello');
  });
  test('writeFileSync/readFileSync binary roundtrip', () => {
    const data = Buffer.from([0, 1, 2, 255]);
    fs.writeFileSync(`${R}/b.bin`, data);
    expect(fs.readFileSync(`${R}/b.bin`)).toEqual(data);
  });
  test('appendFileSync appends', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello');
    fs.appendFileSync(`${R}/a.txt`, ' world');
    expect(fs.readFileSync(`${R}/a.txt`, 'utf8')).toBe('hello world');
  });
  test('readFile callback', (done) => {
    fs.writeFileSync(`${R}/a.txt`, 'hi');
    fs.readFile(`${R}/a.txt`, 'utf8', (err, data) => {
      expect(err).toBeNull();
      expect(data).toBe('hi');
      done();
    });
  });
  test('readFile missing → ENOENT with errno/syscall', (done) => {
    fs.readFile(`${R}/nope.txt`, (err) => {
      expect(err.code).toBe('ENOENT');
      expect(err.errno).toBe(-2);
      expect(err.syscall).toBe('open');
      done();
    });
  });
  test('readFileSync missing → ENOENT', () => {
    try {
      fs.readFileSync(`${R}/nope.txt`);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('ENOENT');
      expect(e.errno).toBe(-2);
    }
  });
  test('readFile accepts fd', () => {
    fs.writeFileSync(`${R}/a.txt`, 'fd-read');
    const fd = fs.openSync(`${R}/a.txt`, 'r');
    expect(fs.readFileSync(fd, 'utf8')).toBe('fd-read');
    fs.closeSync(fd);
  });
  test('unknown encoding → ERR_INVALID_ARG_VALUE, no syscall', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hi');
    try {
      fs.readFileSync(`${R}/a.txt`, 'bad-enc');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('ERR_INVALID_ARG_VALUE');
      expect(e.syscall).toBeUndefined();
    }
  });
});

describe('Stats shape', () => {
  test('enumerable keys match Node', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello');
    const keys = Object.keys(fs.statSync(`${R}/a.txt`));
    expect(keys).toEqual(['dev', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'blksize',
      'ino', 'size', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs']);
  });
  test('date fields are prototype getters returning Date', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello');
    const st = fs.statSync(`${R}/a.txt`);
    expect(st.birthtime instanceof Date).toBe(true);
    expect(Object.keys(st)).not.toContain('birthtime');
  });
  test('type methods', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello');
    fs.mkdirSync(`${R}/d`);
    expect(fs.statSync(`${R}/a.txt`).isFile()).toBe(true);
    expect(fs.statSync(`${R}/d`).isDirectory()).toBe(true);
  });
  test('bigint stats have *Ns fields', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello');
    const st = fs.statSync(`${R}/a.txt`, { bigint: true });
    expect(typeof st.size).toBe('bigint');
    expect(typeof st.atimeNs).toBe('bigint');
    expect(Object.keys(st)).toContain('birthtimeNs');
  });
  test('lstat does not follow symlinks', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello');
    fs.symlinkSync(`${R}/a.txt`, `${R}/link.txt`);
    expect(fs.lstatSync(`${R}/link.txt`).isSymbolicLink()).toBe(true);
    expect(fs.statSync(`${R}/link.txt`).isFile()).toBe(true);
  });
});

describe('Dirent shape', () => {
  test('enumerable keys are name, parentPath', () => {
    fs.writeFileSync(`${R}/a.txt`, 'x');
    const [d] = fs.readdirSync(R, { withFileTypes: true });
    expect(Object.keys(d)).toEqual(['name', 'parentPath']);
    expect(d.name).toBe('a.txt');
    expect(d.parentPath).toBe(R);
    expect(d.isFile()).toBe(true);
  });
});

describe('descriptors', () => {
  test('positional read preserves cursor', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello world');
    const fd = fs.openSync(`${R}/a.txt`, 'r');
    const b1 = Buffer.alloc(4), b2 = Buffer.alloc(2);
    fs.readSync(fd, b1, 0, 4, 2);
    fs.readSync(fd, b2, 0, 2);
    fs.closeSync(fd);
    expect(b1.toString()).toBe('llo ');
    expect(b2.toString()).toBe('he');
  });
  test('positional write preserves cursor', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello world');
    const fd = fs.openSync(`${R}/a.txt`, 'r+');
    fs.writeSync(fd, 'XX', 0, 'utf8');
    const b = Buffer.alloc(5);
    fs.readSync(fd, b, 0, 5, 0);
    fs.closeSync(fd);
    expect(b.toString()).toBe('XXllo');
    // cursor was at 0 for the non-positional read after restore
    const fd2 = fs.openSync(`${R}/a.txt`, 'r');
    const b2 = Buffer.alloc(2);
    fs.readSync(fd2, b2, 0, 2);
    fs.closeSync(fd2);
    expect(b2.toString()).toBe('XX');
  });
  test('read from write-only fd → EBADF', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello');
    const fd = fs.openSync(`${R}/a.txt`, 'w');
    try {
      fs.readSync(fd, Buffer.alloc(4), 0, 4, 0);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('EBADF');
    } finally { fs.closeSync(fd); }
  });
  test('write to read-only fd → EBADF', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello');
    const fd = fs.openSync(`${R}/a.txt`, 'r');
    try {
      fs.writeSync(fd, 'x');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('EBADF');
      expect(e.syscall).toBe('write');
    } finally { fs.closeSync(fd); }
  });
  test('readvSync/writevSync', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello world');
    const fd = fs.openSync(`${R}/a.txt`, 'r');
    const b1 = Buffer.alloc(2), b2 = Buffer.alloc(3);
    expect(fs.readvSync(fd, [b1, b2], 1)).toBe(5);
    fs.closeSync(fd);
    expect(b1.toString() + b2.toString()).toBe('ello ');
    const fd2 = fs.openSync(`${R}/b.txt`, 'w');
    expect(fs.writevSync(fd2, [Buffer.from('ab'), Buffer.from('cd')])).toBe(4);
    fs.closeSync(fd2);
    expect(fs.readFileSync(`${R}/b.txt`, 'utf8')).toBe('abcd');
  });
  test('read beyond EOF returns 0', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hi');
    const fd = fs.openSync(`${R}/a.txt`, 'r');
    expect(fs.readSync(fd, Buffer.alloc(4), 0, 4, 100)).toBe(0);
    fs.closeSync(fd);
  });
  test('ArrayBuffer/DataView normalization', () => {
    const fd = fs.openSync(`${R}/a.txt`, 'w');
    const ab = new Uint8Array([104, 105]).buffer;
    fs.writeSync(fd, ab);
    fs.closeSync(fd);
    expect(fs.readFileSync(`${R}/a.txt`, 'utf8')).toBe('hi');
  });
});

describe('directories', () => {
  test('mkdir recursive', () => {
    fs.mkdirSync(`${R}/a/b/c`, { recursive: true });
    expect(fs.statSync(`${R}/a/b/c`).isDirectory()).toBe(true);
  });
  test('recursive mkdir on existing file → EEXIST', () => {
    fs.writeFileSync(`${R}/f.txt`, 'x');
    expect(() => fs.mkdirSync(`${R}/f.txt`, { recursive: true })).toThrow(/EEXIST/);
  });
  test('readdir recursive', () => {
    fs.mkdirSync(`${R}/sub`);
    fs.writeFileSync(`${R}/sub/g.txt`, 'x');
    const names = fs.readdirSync(R, { recursive: true });
    expect(names).toContain('sub/g.txt');
  });
  test('rename dir->file → ENOTDIR; file->dir → EISDIR', () => {
    fs.mkdirSync(`${R}/d`);
    fs.writeFileSync(`${R}/f.txt`, 'x');
    expect(() => fs.renameSync(`${R}/d`, `${R}/f.txt`)).toThrow(/ENOTDIR/);
    expect(() => fs.renameSync(`${R}/f.txt`, `${R}/d`)).toThrow(/EISDIR/);
  });
  test('unlink directory → EISDIR', () => {
    fs.mkdirSync(`${R}/d`);
    try {
      fs.unlinkSync(`${R}/d`);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('EISDIR');
      expect(e.errno).toBe(-21);
    }
  });
  test('rm dir without recursive → ERR_FS_EISDIR', () => {
    fs.mkdirSync(`${R}/d`);
    try {
      fs.rmSync(`${R}/d`);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('ERR_FS_EISDIR');
      expect(e.errno).toBe(21);
      expect(e.syscall).toBe('rm');
    }
  });
});

describe('truncate', () => {
  test('negative length → 0', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello');
    fs.truncateSync(`${R}/a.txt`, -5);
    expect(fs.statSync(`${R}/a.txt`).size).toBe(0);
  });
  test('fractional length → ERR_OUT_OF_RANGE, no syscall', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello');
    try {
      fs.truncateSync(`${R}/a.txt`, 1.5);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('ERR_OUT_OF_RANGE');
      expect(e.syscall).toBeUndefined();
    }
  });
});

describe('access', () => {
  test('F_OK on existing file', () => {
    fs.writeFileSync(`${R}/a.txt`, 'x');
    expect(() => fs.accessSync(`${R}/a.txt`)).not.toThrow();
  });
  test('missing file → ENOENT', () => {
    expect(() => fs.accessSync(`${R}/nope`)).toThrow(/ENOENT/);
  });
  test('W_OK on 0444 → EACCES', () => {
    fs.writeFileSync(`${R}/m.txt`, 'x');
    fs.chmodSync(`${R}/m.txt`, 0o444);
    try {
      fs.accessSync(`${R}/m.txt`, fs.constants.W_OK);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('EACCES');
    }
  });
  test('bad mode type → ERR_INVALID_ARG_TYPE', () => {
    fs.writeFileSync(`${R}/a.txt`, 'x');
    try {
      fs.accessSync(`${R}/a.txt`, 'x');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('ERR_INVALID_ARG_TYPE');
      expect(e.syscall).toBeUndefined();
    }
  });
});

describe('cp', () => {
  test('cp file', () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello');
    fs.cpSync(`${R}/a.txt`, `${R}/b.txt`);
    expect(fs.readFileSync(`${R}/b.txt`, 'utf8')).toBe('hello');
  });
  test('cp dir without recursive → ERR_FS_EISDIR', () => {
    fs.mkdirSync(`${R}/d`);
    expect(() => fs.cpSync(`${R}/d`, `${R}/d2`)).toThrow(/ERR_FS_EISDIR/);
  });
  test('cp dir recursive', () => {
    fs.mkdirSync(`${R}/d`);
    fs.writeFileSync(`${R}/d/f.txt`, 'x');
    fs.cpSync(`${R}/d`, `${R}/d2`, { recursive: true });
    expect(fs.readFileSync(`${R}/d2/f.txt`, 'utf8')).toBe('x');
  });
  test('cp missing src → ENOENT syscall lstat', () => {
    try {
      fs.cpSync(`${R}/nope`, `${R}/x`);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('ENOENT');
      expect(e.syscall).toBe('lstat');
    }
  });
  test('cp file onto dir → ERR_FS_CP_NON_DIR_TO_DIR', () => {
    fs.writeFileSync(`${R}/a.txt`, 'x');
    fs.mkdirSync(`${R}/d`);
    expect(() => fs.cpSync(`${R}/a.txt`, `${R}/d`)).toThrow(/ERR_FS_CP_NON_DIR_TO_DIR/);
  });
  test('cp mode > 7 → ERR_OUT_OF_RANGE', () => {
    fs.writeFileSync(`${R}/a.txt`, 'x');
    try {
      fs.cpSync(`${R}/a.txt`, `${R}/b.txt`, { mode: 8 });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('ERR_OUT_OF_RANGE');
    }
  });
});

describe('glob', () => {
  test('globSync relative → cwd-relative results', () => {
    fs.writeFileSync(`${R}/a.txt`, 'x');
    fs.mkdirSync(`${R}/sub`);
    fs.writeFileSync(`${R}/sub/b.txt`, 'x');
    const out = fs.globSync('**/*.txt', { cwd: R });
    expect(out).toContain('a.txt');
    expect(out).toContain('sub/b.txt');
    expect(out.every((p) => !p.startsWith('/'))).toBe(true);
  });
  test('globSync absolute → absolute results', () => {
    fs.writeFileSync(`${R}/a.txt`, 'x');
    const out = fs.globSync(`${R}/*.txt`);
    expect(out).toEqual([`${R}/a.txt`]);
  });
});

describe('opendir/Dir', () => {
  test('opendirSync + readSync iteration', () => {
    fs.writeFileSync(`${R}/a.txt`, 'x');
    const dir = fs.opendirSync(R);
    const entry = dir.readSync();
    expect(entry.name).toBe('a.txt');
    expect(entry.isFile()).toBe(true);
    dir.closeSync();
  });
  test('for-await auto-closes; further ops → ERR_DIR_CLOSED', async () => {
    fs.writeFileSync(`${R}/a.txt`, 'x');
    const dir = fs.opendirSync(R);
    const names = [];
    for await (const d of dir) names.push(d.name);
    expect(names).toContain('a.txt');
    try { dir.readSync(); throw new Error('should have thrown'); }
    catch (e) { expect(e.code).toBe('ERR_DIR_CLOSED'); }
    try { dir.closeSync(); throw new Error('should have thrown'); }
    catch (e) { expect(e.code).toBe('ERR_DIR_CLOSED'); }
  });
});

describe('lutimes/statfs', () => {
  test('lutimesSync sets symlink times without touching target', () => {
    fs.writeFileSync(`${R}/a.txt`, 'x');
    fs.symlinkSync(`${R}/a.txt`, `${R}/link.txt`);
    fs.lutimesSync(`${R}/link.txt`, new Date(1000), new Date(2000));
    const lst = fs.lstatSync(`${R}/link.txt`);
    expect(lst.atimeMs).toBe(1000);
    expect(lst.mtimeMs).toBe(2000);
  });
  test('statfsSync keys include frsize', () => {
    const s = fs.statfsSync(R);
    for (const k of ['type', 'bsize', 'frsize', 'blocks', 'bfree', 'bavail', 'files', 'ffree']) {
      expect(s).toHaveProperty(k);
    }
  });
});

describe('misc APIs', () => {
  test('existsSync false for invalid paths, never throws', () => {
    expect(fs.existsSync(`${R}/nope`)).toBe(false);
    expect(fs.existsSync(123)).toBe(false);
    expect(fs.existsSync(null)).toBe(false);
  });
  test('mkdtempSync creates dir', () => {
    const dir = fs.mkdtempSync(`${R}/tmp-`);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });
  test('realpathSync.native exists', () => {
    fs.writeFileSync(`${R}/a.txt`, 'x');
    expect(typeof fs.realpathSync.native).toBe('function');
    expect(fs.realpathSync.native(`${R}/a.txt`)).toBe(`${R}/a.txt`);
  });
  test('FileReadStream/FileWriteStream aliases', () => {
    expect(fs.FileReadStream).toBe(fs.ReadStream);
    expect(fs.FileWriteStream).toBe(fs.WriteStream);
  });
  test('openAsBlob', async () => {
    fs.writeFileSync(`${R}/a.txt`, 'hello');
    const blob = await fs.openAsBlob(`${R}/a.txt`);
    expect(blob.size).toBe(5);
  });
  test('constants', () => {
    expect(fs.constants.F_OK).toBe(0);
    expect(fs.constants.O_CREAT).toBeGreaterThan(0);
  });
  test('FileHandle not public', () => {
    expect(fs.FileHandle).toBeUndefined();
    expect(fs.promises.FileHandle).toBeUndefined();
  });
  test('lchmod/lchmodSync undefined on linux', () => {
    if (process.platform === 'linux') {
      expect(fs.lchmod).toBeUndefined();
      expect(fs.lchmodSync).toBeUndefined();
    }
  });
});

describe('streams', () => {
  test('createWriteStream/createReadStream roundtrip', (done) => {
    const ws = fs.createWriteStream(`${R}/s.txt`);
    ws.on('finish', () => {
      const rs = fs.createReadStream(`${R}/s.txt`, { encoding: 'utf8' });
      let data = '';
      rs.on('data', (c) => { data += c; });
      rs.on('end', () => {
        expect(data).toBe('stream-data');
        done();
      });
    });
    ws.write('stream-');
    ws.end('data');
  });
  test('autoClose:false keeps fd open', (done) => {
    const fd = fs.openSync(`${R}/s.txt`, 'w');
    const ws = fs.createWriteStream(`${R}/s.txt`, { fd, autoClose: false });
    ws.on('finish', () => {
      // fd should still be usable
      fs.writeSync(fd, 'more');
      fs.closeSync(fd);
      expect(fs.readFileSync(`${R}/s.txt`, 'utf8')).toContain('more');
      done();
    });
    ws.end('data');
  });
});

describe('watchers', () => {
  test('watchFile fires on change', (done) => {
    fs.writeFileSync(`${R}/w.txt`, 'v1');
    const watcher = fs.watchFile(`${R}/w.txt`, { interval: 100 }, (curr, prev) => {
      expect(curr.mtimeMs).not.toBe(prev.mtimeMs);
      fs.unwatchFile(`${R}/w.txt`);
      done();
    });
    expect(typeof watcher.unref).toBe('function');
    expect(typeof watcher.ref).toBe('function');
    setTimeout(() => fs.writeFileSync(`${R}/w.txt`, 'v2'), 200);
  }, 10000);
  test('watch returns watcher with ref/unref', (done) => {
    fs.writeFileSync(`${R}/w2.txt`, 'v1');
    const w = fs.watch(`${R}/w2.txt`, (eventType) => {
      expect(typeof eventType).toBe('string');
      w.close();
      done();
    });
    expect(typeof w.ref).toBe('function');
    expect(typeof w.unref).toBe('function');
    setTimeout(() => fs.writeFileSync(`${R}/w2.txt`, 'v2'), 200);
  }, 10000);
});

describe('runtime integration', () => {
  test('_vol is the real memfs Volume with toJSON/readFileSync', () => {
    expect(fs._vol.constructor.name).toBe('Volume');
    expect(typeof fs._vol.toJSON).toBe('function');
    expect(typeof fs.readFileSync).toBe('function');
  });
  test('_vol.toJSON contains written files', () => {
    fs.writeFileSync(`${R}/seed.txt`, 'seeded');
    expect(JSON.stringify(fs._vol.toJSON())).toContain('seed.txt');
  });
  test('emitMe receives fs events', (done) => {
    const events = [];
    globalThis.emitMe = (...args) => { events.push(args); };
    try {
      fs.writeFileSync(`${R}/e.txt`, 'x');
      fs.readFileSync(`${R}/e.txt`, 'utf8');
      expect(events.some((a) => a[0] === 'fs' && a[1] === 'writeFileSync')).toBe(true);
      expect(events.some((a) => a[0] === 'fs' && a[1] === 'readFileSync')).toBe(true);
    } finally {
      delete globalThis.emitMe;
    }
    // promise events
    globalThis.emitMe = (...args) => { events.push(args); };
    fs.promises.writeFile(`${R}/e2.txt`, 'y').then(() => {
      expect(events.some((a) => a[0] === 'fs' && a[1] === 'promises.writeFile')).toBe(true);
      delete globalThis.emitMe;
      done();
    });
  });
  test('seeds from __USER_FILES__ (flat)', async () => {
    const prevRuntime = globalThis._RUNTIME_;
    globalThis._RUNTIME_ = { __USER_FILES__: { '/seeded.txt': 'seed-content' } };
    try {
      // Query string forces a fresh module instance with its own volume.
      const mod = await import(`../src/fs.js?seed=${Date.now()}`);
      expect(mod.default.readFileSync('/seeded.txt', 'utf8')).toBe('seed-content');
      expect(mod.default._vol.constructor.name).toBe('Volume');
    } finally {
      if (prevRuntime === undefined) delete globalThis._RUNTIME_;
      else globalThis._RUNTIME_ = prevRuntime;
    }
  });
});
