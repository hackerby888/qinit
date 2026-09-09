import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { bytesToHex, hexToBytes, deriveIdentity, deriveKeysSync, initK12, signSync, verifySync } from "@qinit/core";
import { assertSeed } from "@qinit/core/crypto/tx";
import { savedSeed } from "../../config";
import { Header, Panel, KV, theme } from "../../ui";
import { output, type CommandArguments } from "../../args";

// QPI contracts verify signatures over arbitrary digests with qpi.signatureValidity(entity, digest,
// signature). Nothing in the toolchain could *produce* one, so for every signature-based port — permit,
// meta-transactions, off-chain order authorisation, key registries — only the rejection path was
// reachable: every test that passed proved the guard says no. The signing primitive was already in
// packages/core; this exposes it.
//
// The digest is whatever the contract hashes, most often qpi.K12() over an input struct, so this takes
// it as raw hex rather than hashing anything itself.
const DIGEST_BYTES = 32;
const SIGNATURE_BYTES = 64;

export type SignFacts = {
    digest: string;
    signature: string;
    identity: string;
    publicKey: string;
    verified: boolean;
};

export function signJsonResult(facts: SignFacts | null, error: string | null) {
    return {
        ok: !error,
        digest: facts?.digest ?? null,
        signature: facts?.signature ?? null,
        identity: facts?.identity ?? null,
        publicKey: facts?.publicKey ?? null,
        verified: facts?.verified ?? null,
        error,
    };
}

/** seed + hex digest -> the 64-byte signature a contract's signatureValidity() will accept. */
export async function signDigest(seed: string, digestHex: string): Promise<SignFacts> {
    assertSeed(seed);

    const normalized = digestHex.trim().replace(/^0x/i, "").toLowerCase();
    if (!/^[0-9a-f]*$/.test(normalized)) {
        throw new Error(`digest must be hex (got ${JSON.stringify(digestHex)})`);
    }
    if (normalized.length !== DIGEST_BYTES * 2) {
        throw new Error(`digest must be ${DIGEST_BYTES} bytes / ${DIGEST_BYTES * 2} hex characters (got ${normalized.length / 2} bytes)`);
    }

    await initK12();
    const digest = hexToBytes(normalized, DIGEST_BYTES);
    const { privateKey, publicKey } = deriveKeysSync(seed);
    const signature = signSync(privateKey, publicKey, digest);
    if (signature.length !== SIGNATURE_BYTES) {
        throw new Error(`signer produced ${signature.length} bytes; the contract ABI expects ${SIGNATURE_BYTES}`);
    }

    const { identity, publicKeyHex } = await deriveIdentity(seed);
    return {
        digest: normalized,
        signature: bytesToHex(signature),
        identity,
        publicKey: publicKeyHex,
        // Signing and then failing to verify against the same key means the pair is unusable; say so
        // here rather than letting the contract be the first thing that finds out.
        verified: verifySync(publicKey, digest, signature),
    };
}

type State = { phase: "run" } | { phase: "done"; facts: SignFacts | null; error: string | null };

export function Sign({ commandArgs }: { commandArgs: CommandArguments }) {
    const { exit } = useApp();
    const [s, setS] = useState<State>({ phase: "run" });

    useEffect(() => {
        (async () => {
            try {
                const digestHex = commandArgs.get("digest") ?? commandArgs.positionals[0];
                if (!digestHex) {
                    throw new Error("no digest: pass `qinit sign <hex-digest>` (32 bytes, as the contract computed it)");
                }
                const seed = commandArgs.get("seed") ?? savedSeed();
                if (!seed) {
                    throw new Error("no seed: pass --seed <seed> or save one with `qinit seed`");
                }
                setS({ phase: "done", facts: await signDigest(seed, digestHex), error: null });
            } catch (error: any) {
                setS({ phase: "done", facts: null, error: String(error?.message ?? error) });
            }
        })();
    }, []);

    useEffect(() => {
        if (s.phase !== "done") return;
        if (output.json) {
            process.stdout.write(JSON.stringify(signJsonResult(s.facts, s.error)) + "\n");
        }
        process.exitCode = s.error ? 1 : 0;
        const t = setTimeout(() => exit(), 40);
        return () => clearTimeout(t);
    }, [s, exit]);

    if (output.json) return null;
    if (s.phase !== "done") {
        return (
            <Box flexDirection="column">
                <Header cmd="sign" />
                <Text dimColor>signing…</Text>
            </Box>
        );
    }
    if (s.error) {
        return (
            <Box flexDirection="column">
                <Header cmd="sign" />
                <Panel title="sign failed" color={theme.err}>
                    <Text wrap="wrap">{s.error}</Text>
                </Panel>
            </Box>
        );
    }

    const facts = s.facts!;
    return (
        <Box flexDirection="column">
            <Header cmd="sign" />
            <Box flexDirection="column" marginTop={1}>
                <KV
                    rows={[
                        ["signer", facts.identity],
                        ["publicKey", facts.publicKey],
                        ["digest", facts.digest],
                        ["signature", facts.signature],
                        ["verifies", facts.verified ? "yes" : "NO — the key pair did not verify its own signature"],
                    ]}
                />
            </Box>
            <Box marginTop={1}>
                <Text dimColor wrap="wrap">
                    Pass the signature to a contract entry as a 64-byte Array&lt;sint8, 64&gt;, with the signer as the `id` its
                    qpi.signatureValidity() checks against.
                </Text>
            </Box>
        </Box>
    );
}
