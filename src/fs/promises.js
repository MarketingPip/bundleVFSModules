/*!
 * fs-web/promises — node:fs/promises for browsers & bundlers
 * MIT License.
 * Node.js parity: node:fs/promises @ Node 14.0.0+
 * Dependencies: memfs (via ../fs)
 * Limitations:
 *   - FileHandle.fd is a memfs virtual descriptor, not a real OS fd.
 *   - watch() uses memfs's FSWatcher; inotify/kqueue semantics not guaranteed.
 *   - All paths are virtual (memfs in-memory volume, ../fs._vol).
 *   - emitMe telemetry is inherited — already wired in ../fs's patch loop.
 */

/**
 * @packageDocumentation
 * Re-exports the already-patched `fs.promises` surface from `../fs` as
 * individual named exports, mirroring `node:fs/promises`.
 *
 * Every method here was monkey-patched in `../fs` to:
 *   - Call the underlying memfs promise implementation.
 *   - Fire `globalThis.emitMe('fs', 'promises.<method>', ...args, result)`
 *     when the global telemetry hook is present.
 *
 * Nothing is re-patched here — we just unwrap the object into named exports
 * so consumers can write:
 *
 *   import { readFile, writeFile } from './fs/promises';
 *   // instead of:
 *   import { promises } from './fs';
 *   const { readFile, writeFile } = promises;
 */

import fs, { promises, constants } from '../fs';

// ---------------------------------------------------------------------------
// FileHandle — thin wrapper around memfs's open() file descriptor
// ---------------------------------------------------------------------------
// Node's fs/promises exposes a FileHandle class whose instances are returned
// by open(). memfs returns a numeric fd; we wrap it to match Node's shape.

/**
 * @typedef {Object} FileHandleReadResult
 * @property {number} bytesRead
 * @property {Buffer | TypedArray} buffer
 */

/**
 * @typedef {Object} FileHandleWriteResult
 * @property {number} bytesWritten
 * @property {Buffer | string} buffer
 */

/**
 * Wraps a memfs numeric file descriptor in a Node-compatible FileHandle object.
 * Instances are returned by {@link open} — not constructed directly.
 *
 * Supported methods: read, readFile, write, writeFile, appendFile, datasync,
 * sync, stat, chmod, chown, truncate, utimes, close, createReadStream,
 * createWriteStream.
 */
