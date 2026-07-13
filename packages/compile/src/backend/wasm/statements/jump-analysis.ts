import type { Statement } from "../../../ast";

// Collect goto-target label names appearing anywhere in a statement subtree.
export function collectGotosIn(statement: Statement, out: Set<string>): void {
    switch (statement.kind) {
        case "goto":
            out.add(statement.label);
            break;
        case "compound":
            for (const bodyItem of statement.body)
                collectGotosIn(bodyItem, out);
            break;
        case "if":
            collectGotosIn(statement.then, out);
            if (statement.else_)
                collectGotosIn(statement.else_, out);
            break;
        case "for":
        case "while":
        case "do_while":
        case "switch":
            collectGotosIn(statement.body, out);
            break;
    }
}

// Collect label names defined anywhere in a statement subtree.
export function collectLabelsIn(statement: Statement, out: Set<string>): void {
    switch (statement.kind) {
        case "label":
            out.add(statement.name);
            break;
        case "compound":
            for (const bodyItem of statement.body)
                collectLabelsIn(bodyItem, out);
            break;
        case "if":
            collectLabelsIn(statement.then, out);
            if (statement.else_)
                collectLabelsIn(statement.else_, out);
            break;
        case "for":
        case "while":
        case "do_while":
        case "switch":
            collectLabelsIn(statement.body, out);
            break;
    }
}
