// os.js (CJS version)

let nodeOS = null;

// Detect Node
const isNode =
  typeof process !== 'undefined' &&
  process.versions &&
  process.versions.node;

if (isNode) {
  nodeOS = require('node:os');
}

// ---------- Helpers for browser ----------

function getBrowserArch() {
  if (typeof navigator === 'undefined') return 'x64';

  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('arm') || ua.includes('aarch64')) return 'arm64';
  if (ua.includes('x86_64') || ua.includes('win64')) return 'x64';
  return 'x64';
}

function getBrowserPlatform() {
  if (typeof navigator === 'undefined') return 'linux';

  const platform = navigator.platform.toLowerCase();

  if (platform.includes('win')) return 'win32';
  if (platform.includes('mac')) return 'darwin';
  if (platform.includes('linux')) return 'linux';

  return 'linux';
}

function getBrowserType() {
  const platform = getBrowserPlatform();
  if (platform === 'win32') return 'Windows_NT';
  if (platform === 'darwin') return 'Darwin';
  return 'Linux';
}

function getBrowserRelease() {
  return typeof navigator !== 'undefined'
    ? navigator.appVersion || ''
    : '';
}

// ---------- Exports ----------

exports.endianness = () =>
  nodeOS ? nodeOS.endianness() : 'LE';

exports.hostname = () =>
  nodeOS ? nodeOS.hostname() : (
    typeof location !== 'undefined' ? location.hostname : ''
  );

exports.loadavg = () =>
  nodeOS ? nodeOS.loadavg() : [0, 0, 0];

exports.uptime = () =>
  nodeOS ? nodeOS.uptime() : 0;

exports.freemem = () =>
  nodeOS ? nodeOS.freemem() : 0;

exports.totalmem = () =>
  nodeOS ? nodeOS.totalmem() : 0;

exports.cpus = () =>
  nodeOS ? nodeOS.cpus() : [];

exports.type = () =>
  nodeOS ? nodeOS.type() : getBrowserType();

exports.release = () =>
  nodeOS ? nodeOS.release() : getBrowserRelease();

exports.networkInterfaces = () =>
  nodeOS ? nodeOS.networkInterfaces() : {};

exports.arch = () =>
  nodeOS ? nodeOS.arch() : getBrowserArch();

exports.platform = () =>
  nodeOS ? nodeOS.platform() : getBrowserPlatform();

exports.tmpdir = () =>
  nodeOS ? nodeOS.tmpdir() : '/tmp';

exports.EOL = nodeOS ? nodeOS.EOL : '\n';

exports.homedir = () =>
  nodeOS ? nodeOS.homedir() : '/';
