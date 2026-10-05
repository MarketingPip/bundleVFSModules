// ============================================================================
// DEMO ONLY — fake shell for developers learning the library.
//
// This is NOT a product feature (see repo AGENTS.md rule 11: no shell, no
// package manager as product). It exists so a learner can see what "npm
// install" would do: read each package's `bin` field, then route the bin
// script through the runtime's `node` (here: `sandbox.execute()`).
//
// It is intentionally NOT imported by runtime.js or any src/ module —
// `tests/demo-fake-shell.test.js` pins that. Copy it into your own demo
// page; never ship it as part of the library.
// ============================================================================

/**
 * Read a package descriptor's `bin` field the way npm does:
 * - string → a single command named after the package
 * - object → { commandName: scriptPath } as-is
 * - missing → no commands
 *
 * @param {{ name: string, bin?: string | Record<string, string> }} pkg
 * @returns {Record<string, string>} command name → bin script path
 */
export function resolveBinCommands(pkg) {
  const bin = pkg.bin;
  if (!bin) return {};
  if (typeof bin === "string") return { [pkg.name]: bin };
  return { ...bin };
}

/**
 * Create a demo fake shell bound to a sandbox.
 *
 * @param {object} deps
 * @param {object} deps.fs - memfs-like volume: mkdirSync/writeFileSync/readFileSync
 * @param {(code: string) => Promise<unknown>} deps.execute - runs code through
 *   the runtime's node (e.g. `sandbox.execute.bind(sandbox)`)
 */
export function createFakeShell({ fs, execute }) {
  // command name → { pkg, path } ; path is the VFS path of the bin script
  const commands = new Map();

  return {
    /**
     * Fake `npm install <pkg>`: lay the package files into
     * `/node_modules/<name>/` and register its bin commands.
     *
     * @param {{ name: string, version: string, bin?: string | Record<string,string> }} pkg
     * @param {Record<string, string>} files - relative path → source, e.g.
     *   `{ "bin/cli.js": "console.log('hi')" }`
     * @returns {Promise<string[]>} registered command names
     */
    async install(pkg, files) {
      const dir = `/node_modules/${pkg.name}`;
      for (const [rel, src] of Object.entries(files)) {
        // ponytail: normalize "./x" and "x" the same way npm does
        const clean = rel.replace(/^\.\//, "");
        const p = `${dir}/${clean}`;
        fs.mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
        fs.writeFileSync(p, src);
      }
      for (const [name, binPath] of Object.entries(resolveBinCommands(pkg))) {
        commands.set(name, {
          pkg: pkg.name,
          path: `${dir}/${binPath.replace(/^\.\//, "")}`,
        });
      }
      return [...commands.keys()];
    },

    /** Names of installed commands. */
    list() {
      return [...commands.keys()];
    },

    /**
     * Run an installed command: read its bin script from the VFS and execute
     * it through the runtime's node with `process.argv` set the way a real
     * `node <bin-script> <args...>` invocation would.
     *
     * @param {string} name - command name
     * @param {string[]} [args] - argv after the script path
     */
    async exec(name, args = []) {
      const cmd = commands.get(name);
      if (!cmd) throw new Error(`fake-shell: command not found: ${name}`);
      const src = fs.readFileSync(cmd.path, "utf8");
      const argv = JSON.stringify(["node", cmd.path, ...args]);
      return execute(`process.argv = ${argv};\n${src}`);
    },
  };
}
