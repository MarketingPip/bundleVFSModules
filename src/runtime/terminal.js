// import {table} from "https://esm.sh/gh/MarketingPip/bundleVFSModules@main/src/cli_table.js"

/**
 * toNodeKeypress - Helper for developers wiring up custom DOM input elements.
 *
 * Converts DOM keydown/paste events on an HTML element into Node.js-style
 * (sequence, key) callbacks, matching the shape of process.stdin 'keypress'
 * events. Useful when building custom input UIs (e.g. terminal emulators).
 *
 * @param {HTMLElement} element - The DOM element to attach listeners to
 * @param {Function} callback - Called as callback(sequence, key) where key
 *   is { name, ctrl, meta, shift, sequence }
 * @returns {{ stop: Function }} - Call .stop() to remove listeners
 *
 * @example
 *   toNodeKeypress(inputElement, (sequence, key) => {
 *     console.log('Key:', key.name, 'Ctrl:', key.ctrl);
 *   });
 */
export function toNodeKeypress(element, callback) {
  if (!element || typeof callback !== "function") {
    throw new Error("Element and callback function are required");
  }
  const autoComplete = element?.autocomplete;
  const keyMap = {
    ArrowUp: "\x1b[A",
    ArrowDown: "\x1b[B",
    ArrowRight: "\x1b[C",
    ArrowLeft: "\x1b[D",
    Enter: "\n",
    Backspace: "\x7f",
    Tab: "\t",
    Escape: "\x1b",
    Delete: "\x1b[3~",
    Home: "\x1b[H",
    End: "\x1b[F",
    PageUp: "\x1b[5~",
    PageDown: "\x1b[6~",
    Insert: "\x1b[2~",
  };
  element.autocomplete = "off";
  element.addEventListener("keydown", (e) => {
    // Determine sequence: mapped special key or literal
    let sequence = keyMap[e.key] || (e.key.length === 1 ? e.key : "");

    // If Ctrl + key, adjust for Node-style control characters
    if (e.ctrlKey && sequence.length === 1) {
      const charCode = sequence.toUpperCase().charCodeAt(0) - 64;
      if (charCode > 0 && charCode < 32)
        sequence = String.fromCharCode(charCode);
    }

    const key = {
      name: e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase(),
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      shift: e.shiftKey,
      sequence,
    };

    if (sequence) callback(sequence, key);

    //    e.preventDefault();

    if (key.name === "enter" && key.sequence === "\n") {
      element.value = "";
    }
  });

  element.addEventListener("paste", (e) => {
    const pastedText = e.clipboardData.getData("text");
    if (pastedText) {
      for (const ch of pastedText) {
        callback(ch, {
          name: ch,
          ctrl: false,
          meta: false,
          shift: false,
          sequence: ch,
        });
      }
    }
    //e.preventDefault();
  });

  return {
    stop: () => {
      element.autocomplete = autoComplete;
      element.replaceWith(element.cloneNode(true)); // removes listeners
    },
  };
}

/**
 * Consolidated ANSI stripper and console interceptor
 */
export const stripAnsi = (string) => {
  if (typeof string !== "string") return string;

  // Fast path: ANSI codes require ESC (7-bit) or CSI (8-bit) introducer
  if (!string.includes("\u001B") && !string.includes("\u009B")) {
    return string;
  }

  // Regex pattern for OSC (hyperlinks) and CSI (colors/styles)
  const pattern = [
    "(?:\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\|\\u009C))", // OSC
    "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]", // CSI
  ].join("|");

  return string.replace(new RegExp(pattern, "g"), "");
};

export function mergeProcess(user = {}, defaults = {}) {
  return Object.keys(defaults).reduce((acc, key) => {
    const userVal = user[key];
    const defaultVal = defaults[key];

    if (userVal === undefined) {
      // take default if user didn't provide
      acc[key] = defaultVal;
    } else if (Array.isArray(userVal)) {
      // arrays are overridden, not merged
      acc[key] = userVal;
    } else if (
      typeof userVal === "object" &&
      userVal !== null &&
      typeof defaultVal === "object"
    ) {
      // deep merge objects
      acc[key] = mergeProcess(userVal, defaultVal);
    } else {
      // primitives: use user value
      acc[key] = userVal;
    }

    return acc;
  }, {});
}
