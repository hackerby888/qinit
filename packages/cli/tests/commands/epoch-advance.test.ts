// The node ticks by itself between requests, so a boundary reached by the fast-forward may already have
// been crossed when the transition is requested; asking again would cross a second epoch.
import { expect, test } from "bun:test";
import { RpcTimeoutError, type LiteRpc } from "@qinit/core";
import { advanceEpochOrFault, crossEpoch } from "../../src/commands/node/epoch";

function node(epochNow: number) {
    let advances = 0;
    const rpc = {
        epochInfo: async () => ({
            epoch: epochNow,
            tick: epochNow * 3000,
            initialTick: epochNow * 3000,
            epochLastTick: epochNow * 3000 + 2999,
            ticksLeft: 2999,
            duration: 3000,
        }),
        advanceEpoch: async () => {
            advances++;
            return {
                fromEpoch: epochNow,
                toEpoch: epochNow + 1,
                fromTick: epochNow * 3000 + 2999,
                tick: (epochNow + 1) * 3000,
                initialTick: (epochNow + 1) * 3000,
                switched: true,
            };
        },
        faultInfo: async () => null,
    } as unknown as LiteRpc;
    return { rpc, advances: () => advances };
}

test("a node already in the next epoch is not advanced again", async () => {
    const { rpc, advances } = node(2);

    const r = await crossEpoch(rpc, 1);

    expect(r).toMatchObject({ fromEpoch: 1, toEpoch: 2, switched: true });
    expect(advances()).toBe(0);
});

test("a node still in the old epoch gets exactly one transition request", async () => {
    const { rpc, advances } = node(1);

    const r = await crossEpoch(rpc, 1);

    expect(r).toMatchObject({ fromEpoch: 1, toEpoch: 2, switched: true });
    expect(advances()).toBe(1);
});

test("a transition request that times out is followed up on the epoch route", async () => {
    let epoch = 1;
    const rpc = {
        epochInfo: async () => {
            const e = epoch;
            epoch = 2;
            return { epoch: e, tick: e * 3000, initialTick: e * 3000, epochLastTick: e * 3000 + 2999, ticksLeft: 2999, duration: 3000 };
        },
        advanceEpoch: async () => Promise.reject(new RpcTimeoutError("/live/v1/dev/advance-epoch", 30000)),
        faultInfo: async () => null,
    } as unknown as LiteRpc;

    const r = await advanceEpochOrFault(rpc, 1, 1);

    expect(r).toMatchObject({ fromEpoch: 1, toEpoch: 2, switched: true });
});

test("a timed-out transition that never switches reports switched:false instead of unreachable", async () => {
    const rpc = {
        epochInfo: async () => ({ epoch: 1, tick: 3000, initialTick: 3000, epochLastTick: 5999, ticksLeft: 2999, duration: 3000 }),
        advanceEpoch: async () => Promise.reject(new RpcTimeoutError("/live/v1/dev/advance-epoch", 30000)),
        faultInfo: async () => null,
    } as unknown as LiteRpc;

    const r = await advanceEpochOrFault(rpc, 1, 1, 5);

    expect(r.switched).toBe(false);
});
