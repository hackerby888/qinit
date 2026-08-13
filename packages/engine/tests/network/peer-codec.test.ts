// Peer-protocol codec — the pure wire layer. Asserts the 8-byte header round-trips, the request decoders read
// the protocol struct layouts, and the response encoders place fields at the offsets a client reads.
import { test, expect } from "bun:test";
import * as codec from "../../src/protocol/peer-codec";
import { MSG } from "../../src/protocol/peer-codec";

function dv(b: Uint8Array): DataView {
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

test("header: frame() then readHeader() round-trips size/type/dejavu", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const f = codec.frame(MSG.RESPOND_ENTITY, payload, 0xdeadbeef);
    const h = codec.readHeader(f)!;

    expect(h.type).toBe(MSG.RESPOND_ENTITY);
    expect(h.size).toBe(codec.HEADER_SIZE + payload.length);
    expect(h.dejavu).toBe(0xdeadbeef);
    expect(f.subarray(codec.HEADER_SIZE)).toEqual(payload);
});

test("readHeader returns null on a short buffer", () => {
    expect(codec.readHeader(new Uint8Array(4))).toBeNull();
});

test("handshake is an ExchangePublicPeers packet (type 0, 16-byte payload)", () => {
    const f = codec.exchangePublicPeers();
    const h = codec.readHeader(f)!;
    expect(h.type).toBe(MSG.EXCHANGE_PUBLIC_PEERS);
    expect(h.size).toBe(codec.HEADER_SIZE + 16);
});

test("decodeContractFunction reads contractIndex/inputType/input", () => {
    const p = new Uint8Array(8 + 3);
    const d = dv(p);
    d.setUint32(0, 28, true);
    d.setUint16(4, 1, true);
    d.setUint16(6, 3, true);
    p.set([9, 8, 7], 8);

    const req = codec.decodeContractFunction(p);
    expect(req.contractIndex).toBe(28);
    expect(req.inputType).toBe(1);
    expect(req.inputSize).toBe(3);
    expect(req.input).toEqual(new Uint8Array([9, 8, 7]));
});

test("tick request decoders require the full Core flag layouts", () => {
    const quorumRequest = new Uint8Array(codec.REQUEST_QUORUM_TICK_SIZE);
    dv(quorumRequest).setUint32(0, 123, true);
    quorumRequest[4 + (675 >> 3)] |= 1 << (675 & 7);

    const quorum = codec.decodeQuorumTickRequest(quorumRequest)!;
    expect(quorum.tick).toBe(123);
    expect(quorum.voteFlags.length).toBe(codec.QUORUM_VOTE_FLAGS_SIZE);
    expect(quorum.voteFlags[675 >> 3] & (1 << (675 & 7))).not.toBe(0);
    expect(codec.decodeQuorumTickRequest(new Uint8Array(89))).toBeNull();

    const transactionsRequest = new Uint8Array(codec.REQUEST_TICK_TRANSACTIONS_SIZE);
    dv(transactionsRequest).setUint32(0, 456, true);
    transactionsRequest[4 + (4095 >> 3)] |= 1 << (4095 & 7);

    const transactions = codec.decodeTickTransactionsRequest(transactionsRequest)!;
    expect(transactions.tick).toBe(456);
    expect(transactions.transactionFlags.length).toBe(codec.TICK_TRANSACTION_FLAGS_SIZE);
    expect(transactions.transactionFlags[4095 >> 3] & (1 << (4095 & 7))).not.toBe(0);
    expect(codec.decodeTickTransactionsRequest(new Uint8Array(4))).toBeNull();
});

test("decodeAssetsRequest reads modern filters and the short index request", () => {
    const issuer = new Uint8Array(32).fill(0x11);
    const possessor = new Uint8Array(32).fill(0x22);
    const filtered = new Uint8Array(112);
    const filteredData = dv(filtered);
    filteredData.setUint16(0, 2, true);
    filteredData.setUint16(
        2,
        codec.ASSET_REQUEST_FLAG.GET_SIBLINGS |
            codec.ASSET_REQUEST_FLAG.ANY_OWNER |
            codec.ASSET_REQUEST_FLAG.ANY_OWNERSHIP_MANAGING_CONTRACT,
        true,
    );
    filteredData.setUint16(6, 29, true);
    filtered.set(issuer, 8);
    filteredData.setBigUint64(40, 0x4e454b4f54n, true);
    filtered.set(possessor, 80);

    expect(codec.decodeAssetsRequest(filtered)).toEqual({
        kind: "possession",
        includeSiblings: true,
        issuer,
        name: 0x4e454b4f54n,
        owner: undefined,
        possessor,
        ownershipManagingContractIndex: undefined,
        possessionManagingContractIndex: 29,
    });

    const byIndex = new Uint8Array(8);
    const indexData = dv(byIndex);
    indexData.setUint16(0, 3, true);
    indexData.setUint32(4, 1234, true);
    expect(codec.decodeAssetsRequest(byIndex)).toEqual({
        kind: "index",
        includeSiblings: false,
        universeIndex: 1234,
    });
    expect(codec.decodeAssetsRequest(new Uint8Array(7))).toBeNull();
});

