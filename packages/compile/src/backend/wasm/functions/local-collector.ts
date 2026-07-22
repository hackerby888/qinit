import { SCALAR_SIZE, C_SCALAR_NAMES } from "../abi/tables";
import { isAutoType, resolveAliasType } from "../expressions/conversions";
import { castInfo } from "../memory/address-resolution";
import { FunctionEmissionContext, EMPTY_TEMPLATE_BINDINGS } from "../types";
import type { TypeSpec, Statement, StructDecl, FunctionDecl, VariableDecl } from "../../../ast";
export function collectFunctionLocals(statement: Statement, context: FunctionEmissionContext): void {
    switch (statement.kind) {
        case "compound":
            for (const bodyItem of statement.body)
                collectFunctionLocals(bodyItem, context);
            break;
        case "if":
            collectFunctionLocals(statement.then, context);
            if (statement.else_)
                collectFunctionLocals(statement.else_, context);
            break;
        case "for":
            if (statement.initializer)
                collectFunctionLocals(statement.initializer, context);
            collectFunctionLocals(statement.body, context);
            break;
        case "while":
            collectFunctionLocals(statement.body, context);
            break;
        case "do_while":
            collectFunctionLocals(statement.body, context);
            break;
        case "switch":
            collectFunctionLocals(statement.body, context);
            break;
        case "declaration": {
            // Register function-local structs so their size and fields resolve.
            if (statement.declaration.kind === "struct") {
                const structDeclaration = statement.declaration as StructDecl;
                if (structDeclaration.name && !context.programAnalysis.globalStructs.has(structDeclaration.name))
                    context.programAnalysis.globalStructs.set(structDeclaration.name, structDeclaration);
                break;
            }
            // Register function-local aliases before classifying later locals.
            if (statement.declaration.kind === "typedef_decl") {
                const td = statement.declaration as {
                    name: string;
                    type: TypeSpec;
                };
                if (!context.programAnalysis.typedefs.has(td.name))
                    context.programAnalysis.typedefs.set(td.name, td.type);
                break;
            }
            if (statement.declaration.kind === "variable") {
                const variableDeclaration = statement.declaration as VariableDecl;
                // Store references, pointers, scratchpads, and iterators as i32 addresses.
                const holdsAddr = variableDeclaration.type.kind === "name" && /(ScopedScratchpad|Iterator)$/.test(variableDeclaration.type.name);
                const templateBindings = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
                // `auto` locals take their shape from the initializer; casts supply full type (e.g., auto* queue = reinterpret_cast<sint64_4*>(...)).
                let dType = variableDeclaration.type;
                if (isAutoType(dType) && variableDeclaration.initializer) {
                    const ci = castInfo(variableDeclaration.initializer);
                    if (ci) {
                        dType = ci.type;
                    }
                    else if (variableDeclaration.initializer.kind === "identifier") {
                        dType =
                            context.localVars.get(variableDeclaration.initializer.name)?.type ?? context.params?.get(variableDeclaration.initializer.name)?.type ?? dType;
                    }
                    else if (variableDeclaration.initializer.kind === "call" && variableDeclaration.initializer.callee.kind === "identifier") {
                        dType = context.programAnalysis.helpers.get(variableDeclaration.initializer.callee.name)?.retType ?? dType;
                    }
                    else if (variableDeclaration.initializer.kind === "call" &&
                        variableDeclaration.initializer.callee.kind === "member_access" &&
                        variableDeclaration.initializer.callee.object.kind === "identifier") {
                        const callee = variableDeclaration.initializer.callee;
                        const objectName = variableDeclaration.initializer.callee.object.name;
                        const objectType = context.localVars.get(objectName)?.type ?? context.params?.get(objectName)?.type;
                        const objectStruct = objectType ? context.programAnalysis.structOf(objectType, templateBindings) : null;
                        const named = objectStruct?.members.find((member) => member.kind === "function" && (member as FunctionDecl).name === callee.member) as FunctionDecl | undefined;
                        dType = named?.returnType ?? dType;
                    }
                    else if (variableDeclaration.initializer.kind === "subscript" && variableDeclaration.initializer.object.kind === "identifier") {
                        const ot = context.localVars.get(variableDeclaration.initializer.object.name)?.type;
                        const operator = ot ? resolveAliasType(context.programAnalysis, ot) : null;
                        if (operator?.kind === "pointer") {
                            dType = operator.pointee;
                        }
                    }
                }
                // Reject unresolved local types before a zero-size scalar fallback.
                if (dType.kind === "name" &&
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
                const concrete = dType.kind === "name" && templateBindings.types.has(dType.name) ? templateBindings.types.get(dType.name)! : dType;
                const isAgg = !holdsAddr &&
                    dType.kind !== "reference" &&
                    dType.kind !== "pointer" &&
                    context.programAnalysis.isAggregateType(concrete);
                const isRef = dType.kind === "reference" || dType.kind === "pointer" || holdsAddr || isAgg;
                // Skip proxy aliases already bound as function parameters.
                if (context.proxyClass && isRef && (variableDeclaration.name === "pv" || variableDeclaration.name === "qpi"))
                    break;
                const wasmType: "i32" | "i64" = isRef ? "i32" : "i64";
                if (!context.localVars.has(variableDeclaration.name)) {
                    context.localVars.set(variableDeclaration.name, { wasmType, type: resolveAliasType(context.programAnalysis, concrete) });
                }
            }
            break;
        }
    }
}
