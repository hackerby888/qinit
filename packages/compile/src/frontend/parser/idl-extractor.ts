import { AstKind } from "../../enums";
import type {
    ClassTemplateDecl,
    Declaration,
    Expression,
    FunctionDecl,
    NamespaceDecl,
    Statement,
    StructDecl,
    TranslationUnit,
} from "../../ast";

export interface ExtractedIdlEntry {
    inputType: number;
    kind: number;
    inSize: number;
    outSize: number;
}

export function extractIdl(
    translationUnit: TranslationUnit,
): Record<string, ExtractedIdlEntry> {
    const idl: Record<string, ExtractedIdlEntry> = {};

    for (const declaration of translationUnit.declarations) {
        extractIdlFromNode(declaration, idl);
    }

    return idl;
}

function extractIdlFromNode(
    node: Declaration,
    idl: Record<string, ExtractedIdlEntry>,
): void {
    if (node.kind === AstKind.FUNCTION) {
        const functionDeclaration = node as FunctionDecl;

        if (functionDeclaration.body) {
            extractIdlFromStatement(functionDeclaration.body, idl);
        }

        return;
    }

    if (node.kind === AstKind.STRUCT || node.kind === AstKind.CLASS_TEMPLATE) {
        const structDeclaration =
            node as StructDecl | ClassTemplateDecl;

        for (const member of structDeclaration.members) {
            extractIdlFromNode(member, idl);
        }

        return;
    }

    if (node.kind === AstKind.NAMESPACE) {
        for (const declaration of (node as NamespaceDecl).body) {
            extractIdlFromNode(declaration, idl);
        }
    }
}

function extractIdlFromStatement(
    statement: Statement,
    idl: Record<string, ExtractedIdlEntry>,
): void {
    if (statement.kind === AstKind.COMPOUND) {
        for (const childStatement of statement.body) {
            extractIdlFromStatement(childStatement, idl);
        }

        return;
    }

    if (
        statement.kind === AstKind.EXPRESSION &&
        statement.expression.kind === AstKind.CALL
    ) {
        checkRegistrationCall(statement.expression, idl);
    }
}

function checkRegistrationCall(
    call: Extract<Expression, { kind: AstKind.CALL }>,
    idl: Record<string, ExtractedIdlEntry>,
): void {
    if (
        call.callee.kind !== AstKind.MEMBER_ACCESS ||
        (
            call.callee.member !== "__registerUserFunction" &&
            call.callee.member !== "__registerUserProcedure"
        )
    ) {
        return;
    }

    const kind =
        call.callee.member === "__registerUserFunction" ? 0 : 1;
    const isSizeofExpression = (
        expression: Expression | undefined,
    ) => {
        return (
            expression?.kind === AstKind.SIZEOF_TYPE ||
            expression?.kind === AstKind.SIZEOF_EXPR
        );
    };

    if (
        call.callArguments.length < 5 ||
        call.callArguments[1]?.kind !== AstKind.INT_LITERAL ||
        !isSizeofExpression(call.callArguments[2]) ||
        !isSizeofExpression(call.callArguments[3])
    ) {
        return;
    }

    const inputType = parseInt(call.callArguments[1].value);
    const functionArgument = call.callArguments[0];
    const functionName =
        functionArgument?.kind === AstKind.IDENTIFIER
            ? functionArgument.name
            : functionArgument?.kind === AstKind.C_CAST &&
                functionArgument.expression.kind === AstKind.IDENTIFIER
              ? functionArgument.expression.name
              : "";

    if (
        functionName &&
        inputType >= 1 &&
        inputType <= 65535
    ) {
        idl[functionName] = {
            inputType,
            kind,
            inSize: 0,
            outSize: 0,
        };
    }
}
