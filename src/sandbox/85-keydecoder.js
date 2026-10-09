// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// Interop exposes hoisted before the sync builtin preload: the preload
// does ~49 sequential loadModule interop calls and can exceed the
// execution timeout; these handlers must be available immediately.
globalThis.__INTEROP_VAR__.expose("__stdin__", (args) => {
  const s = process?.stdin;
  const hasListeners =
    s && (s.listenerCount("data") > 0 || s.listenerCount("keypress") > 0);

  if (
    s &&
    hasListeners &&
    (typeof s.isPaused !== "function" || !s.isPaused())
  ) {
    return s.pushData(args);
  }

  // process.stdin.pushData(args)
  if (
    process &&
    process.stdin &&
    process.stdin.listenerCount("data") != 0 &&
    (typeof process.stdin.isPaused !== "function" ||
      process.stdin.isPaused() == false)
  ) {
    return process.stdin.pushData(args);
  }

  // --- Key Decoder Function ---
  function decodeKeyPress(str) {
    if (!str) return null;

    // ANSI Escape sequences for arrow keys
    if (str === "\x1b[A" || str === "\x1bOA")
      return { name: "up", sequence: str };
    if (str === "\x1b[B" || str === "\x1bOB")
      return { name: "down", sequence: str };
    if (str === "\x1b[C" || str === "\x1bOC")
      return { name: "right", sequence: str };
    if (str === "\x1b[D" || str === "\x1bOD")
      return { name: "left", sequence: str };

    // Enter / Return keys
    if (str === "\r" || str === "\n") return { name: "return", sequence: str };

    // Backspace
    if (str === "\x7f" || str === "\b")
      return { name: "backspace", sequence: str };

    // Handle single characters & Ctrl combinations
    if (str.length === 1) {
      const code = str.charCodeAt(0);
      // Check for Ctrl+A through Ctrl+Z (ASCII codes 1 to 26)
      if (code >= 1 && code <= 26) {
        return {
          name: String.fromCharCode(code + 96),
          ctrl: true,
          sequence: str,
        };
      }
      return { name: str, sequence: str };
    }

    // Fallback for complex/unrecognized sequences
    return { name: "unknown", sequence: str };
  }

  function stripKeySequencesPreserveWhitespace(str) {
    if (!str) return "";

    return (
      str
        // Remove ANSI escape sequences (arrow keys, function keys, CSI sequences)
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
        .replace(/\x1b[\(\)][0-9A-Za-z]/g, "")
        // Remove control characters except \n (\x0A) and \t (\x09)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    );
  }
  // TODO: handle if buffered pass or possible remove if emulating node?
  // Buffer early input instead of silently dropping it: if the sandbox
  // hasn't attached a stdin listener yet (race between __stdin__ and
  // user code), queue the input and flush on first 'data' listener.
  if (s && !hasListeners) {
    s._pendingStdin = s._pendingStdin || [];
    s._pendingStdin.push(args);
    return;
  }
  try {
    const cleanedCode = stripKeySequencesPreserveWhitespace(args);

    const keyEvent = decodeKeyPress(args);
    if (keyEvent) {
      // emitMe("key_event", null, keyEvent)
      return;
    }

    if (!cleanedCode) {
      return;
    }
    const E = window.eval(cleanedCode);
    console.log(E);
  } catch (E) {
    return void console.error(E.message);
  }
});

// Runtime method (not reported via execution:interop_registered).
// Updates the sandbox TTY dimensions and emits Node's 'resize' event on
// stdout/stderr so readline and guest 'resize' listeners react.
globalThis.__INTEROP_VAR__.expose("__terminal_resize__", (args) => {
  const cols = Math.floor(Number(args && args.cols));
  const rows = Math.floor(Number(args && args.rows));
  if (
    !Number.isFinite(cols) ||
    cols <= 0 ||
    !Number.isFinite(rows) ||
    rows <= 0
  ) {
    throw new Error(
      "__terminal_resize__ requires positive integer cols and rows",
    );
  }
  for (const s of [process.stdout, process.stderr]) {
    if (!s) continue;
    s.columns = cols;
    s.rows = rows;
    if (typeof s.emit === "function") s.emit("resize");
  }
  return { cols, rows };
});
