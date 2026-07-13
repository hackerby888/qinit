import type { ClassTemplateDecl, Declaration, FunctionDecl, NamespaceDecl, Statement, StructDecl, TranslationUnit } from "../../ast";
import type { ParserInternals } from "./parser-context";

export function extractIdl(context: ParserInternals, translationUnit: TranslationUnit): Record<string, {
    inputType: number;
    kind: number;
    inSize: number;
    outSize: number;
}> {
    const idl: Record<string, {
        inputType: number;
        kind: number;
        inSize: number;
        outSize: number;
    }> = {};
    // This is driven by the REGISTER_USER_FUNCTION/PROCEDURE calls in __registerUserFunctionsAndProcedures.
    for (const declaration of translationUnit.declarations) {
        context.extractIdlFromNode(declaration, idl);
    }
    return idl;
}

export function extractIdlFromNode(context: ParserInternals, node: Declaration, idl: Record<string, any>): void {
    if (node.kind === "function") {
        const func = node as FunctionDecl;
        if (func.body) {
            context.extractIdlFromStmt(func.body, idl);
        }
    }
    else if (node.kind === "struct" || node.kind === "class_template") {
        const struct = node as StructDecl | ClassTemplateDecl;
        for (const member of struct.members) {
            context.extractIdlFromNode(member, idl);
        }
    }
    else if (node.kind === "namespace") {
        for (const bodyItem of (node as NamespaceDecl).body) {
            context.extractIdlFromNode(bodyItem, idl);
        }
    }
}

export function extractIdlFromStmt(context: ParserInternals, statement: Statement, idl: Record<string, any>): void {
    if (statement.kind === "compound") {
        for (const bodyItem of (statement as any).body) {
            context.extractIdlFromStmt(bodyItem, idl);
        }
    }
    else if (statement.kind === "expression") {
        const expression = statement as any;
        // Look for: qpi.__registerUserFunction(fn, inputType, sizeof(input), sizeof(output), sizeof(locals))
        if (expression.expression?.kind === "call") {
            context.checkRegistrationCall(expression.expression, idl);
        }
    }
}

export function checkRegistrationCall(context: ParserInternals, call: any, idl: Record<string, any>): void {
    if (call.callee?.kind === "member_access" &&
        (call.callee.member === "__registerUserFunction" ||
            call.callee.member === "__registerUserProcedure")) {
        const kind = call.callee.member === "__registerUserFunction" ? 0 : 1;
        // sizeof(Foo_input) parses as sizeof_type when Foo_input is a known type keyword, but as sizeof_expr when it is a
        const isSizeof = (argument: any) => argument?.kind === "sizeof_type" || argument?.kind === "sizeof_expr";
        if (call.callArguments.length >= 5 &&
            call.callArguments[1]?.kind === "int_literal" &&
            isSizeof(call.callArguments[2]) &&
            isSizeof(call.callArguments[3])) {
            const inputType = parseInt(call.callArguments[1].value);
            const fnName = call.callArguments[0]?.kind === "identifier"
                ? call.callArguments[0].name
                : call.callArguments[0]?.kind === "c_cast"
                    ? call.callArguments[0].expression?.name
                    : "";
            // inSize/outSize from sizeof — need sema to evaluate
            if (fnName && inputType >= 1 && inputType <= 65535) {
                idl[fnName] = { inputType, kind, inSize: 0, outSize: 0 };
            }
        }
    }
}
