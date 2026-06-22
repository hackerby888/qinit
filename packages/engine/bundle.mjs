// Build @qinit/engine to dist/ with Bun's bundler. Two entries: the main one is browser+Node safe (no
// node:fs / Bun), the server one is Node/Bun. `@qinit/core` is aliased to its node-free browser entry so the
// main bundle never pulls node:fs; `@qinit/proto` is bundled from source; `@qubic-lib` stays external (the
// consumer installs it — it's a pure-wasm runtime dep). Types are emitted separately by `tsc` (see build script).
import { resolve } from "node:path";

const coreBrowser = resolve(import.meta.dir, "../core/src/browser.ts");

const aliasCoreBrowser = {
  name: "alias-qinit-core-browser",
  setup(build) {
    build.onResolve({ filter: /^@qinit\/core$/ }, () => ({ path: coreBrowser }));
  },
};

const base = {
  outdir: "dist",
  format: "esm",
  external: ["@qubic-lib/qubic-ts-library"],
  plugins: [aliasCoreBrowser],
};

const main = await Bun.build({
  ...base,
  entrypoints: ["src/index.ts"],
  target: "browser",
});

const server = await Bun.build({
  ...base,
  entrypoints: ["src/server.ts"],
  target: "node",
  external: [...base.external, "bun"],
});

const failed = [main, server].filter((r) => !r.success);
if (failed.length > 0) {
  for (const r of failed) {
    for (const log of r.logs) {
      console.error(log);
    }
  }
  process.exit(1);
}

console.log("built dist/index.js + dist/server.js");
