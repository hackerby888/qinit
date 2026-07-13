import { ProgramAnalysis } from "../../../analysis/program-analysis";
import type { Expression, StructDecl, FunctionDecl } from "../../../ast";
export interface ContractRegistration {
    fnName: string;
    kind: number;
    inputType: number;
    constant: boolean;
    line: number;
}
export function evalRegistrationConstant(expression: Expression | undefined, programAnalysis: ProgramAnalysis): bigint | null {
    if (!expression)
        return null;
    switch (expression.kind) {
        case "int_literal":
            try {
                return lexRegistrationLiteral(expression.value);
            }
            catch {
                return null;
            }
        case "bool_literal":
            return expression.value ? 1n : 0n;
        case "char_literal":
            return BigInt(expression.value);
        case "identifier":
            return programAnalysis.resolveConst(expression.name);
        case "qualified_name":
            return programAnalysis.resolveConst(`${expression.namespace}::${expression.name}`);
        case "paren":
            return evalRegistrationConstant(expression.expression, programAnalysis);
        case "unary_op": {
            const numericValue = evalRegistrationConstant(expression.argument, programAnalysis);
            if (numericValue === null)
                return null;
            if (expression.operator === "-")
                return -numericValue;
            if (expression.operator === "+")
                return numericValue;
            if (expression.operator === "~")
                return ~numericValue;
            if (expression.operator === "!")
                return numericValue === 0n ? 1n : 0n;
            return null;
        }
        case "binary_op": {
            const leftValue = evalRegistrationConstant(expression.left, programAnalysis);
            const rightValue = evalRegistrationConstant(expression.right, programAnalysis);
            if (leftValue === null || rightValue === null)
                return null;
            switch (expression.operator) {
                case "+":
                    return leftValue + rightValue;
                case "-":
                    return leftValue - rightValue;
                case "*":
                    return leftValue * rightValue;
                case "/":
                    return rightValue === 0n ? null : leftValue / rightValue;
                case "%":
                    return rightValue === 0n ? null : leftValue % rightValue;
                case "<<":
                    return leftValue << rightValue;
                case ">>":
                    return leftValue >> rightValue;
                case "&":
                    return leftValue & rightValue;
                case "|":
                    return leftValue | rightValue;
                case "^":
                    return leftValue ^ rightValue;
                case "==":
                    return leftValue === rightValue ? 1n : 0n;
                case "!=":
                    return leftValue !== rightValue ? 1n : 0n;
                case "<":
                    return leftValue < rightValue ? 1n : 0n;
                case ">":
                    return leftValue > rightValue ? 1n : 0n;
                case "<=":
                    return leftValue <= rightValue ? 1n : 0n;
                case ">=":
                    return leftValue >= rightValue ? 1n : 0n;
                default:
                    return null;
            }
        }
        case "ternary": {
            const numericValue = evalRegistrationConstant(expression.condition, programAnalysis);
            return numericValue === null ? null : evalRegistrationConstant(numericValue !== 0n ? expression.then : expression.else_, programAnalysis);
        }
        case "c_cast":
        case "static_cast":
            return evalRegistrationConstant(expression.expression, programAnalysis);
        default:
            return null;
    }
}
export function lexRegistrationLiteral(value: string): bigint {
    const cleaned = value.replace(/[uUlL]+$/, "").replace(/'/g, "");
    if (/^0[0-7]+$/.test(cleaned))
        return BigInt(`0o${cleaned.slice(1)}`);
    return BigInt(cleaned);
}
export function extractRegistrations(contract: StructDecl, programAnalysis: ProgramAnalysis): ContractRegistration[] {
    const regs: ContractRegistration[] = [];
    const regFn = contract.members.find((member) => member.kind === "function" && (member as FunctionDecl).name === "__registerUserFunctionsAndProcedures") as FunctionDecl | undefined;
    if (!regFn?.body || regFn.body.kind !== "compound")
        return regs;
    for (const statement of regFn.body.body) {
        if (statement.kind !== "expression")
            continue;
        const expression = statement.expression;
        if (expression.kind !== "call")
            continue;
        if (expression.callee.kind !== "member_access")
            continue;
        const method = expression.callee.member;
        const isFn = method === "__registerUserFunction";
        const isProc = method === "__registerUserProcedure";
        const isNotif = method === "__registerUserProcedureNotification";
        if (!isFn && !isProc && !isNotif)
            continue;
        // args: (void*)fnName, inputType, sizeof(...), ...
        const fnArg = expression.callArguments[0];
        let fnName = "";
        if (fnArg?.kind === "c_cast" && fnArg.expression.kind === "identifier")
            fnName = fnArg.expression.name;
        else if (fnArg?.kind === "identifier")
            fnName = fnArg.name;
        const itArg = expression.callArguments[1];
        const evaluated = evalRegistrationConstant(itArg, programAnalysis);
        let inputType = evaluated === null ? 0 : Number(evaluated);
        // Notification procedure (oracle reply callback): its id arg is the synthetic __id_<proc> ((CONTRACT_INDEX << 22) | defLine, qpi.h
        if (isNotif && fnName) {
            const def = contract.members.find((member) => member.kind === "function" && (member as FunctionDecl).name === fnName) as FunctionDecl | undefined;
            inputType = (def?.span?.line ?? 0) & 0xffff;
        }
        if (fnName) {
            regs.push({
                fnName,
                kind: isFn ? 0 : 1,
                inputType,
                constant: isNotif || evaluated !== null,
                line: expression.span.line,
            });
        }
    }
    return regs;
}
