import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { existsSync } from "node:fs";
import {
  autoUpdateVerifyTool,
  fetchWasiSdk,
  loadManifest,
  wasiSdkPaths,
  type Manifest,
} from "@qinit/core";
import { fetchNodeBin, nodeAssetForPlatform } from "../node-ops";
import { prepareNodeRunCore } from "../node-run-core";
import { output } from "../args";
import { Header, StepRow, type StepState, theme } from "../ui";

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

function configuredVerifyTool(): string | null {
  const override = process.env.QINIT_VERIFY?.trim();
  if (override && existsSync(override)) {
    return override;
  }
  return Bun.which("contractverify");
}

const defaultDeps = {
  loadManifest,
  prepareNodeRunCore,
  nodeAssetForPlatform,
  fetchNodeBin,
  wasiSdkPaths,
  fetchWasiSdk,
  configuredVerifyTool,
  autoUpdateVerifyTool,
  updatesDisabled: () => Boolean(process.env.QINIT_NO_UPDATE),
};

export type SetupDeps = typeof defaultDeps;

type Progress = (received: number, total: number) => void;

async function runStep(
  step: SetupStepKey,
  operation: (onProgress: Progress) => Promise<string>,
  emit: (event: SetupEvent) => void,
): Promise<void> {
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

export async function runSetup(
  emit: (event: SetupEvent) => void = () => {},
  injected: Partial<SetupDeps> = {},
): Promise<void> {
  const deps = { ...defaultDeps, ...injected };
  let manifest: Manifest;

  await runStep(
    "headers",
    async (onProgress) => {
      manifest = await deps.loadManifest("latest");
      const prepared = await deps.prepareNodeRunCore(
        { ref: "latest" },
        false,
        { loadManifest: async () => manifest },
        onProgress,
      );
      return prepared.detail;
    },
    emit,
  );

  await runStep(
    "node",
    async (onProgress) => {
      if (!deps.nodeAssetForPlatform(manifest)) {
        return "skipped — not published yet";
      }
      const node = await deps.fetchNodeBin("latest", onProgress, manifest);
      return `ready ${node.version}`;
    },
    emit,
  );

  await runStep(
    "wasi",
    async (onProgress) => {
      const configured = deps.wasiSdkPaths();
      if (configured) {
        return `ready ${configured.root}`;
      }
      const sdk = await deps.fetchWasiSdk(onProgress);
      const ready = deps.wasiSdkPaths();
      if (!ready) {
        throw new Error(
          "WASI SDK unavailable after setup — check WASM_CLANG and WASI_SYSROOT",
        );
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

export function Setup() {
  const { exit } = useApp();
  const [steps, setSteps] = useState<Record<SetupStepKey, SetupStepView>>({
    headers: { state: "pending" },
    node: { state: "pending" },
    wasi: { state: "pending" },
    verifier: { state: "pending" },
  });
  const [result, setResult] = useState<{ ok: boolean; error?: string }>();

  useEffect(() => {
    runSetup((event) => {
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
    }).then(
      () => setResult({ ok: true }),
      (error) =>
        setResult({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  }, []);

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
      {SETUP_STEPS.map(({ key, label }) => (
        <StepRow
          key={key}
          state={steps[key].state}
          label={label}
          detail={steps[key].detail}
          pct={steps[key].pct}
          elapsedMs={steps[key].elapsedMs}
        />
      ))}
      {result && (
        <Box marginTop={1}>
          <Text color={result.ok ? theme.ok : theme.err}>
            {result.ok ? "✓ setup complete" : `✗ setup failed: ${result.error}`}
          </Text>
        </Box>
      )}
    </Box>
  );
}
