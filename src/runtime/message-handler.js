// Iframe stdin keypress parser (Worker F extraction, branch modular/host).
//
// Source: runtime.js lines 4979-5002 (`_parseKey`), copied with ONE
// deliberate adaptation (see below) plus the added `export` keyword.
//
// ORIGIN — iframe-side code: defined INSIDE the `_getState` interop template
// literal (runtime.js:4635-5005). Called by the iframe bootstrap's stdin
// `_dispatch` (template lines ~4770/~4777) to turn raw keypress chunks into
// `{ name, ctrl, meta, shift, sequence }` descriptors.
//
// TEMPLATE ESCAPE LAYER — WHY THE SOURCE DIFFERS BY ONE CHARACTER CLASS:
// In runtime.js the specials keys are written with DOUBLE backslashes
// (e.g. `'\\x1b[A'`) because the source sits as literal text inside the host
// template literal, whose engine collapses `\\` -> `\` at parse time — so the
// iframe receives `'\x1b[A'` (real ESC). A module is NOT inside that template,
// so the escapes here are SINGLE backslashes: this is the only spelling that
// preserves the function's runtime contract (real keypress in -> key name
// out) both when imported directly AND when integrated via verbatim
// interpolation `${_parseKey.toString()}` into the bootstrap template
// (interpolated values are inserted verbatim — no escape processing — so the
// iframe then parses `'\x1b[A'` exactly as it does today). A byte-verbatim
// copy would silently break ESC-sequence recognition in both uses; this was
// verified empirically (see tests). Pure function: no dependencies.

export function _parseKey(s) {
  const specials = {
    "\x1b[A": "up",
    "\x1b[B": "down",
    "\x1b[C": "right",
    "\x1b[D": "left",
    "\x1b[H": "home",
    "\x1b[F": "end",
    "\x1b[3~": "delete",
    "\x1b[2~": "insert",
    "\x1b[5~": "pageup",
    "\x1b[6~": "pagedown",
    "\x1b": "escape",
    "\r": "return",
    "\n": "return",
    "\t": "tab",
    "\x7f": "backspace",
    "\b": "backspace",
  };

  if (specials[s]) {
    return {
      name: specials[s],
      ctrl: false,
      meta: false,
      shift: false,
      sequence: s,
    };
  }

  if (s.length === 1) {
    const code = s.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      return {
        name: String.fromCharCode(code + 96),
        ctrl: true,
        meta: false,
        shift: false,
        sequence: s,
      };
    }
    return {
      name: s.toLowerCase(),
      ctrl: false,
      meta: false,
      shift: s !== s.toLowerCase(),
      sequence: s,
    };
  }

  return {
    name: "unknown",
    ctrl: false,
    meta: false,
    shift: false,
    sequence: s,
  };
}
