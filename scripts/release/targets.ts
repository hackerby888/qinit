// The shipping targets and the file name each one produces. Kept apart from the build scripts so the
// naming rule can be asserted without cross-compiling the matrix.
export const RELEASE_TARGETS = ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-arm64", "bun-darwin-x64", "bun-windows-x64"] as const;

export function releaseBinaryPath(target: string): string {
    return `dist/qinit-${target.replace("bun-", "")}${target.includes("windows") ? ".exe" : ""}`;
}

export function hostBinaryName(platform: string): string {
    return platform === "win32" ? "qinit.exe" : "qinit";
}
