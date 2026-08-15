import { expect, test } from "bun:test";
import { runSelfUpdate, type SelfUpdateDeps } from "../../src/ops/update";

const tag = "qinit-cli-v1.2.3";
const release = {
    asset: "https://example.invalid/qinit-linux-x64",
    sums: "https://example.invalid/SHA256SUMS",
    name: "qinit-linux-x64",
};
const checksum = "a".repeat(64);

function selfUpdateDeps(overrides: Partial<SelfUpdateDeps> = {}): Partial<SelfUpdateDeps> {
    return {
        executablePath: "/opt/qinit",
        platform: "linux",
        currentVersion: "1.0.0",
        resolveCliTag: async () => tag,
        cliReleaseUrls: () => release,
        fetchCliSha: async () => checksum,
        downloadVerifiedAsset: async (_asset, onProgress) => {
            onProgress?.(1, 2);
            return new Uint8Array([1, 2, 3]);
        },
        writeFileSync: () => {},
        chmodSync: () => {},
        renameSync: () => {},
        unlinkSync: () => {},
        ...overrides,
    };
}

test("self-update skips network and files when running through Bun or Node", async () => {
    for (const executablePath of ["/usr/bin/bun", "/usr/bin/node.exe"]) {
        let resolved = false;
        const result = await runSelfUpdate(
            {},
            selfUpdateDeps({
                executablePath,
                resolveCliTag: async () => {
                    resolved = true;
                    return tag;
                },
            }),
        );

        expect(result).toEqual({ phase: "development" });
        expect(resolved).toBe(false);
    }
});

test("self-update dry-run reports the release without downloading it", async () => {
    let downloaded = false;
    let written = false;
    const result = await runSelfUpdate(
        { dryRun: true },
        selfUpdateDeps({
            downloadVerifiedAsset: async () => {
                downloaded = true;
                return new Uint8Array();
            },
            writeFileSync: () => {
                written = true;
            },
        }),
    );

    expect(result).toEqual({
        phase: "dry-run",
        tag,
        asset: release.asset,
        currentVersion: "1.0.0",
        version: "1.2.3",
    });
    expect(downloaded).toBe(false);
    expect(written).toBe(false);
});

test("self-update skips the current version unless forced", async () => {
    let downloads = 0;
    const deps = selfUpdateDeps({
        currentVersion: "1.2.3",
        downloadVerifiedAsset: async () => {
            downloads++;
            return new Uint8Array([1]);
        },
    });

    expect(await runSelfUpdate({}, deps)).toEqual({
        phase: "up-to-date",
        version: "1.2.3",
    });
    expect(downloads).toBe(0);

    expect(await runSelfUpdate({ force: true }, deps)).toEqual({
        phase: "updated",
        previousVersion: "1.2.3",
        version: "1.2.3",
    });
    expect(downloads).toBe(1);
});

test("self-update verifies and atomically replaces a Unix executable", async () => {
    const calls: string[] = [];
    const progress: Array<[number, number]> = [];
    let downloadedAsset: { url: string; sha256: string } | undefined;

    const result = await runSelfUpdate(
        { onProgress: (received, total) => progress.push([received, total]) },
        selfUpdateDeps({
            fetchCliSha: async (url, name) => {
                calls.push(`checksum:${url}:${name}`);
                return checksum;
            },
            downloadVerifiedAsset: async (asset, onProgress) => {
                downloadedAsset = asset;
                onProgress?.(3, 4);
                return new Uint8Array([7, 8]);
            },
            writeFileSync: (path) => {
                calls.push(`write:${path}`);
            },
            chmodSync: (path, mode) => {
                calls.push(`chmod:${path}:${mode}`);
            },
            renameSync: (from, to) => {
                calls.push(`rename:${from}:${to}`);
            },
        }),
    );

    expect(result).toEqual({
        phase: "updated",
        previousVersion: "1.0.0",
        version: "1.2.3",
    });
    expect(downloadedAsset).toEqual({ url: release.asset, sha256: checksum });
    expect(progress).toEqual([[3, 4]]);
    expect(calls).toEqual([
        `checksum:${release.sums}:${release.name}`,
        "write:/opt/qinit.new",
        `chmod:/opt/qinit.new:${0o755}`,
        "rename:/opt/qinit.new:/opt/qinit",
    ]);
});

