import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { existsSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
    autoUpdateVerifyTool,
    fetchWasiSdk,
    loadManifest,
    managedWasiSdkStatus,
    readCurrent,
    updateCurrent,
    wasiSdkPaths,
    type CurrentPointer,
    type Manifest,
} from "@qinit/core";
import { ensureNodeBinary, fetchNodeBinary, nodeAssetForPlatform } from "../../ops/node";
import { prepareNodeRunCore } from "../../ops/node-core";
import { output, type CommandArguments } from "../../args";
import { Header, StepRow, type StepState, theme } from "../../ui";

export const SETUP_STEPS = [
    { key: "headers", label: "core headers" },
    { key: "node", label: "node binary" },
    { key: "wasi", label: "WASI SDK" },
    { key: "verifier", label: "verifier" },
] as const;

export type SetupStepKey = (typeof SETUP_STEPS)[number]["key"];

export interface SetupEvent {
    step: SetupStepKey;
    state: StepState;
    detail?: string;
    pct?: number;
    elapsedMs?: number;
}

export interface SetupUpdate {
    key: "core" | "wasi";
    label: string;
    current: string;
    available: string;
}

export interface SetupRunOptions {
    force?: boolean;
    onUpdates?: (updates: readonly SetupUpdate[]) => void;
    confirmUpdates?: (updates: readonly SetupUpdate[]) => Promise<boolean>;
}

function configuredVerifyTool(): string | null {
    const override = process.env.QINIT_VERIFY?.trim();
    if (override && existsSync(override)) {
        return override;
    }
    return Bun.which("contractverify");
}

function configuredWasiSdk(): string | null {
    const clang = process.env.WASM_CLANG?.trim();
    const sysroot = process.env.WASI_SYSROOT?.trim();
    if (!clang && !sysroot) {
        return null;
    }
    const sdk = wasiSdkPaths();
    if (!sdk || (clang && sysroot)) {
        return sdk?.root ?? null;
    }
    const managedRoot = managedWasiSdkStatus().currentRoot;
    const configuredPath = clang ?? sysroot;
    if (!managedRoot || !configuredPath) {
        return null;
    }
    const pathFromManagedRoot = relative(resolve(managedRoot), resolve(configuredPath));
    const usesManagedCache = pathFromManagedRoot === "" || (!pathFromManagedRoot.startsWith("..") && !isAbsolute(pathFromManagedRoot));
    return usesManagedCache ? sdk.root : null;
}

const defaultDeps = {
    loadManifest,
    prepareNodeRunCore,
    nodeAssetForPlatform,
    fetchNodeBinary,
    ensureNodeBinary,
    readCurrent,
    updateCurrent,
    existsSync,
    wasiSdkPaths,
    managedWasiSdkStatus,
    fetchWasiSdk,
    configuredWasiSdk,
    configuredVerifyTool,
    autoUpdateVerifyTool,
    updatesDisabled: () => Boolean(process.env.QINIT_NO_UPDATE),
};

export type SetupDeps = typeof defaultDeps;

type Progress = (received: number, total: number) => void;

function coreCurrentLabel(current: CurrentPointer | null, headersReady: boolean, nodeReady: boolean): string {
    const headersVersion = current?.headersVersion ?? "unknown";
    const nodeVersion = current?.nodeVersion ?? "unknown";
    if (headersReady && nodeReady && headersVersion === nodeVersion) {
        return headersVersion;
    }
    return [`headers ${headersReady ? headersVersion : "missing"}`, `node ${nodeReady ? nodeVersion : "missing"}`].join(" · ");
}

async function runStep(step: SetupStepKey, operation: (onProgress: Progress) => Promise<string>, emit: (event: SetupEvent) => void): Promise<void> {
    const startedAt = Date.now();
    emit({ step, state: "active", pct: 0 });

    const onProgress: Progress = (received, total) => {
        emit({
            step,
            state: "active",
            pct: total > 0 ? received / total : undefined,
            detail: total > 0 ? undefined : `${Math.floor(received / 1_000_000)} MB downloaded`,
        });
    };

    try {
        const detail = await operation(onProgress);
        emit({
            step,
            state: "ok",
            detail,
            elapsedMs: Date.now() - startedAt,
        });
    } catch (error) {
        emit({
            step,
            state: "fail",
            detail: error instanceof Error ? error.message : String(error),
            elapsedMs: Date.now() - startedAt,
        });
        throw error;
    }
}

