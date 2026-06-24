// Build @qinit/core's node-safe surface to dist/ for the `import` export condition. The entry is browser.ts
// (identity, tx signing, rpc/net, K12 via an ESM crypto import) — it deliberately excludes the index's
// node-only/Bun bits (fetch.ts downloader, project.ts, backtrace.ts) and the `require()`-based K12 path. Bun
// and the CLI keep using the full src/index.ts via the `bun` condition. @qubic-lib stays external.
const r = await Bun.build({
  entrypoints: ["src/browser.ts"],
  outdir: "dist",
  format: "esm",
  target: "node",
  external: ["@qubic-lib/qubic-ts-library"],
});

if (!r.success) {
  for (const log of r.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("built dist/browser.js");
