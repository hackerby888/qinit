// The asset iterators' selectors. begin() used to lower one any() selector and pass that same buffer
// for both the ownership and the possession parameter, so a filtered walk enumerated every holder --
// a wrong number rather than a crash, in fund-accounting code.
import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { wasiToolchain } from "../support/container-toolchains";

const CORE = CORE_PATH;
const HEADERS = () => loadQpiHeader(CORE);

// Issue 1000 shares, move 400 to a second holder, then walk the owners twice: filtered to that holder,
// and unfiltered as the control that isolates the selector from the iteration itself.
const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 packed; };
  struct Go_input {}; struct Go_output {};
  struct Go_locals {
    id other; Asset asset; AssetOwnershipIterator iter; uint64 guard; sint64 outcome;
    uint64 filteredCount; uint64 filteredShares; uint64 unfilteredCount; uint64 unfilteredShares;
  };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) {
    locals.other = id(5, 0, 0, 0);
    locals.outcome = qpi.issueAsset(5525825ULL, SELF, 0, 1000, 0);
    locals.outcome = qpi.transferShareOwnershipAndPossession(5525825ULL, SELF, SELF, SELF, 400, locals.other);
    locals.asset.issuer = SELF;
    locals.asset.assetName = 5525825ULL;

    locals.iter.begin(locals.asset, AssetOwnershipSelect::byOwner(locals.other));
    locals.guard = 0;
    while (!locals.iter.reachedEnd() && locals.guard < 16) {
      locals.filteredCount++;
      locals.filteredShares += locals.iter.numberOfOwnedShares();
      locals.iter.next();
      locals.guard++;
    }

    locals.iter.begin(locals.asset, AssetOwnershipSelect::any());
    locals.guard = 0;
    while (!locals.iter.reachedEnd() && locals.guard < 16) {
      locals.unfilteredCount++;
      locals.unfilteredShares += locals.iter.numberOfOwnedShares();
      locals.iter.next();
      locals.guard++;
    }

    state.mut().packed = locals.filteredCount * 10000000000ULL + locals.filteredShares * 10000000ULL
                       + locals.unfilteredCount * 10000ULL + locals.unfilteredShares;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
  INITIALIZE() { state.mut().packed = 0; }
};`;

// filtered 1 holder / 400 shares, unfiltered 2 / 1000 -- clang's answer. The backend read 2 / 1000
// for the filtered walk too, which is the whole finding.
const EXPECTED = 1n * 10000000000n + 400n * 10000000n + 2n * 10000n + 1000n;

const runState = (wasm: Uint8Array): bigint => {
    const simulator = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    simulator.fund(user, 1_000_000_000n);
    simulator.deploy(27, wasm);
    simulator.procedure(27, 1, undefined, { invocator: user });
    const state = simulator.contracts.get(27)!.state();
    return new DataView(state.buffer, state.byteOffset).getBigUint64(0, true);
};

const wasiOk = wasiToolchain().available;

describe.skipIf(!HAS_CORE)("differential — asset iterator selectors", () => {
    beforeAll(async () => {
        await initK12();
    });

    test("a filtered ownership walk honours its selector", async () => {
        const ours = await compileContractWithTypeScript({
            source: SOURCE,
            contractName: "AssetIterProbe",
            slot: 27,
            qpiHeader: HEADERS(),
            arenaSizeBytes: 1 << 20,
        });
        expect(ours.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
        expect(runState(ours.wasm)).toBe(EXPECTED);

        if (wasiOk) {
            const directory = mkdtempSync(join(tmpdir(), "asset-iter-probe-"));
            writeFileSync(join(directory, "AssetIterProbe.h"), SOURCE);
            const built = await buildContractWithClang({
                contractPath: join(directory, "AssetIterProbe.h"),
                contractName: "AssetIterProbe",
                slot: 27,
                corePath: CORE,
                outDir: directory,
                skipVerify: true,
            });
            expect(built.ok).toBe(true);
            expect(runState(new Uint8Array(readFileSync(built.wasmPath!)))).toBe(EXPECTED);
        }
    }, 180000);
});
