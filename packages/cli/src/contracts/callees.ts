import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanCallees } from "@qinit/build";
import type { LiteRpc } from "@qinit/core";
import { invalidArgs } from "../args";

export interface DynamicCallee {
  header: string;
  index?: number;
}

export function parseCallees(
  values: readonly string[] | undefined,
): Record<string, DynamicCallee> {
  const callees = new Map<string, DynamicCallee>();

  for (const value of values ?? []) {
    const match = /^([A-Za-z_]\w*)=(.+)$/.exec(value);
    if (!match) {
      invalidArgs(`invalid --callee '${value}': expected Name=header[@index]`);
    }

    const [, name, declaration] = match;
    const indexed = /^(.*)@(\d+)$/.exec(declaration);
    const header = indexed?.[1] ?? declaration;
    const rawIndex = indexed?.[2];
    const index = rawIndex === undefined ? undefined : Number(rawIndex);
    if (
      index !== undefined &&
      (!Number.isSafeInteger(index) || index > 0xffffffff)
    ) {
      invalidArgs(`invalid --callee '${value}': index must be an unsigned 32-bit integer`);
    }
    if (callees.has(name)) {
      invalidArgs(`duplicate --callee name '${name}'`);
    }

    callees.set(name, {
      header: resolve(header),
      ...(index === undefined ? {} : { index }),
    });
  }

  return Object.fromEntries(callees);
}

export async function resolveNodeCallees(
  rpc: Pick<LiteRpc, "dynRegistry">,
  contractSource: string,
  declared: Record<string, DynamicCallee> = {},
  onNote?: (message: string) => void,
  analysis?: { name: string; slot: number; qpiHeader: string },
  timeoutMs?: number,
): Promise<Record<string, DynamicCallee>> {
  const resolved = { ...declared };

  try {
    const names = [...scanCallees(contractSource, analysis)];
    const pending = names.filter((name) => !resolved[name]);
    if (!pending.length) {
      return resolved;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = rpc.dynRegistry();
    const registry = timeoutMs
      ? await Promise.race([
          probe.finally(() => clearTimeout(timer)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("node probe timeout")), timeoutMs);
          }),
        ])
      : await probe;

    for (const name of pending) {
      const contract = (registry.contracts ?? []).find(
        (candidate) => candidate.name === name && candidate.armed && candidate.source,
      );
      if (!contract) {
        continue;
      }

      const header = join(tmpdir(), `qinit-callee-${name}.h`);
      writeFileSync(header, contract.source!);
      resolved[name] = { header, index: contract.index };
      onNote?.(`callee ${name} → slot ${contract.index} (from node)`);
    }
  } catch {
    // Node discovery is optional; explicitly declared callees still work offline.
  }

  return resolved;
}
