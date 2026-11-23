// version-gate — build-time TARGET_NODE gate (workerd-style).
//
// One source tree, two builds. The shims implement the NEWEST Node
// (26) by default; behaviour that changed between Node 24.20.0 and
// Node 26.13.1 is selected by TARGET_NODE. See src/version-table.js
// for the full per-change table (gated / pending / expected-failure).
//
// How the target is resolved (in order):
//   1. Build-time bake: esbuild `define: { __TARGET_NODE__: '"26"' }`
//      in src/build-vfs.mjs replaces the free identifier below with the
//      string literal, so dist builds carry the target as a constant
//      (the env branch is dead code there and is eliminated by minify).
//      Build with TARGET_NODE=24 for the v24 build; default is 26.
//      An unrecognised build-time value fails the build, never silently
//      defaults.
//   2. Harness override: under the parity harness src/ runs directly on
//      a Node host, so __TARGET_NODE__ is undefined and the gate reads
//      process.env.PARITY_TARGET_NODE (set per run, e.g. by the sweep
//      or a direct invocation). This is a MEASUREMENT mechanism only —
//      it is not a product surface: dist never reads it (see 1), and
//      there is no runtime version switcher (AGENTS.md rule 11).
//   3. Default: '26'.
// An unrecognised env value throws at import time: a typo'd target
// must never silently measure as 26.
//
// Rule 7 ("no silent fakes"): a gated branch is real code in source,
// reviewed and tested against the matching Node suite — the opposite
// of a silent fake. A build always reports the Node version it was
// built for, never a newer one.
//
// ponytail: the gate is a string constant + one env read; the ceiling
// is a third target value (Node 27 at LTS, Oct 2027) with a third arm
// only where 27 differs. Upgrade path: when the 24 build is dropped,
// delete the '24' arms and this module's env branch, keeping the
// define as the single source of truth.
const bakedTarget =
  typeof __TARGET_NODE__ !== "undefined" ? __TARGET_NODE__ : undefined;

function resolveTargetNode() {
  if (bakedTarget !== undefined) return bakedTarget;
  const envTarget =
    typeof process !== "undefined" &&
    process !== null &&
    process.env &&
    typeof process.env.PARITY_TARGET_NODE === "string"
      ? process.env.PARITY_TARGET_NODE
      : undefined;
  if (envTarget !== undefined) {
    if (envTarget !== "24" && envTarget !== "26") {
      throw new Error(
        `PARITY_TARGET_NODE must be '24' or '26', got ${JSON.stringify(envTarget)}`,
      );
    }
    return envTarget;
  }
  return "26";
}

export const TARGET_NODE = resolveTargetNode();

/** True when this build targets Node 24.20.0 behaviour. */
export const isTarget24 = TARGET_NODE === "24";

/** True when this build targets Node 26.13.1 behaviour (the default). */
export const isTarget26 = TARGET_NODE === "26";
