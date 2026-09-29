// tests/vite7-fs-url.test.js — fs path validation must accept file: URL objects.
// Vite's dist chunks call readFileSync(new URL(...)) (e.g. to read package.json
// for the version). Node.js fs accepts URL objects; the shim must too.
import fs from "../src/fs.js";

const R = "/test-root-url";

beforeEach(() => {
  try {
    fs.rmSync(R, { recursive: true, force: true });
  } catch {}
  fs.mkdirSync(R, { recursive: true });
});

describe("fs URL path support (vite7 M3)", () => {
  test("readFileSync accepts file: URL object", () => {
    fs.writeFileSync(`${R}/a.txt`, "hello url");
    const url = new URL(`file://${R}/a.txt`);
    expect(fs.readFileSync(url, "utf8")).toBe("hello url");
  });

  test("writeFileSync accepts file: URL object", () => {
    const url = new URL(`file://${R}/b.txt`);
    fs.writeFileSync(url, "written via url");
    expect(fs.readFileSync(`${R}/b.txt`, "utf8")).toBe("written via url");
  });

  test("existsSync accepts file: URL object", () => {
    fs.writeFileSync(`${R}/c.txt`, "x");
    const url = new URL(`file://${R}/c.txt`);
    expect(fs.existsSync(url)).toBe(true);
  });

  test("non-file: URL throws ERR_INVALID_URL_SCHEME", () => {
    const url = new URL("data:text/plain,hello");
    try {
      fs.readFileSync(url);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.code).toBe("ERR_INVALID_URL_SCHEME");
    }
  });
});
