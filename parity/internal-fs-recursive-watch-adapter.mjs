// Parity adapter for `require('internal/fs/recursive_watch')` used by the
// fs test test-fs-watch-recursive-delete-race.js (the only fs test importing
// it).
//
// The problem: Node's JS recursive FSWatcher (lib/internal/fs/recursive_watch.js)
// is what fs.watch({ recursive: true }) uses on Linux, where libuv has no
// native recursive watcher. Without a redirect the require falls through to
// native Node's internal module, whose lazyLoadFsSync() returns native fs —
// its statSync on the memfs-only parent throws ENOENT at
// [kFSWatchStart] (node:internal/fs/recursive_watch:322).
//
// This adapter is a faithful port of Node v24.20.0's FSWatcher class
// (constructor validation, close, #watchFolder/#watchFile, [kFSWatchStart],
// ref/unref, async iterator), with exactly one substitution: the fs
// operations (statSync, readdirSync, watch) run through the shim
// (../src/fs.js default export) instead of native fs. The fs methods are
// read off the shared shim object AT CALL TIME — the harness wraps the
// shim's methods in place on that object, and the test monkey-patches
// fs.watch on it, so the port must not capture the functions at import
// time (Node's lazyLoadFsSync() has the same call-time shape).
//
// The validators, error classes, getValidatedPath, createIgnoreMatcher and
// the kFSWatchStart symbol come from real Node internals (via createRequire
// — the adapter lives under parity/, so the preload's testsDir-guarded
// redirect does not apply to it) and from the sibling watchers adapter,
// exactly as the net adapter does for `internal/net` (PR #425 precedent).
//
// Harness-only; src/ behavior is untouched. The delete-during-start race
// the test exercises is handled by Node's own design: #watchFolder ignores
// ENOENT when a directory vanishes between readdir and watch, so no error
// is emitted for the deleted child.
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import path from "node:path";
import shimFs from "../src/fs.js";
import {
  kFSWatchStart,
  createIgnoreMatcher,
  StatWatcher,
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

class FSWatcher extends EventEmitter {
  #options = null;
  #closed = false;
  #files = new Map();
  #watchers = new Map();
  #symbolicFiles = new Set();
  #rootPath = path.resolve();
  #watchingFile = false;
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

    for (const file of this.#files.keys()) {
      this.#watchers.get(file)?.close();
      this.#watchers.delete(file);
    }

    this.#files.clear();
    this.#symbolicFiles.clear();
    this.emit("close");
  }

  #unwatchFiles(file) {
    this.#symbolicFiles.delete(file);

    const childPrefix = file + path.sep;
    for (const filename of this.#files.keys()) {
      if (filename === file || filename.startsWith(childPrefix)) {
        this.#files.delete(filename);
        this.#watchers.get(filename)?.close();
        this.#watchers.delete(filename);
      }
    }
  }

  #watchFolder(folder) {
    // Read off the shim at call time: the harness wraps these in place and
    // tests may monkey-patch them (same shape as Node's lazyLoadFsSync()).
    const { readdirSync } = shimFs;

    try {
      const files = readdirSync(folder, {
        withFileTypes: true,
      });

      for (const file of files) {
        if (this.#closed) {
          break;
        }

        const f = path.join(folder, file.name);
        const relativePath = path.relative(this.#rootPath, f);

        // Skip watching ignored paths entirely to avoid kernel resource pressure
        if (this.#ignoreMatcher?.(relativePath)) {
          continue;
        }

        if (!this.#files.has(f)) {
          this.emit("change", "rename", relativePath);

          if (file.isSymbolicLink()) {
            this.#symbolicFiles.add(f);
          }

          try {
            this.#watchFile(f);
            if (file.isDirectory() && !file.isSymbolicLink()) {
              this.#watchFolder(f);
            }
          } catch (err) {
            // Ignore ENOENT
            if (err.code !== "ENOENT") {
              throw err;
            }
          }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.emit("error", error);
      }
    }
  }

  #watchFile(file) {
    if (this.#closed) {
      return;
    }

    // Read off the shim at call time (see #watchFolder): the test
    // monkey-patches fs.watch, so a captured reference would miss it.
    const { watch, statSync } = shimFs;

    if (this.#files.has(file)) {
      return;
    }

    {
      const existingStat = statSync(file);
      this.#files.set(file, existingStat);
    }

    // memfs delivers watch events SYNCHRONOUSLY inside the mutating call
    // (rmSync emits 'change' while watch() is still on the stack); libuv
    // delivers them on a later turn, after watch() has returned. The
    // callback must therefore tolerate running before the watcher variable
    // is assigned — hence the `let` cell + guard instead of Node's
    // `const watcher = watch(...)`.
    let watcher;
    const onChange = () => {
      const existingStat = this.#files.get(file);
      let currentStats;

      try {
        currentStats = statSync(file);
        this.#files.set(file, currentStats);
      } catch {
        // This happens if the file was removed
      }

      if (
        currentStats === undefined ||
        (currentStats.birthtimeMs === 0 && existingStat.birthtimeMs !== 0)
      ) {
        // The file is now deleted
        this.#files.delete(file);
        this.#watchers.delete(file);
        watcher?.close();
        this.emit("change", "rename", path.relative(this.#rootPath, file));
        this.#unwatchFiles(file);
      } else if (file === this.#rootPath && this.#watchingFile) {
        // This case will only be triggered when watching a file with fs.watch
        this.emit("change", "change", path.basename(file));
      } else if (this.#symbolicFiles.has(file)) {
        // Stats from watchFile does not return correct value for currentStats.isSymbolicLink()
        // Since it is only valid when using fs.lstat(). Therefore, check the existing symbolic files.
        this.emit("change", "rename", path.relative(this.#rootPath, file));
      } else if (currentStats.isDirectory()) {
        this.#watchFolder(file);
      } else {
        // Watching a directory will trigger a change event for child files)
        this.emit("change", "change", path.relative(this.#rootPath, file));
      }
    };
    watcher = watch(
      file,
      {
        persistent: this.#options.persistent,
      },
      onChange,
    );
    if (!this.#files.has(file)) {
      // The callback already fired synchronously (memfs delivers events
      // inside the mutating call) and found the file gone: Node's callback
      // closes the watcher itself, but it ran before `watcher` was
      // assigned, so the guard above skipped the close. Close now instead
      // of registering a watcher for a deleted file (otherwise its timer
      // holds the event loop forever).
      watcher.close();
      return;
    }
    this.#watchers.set(file, watcher);
  }

  [kFSWatchStart](filename) {
    filename = path.resolve(getValidatedPath(filename));

    try {
      const file = shimFs.statSync(filename);

      this.#rootPath = filename;
      this.#closed = false;
      this.#watchingFile = file.isFile();

      this.#watchFile(filename);
      if (file.isDirectory()) {
        this.#watchFolder(filename);
      }
    } catch (error) {
      if (!this.#options.throwIfNoEntry && error.code === "ENOENT") {
        error.filename = filename;
        throw error;
      }
    }
  }

  ref() {
    this.#files.forEach((file) => {
      if (file instanceof StatWatcher) {
        file.ref();
      }
    });
  }

  unref() {
    this.#files.forEach((file) => {
      if (file instanceof StatWatcher) {
        file.unref();
      }
    });
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
            const kResistStopPropagation =
              require("internal/event_target").kResistStopPropagation;
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
