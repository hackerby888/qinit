import { CORE_PATH } from "../../../../test-utils/paths";
// Checks oracle host-call payloads and reply decoding against native behavior.
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { buildContract } from "@qinit/build";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    sint64 queryId;
    uint64 notified;
    uint64 qFound;
    uint64 qValue;
    uint64 rFound;
    uint64 rEcho;
    uint64 rDouble;
    uint64 sigValid;
    id miningOut;
    uint64 propIdx;
    uint64 voteOk;
  };

  typedef OracleNotificationInput<OI::Mock> Notify_input;
  typedef NoData Notify_output;
  PRIVATE_PROCEDURE(Notify)
  {
    state.mut().notified = state.get().notified + 1;
  }

  struct Ask_input { OI::Mock::OracleQuery q; };
  struct Ask_output { sint64 queryId; };
  PUBLIC_PROCEDURE(Ask)
  {
    state.mut().queryId = QUERY_ORACLE(OI::Mock, input.q, Notify, 60000);
    output.queryId = state.get().queryId;
  }

  struct Read_input {};
  struct Read_output {};
  struct Read_locals {
    OI::Mock::OracleQuery q;
    OI::Mock::OracleReply r;
    id entity;
    id digest;
    Array<sint8, 64> sig;
    id seed;
    id pk;
    id nonce;
    Array<uint8, 1024> propBuf;
    ProposalMultiVoteDataV1 votes;
  };
  PUBLIC_PROCEDURE_WITH_LOCALS(Read)
  {
    state.mut().qFound = qpi.getOracleQuery<OI::Mock>(state.get().queryId, locals.q) ? 1 : 0;
    state.mut().qValue = locals.q.value;
    state.mut().rFound = qpi.getOracleReply<OI::Mock>(state.get().queryId, locals.r) ? 1 : 0;
    state.mut().rEcho = locals.r.echoedValue;
    state.mut().rDouble = locals.r.doubledValue;

    state.mut().sigValid = qpi.signatureValidity(locals.entity, locals.digest, locals.sig) ? 1 : 0;

    qpi.initMiningSeed(locals.seed);
    state.mut().miningOut = qpi.computeMiningFunction(locals.seed, locals.pk, locals.nonce);

    state.mut().propIdx = qpi.setShareholderProposal(3, locals.propBuf, 0);
    state.mut().voteOk = qpi.setShareholderVotes(3, locals.votes, 0) ? 1 : 0;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Ask, 1);
    REGISTER_USER_PROCEDURE(Read, 2);
    REGISTER_USER_PROCEDURE_NOTIFICATION(Notify);
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

describe("differential — oracle read / mining / shareholder host calls", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("state bytes match native across query -> pending read -> resolve -> read", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "oracle-calls-"));
    const contractPath = join(dir, "OrcP.h");
    writeFileSync(contractPath, SRC);

    const built = await buildContract({
      contractPath,
      name: "OrcP",
      slot: 27,
      corePath: CORE,
      outDir: dir,
      skipVerify: true,
    });
    expect(built.ok).toBe(true);
    const nativeWasm = new Uint8Array(readFileSync(built.so!));

    const mine = await compileContract({
      source: SRC,
      name: "OrcP",
      slot: 27,
      qpiHeader: HEADERS,
      arenaSz: 4 * 1024 * 1024,
    });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    // Mock reply for query value 42: echoedValue=42, doubledValue=84 (16 bytes LE).
    const reply = new Uint8Array(16);
    new DataView(reply.buffer).setBigUint64(0, 42n, true);
    new DataView(reply.buffer).setBigUint64(8, 84n, true);

    const askInput = new Uint8Array(8);
    new DataView(askInput.buffer).setBigUint64(0, 42n, true);

    const run = (wasm: Uint8Array) => {
      const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
      sim.deploy(27, wasm);
      const user = new Uint8Array(32).fill(7);
      sim.fund(user, 1_000_000n);
      sim.fund(sim.contractId(27), 1_000n);

      sim.procedure(27, 1, askInput, { invocator: user });
      sim.procedure(27, 2, undefined, { invocator: user });
      const pendingState = sim.contracts.get(27)!.state().slice();

      sim.resolveOracle(1n, reply);
      sim.procedure(27, 2, undefined, { invocator: user });
      const resolvedState = sim.contracts.get(27)!.state().slice();

      return { pendingState, resolvedState };
    };

    const nat = run(nativeWasm);
    const ours = run(mine.wasm);

    for (const phase of ["pendingState", "resolvedState"] as const) {
      const a = nat[phase];
      const b = ours[phase];
      const firstDiff = a.findIndex((v, i) => b[i] !== v);
      if (firstDiff >= 0) {
        console.log(
          `  ${phase} DIVERGENCE at byte ${firstDiff}: native=${a[firstDiff]} ours=${b[firstDiff]}`,
        );
      }
      expect(firstDiff).toBe(-1);
    }

    // Anchor the resolved phase to known query/reply host behavior.
    const dv = new DataView(nat.resolvedState.buffer, nat.resolvedState.byteOffset);
    expect(dv.getBigInt64(0, true)).toBe(1n); // queryId
    expect(dv.getBigUint64(8, true)).toBe(1n); // notified
    expect(dv.getBigUint64(16, true)).toBe(1n); // qFound
    expect(dv.getBigUint64(24, true)).toBe(42n); // qValue
    expect(dv.getBigUint64(32, true)).toBe(1n); // rFound
    expect(dv.getBigUint64(40, true)).toBe(42n); // rEcho
    expect(dv.getBigUint64(48, true)).toBe(84n); // rDouble
    expect(dv.getBigUint64(56, true)).toBe(0n); // sigValid (zeroed signature)
  }, 180000);
});
