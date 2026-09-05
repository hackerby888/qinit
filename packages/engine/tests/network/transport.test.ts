// Exercises NodeTransport through real codecs, signed transactions, and deploy wire data.
import { test, expect } from "bun:test";
import { buildSignedTx, k12Hex, deriveIdentity, identityToBytes, LITE_DEPLOY_ADDRESS } from "@qinit/core";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import {
    encodeInput,
    decodeOutput,
    contractAddress,
    encodeUploadBegin,
    encodeUploadChunk,
    encodeDeploy,
    splitUploadChunks,
    createUploadSessionId,
    LITE_TX,
} from "@qinit/proto";
import { VirtualNode } from "../../src/transport";

const SEED = "a".repeat(55);
const UNSIGNED_SOURCE = new Uint8Array(32).fill(0x99);
const ORACLE = "4b31b54f2213f1396cec4a1bd633b9409112d5969592c2c5fa66ddc1656f63c9";

// Build an unsigned canonical transaction for deploy-wire tests with real header offsets.
function wrapTx(inputType: number, payload: Uint8Array, destination: Uint8Array = LITE_DEPLOY_ADDRESS, tick = 10): Uint8Array {
    const b = new Uint8Array(80 + payload.length + 64);
    const v = new DataView(b.buffer);
    b.set(UNSIGNED_SOURCE, 0);
    b.set(destination, 32);
    v.setUint32(72, tick, true);
    v.setUint16(76, inputType, true);
    v.setUint16(78, payload.length, true);
    b.set(payload, 80);
    return b;
}

test("seam: qinit codec + a REAL signed tx drive the in-process engine (Counter)", async () => {
    const eng = await VirtualNode.create({ mempool: false }); // assert apply immediately (not mempool scheduling)
    await eng.seedFaucet();
    eng.deploy(28, await wasm("Counter"), "Counter");

    // The registry exposes the entry input types used by deployment and clients.
    const reg = await eng.dynRegistry();
    const c = reg.contracts.find((x) => x.index === 28)!;
    expect(c.armed && c.constructed).toBe(true);
    expect(c.name).toBe("Counter");
    expect(c.functions.map((f) => f.inputType)).toContain(1);
    expect(c.procedures.map((p) => p.inputType)).toContain(1);

    // Get (function) via querySmartContract + the real proto decode
    expect(await decodeOutput(await eng.querySmartContract(28, 1, await encodeInput("")), "uint64")).toBe(0n);

    // Inc (procedure) via a REAL @qubic-lib signed tx -> broadcastTx (validates the engine decodes the real wire)
    const tx = await buildSignedTx(SEED, {
        destination: contractAddress(28),
        amount: 0,
        tick: 10,
        inputType: 1,
        payload: await encodeInput(""),
    });
    expect((await eng.broadcastTx(tx.bytes)).ok).toBe(true);

    expect(await decodeOutput(await eng.querySmartContract(28, 1, await encodeInput("")), "uint64")).toBe(1n);
});

