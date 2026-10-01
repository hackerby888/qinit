// A notification's entry number is the __LINE__ of its PRIVATE_PROCEDURE; a declaration split over lines used to miss the one-line
// match and fall back to a preprocessed line, so the TypeScript build and the IDL disagreed with clang's wasm.
import { expect, test } from "bun:test";
import { collectProcedureDeclLines } from "../../src/driver/semantic-calls";

test("a one-line declaration keeps its own line", () => {
    const lines = collectProcedureDeclLines("struct C {\n    PUBLIC_PROCEDURE(Ask)\n    PRIVATE_PROCEDURE_WITH_LOCALS(OnPrice)\n};");
    expect(lines.get("Ask")).toBe(2);
    expect(lines.get("OnPrice")).toBe(3);
});

test("a split declaration takes the line of its closing parenthesis, as clang's __LINE__ does", () => {
    const source = "struct C {\n    PRIVATE_PROCEDURE_WITH_LOCALS(\n        OnPrice)\n    PUBLIC_PROCEDURE(Ask\n    )\n    PRIVATE_PROCEDURE(\n        OnMock\n    )\n};";
    const lines = collectProcedureDeclLines(source);
    expect(lines.get("OnPrice")).toBe(3);
    expect(lines.get("Ask")).toBe(5);
    expect(lines.get("OnMock")).toBe(8);
});
