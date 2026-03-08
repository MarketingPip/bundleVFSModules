import fs, { promises as rawPromises, constants } from '../fs';

import Buffer from "buffer"
// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toBuffer(data, encoding) {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, encoding);
  return Buffer.from(data);
}

// ---------------------------------------------------------------------------
// FileHandle — Node-compatible wrapper around memfs numeric fd
// ---------------------------------------------------------------------------

export class FileHandle {
  constructor(fd) {
    this.fd = fd;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  read(buffer, offset, length, position) {
    return new Promise((resolve, reject) => {
      fs.read(this.fd, buffer, offset, length, position, (err, bytesRead, buf) => {
        if (err) return reject(err);
        resolve({ bytesRead, buffer: buf });
      });
    });
  }

  readFile(options) {
    return rawPromises.readFile(this.fd, options);
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  write(buffer, offsetOrOptions, length, position) {
    if (typeof buffer === 'string') {
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

  // Node behaviour: truncate then write
  async writeFile(data, options) {
    const encoding = typeof options === 'string' ? options : options?.encoding;

    const buffer = toBuffer(data, encoding);

    await new Promise((resolve, reject) =>
      fs.ftruncate(this.fd, 0, err => (err ? reject(err) : resolve()))
    );

    return new Promise((resolve, reject) => {
      fs.write(this.fd, buffer, 0, buffer.length, 0, err => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  // FIXED appendFile — ensures append semantics
  async appendFile(data, options) {
    const encoding = typeof options === 'string' ? options : options?.encoding;

    const buffer = toBuffer(data, encoding);

    const stats = await new Promise((resolve, reject) =>
      fs.fstat(this.fd, (err, stats) => (err ? reject(err) : resolve(stats)))
    );

    const position = stats.size;

    return new Promise((resolve, reject) => {
      fs.write(this.fd, buffer, 0, buffer.length, position, err => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  // ── Sync / stat / meta ───────────────────────────────────────────────────

  datasync() {
    return new Promise((resolve, reject) =>
      fs.fdatasync(this.fd, err => (err ? reject(err) : resolve()))
    );
  }

  sync() {
    return new Promise((resolve, reject) =>
      fs.fsync(this.fd, err => (err ? reject(err) : resolve()))
    );
  }

  stat(options) {
    return rawPromises.fstat(this.fd, options);
  }

  chmod(mode) {
    return new Promise((resolve, reject) =>
      fs.fchmod(this.fd, mode, err => (err ? reject(err) : resolve()))
    );
  }

  chown(uid, gid) {
    return new Promise((resolve, reject) =>
      fs.fchown(this.fd, uid, gid, err => (err ? reject(err) : resolve()))
    );
  }

  truncate(len = 0) {
    return new Promise((resolve, reject) =>
      fs.ftruncate(this.fd, len, err => (err ? reject(err) : resolve()))
    );
  }

  utimes(atime, mtime) {
    return new Promise((resolve, reject) =>
      fs.futimes(this.fd, atime, mtime, err => (err ? reject(err) : resolve()))
    );
  }

  // ── Streams ──────────────────────────────────────────────────────────────

  createReadStream(options) {
    return fs.createReadStream(null, { ...options, fd: this.fd, autoClose: false });
  }

  createWriteStream(options) {
    return fs.createWriteStream(null, { ...options, fd: this.fd, autoClose: false });
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  close() {
    return new Promise((resolve, reject) =>
      fs.close(this.fd, err => (err ? reject(err) : resolve()))
    );
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }
}

// ---------------------------------------------------------------------------
// open() — returns FileHandle
// ---------------------------------------------------------------------------

export async function open(path, flags = 'r', mode = 0o666) {
  const fd = await rawPromises.open(path, flags, mode);
  return new FileHandle(fd);
}

// ---------------------------------------------------------------------------
// Named exports from patched fs.promises
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
} = rawPromises;

export { constants };

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default {
  FileHandle,
  open,

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

  constants,
};
