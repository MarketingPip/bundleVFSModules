# Framework integrations

Copy-based host setup so apps using Vite or Next.js serve the bundleVFSModules
runtime with **zero manual wiring**. Add the plugin, run the dev server or
build — the runtime assets (`runtime.js` + `dist/` shim bundles) land in the
host's static directory automatically.

## What gets copied

| File | Purpose |
|------|---------|
| `<assetDir>/runtime.js` | The host runtime (`CodeSandbox`) — generated from `src/runtime/*` by `src/build-runtime.mjs` |
| `<assetDir>/dist/*.js` | The Node builtin shim bundles, loaded on demand |
| `<assetDir>/ui.html` | Optional playground page (`includePlayground: true`) |

The copy is **idempotent** (safe to run on every build/dev start) and the
Vite plugin wipes the plugin-owned directory first, so deleted repo files
can't linger as stale copies.

## Vite

```js
// vite.config.js
import { bundleVFSModules } from "my-vfs/src/integrations/vite.js";

export default {
  plugins: [bundleVFSModules()],
};
```

Options:

| Option | Default | Description |
|--------|---------|-------------|
| `assetDir` | `"bvm"` | Subdirectory under Vite's `publicDir` |
| `publicPath` | `"/bvm"` | URL prefix the browser uses to load the assets |
| `includePlayground` | `false` | Also copy `ui.html` |
| `interception` | `false` | Reserved for the future opt-in browser-interception plugin; `true` throws |

Behavior:
- `configResolved` + `buildStart`: copies assets into `<publicDir>/<assetDir>`,
  so `vite build` emits them and `vite dev` serves them.
- Dev mode: a watcher on the repo's `runtime.js`/`dist/` re-copies on change,
  so edits are live without restarting the dev server.
- `vite preview` serves the copied assets like any other static file.
- `plugin.assetBase` exposes the normalized public path for host apps that
  construct asset URLs programmatically.

Example host usage:

```html
<script type="module">
  import { CodeSandbox } from "/bvm/runtime.js";
  const sandbox = new CodeSandbox({ /* ... */ });
</script>
```

## Next.js

```js
// next.config.js
import { withBundleVFSModules } from "my-vfs/src/integrations/next.js";

export default withBundleVFSModules(
  {
    // ... your Next.js config
  },
  { assetDir: "bvm" },
);
```

Options: same `assetDir` / `publicPath` / `includePlayground` as Vite
(no `interception` option — the same loud-error rule applies to the
future plugin).

Behavior:
- Copies at **config-evaluation time** (primary trigger): Next loads
  `next.config.js` at startup for both `next dev` and `next build`, so
  assets are in `public/<assetDir>` before the first compilation.
- The `webpack` hook is kept as a safety net on Next ≤ 15.
- **Next 16+ (Turbopack default):** a `webpack` key is a hard build error
  under Turbopack, so the wrapper detects the installed Next major and
  omits its hook on ≥ 16. The eager config-eval copy is the trigger there.
- Pages router and app router both serve `public/` statically — no
  router-specific code needed.
- Asset introspection uses `Symbol.for` keys (`BVM_ASSET_BASE`,
  `BVM_ASSET_DIR`, exported from `next.js`) because plain string keys —
  even non-enumerable ones — trigger Next 16's "Unrecognized key(s)"
  config warning.

Example host usage (app router):

```jsx
// app/page.js
export default function Page() {
  return (
    <script type="module" src="/bvm/runtime.js" />
  );
}
```

## Shared helper

`src/integrations/assets.js` exposes the pieces for custom setups:

- `copyRuntimeAssets(destDir, { includePlayground })` — absolute `destDir`
  required; throws on missing `runtime.js`/`dist/`.
- `assetPublicBase(publicPath)` — normalizes `"/bvm/"` → `"/bvm"`;
  throws unless the path starts with `/`.

## What these integrations do NOT do

Browser-interception (the Vite 7 browser work) is a separate opt-in
plugin, not core and not part of these integrations. These plugins only
serve runtime assets. See `docs/COMPETITOR_TECHNIQUES.md` (Nodepod
`src/integrations/vite.ts`, `next.ts` — techniques only; Nodepod is
MIT + Commons Clause, so no Nodepod code is used here).
