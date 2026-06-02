// Cross-compile standalone binaries for all shipping targets.
const targets = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-windows-x64",
];

for (const t of targets) {
  const suffix = t.replace("bun-", "");
  const out = `dist/qinit-${suffix}${t.includes("windows") ? ".exe" : ""}`;
  console.log(`building ${out} …`);
  const p = Bun.spawn(
    ["bun", "build", "packages/cli/src/index.tsx", "--compile", "--minify",
     `--target=${t}`, "--outfile", out],
    { stdout: "inherit", stderr: "inherit" },
  );
  await p.exited;
  if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
}
console.log("matrix build done");
