// Export-surface parity: src/fs.js  <->  node:fs
// captured from real Node v24.20.0 (node:fs)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/fs.js';

const EXPECTED = ["Dir","Dirent","FileReadStream","FileWriteStream","ReadStream","Stats","Utf8Stream","WriteStream","_toUnixTimestamp","access","accessSync","appendFile","appendFileSync","chmod","chmodSync","chown","chownSync","close","closeSync","constants","copyFile","copyFileSync","cp","cpSync","createReadStream","createWriteStream","default","exists","existsSync","fchmod","fchmodSync","fchown","fchownSync","fdatasync","fdatasyncSync","fstat","fstatSync","fsync","fsyncSync","ftruncate","ftruncateSync","futimes","futimesSync","glob","globSync","lchmod","lchmodSync","lchown","lchownSync","link","linkSync","lstat","lstatSync","lutimes","lutimesSync","mkdir","mkdirSync","mkdtemp","mkdtempDisposableSync","mkdtempSync","open","openAsBlob","openSync","opendir","opendirSync","promises","read","readFile","readFileSync","readSync","readdir","readdirSync","readlink","readlinkSync","readv","readvSync","realpath","realpathSync","rename","renameSync","rm","rmSync","rmdir","rmdirSync","stat","statSync","statfs","statfsSync","symlink","symlinkSync","truncate","truncateSync","unlink","unlinkSync","unwatchFile","utimes","utimesSync","watch","watchFile","write","writeFile","writeFileSync","writeSync","writev","writevSync"];

test('node:fs export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
