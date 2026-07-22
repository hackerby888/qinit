import { CORE_PATH } from "../../../../test-utils/paths";
// Verify that the TypeScript and core WAMR hosts produce identical contract state.
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildContract } from "@qinit/build";
import { Sim, initK12, toHex } from "@qinit/engine";

const CORE = CORE_PATH;
const GTEST = [
  process.env.QINIT_WAMR_GTEST?.trim(),
  `${CORE}/build-wtests/test/qubic_wasm_tests`,
].filter((candidate): candidate is string => Boolean(candidate)).find(existsSync) ?? "";
const FIX = `${import.meta.dir}/../../../../fixtures`;
const haveBoth = GTEST !== "" && existsSync(`${FIX}/DigestProbe.h`);

const id = (b: number) => new Uint8Array(32).fill(b);
const u64 = (n: bigint) => {
  const a = new Uint8Array(8);
  new DataView(a.buffer).setBigUint64(0, n, true);
  return a;
};
const i64 = (n: bigint) => {
  const a = new Uint8Array(8);
  new DataView(a.buffer).setBigInt64(0, n, true);
  return a;
};
const cat = (...xs: Uint8Array[]) => {
  const t = new Uint8Array(xs.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of xs) {
    t.set(x, o);
    o += x.length;
  }
  return t;
};

interface Op {
  it: number;
  in: Uint8Array;
}
interface Case {
  name: string;
  slot: number;
  bytes: number;
  covers: string;
  ops: Op[];
}

const CASES: Case[] = [
  {
    name: "DigestProbe",
    slot: 29,
    bytes: 64,
    covers: "mixed-width scalars + Arrays",
    ops: [{ it: 1, in: new Uint8Array(0) }],
  },
  {
    name: "Registry",
    slot: 31,
    bytes: 72,
    covers: "Array<uint64,4> + scalars",
    ops: [
      { it: 1, in: id(0xaa) },
      { it: 2, in: u64(5n) },
      { it: 2, in: u64(7n) },
    ],
  },
  {
    name: "DbgMap",
    slot: 30,
    bytes: 41240,
    covers: "HashMap<id,uint64,1024> + a trailing scalar",
    ops: [
      { it: 2, in: cat(id(0x11), u64(100n)) },
      { it: 2, in: cat(id(0x22), u64(200n)) },
      { it: 1, in: new Uint8Array(0) },
    ],
  },
  {
    name: "DbgColl",
    slot: 32,
    bytes: 114960,
    covers: "Collection<uint64,1024> (PoV priority queues)",
    ops: [
      { it: 1, in: cat(id(0x11), u64(42n), i64(5n)) },
      { it: 1, in: cat(id(0x11), u64(43n), i64(1n)) },
      { it: 1, in: cat(id(0x22), u64(44n), i64(9n)) },
    ],
  },
];

for (const c of CASES) {
  test.skipIf(!haveBoth)(
    `cross-host: ${c.name} (${c.covers}) state byte-identical on the node WAMR and qinit`,
    async () => {
      await initK12();
      const r = await buildContract({
        contractPath: `${FIX}/${c.name}.h`,
        name: c.name,
        slot: c.slot,
        corePath: CORE,
        outDir: "/tmp/qinit-xhost",
        skipVerify: true,
      });
      expect(r.ok, r.stderr).toBe(true);

      // qinit side: deploy (runs INITIALIZE) then the op script, read the raw StateData
      const sim = new Sim();
      const ct = sim.deploy(c.slot, new Uint8Array(await Bun.file(r.so!).arrayBuffer()));
      for (const o of c.ops) sim.procedure(c.slot, o.it, o.in);
      const qinitHex = toHex(ct.state());
      expect(ct.state().length).toBe(c.bytes);

      // node side: same wasm under WAMR, same INITIALIZE + script, via the gtest that prints CROSSHOST_STATE=<hex>
      const script = c.ops.map((o) => `${o.it}:${toHex(o.in)}`).join(";");
      const proc = Bun.spawnSync(
        [GTEST, "--gtest_filter=WasmContracts.CrossHostStateEquivalence"],
        {
          cwd: tmpdir(),
          env: {
            ...process.env,
            QINIT_WASM: r.so!,
            QINIT_SCRIPT: script,
            QINIT_EXPECTED_SLOT: String(c.slot),
          },
        },
      );
      const m = proc.stdout.toString().match(/CROSSHOST_STATE=([0-9a-f]+)/);
      expect(
        m,
        `gtest emitted no CROSSHOST_STATE:\n${proc.stdout.toString()}\n${proc.stderr.toString()}`,
      ).not.toBeNull();

      // the proof: byte-identical contract state across the two independent host implementations
      expect(m![1]).toBe(qinitHex);
    },
    120_000,
  );
}
