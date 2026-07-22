// Cross-compile standalone binaries for all shipping targets.
export {}; // module marker so top-level await is allowed (file uses Bun globals, no imports)
const targets = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-windows-x64",
];

for (const target of targets) {
  const suffix = target.replace("bun-", "");
  const output = `dist/qinit-${suffix}${target.includes("windows") ? ".exe" : ""}`;
  console.log(`building ${output} …`);
  const child = Bun.spawn(
    [
      "bun",
      "build",
      "packages/cli/src/index.tsx",
      "--compile",
      "--minify",
      `--target=${target}`,
      "--outfile",
      output,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  await child.exited;
  if (child.exitCode !== 0) {
    process.exit(child.exitCode ?? 1);
  }
}
console.log("matrix build done");