export class FileHandle {
  /**
   * @param {number} fd - memfs virtual file descriptor.
   */
  constructor(fd) {
    this.fd = fd;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** @returns {Promise<FileHandleReadResult>} */
  read(buffer, offset, length, position) {
    return new Promise((resolve, reject) => {
      fs.read(this.fd, buffer, offset, length, position, (err, bytesRead, buf) => {
        if (err) return reject(err);
        resolve({ bytesRead, buffer: buf });
      });
    });
  }

  /**
   * @param {{ encoding?: BufferEncoding | null; flag?: string } | BufferEncoding | null} [options]
   * @returns {Promise<Buffer | string>}
   */
  readFile(options) {
    return promises.readFile(this.fd, options);
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /** @returns {Promise<FileHandleWriteResult>} */
  write(buffer, offsetOrOptions, length, position) {
    if (typeof buffer === 'string') {
      // write(string, position?, encoding?)
      return new Promise((resolve, reject) => {
        fs.write(this.fd, buffer, offsetOrOptions, length, (err, bytesWritten, str) => {
          if (err) return reject(err);
          resolve({ bytesWritten, buffer: str });
        });
      });
    }
    return new Promise((resolve, reject) => {
      fs.write(this.fd, buffer, offsetOrOptions, length, position, (err, bytesWritten, buf) => {
        if (err) return reject(err);
        resolve({ bytesWritten, buffer: buf });
      });
    });
  }

  /**
   * @param {string | Buffer | TypedArray} data
   * @param {{ encoding?: BufferEncoding; flag?: string } | BufferEncoding} [options]
   * @returns {Promise<void>}
   */
  writeFile(data, options) {
    return promises.writeFile(this.fd, data, options);
  }

  /**
   * @param {string | Buffer} data
   * @param {{ encoding?: BufferEncoding; flag?: string } | BufferEncoding} [options]
   * @returns {Promise<void>}
   */
  appendFile(data, options) {
    return promises.appendFile(this.fd, data, options);
  }

  // ── Sync / stat / meta ─────────────────────────────────────────────────────

  /** @returns {Promise<void>} */
  datasync() {
    return new Promise((resolve, reject) =>
      fs.fdatasync(this.fd, err => err ? reject(err) : resolve())
    );
  }

  /** @returns {Promise<void>} */
  sync() {
    return new Promise((resolve, reject) =>
      fs.fsync(this.fd, err => err ? reject(err) : resolve())
    );
  }

  /** @returns {Promise<import('fs').Stats>} */
  stat(options) {
    return promises.fstat(this.fd, options);
  }

  /** @param {number} mode @returns {Promise<void>} */
  chmod(mode) {
    return new Promise((resolve, reject) =>
      fs.fchmod(this.fd, mode, err => err ? reject(err) : resolve())
    );
  }

  /** @param {number} uid @param {number} gid @returns {Promise<void>} */
  chown(uid, gid) {
    return new Promise((resolve, reject) =>
      fs.fchown(this.fd, uid, gid, err => err ? reject(err) : resolve())
    );
  }

  /** @param {number} [len=0] @returns {Promise<void>} */
  truncate(len = 0) {
    return new Promise((resolve, reject) =>
      fs.ftruncate(this.fd, len, err => err ? reject(err) : resolve())
    );
  }

  /**
   * @param {string | number | Date} atime
   * @param {string | number | Date} mtime
   * @returns {Promise<void>}
   */
  utimes(atime, mtime) {
    return new Promise((resolve, reject) =>
      fs.futimes(this.fd, atime, mtime, err => err ? reject(err) : resolve())
    );
  }

  // ── Streams ────────────────────────────────────────────────────────────────

  /** @param {import('fs').CreateReadStreamOptions} [options] */
  createReadStream(options) {
    return fs.createReadStream(null, { ...options, fd: this.fd, autoClose: false });
  }

  /** @param {import('fs').CreateWriteStreamOptions} [options] */
  createWriteStream(options) {
    return fs.createWriteStream(null, { ...options, fd: this.fd, autoClose: false });
  }

  // ── Close ──────────────────────────────────────────────────────────────────

  /**
   * Closes the file descriptor. Always call this (or use `using` in TS 5.2+).
   * @returns {Promise<void>}
   */
  close() {
    return new Promise((resolve, reject) =>
      fs.close(this.fd, err => err ? reject(err) : resolve())
    );
  }

  /** Symbol.asyncDispose — supports `await using fh = await open(...)` (TS 5.2+) */
  async [Symbol.asyncDispose]() {
    await this.close();
  }
}

// ---------------------------------------------------------------------------
// open() — overrides promises.open to return a FileHandle instead of a raw fd
// ---------------------------------------------------------------------------

/**
 * Opens a file and returns a {@link FileHandle}.
 * @param {string | Buffer | URL} path
 * @param {string | number} [flags='r']
 * @param {number} [mode=0o666]
 * @returns {Promise<FileHandle>}
 *
 * @example
 * const fh = await open('/data/file.txt', 'r');
 * const { bytesRead, buffer } = await fh.read(Buffer.alloc(16), 0, 16, 0);
 * await fh.close();
 */
export async function open(path, flags = 'r', mode = 0o666) {
  const fd = await promises.open(path, flags, mode);
  return new FileHandle(fd);
}

// ---------------------------------------------------------------------------
// Named re-exports from the already-patched promises object in ../fs
// ---------------------------------------------------------------------------

export const {
  access,
  appendFile,
  chmod,
  chown,
  copyFile,
  cp,
  lchmod,
  lchown,
  link,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  truncate,
  unlink,
  utimes,
  watch,
  writeFile,
} = promises;

// constants is the same object as fs.constants — re-exported for parity with
// Node where `import { constants } from 'fs/promises'` is valid.
export { constants };

// ---------------------------------------------------------------------------
// Default export — the full promises surface, matching Node's module shape
// ---------------------------------------------------------------------------

export default {
  // FileHandle & open
  FileHandle,
  open,
  // All patched promise methods
  access, appendFile, chmod, chown, copyFile, cp,
  lchmod, lchown, link, lstat, mkdir, mkdtemp, opendir,
  readdir, readFile, readlink, realpath, rename, rm, rmdir,
  stat, symlink, truncate, unlink, utimes, watch, writeFile,
  // constants
  constants,
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import fsPromises, { readFile, writeFile, open, constants } from './fs/promises';
//
// // Write then read a file
// await writeFile('/hello.txt', 'Hello, world!', 'utf8');
// const content = await readFile('/hello.txt', 'utf8');
// console.log(content); // 'Hello, world!'
//
// // FileHandle — granular fd-level control
// const fh = await open('/hello.txt', 'r');
// const buf = Buffer.alloc(5);
// const { bytesRead } = await fh.read(buf, 0, 5, 0);
// console.log(buf.toString()); // 'Hello'
// await fh.close();
//
// // TS 5.2+ Symbol.asyncDispose — auto-close via 'await using'
// await using fh2 = await open('/hello.txt', 'a');
// await fh2.appendFile(' More text.');
// // fh2.close() called automatically on block exit
//
// // mkdir + readdir
// await mkdir('/data/subdir', { recursive: true });
// const entries = await readdir('/data', { withFileTypes: true });
// console.log(entries.map(e => e.name)); // ['subdir']
//
// // Edge: open non-existent file for reading → ENOENT
// try {
//   await open('/nope.txt', 'r');
// } catch (e) { console.log(e.code); } // 'ENOENT'
//
// // Edge: constants available
// console.log(constants.O_RDONLY); // 0
