import type { Preprocessor } from "./preprocessor";

export function evalIfCondition(preprocessor: Preprocessor): boolean {
    const raw = preprocessor.readToNewline();
    return preprocessor.evalConstCondition(raw) !== 0n;
}

export function evalConstCondition(preprocessor: Preprocessor, expression: string): bigint {
    // Replace defined(X) / defined X → 1/0
    let text = expression.replace(/defined\s*\(\s*(\w+)\s*\)/g, (_m, exprItemIndex) => (preprocessor.defines.has(exprItemIndex) ? "1" : "0"));
    text = text.replace(/defined\s+(\w+)/g, (_m, sItemIndex) => (preprocessor.defines.has(sItemIndex) ? "1" : "0"));
    // Expand remaining identifiers: a defined macro's body if numeric, else 0.
    // Numeric literals are matched first so a hex literal is never mistaken for an identifier.
    text = text.replace(/0[xX][0-9a-fA-F]+|\b\d\w*|\b([A-Za-z_]\w*)\b/g, (match, id) => {
        if (id === undefined) return match;
        if (id === "true") return "1";
        if (id === "false") return "0";
        const def = preprocessor.defines.get(id);
        if (def && def.params === null && /^-?(0[xX][0-9a-fA-F]+|\d+)$/.test(def.body.trim())) return def.body.trim();
        return "0";
    });
    try {
        return preprocessor.evalArith(text);
    } catch {
        return 0n;
    }
}

export function evalArith(text: string): bigint {
    const toks = text.match(/0[xX][0-9a-fA-F]+|\d+|&&|\|\||==|!=|<=|>=|<<|>>|[()+\-*/%<>!&|^?:]/g) ?? [];
    let index = 0;
    const peek = () => toks[index];
    const next = () => toks[index++];
    // A leading zero means base eight in C, but BigInt("010") reads it as ten.
    const literalValue = (literal: string): bigint => (/^0[0-7]+$/.test(literal) ? BigInt(`0o${literal.slice(1)}`) : BigInt(literal));
    const parsePrimary = (): bigint => {
        const text = next();
        if (text === "(") {
            const numericValue = parseExpr(0);
            next();
            return numericValue;
        }
        if (text === "!") return parsePrimary() === 0n ? 1n : 0n;
        if (text === "-") return -parsePrimary();
        if (text === "+") return parsePrimary();
        return literalValue(text ?? "0");
    };
    const prec: Record<string, number> = {
        "||": 1,
        "&&": 2,
        "|": 3,
        "^": 4,
        "&": 5,
        "==": 6,
        "!=": 6,
        "<": 7,
        ">": 7,
        "<=": 7,
        ">=": 7,
        "<<": 8,
        ">>": 8,
        "+": 9,
        "-": 9,
        "*": 10,
        "/": 10,
        "%": 10,
    };
    const apply = (numericValue: bigint, operator: string, numericValueCandidate: bigint): bigint => {
        switch (operator) {
            case "||":
                return numericValue !== 0n || numericValueCandidate !== 0n ? 1n : 0n;
            case "&&":
                return numericValue !== 0n && numericValueCandidate !== 0n ? 1n : 0n;
            case "|":
                return numericValue | numericValueCandidate;
            case "^":
                return numericValue ^ numericValueCandidate;
            case "&":
                return numericValue & numericValueCandidate;
            case "==":
                return numericValue === numericValueCandidate ? 1n : 0n;
            case "!=":
                return numericValue !== numericValueCandidate ? 1n : 0n;
            case "<":
                return numericValue < numericValueCandidate ? 1n : 0n;
            case ">":
                return numericValue > numericValueCandidate ? 1n : 0n;
            case "<=":
                return numericValue <= numericValueCandidate ? 1n : 0n;
            case ">=":
                return numericValue >= numericValueCandidate ? 1n : 0n;
            case "<<":
                return numericValue << numericValueCandidate;
            case ">>":
                return numericValue >> numericValueCandidate;
            case "+":
                return numericValue + numericValueCandidate;
            case "-":
                return numericValue - numericValueCandidate;
            case "*":
                return numericValue * numericValueCandidate;
            case "/":
                return numericValueCandidate === 0n ? 0n : numericValue / numericValueCandidate;
            case "%":
                return numericValueCandidate === 0n ? 0n : numericValue % numericValueCandidate;
            default:
                return 0n;
        }
    };
    const parseExpr = (minPrec: number): bigint => {
        let left = parsePrimary();
        while (peek() && prec[peek()] !== undefined && prec[peek()] >= minPrec) {
            const operator = next();
            const right = parseExpr(prec[operator] + 1);
            left = apply(left, operator, right);
        }
        // The conditional operator binds looser than every binary operator and is right-associative.
        if (minPrec <= 0 && peek() === "?") {
            next();
            const thenValue = parseExpr(0);
            if (peek() === ":") next();
            const elseValue = parseExpr(0);
            return left !== 0n ? thenValue : elseValue;
        }
        return left;
    };
    return toks.length ? parseExpr(0) : 0n;
}
