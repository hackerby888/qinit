// Build @qinit/compile to dist/ with Bun's bundler. Browser+Node safe.
// @qinit/core is aliased to its node-free browser entry.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const coreBrowser = resolve(import.meta.dir, "../core/src/browser.ts");

// The browser entry embeds the generated QPI header snapshot — refuse to build without it rather
// than let the bundler fail on an unresolvable import.
const snapshotModule = resolve(import.meta.dir, "src/generated/qpi-snapshot.ts");
if (!existsSync(snapshotModule)) {
  console.error("missing tracked browser snapshot — restore src/generated/qpi-snapshot.ts from the Qinit checkout");
  process.exit(1);
}

const aliasCoreBrowser = {
  name: "alias-qinit-core-browser",
  setup(build) {
    build.onResolve({ filter: /^@qinit\/core$/ }, () => ({ path: coreBrowser }));
  },
};

const result = await Bun.build({
  entrypoints: ["src/index.ts", "src/browser.ts"],
  outdir: "dist",
  format: "esm",
  target: "browser",
  plugins: [aliasCoreBrowser],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("built dist/index.js + dist/browser.js");
