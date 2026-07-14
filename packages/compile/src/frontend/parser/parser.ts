import type { Statement, TranslationUnit } from "../../ast";
import type { Token } from "../../lexer";
import { DeclarationParser } from "./declarations/declaration-parser";
import { FunctionParser } from "./declarations/function-parser";
import { RecordParser } from "./declarations/record-parser";
import { TemplateParser } from "./declarations/template-parser";
import { ExpressionParser } from "./expressions/expression-parser";
import { extractIdl as extractContractIdl } from "./idl-extractor";
import type { ParserDiagnostic } from "./parser-context";
import { ParserRecovery } from "./parser-recovery";
import { ParserState } from "./parser-state";
import { StatementParser } from "./statement-parser";
import { TypeParser } from "./types/type-parser";

export type { ParserDiagnostic as Diagnostic } from "./parser-context";

export class Parser {
    readonly state: ParserState;
    readonly declarations: DeclarationParser;
    readonly records: RecordParser;
    readonly templates: TemplateParser;
    readonly functions: FunctionParser;
    readonly types: TypeParser;
    readonly expressions: ExpressionParser;
    readonly statements: StatementParser;
    readonly recovery: ParserRecovery;

    constructor(tokens: Token[]) {
        this.state = new ParserState(tokens);
        this.declarations = new DeclarationParser(this);
        this.records = new RecordParser(this);
        this.templates = new TemplateParser(this);
        this.functions = new FunctionParser(this);
        this.types = new TypeParser(this);
        this.expressions = new ExpressionParser(this);
        this.statements = new StatementParser(this);
        this.recovery = new ParserRecovery(this);
    }

    parseTranslationUnit(): TranslationUnit {
        const start = this.state.peek().span;
        const declarations = [];

        while (!this.state.eof()) {
            const previousPosition = this.state.position;
            const previousErrorCount = this.state.diagnostics.length;
            const declaration = this.declarations.parseDeclaration();

            if (declaration && declaration.kind !== "empty") {
                declarations.push(declaration);
            }

            while (this.state.pendingDeclarations.length > 0) {
                declarations.push(this.state.pendingDeclarations.shift()!);
            }

            this.recovery.recover(
                previousPosition,
                previousErrorCount,
            );
        }

        const end = this.state.last().span;

        return {
            declarations,
            span: {
                start: start.start,
                end: end.end,
                line: start.line,
                column: start.column,
            },
        };
    }

    getDiagnostics(): ParserDiagnostic[] {
        return [
            ...this.state.diagnostics,
            ...this.state.bodyDiagnostics,
        ];
    }

    parseFunctionBody(): Statement {
        const tokens = this.state.tokens;
        const openBraceIndex = this.state.position;
        let braceDepth = 0;
        let closeBraceIndex = -1;

        for (
            let tokenIndex = openBraceIndex;
            tokenIndex < tokens.length;
            tokenIndex++
        ) {
            const kind = tokens[tokenIndex].kind;

            if (kind === "l_brace") {
                braceDepth++;
                continue;
            }

            if (kind === "r_brace") {
                braceDepth--;

                if (braceDepth === 0) {
                    closeBraceIndex = tokenIndex;
                    break;
                }

                continue;
            }

            if (kind === "eof") {
                break;
            }
        }

        if (closeBraceIndex < 0) {
            this.state.next();
            return this.statements.parseCompoundStatement();
        }

        const bodyTokens = tokens.slice(
            openBraceIndex,
            closeBraceIndex + 1,
        );
        bodyTokens.push({
            kind: "eof",
            text: "",
            span: tokens[closeBraceIndex].span,
        });

        const bodyParser = new Parser(bodyTokens);
        bodyParser.state.next();
        const body = bodyParser.statements.parseCompoundStatement();

        this.state.bodyDiagnostics.push(
            ...bodyParser.state.diagnostics,
            ...bodyParser.state.bodyDiagnostics,
        );
        this.state.position = closeBraceIndex + 1;

        return body;
    }

    extractIdl(
        translationUnit: TranslationUnit,
    ): ReturnType<typeof extractContractIdl> {
        return extractContractIdl(translationUnit);
    }
}
