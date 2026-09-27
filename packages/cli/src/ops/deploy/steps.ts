// The deployment progress model. Pure — no RPC, no clock beyond an injected `now` — so the command's rendering can be tested without a node.
import type { DeployOutcome } from "@qinit/core";

export type StepKey = "tick" | "slot" | "build" | "upload" | "deploy" | "confirm";
export type DeploymentStepEvent = {
    step: StepKey;
    state: "active" | "ok" | "fail";
    detail?: string;
    pct?: number;
};
export interface ContractStatus {
    name: string;
    slot: number;
    kind: "system" | "callee" | "main";
    status: string;
    tone: "active" | "ok" | "quiet" | "fail";
    source?: string;
}
// `note` is the whole line as text; `topic` names what a remark is about, `contract` carries one contract's current status.
export type DeploymentNote = { note: string; topic?: string; contract?: ContractStatus };
export type DeploymentEvent = DeploymentStepEvent | DeploymentNote;

export interface DeploymentLog {
    contracts: ContractStatus[];
    lines: { topic?: string; text: string }[];
}

const KIND_ORDER: Record<ContractStatus["kind"], number> = { system: 0, callee: 1, main: 2 };

// a contract reports its status more than once as the deploy moves, and only the last one describes it.
export function deploymentLog(notes: readonly DeploymentNote[]): DeploymentLog {
    const contracts = new Map<string, ContractStatus>();
    const lines: DeploymentLog["lines"] = [];

    for (const entry of notes) {
        if (entry.contract) {
            // a later status may not know the path an earlier one carried.
            contracts.set(entry.contract.name, { ...entry.contract, source: entry.contract.source ?? contracts.get(entry.contract.name)?.source });
            continue;
        }
        lines.push({ topic: entry.topic, text: entry.note });
    }

    return {
        contracts: [...contracts.values()].sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind] || left.slot - right.slot),
        lines,
    };
}

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

export function classifyConfirm(state: { present: boolean; regOk: boolean; onNode: string; want: string; refusal?: Pick<DeployOutcome, "code" | "message"> }): {
    reason: string;
    detail: string;
    note: string;
} {
    // the node's own account of the DEPLOY beats anything inferred from the slot.
    if (state.refusal) {
        return {
            reason: "deploy-refused",
            detail: `node refused deploy: ${state.refusal.message}`,
            note:
                state.refusal.code === "incomplete"
                    ? "the node never received every chunk of the upload — run the deploy again"
                    : `refusal ${state.refusal.code} is final for this upload; fix the cause and deploy again`,
        };
    }

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
