import { CORE_PATH } from "../../../test-utils/paths";
// Compiler diagnostics are consumed by editors and the CLI. Their spans must refer to the original
import { describe, expect, test } from "bun:test";
import { compileContract, loadQpiHeader } from "../src/index";

const HEADERS = loadQpiHeader(CORE_PATH);

const UNKNOWN_SOURCE = [
  `using namespace QPI;`,
  `struct CONTRACT_STATE2_TYPE {};`,
  `struct CONTRACT_STATE_TYPE : public ContractBase {`,
  `  struct StateData { uint64 result; };`,
  `  struct Go_input {}; struct Go_output {};`,
  `  PUBLIC_PROCEDURE(Go) {`,
  `    state.mut().result = missingValue + 1;`,
  `  }`,
  `  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }`,
  `};`,
].join("\n");

const ERROR_LINE = UNKNOWN_SOURCE.slice(0, UNKNOWN_SOURCE.indexOf("missingValue")).split("\n").length;
const ERROR_COLUMN = UNKNOWN_SOURCE.split("\n")[ERROR_LINE - 1]!.indexOf("missingValue") + 1;

describe("edge audit — user-facing diagnostic spans", () => {
  test("an unknown identifier reports its original source line", async () => {
    const result = await compileContract({ source: UNKNOWN_SOURCE, name: "DiagnosticEdge", slot: 27, qpiHeader: HEADERS, arenaSz: 1 << 20 });
    const diagnostic = result.diagnostics.find((d) => /missingValue|unknown.*identifier/i.test(d.message));
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.span.line).toBe(ERROR_LINE);
  });

  test("an unknown identifier reports its original source column", async () => {
    const result = await compileContract({ source: UNKNOWN_SOURCE, name: "DiagnosticEdge", slot: 27, qpiHeader: HEADERS, arenaSz: 1 << 20 });
    const diagnostic = result.diagnostics.find((d) => /missingValue|unknown.*identifier/i.test(d.message));
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.span.col).toBe(ERROR_COLUMN);
  });

  test("a parse error also reports a line within the original source", async () => {
    const source = UNKNOWN_SOURCE.replace(`missingValue + 1`, `1 + ;`);
    const sourceLineCount = source.split("\n").length;
    const result = await compileContract({ source, name: "DiagnosticEdge", slot: 27, qpiHeader: HEADERS, arenaSz: 1 << 20 });
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((d) => d.span.line >= 1 && d.span.line <= sourceLineCount)).toBe(true);
  });
});
