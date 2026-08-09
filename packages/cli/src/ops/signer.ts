// A node accepts a transaction from an identity with no balance and then drops it at tick assembly, so
// the only symptom is work that never lands. Catch that before signing anything.
import { deriveIdentity, type LiteRpc } from "@qinit/core";

export type SignerRpc = Pick<LiteRpc, "fundedSeed" | "balance">;

export interface SignerCheck {
  seed: string;
  identity: string;
  /** Absent when the node could not answer — an unreadable balance never blocks the caller. */
  balance?: string;
  switched?: boolean;
  unfunded?: boolean;
}

export function unfundedSignerMessage(identity: string): string {
  return (
    `signer ${identity} has no balance on this node — it accepts the transaction and then drops it ` +
    "at tick assembly. Pick a funded seed with 'qinit seed', or pass a funded --seed."
  );
}

async function readBalance(
  rpc: SignerRpc,
  identity: string,
): Promise<string | undefined> {
  try {
    return (await rpc.balance(identity)).balance;
  } catch {
    return undefined;
  }
}

// A seed the user typed is never swapped: `explicit` reports the empty signer instead of choosing another.
export async function resolveFundedSigner(
  rpc: SignerRpc,
  seed: string,
  options: { explicit?: boolean } = {},
): Promise<SignerCheck> {
  const { identity } = await deriveIdentity(seed);
  const balance = await readBalance(rpc, identity);

  if (balance === undefined || balance !== "0") {
    return { seed, identity, balance };
  }

  if (!options.explicit) {
    const funded = await rpc.fundedSeed().catch(() => undefined);
    if (funded && funded !== seed) {
      const fundedIdentity = (await deriveIdentity(funded)).identity;
      const fundedBalance = await readBalance(rpc, fundedIdentity);

      if (fundedBalance !== undefined && fundedBalance !== "0") {
        return {
          seed: funded,
          identity: fundedIdentity,
          balance: fundedBalance,
          switched: true,
        };
      }
    }
  }

  return { seed, identity, balance, unfunded: true };
}
