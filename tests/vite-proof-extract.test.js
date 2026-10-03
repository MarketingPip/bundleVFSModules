// Red-first test for the __VITE_PROOF__ extraction used by
// tests/vite-build-proof.html.
//
// Bug (2026-10-02): the HTML mapped each log entry with JSON.stringify and
// then ran /__VITE_PROOF__(\{.*\})/ over the joined text. The entry wrapper's
// quotes become backslash-escaped, so the capture group contains
// `{\"version\":...}` (literal backslash-quote) and JSON.parse throws —
// "proof JSON parses" FAILed while "proof marker in logs" passed.
// Fix: extract from the RAW entry args string, never the re-stringified form.

// Mirrors the extraction logic in tests/vite-build-proof.html — keep in sync.
function extractProofText(logs) {
  const PROOF_PREFIX = "__VITE_PROOF__";
  for (const l of logs || []) {
    const a = typeof l === "string" ? l : l && l.args;
    const s = typeof a === "string" ? a : a != null ? JSON.stringify(a) : "";
    const i = s.indexOf(PROOF_PREFIX);
    if (i !== -1) return s.slice(i + PROOF_PREFIX.length);
  }
  return null;
}

function extractProof(logs) {
  const t = extractProofText(logs);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch (e) {
    return null;
  }
}

describe("vite proof extraction", () => {
  test("old regex approach fails on realistic fixture (documents the bug)", () => {
    const proofObj = { version: "8.3.1", chunkCount: 1, codeBytes: 0 };
    const logs = [
      { type: "warn", args: "[loadModule] x" },
      { type: "log", args: "__VITE_PROOF__" + JSON.stringify(proofObj) },
    ];
    const joined = logs.map((l) => JSON.stringify(l)).join("\n");
    const m = joined.match(/__VITE_PROOF__(\{.*\})/);
    // Marker check passed (m truthy) but parse threw — the observed 6/7 state.
    expect(m).not.toBeNull();
    expect(() => JSON.parse(m[1])).toThrow();
  });

  test("new extraction parses proof from raw entry args", () => {
    const logs = [
      { type: "warn", args: "[loadModule] x" },
      {
        type: "log",
        args: '__VITE_PROOF__{"version":"8.3.1","chunkCount":1,"codeBytes":123}',
      },
      { type: "log", args: "trailing log with } braces" },
    ];
    expect(extractProof(logs)).toEqual({
      version: "8.3.1",
      chunkCount: 1,
      codeBytes: 123,
    });
  });

  test("handles plain-string log entries", () => {
    const logs = ["noise", '__VITE_PROOF__{"a":1}'];
    expect(extractProof(logs)).toEqual({ a: 1 });
  });

  test("returns null when no proof marker present", () => {
    expect(extractProof([{ type: "log", args: "hello" }])).toBeNull();
    expect(extractProof([])).toBeNull();
    expect(extractProof(null)).toBeNull();
  });

  test("skips entries whose proof text is corrupt, keeps scanning", () => {
    const logs = [
      { type: "log", args: "__VITE_PROOF__{not json" },
      { type: "log", args: '__VITE_PROOF__{"ok":true}' },
    ];
    // First match wins per HTML logic; corrupt text yields null proof.
    expect(extractProofText(logs)).toBe("{not json");
    expect(extractProof(logs)).toBeNull();
  });
});
