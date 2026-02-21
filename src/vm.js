// -------------------------------------------------------------------------
// Browser / bundler shim
// -------------------------------------------------------------------------

const globalObject =
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof global !== "undefined"
    ? global
    : typeof window !== "undefined"
    ? window
    : {};

// -------------------------------------------------------------------------
// Context
// -------------------------------------------------------------------------

class Context {}

export function isContext(ctx) {
  return ctx instanceof Context;
}

export function createContext(sandbox) {
  const copy = new Context();
  if (sandbox && typeof sandbox === "object") {
    Object.keys(sandbox).forEach((k) => {
      copy[k] = sandbox[k];
    });
  }
  return copy;
}

// -------------------------------------------------------------------------
// Proxy sandbox
// -------------------------------------------------------------------------

function makeProxy(context) {
  if (typeof Proxy === "undefined") return context; // IE fallback

  return new Proxy(context, {
    // Always claim ownership of every key so `with` routes all identifier
    // lookups through our get/set traps instead of escaping to outer scope.
    has(_target, key) {
      return key !== "__magic__";
    },
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      return key in target ? target[key] : globalObject[key];
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    }
  });
}

// -------------------------------------------------------------------------
// Runner factory
//
// The code is embedded as a JSON string literal inside the Function source so
// that `eval(...)` is a *direct* eval — sharing the lexical `with` scope.
// A direct eval is required for `var` declarations to be routed through the
// proxy and land on the context object. Passing eval or code as parameters
// would make it an indirect eval (global scope), breaking sandbox behaviour.
// -------------------------------------------------------------------------

function makeRunner(code) {
  const fnBody = `with (__proxy__) { return eval(${JSON.stringify(code)}); }`;
  // eslint-disable-next-line no-new-func
  return new Function("__proxy__", fnBody);
}

// -------------------------------------------------------------------------
// Script
// -------------------------------------------------------------------------

export class Script {
  constructor(code, options) {
    if (typeof options === "string") options = { filename: options };
    this.code = code;
    this.filename = options?.filename ?? "evalmachine.<anonymous>";
    this._runner = makeRunner(code);
  }

  runInContext(context, _options) {
    if (!(context instanceof Context)) {
      throw new TypeError("needs a 'context' argument.");
    }
    return this._runner(makeProxy(context));
  }

  runInThisContext(_options) {
    // eslint-disable-next-line no-eval
    return eval(this.code);
  }

  runInNewContext(sandbox, options) {
    const ctx = createContext(sandbox);
    const res = this.runInContext(ctx, options);
    // Write new/mutated properties back to the original sandbox.
    if (sandbox && typeof sandbox === "object") {
      Object.keys(ctx).forEach((k) => {
        sandbox[k] = ctx[k];
      });
    }
    return res;
  }
}

// -------------------------------------------------------------------------
// Module-level convenience functions
// -------------------------------------------------------------------------

export function runInContext(code, context, options) {
  return new Script(code, options).runInContext(context, options);
}

export function runInThisContext(code, options) {
  return new Script(code, options).runInThisContext(options);
}

export function runInNewContext(code, sandbox, options) {
  return new Script(code, options).runInNewContext(sandbox, options);
}

export function createScript(code, options) {
  return new Script(code, options);
}

export default {
  Script,
  createContext,
  createScript,
  isContext,
  runInContext,
  runInNewContext,
  runInThisContext
};
