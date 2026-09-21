// Exercises NodeTransport through real codecs, signed transactions, and deploy wire data.
import { test, expect } from "bun:test";
import { buildSignedTx, k12Hex, deriveIdentity, identityToBytes, LITE_DEPLOY_ADDRESS } from "@qinit/core";
import { compileContractWithTypeScript } from "@qinit/compiler/browser";
import { loadWasmFixture as wasm, wasmFixtureManifest } from "../../../../test-utils/wasm-fixtures";
import { TEST_SLOT_LAYOUT } from "../../../../test-utils/slot-layout";
import {
    encodeInputFormat,
    decodeAbi,
    contractAddress,
    encodeUploadBegin,
    encodeUploadChunk,
    encodeDeploy,
    splitUploadChunks,
    createUploadSessionId,
    LITE_TX,
} from "@qinit/proto";
import { CORE_IO_CAPACITY_BYTES } from "@qinit/core/wasm/sizing";
import { VirtualNode } from "../../src/transport";

const SEED = "a".repeat(55);
const UNSIGNED_SOURCE = new Uint8Array(32).fill(0x99);
const ORACLE = "4b31b54f2213f1396cec4a1bd633b9409112d5969592c2c5fa66ddc1656f63c9";
// The first dynamic slot of the live core headers, where a wire deploy lands.
const DYN = TEST_SLOT_LAYOUT.slotBase;

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
    expect(await decodeAbi(await eng.querySmartContract(28, 1, await encodeInputFormat("")), "uint64")).toBe(0n);

    // Inc (procedure) via a REAL @qubic-lib signed tx -> broadcastTx (validates the engine decodes the real wire)
    const tx = await buildSignedTx(SEED, {
        destination: contractAddress(28),
        amount: 0,
        tick: 10,
        inputType: 1,
        payload: await encodeInputFormat(""),
    });
    expect((await eng.broadcastTx(tx.bytes)).ok).toBe(true);

    expect(await decodeAbi(await eng.querySmartContract(28, 1, await encodeInputFormat("")), "uint64")).toBe(1n);
});

