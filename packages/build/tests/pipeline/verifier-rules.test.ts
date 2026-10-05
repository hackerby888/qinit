// VERIFIER_RULES stands in for core's native verifier where it cannot run, so each code must be one the tool itself refuses.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { analyzeContract, verifierViolations, VERIFIER_RULES } from "@qinit/compiler/analyzer";
import { resolveVerifyTool, verifyContract } from "../../src";

const contract = (global: string, stateField: string, body: string) => `using namespace QPI;
${global}
struct Probe2
{
};

struct Probe : public ContractBase
{
    struct StateData
    {
        uint64 total;
${stateField}
    };

    struct Add_input
    {
        uint64 amount;
    };
    struct Add_output
    {
        uint64 total;
    };

    PUBLIC_PROCEDURE(Add)
    {
${body}
        state.mut().total += input.amount;
        output.total = state.get().total;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Add, 1);
    }
};
`;

const CONTROL = contract("", "", "");

// one source per code, each a single edit of the control.
const REFUSED: Array<[code: string, source: string]> = [
    ["qpi/no-float", contract("", "        float ratio;", "")],
    ["qpi/no-float", contract("", "        double ratio;", "")],
    ["qpi/no-union", contract("union ProbePair { uint64 a; sint64 b; };", "", "")],
    ["qpi/no-const-cast", contract("", "", "        const_cast<uint64&>(input.amount) = 1;")],
    ["qpi/no-qpicontext", contract("", "        QpiContext* context;", "")],
    ["qpi/no-string", contract("", "", '        output.total = sizeof("abc");')],
    ["qpi/no-char", contract("", "", "        output.total = 'a';")],
    ["qpi/no-preprocessor", contract("#define PROBE_LIMIT 5", "", "")],
    ["qpi/no-division", contract("", "", "        output.total = input.amount / 2;")],
    ["qpi/no-modulo", contract("", "", "        output.total = input.amount % 2;")],
    ["qpi/no-brackets", contract("", "        uint64 slots[4];", "")],
    ["qpi/no-varargs", contract("", "", "").replace("    struct Add_input", "    static uint64 sumAll(uint64 first, ...) { return first; }\n    struct Add_input")],
    ["qpi/no-dunder", contract("", "        uint64 __hidden;", "")],
    ["qpi/no-global-typedef", contract("typedef uint64 ProbeAmount;", "", "")],
    ["qpi/no-global-using", contract("using ProbeAmount = uint64;", "", "")],
    ["qpi/stack-local", contract("", "", "        uint64 doubled = input.amount * 2;")],
];

const violationCodes = (source: string) => verifierViolations(analyzeContract({ source, contractName: "Probe" }).diagnostics, source).map((item) => item.code);

test("the control contract has no verifier violation", () => {
    expect(violationCodes(CONTROL)).toEqual([]);
});

test("every code in VERIFIER_RULES has a probe, and every probe is reported under its code", () => {
    expect(new Set(REFUSED.map(([code]) => code))).toEqual(new Set(VERIFIER_RULES));

    for (const [code, source] of REFUSED) {
        expect(violationCodes(source)).toContain(code);
    }
});

test("a double underscore inside a name is the lint's warning, not a verifier violation", () => {
    const source = contract("", "        uint64 my__field;", "");

    expect(analyzeContract({ source, contractName: "Probe" }).diagnostics.map((item) => item.code)).toContain("qpi/no-dunder");
    expect(violationCodes(source)).toEqual([]);
});

const scratch = mkdtempSync(join(tmpdir(), "qinit-verifier-rules-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// the claim the set rests on: the native tool passes the control and refuses each probe.
test.skipIf(!resolveVerifyTool())("the native verifier refuses every probe and passes the control", async () => {
    const verdict = async (source: string, index: number) => {
        const file = join(scratch, `probe-${index}.h`);
        writeFileSync(file, source);
        return (await verifyContract(file, "Probe")).ok;
    };

    expect(await verdict(CONTROL, 0)).toBe(true);
    expect(await verdict(contract("", "        uint64 my__field;", ""), 1)).toBe(true);

    for (const [index, [code, source]] of REFUSED.entries()) {
        expect([code, await verdict(source, index + 2)]).toEqual([code, false]);
    }
});
