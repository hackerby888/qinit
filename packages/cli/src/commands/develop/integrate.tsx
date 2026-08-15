import { useEffect, useState } from "react";
import { basename, resolve } from "node:path";
import { Box, Text, useApp, useInput } from "ink";
import { output, type CommandArguments } from "../../args";
import { loadConfig } from "../../config";
import { Header, Spinner, StepRow, TextPrompt, theme, type StepState } from "../../ui";
import {
    CoreIntegrationMetadataRequiredError,
    runCoreIntegration,
    type CoreIntegrationOptions,
    type CoreIntegrationProgress,
    type CoreIntegrationResult,
    type CoreIntegrationStep,
} from "../../ops/core-integration";

type Metadata = Pick<CoreIntegrationOptions, "assetName" | "constructionEpoch" | "destructionEpoch">;

type PromptField = keyof Metadata;

interface CoreIntegrationContext {
    projectRoot: string;
    contractPath: string;
    contractName: string;
    outputPath: string;
}

interface IntegrationStepView {
    state: StepState;
    detail?: string;
    elapsedMs?: number;
}

const INTEGRATION_STEPS = [
    { key: "contract", label: "check contract" },
    { key: "checkout", label: "Core checkout" },
    { key: "wire", label: "wire contract" },
] as const;

function initialSteps(): Record<CoreIntegrationStep, IntegrationStepView> {
    return {
        contract: { state: "pending" },
        checkout: { state: "pending" },
        wire: { state: "pending" },
    };
}

type State =
    | { phase: "prepare" }
    | {
          phase: "prompt";
          context: CoreIntegrationContext;
          metadata: Metadata;
          fields: PromptField[];
          index: number;
          error?: string;
      }
    | { phase: "run" }
    | { phase: "done"; result: CoreIntegrationResult; contractName: string }
    | { phase: "error"; message: string };

function parseAssetName(value: string): string {
    if (!/^[A-Z][A-Z0-9]{0,6}$/.test(value)) {
        throw new Error("asset must be 1–7 uppercase letters or digits, starting with a letter");
    }

    return value;
}

function parseEpoch(value: string, label: string): number {
    if (!/^\d+$/.test(value)) {
        throw new Error(`${label} must be an integer from 1 to 65535`);
    }

    const epoch = Number(value);
    if (epoch < 1 || epoch > 65535) {
        throw new Error(`${label} must be an integer from 1 to 65535`);
    }

    return epoch;
}

function validateEpochOrder(metadata: Metadata): void {
    if (metadata.constructionEpoch !== undefined && metadata.destructionEpoch !== undefined && metadata.destructionEpoch <= metadata.constructionEpoch) {
        throw new Error("destruction epoch must be later than construction epoch");
    }
}

