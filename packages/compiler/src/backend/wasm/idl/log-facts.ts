import { AssignOp, AstKind } from "../../../shared/enums";
import type { Expression, FunctionDecl, Statement, TypeSpec } from "../../../ast";
import { parseIntLiteral } from "../../../frontend/lexer";
import type { ProgramAnalysis } from "../../../semantics/program-analysis";
import type { StructLayout } from "../../../semantics/types";
import type { PreparedContractModule } from "../module/module-analysis";
import { LOG_INTRINSIC_LEVELS } from "../abi/log-payload";
import { collectPayloadRoots, resolvePayload, visitStatement, type PayloadRoots } from "../module/log-call-validation";

export const LOG_TYPE_FIELD = "_type";

// what the walk learned about one log struct. `types` turns null once a `_type` write cannot be folded: a partial set would let a decoder rule the struct out wrongly.
export interface LogStructFacts {
    types: Set<bigint> | null;
    // the header types the struct is logged under
    severities: Set<number>;
}

export interface LogFacts {
    structs: Map<string, LogStructFacts>;
    // the line of a `_type` write, or of a LOG_* payload, the walk could not attribute to a struct; past it no struct's set is complete.
    untracedTypeWrite?: number;
    untracedLog?: number;
}

// the `_type` values a contract writes into each log struct and the severities it logs it at, keyed by bare name: two structs of one size are told apart by these.
export function collectLogFacts(prepared: PreparedContractModule): LogFacts {
    const facts: LogFacts = { structs: new Map() };
    const contract = prepared.contract;

    if (!contract) {
        return facts;
    }

    const rootsByFunction = collectPayloadRoots(prepared);

    for (const member of contract.members) {
        if (member.kind !== AstKind.FUNCTION) {
            continue;
        }

        const declaration = member as FunctionDecl;
        const roots = rootsByFunction.get(declaration.name);

        if (!roots || !declaration.body) {
            continue;
        }

        visitStatement(declaration.body, (statement) => {
            if (statement.kind !== AstKind.EXPRESSION) {
                return;
            }

            const expression = statement.expression;

            if (expression.kind === AstKind.CALL) {
                recordLogCall(prepared.programAnalysis, roots, facts, expression, statement);
                return;
            }

            if (expression.kind !== AstKind.ASSIGN || expression.operator !== AssignOp.ASSIGN) {
                return;
            }

            const target = expression.left;

            if (target.kind === AstKind.MEMBER_ACCESS && target.member === LOG_TYPE_FIELD) {
                recordTypeWrite(prepared.programAnalysis, roots, facts, target.object, expression.right, statement);
                return;
            }

            if (expression.right.kind === AstKind.CONSTRUCT || expression.right.kind === AstKind.INITIALIZER_LIST) {
                recordAggregateWrite(prepared.programAnalysis, roots, facts, target, expression.right);
            }
        });
    }

    return facts;
}

function recordLogCall(programAnalysis: ProgramAnalysis, roots: PayloadRoots, facts: LogFacts, call: Expression & { kind: AstKind.CALL }, statement: Statement): void {
    const level = call.callee.kind === AstKind.IDENTIFIER ? LOG_INTRINSIC_LEVELS.get(call.callee.name) : undefined;
    const argument = call.callArguments[0];

    if (level === undefined || !argument) {
        return;
    }

    const payload = resolvePayload(programAnalysis, roots, argument);

    if (!payload?.layout) {
        facts.untracedLog ??= statement.span.line;
        return;
    }

    const structName = payload.type ? bareStructName(programAnalysis, payload.type) : null;

    if (structName) {
        structFacts(facts, structName).severities.add(level);
    }
}

function recordTypeWrite(programAnalysis: ProgramAnalysis, roots: PayloadRoots, facts: LogFacts, object: Expression, value: Expression, statement: Statement): void {
    const payload = resolvePayload(programAnalysis, roots, object);

    if (!payload?.layout) {
        facts.untracedTypeWrite ??= statement.span.line;
        return;
    }

    const structName = payload.type ? bareStructName(programAnalysis, payload.type) : null;

    if (structName) {
        recordValue(programAnalysis, facts, structName, value);
    }
}

// `T{…}` names its struct itself; a bare `{…}` takes it from the target. position i fills the i-th layout field, as emitConstruct lays it out, and a missing tail is value-initialised to zero.
function recordAggregateWrite(programAnalysis: ProgramAnalysis, roots: PayloadRoots, facts: LogFacts, target: Expression, initializer: Expression): void {
    let layout: StructLayout | null = null;
    let structName: string | null = null;
    let elements: Expression[] = [];

    if (initializer.kind === AstKind.CONSTRUCT) {
        layout = programAnalysis.layoutOfType(initializer.type);
        structName = bareStructName(programAnalysis, initializer.type);
        elements = initializer.callArguments;
    } else if (initializer.kind === AstKind.INITIALIZER_LIST) {
        const payload = resolvePayload(programAnalysis, roots, target);
        layout = payload?.layout ?? null;
        structName = payload?.type ? bareStructName(programAnalysis, payload.type) : null;
        elements = initializer.expressions;
    }

    if (!layout || !structName) {
        return;
    }

    const index = [...layout.fields.values()].findIndex((field) => field.name === LOG_TYPE_FIELD);

    if (index < 0) {
        return;
    }

    const element = elements[index];

    if (element) {
        recordValue(programAnalysis, facts, structName, element);
        return;
    }

    structFacts(facts, structName).types?.add(0n);
}

function recordValue(programAnalysis: ProgramAnalysis, facts: LogFacts, structName: string, expression: Expression): void {
    const recorded = structFacts(facts, structName);
    const value = foldedConstant(programAnalysis, expression);

    if (value === null) {
        recorded.types = null;
    } else {
        recorded.types?.add(value);
    }
}

function structFacts(facts: LogFacts, structName: string): LogStructFacts {
    let recorded = facts.structs.get(structName);

    if (!recorded) {
        recorded = { types: new Set(), severities: new Set() };
        facts.structs.set(structName, recorded);
    }

    return recorded;
}

// a field typed `Contract::Log` arrives resolved to the struct itself, a bare `Log` as a name.
function bareStructName(programAnalysis: ProgramAnalysis, type: TypeSpec): string | null {
    const resolved = programAnalysis.derefType(type);

    if (resolved.kind === AstKind.INLINE_STRUCT) {
        return resolved.struct.name ?? null;
    }

    if (resolved.kind !== AstKind.NAME) {
        return null;
    }

    return resolved.name.includes("::") ? resolved.name.slice(resolved.name.lastIndexOf("::") + 2) : resolved.name;
}

function foldedConstant(programAnalysis: ProgramAnalysis, expression: Expression): bigint | null {
    switch (expression.kind) {
        case AstKind.INT_LITERAL:
            return parseIntLiteral(expression.value);
        case AstKind.IDENTIFIER:
            return programAnalysis.resolveConst(expression.name);
        case AstKind.QUALIFIED_NAME:
            return programAnalysis.resolveConst(`${expression.namespace}::${expression.name}`);
        case AstKind.PAREN:
            return foldedConstant(programAnalysis, expression.expression);
        default:
            return null;
    }
}
