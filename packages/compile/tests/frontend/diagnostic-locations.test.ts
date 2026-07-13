import { describe, expect, test } from "bun:test";
import { compileContract, parseToAst } from "../../src/index";

function errorsFor(source: string, qpiHeader?: string) {
  return parseToAst({ source, qpiHeader, name: "DiagProbe", slot: 27 }).diagnostics
    .filter((diagnostic) => diagnostic.severity === "error");
}

function diagnosticOnLine(source: string, line: number) {
  const diagnostic = errorsFor(source).find((candidate) => candidate.span.line === line);
  expect(diagnostic).toBeDefined();
  return diagnostic!;
}

describe("compiler diagnostics - source locations", () => {
  test("maps a first-line parse error into user source coordinates", () => {
    const source = "struct Broken { uint64 value = ; };";
    const diagnostic = diagnosticOnLine(source, 1);
    const badToken = source.indexOf(";");

    expect(diagnostic.span.start).toBe(badToken);
    expect(diagnostic.span.end).toBeGreaterThan(diagnostic.span.start);
    expect(diagnostic.span.col).toBe(badToken + 1);
  });

  test("maps a multiline parse error without exposing scaffold lines", () => {
    const source = [
      "struct Broken {",
      "  uint64 good;",
      "  uint64 bad = ;",
      "};",
    ].join("\n");
    const diagnostic = diagnosticOnLine(source, 3);
    const badToken = source.indexOf(";", source.indexOf("bad"));

    expect(diagnostic.span.start).toBe(badToken);
    expect(diagnostic.span.end).toBeLessThanOrEqual(source.length);
    expect(errorsFor(source).every((candidate) => candidate.span.line <= 4)).toBe(true);
  });

  test("handles BOM, CRLF, and a leading tab consistently", () => {
    const source = "\uFEFFstruct Broken {\r\n\tuint64 value = ;\r\n};";
    const diagnostic = diagnosticOnLine(source, 2);
    const badToken = source.indexOf(";");

    expect(diagnostic.span.start).toBe(badToken);
    expect(diagnostic.span.col).toBe(17);
  });

  test("keeps offsets sliceable after non-ASCII source text", () => {
    const source = "// pi: π, face: 😀\nstruct Broken { uint64 value = ; };";
    const diagnostic = diagnosticOnLine(source, 2);
    const badToken = source.indexOf(";");

    // Public spans must use source-string offsets so editor clients can slice the original text.
    expect(diagnostic.span.start).toBe(badToken);
    expect(source.slice(diagnostic.span.start, diagnostic.span.end)).toContain(";");
  });

  test("anchors an unexpected EOF at the end of user source", () => {
    const source = "struct Broken {\n  uint64 value;";
    const diagnostics = errorsFor(source);

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((diagnostic) => diagnostic.span.start === source.length)).toBe(true);
    expect(diagnostics.every((diagnostic) => diagnostic.span.start <= source.length)).toBe(true);
  });

  test("does not leak diagnostics from the supplied QPI header", () => {
    const qpiHeader = "struct HeaderNoise { uint64 broken = ; };";
    const source = "struct UserNoise { uint64 broken = ; };";
    const diagnostics = errorsFor(source, qpiHeader);

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((diagnostic) => diagnostic.span.line === 1)).toBe(true);
    expect(diagnostics.every((diagnostic) => diagnostic.span.start <= source.length)).toBe(true);
  });

  test("still requires embedded ABI metadata for full compilation", async () => {
    await expect(compileContract({
      source: "struct UserSource {};",
      name: "DiagProbe",
      slot: 27,
      qpiHeader: "struct HeaderOnly {};",
    })).rejects.toThrow("QPI headers are missing embedded core ABI metadata");
  });

  test("orders and deduplicates recovered diagnostics deterministically", () => {
    const source = [
      "struct Broken {",
      "  uint64 first = ;",
      "  uint64 second = ;",
      "};",
    ].join("\n");
    const signature = () => errorsFor(source).map((diagnostic) =>
      `${diagnostic.span.start}:${diagnostic.span.end}:${diagnostic.message}`
    );
    const first = signature();
    const second = signature();

    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
    expect(errorsFor(source).map((diagnostic) => diagnostic.span.start))
      .toEqual([...errorsFor(source).map((diagnostic) => diagnostic.span.start)].sort((a, b) => a - b));
  });

  test("strict mode upgrades a source-mapped floating-point fidelity warning", async () => {
    const source = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct Size_input { uint64 value; };
  struct Size_output { uint64 value; };
  PUBLIC_FUNCTION(Size)
  {
    output.value = 1.5;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Size, 1); }
};`;
    const lax = await compileContract({ source, name: "DiagSize", slot: 27, strict: false });
    const strict = await compileContract({ source, name: "DiagSize", slot: 27, strict: true });
    const laxFidelity = lax.diagnostics.find((diagnostic) => diagnostic.category === "fidelity");
    const strictFidelity = strict.diagnostics.find((diagnostic) => diagnostic.category === "fidelity");

    expect(laxFidelity?.severity).toBe("warning");
    expect(lax.wasm.byteLength).toBeGreaterThan(0);
    expect(strictFidelity?.severity).toBe("error");
    expect(strictFidelity?.span.line).toBe(9);
    expect(strict.wasm.byteLength).toBe(0);
  });
});
