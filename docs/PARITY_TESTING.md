# Parity Testing Guide

How we verify Node.js compatibility, and how to triage failures.

## Overview

We use three complementary approaches:

1. **Official Node.js test suite** (`parity/`): Vendored from Node, run against our shims via `parity/run.mjs`
2. **Live oracle** (`tests/oracle-export-surface.test.js`): Compares our shims against real `node:*` at test time
3. **Real-world libraries** (`tests/real-world-libs.test.js`): Popular npm packages through the shim layer

## Running Parity Tests

```bash
# Single module
node parity/run.mjs buffer

# All modules (slow)
node parity/run.mjs

# Oracle (fast, 16 modules)
npx jest tests/oracle-export-surface.test.js

# Scoreboard
node scripts/generate-scoreboard.mjs
```

## Failure Classification (Deno-style)

We adopt Deno's three-bucket triage from their [node-compat skill](https://github.com/denoland/deno/blob/HEAD/.claude/skills/node-compat/SKILL.md):

| Category | Meaning | Action |
|----------|---------|--------|
| `fixable` | Bug in our implementation | Fix the shim |
| `inherent` | Architectural limitation | Document why, don't fix |
| `wontfix` | Not worth fixing | Document why, move on |

### Rules

1. **Every expected failure MUST have a `reason`.** The runner warns on missing reasons.
2. **Reasons must be specific.** "Not supported" is rejected. Explain *why* it's not supported and *what* the limitation is.
3. **When a fix lands**, remove the entry from `expected-failures.shim.json`. The runner reports "NEWLY PASSING".

### Example

```json
{
  "test-buffer-inspect.js": {
    "reason": "Test sets shim buffer.INSPECT_MAX_BYTES but uses global Buffer (Node native) for the value. In the browser sandbox, global Buffer IS the shim, so this works. Harness limitation: cannot replace Node global Buffer.",
    "category": "inherent"
  }
}
```

## Common Inherent Limitations

### Global Object Mismatch

In the parity harness (Node), `global.Buffer` is Node's native. Our shim provides its own `Buffer`. Tests that mix `require("buffer")` (shim) with global `Buffer` (native) fail.

**In the browser**: There is no native `Buffer`, so our shim IS the global. These tests would pass.

**Classification**: `inherent` — harness limitation, not a product bug.

### Timer Global Patching

`als-browser` patches `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask` for AsyncLocalStorage context propagation. Node's test/common leak detector flags these as "unexpected globals".

**Classification**: `inherent` — intended shim behavior, test framework false positive.

### Parent-Frame Delegation

`child_process`, `dgram`, and other modules delegate to the parent frame via `window.postMessage`. The Node harness has no `window`.

**In the browser**: The host implements the protocol.

**Classification**: `inherent` — harness lacks browser APIs.

## Scoreboard

Generate a Cloudflare-style compat matrix:

```bash
node scripts/generate-scoreboard.mjs --output parity/SCOREBOARD.md
```

The scoreboard shows per-module pass rates from the expected-failures data. Per AGENTS.md rule 10, this matrix is **generated, never hand-written**.

## Adding New Tests

1. Write the test in `tests/` (Jest) or add to `parity/` (Node suite)
2. Run it: `node parity/run.mjs <module>`
3. If it fails, classify using the three buckets above
4. Add to `expected-failures.shim.json` with reason and category
5. The next run should show "No new failures. Parity steady. ✔"
