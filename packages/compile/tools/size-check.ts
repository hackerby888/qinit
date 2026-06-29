import { compileContract, loadQpiHeader } from "../src/index";

const headers = loadQpiHeader("/home/kali/Projects/core-lite");

const probe = `
using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    HashMap<id, uint64, 1024> balances;
    Array<uint64, 4> recent;
    uint64 total;
  };
  struct Get_input {};
  struct Get_output { uint64 v; };
  struct Get_locals {};
  PUBLIC_FUNCTION(Get) { output.v = state.get().total; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};
`;

const r = await compileContract({ source: probe, name: "Probe", slot: 28, qpiHeader: headers, arenaSz: 64 * 1024 });
console.log("diags:", r.diagnostics.length);
for (const d of r.diagnostics.slice(0, 5)) console.log("  L" + d.span.line + ":", d.message);
// decode state_size from the wasm (state_size export)
if (r.wasm.byteLength) {
  const mod = new WebAssembly.Module(r.wasm);
  const inst = new WebAssembly.Instance(mod, fakeImports());
  console.log("state_size:", (inst.exports as any).state_size());
}
console.log("Expected: HashMap<id,uint64,1024>=41232 + Array<uint64,4>=32 + uint64=8 = 41272");

function fakeImports(): WebAssembly.Imports {
  const lhost: Record<string, Function> = {};
  for (const n of ["beginFn","endFn","markDirty","pauseLog","resumeLog","acquireScratch","releaseScratch","logBytes","k12","transfer","transferTyped","abort","burn","epoch","tick","numberOfTickTransactions","getEntity","queryFeeReserve","nextId","prevId","isContractId","arbitrator","computor","day","year","hour","minute","month","second","millisecond","now","prevSpectrumDigest","prevUniverseDigest","prevComputerDigest","isAssetIssued","issueAsset","numberOfShares","numberOfPossessedShares","transferShareOwnershipAndPossession","acquireShares","releaseShares","dayOfWeek","signatureValidity","bidInIPO","ipoBidId","ipoBidPrice","computeMiningFunction","initMiningSeed","getOracleQueryStatus","unsubscribeOracle","queryOracle","subscribeOracle","getOracleQuery","getOracleReply","distributeDividends","liteCallFunction","liteInvokeProcedure","liteSetShareholderProposal","liteSetShareholderVotes","assetEnumerate"]) {
    lhost[n] = () => 0;
  }
  return { lhost } as any;
}