test("seam: deploy via the UPLOAD_BEGIN/CHUNK/DEPLOY wire protocol (DigestProbe -> oracle)", async () => {
    const eng = await VirtualNode.create({
        ...TEST_SLOT_LAYOUT,
        mempool: false,
        verifySigs: false,
    });
    const so = await wasm("DigestProbeDyn0");
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

    await eng.broadcastTx(wrapTx(LITE_TX.DEPLOY, encodeDeploy({ sessionId, targetSlot: DYN, finalHashHex, name: "DigestProbe" })));
    // a DEPLOY arms the slot in its own tick; INITIALIZE runs at the head of the next one, as on a core node.
    expect((await eng.dynRegistry()).contracts.find((x) => x.index === DYN)).toMatchObject({ armed: true, constructed: false, name: "DigestProbe" });
    eng.sim.advance();
    expect((await eng.dynRegistry()).contracts.find((x) => x.index === DYN)?.constructed).toBe(true);

    // Exercise the wire-deployed contract + reproduce the cross-platform digest oracle through the seam.
    expect(await decodeAbi(await eng.querySmartContract(DYN, 1, await encodeInputFormat("")), "uint64")).toBe(0n);
    eng.fund(UNSIGNED_SOURCE, 1n);
    await eng.broadcastTx(wrapTx(1, new Uint8Array(0), contractAddress(DYN))); // Inc (procedure it=1)
    expect(await decodeAbi(await eng.querySmartContract(DYN, 1, await encodeInputFormat("")), "uint64")).toBe(1n);
    expect(eng.sim.digest(DYN)).toBe(ORACLE);
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
    const begin = (sessionId: bigint) =>
        eng.broadcastTx(tx(LITE_TX.UPLOAD_BEGIN, encodeUploadBegin({ sessionId, totalSize: so.length, chunkCount: chunks.length, finalHashHex })));

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

test("a refused deploy frees the upload session, so the next one needs no stale wait", async () => {
    const eng = await VirtualNode.create({ ...TEST_SLOT_LAYOUT, mempool: false, verifySigs: false });
    const junk = new Uint8Array(64).fill(0x7f); // no '\0asm' magic -> the load path refuses it
    const finalHashHex = await k12Hex(junk);
    const chunks = splitUploadChunks(junk);
    const begin = (sessionId: bigint) =>
        eng.broadcastTx(wrapTx(LITE_TX.UPLOAD_BEGIN, encodeUploadBegin({ sessionId, totalSize: junk.length, chunkCount: chunks.length, finalHashHex })));

    expect((await begin(11n)).ok).toBe(true);
    await eng.broadcastTx(wrapTx(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId: 11n, seq: 0, bytes: chunks[0] })));
    const refused = await eng.broadcastTx(wrapTx(LITE_TX.DEPLOY, encodeDeploy({ sessionId: 11n, targetSlot: DYN, finalHashHex, name: "Junk" })));
    expect(refused.ok).toBe(false);

    // core drops the session once it has tried to load, so a second upload starts in the same tick — no advanceTick here.
    const afterRefusal = await eng.dynUpload();
    expect(afterRefusal.lastDeploy?.code).toBe("not-wasm");
    expect(afterRefusal.active).toBe(false);
    expect((await begin(22n)).ok).toBe(true);
    expect((await eng.dynUpload()).sessionId).toBe("22");

    // the other load-path refusal: a real module compiled for a different slot, which only fails once the loader reads it.
    const wrongSlot = await wasm("Counter");
    const wrongSlotHashHex = await k12Hex(wrongSlot);
    const wrongSlotChunks = splitUploadChunks(wrongSlot);
    eng.advanceTick(33); // retire session 22 so this one can start
    await eng.broadcastTx(
        wrapTx(
            LITE_TX.UPLOAD_BEGIN,
            encodeUploadBegin({ sessionId: 33n, totalSize: wrongSlot.length, chunkCount: wrongSlotChunks.length, finalHashHex: wrongSlotHashHex }),
            LITE_DEPLOY_ADDRESS,
            eng.sim.currentTick + 1,
        ),
    );
    for (let i = 0; i < wrongSlotChunks.length; i++) {
        await eng.broadcastTx(
            wrapTx(
                LITE_TX.UPLOAD_CHUNK,
                encodeUploadChunk({ sessionId: 33n, seq: i, bytes: wrongSlotChunks[i] }),
                LITE_DEPLOY_ADDRESS,
                eng.sim.currentTick + 1,
            ),
        );
    }
    const loadFailed = await eng.broadcastTx(
        wrapTx(
            LITE_TX.DEPLOY,
            encodeDeploy({ sessionId: 33n, targetSlot: DYN, finalHashHex: wrongSlotHashHex, name: "Counter" }),
            LITE_DEPLOY_ADDRESS,
            eng.sim.currentTick + 1,
        ),
    );
    expect(loadFailed.ok).toBe(false);
    const afterLoadFailure = await eng.dynUpload();
    expect(afterLoadFailure.lastDeploy?.code).toBe("load-failed");
    expect(afterLoadFailure.active).toBe(false);
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
    ).toThrow("upload chunk 0 was already received");

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

// every chunk of a module is signed for one tick, and nothing promises the node meets them in the order they were sent.
test("upload chunks land in any order", async () => {
    const eng = await VirtualNode.create({ mempool: false });
    const session = 12n;
    const chunk = (seq: number, bytes: Uint8Array) => (eng as any).handleDeployTx(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId: session, seq, bytes }));

    (eng as any).handleDeployTx(LITE_TX.UPLOAD_BEGIN, encodeUploadBegin({ sessionId: session, totalSize: 2017, chunkCount: 3, finalHashHex: "11".repeat(32) }));

    chunk(2, new Uint8Array(1).fill(3));
    expect((await eng.dynUpload()).missing).toEqual([0, 1]);

    chunk(0, new Uint8Array(1008).fill(1));
    expect((await eng.dynUpload()).missing).toEqual([1]);

    chunk(1, new Uint8Array(1008).fill(2));
    expect(await eng.dynUpload()).toMatchObject({ receivedCount: 3, complete: true, missing: [] });

    const assembled: Uint8Array = (eng as any).upload.buf;
    expect([assembled[0], assembled[1007], assembled[1008], assembled[2015], assembled[2016]]).toEqual([1, 1, 2, 2, 3]);

    expect(() => chunk(3, new Uint8Array(1))).toThrow("upload chunk 3 is outside 0..2");
});

test("deployment sessions reject oversized modules, malformed chunks, and mismatched hashes", async () => {
    const engine = new VirtualNode({ ...TEST_SLOT_LAYOUT, verifySigs: false });
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
                targetSlot: DYN,
                finalHashHex: "ff".repeat(32),
            }),
        ),
    ).toThrow("deploy names a different module digest than the upload");
});

