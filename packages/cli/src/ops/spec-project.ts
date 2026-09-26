import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// what a bun:test spec needs for editor typing: bun resolves `bun:test` itself, but tsserver needs @types/bun in scope
// and a tsconfig, or it roots the project at the editor's workspace folder and never looks in this node_modules.
const SPEC_TYPES_PACKAGE = "@types/bun";

const SPEC_TSCONFIG = {
    compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
    },
};

export type SpecTypesInstall = "present" | "installed" | "skipped" | "failed";

function writeJsonIfChanged(path: string, value: unknown): void {
    const text = JSON.stringify(value, null, 2) + "\n";
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
        writeFileSync(path, text);
    }
}

// The generated SDK bundles its own crypto, so the only dependency is the editor's; ESM is what bun:test expects.
export function ensureSpecProject(root: string): void {
    const pkgPath = join(root, "package.json");
    const pkg: any = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : { name: basename(root), private: true };
    pkg.type ??= "module";
    pkg.devDependencies ??= {};
    pkg.devDependencies[SPEC_TYPES_PACKAGE] ??= "latest";
    writeJsonIfChanged(pkgPath, pkg);

    const tsconfigPath = join(root, "tsconfig.json");
    if (!existsSync(tsconfigPath)) {
        writeJsonIfChanged(tsconfigPath, SPEC_TSCONFIG);
    }
}

// best effort: the spec runs without it, so an offline or bun-less machine only loses editor typing.
export async function installSpecTypes(root: string): Promise<SpecTypesInstall> {
    if (existsSync(join(root, "node_modules", ...SPEC_TYPES_PACKAGE.split("/")))) {
        return "present";
    }
    if (process.env.QINIT_NO_UPDATE || !Bun.which("bun")) {
        return "skipped";
    }

    try {
        const install = Bun.spawn(["bun", "install", "--silent"], { cwd: root, stdout: "ignore", stderr: "ignore", timeout: 120_000 });
        return (await install.exited) === 0 ? "installed" : "failed";
    } catch {
        return "failed";
    }
}
