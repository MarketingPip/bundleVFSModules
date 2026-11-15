// child_process wrapper for the fs target
// (parity/child_process-fs-harness.mjs).
//
// fs tests stage fixtures in the shim's memfs, but spawn NATIVE child
// processes (git, /bin/sh redirections) that cannot see memfs: `git init`
// needs its cwd to exist on real disk, and a shell redirection (`< file`)
// opens a real-disk path. Before every spawn, mirror the memfs tmpdir
// subtree to real disk (tmpdir-scoped, never clobbering newer real files)
// via the fs harness, then delegate to native child_process with identical
// semantics. Harness-only; src/ is untouched.
//
// This is NOT the child_process shim (parity/child_process-harness.mjs,
// used under PARITY_TARGET=child_process) — native spawn is required here:
// the children are real git / real shells. Only the spawn entry points are
// wrapped; every other export passes through by reference.
import * as nativeCp from "node:child_process";
import { mirrorMemfsTmpdirToDisk } from "./fs-harness.mjs";

// Spawn entry points: every way a test can start a native child. exec /
// execFile call the module-internal spawn, not exports.spawn, so each must
// be wrapped itself; fork likewise spawns internally.
const SPAWN_ENTRY_POINTS = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
];

function withMirror(fn) {
  function wrapped(...args) {
    mirrorMemfsTmpdirToDisk();
    return Reflect.apply(fn, this, args);
  }
  return wrapped;
}

// The object require("child_process") returns (preload returns the default
// export for CJS requires): the native API with only the spawn entry points
// replaced by mirroring wrappers. All other exports (ChildProcess, _forkChild)
// are the native references.
const wrapped = { ...nativeCp };
for (const name of SPAWN_ENTRY_POINTS) {
  if (typeof nativeCp[name] === "function") {
    wrapped[name] = withMirror(nativeCp[name]);
  }
}

export default wrapped;
export const {
  ChildProcess,
  _forkChild,
  spawn,
  spawnSync,
  exec,
  execSync,
  execFile,
  execFileSync,
  fork,
} = wrapped;
