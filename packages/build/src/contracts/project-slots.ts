import type { DynamicContractRegistry, DynamicContractRegistryEntry } from "@qinit/core";

export interface SlotInput {
    kind: "system" | "custom";
    name: string;
    stateType: string;
    slot?: number;
    callees: readonly string[];
}

export interface SlotAssignment {
    slot: number;
    alreadyDeployed: boolean;
}

export interface ProjectSlotLayout {
    slotBase: number;
    slotCount: number;
}

function inDynamicWindow(slot: number, layout: ProjectSlotLayout): boolean {
    return slot >= layout.slotBase && slot < layout.slotBase + layout.slotCount;
}

function armedDynamicContracts(registry: DynamicContractRegistry | undefined): DynamicContractRegistryEntry[] {
    if (!registry) {
        return [];
    }

    return (registry.contracts ?? []).filter((contract) => contract.armed && inDynamicWindow(contract.index, registry));
}

export function assignSlots<T extends SlotInput>(
    nodes: readonly T[],
    layout: ProjectSlotLayout,
    registry?: DynamicContractRegistry,
): Array<T & SlotAssignment> {
    if (layout.slotCount <= 0) {
        throw new Error("no dynamic contract slots are available");
    }

    const byStateType = new Map<string, SlotInput>();
    for (const node of nodes) {
        if (byStateType.has(node.stateType)) {
            throw new Error(`duplicate project contract '${node.stateType}'`);
        }
        byStateType.set(node.stateType, node);
    }

    const customNodes = nodes.filter((node) => node.kind === "custom");
    const deployed = armedDynamicContracts(registry);
    // Core registry entries carry on-chain `index`; project nodes carry `slot` — same number, one seam.
    const deployedBySlot = new Map(deployed.map((contract) => [contract.index, contract]));
    const fixed = new Map<string, { slot: number; alreadyDeployed: boolean }>();

    for (const node of customNodes) {
        const matching = deployed.filter((contract) => contract.name === node.name);
        if (matching.length > 1) {
            throw new Error(`multiple deployed contracts are named '${node.name}': ${matching.map((contract) => contract.index).join(", ")}`);
        }

        if (node.slot !== undefined) {
            if (!inDynamicWindow(node.slot, layout)) {
                throw new Error(
                    `${node.name} slot ${node.slot} is outside the dynamic window ` + `${layout.slotBase}..${layout.slotBase + layout.slotCount - 1}`,
                );
            }

            const occupant = deployedBySlot.get(node.slot);
            if (occupant && occupant.name !== node.name) {
                throw new Error(`slot ${node.slot} is occupied by '${occupant.name}', not '${node.name}'`);
            }
            if (matching[0] && matching[0].index !== node.slot) {
                throw new Error(`'${node.name}' is already deployed at slot ${matching[0].index}, ` + `not requested slot ${node.slot}`);
            }

            fixed.set(node.stateType, {
                slot: node.slot,
                alreadyDeployed: occupant?.name === node.name,
            });
            continue;
        }

        if (matching[0]) {
            fixed.set(node.stateType, {
                slot: matching[0].index,
                alreadyDeployed: true,
            });
        }
    }

    const fixedSlots = new Map<number, string>();
    for (const [stateType, planned] of fixed) {
        const previous = fixedSlots.get(planned.slot);
        if (previous && previous !== stateType) {
            throw new Error(`project contracts '${previous}' and '${stateType}' both require slot ${planned.slot}`);
        }
        fixedSlots.set(planned.slot, stateType);
    }

    const graphNames = new Set(customNodes.map((node) => node.name));
    const unavailableSlots = new Set(deployed.filter((contract) => !graphNames.has(contract.name)).map((contract) => contract.index));
    const assignments = new Map<string, number>();
    for (const [stateType, planned] of fixed) {
        assignments.set(stateType, planned.slot);
    }

    const edges: Array<[callee: string, caller: string]> = [];
    for (const node of customNodes) {
        for (const callee of node.callees) {
            const calleeNode = byStateType.get(callee);
            if (calleeNode?.kind === "custom") {
                edges.push([callee, node.stateType]);
            }
        }
    }

    const constraintsHold = (): boolean => {
        for (const [callee, caller] of edges) {
            const calleeSlot = assignments.get(callee);
            const callerSlot = assignments.get(caller);
            if (calleeSlot !== undefined && callerSlot !== undefined && calleeSlot >= callerSlot) {
                return false;
            }
        }
        return true;
    };

    if (!constraintsHold()) {
        throw new Error("fixed contract slots violate the callee-before-caller rule");
    }

    const unassigned = customNodes.filter((node) => !assignments.has(node.stateType));
    const candidates = Array.from({ length: layout.slotCount }, (_, offset) => layout.slotBase + offset).filter(
        (slot) => !unavailableSlots.has(slot) && !fixedSlots.has(slot),
    );

    const assignNext = (position: number): boolean => {
        if (position >= unassigned.length) {
            return constraintsHold();
        }

        const node = unassigned[position];
        for (const slot of candidates) {
            if ([...assignments.values()].includes(slot)) {
                continue;
            }

            assignments.set(node.stateType, slot);
            if (constraintsHold() && assignNext(position + 1)) {
                return true;
            }
            assignments.delete(node.stateType);
        }

        return false;
    };

    if (!assignNext(0)) {
        throw new Error(
            `cannot assign ${customNodes.length} project contracts to dynamic slots ` +
                `${layout.slotBase}..${layout.slotBase + layout.slotCount - 1} ` +
                "while keeping every callee below its caller",
        );
    }

    return nodes.map((node) => {
        if (node.kind === "system") {
            if (node.slot === undefined) {
                throw new Error(`system contract '${node.name}' has no canonical slot`);
            }
            return { ...node, slot: node.slot, alreadyDeployed: true };
        }

        return {
            ...node,
            slot: assignments.get(node.stateType)!,
            alreadyDeployed: fixed.get(node.stateType)?.alreadyDeployed ?? false,
        };
    });
}
