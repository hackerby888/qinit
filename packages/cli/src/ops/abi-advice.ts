// The CLI compiles, runs and stamps a deploy with its own wasm ABI, while a contract's imports follow the core headers. When the two
// disagree, this says which side is the one to move.
import { loadManifest, readCurrent, WASM_ABI_VERSION } from "@qinit/core";
import { loadWasmAbiSource } from "@qinit/core/wasm/abi-node";
import { cachedReleaseRef } from "./node";
import { runSelfUpdate, runsFromSource } from "./update";

export type AbiSide = "cli" | "headers" | "both" | "skew";
export type Freshness = "latest" | "stale" | "unknown";

export interface AbiAdviceInput {
    cliAbi: number;
    headersAbi: number;
    cli: Freshness;
    headers: Freshness;
    // A CLI run from source has no release to update to, and headers outside the managed cache are a checkout the user owns.
    cliFromSource: boolean;
    headersPath: string;
    headersManaged: boolean;
}

export interface AbiAdvice {
    side: AbiSide;
    detail: string;
    fix: string;
}

const UPDATE_CLI = "qinit update";
const UPDATE_HEADERS = "qinit setup --force";

function sideToMove(input: AbiAdviceInput): AbiSide {
    if (input.cli === "latest" && input.headers === "latest") {
        return "skew";
    }
    if (input.cli === "stale" && input.headers === "stale") {
        return "both";
    }
    // A side already at its newest release cannot move, so the other one has to.
    if (input.cli === "latest") {
        return "headers";
    }
    if (input.headers === "latest") {
        return "cli";
    }
    // Nothing certain is known about either release, so the lower ABI is taken to be the side left behind.
    return input.headersAbi < input.cliAbi ? "headers" : "cli";
}

export function abiAdvice(input: AbiAdviceInput): AbiAdvice {
    const side = sideToMove(input);
    const detail = `cli speaks wasm ABI ${input.cliAbi}, core headers ABI ${input.headersAbi}`;
    const cliFix = input.cliFromSource ? "pull Qinit and run `bun run generate:core-abi`" : UPDATE_CLI;
    const headersFix = input.headersManaged
        ? UPDATE_HEADERS
        : `core checkout at ${input.headersPath} is ABI ${input.headersAbi}, CLI expects ${input.cliAbi} — check out a matching core, or unset QINIT_CORE and run \`${UPDATE_HEADERS}\``;

    switch (side) {
        case "cli":
            return { side, detail: `${detail} — the CLI is behind`, fix: cliFix };
        case "headers":
            return { side, detail: `${detail} — the headers are behind`, fix: headersFix };
        case "both":
            return { side, detail: `${detail} — both are behind their latest release`, fix: `${cliFix}, then ${headersFix}` };
        case "skew": {
            const ahead = input.headersAbi > input.cliAbi ? "headers" : "CLI";
            return {
                side,
                detail: `${detail} — both are the latest release, and the ${ahead} release is ahead`,
                fix: "no update fixes this; report the release skew",
            };
        }
    }
}

export interface AbiCheckDeps {
    cliAbi: number;
    readHeadersAbi: (coreDir: string) => number | null;
    managedHeaders: () => { path?: string; version?: string };
    cliFromSource: () => boolean;
    latestCli: () => Promise<{ current: string; latest: string } | null>;
    latestHeadersVersion: () => Promise<string>;
    updatesDisabled: () => boolean;
    lookupTimeoutMs: number;
}

const defaultDeps: AbiCheckDeps = {
    cliAbi: WASM_ABI_VERSION,
    // Headers without ABI metadata give no verdict: an empty or partial core directory is somebody else's error to report.
    readHeadersAbi: (coreDir) => {
        try {
            return loadWasmAbiSource(coreDir).abiVersion;
        } catch {
            return null;
        }
    },
    managedHeaders: () => {
        const current = readCurrent();
        return { path: current?.coreHeaders, version: cachedReleaseRef(current?.headersVersion) };
    },
    cliFromSource: () => runsFromSource(process.execPath),
    latestCli: async () => {
        const result = await runSelfUpdate({ dryRun: true });
        return result.phase === "dry-run" ? { current: result.currentVersion, latest: result.version } : null;
    },
    latestHeadersVersion: async () => (await loadManifest("latest")).version,
    updatesDisabled: () => Boolean(process.env.QINIT_NO_UPDATE),
    lookupTimeoutMs: 3000,
};

// A slow or failed lookup must not hold up a build, so it degrades to "unknown" and the ABI numbers decide alone.
async function within<T>(lookup: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(undefined), timeoutMs);
    });

    try {
        return await Promise.race([lookup.catch(() => undefined), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/** Null when the CLI and the headers agree, or the headers carry no ABI to compare. The network is touched only on a mismatch. */
export async function checkHeadersAbi(coreDir: string, injected: Partial<AbiCheckDeps> = {}): Promise<AbiAdvice | null> {
    const deps = { ...defaultDeps, ...injected };
    const headersAbi = deps.readHeadersAbi(coreDir);
    if (headersAbi === null || headersAbi === deps.cliAbi) {
        return null;
    }

    const managed = deps.managedHeaders();
    const headersManaged = managed.path !== undefined && managed.path === coreDir;
    const cliFromSource = deps.cliFromSource();
    const lookupsAllowed = !deps.updatesDisabled();
    const [cliRelease, headersLatest] = await Promise.all([
        lookupsAllowed && !cliFromSource ? within(deps.latestCli(), deps.lookupTimeoutMs) : undefined,
        lookupsAllowed && headersManaged && managed.version ? within(deps.latestHeadersVersion(), deps.lookupTimeoutMs) : undefined,
    ]);

    const cli: Freshness = cliRelease ? (cliRelease.current === cliRelease.latest ? "latest" : "stale") : "unknown";
    const headers: Freshness = headersLatest ? (headersLatest === managed.version ? "latest" : "stale") : "unknown";

    return abiAdvice({
        cliAbi: deps.cliAbi,
        headersAbi,
        cli,
        headers,
        cliFromSource,
        headersPath: coreDir,
        headersManaged,
    });
}

export const abiAdviceText = (advice: AbiAdvice): string => `${advice.detail}. Fix: ${advice.fix}`;
