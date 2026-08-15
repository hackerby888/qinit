import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { hostBinaryName } from "./targets";

const output = resolve("dist", hostBinaryName(process.platform));
mkdirSync(resolve("dist"), { recursive: true });

const build = Bun.spawnSync([process.execPath, "build", "packages/cli/src/index.tsx", "--compile", "--minify", "--outfile", output], {
    stdout: "inherit",
    stderr: "inherit",
});

if (build.exitCode !== 0) {
    process.exit(build.exitCode);
}

console.log(output);
