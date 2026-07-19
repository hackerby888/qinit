import { expect, test } from "bun:test";
import { readStateDigest } from "../../src/state-digest";

const digest = "ab".repeat(32);

test("state digest resolves a deployed contract name through the registry", async () => {
  const result = await readStateDigest("digestprobe", {
    dynRegistry: async () =>
      ({
        contracts: [
          { index: 28, name: "DigestProbe", armed: true },
          { index: 29, name: "DigestProbe", armed: false },
        ],
      }) as any,
    contractDigest: async (slot) => ({ slot, stateSize: 64, digest }),
  });

  expect(result).toEqual({ ok: true, slot: 28, stateSize: 64, digest });
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});

test("state digest accepts a numeric slot without reading the registry", async () => {
  let registryCalls = 0;
  const result = await readStateDigest(" 31 ", {
    dynRegistry: async () => {
      registryCalls++;
      throw new Error("must not be called");
    },
    contractDigest: async (slot) => ({ slot, stateSize: 128, digest }),
  });

  expect(result.slot).toBe(31);
  expect(registryCalls).toBe(0);
});

test("state digest reports missing names and registry RPC failures", async () => {
  await expect(
    readStateDigest("Missing", {
      dynRegistry: async () => ({ contracts: [] }) as any,
      contractDigest: async () => ({ slot: 0, stateSize: 0, digest }),
    }),
  ).rejects.toThrow("no deployed contract 'Missing'");

  await expect(
    readStateDigest("DigestProbe", {
      dynRegistry: async () => {
        throw new Error("registry unavailable");
      },
      contractDigest: async () => ({ slot: 0, stateSize: 0, digest }),
    }),
  ).rejects.toThrow("registry unavailable");
});

test("state digest propagates digest RPC failures", async () => {
  await expect(
    readStateDigest("28", {
      dynRegistry: async () => ({ contracts: [] }) as any,
      contractDigest: async () => {
        throw new Error("digest endpoint failed");
      },
    }),
  ).rejects.toThrow("digest endpoint failed");
});

test("state digest requires a target", async () => {
  await expect(
    readStateDigest("", {
      dynRegistry: async () => ({ contracts: [] }) as any,
      contractDigest: async () => ({ slot: 0, stateSize: 0, digest }),
    }),
  ).rejects.toThrow("requires a contract name or numeric slot");
});

test("state digest rejects invalid slots and malformed RPC results", async () => {
  const rpc = {
    dynRegistry: async () => ({ contracts: [] }) as any,
    contractDigest: async (slot: number) => ({ slot, stateSize: -1, digest: "" }),
  };

  await expect(readStateDigest("-1", rpc)).rejects.toThrow("invalid contract slot");
  await expect(readStateDigest("29", rpc)).rejects.toThrow(
    "invalid contract digest response for slot 29",
  );
});
