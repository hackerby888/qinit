// The wasm iterator's host side walks the ledger one record at a time from the indices the contract holds, so a walk
// has no record cap: the old bulk enumeration stopped silently at 1024.
import { test, expect, beforeAll } from "bun:test";
import { initK12 } from "../../src/support/k12";
import { AssetLedger, NO_ASSET_INDEX } from "../../src/ledger/assets";
import { contractId } from "../support/helpers";

beforeAll(async () => {
    await initK12();
});

const NAME = 0x5851n;
const HOLDERS = 1100;

function holderId(index: number): Uint8Array {
    const id = new Uint8Array(32);
    id[0] = index & 0xff;
    id[1] = (index >> 8) & 0xff;
    id[2] = 0x77;
    return id;
}

// anyId + anyMgmt, the wire shape of AssetOwnershipSelect::any().
function anySelect(): Uint8Array {
    const select = new Uint8Array(36);
    select[34] = 1;
    select[35] = 1;
    return select;
}

test("a begin/next walk visits every holder past the old 1024-record cap, in the same order as enumerate", () => {
    const ledger = new AssetLedger({ contractId });
    const issuer = contractId(1);
    ledger.issueAsset(1, NAME, issuer, 0, BigInt(HOLDERS * 2), 0n, issuer);
    for (let index = 1; index <= HOLDERS; index++) {
        ledger.transferShareOwnershipAndPossession(1, NAME, issuer, issuer, issuer, 1n, holderId(index));
    }

    const asset = new Uint8Array(40);
    asset.set(issuer, 0);
    new DataView(asset.buffer).setBigUint64(32, NAME, true);

    const walked: bigint[] = [];
    let position = ledger.iterBegin(0, asset, anySelect(), anySelect());
    while (position.ownershipIndex !== NO_ASSET_INDEX) {
        const entry = ledger.iterRecord(0, position.ownershipIndex, NO_ASSET_INDEX)!;
        walked.push(BigInt(entry.owner[0] | (entry.owner[1] << 8)));
        const step = ledger.iterNext(0, position, anySelect(), anySelect());
        expect(step.selected).toBe(step.position.ownershipIndex !== NO_ASSET_INDEX);
        position = step.position;
    }

    const enumerated = ledger.enumerate(asset, anySelect(), anySelect(), 0).map((entry) => BigInt(entry.owner[0] | (entry.owner[1] << 8)));
    expect(walked).toHaveLength(HOLDERS + 1);
    expect(walked).toEqual(enumerated);
});

test("a possession walk resumes across ownerships and ends when the indices name nothing", () => {
    const ledger = new AssetLedger({ contractId });
    const issuer = contractId(1);
    ledger.issueAsset(1, NAME, issuer, 0, 1000n, 0n, issuer);
    ledger.transferShareOwnershipAndPossession(1, NAME, issuer, issuer, issuer, 300n, holderId(1));

    const asset = new Uint8Array(40);
    asset.set(issuer, 0);
    new DataView(asset.buffer).setBigUint64(32, NAME, true);

    const shares: bigint[] = [];
    let position = ledger.iterBegin(1, asset, anySelect(), anySelect());
    while (position.possessionIndex !== NO_ASSET_INDEX) {
        shares.push(ledger.iterRecord(1, position.ownershipIndex, position.possessionIndex)!.shares);
        position = ledger.iterNext(1, position, anySelect(), anySelect()).position;
    }
    expect(shares.sort()).toEqual([300n, 700n]);

    // an ended possession walk stays ended, and an index outside the universe ends an ownership walk
    const ended = ledger.iterNext(1, position, anySelect(), anySelect());
    expect(ended.selected).toBe(false);
    expect(ended.position.ownershipIndex).toBe(NO_ASSET_INDEX);
    const corrupt = ledger.iterNext(0, { ...position, ownershipIndex: 1 << 30 }, anySelect(), anySelect());
    expect(corrupt.selected).toBe(false);
    expect(ledger.iterRecord(0, 1 << 30, NO_ASSET_INDEX)).toBeNull();
});
