// Build @qinit/proto to dist/ for Node consumers (the `import` export condition; Bun/vite use the TS source
// directly). @qinit/core is aliased to its node-free browser entry and bundled in (proto only uses core's
// codec/identity/rpc surface, all of which browser.ts exports); @qubic-lib stays external (a runtime dep the
// consumer installs). Types are emitted separately by tsc (see the build script).
import { resolve } from "node:path";

const coreBrowser = resolve(import.meta.dir, "../core/src/browser.ts");

const aliasCoreBrowser = {
  name: "alias-qinit-core-browser",
  setup(build) {
    build.onResolve({ filter: /^@qinit\/core$/ }, () => ({ path: coreBrowser }));
  },
};

const r = await Bun.build({
  entrypoints: ["src/index.ts", "src/qpi-layout.ts"],
  outdir: "dist",
  format: "esm",
  target: "node",
  external: ["@qubic-lib/qubic-ts-library"],
  plugins: [aliasCoreBrowser],
});

if (!r.success) {
  for (const log of r.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("built dist/index.js + dist/qpi-layout.js");
