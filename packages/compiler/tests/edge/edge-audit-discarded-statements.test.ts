// A statement whose value is dropped still runs its effects; what cannot be lowered is refused, never emitted as nothing, zero or address 0.
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { edgeClangRunner, edgeCompiler } from "../support/edge-compile";
import { HAS_CORE } from "../../../../test-utils/paths";

const compile = edgeCompiler("DiscardEdge");
// clang builds every kept row too and the two states must match, so a pinned value is also what C++ gives.
const compileAndRun = edgeClangRunner("DiscardEdge");

const MEMBERS = `
  struct Pair { uint64 first; uint64 second; };
  struct Single { uint64 first; };
  struct Box { uint64 held; template <typename T> void put(T value) { held = value; } };
  template <typename T> static void setFive(T& target) { target = 5; }
  static void setSix(uint64& target) { target = 6; }
  static uint64 addFive(uint64& target) { target += 5; return target; }
  static Pair makePair() { Pair pair{}; pair.first = 9; return pair; }
  static Pair bumpPair(uint64& target) { Pair pair{}; target += 5; return pair; }
  typedef OracleNotificationInput<OI::Price> OnReply_input;
  typedef NoData OnReply_output;
  PRIVATE_PROCEDURE(OnReply) { state.mut().result = 5; }`;

const wrap = (body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; };
  ${MEMBERS}
  struct Go_input {}; struct Go_output {};
  struct Go_locals { uint64 yes; uint64 no; uint64 value; uint64 index; Pair pair; Single single; Box box; OI::Price::OracleQuery query; sint64 queryId; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) { locals.yes = 1; state.mut().result = 7; ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE_NOTIFICATION(OnReply); REGISTER_USER_PROCEDURE(Go, 1); }
};`;

// every row starts from result = 7, so a row that expects 7 proves the statement did nothing.
// the oracle rows: the contract holds no qu, so the query fails and its notification writes 5 inside the call.
const KEPT: Record<string, [string, bigint]> = {
    "&& runs its right side when the left is true": ["locals.yes && (state.mut().result = 5);", 5n],
    "&& skips its right side when the left is false": ["locals.no && (state.mut().result = 5);", 7n],
    "|| runs its right side when the left is false": ["locals.no || (state.mut().result = 5);", 5n],
    "|| skips its right side when the left is true": ["locals.yes || (state.mut().result = 5);", 7n],
    "ternary runs its true side": ["locals.yes ? (state.mut().result = 5) : (state.mut().result = 6);", 5n],
    "ternary runs its false side": ["locals.no ? (state.mut().result = 5) : (state.mut().result = 6);", 6n],
    "ternary of void calls": ["locals.no ? setFive(locals.value) : setSix(locals.value); state.mut().result = locals.value;", 6n],
    "parenthesized assignment": ["(state.mut().result = 5);", 5n],
    "void cast of an assignment": ["(void)(state.mut().result = 5);", 5n],
    "void cast of a call": ["(void)addFive(locals.value); state.mut().result = locals.value;", 5n],
    "static_cast of an increment": ["static_cast<uint64>(locals.value++); state.mut().result = locals.value;", 1n],
    "helper with written template arguments": ["setFive<uint64>(locals.value); state.mut().result = locals.value;", 5n],
    "method with written template arguments": ["locals.box.put<uint64>(5); state.mut().result = locals.box.held;", 5n],
    "operator over a call": ["!addFive(locals.value); state.mut().result = locals.value;", 5n],
    "operator over two effects": ["locals.value++ + addFive(locals.value); state.mut().result = locals.value;", 6n],
    "member of a call result": ["bumpPair(locals.value).first; state.mut().result = locals.value;", 5n],
    "nested wrappers": ["((void)(locals.yes && ((state.mut().result = 5))));", 5n],
    "for update with a short-circuit": ["for (locals.index = 0; locals.index < 3; locals.index++, locals.yes && (locals.value += 2)) {} state.mut().result = locals.value;", 6n],
    "oracle query as a statement": ["QUERY_ORACLE(OI::Price, locals.query, OnReply, 1000);", 5n],
    "oracle query as a value": ["locals.queryId = QUERY_ORACLE(OI::Price, locals.query, OnReply, 1000);", 5n],
    "sizeof does not evaluate its operand": ["sizeof(locals.value++); state.mut().result = locals.value;", 0n],
    "a name alone": ["locals.value;", 7n],
    "arithmetic alone": ["locals.value + 1;", 7n],
    "an aggregate alone": ["locals.pair;", 7n],
};

// copyToBuffer(dst, src, setTailToZero): dst.second is the tail past the 8 bytes src fills.
const TAIL = "locals.pair.second = 9; locals.single.first = 5;";
const tailResult = "state.mut().result = locals.pair.first * 10 + locals.pair.second;";

const TAILS: Record<string, [string, bigint]> = {
    "two arguments keep the tail": [`${TAIL} copyToBuffer(locals.pair, locals.single); ${tailResult}`, 59n],
    "false keeps the tail": [`${TAIL} copyToBuffer(locals.pair, locals.single, false); ${tailResult}`, 59n],
    "true zeroes the tail": [`${TAIL} copyToBuffer(locals.pair, locals.single, true); ${tailResult}`, 50n],
    "a runtime flag zeroes the tail": [`${TAIL} copyToBuffer(locals.pair, locals.single, locals.yes == 1); ${tailResult}`, 50n],
    "equal sizes have no tail": [`${TAIL} copyToBuffer(locals.single, locals.single, true); state.mut().result = locals.single.first;`, 5n],
};

const REFUSED: Record<string, [string, RegExp]> = {
    "an aggregate helper where a number is needed": ["state.mut().result = makePair();", /aggregate helper makePair used as a scalar/],
    "a void helper where a number is needed": ["state.mut().result = setSix(locals.value);", /void helper setSix used as a scalar/],
    "a memory wrapper source with no address": ["copyToBuffer(locals.pair, 5ULL);", /argument 2 of copyToBuffer\(2\) is not addressable/],
};

async function refusal(source: string): Promise<string> {
    const result = await compile(source);

    return result.diagnostics
        .filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)
        .map((diagnostic) => diagnostic.message)
        .join("\n");
}

describe.skipIf(!HAS_CORE)("edge audit — discarded statements", () => {
    beforeAll(async () => {
        await initK12();
    });

    for (const [name, [body, expected]] of Object.entries(KEPT)) {
        test(name, async () => {
            expect(await compileAndRun(wrap(body))).toBe(expected);
        });
    }

    for (const [name, [body, expected]] of Object.entries(TAILS)) {
        test(`copyToBuffer: ${name}`, async () => {
            expect(await compileAndRun(wrap(body))).toBe(expected);
        });
    }

    for (const [name, [body, diagnostic]] of Object.entries(REFUSED)) {
        test(`refuses ${name}`, async () => {
            expect(await refusal(wrap(body))).toMatch(diagnostic);
        });
    }
});
