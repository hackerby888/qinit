import type { DynamicContractRegistry, DynamicContractRegistryEntry } from "@qinit/core";

export interface ProjectSlotNode {
    kind: "system" | "custom";
    name: string;
    stateType: string;
    index?: number;
    dependencies: readonly string[];
}

export interface PlannedProjectSlotNode extends ProjectSlotNode {
    index: number;
    reused: boolean;
}

export interface ProjectSlotLayout {
    slotBase: number;
    slotCount: number;
}

function inDynamicWindow(index: number, layout: ProjectSlotLayout): boolean {
    return index >= layout.slotBase && index < layout.slotBase + layout.slotCount;
}

function armedDynamicContracts(
    registry: DynamicContractRegistry | undefined,
): DynamicContractRegistryEntry[] {
    if (!registry) {
        return [];
    }

    return (registry.contracts ?? []).filter(
        (contract) => contract.armed && inDynamicWindow(contract.index, registry),
    );
}

export function planProjectSlots<T extends ProjectSlotNode>(
    nodes: readonly T[],
    layout: ProjectSlotLayout,
    registry?: DynamicContractRegistry,
): Array<T & PlannedProjectSlotNode> {
    if (layout.slotCount <= 0) {
        throw new Error("no dynamic contract slots are available");
    }

    const byStateType = new Map<string, ProjectSlotNode>();
    for (const node of nodes) {
        if (byStateType.has(node.stateType)) {
            throw new Error(`duplicate project contract '${node.stateType}'`);
        }
        byStateType.set(node.stateType, node);
    }

    const customNodes = nodes.filter((node) => node.kind === "custom");
    const deployed = armedDynamicContracts(registry);
    const deployedBySlot = new Map(deployed.map((contract) => [contract.index, contract]));
    const fixed = new Map<string, { index: number; reused: boolean }>();

    for (const node of customNodes) {
        const matching = deployed.filter((contract) => contract.name === node.name);
        if (matching.length > 1) {
            throw new Error(
                `multiple deployed contracts are named '${node.name}': ${matching
                    .map((contract) => contract.index)
                    .join(", ")}`,
            );
        }

        if (node.index !== undefined) {
            if (!inDynamicWindow(node.index, layout)) {
                throw new Error(
                    `${node.name} slot ${node.index} is outside the dynamic window ` +
                        `${layout.slotBase}..${layout.slotBase + layout.slotCount - 1}`,
                );
            }

            const occupant = deployedBySlot.get(node.index);
            if (occupant && occupant.name !== node.name) {
                throw new Error(
                    `slot ${node.index} is occupied by '${occupant.name}', not '${node.name}'`,
                );
            }
            if (matching[0] && matching[0].index !== node.index) {
                throw new Error(
                    `'${node.name}' is already deployed at slot ${matching[0].index}, ` +
                        `not requested slot ${node.index}`,
                );
            }

            fixed.set(node.stateType, {
                index: node.index,
                reused: occupant?.name === node.name,
            });
            continue;
        }

        if (matching[0]) {
            fixed.set(node.stateType, {
                index: matching[0].index,
                reused: true,
            });
        }
    }

    const fixedSlots = new Map<number, string>();
    for (const [stateType, planned] of fixed) {
        const previous = fixedSlots.get(planned.index);
        if (previous && previous !== stateType) {
            throw new Error(
                `project contracts '${previous}' and '${stateType}' both require slot ${planned.index}`,
            );
        }
        fixedSlots.set(planned.index, stateType);
    }

    const graphNames = new Set(customNodes.map((node) => node.name));
    const unavailableSlots = new Set(
        deployed
            .filter((contract) => !graphNames.has(contract.name))
            .map((contract) => contract.index),
    );
    const assignments = new Map<string, number>();
    for (const [stateType, planned] of fixed) {
        assignments.set(stateType, planned.index);
    }

    const edges: Array<[dependency: string, caller: string]> = [];
    for (const node of customNodes) {
        for (const dependency of node.dependencies) {
            const dependencyNode = byStateType.get(dependency);
            if (dependencyNode?.kind === "custom") {
                edges.push([dependency, node.stateType]);
            }
        }
    }

    const constraintsHold = (): boolean => {
        for (const [dependency, caller] of edges) {
            const dependencySlot = assignments.get(dependency);
            const callerSlot = assignments.get(caller);
            if (
                dependencySlot !== undefined &&
                callerSlot !== undefined &&
                dependencySlot >= callerSlot
            ) {
                return false;
            }
        }
        return true;
    };

    if (!constraintsHold()) {
        throw new Error("fixed contract slots violate the callee-before-caller rule");
    }

    const unassigned = customNodes.filter((node) => !assignments.has(node.stateType));
    const candidates = Array.from(
        { length: layout.slotCount },
        (_, offset) => layout.slotBase + offset,
    ).filter((index) => !unavailableSlots.has(index) && !fixedSlots.has(index));

    const assignNext = (position: number): boolean => {
        if (position >= unassigned.length) {
            return constraintsHold();
        }

        const node = unassigned[position];
        for (const index of candidates) {
            if ([...assignments.values()].includes(index)) {
                continue;
            }

            assignments.set(node.stateType, index);
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
            if (node.index === undefined) {
                throw new Error(`system contract '${node.name}' has no canonical slot`);
            }
            return { ...node, index: node.index, reused: true };
        }

        return {
            ...node,
            index: assignments.get(node.stateType)!,
            reused: fixed.get(node.stateType)?.reused ?? false,
        };
    });
}
