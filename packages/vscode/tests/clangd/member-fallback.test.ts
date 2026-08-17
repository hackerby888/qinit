import { test, expect } from "bun:test";
import { memberFallbackCompletions, type FallbackRequest } from "../../src/member-fallback";

// No qpiHeader is supplied, so the query uses the generated snapshot: these run with no core checkout,
// no clang++ and no wasi-sdk — the environment an editor-only user has.
const COUNTER_SOURCE = `using namespace QPI;

struct Counter : public ContractBase {
  struct StateData { uint64 counter; };
  struct Get_input {
    Array<uint64, 8> bc;
    sint16 a;
  };
  struct Get_output { uint64 value; };

  PUBLIC_FUNCTION(Get) {
    output.value = state.get().counter;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Get, 1);
  }
};
`;

const CROSSCALL_SOURCE = `using namespace QPI;

struct CrossCall : public ContractBase {
  struct StateData { HashMap<id, uint64, 1024> balances; };
  struct Read_input {};
  struct Read_output { uint64 value; };
  struct Read_locals { Counter::Get_input gi; Counter::Get_output go; };

  PUBLIC_FUNCTION_WITH_LOCALS(Read) {
    CALL_OTHER_CONTRACT_FUNCTION(Counter, Get, locals.gi, locals.go);
    output.value = locals.go.value;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};
`;

const MARKER = "    CALL_OTHER_CONTRACT_FUNCTION(Counter, Get, locals.gi, locals.go);";

const CROSSCALL_CONTEXT = {
    contractName: "CrossCall",
    slot: 30,
    calleeSources: [{ name: "Counter", source: COUNTER_SOURCE, slot: 29 }],
};

/** Insert `probeLine` after the call marker and complete at its last member operator. */
function requestAt(probeLine: string, context: FallbackRequest["context"] = CROSSCALL_CONTEXT, counterSource = COUNTER_SOURCE): FallbackRequest {
    const callees = context?.calleeSources?.map((callee) => (callee.name === "Counter" ? { ...callee, source: counterSource } : callee));
    const bufferText = CROSSCALL_SOURCE.replace(MARKER, `${MARKER}\n${probeLine}`);
    return {
        bufferText,
        line: bufferText.split("\n").findIndex((text) => text === probeLine),
        character: probeLine.lastIndexOf(".") + 1,
        context: callees ? { ...context, calleeSources: callees } : context,
    };
}

async function names(request: FallbackRequest): Promise<string[]> {
    return ((await memberFallbackCompletions(request)) ?? []).map((item) => item.name);
}

// The user-reported repro: a callee's input struct reached through locals, which the clangd bug
// answers with an empty list because the struct holds a template member.
test("completes locals.gi. members on the cross-call repro", async () => {
    expect(await names(requestAt("    locals.gi."))).toEqual(expect.arrayContaining(["bc", "a"]));
});

test("completes a template container reached through contract state", async () => {
    const labels = await names(requestAt("    state.mut().balances."));

    expect(labels).toEqual(expect.arrayContaining(["set", "get", "population"]));
    // Private members are the caller's to filter, but the reserved names never reach it as fields.
    expect(labels).not.toContain("HashMap");
});

// Asked at the member operator, so the whole list comes back; asking at the cursor would return `a` alone.
test("completing at the member operator returns the whole list", async () => {
    const probeLine = "    locals.gi.a";
    const bufferText = CROSSCALL_SOURCE.replace(MARKER, `${MARKER}\n${probeLine}`);
    const labels = await names({
        bufferText,
        line: bufferText.split("\n").findIndex((text) => text === probeLine),
        character: probeLine.lastIndexOf(".") + 1,
        context: CROSSCALL_CONTEXT,
    });

    expect(labels).toEqual(expect.arrayContaining(["a", "bc"]));
});

test("carries the signature chunks the completion item is built from", async () => {
    const set = (await memberFallbackCompletions(requestAt("    state.mut().balances.")))?.find((item) => item.name === "set");

    expect(set).toEqual({
        name: "set",
        kind: "method",
        returnType: "sint64",
        placeholders: ["const id& key", "const uint64& value"],
    });
    const balances = (await memberFallbackCompletions(requestAt("    state.mut().")))?.find((item) => item.name === "balances");
    expect(balances).toEqual({ name: "balances", kind: "field", returnType: "HashMap<id, uint64, 1024>", placeholders: [] });
});

