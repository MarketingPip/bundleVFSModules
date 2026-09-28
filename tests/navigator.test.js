import {
  jest,
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import nodeOs from "node:os";

// Static import: evaluated once under real Node. The module's default export
// takes the native-bridge lane here (real Node navigator), while the named
// Navigator/createNavigator exports are the portable pure implementation.
import {
  navigator as navExport,
  Navigator,
  createNavigator,
} from "../src/navigator.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fakeSource = ({
  version = "v24.20.0",
  platform = "linux",
  arch = "x64",
  env = {},
  parallelism = 4,
} = {}) => ({
  version,
  platform,
  arch,
  env,
  availableParallelism: () => parallelism,
});

describe("navigator — native Node lane (default export)", () => {
  test("default export is the ambient Node navigator", () => {
    expect(navExport).toBe(globalThis.navigator);
  });

  test("userAgent is Node.js/<major>", () => {
    const major = process.versions.node.split(".")[0];
    expect(navExport.userAgent).toBe(`Node.js/${major}`);
  });

  test("platform matches Node platform mapping", () => {
    // This host is linux/x64.
    expect(navExport.platform).toBe("Linux x86_64");
  });

  test("language/languages", () => {
    expect(typeof navExport.language).toBe("string");
    expect(navExport.language.length).toBeGreaterThan(0);
    expect(Array.isArray(navExport.languages)).toBe(true);
    expect(navExport.languages).toHaveLength(1);
    expect(navExport.languages[0]).toBe(navExport.language);
    expect(Object.isFrozen(navExport.languages)).toBe(true);
    expect(navExport.languages).toBe(navExport.languages); // stable ref
  });

  test("hardwareConcurrency matches os.availableParallelism()", () => {
    expect(navExport.hardwareConcurrency).toBe(nodeOs.availableParallelism());
  });

  test("locks is a working LockManager", async () => {
    const locks = navExport.locks;
    expect(navExport.locks).toBe(locks); // stable ref
    expect(typeof locks.request).toBe("function");
    expect(typeof locks.query).toBe("function");
    await expect(locks.query()).resolves.toEqual({ held: [], pending: [] });
    await expect(locks.request("nav-test", () => "ok")).resolves.toBe("ok");
  });

  test("no browser-only surface", () => {
    for (const key of [
      "userAgentData",
      "onLine",
      "geolocation",
      "mediaDevices",
      "cookieEnabled",
      "vendor",
      "deviceMemory",
      "connection",
      "getUserMedia",
      "sendBeacon",
      "clipboard",
    ]) {
      expect(key in navExport).toBe(false);
    }
  });

  test("no own properties; getters live on Navigator.prototype and are enumerable", () => {
    expect(Object.getOwnPropertyNames(navExport)).toEqual([]);
    const protoKeys = Object.keys(Object.getPrototypeOf(navExport)).sort();
    expect(protoKeys).toEqual([
      "hardwareConcurrency",
      "language",
      "languages",
      "locks",
      "platform",
      "userAgent",
    ]);
  });
});

describe("Navigator class — Node constructor/brand semantics", () => {
  test("new Navigator() throws illegal constructor", () => {
    let err;
    try {
      new Navigator();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TypeError);
    expect(err.code).toBe("ERR_ILLEGAL_CONSTRUCTOR");
  });

  test("getters brand-check: wrong receiver throws TypeError", () => {
    for (const key of [
      "userAgent",
      "platform",
      "language",
      "languages",
      "hardwareConcurrency",
      "locks",
    ]) {
      const get = Object.getOwnPropertyDescriptor(Navigator.prototype, key).get;
      expect(() => get.call({})).toThrow(TypeError);
      expect(() => get.call(Navigator.prototype)).toThrow(TypeError);
    }
  });

  test("no Symbol.toStringTag on Navigator.prototype (Node has none)", () => {
    expect(
      Object.getOwnPropertyDescriptor(Navigator.prototype, Symbol.toStringTag),
    ).toBeUndefined();
    expect(Object.prototype.toString.call(createNavigator())).toBe(
      "[object Object]",
    );
  });
});

