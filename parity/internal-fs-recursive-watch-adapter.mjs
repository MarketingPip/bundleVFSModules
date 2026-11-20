// Parity adapter for `require('internal/fs/recursive_watch')` used by the
// fs recursive-watch tests (test-fs-watch-recursive-* and the recursive
// block of test-fs-watch-enoent.js).
//
// The problem: Node's JS recursive FSWatcher (lib/internal/fs/recursive_watch.js)
// is what fs.watch({ recursive: true }) uses on Linux, where libuv has no
// native recursive watcher. Without a redirect the require falls through to
// native Node's internal module, whose lazyLoadFsSync() returns native fs —
// its statSync on the memfs-only parent throws ENOENT at
// [kFSWatchStart] (node:internal/fs/recursive_watch:322).
//
// This adapter is a faithful port of Node v26.13.1's FSWatcher
// (lib/internal/fs/recursive_watch.js — the v26 rewrite: Linux-only dir
// watchers via kDirectoryWatchReportsEntries, #entries/#watchers/
// #symbolicLinks sets, #watch returning false for paths that vanish before
// the watch lands, #scanFolder watching BEFORE reading, #forget with the
// exact-or-`file + sep` prefix, [kFSWatchStart] throwing unless
// !throwIfNoEntry && code === 'ENOENT'), with exactly two substitutions:
//
// 1. The fs operations (statSync, lstatSync, readdirSync, watch) run through
//    the shim (../src/fs.js default export) instead of native fs. The fs
//    methods are read off the shared shim object AT CALL TIME — the harness
//    wraps the shim's methods in place on that object, and the tests
//    monkey-patch fs.watch / fs.readdirSync on it, so the port must not
//    capture the functions at import time (Node's lazyLoadFsSync() has the
//    same call-time shape).
// 2. One memfs guard in #watch: memfs delivers watch events SYNCHRONOUSLY
//    inside the mutating call (rmSync emits 'change' while watch() is still
//    on the stack); libuv delivers them on a later turn, after watch() has
//    returned. If a synchronous callback forgot the entry (or closed the
//    watcher) while watch() was on the stack, the just-created watcher is
//    closed instead of being registered — otherwise it leaks (registered
//    after its entry was forgotten, never closed again).
//
// The validators, error classes, getValidatedPath, createIgnoreMatcher and
// the kFSWatchStart symbol come from real Node internals (via createRequire
// — the adapter lives under parity/, so the preload's testsDir-guarded
// redirect does not apply to it) and from the sibling watchers adapter,
// exactly as the net adapter does for `internal/net` (PR #425 precedent).
//
// Harness-only; src/ behavior is untouched.
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import path from "node:path";
import shimFs from "../src/fs.js";
import {
  kFSWatchStart,
  createIgnoreMatcher,
} from "./internal-fs-watchers-adapter.mjs";

const require = createRequire(import.meta.url);
const { getValidatedPath } = require("internal/fs/utils");
const {
  validateBoolean,
  validateAbortSignal,
  validateIgnoreOption,
} = require("internal/validators");
const {
  AbortError,
  codes: { ERR_INVALID_ARG_VALUE },
} = require("internal/errors");
const { kEmptyObject } = require("internal/util");

function assert(value) {
  if (!value) throw new Error("Assertion failed");
}

// The fs operations run through the shim, read off it at call time (see
// header): the harness wraps these in place and tests monkey-patch them.
function lazyLoadFsSync() {
  return shimFs;
}

let kResistStopPropagation;

const kIsAIX = process.platform === "aix";

function isPathMissingForWatch(error, file) {
  if (error.code === "ENOENT") {
    return true;
  }
  // AIX reports ENODEV when the path disappears before fs.watch() starts.
  // Check that it is actually gone so other ENODEV errors still propagate.
  if (!kIsAIX || error.code !== "ENODEV") {
    return false;
  }
  try {
    return (
      lazyLoadFsSync().statSync(file, { throwIfNoEntry: false }) === undefined
    );
  } catch {
    return false;
  }
}

// Inotify reports changes to a directory's entries, with their names, on the
// directory's own watch, so one watcher per directory is enough on Linux.
// kqueue and event ports only report that the directory itself changed, so
// elsewhere every file keeps a watcher of its own as well.
const kDirectoryWatchReportsEntries = process.platform === "linux";

class FSWatcher extends EventEmitter {
  #options = null;
  #closed = false;
  // Every path below the root that has been reported (or existed at start).
  #entries = new Set();
  // One fs.watch() per directory and symbolic link (and per file where the
  // directory watch does not report its entries).
  #watchers = new Map();
  #symbolicLinks = new Set();
  // Folders whose #scanFolder is on the stack. memfs delivers watch events
  // synchronously inside the mutating call, so an event fired during a
  // scan can re-enter #scanFolder for the same folder (the harness's
  // sync-on-read resurrects a just-deleted dir from real disk while its
  // memfs deletion is still in flight, and the re-scan re-arms the mock
  // rmSync that deleted it — an unbounded resurrect/delete cycle).
  // libuv never delivers an event re-entrantly, so in real Node this set
  // is always empty when an event arrives; the guard only fires for the
  // synchronous case, and the outer scan's own readdir still sees the
  // post-event state, so no update is lost.
  #scanning = new Set();
  #rootPath = path.resolve();
  #ignoreMatcher = null;

