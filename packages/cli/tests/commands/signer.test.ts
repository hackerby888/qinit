import { expect, test } from "bun:test";
import { deriveIdentity } from "@qinit/core";
import { insufficientBalanceMessage, resolveFundedSigner, unfundedSignerMessage, type SignerRpc } from "../../src/ops/signer";

const saved = "b".repeat(55);
const funded = "c".repeat(55);

// Only the funded seed's identity carries a balance; everything else reads as an empty entity.
function balanceRpc(balances: Record<string, string>): SignerRpc {
    return {
        fundedSeed: async () => funded,
        balance: async (id: string) => ({ balance: balances[id] ?? "0" }) as any,
    };
}

async function identityOf(seed: string) {
    return (await deriveIdentity(seed)).identity;
}

test("a funded seed is used as it stands", async () => {
    const identity = await identityOf(saved);
    const signer = await resolveFundedSigner(balanceRpc({ [identity]: "100" }), saved);

    expect(signer).toEqual({ seed: saved, identity, balance: "100" });
});

test("an empty seed falls back to the node's funded one", async () => {
    const fundedIdentity = await identityOf(funded);
    const signer = await resolveFundedSigner(balanceRpc({ [fundedIdentity]: "10000000000" }), saved);

    expect(signer).toEqual({
        seed: funded,
        identity: fundedIdentity,
        balance: "10000000000",
        switched: true,
    });
});

// A seed the user typed is their choice — report it rather than signing as somebody else.
test("an explicit empty seed is reported instead of swapped", async () => {
    const fundedIdentity = await identityOf(funded);
    const signer = await resolveFundedSigner(balanceRpc({ [fundedIdentity]: "10000000000" }), saved, {
        explicit: true,
    });

    expect(signer.seed).toBe(saved);
    expect(signer.switched).toBeUndefined();
    expect(signer.unfunded).toBe(true);
});

test("an empty seed with no funded alternative reports unfunded", async () => {
    const identity = await identityOf(saved);

    expect(await resolveFundedSigner(balanceRpc({}), saved)).toEqual({
        seed: saved,
        identity,
        balance: "0",
        unfunded: true,
    });

    // A node without the funded-seed route is the same case.
    const noFundedRoute: SignerRpc = {
        fundedSeed: async () => undefined,
        balance: async () => ({ balance: "0" }) as any,
    };
    expect((await resolveFundedSigner(noFundedRoute, saved)).unfunded).toBe(true);
});

// An unreadable balance says nothing about the seed, so it must not redirect or block the caller.
test("a node that cannot answer leaves the seed alone", async () => {
    const rpc: SignerRpc = {
        fundedSeed: async () => funded,
        balance: async () => {
            throw new Error("balances route unavailable");
        },
    };
    const signer = await resolveFundedSigner(rpc, saved);

    expect(signer).toEqual({ seed: saved, identity: await identityOf(saved) });
});

test("the message names the identity and both ways out", async () => {
    const message = unfundedSignerMessage("BZBQFLLB");

    expect(message).toContain("BZBQFLLB");
    expect(message).toContain("qinit seed");
    expect(message).toContain("--seed");
});

test("the balance message names both amounts and the way out", () => {
    const message = insufficientBalanceMessage("ID", "50", 100n);

    expect(message).toContain("holds 50 qu, below the 100 qu --amount");
    expect(message).toContain("Lower --amount or fund the signer");
});
