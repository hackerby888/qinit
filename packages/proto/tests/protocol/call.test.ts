import { expect, test } from "bun:test";
import { LiteRpc, type DynamicContractRegistryEntry } from "@qinit/core";
import { resolveDeploymentSlot } from "../../src/call";

function contract(index: number, armed: boolean, name = ""): DynamicContractRegistryEntry {
    return {
        index,
        armed,
        constructed: armed,
        version: armed ? 1 : 0,
        name,
        codeHash: "",
        functions: [],
        procedures: [],
    };
}

function rpcWithRegistry(contracts: DynamicContractRegistryEntry[]): LiteRpc {
    return {
        dynRegistry: async () => ({
            contracts,
            slotBase: 29,
            slotCount: 4,
        }),
    } as LiteRpc;
}

test("resolveDeploymentSlot rejects explicit slots outside the dynamic window", async () => {
    const rpc = rpcWithRegistry([]);

    await expect(resolveDeploymentSlot(rpc, "Counter", 28)).rejects.toThrow("slot 28 is outside dynamic range 29..32");
    await expect(resolveDeploymentSlot(rpc, "Counter", 33)).rejects.toThrow("slot 33 is outside dynamic range 29..32");
    expect(await resolveDeploymentSlot(rpc, "Counter", 29)).toEqual({
        slot: 29,
        reused: false,
    });
});

test("resolveDeploymentSlot protects explicit slots and reuses the same name", async () => {
    const occupied = rpcWithRegistry([contract(29, true, "Other"), contract(30, true, "Counter")]);

    await expect(resolveDeploymentSlot(occupied, "Counter", 29)).rejects.toThrow("slot 29 is occupied by 'Other', not 'Counter'");
    await expect(resolveDeploymentSlot(occupied, "Counter", 31)).rejects.toThrow("'Counter' is already deployed at slot 30, not requested slot 31");
    expect(await resolveDeploymentSlot(occupied, "Counter", 30)).toEqual({
        slot: 30,
        reused: true,
    });
});

test("resolveDeploymentSlot ignores same-name and free entries outside the dynamic window", async () => {
    const rpc = rpcWithRegistry([contract(1, true, "Counter"), contract(28, false), contract(29, false), contract(30, true, "Other")]);

    expect(await resolveDeploymentSlot(rpc, "Counter")).toEqual({
        slot: 29,
        reused: false,
    });

    const reused = rpcWithRegistry([contract(1, false), contract(29, true, "Other"), contract(30, true, "Counter")]);
    expect(await resolveDeploymentSlot(reused, "Counter")).toEqual({
        slot: 30,
        reused: true,
    });
});
