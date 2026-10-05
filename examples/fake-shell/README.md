# Demo-only fake shell

**Not a product feature.** See repo `AGENTS.md` rule 11. This is a teaching
tool: it shows what `npm install` does with a package's `bin` field, then
routes the bin script through the runtime's `node`.

## Sample

```js
import { CodeSandbox } from "../../runtime.js";
import { createFakeShell } from "./fake-shell.js";

const sandbox = new CodeSandbox({ fs: /* your memfs volume */ });
await sandbox.init();

const shell = createFakeShell({ fs: sandboxFs, execute: (code) => sandbox.execute(code) });

// Fake `npm install cowsay`: reads pkg.bin, lays files into /node_modules/cowsay/
await shell.install(
  { name: "cowsay", version: "1.0.0", bin: "./bin/cowsay.js" },
  { "bin/cowsay.js": 'console.log("moo " + process.argv.slice(2).join(" "));' },
);

console.log(shell.list()); // ["cowsay"]

// Runs `node /node_modules/cowsay/bin/cowsay.js hello` inside the sandbox
await shell.exec("cowsay", ["hello"]); // → "moo hello"
```

Object-form `bin` (`{ lint: "./lint.js", fmt: "./fmt.js" }`) registers one
command per entry. Unknown commands throw `command not found`.