describe("pure implementation — value semantics (createNavigator)", () => {
  test("userAgent tracks major version only", () => {
    expect(createNavigator(fakeSource({ version: "v20.11.0" })).userAgent).toBe(
      "Node.js/20",
    );
    expect(createNavigator(fakeSource({ version: "v24.20.0" })).userAgent).toBe(
      "Node.js/24",
    );
  });

  test("platform mapping matches Node getNavigatorPlatform", () => {
    const cases = [
      ["darwin", "x64", "MacIntel"],
      ["darwin", "arm64", "MacIntel"],
      ["win32", "x64", "Win32"],
      ["linux", "x64", "Linux x86_64"],
      ["linux", "ia32", "Linux i686"],
      ["linux", "arm64", "Linux arm64"],
      ["freebsd", "x64", "FreeBSD amd64"],
      ["freebsd", "ia32", "FreeBSD i386"],
      ["openbsd", "x64", "OpenBSD amd64"],
      ["sunos", "x64", "SunOS x64"],
      ["sunos", "ia32", "SunOS i86pc"],
      ["aix", "ppc64", "AIX"],
    ];
    for (const [platform, arch, expected] of cases) {
      expect(createNavigator(fakeSource({ platform, arch })).platform).toBe(
        expected,
      );
    }
  });

  test("language from env locale, en-US fallback", () => {
    expect(createNavigator(fakeSource({ env: {} })).language).toBe("en-US");
    expect(createNavigator(fakeSource({ env: { LANG: "C" } })).language).toBe(
      "en-US",
    );
    expect(
      createNavigator(fakeSource({ env: { LANG: "fr_FR.UTF-8" } })).language,
    ).toBe("fr-FR");
    expect(
      createNavigator(fakeSource({ env: { LANG: "de_DE" } })).language,
    ).toBe("de-DE");
    expect(
      createNavigator(
        fakeSource({ env: { LC_ALL: "es_ES.UTF-8", LANG: "fr_FR.UTF-8" } }),
      ).language,
    ).toBe("es-ES");
  });

  test("languages is a frozen single-entry array, stable across reads", () => {
    const n = createNavigator(fakeSource({ env: { LANG: "ja_JP.UTF-8" } }));
    expect(n.languages).toEqual(["ja-JP"]);
    expect(Object.isFrozen(n.languages)).toBe(true);
    expect(n.languages).toBe(n.languages);
  });

  test("hardwareConcurrency from source", () => {
    expect(
      createNavigator(fakeSource({ parallelism: 8 })).hardwareConcurrency,
    ).toBe(8);
  });

  test("no browser-only surface on the pure instance either", () => {
    const n = createNavigator();
    for (const key of [
      "userAgentData",
      "onLine",
      "geolocation",
      "mediaDevices",
      "cookieEnabled",
      "vendor",
    ]) {
      expect(key in n).toBe(false);
    }
    expect(Object.getOwnPropertyNames(n)).toEqual([]);
  });
});

