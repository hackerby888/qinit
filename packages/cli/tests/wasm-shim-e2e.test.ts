// End-to-end correctness of the wasm QPI shim (recipe.ts): build a real system contract to wasm, deploy it on
// the VirtualNode, and drive a procedure that allocates function locals (__qpiAllocLocals) and moves qu. The
// shim compiles the pure helpers (smul / copyMemory / __qpiAllocLocals) INTO the wasm; this asserts they're not
// just non-crashing but produce the EXACT right result — recipients credited the precise amounts, a clean burn,
// and a function output that decodes. Builds with clang, so it's skipped when the core-lite tree isn't present.
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { buildSystemContract } from "@qinit/build";
import { VirtualNode } from "@qinit/engine";

const CORE = "/home/kali/Projects/core-lite";
const haveCore = existsSync(`${CORE}/src/contracts/QUtil.h`);
const id = (b: number) => new Uint8Array(32).fill(b);
const i64 = (b: Uint8Array, off = 0) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(off, true);

test.skipIf(!haveCore)("wasm shim: QUtil SendToManyV1 credits the exact amounts (locals + transfers + decode)", async () => {
  const eng = await VirtualNode.create({ fees: "off" });
  const sim = eng.sim;
  const r = await buildSystemContract("QUTIL", CORE, { outDir: `/tmp/qinit-shim-e2e` });
  expect(r.ok).toBe(true);
  const slot = eng.deploy(new Uint8Array(await Bun.file(r.so!).arrayBuffer()), { name: "QUTIL", slot: r.index }).slot;

  // functions and procedures have separate id spaces — look them up separately (a combined map would collide).
  const fnId = (name: string) => Number(Object.entries(r.idl!.functions).find(([, e]) => e.name === name)![0]);
  const pId = (name: string) => Number(Object.entries(r.idl!.procedures).find(([, e]) => e.name === name)![0]);

  // a read function with output — the contract runs with a _locals frame; the i64 result must decode
  const fee = i64(sim.query(slot, fnId("GetSendToManyV1Fee"), new Uint8Array(0)));
  expect(fee).toBe(10n);

  // SendToManyV1_input: 25 id (dst0..24) then 25 sint64 (amt0..24). Send 1000 -> r1, 2000 -> r2.
  const input = new Uint8Array(25 * 32 + 25 * 8);
  const dv = new DataView(input.buffer);
  input.set(id(0x21), 0);
  input.set(id(0x22), 32);
  dv.setBigInt64(800, 1000n, true);
  dv.setBigInt64(808, 2000n, true);

  const caller = id(0x11);
  const reward = 3000n + fee;
  sim.fund(caller, reward);
  const before1 = sim.balance(id(0x21)), before2 = sim.balance(id(0x22));
  const out = sim.procedure(slot, pId("SendToManyV1"), input, { invocator: caller, reward });

  expect(new DataView(out.buffer, out.byteOffset, out.byteLength).getInt32(0, true)).toBe(0); // returnCode OK
  expect(sim.balance(id(0x21)) - before1).toBe(1000n);
  expect(sim.balance(id(0x22)) - before2).toBe(2000n);

  // BurnQubic: a simple procedure — the contract retains none of the burned reward
  const burner = id(0x31);
  sim.fund(burner, 500n);
  const supplyBefore = sim.balanceOf(slot);
  const burnIn = new Uint8Array(8);
  new DataView(burnIn.buffer).setBigInt64(0, 500n, true);
  sim.procedure(slot, pId("BurnQubic"), burnIn, { invocator: burner, reward: 500n });
  expect(sim.balanceOf(slot) - supplyBefore).toBe(0n);
}, 60_000);
