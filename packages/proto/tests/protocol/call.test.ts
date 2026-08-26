import { expect, test } from "bun:test";
import { LiteRpc, type DynamicContractRegistryEntry } from "@qinit/core";
import { resolveDeploymentSlot, sendTransfer } from "../../src/call";

const realFetch = globalThis.fetch;

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

// A node that answers tick-info, accepts broadcasts, and reports each tx as included or missed in order.
function fakeNode(verdicts: ({ found: boolean } | "no-route")[]) {
    const broadcasts: string[] = [];
    let tick = 100;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

        if (path === "/live/v1/tick-info") {
            return json({ tick, epoch: 1 });
        }
        if (path === "/live/v1/broadcast-transaction") {
            broadcasts.push(String(JSON.parse(String(init?.body)).encodedTransaction));
            tick += 10;
            return json({ peersBroadcasted: 1, transactionId: `tx${broadcasts.length}` });
        }
        if (path.startsWith("/live/v1/tx-status/")) {
            const verdict = verdicts[broadcasts.length - 1];
            if (!verdict || verdict === "no-route") {
                return json({ code: 404 }, 404);
            }
            return json({ processed: true, found: verdict.found, moneyFlew: verdict.found, currentTick: tick });
        }
        return json({ code: 404 }, 404);
    }) as typeof fetch;

    return { broadcasts };
}

const transfer = (rpc: LiteRpc) =>
    sendTransfer({
        seed: "a".repeat(55),
        destination: new Uint8Array(32),
        amount: 0,
        rpcBaseUrl: "http://node",
        rpc,
        tick: 108,
        confirm: true,
        confirmTimeoutMs: 2000,
    });

test("a transaction the node processed without including is signed again for a later tick", async () => {
    const node = fakeNode([{ found: false }, { found: true }]);

    try {
        const result = await transfer(new LiteRpc("http://node"));

        expect(node.broadcasts.length).toBe(2);
        expect(node.broadcasts[0]).not.toBe(node.broadcasts[1]);
        expect(result).toMatchObject({ confirmed: true, included: true, tick: 113 }); // resent for tick-info + TX_TICK_OFFSET
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("resends stop at the configured limit", async () => {
    const node = fakeNode([{ found: false }, { found: false }, { found: false }]);

    try {
        const result = await sendTransfer({
            seed: "a".repeat(55),
            destination: new Uint8Array(32),
            amount: 0,
            rpcBaseUrl: "http://node",
            rpc: new LiteRpc("http://node"),
            tick: 108,
            confirm: true,
            confirmTimeoutMs: 2000,
            resends: 1,
        });

        expect(node.broadcasts.length).toBe(2);
        expect(result).toMatchObject({ confirmed: true, included: false });
    } finally {
        globalThis.fetch = realFetch;
    }
});

// Without tx-status the tx may well have landed, and a blind resend would execute it twice.
test("a transaction with an unknown fate is never resent", async () => {
    const node = fakeNode(["no-route", "no-route"]);

    try {
        const result = await transfer(new LiteRpc("http://node"));

        expect(node.broadcasts.length).toBe(1);
        expect(result).toMatchObject({ confirmed: false });
    } finally {
        globalThis.fetch = realFetch;
    }
});
