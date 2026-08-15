// Build standalone Qinit binaries for all shipping targets.
import { RELEASE_TARGETS, releaseBinaryPath } from "./targets";

for (const target of RELEASE_TARGETS) {
    const output = releaseBinaryPath(target);
    console.log(`building ${output} …`);
    const child = Bun.spawn(["bun", "build", "packages/cli/src/index.tsx", "--compile", "--minify", `--target=${target}`, "--outfile", output], {
        stdout: "inherit",
        stderr: "inherit",
    });
    await child.exited;
    if (child.exitCode !== 0) {
        process.exit(child.exitCode ?? 1);
    }
}
console.log("matrix build done");
