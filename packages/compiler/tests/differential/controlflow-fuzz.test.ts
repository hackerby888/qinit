import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
// Generated control-flow programs, judged by clang. controlflow-diff.test.ts pins the shapes someone
// thought of; this covers the ones nobody did. Every seed is rendered twice from one AST — as a contract
// entry and as a plain C++ reference in the gtest — so a mismatch is a codegen divergence between the two
// compilers on identical source.
//
// All seeds live in ONE contract so the suite pays for a single clang build and a single Qinit build
// rather than one per seed.
import { coreGtest } from "../support/core-gtest";
import { buildDifferentialRunner } from "../support/differential-runner";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { describe, expect, beforeAll, test } from "bun:test";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { generatePrograms } from "../support/controlflow-generator";

const CORE = CORE_PATH;
const HEADERS = () => loadQpiHeader(CORE);

// Widening the sweep is an env var, not an edit — the same knobs container-parity.test.ts exposes.
const SEED_START = Number(process.env.QINIT_CONTROLFLOW_SEED_START ?? 0);
// 128 rather than 32: the whole sweep is one compile, so the extra seeds cost ~2s and roughly quadruple
// the hit rate on the rarer codegen mutations.
const SEEDS = Number(process.env.QINIT_CONTROLFLOW_SEEDS ?? 128);
const PROGRAMS = generatePrograms(SEED_START, SEEDS);

const entryName = (seed: number) => `Prog${seed}`;

const contractEntry = (program: (typeof PROGRAMS)[number]): string => {
    const name = entryName(program.seed);
    const locals = ["uint64 sum;", ...program.vars.map((v) => `uint64 ${v};`)].join(" ");
    return `  struct ${name}_input {}; struct ${name}_output { uint64 value; };
  struct ${name}_locals { ${locals} };
  PUBLIC_FUNCTION_WITH_LOCALS(${name}) {
    locals.sum = 0;
${program.vars.map((v) => `    locals.${v} = 0;`).join("\n")}
${program.contractBody}
    output.value = locals.sum;
  }`;
};

const referenceFunction = (program: (typeof PROGRAMS)[number]): string => {
    const declarations = ["uint64 sum = 0;", ...program.vars.map((v) => `uint64 ${v} = 0;`)].join(" ");
    return `static uint64 ref${entryName(program.seed)}() {
    ${declarations}
${program.referenceBody}
    return sum;
}`;
};

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 unused; };
${PROGRAMS.map(contractEntry).join("\n\n")}

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
${PROGRAMS.map((program, index) => `    REGISTER_USER_FUNCTION(${entryName(program.seed)}, ${index + 1});`).join("\n")}
  }
};`;

const GTEST = coreGtest(
    "Fuzz",
    `${PROGRAMS.map(referenceFunction).join("\n\n")}

${PROGRAMS.map(
    (program, index) => `TEST(ControlFlowFuzz, Seed${program.seed}) {
  ContractTestingHarness t;
  CONTRACT_STATE_TYPE::${entryName(program.seed)}_input in{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::${entryName(program.seed)}_output>(${index + 1}, in).value, ref${entryName(program.seed)}());
}`,
).join("\n\n")}
`,
);

const wasi = wasiToolchain();

describe.skipIf(!HAS_CORE)(`differential gtest — generated control flow (seeds ${SEED_START}..${SEED_START + SEEDS - 1})`, () => {
    beforeAll(async () => {
        await initK12();
    });

    // Termination is a property of the generator, not of the runner's timeout: every loop bound is a
    // literal and nesting is capped, so assert it here rather than discovering a hang.
    test("every generated program has a bounded step count", () => {
        for (const program of PROGRAMS) {
            expect({ seed: program.seed, bounded: program.steps <= 4096 }).toEqual({ seed: program.seed, bounded: true });
        }
        expect(PROGRAMS.length).toBe(SEEDS);
    });

    toolchainTest(
        "every generated program agrees with its clang-compiled reference",
        wasi,
        async () => {
            const runnerWasm = await buildDifferentialRunner({
                corePath: CORE,
                source: SOURCE,
                testSource: GTEST,
                name: "Fuzz",
                tempPrefix: "flow-fuzz-",
            });

            const mine = await compileContractWithTypeScript({
                source: SOURCE,
                contractName: "Fuzz",
                slot: 28,
                qpiHeader: HEADERS(),
                arenaSizeBytes: 1 << 20,
            });
            expect(mine.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

            const results: TestResult[] = await runContractTesting(runnerWasm, { 28: mine.wasm });
            for (const r of results) {
                console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message}`);
            }
            expect(results.length).toBeGreaterThan(0);
            expect(results.every((r) => r.passed)).toBe(true);
        },
        300000,
    );
});