test("self-update replaces a Windows executable through an old file", async () => {
    const calls: string[] = [];

    await runSelfUpdate(
        {},
        selfUpdateDeps({
            executablePath: "C:\\qinit\\qinit.exe",
            platform: "win32",
            writeFileSync: (path) => {
                calls.push(`write:${path}`);
            },
            chmodSync: () => {
                throw new Error("chmod must not run on Windows");
            },
            renameSync: (from, to) => {
                calls.push(`rename:${from}:${to}`);
            },
            unlinkSync: (path) => {
                calls.push(`unlink:${path}`);
            },
        }),
    );

    expect(calls).toEqual([
        "write:C:\\qinit\\qinit.exe.new",
        "unlink:C:\\qinit\\qinit.exe.old",
        "rename:C:\\qinit\\qinit.exe:C:\\qinit\\qinit.exe.old",
        "rename:C:\\qinit\\qinit.exe.new:C:\\qinit\\qinit.exe",
    ]);
});

test("self-update removes the temporary file after a Unix rename failure", async () => {
    const unlinked: string[] = [];
    const error = Object.assign(new Error("denied"), { code: "EACCES" });

    await expect(
        runSelfUpdate(
            {},
            selfUpdateDeps({
                renameSync: () => {
                    throw error;
                },
                unlinkSync: (path) => {
                    unlinked.push(String(path));
                },
            }),
        ),
    ).rejects.toThrow("could not replace /opt/qinit (EACCES) — bin dir not writable; " + "re-run install.sh or use sudo");
    expect(unlinked).toEqual(["/opt/qinit.new"]);
});

test("self-update removes partial staging files after write or chmod failures", async () => {
    for (const operation of ["write", "chmod"] as const) {
        const unlinked: string[] = [];
        const error = Object.assign(new Error(`${operation} failed`), {
            code: "EACCES",
        });

        await expect(
            runSelfUpdate(
                {},
                selfUpdateDeps({
                    writeFileSync: () => {
                        if (operation === "write") {
                            throw error;
                        }
                    },
                    chmodSync: () => {
                        if (operation === "chmod") {
                            throw error;
                        }
                    },
                    unlinkSync: (path) => {
                        unlinked.push(String(path));
                    },
                }),
            ),
        ).rejects.toThrow(operation === "write" ? "write failed" : "could not replace /opt/qinit (EACCES)");
        expect(unlinked).toEqual(["/opt/qinit.new"]);
    }
});

test("self-update restores a Windows executable when the swap fails", async () => {
    const calls: string[] = [];
    let renames = 0;
    const executablePath = "C:\\qinit\\qinit.exe";

    await expect(
        runSelfUpdate(
            {},
            selfUpdateDeps({
                executablePath,
                platform: "win32",
                renameSync: (from, to) => {
                    calls.push(`rename:${from}:${to}`);
                    renames++;
                    if (renames === 2) {
                        throw Object.assign(new Error("locked"), { code: "EPERM" });
                    }
                },
                unlinkSync: (path) => {
                    calls.push(`unlink:${path}`);
                },
            }),
        ),
    ).rejects.toThrow(`could not replace ${executablePath} (EPERM) — ` + "close other qinit processes or re-run install.ps1");
    expect(calls).toEqual([
        "unlink:C:\\qinit\\qinit.exe.old",
        "rename:C:\\qinit\\qinit.exe:C:\\qinit\\qinit.exe.old",
        "rename:C:\\qinit\\qinit.exe.new:C:\\qinit\\qinit.exe",
        "rename:C:\\qinit\\qinit.exe.old:C:\\qinit\\qinit.exe",
        "unlink:C:\\qinit\\qinit.exe.new",
    ]);
});

test("self-update does not restore a stale Windows backup when the first rename fails", async () => {
    const calls: string[] = [];
    const executablePath = "C:\\qinit\\qinit.exe";

    await expect(
        runSelfUpdate(
            {},
            selfUpdateDeps({
                executablePath,
                platform: "win32",
                renameSync: (from, to) => {
                    calls.push(`rename:${from}:${to}`);
                    throw Object.assign(new Error("locked"), { code: "EPERM" });
                },
                unlinkSync: (path) => {
                    calls.push(`unlink:${path}`);
                },
            }),
        ),
    ).rejects.toThrow(`could not replace ${executablePath} (EPERM)`);
    expect(calls).toEqual(["unlink:C:\\qinit\\qinit.exe.old", "rename:C:\\qinit\\qinit.exe:C:\\qinit\\qinit.exe.old", "unlink:C:\\qinit\\qinit.exe.new"]);
});

test("self-update rejects an invalid release pointer", async () => {
    await expect(runSelfUpdate({}, selfUpdateDeps({ resolveCliTag: async () => null }))).rejects.toThrow(
        "latest.txt does not contain a valid qinit-cli release tag",
    );
});
