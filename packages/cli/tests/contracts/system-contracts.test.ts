import { test, expect } from "bun:test";
import { systemContracts, systemNames } from "@qinit/build";
import { encodeInput, encodeInputJson, zeroInputFmt } from "@qinit/proto";
import { parseContractIdl } from "@qinit/proto/contract-idl";
import { resolveContract, type ContractSets } from "../../src/contracts";

test.skipIf(!process.env.QINIT_CORE)(
  "systemContracts: live contract_def catalog includes typed IDL",
  async () => {
    const catalog = systemContracts(process.env.QINIT_CORE!);
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.some((contract) => contract.idl.functions.length > 0)).toBe(true);
    expect(systemNames(process.env.QINIT_CORE!).size).toBe(catalog.length);
    for (const contract of catalog) {
      expect(parseContractIdl(contract.idl)).toEqual(contract.idl);
    }

    const qutil = catalog.find((contract) => contract.name === "QUTIL")!;
    const proposal = qutil.idl.procedures.find(
      (entry) => entry.name === "SetShareholderProposal",
    )!;
    const input = await encodeInputJson(proposal.input, {
      url: Array(256).fill(0),
      epoch: 0,
      type: 0,
      tick: 0,
      data: Array(40).fill(0),
    });
    expect(input).toHaveLength(proposal.inSize);
    expect(
      await encodeInput(zeroInputFmt(proposal.input)),
    ).toHaveLength(proposal.inSize);
  },
);

// --- resolution: user matched before system ---
test("resolveContract: user before system; by name or index", () => {
  const sets: ContractSets = {
    user: [
      {
        index: 28,
        name: "MyTok",
        armed: true,
        constructed: true,
        version: 1,
        codeHash: "",
        functions: [],
        procedures: [],
        source: "u",
      } as any,
    ],
    system: [
      {
        index: 1,
        name: "QX",
        file: "Qx.h",
        source: "s",
        idl: { name: "QX", functions: [], procedures: [] },
      } as any,
    ],
  };
  expect(resolveContract("MyTok", sets)?.kind).toBe("user");
  expect(resolveContract("28", sets)?.index).toBe(28);
  expect(resolveContract("QX", sets)?.kind).toBe("system");
  expect(resolveContract("1", sets)?.name).toBe("QX");
  expect(resolveContract("nope", sets)).toBeNull();
});
