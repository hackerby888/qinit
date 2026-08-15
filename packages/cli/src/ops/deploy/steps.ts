// The deployment progress model: the six steps a deploy walks through, how an event folds into their
// state, and the two failure messages the UI shows verbatim. Pure — no RPC, no clock beyond an injected
// `now`, so the command's rendering can be tested without a node.

export type StepKey = "tick" | "slot" | "build" | "upload" | "deploy" | "confirm";
export type DeploymentStepEvent = {
    step: StepKey;
    state: "active" | "ok" | "fail";
    detail?: string;
    pct?: number;
};
export type DeploymentEvent = DeploymentStepEvent | { note: string };

export interface DeploymentStepState {
    state: DeploymentStepEvent["state"];
    detail?: string;
    pct?: number;
    startedAt?: number;
    elapsedMs?: number;
}

export function updateDeploymentSteps(
    steps: Record<string, DeploymentStepState>,
    event: DeploymentStepEvent,
    now = Date.now(),
): Record<string, DeploymentStepState> {
    const previous = steps[event.step];
    const startedAt = event.state === "active" && !previous?.startedAt ? now : previous?.startedAt;
    const elapsedMs = (event.state === "ok" || event.state === "fail") && startedAt ? now - startedAt : previous?.elapsedMs;
    return {
        ...steps,
        [event.step]: {
            state: event.state,
            detail: event.detail ?? previous?.detail,
            pct: event.pct ?? previous?.pct,
            startedAt,
            elapsedMs,
        },
    };
}

export const STEPS: { key: StepKey; label: string }[] = [
    { key: "tick", label: "node ticking" },
    { key: "slot", label: "resolve slot" },
    { key: "build", label: "build wasm" },
    { key: "upload", label: "upload" },
    { key: "deploy", label: "deploy" },
    { key: "confirm", label: "confirm" },
];

export function tickFailureMessage(reached: boolean, rpcBaseUrl: string): string {
    return reached ? "node not ticking" : `node unreachable at ${rpcBaseUrl} — is it running? (qinit node run)`;
}

export function classifyConfirm(state: { present: boolean; regOk: boolean; onNode: string; want: string }): { reason: string; detail: string; note: string } {
    if (!state.regOk) {
        return {
            reason: "registry-unreadable",
            detail: "couldn't read dyn-registry",
            note: "couldn't read /dyn-registry (node too old or RPC down) — deploy state unknown",
        };
    }

    if (!state.present) {
        return {
            reason: "empty",
            detail: "slot empty — didn't land",
            note: "upload/deploy didn't land (chunks dropped, tick missed, or seed unfunded)",
        };
    }

    return {
        reason: "wrong-code",
        detail: "different code — didn't take",
        note: `on-node ${state.onNode} ≠ yours ${state.want}`,
    };
}