// every DEPLOY the node processes leaves its outcome on /dyn-upload, so a client reads the reason instead of inferring it from an empty slot.
test("a processed DEPLOY records what the node did with it", async () => {
    const engine = new VirtualNode({ ...TEST_SLOT_LAYOUT, verifySigs: false });
    const handle = (inputType: number, payload: Uint8Array) => (engine as any).handleDeployTx(inputType, payload);
    const lastDeploy = async () => (await engine.dynUpload()).lastDeploy;
    const begin = async (sessionId: bigint, bytes: Uint8Array, finalHashHex?: string) => {
        const chunks = splitUploadChunks(bytes);
        handle(
            LITE_TX.UPLOAD_BEGIN,
            encodeUploadBegin({ sessionId, totalSize: bytes.length, chunkCount: chunks.length, finalHashHex: finalHashHex ?? (await k12Hex(bytes)) }),
        );
        return chunks;
    };
    const deploy = (sessionId: bigint, finalHashHex: string, extra: { targetSlot?: number; abiVersion?: number } = {}) =>
        handle(LITE_TX.DEPLOY, encodeDeploy({ sessionId, targetSlot: DYN, finalHashHex, name: "Counter", ...extra }));

    expect(await lastDeploy()).toBeNull();

    const counter = await wasm("Counter");
    const counterHash = await k12Hex(counter);
    const chunks = await begin(21n, counter);

    expect(() => deploy(21n, counterHash, { targetSlot: DYN - 1 })).toThrow("is not a dynamic contract slot");
    expect(await lastDeploy()).toMatchObject({ sessionId: "21", slot: DYN - 1, ok: false, code: "bad-slot" });

    // a new session replaces the record; within one, only an incomplete upload may still end differently.
    expect(() => deploy(22n, counterHash, { abiVersion: 6 })).toThrow("unsupported Wasm ABI version 6; expected 7");
    expect(await lastDeploy()).toMatchObject({ sessionId: "22", code: "abi-mismatch", message: "unsupported Wasm ABI version 6; expected 7" });
    expect(() => deploy(22n, counterHash)).toThrow("is not the upload session");
    expect((await lastDeploy())?.code).toBe("abi-mismatch");

    expect(() => deploy(23n, counterHash)).toThrow("is not the upload session");
    expect(await lastDeploy()).toMatchObject({ sessionId: "23", code: "session-mismatch" });

    expect(() => deploy(21n, counterHash)).toThrow(`upload incomplete (0/${chunks.length} chunks)`);
    expect(await lastDeploy()).toMatchObject({ sessionId: "21", code: "incomplete", message: `upload incomplete (0/${chunks.length} chunks)` });

    chunks.forEach((bytes, seq) => handle(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId: 21n, seq, bytes })));
    expect(() => deploy(21n, "ff".repeat(32))).toThrow("deploy names a different module digest");
    expect((await lastDeploy())?.code).toBe("hash-mismatch");
});

// a core node refuses a module built with a small arena, and a node holding core's minimum refuses it the same way, on both deploy paths.
test("a node holding core's io minimum refuses a small-arena module in core's words", async () => {
    const built = await compileContractWithTypeScript({
        source: wasmFixtureManifest.DigestProbeDyn0.source,
        contractName: wasmFixtureManifest.DigestProbeDyn0.contractName,
        slot: DYN,
        arenaSizeBytes: 1024 * 1024,
    });
    const module = built.wasm;
    const strict = new VirtualNode({ ...TEST_SLOT_LAYOUT, verifySigs: false, minIoBytes: CORE_IO_CAPACITY_BYTES });
    const tooSmall = "contract io region too small for the engine carve (rebuild the contract)";

    expect(() => strict.deploy(DYN, module, "DigestProbe")).toThrow(tooSmall);
    expect((await strict.dynRegistry()).contracts.find((contract) => contract.index === DYN)?.armed).toBeFalsy();

    const handle = (inputType: number, payload: Uint8Array) => (strict as any).handleDeployTx(inputType, payload);
    const finalHashHex = await k12Hex(module);
    const chunks = splitUploadChunks(module);
    handle(LITE_TX.UPLOAD_BEGIN, encodeUploadBegin({ sessionId: 41n, totalSize: module.length, chunkCount: chunks.length, finalHashHex }));
    chunks.forEach((bytes, seq) => handle(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId: 41n, seq, bytes })));
    expect(() => handle(LITE_TX.DEPLOY, encodeDeploy({ sessionId: 41n, targetSlot: DYN, finalHashHex }))).toThrow(tooSmall);
    expect((await strict.dynUpload()).lastDeploy).toMatchObject({ sessionId: "41", ok: false, code: "load-failed", message: tooSmall });

    // a node told to hold no minimum arms the same module.
    const lenient = new VirtualNode({ ...TEST_SLOT_LAYOUT, verifySigs: false, minIoBytes: 0 });
    lenient.deploy(DYN, module, "DigestProbe");
    expect((await lenient.dynRegistry()).contracts.find((contract) => contract.index === DYN)?.armed).toBe(true);
});

