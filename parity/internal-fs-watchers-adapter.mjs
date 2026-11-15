// Parity adapter for `require('internal/fs/watchers')` used by the fs test
// test-fs-watch-recursive-delete-race.js (the only fs test importing it).
//
// The problem: the test destructures `kFSWatchStart` from this module and
// calls it on the recursive FSWatcher from `internal/fs/recursive_watch`.
// Without a redirect the require falls through to native Node's internal
// module — and the native recursive FSWatcher then stats the real-disk
// parent (which exists only in memfs) and throws ENOENT. The adapter
// re-exports real Node's module wholesale (the symbol identity for
// kFSWatchStart is Node's own, so the test's destructured symbol matches
// the recursive adapter's method key), exactly as the net adapter does for
// `internal/net` (PR #425 precedent). No behavior change for any other
// consumer: the only requiring test is the delete-race one.
//
// Harness-only; src/ behavior is untouched. The adapter's own require()
// below reaches real Node because the adapter lives under parity/, not
// under parity/node-test/parallel/, so the preload's testsDir-guarded
// redirect does not apply to it.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const real = require("internal/fs/watchers");

export const createIgnoreMatcher = real.createIgnoreMatcher;
export const FSWatcher = real.FSWatcher;
export const StatWatcher = real.StatWatcher;
export const kFSWatchStart = real.kFSWatchStart;
export const kFSStatWatcherStart = real.kFSStatWatcherStart;
export const kFSStatWatcherAddOrCleanRef = real.kFSStatWatcherAddOrCleanRef;
export const watch = real.watch;
export default real;
