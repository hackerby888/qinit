import { AstKind, LogPayloadDefect } from "../../../shared/enums";
import type { ProgramAnalysis } from "../../../semantics/program-analysis";
import type { StructLayout } from "../../../semantics/types";
import type { Expression, FunctionDecl, Statement, TypeSpec } from "../../../ast";
import { isKnownScalarType, logPayloadDefect, logPayloadMessage } from "../abi/log-payload";
import { SYSPROC_IO } from "../abi/tables";
import { isStateAccessor } from "../memory/address-resolution";
import type { PreparedContractModule } from "./module-analysis";

const MIGRATION_IMPLEMENTATION = "__impl_migrate";

// Entries taking this context are functions; procedures take QpiContextProcedureCall.
const QPI_FUNCTION_CONTEXT = "QpiContextFunctionCall";

const LOG_INTRINSICS: ReadonlySet<string> = new Set(["__qinit_log_error", "__qinit_log_warning", "__qinit_log_info", "__qinit_log_debug"]);

// The magic names a payload can be rooted at, bound the way function emission binds them.
interface PayloadRoots {
    locals: StructLayout;
    input: StructLayout;
    output: StructLayout;
    state: StructLayout;
}

interface ResolvedPayload {
    layout: StructLayout | null;
    type: TypeSpec | null;
}

// Report LOG_* calls that cannot reach the chain, and payloads that break the host contract.
// Running here rather than in emission is what lets the editor see them.
export function validateLogCalls(prepared: PreparedContractModule): void {
    const contract = prepared.contract;

    if (!contract) {
        return;
    }

    const rootsByFunction = collectPayloadRoots(prepared);

    // Only the contract's own members are walked. In gtest's second pass the contract is the runner,
    // so the target's calls sit in a sibling declaration and are never reported twice.
    for (const member of contract.members) {
        if (member.kind !== AstKind.FUNCTION) {
            continue;
        }

        const declaration = member as FunctionDecl;
        const roots = rootsByFunction.get(declaration.name);

        if (!roots || !declaration.body) {
            continue;
        }

        const unreachable = logsCannotReachTheChain(prepared, declaration);

        visitStatement(declaration.body, (statement) => {
            checkLogStatement(prepared.programAnalysis, roots, unreachable, statement);
        });
    }
}

// A log is recorded against the current transaction, which a function is never invoked by.
// Lifecycle hooks share the function context type but do run inside tick processing.
function logsCannotReachTheChain(prepared: PreparedContractModule, declaration: FunctionDecl): boolean {
    if (declaration.name === MIGRATION_IMPLEMENTATION || prepared.systemProcedureIndex.idsByImplementation.has(declaration.name)) {
        return false;
    }

    const context = declaration.params[0]?.type;

    if (!context) {
        return false;
    }

    const resolved = prepared.programAnalysis.derefType(context);
    return resolved.kind === AstKind.NAME && resolved.name === QPI_FUNCTION_CONTEXT;
}

// Helper functions are deliberately absent: emission binds them empty layouts, so their bodies
// carry no resolvable payload root.
function collectPayloadRoots(prepared: PreparedContractModule): Map<string, PayloadRoots> {
    const layouts = prepared.layouts;
    const state = prepared.stateLayout;
    const rootsByFunction = new Map<string, PayloadRoots>();

    for (const registration of prepared.registrations) {
        rootsByFunction.set(registration.fnName, {
            locals: layouts.resolve(`${registration.fnName}_locals`),
            input: layouts.resolve(`${registration.fnName}_input`),
            output: layouts.resolve(`${registration.fnName}_output`),
            state,
        });
    }

    const systemProcedures = prepared.systemProcedureIndex;

    for (const name of systemProcedures.idsByImplementation.keys()) {
        // System procedures name their locals after the macro, not the implementation symbol, and
        // take their I/O structs from the ABI table rather than a `${name}_input` convention.
        const localsPrefix = systemProcedures.prefixesByImplementation.get(name) ?? name;
        const io = SYSPROC_IO[name];

        rootsByFunction.set(name, {
            locals: layouts.resolve(`${localsPrefix}_locals`),
            input: layouts.resolveOptional(io?.in),
            output: layouts.resolveOptional(io?.out),
            state,
        });
    }

    rootsByFunction.set(MIGRATION_IMPLEMENTATION, {
        locals: layouts.resolve("MIGRATE_locals"),
        input: layouts.resolve("OldStateData"),
        output: layouts.emptyLayout,
        state,
    });

    for (const declaration of prepared.callables.privateFunctions) {
        rootsByFunction.set(declaration.name, {
            locals: layouts.resolve(`${declaration.name}_locals`),
            input: layouts.resolve(`${declaration.name}_input`),
            output: layouts.resolve(`${declaration.name}_output`),
            state,
        });
    }

    return rootsByFunction;
}

