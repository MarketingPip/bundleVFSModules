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

export const endianness = () =>
  nodeOS ? nodeOS.endianness() : 'LE';

export const hostname = () =>
  nodeOS ? nodeOS.hostname() : (
    typeof location !== 'undefined' ? location.hostname : ''
  );

export const loadavg = () =>
  nodeOS ? nodeOS.loadavg() : [0, 0, 0];

export const uptime = () =>
  nodeOS ? nodeOS.uptime() : 0;

export const freemem = () =>
  nodeOS ? nodeOS.freemem() : 0;

export const totalmem = () =>
  nodeOS ? nodeOS.totalmem() : 0;

export const cpus = () =>
  nodeOS ? nodeOS.cpus() : [];

export const type = () =>
  nodeOS ? nodeOS.type() : getBrowserType();

export const release = () =>
  nodeOS ? nodeOS.release() : getBrowserRelease();

export const networkInterfaces = () =>
  nodeOS ? nodeOS.networkInterfaces() : {};

export const arch = () =>
  nodeOS ? nodeOS.arch() : getBrowserArch();

export const platform = () =>
  nodeOS ? nodeOS.platform() : getBrowserPlatform();

export const tmpdir = () =>
  nodeOS ? nodeOS.tmpdir() : '/tmp';

export const EOL = nodeOS ? nodeOS.EOL : '\n';

export const homedir = () =>
  nodeOS ? nodeOS.homedir() : '/';
