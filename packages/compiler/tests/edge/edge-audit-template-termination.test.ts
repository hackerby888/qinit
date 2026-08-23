// A compiler that loops takes the whole suite's timeout with it and names no fixture, so these
// compile in a child process that gets killed. Every case here is code Clang accepts.
import { describe, expect, test } from "bun:test";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";

const compilerUrl = new URL("../../src/index.ts", import.meta.url).href;
const childProgram = `
  import { compileContractWithTypeScript, loadQpiHeader } from ${JSON.stringify(compilerUrl)};
  const source = Buffer.from(process.env.QINIT_TERMINATION_SOURCE, "base64").toString("utf8");
  const result = await compileContractWithTypeScript({
    source,
    contractName: "Termination",
    slot: 27,
    qpiHeader: loadQpiHeader(process.env.QINIT_TERMINATION_CORE),
    arenaSizeBytes: 1 << 20,
  });
  console.log(JSON.stringify({ errors: result.diagnostics.filter((d) => d.severity === "error").map((d) => d.message.slice(0, 200)) }));
`;

async function compileIsolated(source: string, timeoutMs: number): Promise<string[]> {
    const child = Bun.spawn({
        cmd: [process.execPath, "-e", childProgram],
        env: {
            ...process.env,
            QINIT_TERMINATION_SOURCE: Buffer.from(source).toString("base64"),
            QINIT_TERMINATION_CORE: CORE_PATH,
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
                    reject(new Error(`the compiler did not terminate within ${timeoutMs}ms`));
                }, timeoutMs);
            }),
        ]);
        const stdout = await new Response(child.stdout).text();
        const stderr = await new Response(child.stderr).text();

        expect(exitCode, stderr).toBe(0);
        return (JSON.parse(stdout.trim()) as { errors: string[] }).errors;
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (child.exitCode === null) child.kill();
    }
}

const wrap = (members: string, width: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  template <typename T> struct K { T a; T b; ${members} };
  struct StateData { uint64 result; };
  struct Go_input {}; struct Go_output {};
  struct Go_locals { K<${width}> l; K<${width}> r; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) { locals.l = {1,2}; locals.r = {1,99}; ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

const EQUALITY = (parameter: string) => `bool operator==(${parameter}& other) const { return a == other.a; }`;
const COMPARE = "state.mut().result = (locals.l == locals.r) ? 1 : 0;";

describe.skipIf(!HAS_CORE)("a template instantiation terminates", () => {
    // Writing the arguments out is the same declaration as the injected name. Compiling the operator
    // against an unbound instantiation left T with nothing to bind to and never finished.
    for (const parameter of ["const K", "const K<T>"]) {
        for (const width of ["uint8", "uint64"]) {
            test(`operator== taking \`${parameter}&\` at ${width}`, async () => {
                expect(await compileIsolated(wrap(EQUALITY(parameter), width, COMPARE), 20_000)).toEqual([]);
            }, 30_000);
        }
    }
});
