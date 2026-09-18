import { expect, test } from "bun:test";
import { LiteRpc, deriveIdentity, type DebugEntry, type DynamicContractRegistryEntry } from "@qinit/core";
import { invokeProcedure, resolveDeploymentSlot, sendTransfer } from "../../src/call";
import { u64 } from "../codec/abi-builders";

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

const SIGNER_SEED = "a".repeat(55);
const TX_TICK = 108;
const SLOT = 30;
const PROCEDURE_ID = 1;

function traceEntry(fields: Partial<DebugEntry>): DebugEntry {
    return {
        seq: 0,
        tick: TX_TICK,
        index: SLOT,
        entry: PROCEDURE_ID,
        kind: 1,
        ok: true,
        execNs: 0,
        inSize: 0,
        outSize: 0,
        stateSize: 0,
        stateTruncated: false,
        invocator: "0".repeat(64),
        invocationReward: 0,
        inHex: "",
        outHex: "",
        stateDiff: [],
        hostCalls: [],
        logs: [],
        cheats: [],
        ...fields,
    };
}

// A dev node: includes every tx, serves the debug trace with since/limit, and can report a halt instead of processing.
function devNode(options: { before: DebugEntry[]; afterBroadcast: DebugEntry[]; fault?: object; traceRoute?: boolean }) {
    let broadcasts = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
        const parsed = new URL(String(url));
        const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

        switch (parsed.pathname) {
            case "/live/v1/tick-info":
                return json({ tick: 100, epoch: 1 });
            case "/live/v1/broadcast-transaction":
                broadcasts++;
                return json({ peersBroadcasted: 1, transactionId: "tx" });
            case "/live/v1/dev/fault":
                return json(options.fault ?? null);
            case "/live/v1/dev/advance-tick":
                // core-lite holds an advance open for its whole time budget once the node has halted.
                if (options.fault) {
                    await new Promise((resolve) => setTimeout(resolve, 3000));
                    return json({ from: 100, requested: 9, target: 109, reached: 100, epochLastTick: 9999, cappedAtEpochEnd: false });
                }
                return json({ code: 404 }, 404);
            case "/live/v1/dev/debug":
                return options.traceRoute === false ? json({ code: 404 }, 404) : json({ enabled: true });
            case "/live/v1/debug-trace": {
                const since = Number(parsed.searchParams.get("since"));
                const limit = Number(parsed.searchParams.get("limit"));
                const recorded = broadcasts ? [...options.before, ...options.afterBroadcast] : options.before;

                return json({ enabled: true, entries: recorded.filter((entry) => entry.seq > since).slice(-limit) });
            }
        }
        if (parsed.pathname.startsWith("/live/v1/tx-status/")) {
            return json({ processed: !options.fault, found: !options.fault, moneyFlew: false, currentTick: 120 });
        }
        return json({ code: 404 }, 404);
    }) as typeof fetch;

    return { broadcastCount: () => broadcasts };
}

const invoke = (trace: boolean) =>
    invokeProcedure({
        seed: SIGNER_SEED,
        contractIndex: SLOT,
        procedureId: PROCEDURE_ID,
        amount: 0,
        input: new Uint8Array(0),
        rpcBaseUrl: "http://node",
        rpc: new LiteRpc("http://node"),
        tick: TX_TICK,
        confirm: true,
        confirmTimeoutMs: 2000,
        trace,
        outputType: u64,
    });

const OUTPUT_42 = "2a00000000000000";

test("a traced procedure returns its own dispatch, decoded, and the callees that trapped under it", async () => {
    const signerHex = (await deriveIdentity(SIGNER_SEED)).publicKeyHex;
    devNode({
        // an older run of the same procedure by the same signer: before the armed seq, so never a candidate.
        before: [traceEntry({ seq: 4, invocator: signerHex, outHex: "0100000000000000" })],
        afterBroadcast: [
            traceEntry({ seq: 5, index: 29, kind: 1, entry: 7, ok: false, trap: "integer divide by zero" }),
            traceEntry({ seq: 6, index: 29, kind: 1, entry: 8 }),
            traceEntry({ seq: 7, invocator: "b".repeat(64), outHex: "0900000000000000" }),
            // the signer's own parallel call to the same procedure, landed one tick earlier.
            traceEntry({ seq: 8, tick: TX_TICK - 1, invocator: signerHex, outHex: "0300000000000000" }),
            traceEntry({ seq: 9, invocator: signerHex.toUpperCase(), outHex: OUTPUT_42 }),
            // a later tx of the same tick that trapped: after this dispatch, so not one of its callees.
            traceEntry({ seq: 10, index: 29, kind: 1, entry: 7, ok: false, trap: "unreachable" }),
        ],
    });

    try {
        const result = await invoke(true);

        expect(result).toMatchObject({ confirmed: true, included: true, output: 42n });
        expect(result.traceEntry?.seq).toBe(9);
        expect(result.failedCallees?.map((entry) => entry.seq)).toEqual([5]);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("a procedure that trapped carries its trace entry and no output", async () => {
    const signerHex = (await deriveIdentity(SIGNER_SEED)).publicKeyHex;
    devNode({ before: [], afterBroadcast: [traceEntry({ seq: 1, invocator: signerHex, ok: false, trap: "unreachable" })] });

    try {
        const result = await invoke(true);

        expect(result.traceEntry?.trap).toBe("unreachable");
        expect(result.output).toBeUndefined();
    } finally {
        globalThis.fetch = realFetch;
    }
});

test("without trace, or on a node that serves none, the result is the plain confirmation", async () => {
    const signerHex = (await deriveIdentity(SIGNER_SEED)).publicKeyHex;
    const entries = { before: [], afterBroadcast: [traceEntry({ seq: 1, invocator: signerHex, outHex: OUTPUT_42 })] };

    try {
        devNode(entries);
        const untraced = await invoke(false);
        expect(untraced).toMatchObject({ confirmed: true, included: true });
        expect(untraced.traceEntry).toBeUndefined();

        devNode({ ...entries, traceRoute: false });
        const unserved = await invoke(true);
        expect(unserved).toMatchObject({ confirmed: true, included: true });
        expect(unserved.traceEntry).toBeUndefined();
    } finally {
        globalThis.fetch = realFetch;
    }
});

// A halted node never processes the target tick; the fault is the answer, and a resend could run the tx twice after a restart.
test("a halted node is reported at once and the tx is never resent", async () => {
    const fault = { message: "slot 30 procedure 1 trapped", phase: "transaction", failedTick: TX_TICK, slot: SLOT };
    const node = devNode({ before: [], afterBroadcast: [], fault });

    try {
        const started = Date.now();
        const result = await invoke(true);

        expect(result).toMatchObject({ confirmed: false, fault });
        expect(result.included).toBeUndefined();
        expect(node.broadcastCount()).toBe(1);
        expect(Date.now() - started).toBeLessThan(1500);
    } finally {
        globalThis.fetch = realFetch;
    }
});
