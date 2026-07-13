import { describe, expect, test } from "bun:test";

interface ChildResult {
  count: number;
  diagnostics: Array<{ severity: string; message: string; line: number; col: number }>;
  declarations: number;
}

const compilerUrl = new URL("../../src/index.ts", import.meta.url).href;
const childProgram = `
  import { parseToAst } from ${JSON.stringify(compilerUrl)};
  const source = Buffer.from(process.env.QINIT_ADVERSARIAL_SOURCE, "base64").toString("utf8");
  const result = parseToAst({ source, name: "Adversarial", slot: 27 });
  const diagnostics = result.diagnostics.slice(0, 16).map((diagnostic) => ({
    severity: diagnostic.severity,
    message: diagnostic.message.slice(0, 200),
    line: diagnostic.span.line,
    col: diagnostic.span.col,
  }));
  console.log(JSON.stringify({
    count: result.diagnostics.length,
    diagnostics,
    declarations: result.ast.declarations.length,
  }));
`;

async function parseIsolated(source: string, timeoutMs = 5_000): Promise<ChildResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", childProgram],
    env: {
      ...process.env,
      QINIT_ADVERSARIAL_SOURCE: Buffer.from(source).toString("base64"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          child.kill();
          reject(new Error(`compiler did not terminate within ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();

    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout.trim()) as ChildResult;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
  }
}

describe("adversarial compiler input", () => {
  const invalidCases = [
    ["self-recursive macro", "#define LOOP LOOP\nLOOP"],
    ["mutually recursive macros", "#define A B\n#define B A\nA"],
    ["unterminated conditional", "#if 1\nstruct A {};"],
    ["unterminated block comment", "struct A {}; /* never closed"],
    ["unterminated string", 'static_assert(false, "never closed);'],
    ["unterminated character literal", "uint64 f() { return 'x; }"],
    ["embedded NUL", "struct A {};\0struct B {};"],
    ["long invalid token stream", `${"@ ".repeat(2_000)}struct Tail {};`],
  ] as const;

  for (const [name, source] of invalidCases) {
    test(`${name} terminates with bounded diagnostics`, async () => {
      const result = await parseIsolated(source);

      expect(result.count).toBeGreaterThan(0);
      expect(result.count).toBeLessThanOrEqual(256);
      expect(result.diagnostics.every((diagnostic) => diagnostic.message.length <= 200)).toBe(true);
    }, 7_000);
  }

  test("a very long valid identifier terminates without forced rejection", async () => {
    const identifier = `Type${"x".repeat(16_000)}`;
    const result = await parseIsolated(`struct ${identifier} {};`);

    expect(result.count).toBe(0);
    expect(result.declarations).toBe(1);
  }, 7_000);

  test("deep but valid parentheses do not overflow the parser stack", async () => {
    const depth = 256;
    const source = `uint64 value() { return ${"(".repeat(depth)}1${")".repeat(depth)}; }`;
    const result = await parseIsolated(source);

    expect(result.count).toBe(0);
    expect(result.declarations).toBe(1);
  }, 7_000);

  test("deeply nested blocks terminate without an internal exception", async () => {
    const depth = 128;
    const source = `void value() { ${"{".repeat(depth)}${"}".repeat(depth)} }`;
    const result = await parseIsolated(source);

    expect(result.count).toBe(0);
    expect(result.declarations).toBe(1);
  }, 7_000);

  test("adversarial diagnostics are deterministic across processes", async () => {
    const source = "#define A B\n#define B A\nstruct Broken { uint64 value = ; }; A";
    const [first, second] = await Promise.all([parseIsolated(source), parseIsolated(source)]);

    expect(second).toEqual(first);
  }, 7_000);
});