export async function runSetup(emit: (event: SetupEvent) => void = () => {}, injected: Partial<SetupDeps> = {}, options: SetupRunOptions = {}): Promise<void> {
    const deps = { ...defaultDeps, ...injected };
    const manifestStartedAt = Date.now();
    emit({ step: "headers", state: "active", detail: "checking", pct: 0 });
    let manifest: Manifest;
    try {
        manifest = await deps.loadManifest("latest");
        emit({ step: "headers", state: "pending" });
    } catch (error) {
        emit({
            step: "headers",
            state: "fail",
            detail: error instanceof Error ? error.message : String(error),
            elapsedMs: Date.now() - manifestStartedAt,
        });
        throw error;
    }
    const current = deps.readCurrent();
    const headersReady = Boolean(current?.coreHeaders && deps.existsSync(current.coreHeaders));
    const nodeReady = Boolean(current?.node && deps.existsSync(current.node));
    const nodePublished = Boolean(deps.nodeAssetForPlatform(manifest));
    const coreUpdateAvailable = Boolean(
        nodePublished
            ? (headersReady && current?.headersVersion !== manifest.version) || (nodeReady && current?.nodeVersion !== manifest.version)
            : !nodeReady && headersReady && current?.headersVersion !== manifest.version,
    );
    const configuredSdk = deps.configuredWasiSdk();
    const managedSdk = configuredSdk ? undefined : deps.managedWasiSdkStatus();
    const updates: SetupUpdate[] = [];

    if (coreUpdateAvailable) {
        updates.push({
            key: "core",
            label: nodePublished ? "core release" : "core headers",
            current: coreCurrentLabel(current, headersReady, nodeReady),
            available: manifest.version,
        });
    }
    if (managedSdk?.updateAvailable) {
        updates.push({
            key: "wasi",
            label: "WASI SDK",
            current: basename(managedSdk.currentRoot!),
            available: basename(managedSdk.expectedRoot),
        });
    }

    options.onUpdates?.(updates);
    const installUpdates = updates.length > 0 && (options.force || (await options.confirmUpdates?.(updates)) === true);
    const updateCore = coreUpdateAvailable && installUpdates;
    const updateWasi = Boolean(managedSdk?.updateAvailable && installUpdates);
    const installLatestCore = updateCore || (!headersReady && !nodeReady);
    let preparedCore: Awaited<ReturnType<typeof prepareNodeRunCore>>;

    await runStep(
        "headers",
        async (onProgress) => {
            preparedCore = await deps.prepareNodeRunCore(
                {
                    ref: installLatestCore ? "latest" : undefined,
                    updateCurrent: false,
                },
                false,
                installLatestCore ? { loadManifest: async () => manifest } : {},
                onProgress,
            );
            return preparedCore.detail;
        },
        emit,
    );

    await runStep(
        "node",
        async (onProgress) => {
            if (!nodePublished && !nodeReady) {
                deps.updateCurrent({
                    headersVersion: preparedCore.version,
                    coreHeaders: preparedCore.coreHeaders,
                });
                return "skipped — not published yet";
            }
            if (installLatestCore) {
                if (!nodePublished) {
                    deps.updateCurrent({
                        headersVersion: preparedCore.version,
                        coreHeaders: preparedCore.coreHeaders,
                    });
                    return "skipped — not published yet";
                }
                const node = await deps.fetchNodeBinary("latest", onProgress, manifest, {
                    updateCurrent: false,
                });
                deps.updateCurrent({
                    headersVersion: preparedCore.version,
                    coreHeaders: preparedCore.coreHeaders,
                    nodeVersion: node.version,
                    node: node.nodeBinaryPath,
                });
                return `ready ${node.version}`;
            }

            if (!nodeReady && headersReady && current?.headersVersion === "local") {
                deps.updateCurrent({
                    headersVersion: preparedCore.version,
                    coreHeaders: preparedCore.coreHeaders,
                });
                return "skipped — local headers require --node-bin";
            }
            const node = await deps.ensureNodeBinary(undefined, onProgress, {
                updateCurrent: false,
            });
            if (node.version !== preparedCore.version) {
                if (headersReady && nodeReady) {
                    return `cached ${node.version} · version drift`;
                }
                throw new Error(`headers/node version drift (${preparedCore.version} != ${node.version})`);
            }
            deps.updateCurrent({
                headersVersion: preparedCore.version,
                coreHeaders: preparedCore.coreHeaders,
                nodeVersion: node.version,
                node: node.nodeBinaryPath,
            });
            return `ready ${node.version}`;
        },
        emit,
    );

    await runStep(
        "wasi",
        async (onProgress) => {
            if (configuredSdk) {
                return `ready ${configuredSdk}`;
            }
            const sdk = await deps.fetchWasiSdk(onProgress, updateWasi ? { upgrade: true } : undefined);
            const ready = deps.wasiSdkPaths();
            if (!ready) {
                throw new Error("WASI SDK unavailable after setup — check WASM_CLANG and WASI_SYSROOT");
            }
            return sdk.cached ? `cached ${ready.root}` : `fetched ${ready.root}`;
        },
        emit,
    );

    await runStep(
        "verifier",
        async (onProgress) => {
            const configured = deps.configuredVerifyTool();
            if (configured) {
                return `ready ${configured}`;
            }

            const update = await deps.autoUpdateVerifyTool({
                force: true,
                onProgress,
            });
            if (update.action === "unsupported") {
                return "skipped — not published yet";
            }
            if (update.action === "none" && deps.updatesDisabled()) {
                return "skipped — updates disabled";
            }
            if (update.action === "offline") {
                throw new Error("contract verifier download failed");
            }
            if (update.action === "none") {
                throw new Error("contract verifier was not installed");
            }
            return update.version ? `${update.action} ${update.version}` : update.action;
        },
        emit,
    );
}

