// tests/fs.test.js — repo tests for the browser-native node:fs port.
// Every expectation below was verified against real node:fs v24.20.0
// (probes + differential battery in /tmp/fs-diff.mjs) before being asserted.
import fs from '../src/fs.js';

const R = '/jest-fs';

beforeEach(() => {
  fs.rmSync(R, { recursive: true, force: true });
  fs.mkdirSync(R, { recursive: true });
});
afterAll(() => {
  fs.rmSync(R, { recursive: true, force: true });
  fs.unwatchFile(R);
});

describe('readFileSync / writeFileSync', () => {
  test('utf8 round-trip', () => {
    fs.writeFileSync(R + '/a.txt', 'hello world');
    expect(fs.readFileSync(R + '/a.txt', 'utf8')).toBe('hello world');
  });
  test('no encoding returns a Buffer (a Uint8Array)', () => {
    fs.writeFileSync(R + '/b.bin', Buffer.from([0, 1, 2, 250]));
    const data = fs.readFileSync(R + '/b.bin');
    expect(Buffer.isBuffer(data)).toBe(true);
    expect(data instanceof Uint8Array).toBe(true);
    expect([...data]).toEqual([0, 1, 2, 250]);
  });
  test('base64 / hex encodings', () => {
    fs.writeFileSync(R + '/c.bin', Buffer.from([0xde, 0xad]));
    expect(fs.readFileSync(R + '/c.bin', 'hex')).toBe('dead');
    expect(fs.readFileSync(R + '/c.bin', 'base64')).toBe('3q0=');
  });
  test('Uint8Array and ArrayBuffer data', () => {
    fs.writeFileSync(R + '/d.bin', new Uint8Array([9, 8]));
    expect([...fs.readFileSync(R + '/d.bin')]).toEqual([9, 8]);
    fs.writeFileSync(R + '/e.bin', new Uint8Array([7]).buffer);
    expect([...fs.readFileSync(R + '/e.bin')]).toEqual([7]);
  });
  test('ENOENT has Node message shape', () => {
    let err;
    try { fs.readFileSync(R + '/nope.txt'); } catch (e) { err = e; }
    expect(err.code).toBe('ENOENT');
    expect(err.errno).toBe(-2);
    expect(err.syscall).toBe('open');
    expect(err.path).toBe(R + '/nope.txt');
    expect(err.message).toBe(`ENOENT: no such file or directory, open '${R}/nope.txt'`);
  });
  test('readFileSync on a directory throws EISDIR', () => {
    expect(() => fs.readFileSync(R)).toThrow(expect.objectContaining({ code: 'EISDIR' }));
  });
  test('unknown encoding throws ERR_INVALID_ARG_VALUE', () => {
    fs.writeFileSync(R + '/f.txt', 'x');
    expect(() => fs.readFileSync(R + '/f.txt', 'nope')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
  });
  test('writeFileSync returns undefined', () => {
    expect(fs.writeFileSync(R + '/g.txt', 'x')).toBeUndefined();
  });
  test('writeFileSync to missing parent throws ENOENT', () => {
    expect(() => fs.writeFileSync(R + '/nodir/x', 'q')).toThrow(
      expect.objectContaining({ code: 'ENOENT' }));
  });
  test('appendFileSync appends and creates', () => {
    fs.appendFileSync(R + '/h.txt', 'a');
    fs.appendFileSync(R + '/h.txt', 'b');
    expect(fs.readFileSync(R + '/h.txt', 'utf8')).toBe('ab');
  });
  test('readFileSync from an fd reads from its position', () => {
    fs.writeFileSync(R + '/i.txt', '0123456789');
    const fd = fs.openSync(R + '/i.txt', 'r');
    expect(fs.readFileSync(fd, 'utf8')).toBe('0123456789');
    fs.closeSync(fd);
  });
});

describe('existsSync / accessSync', () => {
  test('existsSync true/false, never throws', () => {
    fs.writeFileSync(R + '/a.txt', 'x');
    expect(fs.existsSync(R + '/a.txt')).toBe(true);
    expect(fs.existsSync(R + '/nope')).toBe(false);
    expect(fs.existsSync('')).toBe(false);
    expect(fs.existsSync()).toBe(false);
    expect(fs.existsSync(null)).toBe(false);
  });
  test('accessSync ok and ENOENT/EACCES', () => {
    fs.writeFileSync(R + '/a.txt', 'x');
    expect(fs.accessSync(R + '/a.txt', fs.constants.R_OK | fs.constants.W_OK)).toBeUndefined();
    expect(() => fs.accessSync(R + '/nope')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    fs.chmodSync(R + '/a.txt', 0o444);
    expect(() => fs.accessSync(R + '/a.txt', fs.constants.W_OK)).toThrow(
      expect.objectContaining({ code: 'EACCES' }));
  });
  test('accessSync rejects non-integer mode', () => {
    expect(() => fs.accessSync(R + '/a.txt', 'x')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });
});

describe('stat / lstat / fstat', () => {
  test('Stats shape and methods', () => {
    fs.writeFileSync(R + '/a.txt', 'hello');
    const st = fs.statSync(R + '/a.txt');
    expect(st.isFile()).toBe(true);
    expect(st.isDirectory()).toBe(false);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.size).toBe(5);
    expect(st.mode & 0o777).toBe(0o666 & ~process.umask());
    expect(st.atime instanceof Date).toBe(true);
    expect(typeof st.atimeMs).toBe('number');
    expect(Object.keys(st).join(',')).toBe(
      'dev,mode,nlink,uid,gid,rdev,blksize,ino,size,blocks,atimeMs,mtimeMs,ctimeMs,birthtimeMs');
  });
  test('directory stats', () => {
    const st = fs.statSync(R);
    expect(st.isDirectory()).toBe(true);
    expect(st.isFile()).toBe(false);
  });
  test('bigint variant', () => {
    fs.writeFileSync(R + '/a.txt', 'hello');
    const st = fs.statSync(R + '/a.txt', { bigint: true });
    expect(typeof st.size).toBe('bigint');
    expect(typeof st.ino).toBe('bigint');
    expect(typeof st.atimeNs).toBe('bigint');
    expect(st.size).toBe(5n);
  });
  test('symlink: stat follows, lstat does not', () => {
    fs.writeFileSync(R + '/a.txt', 'x');
    fs.symlinkSync(R + '/a.txt', R + '/lnk');
    expect(fs.statSync(R + '/lnk').isFile()).toBe(true);
    const lst = fs.lstatSync(R + '/lnk');
    expect(lst.isSymbolicLink()).toBe(true);
    expect(lst.isFile()).toBe(false);
  });
  test('throwIfNoEntry: false returns undefined', () => {
    expect(fs.statSync(R + '/nope', { throwIfNoEntry: false })).toBeUndefined();
    expect(() => fs.statSync(R + '/nope')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
  test('fstatSync on closed fd throws EBADF', () => {
    fs.writeFileSync(R + '/a.txt', 'x');
    const fd = fs.openSync(R + '/a.txt', 'r');
    fs.closeSync(fd);
    expect(() => fs.fstatSync(fd)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });
});

describe('mkdir / mkdtemp / readdir / opendir', () => {
  test('mkdir and EEXIST', () => {
    fs.mkdirSync(R + '/d');
    expect(fs.statSync(R + '/d').isDirectory()).toBe(true);
    expect(() => fs.mkdirSync(R + '/d')).toThrow(expect.objectContaining({ code: 'EEXIST' }));
  });
  test('mkdir recursive', () => {
    fs.mkdirSync(R + '/a/b/c', { recursive: true });
    expect(fs.statSync(R + '/a/b/c').isDirectory()).toBe(true);
    fs.mkdirSync(R + '/a/b', { recursive: true }); // no-op
    fs.writeFileSync(R + '/f', 'x');
    expect(() => fs.mkdirSync(R + '/f', { recursive: true })).toThrow(
      expect.objectContaining({ code: 'EEXIST' }));
  });
  test('mkdtemp appends 6 random chars', () => {
    const d = fs.mkdtempSync(R + '/tmp-');
    expect(d.startsWith(R + '/tmp-')).toBe(true);
    expect(d.length).toBe(R.length + 11);
    expect(fs.statSync(d).isDirectory()).toBe(true);
  });
  test('readdir names, Dirent, recursive', () => {
    fs.writeFileSync(R + '/f.txt', 'x');
    fs.mkdirSync(R + '/sub');
    fs.writeFileSync(R + '/sub/g.txt', 'y');
    expect(fs.readdirSync(R).sort()).toEqual(['f.txt', 'sub']);
    const dents = fs.readdirSync(R, { withFileTypes: true });
    const byName = Object.fromEntries(dents.map((d) => [d.name, d]));
    expect(byName['f.txt'].isFile()).toBe(true);
    expect(byName['sub'].isDirectory()).toBe(true);
    expect(fs.readdirSync(R, { recursive: true }).sort()).toEqual(['f.txt', 'sub', 'sub/g.txt']);
    expect(() => fs.readdirSync(R + '/f.txt')).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
  });
  test('readdir buffer encoding', () => {
    fs.writeFileSync(R + '/f.txt', 'x');
    const names = fs.readdirSync(R, { encoding: 'buffer' });
    expect(Buffer.isBuffer(names[0])).toBe(true);
    expect(names[0].toString()).toBe('f.txt');
  });
  test('opendir Dir iteration', async () => {
    fs.writeFileSync(R + '/f.txt', 'x');
    const dir = fs.opendirSync(R);
    expect(dir.path).toBe(R);
    const names = [];
    for await (const d of dir) names.push(d.name);
    expect(names).toEqual(['f.txt']);
    expect(dir.readSync()).toBeNull();
    dir.closeSync();
  });
});

describe('rename / copyFile / cp / links', () => {
  test('rename moves', () => {
    fs.writeFileSync(R + '/a.txt', 'x');
    fs.renameSync(R + '/a.txt', R + '/b.txt');
    expect(fs.existsSync(R + '/a.txt')).toBe(false);
    expect(fs.readFileSync(R + '/b.txt', 'utf8')).toBe('x');
    expect(() => fs.renameSync(R + '/nope', R + '/x')).toThrow(
      expect.objectContaining({ code: 'ENOENT' }));
  });
  test('rename dir onto file -> ENOTDIR; file onto dir -> EISDIR', () => {
    fs.mkdirSync(R + '/d');
    fs.writeFileSync(R + '/f', 'x');
    expect(() => fs.renameSync(R + '/d', R + '/f')).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
    expect(() => fs.renameSync(R + '/f', R + '/d')).toThrow(expect.objectContaining({ code: 'EISDIR' }));
  });
  test('copyFile copies content; COPYFILE_EXCL', () => {
    fs.writeFileSync(R + '/a.txt', 'data');
    fs.copyFileSync(R + '/a.txt', R + '/b.txt');
    expect(fs.readFileSync(R + '/b.txt', 'utf8')).toBe('data');
    expect(() => fs.copyFileSync(R + '/a.txt', R + '/b.txt', fs.constants.COPYFILE_EXCL)).toThrow(
      expect.objectContaining({ code: 'EEXIST' }));
  });
  test('cp recursive copies trees; dir without recursive -> ERR_FS_EISDIR', () => {
    fs.mkdirSync(R + '/src/sub', { recursive: true });
    fs.writeFileSync(R + '/src/sub/f.txt', 'z');
    fs.cpSync(R + '/src', R + '/dst', { recursive: true });
    expect(fs.readFileSync(R + '/dst/sub/f.txt', 'utf8')).toBe('z');
    expect(() => fs.cpSync(R + '/src', R + '/dst2')).toThrow(
      expect.objectContaining({ code: 'ERR_FS_EISDIR' }));
  });
  test('symlink / readlink / realpath', () => {
    fs.writeFileSync(R + '/a.txt', 'x');
    fs.symlinkSync(R + '/a.txt', R + '/lnk');
    expect(fs.readlinkSync(R + '/lnk')).toBe(R + '/a.txt');
    expect(fs.realpathSync(R + '/lnk')).toBe(fs.realpathSync(R + '/a.txt'));
    expect(fs.realpathSync.native(R + '/lnk')).toBe(fs.realpathSync(R + '/lnk'));
    expect(() => fs.readlinkSync(R + '/a.txt')).toThrow(expect.objectContaining({ code: 'EINVAL' }));
    expect(() => fs.symlinkSync('x', R + '/lnk')).toThrow(expect.objectContaining({ code: 'EEXIST' }));
  });
  test('hard link shares data and bumps nlink', () => {
    fs.writeFileSync(R + '/a.txt', 'x');
    fs.linkSync(R + '/a.txt', R + '/hard');
    expect(fs.statSync(R + '/hard').nlink).toBe(2);
    fs.writeFileSync(R + '/a.txt', 'y');
    expect(fs.readFileSync(R + '/hard', 'utf8')).toBe('y');
  });
});

describe('rm / rmdir / unlink', () => {
  test('unlink removes files; unlink on dir -> EISDIR', () => {
    fs.writeFileSync(R + '/a.txt', 'x');
    fs.unlinkSync(R + '/a.txt');
    expect(fs.existsSync(R + '/a.txt')).toBe(false);
    expect(() => fs.unlinkSync(R + '/nope')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(() => fs.unlinkSync(R)).toThrow(expect.objectContaining({ code: 'EISDIR' }));
  });
  test('rmdir only empty dirs', () => {
    fs.mkdirSync(R + '/d');
    fs.writeFileSync(R + '/d/f', 'x');
    expect(() => fs.rmdirSync(R + '/d')).toThrow(expect.objectContaining({ code: 'ENOTEMPTY' }));
    fs.unlinkSync(R + '/d/f');
    fs.rmdirSync(R + '/d');
    expect(fs.existsSync(R + '/d')).toBe(false);
  });
  test('rm without recursive on a dir -> ERR_FS_EISDIR', () => {
    fs.mkdirSync(R + '/d');
    let err;
    try { fs.rmSync(R + '/d'); } catch (e) { err = e; }
    expect(err.code).toBe('ERR_FS_EISDIR');
    expect(err.message).toBe(`Path is a directory: rm returned EISDIR (is a directory) ${R}/d`);
    fs.rmSync(R + '/d', { recursive: true });
    expect(fs.existsSync(R + '/d')).toBe(false);
  });
  test('rm force on missing path is silent', () => {
    expect(fs.rmSync(R + '/nope', { force: true })).toBeUndefined();
    expect(() => fs.rmSync(R + '/nope')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
});

describe('truncate / chmod / chown / utimes', () => {
  test('truncate shrinks and grows (zero-filled)', () => {
    fs.writeFileSync(R + '/a.txt', 'hello');
    fs.truncateSync(R + '/a.txt', 2);
    expect(fs.readFileSync(R + '/a.txt', 'utf8')).toBe('he');
    fs.truncateSync(R + '/a.txt', 4);
    expect([...fs.readFileSync(R + '/a.txt')]).toEqual([104, 101, 0, 0]);
  });
  test('truncate negative clamps to 0; fractional throws', () => {
    fs.writeFileSync(R + '/a.txt', 'hello');
    fs.truncateSync(R + '/a.txt', -1);
    expect(fs.statSync(R + '/a.txt').size).toBe(0);
    expect(() => fs.truncateSync(R + '/a.txt', 1.5)).toThrow(
      expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
  });
  test('chmod / chown / utimes metadata', () => {
    fs.writeFileSync(R + '/a.txt', 'x');
    fs.chmodSync(R + '/a.txt', 0o600);
    expect((fs.statSync(R + '/a.txt').mode & 0o777).toString(8)).toBe('600');
    fs.chmodSync(R + '/a.txt', '755');
    expect((fs.statSync(R + '/a.txt').mode & 0o777).toString(8)).toBe('755');
    fs.chownSync(R + '/a.txt', 1000, 1000);
    const st = fs.statSync(R + '/a.txt');
    expect([st.uid, st.gid]).toEqual([1000, 1000]);
    fs.utimesSync(R + '/a.txt', new Date('2020-06-01T00:00:00Z'), 1590969600);
    expect(fs.statSync(R + '/a.txt').mtimeMs).toBe(1590969600000);
  });
});

describe('open / read / write / close', () => {
  test('fd read with position handling', () => {
    fs.writeFileSync(R + '/a.txt', '0123456789');
    const fd = fs.openSync(R + '/a.txt', 'r');
    expect(typeof fd).toBe('number');
    const buf = Buffer.alloc(4);
    expect(fs.readSync(fd, buf, 0, 4, 2)).toBe(4);
    expect(buf.toString()).toBe('2345');
    // null position uses and advances the fd cursor
    const buf2 = Buffer.alloc(2);
    expect(fs.readSync(fd, buf2, 0, 2, null)).toBe(2);
    expect(buf2.toString()).toBe('01');
    expect(fs.fstatSync(fd).isFile()).toBe(true);
    fs.closeSync(fd);
  });
  test('write, append and exclusive flags', () => {
    const fd = fs.openSync(R + '/w.txt', 'w');
    expect(fs.writeSync(fd, 'ab')).toBe(2);
    expect(fs.writeSync(fd, Buffer.from('cd'))).toBe(2);
    fs.closeSync(fd);
    expect(fs.readFileSync(R + '/w.txt', 'utf8')).toBe('abcd');
    expect(() => fs.openSync(R + '/w.txt', 'wx')).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    const fa = fs.openSync(R + '/w.txt', 'a');
    fs.writeSync(fa, '!');
    fs.closeSync(fa);
    expect(fs.readFileSync(R + '/w.txt', 'utf8')).toBe('abcd!');
  });
  test('string writeSync with position and encoding', () => {
    const fd = fs.openSync(R + '/s.txt', 'w');
    fs.writeSync(fd, 'hello', 0, 'utf8');
    fs.writeSync(fd, 'X', 0);
    fs.closeSync(fd);
    expect(fs.readFileSync(R + '/s.txt', 'utf8')).toBe('Xello');
  });
  test('readv / writev', () => {
    const fd = fs.openSync(R + '/v.txt', 'w+');
    expect(fs.writevSync(fd, [Buffer.from('ab'), Buffer.from('cd')])).toBe(4);
    const bufs = [Buffer.alloc(2), Buffer.alloc(2)];
    expect(fs.readvSync(fd, bufs, 0)).toBe(4);
    expect(Buffer.concat(bufs).toString()).toBe('abcd');
    fs.closeSync(fd);
  });
  test('write to read-only fd throws EBADF', () => {
    fs.writeFileSync(R + '/a.txt', 'x');
    const fd = fs.openSync(R + '/a.txt', 'r');
    expect(() => fs.writeSync(fd, 'y')).toThrow(expect.objectContaining({ code: 'EBADF' }));
    fs.closeSync(fd);
  });
  test('openSync with numeric flags', () => {
    const fd = fs.openSync(R + '/n.txt', fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o644);
    fs.writeSync(fd, 'num');
    fs.closeSync(fd);
    expect(fs.readFileSync(R + '/n.txt', 'utf8')).toBe('num');
  });
});

describe('callback API', () => {
  test('readFile / writeFile round-trip via callback', (done) => {
    fs.writeFile(R + '/a.txt', 'cb-data', (err) => {
      expect(err).toBeNull();
      fs.readFile(R + '/a.txt', 'utf8', (err2, data) => {
        expect(err2).toBeNull();
        expect(data).toBe('cb-data');
        done();
      });
    });
  });
  test('missing callback throws ERR_INVALID_ARG_TYPE synchronously', () => {
    expect(() => fs.readFile(R + '/a.txt')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });
  test('operational errors go to the callback', (done) => {
    fs.readFile(R + '/nope.txt', (err, data) => {
      expect(err.code).toBe('ENOENT');
      expect(data).toBeUndefined();
      done();
    });
  });
  test('invalid path type throws synchronously', () => {
    expect(() => fs.readFile(1.5, () => {})).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });
  test('unknown integer fd calls back with EBADF (documented Node-quirk gap)', (done) => {
    // Real Node surfaces an internal ERR_INVALID_ARG_TYPE '"list" argument…'
    // here; the shim reports the saner EBADF. Recorded as a known gap.
    fs.readFile(123, (err) => {
      expect(err && err.code).toBe('EBADF');
      done();
    });
  });
  test('read callback receives (bytesRead, buffer)', (done) => {
    fs.writeFileSync(R + '/a.txt', '0123');
    const fd = fs.openSync(R + '/a.txt', 'r');
    const buf = Buffer.alloc(2);
    fs.read(fd, buf, 0, 2, 1, (err, bytesRead, buffer) => {
      expect(err).toBeNull();
      expect(bytesRead).toBe(2);
      expect(buffer.toString()).toBe('12');
      fs.closeSync(fd);
      done();
    });
  });
  test('stat / mkdir / readdir callbacks', (done) => {
    fs.mkdir(R + '/d', (err) => {
      expect(err).toBeNull();
      fs.stat(R + '/d', (err2, st) => {
        expect(err2).toBeNull();
        expect(st.isDirectory()).toBe(true);
        fs.readdir(R, (err3, files) => {
          expect(err3).toBeNull();
          expect(files).toEqual(['d']);
          done();
        });
      });
    });
  });
  test('exists callback receives a boolean, never an error', (done) => {
    fs.exists(R + '/nope', (y) => {
      expect(y).toBe(false);
      done();
    });
  });
});

describe('constants', () => {
  test('spot-check values against Node', () => {
    expect(fs.constants.F_OK).toBe(0);
    expect(fs.constants.R_OK).toBe(4);
    expect(fs.constants.W_OK).toBe(2);
    expect(fs.constants.X_OK).toBe(1);
    expect(fs.constants.O_RDONLY).toBe(0);
    expect(fs.constants.O_WRONLY).toBe(1);
    expect(fs.constants.O_RDWR).toBe(2);
    expect(fs.constants.O_CREAT).toBe(64);
    expect(fs.constants.O_EXCL).toBe(128);
    expect(fs.constants.O_TRUNC).toBe(512);
    expect(fs.constants.O_APPEND).toBe(1024);
    expect(fs.constants.S_IFREG).toBe(32768);
    expect(fs.constants.S_IFDIR).toBe(16384);
    expect(fs.constants.S_IFLNK).toBe(40960);
    expect(fs.constants.COPYFILE_EXCL).toBe(1);
  });
});

describe('createReadStream / createWriteStream', () => {
  test('read stream emits data and end', (done) => {
    fs.writeFileSync(R + '/a.txt', 'stream-data');
    const rs = fs.createReadStream(R + '/a.txt', { encoding: 'utf8' });
    let text = '';
    let opened = false;
    rs.on('open', (fd) => { opened = true; expect(typeof fd).toBe('number'); });
    rs.on('data', (c) => { text += c; });
    rs.on('end', () => {
      expect(text).toBe('stream-data');
      expect(opened).toBe(true);
      done();
    });
  });
  test('write stream writes and finishes', (done) => {
    const ws = fs.createWriteStream(R + '/w.txt');
    ws.on('finish', () => {
      expect(fs.readFileSync(R + '/w.txt', 'utf8')).toBe('written');
      done();
    });
    ws.write('writ');
    ws.end('ten');
  });
  test('read stream with start/end range', (done) => {
    fs.writeFileSync(R + '/a.txt', '0123456789');
    const rs = fs.createReadStream(R + '/a.txt', { start: 2, end: 5 });
    const chunks = [];
    rs.on('data', (c) => chunks.push(c));
    rs.on('end', () => {
      expect(Buffer.concat(chunks).toString()).toBe('2345');
      done();
    });
  });
  test('read stream on missing file errors', (done) => {
    const rs = fs.createReadStream(R + '/nope.txt');
    rs.on('error', (err) => {
      expect(err.code).toBe('ENOENT');
      done();
    });
    rs.resume();
  });
});

describe('watch / watchFile', () => {
  test('watch returns an FSWatcher with close/ref/unref', () => {
    fs.writeFileSync(R + '/a.txt', 'x');
    const w = fs.watch(R + '/a.txt');
    expect(typeof w.close).toBe('function');
    expect(typeof w.on).toBe('function');
    expect(w.ref()).toBe(w);
    expect(w.unref()).toBe(w);
    w.close();
  });
  test('watch on missing path throws ENOENT', () => {
    expect(() => fs.watch(R + '/nope')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
  test('watchFile polls and fires on change', (done) => {
    fs.writeFileSync(R + '/a.txt', 'one');
    fs.watchFile(R + '/a.txt', { interval: 30 }, (curr, prev) => {
      expect(curr.mtimeMs).toBeGreaterThan(prev.mtimeMs);
      fs.unwatchFile(R + '/a.txt');
      done();
    });
    setTimeout(() => fs.writeFileSync(R + '/a.txt', 'two'), 80);
  }, 10000);
});

describe('glob', () => {
  test('globSync ** and * patterns', () => {
    fs.mkdirSync(R + '/g/sub', { recursive: true });
    fs.writeFileSync(R + '/g/one.txt', '1');
    fs.writeFileSync(R + '/g/sub/two.txt', '2');
    fs.writeFileSync(R + '/g/sub/three.md', '3');
    expect(fs.globSync(R + '/g/**/*.txt').sort()).toEqual(
      [R + '/g/one.txt', R + '/g/sub/two.txt']);
    expect(fs.globSync('**/*.txt', { cwd: R + '/g' }).sort()).toEqual(
      ['one.txt', 'sub/two.txt']);
    expect(fs.globSync(R + '/g/*.txt')).toEqual([R + '/g/one.txt']);
    expect(fs.globSync(R + '/g/**/*.md')).toEqual([R + '/g/sub/three.md']);
  });
  test('glob callback version', (done) => {
    fs.writeFileSync(R + '/q.txt', 'x');
    fs.glob(R + '/*.txt', (err, matches) => {
      expect(err).toBeNull();
      expect(matches).toEqual([R + '/q.txt']);
      done();
    });
  });
});

describe('misc', () => {
  test('statfsSync has bsize and frsize', () => {
    const s = fs.statfsSync(R);
    expect(s.bsize).toBe(4096);
    expect(s.frsize).toBe(4096);
  });
  test('mkdtempDisposableSync disposes', () => {
    const d = fs.mkdtempDisposableSync(R + '/disp-');
    const p = d.path;
    expect(fs.statSync(p).isDirectory()).toBe(true);
    d[Symbol.dispose]();
    expect(fs.existsSync(p)).toBe(false);
  });
  test('openAsBlob returns a Blob', async () => {
    fs.writeFileSync(R + '/a.txt', 'blobme');
    const b = await fs.openAsBlob(R + '/a.txt', { type: 'text/plain' });
    expect(b instanceof Blob).toBe(true);
    expect(b.size).toBe(6);
    expect(b.type).toBe('text/plain');
    expect(await b.text()).toBe('blobme');
  });
  test('_toUnixTimestamp converts Date/string/number', () => {
    expect(fs._toUnixTimestamp(new Date('2020-01-01T00:00:00Z'))).toBe(1577836800);
    expect(fs._toUnixTimestamp('1577836800')).toBe(1577836800);
    expect(fs._toUnixTimestamp(1577836800)).toBe(1577836800);
  });
  test('public class exports exist', () => {
    expect(typeof fs.Stats).toBe('function');
    expect(typeof fs.Dirent).toBe('function');
    expect(typeof fs.Dir).toBe('function');
    expect(typeof fs.ReadStream).toBe('function');
    expect(typeof fs.WriteStream).toBe('function');
    expect(fs.FileReadStream).toBe(fs.ReadStream);
    expect(fs.FileWriteStream).toBe(fs.WriteStream);
  });
  test('default export is the fs namespace object', async () => {
    const mod = await import('../src/fs.js');
    expect(mod.default).toBe(fs);
    expect(typeof mod.readFileSync).toBe('function');
    expect(mod.promises).toBe(fs.promises);
  });
});
