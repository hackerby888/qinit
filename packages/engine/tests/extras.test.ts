// The last host imports: spectrum iteration (nextId/prevId) and shareholder governance
// (setShareholderProposal -> the callee's SET_SHAREHOLDER_PROPOSAL sysproc).
import { test, expect } from "bun:test";
import { initK12 } from "../src/k12";
import { Sim } from "../src/sim";

const FIX = import.meta.dir + "/fixtures";

async function wasm(n: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${FIX}/${n}.wasm`).arrayBuffer());
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const ID = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const ZERO = new Uint8Array(32);

test("nextId / prevId iterate the occupied spectrum entities", async () => {
  await initK12();

  const sim = new Sim();
  const A = ID(0x11), B = ID(0x22), C = ID(0x33);
  sim.fund(A, 1n);
  sim.fund(B, 1n);
  sim.fund(C, 1n);

  expect(hex(sim.nextId(A))).toBe(hex(B));
  expect(hex(sim.nextId(B))).toBe(hex(C));
  expect(hex(sim.nextId(C))).toBe(hex(ZERO)); // none after
  expect(hex(sim.prevId(C))).toBe(hex(B));
  expect(hex(sim.prevId(A))).toBe(hex(ZERO)); // none before
});

test("nextId via the wasm host import (Token.NextId)", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(28, await wasm("Token"));
  const A = ID(0x44), B = ID(0x55);
  sim.fund(A, 1n);
  sim.fund(B, 1n);

  const out = sim.query(28, 4, A); // Token.NextId(cur=A) -> qpi.nextId -> host.nextId
  expect(hex(out)).toBe(hex(B));
});

test("governance: setShareholderProposal invokes the callee's SET_SHAREHOLDER_PROPOSAL", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(28, await wasm("Gov")); // callee (defines SET_SHAREHOLDER_PROPOSAL)
  sim.deploy(29, await wasm("Gov")); // caller

  const input = new Uint8Array(4); // Propose_input { uint16 calleeIdx; uint8 firstByte }
  new DataView(input.buffer).setUint16(0, 28, true);
  input[2] = 0xab;

  const out = sim.procedure(29, 1, input); // Gov@29.Propose -> Gov@28 SET_SHAREHOLDER_PROPOSAL
  expect(new DataView(out.buffer, out.byteOffset, out.byteLength).getUint16(0, true)).toBe(42); // proposal index
  expect(sim.query(28, 1)[0]).toBe(0xab); // Gov@28.GetLast.lastByte = the proposal's first byte
});

test("governance guards: callee lacks the sysproc + self-call -> INVALID_PROPOSAL_INDEX", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(28, await wasm("Counter")); // no SET_SHAREHOLDER_PROPOSAL
  sim.deploy(29, await wasm("Gov"));
  const ORIG = new Uint8Array(32);
  const PROP = new Uint8Array(1024);

  expect(sim.doSetShareholderProposal(29, 28, PROP, 0n, ORIG)).toBe(0xffff); // callee lacks the sysproc
  expect(sim.doSetShareholderProposal(28, 28, PROP, 0n, ORIG)).toBe(0xffff); // self-call
});
