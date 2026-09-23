// Browser-safe task-queue helpers for the node:stream port.
//
// Under Node, process.nextTick is used (bound to process). Anywhere else we
// fall back to queueMicrotask, then setTimeout(0).

const proc =
  typeof process === 'object' && process !== null ? process : undefined;

const nextTick = (proc && typeof proc.nextTick === 'function') ?
  proc.nextTick.bind(proc) :
  (typeof queueMicrotask === 'function' ?
    queueMicrotask :
    (fn, ...args) => setTimeout(() => fn(...args), 0));

// process.stdout / process.stderr only appear in a pipe-cleanup comparison;
// default to nullish so the comparison simply never matches off-Node.
const procStdout = proc?.stdout;
const procStderr = proc?.stderr;
const procPlatform = typeof proc?.platform === 'string' ? proc.platform : '';

export {
  nextTick,
  procStdout,
  procStderr,
  procPlatform,
};
