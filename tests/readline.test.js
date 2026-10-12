import {
  jest,
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { createInterface, Interface, Readline } from "../src/readline.js";
import { Readable, Writable } from "../src/stream.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function lineReadable(lines) {
  const r = new Readable({ read() {} });
  for (const l of lines) r.push(l + "\n");
  r.push(null);
  return r;
}

function nullWritable() {
  return new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
}

// ─── createInterface / Interface ──────────────────────────────────────────────
describe("readline (callback version)", () => {
  describe("createInterface()", () => {
    test("returns an Interface instance", () => {
      const rl = createInterface({
        input: lineReadable([]),
        output: nullWritable(),
      });
      expect(rl).toBeInstanceOf(Interface);
      rl.close();
    });
  });

  describe("Interface", () => {
    let rl;

    afterEach(() => {
      rl?.close();
    });

    // ── 'line' event ─────────────────────────────────────────────────────────
    test("emits 'line' event for each line", (done) => {
      rl = createInterface({ input: lineReadable(["foo", "bar", "baz"]) });

      const lines = [];
      rl.on("line", (l) => lines.push(l));

      rl.on("close", () => {
        expect(lines).toEqual(["foo", "bar", "baz"]);
        done();
      });
    });

    test("strips trailing newline", (done) => {
      const r = new Readable({ read() {} });
      r.push("hello\nworld\n");
      r.push(null);

      rl = createInterface({ input: r });

      const lines = [];
      rl.on("line", (l) => lines.push(l));

      rl.on("close", () => {
        expect(lines).toEqual(["hello", "world"]);
        done();
      });
    });

    test("handles EOF without newline", (done) => {
      const r = new Readable({ read() {} });
      r.push("no newline");
      r.push(null);

      rl = createInterface({ input: r });

      const lines = [];
      rl.on("line", (l) => lines.push(l));

      rl.on("close", () => {
        expect(lines).toContain("no newline");
        done();
      });
    });

    // ── close ────────────────────────────────────────────────────────────────
    test("emits 'close' after input ends", (done) => {
      rl = createInterface({ input: lineReadable(["x"]) });
      rl.on("close", () => done());
    });

    test("close() emits close event", (done) => {
      rl = createInterface({ input: lineReadable([]) });
      rl.on("close", () => done());
      rl.close();
    });

    // ── question() (callback version) ────────────────────────────────────────
    test("question() invokes callback with answer", (done) => {
      rl = createInterface({ input: lineReadable(["my answer"]) });

      rl.question("Prompt: ", (answer) => {
        expect(answer).toBe("my answer");
        done();
      });
    });

    test("question() writes prompt to output", (done) => {
      const chunks = [];
      const out = new Writable({
        write(c, _e, cb) {
          chunks.push(c.toString());
          cb();
        },
      });

      rl = createInterface({ input: lineReadable(["yes"]), output: out });

      rl.question("Continue? ", () => {
        expect(chunks.join("")).toContain("Continue?");
        done();
      });
    });

    // ── pause / resume ───────────────────────────────────────────────────────
    test("pause() and resume() do not throw", () => {
      rl = createInterface({ input: lineReadable([]) });
      expect(() => {
        rl.pause();
        rl.resume();
      }).not.toThrow();
    });

    test("pause() emits 'pause' event", (done) => {
      rl = createInterface({ input: lineReadable([]) });
      rl.on("pause", () => done());
      rl.pause();
    });

    test("resume() emits 'resume' event", (done) => {
      rl = createInterface({ input: lineReadable([]) });
      rl.pause();
      rl.on("resume", () => done());
      rl.resume();
    });

    // ── prompt ───────────────────────────────────────────────────────────────
    test("setPrompt() / getPrompt()", () => {
      rl = createInterface({ input: lineReadable([]) });
      rl.setPrompt("> ");
      expect(rl.getPrompt()).toBe("> ");
    });

    // ── properties ───────────────────────────────────────────────────────────
    test("terminal is false when no output", () => {
      rl = createInterface({ input: lineReadable([]) });
      expect(rl.terminal).toBe(false);
    });

    test("line is string", () => {
      rl = createInterface({ input: lineReadable([]) });
      expect(typeof rl.line).toBe("string");
    });

    test("cursor is undefined for non-terminal input (Node parity)", () => {
      // Real Node only sets `cursor` in terminal mode; for a plain pipe
      // input it stays undefined. (Verified against node v24.20.0.)
      rl = createInterface({ input: lineReadable([]) });
      expect(rl.cursor).toBeUndefined();
    });
  });

  // ── Readline export (Node: Readline === Interface) ──────────────────────────
  // In real Node.js, `require('readline').Readline` is the Interface
  // constructor itself — there is no separate chainable "controller" class
  // (the promises variant's Readline is an output-stream controller with a
  // different constructor). These tests assert the genuine Node surface.
  describe("Readline", () => {
    test("Readline is the Interface constructor", () => {
      expect(Readline).toBe(Interface);
    });

    test("new Readline(options) creates a working Interface", () => {
      const rl = new Readline({ input: lineReadable([]) });
      expect(rl).toBeInstanceOf(Interface);
      expect(typeof rl.question).toBe("function");
      rl.close();
      expect(rl.closed).toBe(true);
    });

    test("Readline callable without new (factory)", () => {
      const rl = Readline({ input: lineReadable([]) });
      expect(rl).toBeInstanceOf(Interface);
      rl.close();
    });
  });
});
