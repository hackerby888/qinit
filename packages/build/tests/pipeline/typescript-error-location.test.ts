import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithTypeScript } from "../../src";
import { formatCompileError } from "../../src/compile/typescript";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";

// F250: QUERY_ORACLE / INVOKE_OC in a function. clang: "InFn.h:30:26: error: no member named '__qpiQueryOracle'"; the TypeScript build said
// "unsupported template_call '?' as value" twice, with no line and no name.
const IN_FUNCTION = `// Asks the price oracle and invokes OC from inside a read-only function.
using namespace QPI;

struct InFn2
{
};

struct InFn : public ContractBase
{
    struct StateData
    {
        uint64 notifications;
    };

    struct AskFn_input {};
    struct AskFn_output
    {
        sint64 queryId;
        sint64 ocId;
    };
    struct AskFn_locals
    {
        OI::Price::OracleQuery query;
        OCI::Mock::OcRequest request;
    };

    PUBLIC_FUNCTION_WITH_LOCALS(AskFn)
    {
        setMemory(locals.query, 0);
        output.queryId = QUERY_ORACLE(OI::Price, locals.query, OnPrice, 60000);
        setMemory(locals.request, 0);
        output.ocId = INVOKE_OC(OCI::Mock, locals.request);
    }

    typedef OracleNotificationInput<OI::Price> OnPrice_input;
    typedef NoData OnPrice_output;

    PRIVATE_PROCEDURE(OnPrice)
    {
        state.mut().notifications += 1;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE_NOTIFICATION(OnPrice);
        REGISTER_USER_FUNCTION(AskFn, 1);
    }
};
`;

test.skipIf(!HAS_CORE)(
    "the TypeScript build names QUERY_ORACLE and INVOKE_OC in a function at the contract's line, as clang does",
    async () => {
        const directory = mkdtempSync(join(tmpdir(), "qinit-ts-error-location-"));
        const contractPath = join(directory, "InFn.h");
        writeFileSync(contractPath, IN_FUNCTION);
        try {
            const result = await buildContractWithTypeScript({ contractPath, contractName: "InFn", slot: 31, corePath: CORE_PATH, outDir: directory, skipVerify: true });

            expect(result.ok).toBe(false);
            expect(result.stderr).toContain(
                `${contractPath}:30:26: error: 'AskFn' takes QpiContextFunctionCall and cannot use QUERY_ORACLE, which needs QpiContextProcedureCall — call it from a procedure`,
            );
            expect(result.stderr).toContain(`${contractPath}:32:23: error: 'AskFn' takes QpiContextFunctionCall and cannot use INVOKE_OC`);
            expect(result.stderr).not.toContain("template_call");
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    },
    120_000,
);

test("a compile error is located only when its span lies inside the contract's text", () => {
    const source = "0123456789\nabcdefghij\n"; // 22 characters
    const at = (start: number, line: number, column: number) => ({ message: "m", span: { start, line, column } });

    expect(formatCompileError("C.h", source, at(14, 2, 4))).toBe("C.h:2:4: error: m");
    // a backend diagnostic knows only its line
    expect(formatCompileError("C.h", source, at(11, 2, 1))).toBe("C.h:2: error: m");
    // the QPI prelude maps to the first character, a library helper's body to one past the end: neither is a line of C.h
    expect(formatCompileError("C.h", source, at(0, 1, 1))).toBe("error: m");
    expect(formatCompileError("C.h", source, at(22, 3, 1))).toBe("error: m");
    expect(formatCompileError("C.h", source, { message: "m" })).toBe("error: m");
});