export function Integrate({ commandArgs }: { commandArgs: CommandArguments }) {
    const { exit } = useApp();
    const [state, setState] = useState<State>({ phase: "prepare" });
    const [steps, setSteps] = useState<Record<CoreIntegrationStep, IntegrationStepView> | null>(null);

    const finishWithError = (error: unknown) => {
        process.exitCode = 1;
        setState({
            phase: "error",
            message: String((error as Error)?.message ?? error),
        });
    };

    const promptForMetadata = (context: CoreIntegrationContext, metadata: Metadata): void => {
        setSteps(null);
        const fields: PromptField[] = [];
        if (metadata.assetName === undefined) {
            fields.push("assetName");
        }
        if (metadata.constructionEpoch === undefined) {
            fields.push("constructionEpoch");
        }
        if (metadata.destructionEpoch === undefined) {
            fields.push("destructionEpoch");
        }

        setState({
            phase: "prompt",
            context,
            metadata,
            fields,
            index: 0,
        });
    };

    const execute = async (context: CoreIntegrationContext, metadata: Metadata, promptWhenMetadataIsRequired = false): Promise<void> => {
        try {
            validateEpochOrder(metadata);
            setSteps(initialSteps());
            setState({ phase: "run" });
            const result = await runCoreIntegration({
                ...context,
                ...metadata,
                requireDestructionEpoch: promptWhenMetadataIsRequired,
                onProgress: (event: CoreIntegrationProgress) => {
                    setSteps((current) => ({
                        ...(current ?? initialSteps()),
                        [event.step]: {
                            state: event.state,
                            detail: event.detail,
                            elapsedMs: event.elapsedMs,
                        },
                    }));
                },
            });
            setState({ phase: "done", result, contractName: context.contractName });
        } catch (error) {
            if (error instanceof CoreIntegrationMetadataRequiredError) {
                if (promptWhenMetadataIsRequired) {
                    promptForMetadata(context, metadata);
                } else {
                    setSteps((current) => {
                        if (!current) {
                            return current;
                        }
                        return {
                            ...current,
                            wire: {
                                ...current.wire,
                                state: "fail",
                            },
                        };
                    });
                    finishWithError("new integration requires --asset and --construction-epoch without a terminal");
                }
                return;
            }
            finishWithError(error);
        }
    };

    useEffect(() => {
        (async () => {
            try {
                if (commandArgs.positionals.length > 1) {
                    throw new Error("integrate accepts at most one contract path");
                }

                const projectRoot = process.cwd();
                const config = loadConfig();
                const selectedContract = commandArgs.get("contract") ?? commandArgs.positionals[0] ?? config.contract;
                if (!selectedContract) {
                    throw new Error("pass a contract header: qinit integrate <file.h>");
                }

                const contractPath = resolve(projectRoot, selectedContract);
                const contractName = commandArgs.get("contract-name") ?? config.contractName ?? basename(contractPath).replace(/\.[^.]+$/, "");
                const outputPath = resolve(projectRoot, commandArgs.get("out") ?? `../${contractName}-core`);
                const context: CoreIntegrationContext = {
                    projectRoot,
                    contractPath,
                    contractName,
                    outputPath,
                };
                const metadata: Metadata = {
                    assetName: commandArgs.has("asset") ? parseAssetName(commandArgs.get("asset") ?? "") : undefined,
                    constructionEpoch: commandArgs.has("construction-epoch")
                        ? parseEpoch(commandArgs.get("construction-epoch") ?? "", "construction epoch")
                        : undefined,
                    destructionEpoch: commandArgs.has("destruction-epoch")
                        ? parseEpoch(commandArgs.get("destruction-epoch") ?? "", "destruction epoch")
                        : undefined,
                };
                validateEpochOrder(metadata);

                const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !output.json);
                await execute(context, metadata, interactive);
            } catch (error) {
                finishWithError(error);
            }
        })();
    }, []);

    useEffect(() => {
        if (state.phase === "done" || state.phase === "error") {
            const timer = setTimeout(() => exit(), 30);
            return () => clearTimeout(timer);
        }
    }, [state.phase, exit]);

    useInput(
        (_input, key) => {
            if (key.escape && state.phase === "prompt") {
                process.exitCode = 1;
                exit();
            }
        },
        { isActive: state.phase === "prompt" },
    );

    const submitPrompt = (value: string) => {
        if (state.phase !== "prompt") {
            return;
        }

        try {
            const field = state.fields[state.index];
            const metadata: Metadata = {
                ...state.metadata,
                [field]:
                    field === "assetName"
                        ? parseAssetName(value)
                        : parseEpoch(value, field === "constructionEpoch" ? "construction epoch" : "destruction epoch"),
            };
            const nextIndex = state.index + 1;
            if (nextIndex === state.fields.length) {
                validateEpochOrder(metadata);
                void execute(state.context, metadata);
                return;
            }

            setState({
                ...state,
                metadata,
                index: nextIndex,
                error: undefined,
            });
        } catch (error) {
            setState({
                ...state,
                error: String((error as Error)?.message ?? error),
            });
        }
    };

    const promptField = state.phase === "prompt" ? state.fields[state.index] : undefined;
    const promptLabel =
        promptField === "assetName"
            ? "asset name"
            : promptField === "constructionEpoch"
              ? "construction epoch (IPO is normally one epoch earlier)"
              : "destruction epoch";

    return (
        <Box flexDirection="column">
            <Header cmd="integrate" />
            {state.phase === "prepare" ? <Spinner label="checking Qubic Core target" /> : null}
            {state.phase === "prompt" && promptField ? (
                <Box flexDirection="column">
                    <TextPrompt key={promptField} label={promptLabel} initial={promptField === "destructionEpoch" ? "10000" : ""} onSubmit={submitPrompt} />
                    {state.error ? <Text color={theme.err}>✗ {state.error}</Text> : null}
                </Box>
            ) : null}
            {steps && state.phase !== "prompt" ? (
                <Box flexDirection="column">
                    {INTEGRATION_STEPS.map(({ key, label }) => (
                        <StepRow key={key} state={steps[key].state} label={label} detail={steps[key].detail} elapsedMs={steps[key].elapsedMs} />
                    ))}
                </Box>
            ) : null}
            {state.phase === "error" ? <Text color={theme.err}>✗ {state.message}</Text> : null}
            {state.phase === "done" ? (
                <Box flexDirection="column">
                    <Text color={theme.ok}>
                        ✓ {state.result.mode} contract index {state.result.contractIndex}
                    </Text>
                    <Text>
                        <Text dimColor>core </Text>
                        {state.result.corePath}
                    </Text>
                    <Text>
                        <Text dimColor>branch </Text>
                        {state.result.branch}
                    </Text>
                    {state.result.testPath ? (
                        <Text>
                            <Text dimColor>test </Text>
                            {state.result.testPath}
                        </Text>
                    ) : null}
                    {state.result.warnings.map((warning) => (
                        <Text key={warning} color={theme.warn}>
                            ! {warning}
                        </Text>
                    ))}
                    <Text> </Text>
                    <Text dimColor>next (Windows):</Text>
                    <Text color={theme.accent}>cd "{state.result.corePath}"</Text>
                    <Text color={theme.accent}>nuget restore Qubic.sln</Text>
                    <Text color={theme.accent}>msbuild /m /p:Configuration=Release Qubic.sln /t:Qubic:Rebuild /warnaserror</Text>
                    {state.result.testPath ? (
                        <>
                            <Text color={theme.accent}>msbuild /m /p:Configuration=Release Qubic.sln /t:test:Rebuild /warnaserror</Text>
                            <Text color={theme.accent}>.\x64\Release\test.exe --gtest_filter={state.contractName}.*</Text>
                        </>
                    ) : null}
                </Box>
            ) : null}
        </Box>
    );
}
