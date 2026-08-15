// The on-chain chunked upload protocol: claim the node's single upload slot with UPLOAD_BEGIN, broadcast
// every UPLOAD_CHUNK, then wait for the node to report the session assembled. Broadcasting a chunk is not
// the same as it landing in a tick, so every phase re-reads the node's upload status and resends what is
// still missing rather than trusting the broadcast result.
import { LiteRpc, buildSignedTx } from "@qinit/core";
import { LITE_TX, TX_TICK_OFFSET, createUploadSessionId, encodeUploadBegin, encodeUploadChunk, splitUploadChunks } from "@qinit/proto";
import type { DeploymentEvent } from "./steps";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A signed transaction for one lite-protocol input type, ready to broadcast.
export async function buildUploadTx(seed: string, inputType: number, payload: Uint8Array, tick: number): Promise<Uint8Array> {
    return (await buildSignedTx(seed, { tick, inputType, payload })).bytes;
}

export function activeUploadError(upload: { sessionId: string; receivedCount: number; chunkCount: number }): string {
    return `another contract upload is active (session ${upload.sessionId}, ${upload.receivedCount}/${upload.chunkCount} chunks); wait for it to complete`;
}

export interface UploadOpts {
    rpc: LiteRpc;
    seed: string;
    wasm: Uint8Array;
    hash: string;
    emit: (event: DeploymentEvent) => void;
    readTick: () => Promise<number>;
    waitForTick: (target: number, attempts?: number) => Promise<number>;
}

// On success the caller gets the session id it must name in its DEPLOY transaction. On failure the upload
// step has already been marked failed via `emit`, so the caller only has to surface the message.
export type UploadResult = { ok: true; session: bigint; assembled: boolean } | { ok: false; error: string };

export async function uploadContract({ rpc, seed, wasm, hash, emit, readTick, waitForTick }: UploadOpts): Promise<UploadResult> {
    const session = createUploadSessionId();
    const chunks = splitUploadChunks(wasm);
    const total = chunks.length + 1;
    const sentIndexes = new Set<number>();
    const buildTransaction = (inputType: number, payload: Uint8Array, tick: number) => buildUploadTx(seed, inputType, payload, tick);

    emit({ step: "upload", state: "active", detail: `0/${total}`, pct: 0 });

    // Claim the single upload slot before any chunk leaves this client.
    const claimUpload = async (): Promise<{ owned: boolean; error?: string }> => {
        for (let attempt = 0; attempt <= 3; attempt++) {
            const tick = (await readTick()) + TX_TICK_OFFSET;
            let sent = false;

            try {
                sent = (
                    await rpc.broadcastTx(
                        await buildTransaction(
                            LITE_TX.UPLOAD_BEGIN,
                            encodeUploadBegin({
                                sessionId: session,
                                totalSize: wasm.length,
                                chunkCount: chunks.length,
                                finalHashHex: hash,
                            }),
                            tick,
                        ),
                    )
                ).ok;
            } catch {
                // A fresh tick below retries transient broadcast failures.
            }

            if (sent) {
                sentIndexes.add(0);
                emit({
                    step: "upload",
                    state: "active",
                    detail: `${sentIndexes.size}/${total}`,
                    pct: sentIndexes.size / total,
                });
                await waitForTick(tick + 1);
            }

            try {
                const upload = await rpc.dynUpload();
                if (upload.active) {
                    if (upload.sessionId === String(session)) {
                        return { owned: true };
                    }
                    return { owned: false, error: activeUploadError(upload) };
                }
            } catch {
                // Older nodes may not expose upload status during the retry window.
            }

            if (attempt < 3) {
                emit({ note: `retry ${attempt + 1}: UPLOAD_BEGIN not confirmed` });
                await sleep(600);
            }
        }

        return { owned: false, error: "upload begin not confirmed after retries" };
    };

    const claim = await claimUpload();
    if (!claim.owned) {
        emit({ step: "upload", state: "fail", detail: claim.error });
        return { ok: false, error: claim.error ?? "upload begin failed" };
    }

    const chunkTick = (await readTick()) + TX_TICK_OFFSET;
    let pendingChunks = await Promise.all(
        chunks.map(async (bytes, seq) => ({
            bytes: await buildTransaction(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId: session, seq, bytes }), chunkTick),
            index: seq + 1,
        })),
    );

    for (let attempt = 0; attempt <= 3 && pendingChunks.length; attempt++) {
        const failedChunks: typeof pendingChunks = [];

        for (const chunk of pendingChunks) {
            try {
                const result = await rpc.broadcastTx(chunk.bytes);
                if (result.ok) {
                    sentIndexes.add(chunk.index);
                } else {
                    failedChunks.push(chunk);
                }
            } catch {
                failedChunks.push(chunk);
            }

            emit({
                step: "upload",
                state: "active",
                detail: `${sentIndexes.size}/${total}`,
                pct: sentIndexes.size / total,
            });
        }

        pendingChunks = failedChunks;
        if (pendingChunks.length) {
            emit({ note: `retry ${attempt + 1}: ${pendingChunks.length} chunk(s)` });
            await sleep(600);
        }
    }

    if (sentIndexes.size < total) {
        emit({
            step: "upload",
            state: "fail",
            detail: `${sentIndexes.size}/${total}`,
        });
        emit({
            note: `✗ ${total - sentIndexes.size} upload tx(s) failed after retries`,
        });
        return { ok: false, error: "upload failed" };
    }
    emit({
        step: "upload",
        state: "active",
        detail: `${total}/${total} broadcast · confirming…`,
        pct: 1,
    });

    // A successful broadcast does not guarantee that the chunk landed in a tick.
    let assembled = false;
    await waitForTick(chunkTick + 1);

    for (let round = 0; round < 4 && !assembled; round++) {
        let upload: Awaited<ReturnType<typeof rpc.dynUpload>> | null = null;

        try {
            upload = await rpc.dynUpload();
        } catch {
            // Older nodes may not expose upload status.
        }

        if (upload?.active && upload.sessionId !== String(session)) {
            const error = activeUploadError(upload);
            emit({ step: "upload", state: "fail", detail: error });
            return { ok: false, error };
        }

        if (upload?.active) {
            if (upload.complete) {
                assembled = true;
                break;
            }

            const missing = (upload.missing ?? []).filter((seq) => seq < chunks.length);
            if (!missing.length) {
                await waitForTick((await readTick()) + 1);
                continue;
            }

            const resendTick = (await readTick()) + TX_TICK_OFFSET;
            for (const seq of missing) {
                await rpc.broadcastTx(
                    await buildTransaction(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId: session, seq, bytes: chunks[seq] }), resendTick),
                );
            }

            emit({
                note: `assembly: resent ${missing.length} missing chunk(s) [round ${round + 1}]`,
            });
            await waitForTick(resendTick + 1);
        } else {
            await waitForTick((await readTick()) + 1);
        }
    }

    emit({
        step: "upload",
        state: "ok",
        detail: assembled ? `${total}/${total} · assembled` : `${total}/${total} broadcast`,
        pct: 1,
    });
    if (!assembled) {
        emit({
            note: "⚠ assembly not confirmed via dyn-upload — deploying anyway (older node without the endpoint?)",
        });
    }

    return { ok: true, session, assembled };
}