test("seam: deploy via the UPLOAD_BEGIN/CHUNK/DEPLOY wire protocol (DigestProbe -> oracle)", async () => {
    const eng = await VirtualNode.create({
        mempool: false,
        verifySigs: false,
    });
    const so = await wasm("DigestProbe");
    const finalHashHex = await k12Hex(so);
    const sessionId = createUploadSessionId();
    const chunks = splitUploadChunks(so);

    await eng.broadcastTx(
        wrapTx(
            LITE_TX.UPLOAD_BEGIN,
            encodeUploadBegin({
                sessionId,
                totalSize: so.length,
                chunkCount: chunks.length,
                finalHashHex,
            }),
        ),
    );
    for (let i = 0; i < chunks.length; i++) await eng.broadcastTx(wrapTx(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId, seq: i, bytes: chunks[i] })));
    expect((await eng.dynUpload()).complete).toBe(true);

    await eng.broadcastTx(wrapTx(LITE_TX.DEPLOY, encodeDeploy({ sessionId, targetSlot: 29, finalHashHex, name: "DigestProbe" })));
    const reg = await eng.dynRegistry();
    expect(reg.contracts.find((x) => x.index === 29)?.constructed).toBe(true);
    expect(reg.contracts.find((x) => x.index === 29)?.name).toBe("DigestProbe");

    // Exercise the wire-deployed contract + reproduce the cross-platform digest oracle through the seam.
    expect(await decodeOutput(await eng.querySmartContract(29, 1, await encodeInput("")), "uint64")).toBe(0n);
    eng.fund(UNSIGNED_SOURCE, 1n);
    await eng.broadcastTx(wrapTx(1, new Uint8Array(0), contractAddress(29))); // Inc (procedure it=1)
    expect(await decodeOutput(await eng.querySmartContract(29, 1, await encodeInput("")), "uint64")).toBe(1n);
    expect(eng.sim.digest(29)).toBe(ORACLE);
});

test("an upload session idle past the stale limit gives way to a new one", async () => {
    const eng = await VirtualNode.create({
        mempool: false,
        verifySigs: false,
    });
    const so = await wasm("DigestProbe");
    const finalHashHex = await k12Hex(so);
    const chunks = splitUploadChunks(so);
    // Every tx is scheduled just ahead of the node so the advanced clock never makes it stale.
    const tx = (inputType: number, payload: Uint8Array) => wrapTx(inputType, payload, LITE_DEPLOY_ADDRESS, eng.sim.currentTick + 1);
    const begin = (sessionId: bigint) => eng.broadcastTx(tx(LITE_TX.UPLOAD_BEGIN, encodeUploadBegin({ sessionId, totalSize: so.length, chunkCount: chunks.length, finalHashHex })));

    await begin(11n);
    await eng.broadcastTx(tx(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId: 11n, seq: 0, bytes: chunks[0] })));
    const started = await eng.dynUpload();
    expect(started.receivedCount).toBe(1);
    expect(started.staleAfterTicks).toBe(32);

    // At the limit the first session still owns the slot and the second is refused.
    eng.advanceTick(32);
    expect((await eng.dynUpload()).idleTicks).toBe(32);
    expect((await begin(22n)).ok).toBe(false);
    expect((await eng.dynUpload()).sessionId).toBe("11");

    // One tick later it is abandoned and the second session takes over from scratch.
    eng.advanceTick(1);
    expect((await eng.dynUpload()).active).toBe(false);
    expect((await begin(22n)).ok).toBe(true);
    const replaced = await eng.dynUpload();
    expect(replaced.sessionId).toBe("22");
    expect(replaced.receivedCount).toBe(0);
    expect(replaced.idleTicks).toBe(0);
});

test("deployment routing requires the exact reserved address", async () => {
    const eng = await VirtualNode.create({
        mempool: false,
        verifySigs: false,
    });
    const otherAddress = LITE_DEPLOY_ADDRESS.slice();
    otherAddress[8] = 1;

    await eng.broadcastTx(
        wrapTx(
            LITE_TX.UPLOAD_BEGIN,
            encodeUploadBegin({
                sessionId: 1n,
                totalSize: 1,
                chunkCount: 1,
                finalHashHex: "00".repeat(32),
            }),
            otherAddress,
        ),
    );

    expect((await eng.dynUpload()).active).toBe(false);
});

