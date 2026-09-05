import { expect, test } from "bun:test";
import type { DynamicContractRegistry } from "@qinit/core";
import { assignSlots, type SlotInput } from "@qinit/build/contracts/project-slots";

const layout = { slotBase: 29, slotCount: 4 };

function custom(stateType: string, callees: string[] = [], slot?: number): SlotInput {
    return {
        kind: "custom",
        name: stateType,
        stateType,
        callees,
        slot,
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

test("assignSlots assigns a dependency chain from low to high slots", () => {
    const plan = assignSlots([custom("Leaf"), custom("Middle", ["Leaf"]), custom("Main", ["Middle"])], layout);

    expect(plan.map(({ stateType, slot }) => [stateType, slot])).toEqual([
        ["Leaf", 29],
        ["Middle", 30],
        ["Main", 31],
    ]);
});

test("assignSlots respects deployed and explicitly fixed slots", () => {
    const plan = assignSlots(
        [custom("Leaf"), custom("Middle", ["Leaf"]), custom("Main", ["Middle"], 32)],
        layout,
        registry([{ index: 30, name: "Middle" }]),
    );

    expect(plan.map(({ stateType, slot, alreadyDeployed }) => [stateType, slot, alreadyDeployed])).toEqual([
        ["Leaf", 29, false],
        ["Middle", 30, true],
        ["Main", 32, false],
    ]);
});

test("assignSlots leaves unrelated occupied slots unavailable", () => {
    const plan = assignSlots([custom("Dependency"), custom("Main", ["Dependency"])], layout, registry([{ index: 29, name: "Other" }]));

    expect(plan.map(({ slot }) => slot)).toEqual([30, 31]);
});

test("assignSlots rejects unsafe fixed slots and impossible ordering", () => {
    expect(() => assignSlots([custom("Main", [], 1)], layout)).toThrow("outside the dynamic window");

    expect(() => assignSlots([custom("Dependency"), custom("Main", ["Dependency"])], layout, registry([{ index: 29, name: "Main" }]))).toThrow(
        "cannot assign",
    );
});

test("assignSlots rejects occupied explicit slots without mutation", () => {
    expect(() => assignSlots([custom("Main", [], 29)], layout, registry([{ index: 29, name: "Other" }]))).toThrow("occupied by 'Other'");
});
