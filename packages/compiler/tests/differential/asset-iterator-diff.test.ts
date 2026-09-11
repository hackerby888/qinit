// The asset iterators against clang. The selectors row is F220: begin() used to lower one any() selector and pass that same buffer for both the
// ownership and the possession parameter, so a filtered walk enumerated every holder. The object rows are F224: the iterator holds qpi.h's
// fields and the node's universe indices, so its bytes match clang's wherever it lives, and its accessors read the record the host names.
import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE, QINIT_ROOT } from "../../../../test-utils/paths";
import { wasiToolchain } from "../support/container-toolchains";

const CORE = CORE_PATH;
const HEADERS = () => loadQpiHeader(CORE);
const TRIAGE = join(QINIT_ROOT, "corpus", "solidity-port", "triage");

// Issue 1000 shares, move 400 to a second holder, then walk the owners twice: filtered to that holder,
// and unfiltered as the control that isolates the selector from the iteration itself. The filtered walk's
// iterator is either the `_locals` member started with begin() or a block-scoped local constructed in place.
const source = (filteredWalk: { declare: string; iterator: string }) => `using namespace QPI;
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

    ${filteredWalk.declare}
    locals.guard = 0;
    while (!${filteredWalk.iterator}.reachedEnd() && locals.guard < 16) {
      locals.filteredCount++;
      locals.filteredShares += ${filteredWalk.iterator}.numberOfOwnedShares();
      ${filteredWalk.iterator}.next();
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

// The state after procedure 1, as little-endian u64 words: one per StateData field, so a layout row reads like the declaration.
const runWords = (wasm: Uint8Array): bigint[] => {
    const simulator = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    simulator.fund(user, 1_000_000_000n);
    simulator.deploy(27, wasm);
    simulator.procedure(27, 1, undefined, { invocator: user });
    const state = simulator.contracts.get(27)!.state();
    return [...new BigUint64Array(state.buffer.slice(state.byteOffset, state.byteOffset + state.byteLength))];
};

const runState = (wasm: Uint8Array): bigint => runWords(wasm)[0];

const wasiOk = wasiToolchain().available;

const clangWords = async (contractName: string, source: string): Promise<bigint[]> => {
    const directory = mkdtempSync(join(tmpdir(), "asset-iter-probe-"));
    writeFileSync(join(directory, `${contractName}.h`), source);
    const built = await buildContractWithClang({
        contractPath: join(directory, `${contractName}.h`),
        contractName,
        slot: 27,
        corePath: CORE,
        outDir: directory,
        skipVerify: true,
    });
    expect(built.ok).toBe(true);
    return runWords(new Uint8Array(readFileSync(built.wasmPath!)));
};

// Issue 1000 shares of one asset and move 400 to a second holder, then run `body` with `locals` declared alongside the setup.
const holders = (contractName: string, stateFields: string, locals: string, body: string) => `using namespace QPI;
struct ${contractName}2 {};
struct ${contractName} : public ContractBase {
  struct StateData { ${stateFields} };
  struct Go_input {}; struct Go_output {};
  struct Go_locals { id other; Asset asset; uint64 guard; sint64 outcome; ${locals} };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) {
    locals.other = id(5, 0, 0, 0);
    locals.outcome = qpi.issueAsset(5525825ULL, SELF, 0, 1000, 0);
    locals.outcome = qpi.transferShareOwnershipAndPossession(5525825ULL, SELF, SELF, SELF, 400, locals.other);
    locals.asset.issuer = SELF;
    locals.asset.assetName = 5525825ULL;
    ${body}
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

// Every object row pins the words both backends print; the universe indices are the engine's slots (SELF's id is slot 27, `other` is slot 5).
const OBJECT_ROWS: Record<string, { contractName: string; source: string; words: bigint[] }> = {
    "an iterator held in state carries qpi.h's fields, not a count and a cursor": {
        contractName: "IteratorInState",
        source: readFileSync(join(TRIAGE, "F224-iterator-in-state", "IteratorInState.h"), "utf8"),
        words: [2n, 1000n, 1n, 27n, 0n, 0n, 0n, 5525825n, 27n, 0n, 0n, 0n, 0n, 16842752n, 4294967295n],
    },
    "issuanceIndex() and ownershipIndex() report the universe indices": {
        contractName: "IteratorIndexAccessors",
        source: readFileSync(join(TRIAGE, "F224-iterator-index-accessors", "IteratorIndexAccessors.h"), "utf8"),
        words: [2n, 1000n, 27n, 5n, 28n],
    },
    "issuer() and assetName() read the issuance, and the id stores into state": {
        contractName: "IteratorIssuer",
        source: holders(
            "IteratorIssuer",
            "id iterIssuer; uint64 name; uint64 holders;",
            "AssetOwnershipIterator iter;",
            `locals.iter.begin(locals.asset, AssetOwnershipSelect::any());
    state.mut().iterIssuer = locals.iter.issuer();
    state.mut().name = locals.iter.assetName();
    for (locals.guard = 0; !locals.iter.reachedEnd() && locals.guard < 16; locals.guard++) { state.mut().holders++; locals.iter.next(); }`,
        ),
        words: [27n, 0n, 0n, 0n, 5525825n, 2n],
    },
    "a possession walk reads possessor, shares and the possession's managing contract": {
        contractName: "IteratorPossession",
        source: holders(
            "IteratorPossession",
            "uint64 holders; uint64 shares; uint64 managers; id lastPossessor;",
            "AssetPossessionIterator iter;",
            `locals.iter.begin(locals.asset, AssetOwnershipSelect::any(), AssetPossessionSelect::any());
    for (locals.guard = 0; !locals.iter.reachedEnd() && locals.guard < 16; locals.guard++) {
      state.mut().holders++;
      state.mut().shares += locals.iter.numberOfPossessedShares();
      state.mut().managers += locals.iter.possessionManagingContract();
      state.mut().lastPossessor = locals.iter.possessor();
      locals.iter.next();
    }`,
        ),
        words: [2n, 1000n, 54n, 27n, 0n, 0n, 0n],
    },
    "an inner walk leaves the outer iterator on its own record": {
        contractName: "IteratorNested",
        source: holders(
            "IteratorNested",
            "uint64 pairs; uint64 outerOwners;",
            "Asset second; AssetOwnershipIterator outer; AssetOwnershipIterator inner; uint64 innerGuard; id owner;",
            `locals.outcome = qpi.issueAsset(4412754ULL, SELF, 0, 900, 0);
    locals.outcome = qpi.transferShareOwnershipAndPossession(4412754ULL, SELF, SELF, SELF, 100, id(6, 0, 0, 0));
    locals.outcome = qpi.transferShareOwnershipAndPossession(4412754ULL, SELF, SELF, SELF, 200, id(7, 0, 0, 0));
    locals.second.issuer = SELF;
    locals.second.assetName = 4412754ULL;
    locals.outer.begin(locals.asset, AssetOwnershipSelect::any());
    for (locals.guard = 0; !locals.outer.reachedEnd() && locals.guard < 16; locals.guard++) {
      locals.inner.begin(locals.second, AssetOwnershipSelect::any());
      for (locals.innerGuard = 0; !locals.inner.reachedEnd() && locals.innerGuard < 16; locals.innerGuard++) { state.mut().pairs++; locals.inner.next(); }
      locals.owner = locals.outer.owner();
      state.mut().outerOwners += locals.owner.u64._0;
      locals.outer.next();
    }`,
        ),
        words: [6n, 32n],
    },
};

describe.skipIf(!HAS_CORE)("differential — asset iterator selectors", () => {
    beforeAll(async () => {
        await initK12();
    });

    // The block-scoped form goes through the synthesized begin(), which used to forward only the asset and drop the selector.
    const FILTERED_WALKS: Record<string, { declare: string; iterator: string }> = {
        "a filtered ownership walk honours its selector": {
            declare: "locals.iter.begin(locals.asset, AssetOwnershipSelect::byOwner(locals.other));",
            iterator: "locals.iter",
        },
        "a block-scoped iterator constructed with a selector honours it": {
            declare: "AssetOwnershipIterator it(locals.asset, AssetOwnershipSelect::byOwner(locals.other));",
            iterator: "it",
        },
    };

    for (const [name, filteredWalk] of Object.entries(FILTERED_WALKS)) {
        test(
            name,
            async () => {
                const probeSource = source(filteredWalk);
                const ours = await compileContractWithTypeScript({
                    source: probeSource,
                    contractName: "AssetIterProbe",
                    slot: 27,
                    qpiHeader: HEADERS(),
                    arenaSizeBytes: 1 << 20,
                });
                expect(ours.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
                expect(runState(ours.wasm)).toBe(EXPECTED);

                if (wasiOk) expect((await clangWords("AssetIterProbe", probeSource))[0]).toBe(EXPECTED);
            },
            180000,
        );
    }
});

describe.skipIf(!HAS_CORE)("differential — asset iterator object", () => {
    beforeAll(async () => {
        await initK12();
    });

    for (const [name, row] of Object.entries(OBJECT_ROWS)) {
        test(
            name,
            async () => {
                const ours = await compileContractWithTypeScript({
                    source: row.source,
                    contractName: row.contractName,
                    slot: 27,
                    qpiHeader: HEADERS(),
                    arenaSizeBytes: 1 << 20,
                });
                expect(
                    ours.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR).map((diagnostic) => diagnostic.message),
                ).toEqual([]);
                expect(runWords(ours.wasm)).toEqual(row.words);

                if (wasiOk) expect(await clangWords(row.contractName, row.source)).toEqual(row.words);
            },
            180000,
        );
    }
});