test("UPLOAD_BEGIN keeps the active session across retries and rejects a different session", async () => {
    const eng = await VirtualNode.create({ mempool: false });
    const first = 11n;
    const begin = (sessionId: bigint, totalSize: number, chunkCount: number, hash: string) =>
        (eng as any).handleDeployTx(LITE_TX.UPLOAD_BEGIN, encodeUploadBegin({ sessionId, totalSize, chunkCount, finalHashHex: hash }));

    begin(first, 2017, 3, "11".repeat(32));
    (eng as any).handleDeployTx(
        LITE_TX.UPLOAD_CHUNK,
        encodeUploadChunk({
            sessionId: first,
            seq: 0,
            bytes: new Uint8Array(1008).fill(1),
        }),
    );
    const active = (eng as any).upload;
    const buffer = [...active.buf];

    expect(() =>
        (eng as any).handleDeployTx(
            LITE_TX.UPLOAD_CHUNK,
            encodeUploadChunk({
                sessionId: first,
                seq: 0,
                bytes: new Uint8Array(1008).fill(2),
            }),
        ),
    ).toThrow("upload chunk 0 is out of order; expected 1");
    expect(() =>
        (eng as any).handleDeployTx(
            LITE_TX.UPLOAD_CHUNK,
            encodeUploadChunk({
                sessionId: first,
                seq: 2,
                bytes: new Uint8Array(1).fill(3),
            }),
        ),
    ).toThrow("upload chunk 2 is out of order; expected 1");

    expect(() => begin(first, 4, 1, "22".repeat(32))).not.toThrow();
    expect((eng as any).upload).toBe(active);
    expect(await eng.dynUpload()).toMatchObject({
        sessionId: "11",
        totalSize: 2017,
        chunkCount: 3,
        receivedCount: 1,
        finalHash: "11".repeat(32),
    });
    expect([...(eng as any).upload.buf]).toEqual(buffer);

    expect(() => begin(22n, 4, 1, "22".repeat(32))).toThrow("another contract upload is active (session 11, 1/3 chunks); wait for it to complete");
    expect((eng as any).upload).toBe(active);
    expect([...(eng as any).upload.buf]).toEqual(buffer);
    expect((await eng.dynUpload()).receivedCount).toBe(1);
});

test("deployment sessions reject oversized modules, malformed chunks, and mismatched hashes", async () => {
    const engine = new VirtualNode({ verifySigs: false });
    const handle = (inputType: number, payload: Uint8Array) => (engine as any).handleDeployTx(inputType, payload);

    expect(() =>
        handle(
            LITE_TX.UPLOAD_BEGIN,
            encodeUploadBegin({
                sessionId: 1n,
                totalSize: 4 * 1024 * 1024 + 1,
                chunkCount: 4162,
                finalHashHex: "00".repeat(32),
            }),
        ),
    ).toThrow("module size must be between");

    const artifact = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
    const finalHashHex = await k12Hex(artifact);
    handle(
        LITE_TX.UPLOAD_BEGIN,
        encodeUploadBegin({
            sessionId: 2n,
            totalSize: artifact.length,
            chunkCount: 1,
            finalHashHex,
        }),
    );
    const malformedChunk = encodeUploadChunk({
        sessionId: 2n,
        seq: 0,
        bytes: artifact,
    }).slice(0, -1);
    expect(() => handle(LITE_TX.UPLOAD_CHUNK, malformedChunk)).toThrow("invalid length");

    handle(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId: 2n, seq: 0, bytes: artifact }));
    expect(() =>
        handle(
            LITE_TX.DEPLOY,
            encodeDeploy({
                sessionId: 2n,
                targetSlot: 29,
                finalHashHex: "ff".repeat(32),
            }),
        ),
    ).toThrow("deploy hash does not match");
});

test("signature verification (opt-in): valid signed tx accepted, tampered one rejected", async () => {
    const eng = await VirtualNode.create({ verifySigs: true, mempool: false }); // assert apply immediately
    await eng.seedFaucet();
    eng.deploy(28, await wasm("Counter"), "Counter");

    const tx = await buildSignedTx(SEED, {
        destination: contractAddress(28),
        amount: 0,
        tick: 10,
        inputType: 1,
        payload: await encodeInput(""),
    });
    expect((await eng.broadcastTx(tx.bytes)).ok).toBe(true);
    expect(await decodeOutput(await eng.querySmartContract(28, 1, await encodeInput("")), "uint64")).toBe(1n); // applied

    const bad = tx.bytes.slice();
    bad[bad.length - 1] ^= 0xff; // flip a signature byte
    const r = await eng.broadcastTx(bad);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("invalid signature");
});

