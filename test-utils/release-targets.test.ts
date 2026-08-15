// The release matrix and the installers agree on file names by convention only — the installers build an
// asset name from uname output, and the matrix builds one from a bun target triple. A mismatch is invisible
// until a user's download 404s, so the two are compared here rather than at release time.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RELEASE_TARGETS, hostBinaryName, releaseBinaryPath } from "../scripts/release/targets";

const root = resolve(import.meta.dir, "..");
const binaryName = (target: string) => releaseBinaryPath(target).replace("dist/", "");

test("every shipping target maps to its documented asset name", () => {
    expect(RELEASE_TARGETS.map(binaryName)).toEqual([
        "qinit-linux-x64",
        "qinit-linux-arm64",
        "qinit-darwin-arm64",
        "qinit-darwin-x64",
        "qinit-windows-x64.exe",
    ]);
});

test("only the Windows target carries the .exe suffix", () => {
    const exeTargets = RELEASE_TARGETS.filter((target) => binaryName(target).endsWith(".exe"));

    expect(exeTargets).toEqual(["bun-windows-x64"]);
});

// install.sh composes "qinit-$os-$arch" from uname; every pair it accepts has to be a target we build.
test("install.sh can name a binary for every OS and arch it accepts", () => {
    const script = readFileSync(resolve(root, "install.sh"), "utf8");
    const operatingSystems = ["linux", "darwin"];
    const architectures = ["x64", "arm64"];

    for (const operatingSystem of operatingSystems) {
        expect(script).toContain(`) o=${operatingSystem} ;;`);
    }
    for (const architecture of architectures) {
        expect(script).toContain(`) a=${architecture} ;;`);
    }
    expect(script).toContain('asset="qinit-$o-$a"');

    const built = new Set(RELEASE_TARGETS.map(binaryName));
    for (const operatingSystem of operatingSystems) {
        for (const architecture of architectures) {
            expect(built).toContain(`qinit-${operatingSystem}-${architecture}`);
        }
    }
});

test("install.ps1 asks for the Windows binary the matrix produces", () => {
    const script = readFileSync(resolve(root, "install.ps1"), "utf8");

    expect(script).toContain('$asset = "qinit-windows-$assetArch.exe"');
    expect(script).toContain('$assetArch = "x64"');
    expect(new Set(RELEASE_TARGETS.map(binaryName))).toContain("qinit-windows-x64.exe");
});

// The release workflow runs this exact path after build:all, and build:bin writes the host name.
test("the release workflow and the host build agree on their file names", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("./dist/qinit-linux-x64 smoke");
    expect(hostBinaryName("linux")).toBe("qinit");
    expect(hostBinaryName("darwin")).toBe("qinit");
    expect(hostBinaryName("win32")).toBe("qinit.exe");
});
