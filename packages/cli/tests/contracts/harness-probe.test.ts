import { CORE_PATH } from "../../../../test-utils/paths";
// harness-probe.test.cpp exercises the shim's direct-access surface (assets[], spectrumIndex/energy, contractStates[], system, the fee reserve) the way core's tests do; red here means the harness drifted from core.
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wasiSdkPaths } from "@qinit/core/project";
import { runStdGtest } from "../../src/ops/corpus-run";

const CORE = CORE_PATH;
const CONTRACT = `${import.meta.dir}/../../../../fixtures/HarnessProbe.h`;
const PROBES = `${import.meta.dir}/harness-probe.test.cpp`;
const have = existsSync(`${CORE}/test/contract_testing.h`) && existsSync(CONTRACT) && wasiSdkPaths() !== null;

const PASSING = [
    "HarnessProbe.IssueAssetReturnsUniverseIndices",
    "HarnessProbe.DuplicateIssuanceReturnsZeroAndTheExistingIndex",
    "HarnessProbe.TransferByIndexPlacesTheOwnerAtItsHash",
    "HarnessProbe.ReferenceSurvivesHostCallsAndReset",
    "HarnessProbe.MirrorReloadsAfterEveryUniverseChange",
    "HarnessProbe.ContractSeesTheMirrorWrite",
    "HarnessProbe.ScanFindsOnlyTheRecordsIssued",
    "HarnessProbe.SpectrumIndexIsCoresHashSlot",
    "HarnessProbe.InvokeWithoutASpectrumRecordIsRefused",
    "HarnessProbe.ContractTransferShowsInTheSpectrum",
    "HarnessProbe.StateWriteReachesTheContract",
    "HarnessProbe.SystemEpochAndTickReachTheContract",
    "HarnessProbe.SecondFixtureResetsSpectrumAndUniverse",
    "HarnessProbe.FeeReserveRoundTrips",
    "HarnessProbe.PrintsReachTheReport",
];
// probes that must fail, with the text their failure has to carry
const FAILING: Record<string, string> = {
    "HarnessProbe.WriteIntoAnEmptyIndexIsRefused": "assets[5] was written",
    "HarnessProbe.ReadingAnUndeployedSlotFailsLoud": "contractStates[101]: no contract deployed in slot 101",
};

test.skipIf(!have)(
    "a gtest probing the harness's direct-access surface sees core's behaviour",
    async () => {
        const scratch = mkdtempSync(join(tmpdir(), "qinit-gtest-harness-"));
        try {
            const testPath = join(scratch, "HarnessProbe.test.cpp");
            writeFileSync(testPath, readFileSync(PROBES, "utf8"));
            const run = await runStdGtest({
                contractPath: CONTRACT,
                testPath,
                name: "HarnessProbe",
                stateType: "HarnessProbe",
                slot: 100,
                core: CORE,
                backend: "clang",
                scratch,
            });
            expect(run.runnerOk, run.buildError).toBe(true);
            expect(run.results.map((result) => result.name).sort()).toEqual([...PASSING, ...Object.keys(FAILING)].sort());
            const by = Object.fromEntries(run.results.map((result) => [result.name, result]));
            for (const name of PASSING) {
                expect(by[name]?.passed, `${name}: ${by[name]?.message}`).toBe(true);
            }
            expect(by["HarnessProbe.PrintsReachTheReport"]?.output).toContain("probe printf 1\nprobe cout 2\nprobe stderr\n");
            expect(by["HarnessProbe.FeeReserveRoundTrips"]?.output).toBeUndefined();
            for (const [name, text] of Object.entries(FAILING)) {
                expect(by[name]?.passed, name).toBe(false);
                expect(by[name]?.message, name).toContain(text);
                expect(by[name]?.message, name).not.toContain("EXPECT_");
            }
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    },
    180_000,
);
