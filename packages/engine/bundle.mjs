// Bundle browser-safe engine code and Node/Bun server entries.
// Keep @qubic-lib external and alias @qinit/core to its browser entry.
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

// The qubic-cli TCP bridge — Node/Bun (uses Bun.listen), like the HTTP server entry.
const peer = await Bun.build({
  ...base,
  entrypoints: ["src/peer-server.ts"],
  target: "node",
  external: [...base.external, "bun"],
});

const failed = [main, server, peer].filter((result) => !result.success);
if (failed.length > 0) {
  for (const result of failed) {
    for (const log of result.logs) {
      console.error(log);
    }
  }
  process.exit(1);
}

console.log("built dist/index.js + dist/server.js + dist/peer.js");
