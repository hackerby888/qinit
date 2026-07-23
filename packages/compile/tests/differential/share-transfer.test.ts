import { DiagnosticSeverity } from "../../src/enums";
import { CORE_PATH, QINIT_ROOT } from "../../../../test-utils/paths";
import { loadWasmFixture } from "../../../../test-utils/wasm-fixtures";
// Share custody sysproc parity (PRE_*_SHARES).
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);
const APPROVER_SRC = readFileSync(QINIT_ROOT + "/fixtures/ShareApprover.h", "utf8");

const TOKEN = 0x4e454b4f54n; // "TOKEN"

// Records POST_RELEASE_SHARES fields to verify input layout and hook delivery.
const POST_REC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { sint64 lastShares; sint64 lastFee; sint64 postCount; };
  struct Issue_input { uint64 name; sint64 shares; }; struct Issue_output { sint64 result; };
  struct Get_input {}; struct Get_output { sint64 shares; sint64 fee; sint64 count; };
  PUBLIC_PROCEDURE(Issue) { output.result = qpi.issueAsset(input.name, SELF, 0, input.shares, 0); }
  PRE_RELEASE_SHARES() { output.allowTransfer = true; output.requestedFee = 0; }
  POST_RELEASE_SHARES() {
    state.mut().lastShares = input.numberOfShares;
    state.mut().lastFee = input.receivedFee;
    state.mut().postCount += 1;
  }
  PUBLIC_FUNCTION(Get) {
    output.shares = state.get().lastShares;
    output.fee = state.get().lastFee;
    output.count = state.get().postCount;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Issue, 1); REGISTER_USER_FUNCTION(Get, 1); }
};`;

function cid(slot: number): Uint8Array {
  const a = new Uint8Array(32);
  new DataView(a.buffer).setBigUint64(0, BigInt(slot), true);
  return a;
}
function i64(b: Uint8Array): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(0, true);
}
function issueIn(name: bigint, shares: bigint): Uint8Array {
  const b = new Uint8Array(16);
  const d = new DataView(b.buffer);
  d.setBigUint64(0, name, true);
  d.setBigInt64(8, shares, true);
  return b;
}
// ShareManager Acquire input: { uint64 name; id issuer; id holder; sint64 shares; uint16 srcMgmt; sint64 fee }
function acqIn(
  name: bigint,
  issuer: Uint8Array,
  holder: Uint8Array,
  shares: bigint,
  srcMgmt: number,
  fee: bigint,
): Uint8Array {
  const b = new Uint8Array(96);
  const d = new DataView(b.buffer);
  d.setBigUint64(0, name, true);
  b.set(issuer, 8);
  b.set(holder, 40);
  d.setBigInt64(72, shares, true);
  d.setUint16(80, srcMgmt, true);
  d.setBigInt64(88, fee, true);
  return b;
}
function sharesByMgmt(sim: Sim, mgmt: number): bigint {
  let sum = 0n;
  for (const a of sim.assetUniverse()) {
    for (const h of a.holdings) {
      if (h.posMgmt === mgmt) sum += BigInt(h.shares);
    }
  }
  return sum;
}

describe("sysproc — PRE_RELEASE_SHARES / PRE_ACQUIRE_SHARES approve management-rights transfer", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("my approver's PRE_RELEASE_SHARES lets the generated acquirer take rights (allowTransfer read back)", async () => {
    const approver = await compileContract({
      source: APPROVER_SRC,
      name: "ShareApprover",
      slot: 28,
      qpiHeader: HEADERS,
      arenaSz: 1024 * 1024,
    });
    expect(approver.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

    const sim = new Sim();
    sim.deploy(28, approver.wasm); // MY compiled approver: issues + approves releases
    sim.deploy(29, await loadWasmFixture("ShareManager"));
    const A = cid(28);

    sim.procedure(28, 1, issueIn(TOKEN, 1000n)); // owner = possessor = id(28), managed by contract 28
    expect(sharesByMgmt(sim, 28)).toBe(1000n);

    // ShareManager(29).Acquire 400 from srcMgmt 28: fires my PRE_RELEASE_SHARES on 28 → allowTransfer=true.
    sim.procedure(29, 2, acqIn(TOKEN, A, A, 400n, 28, 0n));

    expect(i64(sim.query(29, 1))).toBe(0n); // acquireShares returned the paid fee (0) on success
    expect(sharesByMgmt(sim, 29)).toBe(400n); // 400 now managed by the acquirer
    expect(sharesByMgmt(sim, 28)).toBe(600n); // 600 still managed by the approver
  });

  test("PRE_RELEASE_SHARES.requestedFee (output struct) is honoured: approver charges, acquirer pays", async () => {
    const approver = await compileContract({
      source: APPROVER_SRC,
      name: "ShareApprover",
      slot: 28,
      qpiHeader: HEADERS,
      arenaSz: 1024 * 1024,
    });
    const sim = new Sim();
    sim.deploy(28, approver.wasm);
    sim.deploy(29, await loadWasmFixture("ShareManager"));
    const A = cid(28);

    sim.procedure(28, 1, issueIn(TOKEN, 1000n));

    // SetFee(10): the approver's PRE_RELEASE_SHARES now returns requestedFee = 10 in its output struct.
    const setFee = new Uint8Array(8);
    new DataView(setFee.buffer).setBigInt64(0, 10n, true);
    sim.procedure(28, 2, setFee);
    sim.fund(cid(29), 100n); // the acquirer needs balance to pay the fee

    sim.procedure(29, 2, acqIn(TOKEN, A, A, 400n, 28, 10n)); // Acquire offering fee 10
    expect(i64(sim.query(29, 1))).toBe(10n); // acquireShares returned the fee the approver requested
    expect(sim.balanceOf(28)).toBe(10n); // the approver received it
    expect(sim.balanceOf(29)).toBe(90n); // the acquirer paid it
    expect(sharesByMgmt(sim, 29)).toBe(400n);
  });

  test("my approver's PRE_ACQUIRE_SHARES lets the acquirer release rights back", async () => {
    const approver = await compileContract({
      source: APPROVER_SRC,
      name: "ShareApprover",
      slot: 28,
      qpiHeader: HEADERS,
      arenaSz: 1024 * 1024,
    });
    const sim = new Sim();
    sim.deploy(28, approver.wasm);
    sim.deploy(29, await loadWasmFixture("ShareManager"));
    const A = cid(28);

    sim.procedure(28, 1, issueIn(TOKEN, 1000n));
    sim.procedure(29, 2, acqIn(TOKEN, A, A, 400n, 28, 0n)); // acquire 400 → managed by 29
    expect(sharesByMgmt(sim, 29)).toBe(400n);

    // ShareManager(29).Release (proc 3) back to 28: fires my PRE_ACQUIRE_SHARES on 28 → allowTransfer=true.
    sim.procedure(29, 3, acqIn(TOKEN, A, A, 400n, 28, 0n));
    expect(i64(sim.query(29, 1))).toBe(0n);
    expect(sharesByMgmt(sim, 29)).toBe(0n); // released
    expect(sharesByMgmt(sim, 28)).toBe(1000n); // all back to the approver
  });

  test("POST_RELEASE_SHARES (sysproc 7) fires with the right numberOfShares + receivedFee", async () => {
    const rec = await compileContract({
      source: POST_REC,
      name: "PostRec",
      slot: 28,
      qpiHeader: HEADERS,
      arenaSz: 1024 * 1024,
    });
    expect(rec.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

    const sim = new Sim();
    sim.deploy(28, rec.wasm);
    sim.deploy(29, await loadWasmFixture("ShareManager"));
    const A = cid(28);

    sim.procedure(28, 1, issueIn(TOKEN, 1000n)); // PostRec.Issue (proc 1)

    // Nothing acquired yet — POST hook never fired.
    let g = sim.query(28, 1);
    expect(i64(g.subarray(16, 24))).toBe(0n); // count

    // Acquirer takes 400: PRE_RELEASE_SHARES approves, then POST_RELEASE_SHARES fires on 28.
    sim.procedure(29, 2, acqIn(TOKEN, A, A, 400n, 28, 0n));
    g = sim.query(28, 1);
    expect(i64(g.subarray(0, 8))).toBe(400n); // numberOfShares from PostManagementRightsTransfer_input
    expect(i64(g.subarray(8, 16))).toBe(0n); // receivedFee (0 offered)
    expect(i64(g.subarray(16, 24))).toBe(1n); // fired once
  });
});