describe("pure implementation — LockManager", () => {
  let locks;
  beforeEach(() => {
    locks = createNavigator().locks;
  });

  test("request resolves with the callback return value; lock has name/mode", async () => {
    const seen = [];
    const result = await locks.request("a", (lock) => {
      seen.push([lock.name, lock.mode, Object.prototype.toString.call(lock)]);
      return 42;
    });
    expect(result).toBe(42);
    expect(seen).toEqual([["a", "exclusive", "[object Lock]"]]);
  });

  test("exclusive requests serialize", async () => {
    const order = [];
    const p1 = locks.request("res", async () => {
      order.push("a-start");
      await sleep(20);
      order.push("a-end");
    });
    const p2 = locks.request("res", () => {
      order.push("b");
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  test("shared requests run concurrently", async () => {
    let concurrent = 0;
    let max = 0;
    await Promise.all(
      [0, 1].map(() =>
        locks.request("sh", { mode: "shared" }, async () => {
          concurrent += 1;
          max = Math.max(max, concurrent);
          await sleep(15);
          concurrent -= 1;
        }),
      ),
    );
    expect(max).toBe(2);
  });

  test("different names do not block each other", async () => {
    const order = [];
    await Promise.all([
      locks.request("n1", async () => {
        await sleep(20);
        order.push("n1");
      }),
      locks.request("n2", () => {
        order.push("n2");
      }),
    ]);
    expect(order[0]).toBe("n2");
  });

  test("callback throw rejects and releases the lock", async () => {
    const boom = new Error("boom");
    await expect(
      locks.request("e1", () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    await expect(locks.request("e1", () => "after")).resolves.toBe("after");
  });

  test("query() reflects held and pending", async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const held = locks.request("q1", async () => {
      await gate;
    });
    const pending = locks.request("q1", () => "late");
    await sleep(10);
    const snap = await locks.query();
    expect(snap.held).toEqual([{ name: "q1", mode: "exclusive" }]);
    expect(snap.pending).toEqual([{ name: "q1", mode: "exclusive" }]);
    release();
    await held;
    await pending;
    await expect(locks.query()).resolves.toEqual({ held: [], pending: [] });
  });

  test("ifAvailable miss invokes callback with null", async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const held = locks.request("q3", async () => {
      await gate;
    });
    await sleep(10);
    await expect(
      locks.request("q3", { ifAvailable: true }, (lock) => lock),
    ).resolves.toBeNull();
    release();
    await held;
  });

  test("ifAvailable hit grants the lock", async () => {
    await expect(
      locks.request("q4", { ifAvailable: true }, (lock) => lock && lock.name),
    ).resolves.toBe("q4");
  });

  test("steal preempts a held lock; victim rejects with AbortError", async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const victim = locks.request("st", async () => {
      await gate;
      return "victim";
    });
    await sleep(10);
    await expect(
      locks.request("st", { steal: true }, () => "stolen"),
    ).resolves.toBe("stolen");
    release();
    const err = await victim.catch((e) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe("AbortError");
  });

  test("missing callback rejects with ERR_INVALID_ARG_TYPE TypeError", async () => {
    const err = await locks.request("x").catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.code).toBe("ERR_INVALID_ARG_TYPE");
  });

  test("name starting with hyphen rejects with NotSupportedError", async () => {
    const err = await locks.request("-bad", () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe("NotSupportedError");
  });

  test("invalid mode rejects with TypeError", async () => {
    await expect(
      locks.request("x", { mode: "bogus" }, () => {}),
    ).rejects.toThrow(TypeError);
  });

  test("ifAvailable + steal rejects with NotSupportedError", async () => {
    const err = await locks
      .request("x", { ifAvailable: true, steal: true }, () => {})
      .catch((e) => e);
    expect(err.name).toBe("NotSupportedError");
  });

  test("shared + steal rejects with NotSupportedError", async () => {
    const err = await locks
      .request("x", { mode: "shared", steal: true }, () => {})
      .catch((e) => e);
    expect(err.name).toBe("NotSupportedError");
  });

  test("already-aborted signal rejects with AbortError and never runs the callback", async () => {
    const c = new AbortController();
    c.abort();
    let ran = false;
    const err = await locks
      .request("x", { signal: c.signal }, () => {
        ran = true;
      })
      .catch((e) => e);
    expect(err.name).toBe("AbortError");
    expect(ran).toBe(false);
  });

  test("abort while queued removes the request and rejects", async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const held = locks.request("ab", async () => {
      await gate;
    });
    await sleep(10);
    const c = new AbortController();
    const queued = locks.request("ab", { signal: c.signal }, () => "never");
    c.abort(new DOMException("stop", "AbortError"));
    const err = await queued.catch((e) => e);
    expect(err.name).toBe("AbortError");
    const snap = await locks.query();
    expect(snap.pending).toEqual([]);
    release();
    await held;
  });

  test("query on a non-LockManager receiver throws", async () => {
    const query = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(locks),
      "query",
    ).value;
    await expect(query.call({})).rejects.toThrow(TypeError);
  });

  test("LockManager prototype has toStringTag; methods enumerable", () => {
    const proto = Object.getPrototypeOf(locks);
    expect(proto[Symbol.toStringTag]).toBe("LockManager");
    expect(Object.keys(proto).sort()).toEqual(["query", "request"]);
  });
});

describe("module default export — lane selection", () => {
  const realDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", realDesc);
    jest.resetModules();
  });

  test("under Node, the default export is the native navigator", async () => {
    jest.resetModules();
    const m = await import("../src/navigator.js");
    expect(m.default).toBe(globalThis.navigator);
    expect(m.navigator).toBe(globalThis.navigator);
  });

  test("with a browser-like navigator global, the default export is the Node-faithful shim", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      configurable: true,
    });
    jest.resetModules();
    const m = await import("../src/navigator.js");
    expect(m.default).not.toBe(globalThis.navigator);
    expect(m.default.userAgent).toMatch(/^Node\.js\/\d+$/);
    expect(m.default.platform).toBe("Linux x86_64");
    expect(m.default).toBeInstanceOf(m.Navigator);
  });

  test("with no navigator global, the default export is the shim", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      configurable: true,
    });
    jest.resetModules();
    const m = await import("../src/navigator.js");
    expect(m.default.userAgent).toMatch(/^Node\.js\/\d+$/);
    expect(m.default.hardwareConcurrency).toBeGreaterThan(0);
  });

  test("install() sets globalThis.navigator only when undefined", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      configurable: true,
    });
    jest.resetModules();
    const m = await import("../src/navigator.js");
    m.install();
    expect(globalThis.navigator).toBe(m.default);

    const existing = { userAgent: "keep-me" };
    Object.defineProperty(globalThis, "navigator", {
      value: existing,
      configurable: true,
    });
    m.install();
    expect(globalThis.navigator).toBe(existing);
  });
});
