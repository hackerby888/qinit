import { CORE_PATH, QINIT_ROOT } from "../../../../test-utils/paths";
// Dumps the exact WAT text (via QINIT_DUMP_WAT) for a fixed corpus of contracts into a directory.
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { compileContract, loadQpiHeader } from "../../src/index";

const OUT = process.argv[2];
if (!OUT) {
  console.error("usage: bun run tests/_dump_wat_corpus.ts <outdir>");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const QPI = loadQpiHeader(CORE_PATH);
const FIXTURES = QINIT_ROOT + "/fixtures";
const SYSTEM = CORE_PATH + "/src/contracts";

const FIXTURE_FILES = ["Counter.h", "Counter5.h", "Bank.h", "Token.h", "Vault.h", "Dividend.h", "Proxy.h", "DigestProbe.h", "BigState.h"];
const SYSTEM_FILES = [
  "Qx.h", "Quottery.h", "Random.h", "QUtil.h", "QEARN=Qearn.h", "QVAULT.h", "MsVault.h",
  "GGWP.h", "QIP.h", "QBond.h", "QDuel.h", "Qbay.h", "Qdraw.h", "Qswap.h", "QThirtyFour.h",
  "Qusino.h", "qRWA.h", "QReservePool.h", "RandomLottery.h", "Pulse.h", "Escrow.h",
  "Nostromo.h", "QRaffle.h", "MyLastMatch.h", "SupplyWatcher.h", "VottunBridge.h",
  "ComputorControlledFund.h", "GeneralQuorumProposal.h",
];

// Inline fixtures covering codegen shapes the file corpus underexercises: uint128 ops, narrowing casts, short-circuit && / ||, ternary,
const TIER1_SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct F_input { sint64 x; sint64 k; sint64 ahi; sint64 alo; sint64 bhi; sint64 blo; };
  struct F_output {
    uint64 m8; uint64 m16; uint64 m32; uint64 s8; uint64 s16; uint64 cmp;
    uint64 andlo; uint64 andhi; uint64 orlo; uint64 orhi; uint64 xorlo; uint64 xorhi;
  };
  struct F_locals { uint128 a; uint128 b; uint128 r; };
  PUBLIC_FUNCTION_WITH_LOCALS(F)
  {
    output.m8  = uint64(uint8(input.x));
    output.m16 = uint64(uint16(input.x));
    output.m32 = uint64(uint32(input.x));
    output.s8  = uint64(sint8(input.x));
    output.s16 = uint64(sint16(input.x));
    output.cmp = (uint8(input.x) == input.k) ? 1 : 0;

    locals.a = uint128(input.ahi, input.alo);
    locals.b = uint128(input.bhi, input.blo);

    locals.r = locals.a & locals.b;
    output.andlo = locals.r.low; output.andhi = locals.r.high;
    locals.r = locals.a | locals.b;
    output.orlo = locals.r.low; output.orhi = locals.r.high;
    locals.r = locals.a ^ locals.b;
    output.xorlo = locals.r.low; output.xorhi = locals.r.high;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(F, 1); }
};`;

const LOGIC_SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct G_input { sint64 a; sint64 b; sint64 c; };
  struct G_output { sint64 sc; sint64 t; sint64 d; sint64 m; };
  PUBLIC_FUNCTION(G)
  {
    output.sc = (input.a > 0 && input.b > 0) || input.c != 0 ? 1 : 0;
    output.t = input.a < input.b ? input.a : input.b;
    output.d = div(input.a, input.b);
    output.m = mod(input.a, input.b);
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(G, 1); }
};`;

function structName(src: string): string {
  const m = src.match(/struct\s+(\w+)\s*:\s*public\s+ContractBase/);
  return m ? m[1] : "Contract";
}

async function dumpOne(displayName: string, src: string, name: string, slot: number): Promise<string> {
  const watPath = join(OUT, `${displayName}.wat`);
  process.env.QINIT_DUMP_WAT = watPath;
  try {
    const r = await compileContract({ source: src, name, slot, qpiHeader: QPI, arenaSz: 64 * 1024 });
    const errs = r.diagnostics.filter((d) => d.severity === "error").length;
    const dumped = existsSync(watPath);
    return `${displayName}: ${dumped ? "wat" : "NO-WAT"} · ${errs} err`;
  } catch (e: any) {
    return `${displayName}: THROW ${(e.message ?? "").slice(0, 60)}`;
  } finally {
    delete process.env.QINIT_DUMP_WAT;
  }
}

const lines: string[] = [];
for (const f of FIXTURE_FILES) {
  const p = join(FIXTURES, f);
  if (!existsSync(p)) {
    lines.push(`${f}: MISSING`);
    continue;
  }
  const src = readFileSync(p, "utf8");
  lines.push(await dumpOne(f.replace(".h", ""), src, structName(src), 28));
}
for (const spec of SYSTEM_FILES) {
  const [disp, file] = spec.includes("=") ? spec.split("=") : [spec.replace(".h", ""), spec];
  const p = join(SYSTEM, file);
  if (!existsSync(p)) {
    lines.push(`${disp}: MISSING`);
    continue;
  }
  const src = readFileSync(p, "utf8");
  lines.push(await dumpOne(disp, src, structName(src), 28));
}
lines.push(await dumpOne("Tier1CastU128", TIER1_SRC, "T1", 6));
lines.push(await dumpOne("LogicShortCircuit", LOGIC_SRC, "L1", 6));

console.log(lines.join("\n"));
