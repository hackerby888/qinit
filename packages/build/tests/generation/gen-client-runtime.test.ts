import { expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { extractIdl } from "../../src/idl";
import { generateClient } from "../../src/gen-client";

const SOURCE = `
struct Demo : public ContractBase {
  struct Read_input {};
  struct Read_output { uint64 value; };
  struct Reset_input {};
  struct Reset_output {};
  PUBLIC_FUNCTION(Read) {}
  PUBLIC_PROCEDURE(Reset) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
    REGISTER_USER_PROCEDURE(Reset, 1);
  }
};`;

const RUNTIME = `
export const functionInputs: Uint8Array[] = [];
export const procedureInputs: Uint8Array[] = [];

export class LiteRpc {
  constructor(_base: string) {}
  async tickInfo() { return { tick: 10 }; }
  async fundedSeed() { return undefined; }
}

function encode(input: { type: { size: number } }): Uint8Array {
  return new Uint8Array(input.type.size);
}

export async function callFunction(
  _rpc: LiteRpc,
  _index: number,
  _entry: number,
  input: { type: { size: number }; value: unknown },
): Promise<bigint> {
  functionInputs.push(encode(input));
  return 7n;
}

export async function invokeProcedure(options: {
  input: { type: { size: number }; value: unknown };
}): Promise<{ ok: boolean }> {
  procedureInputs.push(encode(options.input));
  return { ok: true };
}
`;

test("no-argument generated clients send the canonical padding byte", async () => {
  const outputDir = mkdtempSync(join(tmpdir(), "qinit-client-runtime-"));

  try {
    const idl = extractIdl(SOURCE, "Demo");
    const runtimePath = join(outputDir, "runtime.ts");
    const clientPath = join(outputDir, "client.ts");
    writeFileSync(runtimePath, RUNTIME);
    writeFileSync(
      clientPath,
      generateClient(idl, 28, {
        runtimeImport: "./runtime",
      }),
    );

    const runtime = await import(pathToFileURL(runtimePath).href);
    const generated = await import(pathToFileURL(clientPath).href);
    const client = new generated.Demo();

    expect(await client.Read()).toEqual({ value: 7n });
    expect(
      await client.Reset({
        seed: "a".repeat(55),
        confirm: false,
      }),
    ).toEqual({ ok: true });
    expect(runtime.functionInputs).toEqual([new Uint8Array([0])]);
    expect(runtime.procedureInputs).toEqual([new Uint8Array([0])]);
  } finally {
    rmSync(outputDir, {
      recursive: true,
      force: true,
    });
  }
});
