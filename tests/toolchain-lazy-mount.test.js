import { describe, test, expect, beforeEach } from "@jest/globals";
import {
  registerToolchain,
  getToolchain,
  clearToolchains,
  mountSysroot,
  mountSysrootIntoSeed,
  isSysrootMounted,
  ToolchainError,
  SYSROOT_MOUNT_PREFIX,
} from "../src/toolchain.js";

// Red-first tests for the VFS read-only lazy mount seam
// (docs/TOOLCHAIN.md §4): string-path sysroots are served on demand via a
// SysrootMount instead of being copied into the seed.

beforeEach(() => {
  clearToolchains();
});

const good = () => ({
  name: "t",
  compile: async () => ({ bytes: new Uint8Array([0, 1]) }),
});

const dec = (u8) => new TextDecoder().decode(u8);

describe("mountSysroot", () => {
  test("unknown toolchain throws ToolchainError", async () => {
    await expect(mountSysroot("nope")).rejects.toThrow(ToolchainError);
    await expect(mountSysroot("nope")).rejects.toThrow(/unknown toolchain/);
  });

  test("file-map sysroot: readFile serves bytes, null on miss", async () => {
    registerToolchain({
      ...good(),
      name: "m",
      sysroot: {
        "/usr/include/a.h": "int a;\n",
        "/b.h": new Uint8Array([1, 2, 3]),
      },
    });
    const m = await mountSysroot("m");
    expect(m.readonly).toBe(true);
    const a = await m.readFile("/usr/include/a.h");
    expect(a).toBeInstanceOf(Uint8Array);
    expect(dec(a)).toBe("int a;\n");
    expect([...(await m.readFile("/b.h"))]).toEqual([1, 2, 3]);
    expect(await m.readFile("/missing.h")).toBeNull();
  });

  test("file-map sysroot: stat and listDir", async () => {
    registerToolchain({
      ...good(),
      name: "m",
      sysroot: {
        "/usr/include/a.h": "int a;\n",
        "/usr/include/sub/b.h": "x",
      },
    });
    const m = await mountSysroot("m");
    expect(await m.stat("/usr/include/a.h")).toEqual({
      size: 7,
      isDirectory: false,
    });
    expect(await m.stat("/usr/include")).toEqual({
      size: 0,
      isDirectory: true,
    });
    expect(await m.stat("/")).toEqual({ size: 0, isDirectory: true });
    expect(await m.stat("/nope")).toBeNull();
    expect(await m.listDir("/usr/include")).toEqual(["a.h", "sub"]);
    expect(await m.listDir("/")).toEqual(["usr"]);
    expect(await m.listDir("/nope")).toBeNull();
  });

  test("string sysroot: readFile delegates to tc.readFile with prefixed path", async () => {
    const seen = [];
    registerToolchain({
      ...good(),
      name: "s",
      sysroot: "/opt/wasi-sysroot",
      readFile: async (p) => {
        seen.push(p);
        return p === "/opt/wasi-sysroot/usr/include/stdio.h"
          ? "#define NULL 0\n"
          : null;
      },
    });
    const m = await mountSysroot("s");
    expect(m.readonly).toBe(true);
    const data = await m.readFile("/usr/include/stdio.h");
    expect(data).toBeInstanceOf(Uint8Array);
    expect(dec(data)).toBe("#define NULL 0\n");
    // Lazy: only the requested file was fetched, nothing pre-copied.
    expect(seen).toEqual(["/opt/wasi-sysroot/usr/include/stdio.h"]);
    expect(await m.readFile("/missing.h")).toBeNull();
    expect(seen).toEqual([
      "/opt/wasi-sysroot/usr/include/stdio.h",
      "/opt/wasi-sysroot/missing.h",
    ]);
  });

  test("string sysroot: string contents become UTF-8 bytes", async () => {
    registerToolchain({
      ...good(),
      name: "s",
      sysroot: "/opt/wasi-sysroot",
      readFile: async () => "héllo",
    });
    const m = await mountSysroot("s");
    expect([...(await m.readFile("/a.h"))]).toEqual([
      ...new TextEncoder().encode("héllo"),
    ]);
  });

  test("string sysroot: path traversal cannot escape the sysroot", async () => {
    const seen = [];
    registerToolchain({
      ...good(),
      name: "s",
      sysroot: "/opt/wasi-sysroot",
      readFile: async (p) => {
        seen.push(p);
        return "x";
      },
    });
    const m = await mountSysroot("s");
    expect(await m.readFile("/../etc/passwd")).toBeNull();
    expect(await m.readFile("/usr/../../etc/passwd")).toBeNull();
    expect(await m.readFile("..")).toBeNull();
    // The accessor is never consulted for escaping paths.
    expect(seen).toEqual([]);
  });

  test("string sysroot: accessor throwing becomes a null miss", async () => {
    registerToolchain({
      ...good(),
      name: "s",
      sysroot: "/opt/wasi-sysroot",
      readFile: async () => {
        throw new Error("disk on fire");
      },
    });
    const m = await mountSysroot("s");
    expect(await m.readFile("/a.h")).toBeNull();
  });

  test("string sysroot without a readFile accessor throws a clear error", async () => {
    registerToolchain({ ...good(), name: "s", sysroot: "/opt/wasi-sysroot" });
    await expect(mountSysroot("s")).rejects.toThrow(ToolchainError);
    await expect(mountSysroot("s")).rejects.toThrow(/readFile.*accessor/);
  });

  test("string sysroot: no stat/listDir (host cannot be enumerated)", async () => {
    registerToolchain({
      ...good(),
      name: "s",
      sysroot: "/opt/wasi-sysroot",
      readFile: async () => null,
    });
    const m = await mountSysroot("s");
    expect(m.stat).toBeUndefined();
    expect(m.listDir).toBeUndefined();
  });

  test("absent sysroot: empty mount, readFile always null", async () => {
    registerToolchain(good());
    const m = await mountSysroot("t");
    expect(m.readonly).toBe(true);
    expect(await m.readFile("/a.h")).toBeNull();
  });

  test("mount is frozen: read-only is enforced, not documented", async () => {
    registerToolchain({
      ...good(),
      name: "m",
      sysroot: { "/a.h": "x" },
    });
    const m = await mountSysroot("m");
    expect(Object.isFrozen(m)).toBe(true);
    expect(() => {
      m.readFile = async () => new Uint8Array([9]);
    }).toThrow();
    expect(() => {
      m.writeFile = async () => {};
    }).toThrow();
  });
});