test("broadcastTx reports moneyFlew + queued for an applied transfer (the IDE reads r.moneyFlew)", async () => {
    const eng = await VirtualNode.create({ mempool: false, fees: "off" }); // applied now, no fee gate
    const dest = new Uint8Array(32).fill(0x55);

    eng.sim.fund(identityToBytes((await deriveIdentity(SEED)).identity), 1000n); // fund the sender
    const funded = await buildSignedTx(SEED, {
        destination: dest,
        amount: 100,
        tick: 10,
        inputType: 0,
        payload: new Uint8Array(0),
    });
    const r = await eng.broadcastTx(funded.bytes);
    expect(r.ok).toBe(true);
    expect(r.queued).toBe(false); // mempool:false -> the tx is applied at broadcast, not queued
    expect(r.moneyFlew).toBe(true); // the 100 qu actually moved

    const broke = await buildSignedTx("c".repeat(55), {
        destination: dest,
        amount: 100,
        tick: 10,
        inputType: 0,
        payload: new Uint8Array(0),
    });
    expect((await eng.broadcastTx(broke.bytes)).moneyFlew).toBe(false); // unfunded sender -> no money moved
});

test("VirtualNode exposes the simulator's direct procedure, query, and digest operations", async () => {
    const eng = await VirtualNode.create({ fees: "off" });
    eng.deploy(28, await wasm("Counter"), "Counter");

    expect(await decodeOutput(eng.query(28, 1), "uint64")).toBe(0n);
    eng.procedure(28, 1); // direct Inc (instant, no signing)
    expect(await decodeOutput(eng.query(28, 1), "uint64")).toBe(1n);

    // they delegate to the same engine -> byte-identical to reaching into eng.sim
    expect(eng.query(28, 1)).toEqual(eng.sim.query(28, 1));
    expect(eng.getComputerDigest()).toEqual(eng.sim.getComputerDigest());
    expect(eng.getSpectrumDigest()).toEqual(eng.sim.getSpectrumDigest());
    expect(eng.getUniverseDigest()).toEqual(eng.sim.getUniverseDigest());
});

test("stateRead avoids copying the full contract state", async () => {
    const eng = await VirtualNode.create({ fees: "off" });
    const contract = eng.deploy(28, await wasm("Counter"), "Counter");
    contract.writeState(new Uint8Array([1, 2, 3, 4]));
    contract.state = () => {
        throw new Error("full state snapshot requested");
    };

    expect(await eng.stateRead(28, 1, 2)).toEqual({
        off: 1,
        len: 2,
        stateSize: contract.stateSize,
        hex: "0203",
    });
});

test("fund + balance accept either an id string or raw bytes (unified id type)", async () => {
    const eng = await VirtualNode.create({ fees: "off" });
    const idStr = (await deriveIdentity(SEED)).identity;
    const idBytes = identityToBytes(idStr);

    eng.fund(idBytes, 500n); // fund by bytes
    expect((await eng.balance(idStr)).balance).toBe("500"); // read by string

    eng.fund(idStr, 250n); // fund by string (adds)
    const b = await eng.balance(idBytes); // read by bytes
    expect(b.balance).toBe("750");
    expect(b.id).toBe(idStr); // bytes input -> canonical identity in the response
});

