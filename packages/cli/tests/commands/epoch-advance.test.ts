// The node ticks by itself between requests, so a boundary reached by the fast-forward may already have
// been crossed when the transition is requested; asking again would cross a second epoch.
import { expect, test } from "bun:test";
import type { LiteRpc } from "@qinit/core";
import { crossEpoch } from "../../src/commands/node/epoch";

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