describe("mountSysrootIntoSeed with string sysroots", () => {
  test("registers the lazy mount: prefix returned, nothing copied", () => {
    const tc = {
      ...good(),
      name: "s",
      sysroot: "/opt/wasi-sysroot",
      readFile: async () => null,
    };
    registerToolchain(tc);
    const seed = {};
    const prefix = mountSysrootIntoSeed(tc, seed);
    expect(prefix).toBe(`${SYSROOT_MOUNT_PREFIX}/s`);
    // Lazy: the seed gains no file entries — nothing is pre-copied.
    expect(Object.keys(seed)).toEqual([]);
    expect(isSysrootMounted("s", seed)).toBe(true);
  });

  test("string-sysroot mount is idempotent per seed", () => {
    const tc = {
      ...good(),
      name: "s",
      sysroot: "/opt/wasi-sysroot",
      readFile: async () => null,
    };
    registerToolchain(tc);
    const seed = {};
    const p1 = mountSysrootIntoSeed(tc, seed);
    const p2 = mountSysrootIntoSeed(tc, seed);
    expect(p1).toBe(p2);
    expect(Object.keys(seed)).toEqual([]);
  });

  test("lazy mount serves reads after seed registration", async () => {
    const tc = {
      ...good(),
      name: "s",
      sysroot: "/opt/wasi-sysroot",
      readFile: async (p) =>
        p === "/opt/wasi-sysroot/usr/include/stdio.h" ? "/* stdio */\n" : null,
    };
    registerToolchain(tc);
    mountSysrootIntoSeed(tc, {});
    const m = await mountSysroot("s");
    expect(dec(await m.readFile("/usr/include/stdio.h"))).toBe("/* stdio */\n");
  });
});
