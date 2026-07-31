import { AstKind } from "../../../enums";
import type { Statement } from "../../../ast";

// Collect goto-target label names appearing anywhere in a statement subtree.
export function collectGotosIn(statement: Statement, out: Set<string>): void {
    switch (statement.kind) {
        case AstKind.GOTO:
            out.add(statement.label);
            break;
        case AstKind.COMPOUND:
            for (const bodyItem of statement.body)
                collectGotosIn(bodyItem, out);
            break;
        case AstKind.IF:
            collectGotosIn(statement.then, out);
            if (statement.else_)
                collectGotosIn(statement.else_, out);
            break;
        case AstKind.FOR:
        case AstKind.WHILE:
        case AstKind.DO_WHILE:
        case AstKind.SWITCH:
            collectGotosIn(statement.body, out);
            break;
    }
}

// Collect label names defined anywhere in a statement subtree.
export function collectLabelsIn(statement: Statement, out: Set<string>): void {
    switch (statement.kind) {
        case AstKind.LABEL:
            out.add(statement.name);
            break;
        case AstKind.COMPOUND:
            for (const bodyItem of statement.body)
                collectLabelsIn(bodyItem, out);
            break;
        case AstKind.IF:
            collectLabelsIn(statement.then, out);
            if (statement.else_)
                collectLabelsIn(statement.else_, out);
            break;
        case AstKind.FOR:
        case AstKind.WHILE:
        case AstKind.DO_WHILE:
        case AstKind.SWITCH:
            collectLabelsIn(statement.body, out);
            break;
    }
}
