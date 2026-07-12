// Bundle the extension for the VS Code (Node) host. The @qinit/* packages are TypeScript SOURCE
// (no dist/), so esbuild transpiles + inlines them; the shipped .js has zero @qinit/* runtime deps.
import { build, context } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)); // package dir, so this runs from any CWD

const opts = {
  entryPoints: [join(root, "src/extension.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: join(root, "dist/extension.js"),
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("esbuild: watching…");
} else {
  await build(opts);
}