function checkLogStatement(programAnalysis: ProgramAnalysis, roots: PayloadRoots, unreachable: boolean, statement: Statement): void {
    if (statement.kind !== AstKind.EXPRESSION) {
        return;
    }

    const call = statement.expression;

    if (call.kind !== AstKind.CALL || call.callee.kind !== AstKind.IDENTIFIER) {
        return;
    }

    if (!LOG_INTRINSICS.has(call.callee.name)) {
        return;
    }

    const argument = call.callArguments[0];

    if (!argument) {
        return;
    }

    if (unreachable) {
        programAnalysis.error(`${call.callee.name} is not available in a function; logs are paired with a transaction`, argument.span ?? statement.span);
        return;
    }

    const payload = resolvePayload(programAnalysis, roots, argument);

    if (!payload) {
        return;
    }

    const defect = payload.layout ? logPayloadDefect(payload.layout) : scalarPayloadDefect(payload.type);

    if (!defect) {
        return;
    }

    // The argument span survives the preprocessed-to-source remap; the callee's column does not.
    programAnalysis.error(logPayloadMessage(call.callee.name, defect), argument.span ?? statement.span);
}

// ponytail: depth-1 payloads only (locals.x / state.get().x); deeper chains need codegen's typedef
// and template member-type resolution, so they fall through to the codegen check.
function resolvePayload(programAnalysis: ProgramAnalysis, roots: PayloadRoots, expression: Expression): ResolvedPayload | null {
    const direct = rootLayout(roots, expression);

    if (direct) {
        return direct.fields.size === 0 ? null : { layout: direct, type: null };
    }

    if (expression.kind !== AstKind.MEMBER_ACCESS) {
        return null;
    }

    const base = rootLayout(roots, expression.object);

    // An unresolved prefix and qpi.h's `typedef NoData <fn>_locals` both arrive as an empty layout,
    // and neither says anything about the payload.
    if (!base || base.fields.size === 0) {
        return null;
    }

    const field = base.fields.get(expression.member);

    if (!field) {
        return null;
    }

    return {
        layout: programAnalysis.layoutOfType(field.type),
        type: field.type,
    };
}

function rootLayout(roots: PayloadRoots, expression: Expression): StructLayout | null {
    if (isStateAccessor(expression)) {
        return roots.state;
    }

    if (expression.kind !== AstKind.IDENTIFIER) {
        return null;
    }

    switch (expression.name) {
        case "locals":
            return roots.locals;
        case "input":
            return roots.input;
        case "output":
            return roots.output;
        default:
            return null;
    }
}

function scalarPayloadDefect(type: TypeSpec | null): LogPayloadDefect | null {
    if (!type || !isKnownScalarType(type)) {
        return null;
    }

    return LogPayloadDefect.NOT_A_STRUCT;
}

function visitStatement(statement: Statement, visit: (statement: Statement) => void): void {
    visit(statement);

    switch (statement.kind) {
        case AstKind.COMPOUND:
            for (const child of statement.body) {
                visitStatement(child, visit);
            }
            break;
        case AstKind.IF:
            visitStatement(statement.then, visit);

            if (statement.else_) {
                visitStatement(statement.else_, visit);
            }
            break;
        case AstKind.FOR:
            if (statement.initializer) {
                visitStatement(statement.initializer, visit);
            }

            visitStatement(statement.body, visit);
            break;
        case AstKind.WHILE:
        case AstKind.DO_WHILE:
        case AstKind.SWITCH:
            visitStatement(statement.body, visit);
            break;
    }
}