test("an edited callee is completed from its new source", async () => {
    const edited = COUNTER_SOURCE.replace("sint16 a;", "sint16 a;\n    sint16 zz;");

    expect(await names(requestAt("    locals.gi.", CROSSCALL_CONTEXT, edited))).toEqual(expect.arrayContaining(["bc", "zz"]));
});

test("a document with no analysis context still answers what the snapshot alone can resolve", async () => {
    // Without the callee's source the callee type is unknown, but contract state is still resolvable.
    expect(await names(requestAt("    locals.gi.", { contractName: "CrossCall", slot: 30 }))).toEqual([]);
    expect(await names(requestAt("    state.mut().balances.", { contractName: "CrossCall", slot: 30 }))).toContain("set");
});

test("a cancelled request answers nothing", async () => {
    const cancelled = {
        ...requestAt("    locals.gi."),
        cancel: { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => {} }) },
    };

    expect(await memberFallbackCompletions(cancelled)).toBeUndefined();
});

test("returns undefined rather than an empty list when nothing resolves", async () => {
    expect(await memberFallbackCompletions(requestAt("    notAThing."))).toBeUndefined();
    // No member operator precedes the cursor.
    expect(await memberFallbackCompletions({ ...requestAt("    locals.gi."), character: 2 })).toBeUndefined();
});

// A gtest is general C++, so nothing here parses as a contract: the root's type comes from the language
// server (stubbed offline) and only the hops after it are resolved by the compiler.
const GTEST_SOURCE = `#include "contract_testing.h"

TEST(ContractCounter, Get)
{
    Counter::Get_input gi;
    gi.bc.
}
`;

function gtestRequest(rootTypeText?: string): FallbackRequest {
    const probeLine = "    gi.bc.";
    return {
        bufferText: GTEST_SOURCE,
        line: GTEST_SOURCE.split("\n").findIndex((text) => text === probeLine),
        character: probeLine.length,
        context: { contractName: "CounterTest", slot: 30, calleeSources: [{ name: "Counter", source: COUNTER_SOURCE, slot: 29 }] },
        rootType: rootTypeText ? async () => rootTypeText : undefined,
    };
}

test("completes a gtest receiver from the root type the language server reports", async () => {
    expect(await names(gtestRequest("Counter::Get_input"))).toEqual(expect.arrayContaining(["capacity", "get", "set"]));
    // The same shape as a const reference, which is how clangd spells a bound parameter.
    expect(await names(gtestRequest("const Counter::Get_input &"))).toContain("set");
});

test("a gtest answers nothing without a resolvable root type", async () => {
    expect(await memberFallbackCompletions(gtestRequest("auto &"))).toBeUndefined();
    // Neither the language server nor the text knows this one.
    const unknown = { ...gtestRequest(), bufferText: GTEST_SOURCE.replace("Counter::Get_input gi;", "") };
    expect(await memberFallbackCompletions(unknown)).toBeUndefined();
});

// The state the buffer is actually in while completion runs: the statement is half-typed, so the
// language server drops it and hover on the root answers nothing. The declaration in the text does.
test("completes a half-typed receiver when hover answers nothing", async () => {
    const probeLine = "    gi.bc.";
    const bufferText = GTEST_SOURCE.replace("    gi.bc.", `${probeLine}\n\n    Counter::Get_output go;\n    go.`);

    const at = (line: string, rootType?: FallbackRequest["rootType"]) => ({
        ...gtestRequest(),
        bufferText,
        line: bufferText.split("\n").findIndex((text) => text === line),
        character: line.length,
        rootType,
    });

    expect(await names(at(probeLine))).toEqual(expect.arrayContaining(["capacity", "get", "set"]));
    // A declaration below the dangling line still resolves.
    expect(await names(at("    go."))).toEqual(["value"]);
    // Hover outranks the text when it answers: `go` reads as Get_output there, as Get_input here.
    expect(await names(at("    go.", async () => "Counter::Get_input"))).toEqual(["bc", "a"]);
});
