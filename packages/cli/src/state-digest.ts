import type { LiteRpc } from "@qinit/core";

export interface StateDigestResult {
  ok: true;
  slot: number;
  stateSize: number;
  digest: string;
}

export type StateDigestRpc = Pick<LiteRpc, "dynRegistry" | "contractDigest">;

export async function readStateDigest(
  target: string,
  rpc: StateDigestRpc,
): Promise<StateDigestResult> {
  const normalized = target.trim();
  if (!normalized) {
    throw new Error("state digest requires a contract name or numeric slot");
  }

  let slot: number;
  if (/^-?\d+$/.test(normalized)) {
    slot = Number(normalized);
    if (!Number.isSafeInteger(slot) || slot < 0) {
      throw new Error(`invalid contract slot: ${normalized}`);
    }
  } else {
    const registry = await rpc.dynRegistry();
    const name = normalized.toLowerCase();
    const contract = (registry.contracts ?? []).find(
      (entry) => entry.armed && entry.name.toLowerCase() === name,
    );
    if (!contract) {
      throw new Error(`no deployed contract '${normalized}'`);
    }
    slot = contract.index;
  }

  const result = await rpc.contractDigest(slot);
  if (
    !Number.isSafeInteger(result.stateSize) ||
    result.stateSize < 0 ||
    typeof result.digest !== "string" ||
    !result.digest
  ) {
    throw new Error(`invalid contract digest response for slot ${slot}`);
  }
  return {
    ok: true,
    slot,
    stateSize: result.stateSize,
    digest: result.digest,
  };
}
