// SET_SHAREHOLDER_PROPOSAL / SET_SHAREHOLDER_VOTES parity: a caller's qpi.setShareholderProposal /
// qpi.setShareholderVotes invokes the callee's sysproc 10/11 with the typed payload (Array<uint8,1024>
// proposal buffer / ProposalMultiVoteDataV1), and the callee's scalar output (uint16 proposal index /
// success bit) flows back as the caller's return value. Both contracts' state bytes must match native.
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { buildContract } from "@qinit/build";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);

const CALLEE_SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    uint64 gotProposal;
    uint64 firstByte;
    uint64 gotVotes;
    uint64 votedIndex;
  };

  SET_SHAREHOLDER_PROPOSAL()
  {
    state.mut().gotProposal = state.get().gotProposal + 1;
    state.mut().firstByte = input.get(0);
    output = 7;
  }

  SET_SHAREHOLDER_VOTES()
  {
    state.mut().gotVotes = state.get().gotVotes + 1;
    state.mut().votedIndex = input.proposalIndex;
    output = 1;
  }

  struct Ping_input {};
  struct Ping_output { uint64 x; };
  PUBLIC_FUNCTION(Ping)
  {
    output.x = 1;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Ping, 1);
  }
};`;

const CALLER_SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    uint64 propIdx;
    uint64 voteOk;
  };

  struct Go_input {};
  struct Go_output {};
  struct Go_locals {
    Array<uint8, 1024> buf;
    ProposalMultiVoteDataV1 votes;
  };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go)
  {
    locals.buf.set(0, 42);
    state.mut().propIdx = qpi.setShareholderProposal(3, locals.buf, 0);

    locals.votes.proposalIndex = 5;
    state.mut().voteOk = qpi.setShareholderVotes(3, locals.votes, 0) ? 1 : 0;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Go, 1);
  }
};`;

function wasiAvailable(): boolean {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
}

describe("differential — shareholder sysproc 10/11 state parity", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("caller + callee state bytes match native after proposal + votes", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "shprop-"));

    const buildNative = async (name: string, src: string, slot: number) => {
      const contractPath = join(dir, `${name}.h`);
      writeFileSync(contractPath, src);
      const built = await buildContract({ contractPath, name, slot, corePath: CORE, outDir: dir, skipVerify: true });
      expect(built.ok).toBe(true);
      return new Uint8Array(readFileSync(built.so!));
    };
    const buildOurs = async (name: string, src: string, slot: number) => {
      const mine = await compileContract({ source: src, name, slot, qpiHeader: HEADERS, arenaSz: 4 * 1024 * 1024 });
      expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
      return mine.wasm;
    };

    const nativeCallee = await buildNative("ShCallee", CALLEE_SRC, 3);
    const nativeCaller = await buildNative("ShCaller", CALLER_SRC, 27);
    const oursCallee = await buildOurs("ShCallee", CALLEE_SRC, 3);
    const oursCaller = await buildOurs("ShCaller", CALLER_SRC, 27);

    const run = (callee: Uint8Array, caller: Uint8Array) => {
      const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
      const user = new Uint8Array(32).fill(4);
      sim.fund(user, 1_000_000n);
      sim.deploy(3, callee);
      sim.deploy(27, caller);
      sim.procedure(27, 1, undefined, { invocator: user });
      return {
        caller: sim.contracts.get(27)!.state().slice(),
        callee: sim.contracts.get(3)!.state().slice(),
      };
    };

    const nat = run(nativeCallee, nativeCaller);
    const ours = run(oursCallee, oursCaller);

    for (const side of ["caller", "callee"] as const) {
      const a = nat[side];
      const b = ours[side];
      const firstDiff = a.findIndex((v, i) => b[i] !== v);
      if (firstDiff >= 0) {
        console.log(`  ${side} DIVERGENCE at byte ${firstDiff}: native=${a[firstDiff]} ours=${b[firstDiff]}`);
      }
      expect(firstDiff).toBe(-1);
    }

    // Anchors: callee saw one proposal (first byte 42) and one vote (index 5); the caller received
    // the callee's outputs (proposal index 7, vote success 1).
    const callee = new DataView(nat.callee.buffer, nat.callee.byteOffset);
    expect(callee.getBigUint64(0, true)).toBe(1n);  // gotProposal
    expect(callee.getBigUint64(8, true)).toBe(42n); // firstByte
    expect(callee.getBigUint64(16, true)).toBe(1n); // gotVotes
    expect(callee.getBigUint64(24, true)).toBe(5n); // votedIndex
    const caller = new DataView(nat.caller.buffer, nat.caller.byteOffset);
    expect(caller.getBigUint64(0, true)).toBe(7n);  // propIdx
    expect(caller.getBigUint64(8, true)).toBe(1n);  // voteOk
  }, 180000);
});
