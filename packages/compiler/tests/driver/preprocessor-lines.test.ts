// The other half of the same defect: a directive's line is consumed and emitted nothing, so every
// diagnostic below it was reported one line too high per directive line. The span is what the editor
// draws a squiggle on, so the squiggle landed on a line the developer did not write the error on.
import { expect, test } from "bun:test";
import { analyzeContract } from "../../src/analyzer";

function contractWithBadType(parked: string): { source: string; line: number } {
    const source = `using namespace QPI;
${parked}
struct Desk2 {};
struct Desk : public ContractBase
{
    struct StateData
    {
        uint64 alpha;
        NotAType wrong;
    };
    struct Go_input {}; struct Go_output { uint64 v; };
    PUBLIC_FUNCTION(Go) { output.v = state.get().alpha; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Go, 1); }
};
`;
    return { source, line: source.split("\n").findIndex((text) => text.includes("NotAType")) + 1 };
}

function reportedLine(parked: string): { reported: number | undefined; actual: number } {
    const { source, line } = contractWithBadType(parked);
    const errors = analyzeContract({ source, contractName: "Desk", slot: 28 }).diagnostics.filter((item) => item.severity === "error");

    return { reported: errors[0]?.span.line, actual: line };
}

test("an unknown type is reported on its own line", () => {
    const { reported, actual } = reportedLine("");

    expect(reported).toBe(actual);
});

test("a #define above the error does not move the error's line", () => {
    const { reported, actual } = reportedLine("#define PARKED 1");

    expect(reported).toBe(actual);
});

test("an #if 0 block above the error does not move the error's line", () => {
    const { reported, actual } = reportedLine("#if 0\nstruct Parked { uint64 x; };\n#endif");

    expect(reported).toBe(actual);
});
