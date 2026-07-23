import { AstKind, WatNodeType, type WatValueType } from "../../../enums";
import { SCALAR_SIZE, C_SCALAR_NAMES } from "../abi/tables";
import { isAutoType, resolveAliasType } from "../expressions/conversions";
import { castInfo } from "../memory/address-resolution";
import { FunctionEmissionContext, EMPTY_TEMPLATE_BINDINGS } from "../types";
import type { TypeSpec, Statement, StructDecl, FunctionDecl, VariableDecl } from "../../../ast";
export function collectFunctionLocals(statement: Statement, context: FunctionEmissionContext): void {
    switch (statement.kind) {
        case AstKind.COMPOUND:
            for (const bodyItem of statement.body)
                collectFunctionLocals(bodyItem, context);
            break;
        case AstKind.IF:
            collectFunctionLocals(statement.then, context);
            if (statement.else_)
                collectFunctionLocals(statement.else_, context);
            break;
        case AstKind.FOR:
            if (statement.initializer)
                collectFunctionLocals(statement.initializer, context);
            collectFunctionLocals(statement.body, context);
            break;
        case AstKind.WHILE:
            collectFunctionLocals(statement.body, context);
            break;
        case AstKind.DO_WHILE:
            collectFunctionLocals(statement.body, context);
            break;
        case AstKind.SWITCH:
            collectFunctionLocals(statement.body, context);
            break;
        case AstKind.DECLARATION: {
            // Register function-local structs so their size and fields resolve.
            if (statement.declaration.kind === AstKind.STRUCT) {
                const structDeclaration = statement.declaration as StructDecl;
                if (structDeclaration.name && !context.programAnalysis.globalStructs.has(structDeclaration.name))
                    context.programAnalysis.globalStructs.set(structDeclaration.name, structDeclaration);
                break;
            }
            // Register function-local aliases before classifying later locals.
            if (statement.declaration.kind === AstKind.TYPEDEF_DECL) {
                const td = statement.declaration as {
                    name: string;
                    type: TypeSpec;
                };
                if (!context.programAnalysis.typedefs.has(td.name))
                    context.programAnalysis.typedefs.set(td.name, td.type);
                break;
            }
            if (statement.declaration.kind === AstKind.VARIABLE) {
                const variableDeclaration = statement.declaration as VariableDecl;
                // Store references, pointers, scratchpads, and iterators as i32 addresses.
                const holdsAddr = variableDeclaration.type.kind === AstKind.NAME && /(ScopedScratchpad|Iterator)$/.test(variableDeclaration.type.name);
                const templateBindings = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
                // `auto` locals take their shape from the initializer; casts supply full type (e.g., auto* queue = reinterpret_cast<sint64_4*>(...)).
                let dType = variableDeclaration.type;
                if (isAutoType(dType) && variableDeclaration.initializer) {
                    const ci = castInfo(variableDeclaration.initializer);
                    if (ci) {
                        dType = ci.type;
                    }
                    else if (variableDeclaration.initializer.kind === AstKind.IDENTIFIER) {
                        dType =
                            context.localVars.get(variableDeclaration.initializer.name)?.type ?? context.params?.get(variableDeclaration.initializer.name)?.type ?? dType;
                    }
                    else if (variableDeclaration.initializer.kind === AstKind.CALL && variableDeclaration.initializer.callee.kind === AstKind.IDENTIFIER) {
                        dType = context.programAnalysis.helpers.get(variableDeclaration.initializer.callee.name)?.retType ?? dType;
                    }
                    else if (variableDeclaration.initializer.kind === AstKind.CALL &&
                        variableDeclaration.initializer.callee.kind === AstKind.MEMBER_ACCESS &&
                        variableDeclaration.initializer.callee.object.kind === AstKind.IDENTIFIER) {
                        const callee = variableDeclaration.initializer.callee;
                        const objectName = variableDeclaration.initializer.callee.object.name;
                        const objectType = context.localVars.get(objectName)?.type ?? context.params?.get(objectName)?.type;
                        const objectStruct = objectType ? context.programAnalysis.structOf(objectType, templateBindings) : null;
                        const named = objectStruct?.members.find((member) => member.kind === AstKind.FUNCTION && (member as FunctionDecl).name === callee.member) as FunctionDecl | undefined;
                        dType = named?.returnType ?? dType;
                    }
                    else if (variableDeclaration.initializer.kind === AstKind.SUBSCRIPT && variableDeclaration.initializer.object.kind === AstKind.IDENTIFIER) {
                        const ot = context.localVars.get(variableDeclaration.initializer.object.name)?.type;
                        const operator = ot ? resolveAliasType(context.programAnalysis, ot) : null;
                        if (operator?.kind === AstKind.POINTER) {
                            dType = operator.pointee;
                        }
                    }
                }
                // Reject unresolved local types before a zero-size scalar fallback.
                if (dType.kind === AstKind.NAME &&
                    !isAutoType(dType) &&
                    SCALAR_SIZE[dType.name] === undefined &&
                    !C_SCALAR_NAMES.has(dType.name) &&
                    !dType.name.includes("::") &&
                    !templateBindings.types.has(dType.name) &&
                    !context.programAnalysis.typedefs.has(dType.name) &&
                    !context.programAnalysis.enumNames.has(dType.name) &&
                    !context.programAnalysis.structByName(dType.name, templateBindings)) {
                    context.programAnalysis.error(`unknown type '${dType.name}' in declaration of '${variableDeclaration.name}'`, statement.span.line);
                }
                // Store aggregate locals in allocated slots referenced by i32 locals.
                const concrete = dType.kind === AstKind.NAME && templateBindings.types.has(dType.name) ? templateBindings.types.get(dType.name)! : dType;
                const isAgg = !holdsAddr &&
                    dType.kind !== AstKind.REFERENCE &&
                    dType.kind !== AstKind.POINTER &&
                    context.programAnalysis.isAggregateType(concrete);
                const isRef = dType.kind === AstKind.REFERENCE || dType.kind === AstKind.POINTER || holdsAddr || isAgg;
                // Skip proxy aliases already bound as function parameters.
                if (context.proxyClass && isRef && (variableDeclaration.name === "pv" || variableDeclaration.name === "qpi"))
                    break;
                const wasmType: WatValueType = isRef
                    ? WatNodeType.I32
                    : WatNodeType.I64;
                if (!context.localVars.has(variableDeclaration.name)) {
                    context.localVars.set(variableDeclaration.name, { wasmType, type: resolveAliasType(context.programAnalysis, concrete) });
                }
            }
            break;
        }
    }
}
