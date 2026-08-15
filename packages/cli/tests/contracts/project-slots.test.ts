import { expect, test } from "bun:test";
import type { DynamicContractRegistry } from "@qinit/core";
import { planProjectSlots, type ProjectSlotNode } from "../../src/contracts/project-slots";

const layout = { slotBase: 29, slotCount: 4 };

function custom(stateType: string, dependencies: string[] = [], index?: number): ProjectSlotNode {
    return {
        kind: "custom",
        name: stateType,
        stateType,
        dependencies,
        index,
    };
}

function registry(contracts: Array<{ index: number; name: string }>): DynamicContractRegistry {
    return {
        ...layout,
        contracts: Array.from({ length: layout.slotCount }, (_, offset) => {
            const index = layout.slotBase + offset;
            const deployed = contracts.find((contract) => contract.index === index);
            return {
                index,
                armed: !!deployed,
                constructed: !!deployed,
                version: deployed ? 1 : 0,
                name: deployed?.name ?? "",
                codeHash: "",
                functions: [],
                procedures: [],
            };
        }),
    };
}

test("planProjectSlots assigns a dependency chain from low to high slots", () => {
    const plan = planProjectSlots([custom("Leaf"), custom("Middle", ["Leaf"]), custom("Main", ["Middle"])], layout);

    expect(plan.map(({ stateType, index }) => [stateType, index])).toEqual([
        ["Leaf", 29],
        ["Middle", 30],
        ["Main", 31],
    ]);
});

test("planProjectSlots respects deployed and explicitly fixed slots", () => {
    const plan = planProjectSlots(
        [custom("Leaf"), custom("Middle", ["Leaf"]), custom("Main", ["Middle"], 32)],
        layout,
        registry([{ index: 30, name: "Middle" }]),
    );

    expect(plan.map(({ stateType, index, reused }) => [stateType, index, reused])).toEqual([
        ["Leaf", 29, false],
        ["Middle", 30, true],
        ["Main", 32, false],
    ]);
});

test("planProjectSlots leaves unrelated occupied slots unavailable", () => {
    const plan = planProjectSlots([custom("Dependency"), custom("Main", ["Dependency"])], layout, registry([{ index: 29, name: "Other" }]));

    expect(plan.map(({ index }) => index)).toEqual([30, 31]);
});

test("planProjectSlots rejects unsafe fixed slots and impossible ordering", () => {
    expect(() => planProjectSlots([custom("Main", [], 1)], layout)).toThrow("outside the dynamic window");

    expect(() => planProjectSlots([custom("Dependency"), custom("Main", ["Dependency"])], layout, registry([{ index: 29, name: "Main" }]))).toThrow(
        "cannot assign",
    );
});

test("planProjectSlots rejects occupied explicit slots without mutation", () => {
    expect(() => planProjectSlots([custom("Main", [], 29)], layout, registry([{ index: 29, name: "Other" }]))).toThrow("occupied by 'Other'");
});