test("engine emits a diagnostic log stream (deploy/tick/tx events via onLog)", async () => {
    const eng = await VirtualNode.create({ mempool: false, fees: "off" });
    const ev: { level: string; cat: string; msg: string }[] = [];
    eng.onLog = (e) => ev.push(e);

    eng.deploy(28, await wasm("Counter"), "Counter");
    expect(ev.some((e) => e.cat === "deploy" && e.level === "info")).toBe(true);

    eng.advanceTick(1);
    expect(ev.some((e) => e.cat === "tick" && e.level === "debug" && /begin/.test(e.msg))).toBe(true);
    expect(ev.some((e) => e.cat === "tick" && /end/.test(e.msg))).toBe(true);

    ev.length = 0;
    const tx = await buildSignedTx(SEED, {
        destination: contractAddress(28),
        amount: 0,
        tick: 10,
        inputType: 1,
        payload: await encodeInput(""),
    });
    await eng.broadcastTx(tx.bytes);
    expect(ev.some((e) => e.cat === "tx" && e.level === "info")).toBe(true);

    // Unset = no-op: a fresh node with no subscriber doesn't throw.
    const quiet = await VirtualNode.create({ mempool: false, fees: "off" });
    quiet.deploy(28, await wasm("Counter"), "Counter");
    quiet.advanceTick(1);
    expect(true).toBe(true);
});

test("transaction records and raw bytes share the finalized tick history window", async () => {
    const engine = await VirtualNode.create({
        historyTicks: 2,
    });
    await engine.seedFaucet();
    const transaction = await buildSignedTx(SEED, {
        destination: new Uint8Array(32).fill(0x44),
        amount: 1,
        tick: 1,
        inputType: 0,
        payload: new Uint8Array(0),
    });
    const result = await engine.broadcastTx(transaction.bytes);
    const transactionId = result.transactionId!;

    expect(result.ok).toBe(true);
    expect(transactionId).toBe(transaction.id);
    engine.advanceTick(1);
    expect(engine.rawTx(transactionId)).toEqual(transaction.bytes);
    expect(engine.sim.txByHash(transactionId)).toBeDefined();

    engine.advanceTick(2);
    expect(engine.rawTx(transactionId)).toBeUndefined();
    expect(engine.sim.txByHash(transactionId)).toBeUndefined();
});

test("a fault hides raw and indexed transactions from its unfinalized tick", async () => {
    const engine = await VirtualNode.create({ verifySigs: false });
    engine.deploy(28, await wasm("Trap"), "Trap");
    engine.fund(UNSIGNED_SOURCE, 1n);

    const first = wrapTx(0, new Uint8Array(0), new Uint8Array(32).fill(0x77));
    new DataView(first.buffer).setUint32(72, 1, true);

    const trapInput = new Uint8Array(16);
    const trapData = new DataView(trapInput.buffer);
    trapData.setBigUint64(0, 7n, true);
    trapData.setBigUint64(8, 0n, true);
    const second = wrapTx(2, trapInput, contractAddress(28));
    new DataView(second.buffer).setUint32(72, 1, true);

    const firstResult = await engine.broadcastTx(first);
    const secondResult = await engine.broadcastTx(second);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(engine.rawTx(firstResult.transactionId!)).toBeDefined();

    expect(() => engine.advanceTick(1)).toThrow();
    expect(engine.sim.faultInfo()?.txId).toBe(secondResult.transactionId);
    expect(engine.rawTx(firstResult.transactionId!)).toBeUndefined();
    expect(await engine.tickTransactions(1)).toEqual([]);
    expect(await engine.txStatus(1, firstResult.transactionId!)).toMatchObject({
        found: false,
        moneyFlew: false,
    });
});

test("a post-fault broadcast is not blamed for an earlier fault", async () => {
    const engine = await VirtualNode.create({ verifySigs: false });
    engine.deploy(28, await wasm("Trap"), "Trap");
    const input = new Uint8Array(16);
    new DataView(input.buffer).setBigUint64(0, 1n, true);

    expect(() => engine.sim.procedure(28, 2, input)).toThrow();
    expect(engine.sim.faultInfo()?.txId).toBeUndefined();

    await expect(engine.broadcastTx(wrapTx(0, new Uint8Array(0)))).rejects.toThrow();
    expect(engine.sim.faultInfo()?.txId).toBeUndefined();
});
