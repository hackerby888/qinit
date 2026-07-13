
import type { PreprocessorInternals } from "./preprocessor-context";

export function evalIfCondition(context: PreprocessorInternals): boolean {
    const raw = context.readToNewline();
    return context.evalConstCondition(raw) !== 0n;
}

export function evalConstCondition(context: PreprocessorInternals, expression: string): bigint {
    // Replace defined(X) / defined X → 1/0
    let text = expression.replace(/defined\s*\(\s*(\w+)\s*\)/g, (_m, exprItemIndex) => context.defines.has(exprItemIndex) ? "1" : "0");
    text = text.replace(/defined\s+(\w+)/g, (_m, sItemIndex) => (context.defines.has(sItemIndex) ? "1" : "0"));
    // Expand remaining identifiers: a defined macro's body if numeric, else 0.
    text = text.replace(/\b([A-Za-z_]\w*)\b/g, (_m, id) => {
        if (id === "true")
            return "1";
        if (id === "false")
            return "0";
        const def = context.defines.get(id);
        if (def && def.params === null && /^-?\d+$/.test(def.body.trim()))
            return def.body.trim();
        return "0";
    });
    try {
        return context.evalArith(text);
    }
    catch {
        return 0n;
    }
}

export function evalArith(context: PreprocessorInternals, text: string): bigint {
    const toks = text.match(/\d+|&&|\|\||==|!=|<=|>=|<<|>>|[()+\-*/%<>!&|^]/g) ?? [];
    let index = 0;
    const peek = () => toks[index];
    const next = () => toks[index++];
    const parsePrimary = (): bigint => {
        const text = next();
        if (text === "(") {
            const numericValue = parseExpr(0);
            next();
            return numericValue;
        }
        if (text === "!")
            return parsePrimary() === 0n ? 1n : 0n;
        if (text === "-")
            return -parsePrimary();
        if (text === "+")
            return parsePrimary();
        return BigInt(text ?? "0");
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
        return left;
    };
    return toks.length ? parseExpr(0) : 0n;
}
