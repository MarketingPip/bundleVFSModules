/*!
 * navigator — Node.js `navigator` global for environments that lack one.
 *
 * Faithful ESM port of Node.js v24.20.0 `lib/internal/navigator.js`
 * (backed by `lib/internal/locks.js` for `navigator.locks`).
 *
 * Node's navigator is deliberately minimal — it is NOT the browser's
 * Navigator. The entire surface is six getters on `Navigator.prototype`:
 * `hardwareConcurrency`, `language`, `languages`, `locks`, `platform`,
 * `userAgent`. There is no `userAgentData`, `onLine`, `geolocation`,
 * `mediaDevices`, `cookieEnabled`, `vendor`, `deviceMemory`, or `connection`.
 *
 * Design — two lanes (same pattern as src/os.js):
 *  1. Under genuine Node the ambient `globalThis.navigator` already IS
 *     Node's, so the module re-exports it (exact parity, zero drift).
 *     Detected via `process.versions.node` plus a `userAgent` that starts
 *     with `'Node.js/'`, so browser navigators and test mocks never match.
 *  2. Everywhere else (Jared's sandbox deny-lists the browser's navigator,
 *     real browser pages, edge runtimes) the pure `Navigator`
 *     implementation below is exported. It reads `version`/`platform`/
 *     `arch`/`env` from the sandbox `_RUNTIME_.process` (or the ambient
 *     `globalThis.process`), exactly like Node's internal bindings do.
 *
 * `navigator.locks` is an in-realm Web Locks implementation: FIFO queues,
 * shared/exclusive modes, `ifAvailable`, `steal`, `AbortSignal`, and
 * `query()`. Node coordinates locks across worker threads in C++; a pure
 * JS shim cannot, so cross-realm exclusion is the documented gap
 * (single-realm semantics are exact).
 */

/**
 * Runtime bridge (guarded: rewritten to the sandbox scope at load time,
 * undefined under real Node / direct import).
 */
