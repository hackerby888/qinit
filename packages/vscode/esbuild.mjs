// Bundle workspace TypeScript into the extension host.
import { build, context } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

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
