// os.js (browser + Node.js shim)
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
  return typeof navigator !== 'undefined' ? navigator.appVersion || '' : '';
}

// ---------- Exports ----------
export const endianness = () => (nodeOS ? nodeOS.endianness() : 'LE');

export const hostname = () =>
  nodeOS ? nodeOS.hostname() : (typeof location !== 'undefined' ? location.hostname : 'localhost');

export const loadavg = () => (nodeOS ? nodeOS.loadavg() : [0, 0, 0]);

export const uptime = () =>
  nodeOS ? nodeOS.uptime() : Math.floor(performance.now() / 1000);

export const freemem = () => (nodeOS ? nodeOS.freemem() : 2 * 1024 * 1024 * 1024);

export const totalmem = () => (nodeOS ? nodeOS.totalmem() : 4 * 1024 * 1024 * 1024);

export const cpus = () => {
  if (nodeOS) return nodeOS.cpus();
  const cpu = { model: 'Virtual CPU', speed: 2400, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } };
  return [cpu, cpu];
};

export const type = () => (nodeOS ? nodeOS.type() : getBrowserType());

export const release = () => (nodeOS ? nodeOS.release() : getBrowserRelease());

export const networkInterfaces = () => (nodeOS ? nodeOS.networkInterfaces() : {
  lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }]
});

export const arch = () => (nodeOS ? nodeOS.arch() : getBrowserArch());

export const platform = () => (nodeOS ? nodeOS.platform() : getBrowserPlatform());

export const tmpdir = () => (nodeOS ? nodeOS.tmpdir() : '/tmp');

export const homedir = () => (nodeOS ? nodeOS.homedir() : '/home/user');

export const version = () => (nodeOS ? nodeOS.version() : '#1 SMP');

export const machine = () => (nodeOS ? nodeOS.machine() : arch());

export const userInfo = () => (nodeOS
  ? nodeOS.userInfo()
  : { username: 'user', uid: 1000, gid: 1000, shell: '/bin/bash', homedir: homedir() });

export const getPriority = (pid) => (nodeOS ? nodeOS.getPriority(pid) : 0);

export const setPriority = (pid, priority) => {
  if (nodeOS) return nodeOS.setPriority(pid, priority);
  // no-op in browser
};

export const constants = nodeOS
  ? nodeOS.constants
  : {
      signals: {
        SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8,
        SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
        SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23,
        SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPWR: 30,
        SIGSYS: 31
      },
      errno: {},
      priority: {
        PRIORITY_LOW: 19,
        PRIORITY_BELOW_NORMAL: 10,
        PRIORITY_NORMAL: 0,
        PRIORITY_ABOVE_NORMAL: -7,
        PRIORITY_HIGH: -14,
        PRIORITY_HIGHEST: -20
      }
    };

export const devNull = nodeOS ? nodeOS.devNull : '/dev/null';

export const EOL = nodeOS ? nodeOS.EOL : '\n';

// ---------- Default Export ----------
export default {
  endianness,
  hostname,
  loadavg,
  uptime,
  freemem,
  totalmem,
  cpus,
  type,
  release,
  networkInterfaces,
  arch,
  platform,
  tmpdir,
  homedir,
  version,
  machine,
  userInfo,
  getPriority,
  setPriority,
  constants,
  devNull,
  EOL
};