test("logging requests accept only the zero development passcode", () => {
    const logRequest = new Uint8Array(48);
    expect(codec.decodeRequestLog(logRequest)).not.toBeNull();
    logRequest[0] = 1;
    expect(codec.decodeRequestLog(logRequest)).toBeNull();

    const rangeRequest = new Uint8Array(40);
    expect(codec.decodeLogRangeRequest(rangeRequest)).not.toBeNull();
    rangeRequest[31] = 1;
    expect(codec.decodeLogRangeRequest(rangeRequest)).toBeNull();

    const tickRequest = new Uint8Array(36);
    expect(codec.decodeAllLogRangesRequest(tickRequest)).not.toBeNull();
    tickRequest[16] = 1;
    expect(codec.decodeAllLogRangesRequest(tickRequest)).toBeNull();
    expect(codec.decodeLogDigestRequest(tickRequest)).toBeNull();
});

test("encodeRespondEntity places balance fields at the EntityRecord offsets", () => {
    const id = new Uint8Array(32).fill(0x11);
    const enc = codec.encodeRespondEntity(
        id,
        {
            incomingAmount: 1000n,
            outgoingAmount: 250n,
            numberOfIncomingTransfers: 3,
            numberOfOutgoingTransfers: 1,
            latestIncomingTransferTick: 7,
            latestOutgoingTransferTick: 5,
        },
        42,
        0,
    );

    expect(enc.length).toBe(64 + 4 + 4 + codec.SPECTRUM_DEPTH * 32);
    const d = dv(enc);
    expect(enc.subarray(0, 32)).toEqual(id);
    expect(d.getBigInt64(32, true)).toBe(1000n);
    expect(d.getBigInt64(40, true)).toBe(250n);
    expect(d.getUint32(48, true)).toBe(3);
    expect(d.getUint32(64, true)).toBe(42); // tick
});

test("encodeRespondEntity writes the merkle-proof siblings at the spectrum offset", () => {
    const id = new Uint8Array(32).fill(0x11);
    const sib = Array.from({ length: 24 }, (_, i) => new Uint8Array(32).fill(i + 1));
    const enc = codec.encodeRespondEntity(
        id,
        {
            incomingAmount: 1n,
            outgoingAmount: 0n,
            numberOfIncomingTransfers: 1,
            numberOfOutgoingTransfers: 0,
            latestIncomingTransferTick: 0,
            latestOutgoingTransferTick: 0,
        },
        1,
        7,
        sib,
    );

    expect(dv(enc).getInt32(68, true)).toBe(7); // spectrumIndex
    expect(enc.subarray(72, 104)).toEqual(sib[0]); // first sibling @72
    expect(enc.subarray(72 + 23 * 32, 72 + 24 * 32)).toEqual(sib[23]); // last sibling
});

test("encodeCurrentTickInfo lays out tick/epoch/alignedVotes", () => {
    const enc = codec.encodeCurrentTickInfo({
        tickDuration: 1000,
        epoch: 2,
        tick: 123,
        numberOfAlignedVotes: 6,
        numberOfMisalignedVotes: 0,
        initialTick: 100,
    });
    const d = dv(enc);
    expect(enc.length).toBe(16);
    expect(d.getUint16(0, true)).toBe(1000);
    expect(d.getUint16(2, true)).toBe(2);
    expect(d.getUint32(4, true)).toBe(123);
    expect(d.getUint16(8, true)).toBe(6);
    expect(d.getUint32(12, true)).toBe(100);
});

test("encodeRespondOwnedAssets lays out the ownership + issuance records", () => {
    const owner = new Uint8Array(32).fill(0x22);
    const issuer = new Uint8Array(32).fill(0x33);
    const enc = codec.encodeRespondOwnedAssets({
        owner,
        issuer,
        name: "QTOKEN",
        decimals: 2,
        shares: 5000n,
        managingContractIndex: 29,
    });
    const d = dv(enc);

    expect(enc.length).toBe(48 + 48 + 4 + 4 + 24 * 32); // records + tick + universeIndex + ASSETS_DEPTH siblings
    // ownership record @0
    expect(enc.subarray(0, 32)).toEqual(owner);
    expect(enc[32]).toBe(2); // type = ownership
    expect(d.getUint16(34, true)).toBe(29); // managingContractIndex
    expect(d.getBigInt64(40, true)).toBe(5000n); // numberOfShares
    // issuance record @48
    expect(enc.subarray(48, 80)).toEqual(issuer);
    expect(enc[80]).toBe(1); // type = issuance
    expect(String.fromCharCode(...enc.subarray(81, 87))).toBe("QTOKEN"); // name @48+33
    expect(enc[88]).toBe(2); // numberOfDecimalPlaces @48+40
});