interface SetupStepView {
    state: StepState;
    detail?: string;
    pct?: number;
    elapsedMs?: number;
}

type UpdateDecision = "accepted" | "skipped";

export function Setup({ commandArgs }: { commandArgs: CommandArguments }) {
    const { exit } = useApp();
    const force = commandArgs.has("force");
    const canPrompt = Boolean(process.stdin.isTTY && process.stdout.isTTY && !output.json);
    const [steps, setSteps] = useState<Record<SetupStepKey, SetupStepView>>({
        headers: { state: "pending" },
        node: { state: "pending" },
        wasi: { state: "pending" },
        verifier: { state: "pending" },
    });
    const [result, setResult] = useState<{ ok: boolean; error?: string }>();
    const [updates, setUpdates] = useState<readonly SetupUpdate[]>([]);
    const [prompting, setPrompting] = useState(false);
    const [decision, setDecision] = useState<UpdateDecision>();
    const resolvePrompt = useRef<((accepted: boolean) => void) | null>(null);

    useEffect(() => {
        runSetup(
            (event) => {
                if (output.plain && event.state === "active" && event.pct !== 0) {
                    return;
                }
                setSteps((current) => ({
                    ...current,
                    [event.step]: {
                        state: event.state,
                        detail: event.detail,
                        pct: event.state === "active" ? event.pct : undefined,
                        elapsedMs: event.elapsedMs,
                    },
                }));
            },
            {},
            {
                force,
                onUpdates: (available) => {
                    setUpdates([...available]);
                    if (available.length > 0 && force) {
                        setDecision("accepted");
                    }
                },
                confirmUpdates: async () => {
                    if (!canPrompt) {
                        setDecision("skipped");
                        return false;
                    }
                    return new Promise<boolean>((resolve) => {
                        resolvePrompt.current = resolve;
                        setPrompting(true);
                    });
                },
            },
        ).then(
            () => setResult({ ok: true }),
            (error) =>
                setResult({
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                }),
        );
    }, []);

    useInput(
        (input, key) => {
            if (!prompting) {
                return;
            }
            const answer = input.toLowerCase();
            if (answer !== "y" && answer !== "n" && !key.return && !key.escape) {
                return;
            }
            const accepted = answer === "y";
            setPrompting(false);
            setDecision(accepted ? "accepted" : "skipped");
            const resolve = resolvePrompt.current;
            resolvePrompt.current = null;
            resolve?.(accepted);
        },
        { isActive: prompting },
    );

    useEffect(() => {
        if (!result) {
            return;
        }
        process.exitCode = result.ok ? 0 : 1;
        const timer = setTimeout(() => exit(), 50);
        return () => clearTimeout(timer);
    }, [result, exit]);

    return (
        <Box flexDirection="column">
            <Header cmd="setup" />
            {updates.length > 0 && (
                <Box flexDirection="column" marginBottom={1}>
                    <Text bold color={theme.warn}>
                        updates available
                    </Text>
                    {updates.map((update) => (
                        <Text key={update.key}>
                            {update.label}: {update.current} → {update.available}
                        </Text>
                    ))}
                    {prompting ? (
                        <Text>install these updates? [y/N]</Text>
                    ) : decision === "skipped" ? (
                        <Text dimColor>updates skipped · run `qinit setup --force` to install</Text>
                    ) : decision === "accepted" ? (
                        <Text dimColor>installing updates{force ? " (--force)" : ""}</Text>
                    ) : null}
                </Box>
            )}
            {SETUP_STEPS.map(({ key, label }) => (
                <StepRow key={key} state={steps[key].state} label={label} detail={steps[key].detail} pct={steps[key].pct} elapsedMs={steps[key].elapsedMs} />
            ))}
            {result && (
                <Box marginTop={1}>
                    <Text color={result.ok ? theme.ok : theme.err}>{result.ok ? "✓ setup complete" : `✗ setup failed: ${result.error}`}</Text>
                </Box>
            )}
        </Box>
    );
}