  constructor(options = kEmptyObject) {
    super();

    assert(typeof options === "object");

    const { persistent, recursive, signal, encoding, ignore } = options;
    let { throwIfNoEntry } = options;

    // TODO(anonrig): Add non-recursive support to non-native-watcher for IBMi & AIX support.
    if (recursive != null) {
      validateBoolean(recursive, "options.recursive");
    }

    if (persistent != null) {
      validateBoolean(persistent, "options.persistent");
    }

    if (signal != null) {
      validateAbortSignal(signal, "options.signal");
    }

    if (throwIfNoEntry != null) {
      validateBoolean(throwIfNoEntry, "options.throwIfNoEntry");
    } else {
      throwIfNoEntry = true;
    }

    if (encoding != null) {
      // This is required since on macOS and Windows it throws ERR_INVALID_ARG_VALUE
      if (typeof encoding !== "string") {
        throw new ERR_INVALID_ARG_VALUE("options.encoding", encoding);
      }
    }

    validateIgnoreOption(ignore, "options.ignore");
    this.#ignoreMatcher = createIgnoreMatcher(ignore);

    this.#options = {
      persistent,
      recursive,
      signal,
      encoding,
      throwIfNoEntry,
    };
  }

  close() {
    if (this.#closed) {
      return;
    }

    this.#closed = true;

    for (const watcher of this.#watchers.values()) {
      watcher.close();
    }
    this.#watchers.clear();
    this.#entries.clear();
    this.#symbolicLinks.clear();
    this.emit("close");
  }

  #emit(eventType, file) {
    this.emit("change", eventType, path.relative(this.#rootPath, file));
  }

  #forget(file) {
    const watcher = this.#watchers.get(file);
    if (watcher !== undefined) {
      watcher.close();
      this.#watchers.delete(file);
    }
    this.#entries.delete(file);
    this.#symbolicLinks.delete(file);

    const childPrefix = file + path.sep;
    for (const entry of this.#entries) {
      if (entry.startsWith(childPrefix)) {
        this.#entries.delete(entry);
        this.#symbolicLinks.delete(entry);
        const childWatcher = this.#watchers.get(entry);
        if (childWatcher !== undefined) {
          childWatcher.close();
          this.#watchers.delete(entry);
        }
      }
    }
  }

  // Report an entry that vanished between being listed and being watched so
  // the caller can discard its stale bookkeeping.
  #watch(file, onChange) {
    if (this.#closed) {
      return false;
    }
    if (this.#watchers.has(file)) {
      return true;
    }
    const { watch } = lazyLoadFsSync();
    let watcher;
    try {
      watcher = watch(
        file,
        { persistent: this.#options.persistent },
        onChange,
      );
    } catch (err) {
      if (
        isPathMissingForWatch(err, file) &&
        (file !== this.#rootPath || !this.#options.throwIfNoEntry)
      ) {
        return false;
      }
      throw err;
    }
    // memfs delivers watch events synchronously inside the mutating call,
    // so the listener may already have forgotten this entry (or closed
    // the watcher) while watch() was still on the stack. Do not register
    // a watcher for a forgotten entry — close it and report failure
    // (the root is never an entry, so it is exempt: a vanished root is
    // reported by the readdir ENOENT below, as in Node).
    if (
      this.#closed ||
      (file !== this.#rootPath && !this.#entries.has(file))
    ) {
      watcher.close();
      return false;
    }
    this.#watchers.set(file, watcher);
    return true;
  }

  // Arms one watcher for `folder`, then registers entries that are not known
  // yet (emitting 'rename' for them unless this is the initial scan);
  // #addEntry() descends into subdirectories.
  #scanFolder(folder, initial) {
    if (this.#scanning.has(folder)) {
      return;
    }
    this.#scanning.add(folder);
    try {
      this.#scanFolderInner(folder, initial);
    } finally {
      this.#scanning.delete(folder);
    }
  }

  #scanFolderInner(folder, initial) {
    if (
      !this.#watch(folder, (eventType, filename) =>
        this.#onFolderEvent(folder, filename),
      )
    ) {
      this.#forget(folder);
      return;
    }

    const { readdirSync } = lazyLoadFsSync();
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        if (
          folder === this.#rootPath &&
          initial &&
          (error.code !== "ENOENT" || this.#options.throwIfNoEntry)
        ) {
          throw error;
        }
        if (!initial && !this.#closed) {
          this.#emit("rename", folder);
        }
        this.#forget(folder);
      } else {
        this.emit("error", error);
      }
      return;
    }

    for (const entry of entries) {
      if (this.#closed) {
        break;
      }
      const file = path.join(folder, entry.name);
      if (
        !this.#entries.has(file) &&
        !this.#ignoreMatcher?.(path.relative(this.#rootPath, file))
      ) {
        this.#addEntry(file, entry, initial);
      }
    }
  }

  // `entry` is the Dirent or the lstat() Stats of `file`.
  #addEntry(file, entry, initial) {
    this.#entries.add(file);
    if (!initial) {
      this.#emit("rename", file);
    }
    if (entry.isSymbolicLink()) {
      // The link target is watched so that changes behind the link surface
      // as a 'rename' of the link, as they always have on this code path.
      this.#symbolicLinks.add(file);
      if (!this.#watch(file, () => this.#emit("rename", file))) {
        this.#forget(file);
      }
    } else if (entry.isDirectory()) {
      this.#scanFolder(file, initial);
    } else if (!kDirectoryWatchReportsEntries) {
      if (!this.#watch(file, () => this.#onEntryEvent(file))) {
        this.#forget(file);
      }
    }
  }

  #onFolderEvent(folder, filename) {
    if (this.#closed) {
      return;
    }
    const { lstatSync, statSync } = lazyLoadFsSync();
    if (!kDirectoryWatchReportsEntries || filename == null) {
      // All that is known is that something about `folder` changed.
      if (statSync(folder, { throwIfNoEntry: false }) === undefined) {
        this.#emit("rename", folder);
        this.#forget(folder);
      } else {
        this.#scanFolder(folder, false);
      }
      return;
    }
    // Events about the watched directory itself are reported under its own
    // name; those take the "unknown entry" path and are resolved by the parent.
    const file = path.join(folder, filename);

    if (!this.#entries.has(file)) {
      if (this.#ignoreMatcher?.(path.relative(this.#rootPath, file))) {
        return;
      }
      const entry = lstatSync(file, { throwIfNoEntry: false });
      if (entry !== undefined) {
        this.#addEntry(file, entry, false);
      } else if (
        folder === this.#rootPath &&
        statSync(folder, { throwIfNoEntry: false }) === undefined
      ) {
        this.#emit("rename", folder);
        this.#forget(folder);
      }
      return;
    }

    this.#onEntryEvent(file);
  }

  // Something happened to a known entry: work out what from its current state.
  #onEntryEvent(file) {
    if (this.#closed) {
      return;
    }
    const { statSync } = lazyLoadFsSync();
    const stats = statSync(file, { throwIfNoEntry: false });
    if (stats === undefined) {
      this.#emit("rename", file);
      this.#forget(file);
    } else if (this.#symbolicLinks.has(file)) {
      this.#emit("rename", file);
    } else if (stats.isDirectory()) {
      this.#scanFolder(file, false);
    } else {
      this.#emit("change", file);
    }
  }

  #watchRootFile(file) {
    const { statSync } = lazyLoadFsSync();
    this.#entries.add(file);
    if (
      !this.#watch(file, () => {
        if (this.#closed) {
          return;
        }
        if (statSync(file, { throwIfNoEntry: false }) === undefined) {
          this.#emit("rename", file);
          this.#forget(file);
        } else {
          this.emit("change", "change", path.basename(file));
        }
      })
    ) {
      this.#forget(file);
    }
  }

  [kFSWatchStart](filename) {
    filename = path.resolve(getValidatedPath(filename));

    try {
      const file = lazyLoadFsSync().statSync(filename);

      this.#rootPath = filename;
      this.#closed = false;

      if (file.isDirectory()) {
        this.#scanFolder(filename, true);
      } else {
        this.#watchRootFile(filename);
      }
    } catch (error) {
      if (this.#options.throwIfNoEntry || error.code !== "ENOENT") {
        error.filename = filename;
        this.close();
        throw error;
      }
    }
  }

  ref() {
    for (const watcher of this.#watchers.values()) {
      watcher.ref();
    }
  }

  unref() {
    for (const watcher of this.#watchers.values()) {
      watcher.unref();
    }
  }

  [Symbol.asyncIterator]() {
    const { signal } = this.#options;
    const promiseExecutor =
      signal == null
        ? (resolve) => {
            this.once("change", (eventType, filename) => {
              resolve({
                __proto__: null,
                value: { eventType, filename },
              });
            });
          }
        : (resolve, reject) => {
            const onAbort = () => {
              this.close();
              reject(new AbortError(undefined, { cause: signal.reason }));
            };
            if (signal.aborted) return onAbort();
            kResistStopPropagation ??= require(
              "internal/event_target",
            ).kResistStopPropagation;
            signal.addEventListener("abort", onAbort, {
              __proto__: null,
              once: true,
              [kResistStopPropagation]: true,
            });
            this.once("change", (eventType, filename) => {
              signal.removeEventListener("abort", onAbort);
              resolve({
                __proto__: null,
                value: { eventType, filename },
              });
            });
          };
    return {
      next: () =>
        this.#closed
          ? { __proto__: null, done: true }
          : new Promise(promiseExecutor),
      return: () => {
        this.close();
        return { __proto__: null, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

export { FSWatcher, kFSWatchStart };
export default { FSWatcher, kFSWatchStart };