test("a DEPLOY that arms keeps its verdict against a late resend, and a module that cannot load says why", async () => {
    const engine = new VirtualNode({ ...TEST_SLOT_LAYOUT, verifySigs: false });
    const handle = (inputType: number, payload: Uint8Array) => (engine as any).handleDeployTx(inputType, payload);
    const upload = async (sessionId: bigint, bytes: Uint8Array) => {
        const finalHashHex = await k12Hex(bytes);
        const chunks = splitUploadChunks(bytes);
        handle(LITE_TX.UPLOAD_BEGIN, encodeUploadBegin({ sessionId, totalSize: bytes.length, chunkCount: chunks.length, finalHashHex }));
        chunks.forEach((chunk, seq) => handle(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId, seq, bytes: chunk })));
        return finalHashHex;
    };

    const notWasm = new Uint8Array([1, 2, 3, 4, 5]);
    const notWasmHash = await upload(31n, notWasm);
    expect(() => handle(LITE_TX.DEPLOY, encodeDeploy({ sessionId: 31n, targetSlot: DYN, finalHashHex: notWasmHash }))).toThrow("is not a wasm module");
    expect((await engine.dynUpload()).lastDeploy).toMatchObject({ sessionId: "31", code: "not-wasm" });
    (engine as any).upload = null;

    // a module built for another slot passes every wire check and is refused by the loader, in core's words.
    const misplaced = await wasm("Counter");
    const misplacedHash = await upload(32n, misplaced);
    expect(() => handle(LITE_TX.DEPLOY, encodeDeploy({ sessionId: 32n, targetSlot: DYN, finalHashHex: misplacedHash }))).toThrow("artifact slot mismatch");
    expect((await engine.dynUpload()).lastDeploy).toMatchObject({
        sessionId: "32",
        ok: false,
        code: "load-failed",
        message: `artifact slot mismatch: compiled 28, target ${DYN}`,
    });
    (engine as any).upload = null;

    const probe = await wasm("DigestProbeDyn0");
    const probeHash = await upload(33n, probe);
    handle(LITE_TX.DEPLOY, encodeDeploy({ sessionId: 33n, targetSlot: DYN, finalHashHex: probeHash, name: "DigestProbe" }));
    expect((await engine.dynUpload()).lastDeploy).toMatchObject({ sessionId: "33", slot: DYN, ok: true, code: "ok", message: "slot armed" });

    expect(() => handle(LITE_TX.DEPLOY, encodeDeploy({ sessionId: 33n, targetSlot: DYN, finalHashHex: probeHash, name: "DigestProbe" }))).toThrow();
    expect((await engine.dynUpload()).lastDeploy).toMatchObject({ sessionId: "33", ok: true, code: "ok" });
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
        payload: await encodeInputFormat(""),
    });
    expect((await eng.broadcastTx(tx.bytes)).ok).toBe(true);
    expect(await decodeAbi(await eng.querySmartContract(28, 1, await encodeInputFormat("")), "uint64")).toBe(1n); // applied

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

    expect(await decodeAbi(eng.query(28, 1), "uint64")).toBe(0n);
    eng.procedure(28, 1); // direct Inc (instant, no signing)
    expect(await decodeAbi(eng.query(28, 1), "uint64")).toBe(1n);

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
        version: 0,
    });
});

test("stateRead reports a state version that moves when the contract writes", async () => {
    const eng = await VirtualNode.create({ fees: "off" });
    eng.deploy(28, await wasm("Counter"), "Counter");

    const before = (await eng.stateRead(28, 0, 8)).version!;
    eng.sim.invokeProcedure(29, 28, 1, new Uint8Array(0), 0n, new Uint8Array(32));
    const after = (await eng.stateRead(28, 0, 8)).version!;

    // A container view spans several of these; the version is what reports a write between them.
    expect(after).toBeGreaterThan(before);
    expect((await eng.stateRead(28, 0, 8)).version).toBe(after); // stable while nothing writes
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
        payload: await encodeInputFormat(""),
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