test("encodeRespondPossessedAssets lays out possession + ownership + issuance records", () => {
    const possessor = new Uint8Array(32).fill(0x22);
    const owner = new Uint8Array(32).fill(0x33);
    const issuer = new Uint8Array(32).fill(0x44);
    const enc = codec.encodeRespondPossessedAssets({
        possessor,
        owner,
        issuer,
        name: "QTOKEN",
        decimals: 2,
        shares: 700n,
        possessionManagingContract: 30,
        ownershipManagingContract: 28,
    });
    const d = dv(enc);

    expect(enc.length).toBe(48 + 48 + 48 + 4 + 4 + 24 * 32); // records + tick + universeIndex + ASSETS_DEPTH siblings
    // possession record @0
    expect(enc.subarray(0, 32)).toEqual(possessor);
    expect(enc[32]).toBe(3); // type = possession
    expect(d.getUint16(34, true)).toBe(30); // possession managing contract
    expect(d.getBigInt64(40, true)).toBe(700n);
    // ownership record @48
    expect(enc.subarray(48, 80)).toEqual(owner);
    expect(enc[80]).toBe(2); // type = ownership
    expect(d.getUint16(48 + 34, true)).toBe(28); // ownership managing contract
    // issuance record @96
    expect(enc.subarray(96, 128)).toEqual(issuer);
    expect(enc[128]).toBe(1); // type = issuance
    expect(String.fromCharCode(...enc.subarray(96 + 33, 96 + 39))).toBe("QTOKEN");
    expect(enc[96 + 40]).toBe(2); // numberOfDecimalPlaces
});

test("asset response encoders retain exact records, tick, index, and proof", () => {
    const possession = new Uint8Array(48).fill(0x31);
    const ownership = new Uint8Array(48).fill(0x42);
    const issuance = new Uint8Array(48).fill(0x53);
    const sibling = new Uint8Array(32).fill(0x64);

    const legacy = codec.encodeRespondPossessedAssets(
        {
            possessor: new Uint8Array(32),
            owner: new Uint8Array(32),
            issuer: new Uint8Array(32),
            name: "QX",
            decimals: 2,
            shares: 1n,
            possessionManagingContract: 9,
            ownershipManagingContract: 8,
            tick: 77,
            ownershipRecord: ownership,
            issuanceRecord: issuance,
        },
        123,
        [sibling],
        possession,
    );
    expect(legacy.subarray(0, 48)).toEqual(possession);
    expect(legacy.subarray(48, 96)).toEqual(ownership);
    expect(legacy.subarray(96, 144)).toEqual(issuance);
    expect(dv(legacy).getUint32(144, true)).toBe(77);
    expect(dv(legacy).getUint32(148, true)).toBe(123);
    expect(legacy.subarray(152, 184)).toEqual(sibling);

    const compact = codec.encodeRespondAssets({
        record: ownership,
        tick: 88,
        universeIndex: 456,
    });
    expect(compact).toHaveLength(56);
    expect(compact.subarray(0, 48)).toEqual(ownership);
    expect(dv(compact).getUint32(48, true)).toBe(88);
    expect(dv(compact).getUint32(52, true)).toBe(456);

    const withProof = codec.encodeRespondAssets({
        record: issuance,
        tick: 99,
        universeIndex: 789,
        siblings: [sibling],
    });
    expect(withProof).toHaveLength(56 + codec.ASSETS_DEPTH * 32);
    expect(withProof.subarray(56, 88)).toEqual(sibling);
});

test("encodeTxStatus sets the moneyFlew bitmask + packs the digests", () => {
    const a = new Uint8Array(32).fill(0xaa);
    const b = new Uint8Array(32).fill(0xbb);
    const enc = codec.encodeTxStatus(50, 48, [a, b], [true, false]);
    const flagBytes = (codec.TXS_PER_TICK + 7) >> 3;
    const d = dv(enc);

    expect(d.getUint32(0, true)).toBe(50); // currentTick
    expect(d.getUint32(4, true)).toBe(48); // tick
    expect(d.getUint32(8, true)).toBe(2); // txCount
    expect(enc[12] & 1).toBe(1); // tx0 moneyFlew
    expect(enc[12] & 2).toBe(0); // tx1 not
    expect(enc.subarray(12 + flagBytes, 12 + flagBytes + 32)).toEqual(a);
});