function getProcess() {
  const RT =
    typeof globalThis._RUNTIME_ !== "undefined"
      ? globalThis._RUNTIME_
      : undefined;
  if (RT && RT.process) return RT.process;
  if (typeof globalThis.process === "object" && globalThis.process !== null) {
    return globalThis.process;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Error helpers — mirror Node's codes.
// ---------------------------------------------------------------------------

function inspectArg(value) {
  if (value === null || value === undefined) return `${value}`;
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "function")
    return `function ${value.name || "anonymous"}`;
  return `type ${typeof value}`;
}

class ERR_INVALID_ARG_TYPE extends TypeError {
  constructor(name, expected, actual) {
    super(
      `The "${name}" argument must be of type ${expected}. Received ${inspectArg(actual)}`,
    );
    this.code = "ERR_INVALID_ARG_TYPE";
  }
}

function illegalConstructor() {
  const err = new TypeError("Illegal constructor");
  err.code = "ERR_ILLEGAL_CONSTRUCTOR";
  return err;
}

function invalidThis(type) {
  const err = new TypeError(`Value of "this" must be of type ${type}`);
  err.code = "ERR_INVALID_THIS";
  return err;
}

function notSupportedError(message) {
  return new DOMException(message, "NotSupportedError");
}

function abortError(reason) {
  if (reason !== undefined) return reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

// ---------------------------------------------------------------------------
// getNavigatorPlatform — verbatim port of Node's internal/navigator.js.
// ---------------------------------------------------------------------------

/**
 * Maps Node.js arch/platform to the browser-style platform string Node
 * reports (e.g. darwin -> 'MacIntel', matching modern browsers).
 */
export function getNavigatorPlatform(arch, platform) {
  if (platform === "darwin") {
    // On macOS, modern browsers return 'MacIntel' even on Apple Silicon.
    return "MacIntel";
  } else if (platform === "win32") {
    // On Windows, modern browsers return 'Win32' even on 64-bit Windows.
    return "Win32";
  } else if (platform === "linux") {
    if (arch === "ia32") {
      return "Linux i686";
    } else if (arch === "x64") {
      return "Linux x86_64";
    }
    return `Linux ${arch}`;
  } else if (platform === "freebsd") {
    if (arch === "ia32") {
      return "FreeBSD i386";
    } else if (arch === "x64") {
      return "FreeBSD amd64";
    }
    return `FreeBSD ${arch}`;
  } else if (platform === "openbsd") {
    if (arch === "ia32") {
      return "OpenBSD i386";
    } else if (arch === "x64") {
      return "OpenBSD amd64";
    }
    return `OpenBSD ${arch}`;
  } else if (platform === "sunos") {
    if (arch === "ia32") {
      return "SunOS i86pc";
    }
    return `SunOS ${arch}`;
  } else if (platform === "aix") {
    return "AIX";
  }
  return `${platform[0].toUpperCase()}${platform.slice(1)} ${arch}`;
}

/**
 * `Node.js/<major>` — Node slices its `vX.Y.Z` version the same way.
 */
function getMajorVersion(version) {
  const v = String(version);
  const dot = v.indexOf(".");
  return dot === -1 ? v.slice(1) : v.slice(1, dot);
}

/**
 * Approximation of Node's ICU-backed `getDefaultLocale()`: derive a
 * BCP 47 tag from LC_ALL/LC_MESSAGES/LANG. Unparseable values
 * ('C', 'POSIX', '') yield '' so the caller falls back to 'en-US'.
 */
function getDefaultLocale(env) {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  const tag = String(raw).split(".")[0].split("@")[0].replace(/_/g, "-");
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(tag) ? tag : "";
}

// ---------------------------------------------------------------------------
// Lock / LockManager — port of Node's internal/locks.js (single-realm).
// ---------------------------------------------------------------------------

const kLockInit = Symbol("kLockInit");
const kLockManagerInit = Symbol("kLockManagerInit");

// Process-wide lock state, like Node's C++ binding: name -> { held, pending }.
const lockQueues = new Map();

class Lock {
  #name;
  #mode;

  constructor(init, name, mode) {
    if (init !== kLockInit) {
      throw illegalConstructor();
    }
    this.#name = name;
    this.#mode = mode;
  }

  get name() {
    return this.#name;
  }

  get mode() {
    return this.#mode;
  }
}

Object.defineProperties(Lock.prototype, {
  name: { enumerable: true, configurable: true },
  mode: { enumerable: true, configurable: true },
  [Symbol.toStringTag]: {
    value: "Lock",
    writable: false,
    enumerable: false,
    configurable: true,
  },
});

function isAbortSignal(value) {
  if (!value || typeof value !== "object") return false;
  const AS = globalThis.AbortSignal;
  if (typeof AS === "function" && value instanceof AS) return true;
  return (
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.throwIfAborted === "function"
  );
}

function validateAbortSignal(signal) {
  if (!isAbortSignal(signal)) {
    throw new ERR_INVALID_ARG_TYPE("options.signal", "AbortSignal", signal);
  }
}

function toDOMString(value) {
  if (typeof value === "symbol") {
    throw new TypeError("Cannot convert a Symbol value to a string");
  }
  return String(value);
}

/**
 * WebIDL LockOptions dictionary conversion.
 */
function normalizeLockOptions(options) {
  if (
    options === undefined ||
    options === null ||
    typeof options === "function"
  ) {
    options = {};
  } else if (typeof options !== "object") {
    throw new ERR_INVALID_ARG_TYPE("options", "object", options);
  }
  const mode =
    options.mode === undefined ? "exclusive" : toDOMString(options.mode);
  if (mode !== "exclusive" && mode !== "shared") {
    throw new TypeError(
      `The provided value '${options.mode}' is not a valid enum value of type LockMode.`,
    );
  }
  return {
    mode,
    ifAvailable: !!options.ifAvailable,
    steal: !!options.steal,
    signal: options.signal,
  };
}

/**
 * Whether a lock of `mode` may be granted given held locks and the locks
 * already granted in this queue-processing pass (FIFO fairness: a granted
 * exclusive blocks later shared requests in the same pass).
 */
function isModeCompatible(mode, held, grantedModes) {
  if (mode === "exclusive") {
    return held.length === 0 && grantedModes.length === 0;
  }
  return (
    !held.some((h) => h.mode === "exclusive") &&
    !grantedModes.includes("exclusive")
  );
}

function releaseHeldLock(queue, entry) {
  const idx = queue.held.indexOf(entry);
  if (idx !== -1) queue.held.splice(idx, 1);
}

function grantLockRequest(queue, req) {
  const entry = { mode: req.mode, stolen: false };
  queue.held.push(entry);
  const lock = new Lock(kLockInit, req.name, req.mode);
  // Like Node's binding, the callback runs asynchronously after the grant.
  queueMicrotask(() => {
    (async () => {
      if (req.signal !== undefined && req.signal.aborted) {
        releaseHeldLock(queue, entry);
        processLockQueue(req.name, queue);
        req.resolve(undefined);
        return;
      }
      let result;
      try {
        result = await req.callback(lock);
      } catch (err) {
        releaseHeldLock(queue, entry);
        processLockQueue(req.name, queue);
        req.reject(err);
        return;
      }
      releaseHeldLock(queue, entry);
      processLockQueue(req.name, queue);
      if (entry.stolen) {
        // Node converts LOCK_STOLEN_ERROR into an AbortError rejection.
        req.reject(
          new DOMException("The operation was aborted.", "AbortError"),
        );
      } else {
        req.resolve(result);
      }
    })();
  });
}

function processLockQueue(name, queue) {
  const grantedModes = [];
  let i = 0;
  while (i < queue.pending.length) {
    const req = queue.pending[i];
    if (!req.steal && !isModeCompatible(req.mode, queue.held, grantedModes)) {
      i++;
      continue;
    }
    queue.pending.splice(i, 1);
    if (req.steal) {
      // Steal releases every held lock for the name; victims reject with
      // AbortError once their callbacks settle.
      for (const held of queue.held) held.stolen = true;
      queue.held.length = 0;
      grantedModes.length = 0;
    }
    grantedModes.push(req.mode);
    grantLockRequest(queue, req);
  }
  if (queue.held.length === 0 && queue.pending.length === 0) {
    lockQueues.delete(name);
  }
}

class LockManager {
  constructor(init) {
    if (init !== kLockManagerInit) {
      throw illegalConstructor();
    }
  }

  /**
   * https://w3c.github.io/web-locks/#api-lock-manager-request
   * Resolves with the callback's return value once the lock releases.
   */
  async request(name, options, callback) {
    if (callback === undefined) {
      callback = options;
      options = undefined;
    }

    name = toDOMString(name);
    if (typeof callback !== "function") {
      throw new ERR_INVALID_ARG_TYPE("callback", "function", callback);
    }

    const { mode, ifAvailable, steal, signal } = normalizeLockOptions(options);

    if (signal !== undefined) {
      validateAbortSignal(signal);
      if (signal.aborted) {
        throw abortError(signal.reason);
      }
    }

    if (name.charCodeAt(0) === 45 /* '-' */) {
      throw notSupportedError("Lock name may not start with hyphen");
    }
    if (ifAvailable && steal) {
      throw notSupportedError("ifAvailable and steal are mutually exclusive");
    }
    if (mode === "shared" && steal) {
      throw notSupportedError(
        'mode: "shared" and steal are mutually exclusive',
      );
    }
    if (signal !== undefined && (steal || ifAvailable)) {
      throw notSupportedError(
        "signal cannot be used with steal or ifAvailable",
      );
    }

    let queue = lockQueues.get(name);
    if (!queue) {
      queue = { held: [], pending: [] };
      lockQueues.set(name, queue);
    }

    // ifAvailable: grant only when no wait would be needed, else run the
    // callback with null.
    if (
      ifAvailable &&
      (queue.pending.length > 0 || !isModeCompatible(mode, queue.held, []))
    ) {
      return Promise.resolve().then(() => callback(null));
    }

    return new Promise((resolve, reject) => {
      const req = { name, mode, steal, callback, signal, resolve, reject };
      if (signal !== undefined) {
        const onAbort = () => {
          const idx = queue.pending.indexOf(req);
          if (idx !== -1) queue.pending.splice(idx, 1);
          req.reject(abortError(signal.reason));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        const origResolve = resolve;
        const origReject = reject;
        req.resolve = (value) => {
          signal.removeEventListener("abort", onAbort);
          origResolve(value);
        };
        req.reject = (err) => {
          signal.removeEventListener("abort", onAbort);
          origReject(err);
        };
      }
      queue.pending.push(req);
      processLockQueue(name, queue);
    });
  }

  /**
   * https://w3c.github.io/web-locks/#api-lock-manager-query
   */
  async query() {
    if (!(this instanceof LockManager)) {
      throw invalidThis("LockManager");
    }
    const held = [];
    const pending = [];
    for (const [name, queue] of lockQueues) {
      for (const h of queue.held) held.push({ name, mode: h.mode });
      for (const r of queue.pending)
        pending.push({ name: r.name, mode: r.mode });
    }
    return { held, pending };
  }
}

Object.defineProperties(LockManager.prototype, {
  request: { enumerable: true, configurable: true },
  query: { enumerable: true, configurable: true },
  [Symbol.toStringTag]: {
    value: "LockManager",
    writable: false,
    enumerable: false,
    configurable: true,
  },
});

// ---------------------------------------------------------------------------
// Navigator — port of Node's internal/navigator.js.
// ---------------------------------------------------------------------------

const kInitialize = Symbol("kInitialize");

/**
 * Ambient process info. Prefers the sandbox runtime's process config,
 * falls back to the ambient Node process.
 */
function defaultSource() {
  const proc = getProcess();
  let version = proc.version;
  if (!version && proc.versions && typeof proc.versions.node === "string") {
    version = `v${proc.versions.node}`;
  }
  return {
    version: version || "v0.0.0",
    platform: proc.platform || "unknown",
    arch: proc.arch || "unknown",
    env: proc.env && typeof proc.env === "object" ? proc.env : {},
    availableParallelism: defaultParallelism,
  };
}

/**
 * Estimate of usable parallelism. Uses the real `os` builtin when one is
 * reachable (genuine Node), the ambient *browser* navigator's
 * `hardwareConcurrency` when this module runs on a real browser page, and 1
 * otherwise. Never reads the module's own navigator instance back, which
 * would recurse once `install()`ed as the global.
 */
function defaultParallelism() {
  const proc = getProcess();
  try {
    const getBuiltin = proc && proc.getBuiltinModule;
    if (typeof getBuiltin === "function") {
      const osMod = getBuiltin.call(proc, "os");
      if (osMod && typeof osMod.availableParallelism === "function") {
        const n = osMod.availableParallelism();
        if (typeof n === "number" && n >= 1) return Math.floor(n);
      }
    }
  } catch {
    // Fall through to the heuristic below.
  }
  if (
    ambientBrowserNavigator &&
    typeof ambientBrowserNavigator.hardwareConcurrency === "number"
  ) {
    return ambientBrowserNavigator.hardwareConcurrency;
  }
  return 1;
}

class Navigator {
  // Private fields double as brand checks: invoking a getter on a
  // non-Navigator receiver throws a TypeError, exactly like Node.
  #availableParallelism;
  #locks;
  #userAgent;
  #platform;
  #languages;
  #source;

  constructor(init, source) {
    if (init !== kInitialize) {
      throw illegalConstructor();
    }
    this.#source = source || defaultSource();
  }

  get hardwareConcurrency() {
    this.#availableParallelism ??= this.#source.availableParallelism();
    return this.#availableParallelism;
  }

  get locks() {
    this.#locks ??= new LockManager(kLockManagerInit);
    return this.#locks;
  }

  get language() {
    // Brand check, like Node: reading a private field on a non-Navigator
    // receiver throws a TypeError.
    this.#languages;
    // The default locale may change dynamically, so it is read on every access.
    return getDefaultLocale(this.#source.env) || "en-US";
  }

  get languages() {
    this.#languages ??= Object.freeze([this.language]);
    return this.#languages;
  }

  get userAgent() {
    this.#userAgent ??= `Node.js/${getMajorVersion(this.#source.version)}`;
    return this.#userAgent;
  }

  get platform() {
    this.#platform ??= getNavigatorPlatform(
      this.#source.arch,
      this.#source.platform,
    );
    return this.#platform;
  }
}

// Node defines the getters enumerable on Navigator.prototype.
for (const key of [
  "hardwareConcurrency",
  "language",
  "languages",
  "locks",
  "userAgent",
  "platform",
]) {
  Object.defineProperty(Navigator.prototype, key, { enumerable: true });
}
// Node exposes no Symbol.toStringTag on Navigator.prototype —
// Object.prototype.toString.call(navigator) is '[object Object]'.

// ---------------------------------------------------------------------------
// Lane selection + exports.
// ---------------------------------------------------------------------------

/**
 * The ambient navigator captured at module evaluation, when it is a genuine
 * *browser* one. Used only as a hardwareConcurrency hint; never the module's
 * own instance (which would recurse after install()).
 */
function snapshotAmbientNavigator() {
  try {
    const nav = globalThis.navigator;
    if (nav && typeof nav === "object" && typeof nav.userAgent === "string") {
      if (!nav.userAgent.startsWith("Node.js/")) return nav;
    }
  } catch {
    // A deny-listed or otherwise unreadable global — treat as absent.
  }
  return undefined;
}

const ambientBrowserNavigator = snapshotAmbientNavigator();

/**
 * Under genuine Node the ambient navigator already has exactly Node's
 * behavior, so it is re-exported as-is. Browser navigators, test mocks, and
 * absent globals never match (their userAgent never starts with 'Node.js/').
 */
function getNativeNodeNavigator() {
  try {
    const nav = globalThis.navigator;
    if (
      nav &&
      typeof nav === "object" &&
      typeof nav.userAgent === "string" &&
      nav.userAgent.startsWith("Node.js/")
    ) {
      return nav;
    }
  } catch {
    // Unreadable global — fall through to the pure implementation.
  }
  return undefined;
}

/**
 * Build a Navigator from an explicit source (version/platform/arch/env/
 * availableParallelism). Used by tests and embedders; the singleton below
 * uses the ambient process.
 */
export function createNavigator(source) {
  return new Navigator(kInitialize, source);
}

export const navigator = getNativeNodeNavigator() || new Navigator(kInitialize);

/**
 * Installs the navigator onto the global scope when none is present
 * (Jared's sandbox deny-lists the browser's navigator, so user code sees
 * `undefined` without this). Never clobbers an existing navigator.
 */
export function install() {
  if (typeof globalThis.navigator === "undefined") {
    globalThis.navigator = navigator;
  }
  return globalThis.navigator;
}

export { Navigator };
export default navigator;
