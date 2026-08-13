import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { buildSnapshot } from "@qinit/build";

const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        "core-dir": { type: "string" },
        out: { type: "string" },
    },
    strict: true,
});

if (!values["core-dir"] || !values.out) {
    throw new Error("usage: build-core-headers --core-dir <checkout> --out <directory>");
}

const core = resolve(values["core-dir"]);
const output = resolve(values.out);
if (!existsSync(join(core, "src", "qpi", "qpi.h"))) {
    throw new Error(`not a core-lite checkout: ${core}`);
}

mkdirSync(output, { recursive: true });
const snapshot = await buildSnapshot(core, output);
const archive = join(output, "core-headers.tar.gz");
const tar = Bun.spawnSync(["tar", "czf", archive, "-C", snapshot.root, "."], {
    stdout: "inherit",
    stderr: "inherit",
});
if (tar.exitCode !== 0) {
    throw new Error("failed to create core-headers.tar.gz");
}

const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(join(output, "core-headers.sha256"), `${sha256}\n`);
console.log(`snapshot: ${archive} (${snapshot.fileCount} files, sha256 ${sha256})`);
