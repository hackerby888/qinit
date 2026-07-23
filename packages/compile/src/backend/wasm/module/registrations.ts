import { AstKind, BinaryOp, QpiContextKind, UnaryOp } from "../../../enums";
import { ProgramAnalysis } from "../../../analysis/program-analysis";
import type { StructLayout } from "../../../analysis/types";
import type { Expression, StructDecl, FunctionDecl } from "../../../ast";
import type { UserEntry } from "../../../framework";
import { emitFunction } from "../functions/function-emitter";
import { findMemberFn } from "./contract-discovery";
import type { ContractLayoutResolver } from "./named-layouts";

const MIN_INPUT_TYPE = 1;
const MAX_INPUT_TYPE = 65535;
const MAX_PROCEDURE_INPUT_SIZE = 1024;
const MAX_ENTRY_OUTPUT_SIZE = 65535;
const MAX_ENTRY_LOCALS_SIZE = 32768;

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
        case AstKind.INT_LITERAL:
            try {
                return lexRegistrationLiteral(expression.value);
            }
            catch {
                return null;
            }
        case AstKind.BOOL_LITERAL:
            return expression.value ? 1n : 0n;
        case AstKind.CHAR_LITERAL:
            return BigInt(expression.value);
        case AstKind.IDENTIFIER:
            return programAnalysis.resolveConst(expression.name);
        case AstKind.QUALIFIED_NAME:
            return programAnalysis.resolveConst(`${expression.namespace}::${expression.name}`);
        case AstKind.PAREN:
            return evalRegistrationConstant(expression.expression, programAnalysis);
        case AstKind.UNARY_OP: {
            const numericValue = evalRegistrationConstant(expression.argument, programAnalysis);
            if (numericValue === null)
                return null;
            if (expression.operator === UnaryOp.MINUS)
                return -numericValue;
            if (expression.operator === UnaryOp.PLUS)
                return numericValue;
            if (expression.operator === UnaryOp.BITWISE_NOT)
                return ~numericValue;
            if (expression.operator === UnaryOp.LOGICAL_NOT)
                return numericValue === 0n ? 1n : 0n;
            return null;
        }
        case AstKind.BINARY_OP: {
            const leftValue = evalRegistrationConstant(expression.left, programAnalysis);
            const rightValue = evalRegistrationConstant(expression.right, programAnalysis);
            if (leftValue === null || rightValue === null)
                return null;
            switch (expression.operator) {
                case BinaryOp.ADD:
                    return leftValue + rightValue;
                case BinaryOp.SUBTRACT:
                    return leftValue - rightValue;
                case BinaryOp.MULTIPLY:
                    return leftValue * rightValue;
                case BinaryOp.DIVIDE:
                    return rightValue === 0n ? null : leftValue / rightValue;
                case BinaryOp.MODULO:
                    return rightValue === 0n ? null : leftValue % rightValue;
                case BinaryOp.SHIFT_LEFT:
                    return leftValue << rightValue;
                case BinaryOp.SHIFT_RIGHT:
                    return leftValue >> rightValue;
                case BinaryOp.BITWISE_AND:
                    return leftValue & rightValue;
                case BinaryOp.BITWISE_OR:
                    return leftValue | rightValue;
                case BinaryOp.BITWISE_XOR:
                    return leftValue ^ rightValue;
                case BinaryOp.EQUAL:
                    return leftValue === rightValue ? 1n : 0n;
                case BinaryOp.NOT_EQUAL:
                    return leftValue !== rightValue ? 1n : 0n;
                case BinaryOp.LESS_THAN:
                    return leftValue < rightValue ? 1n : 0n;
                case BinaryOp.GREATER_THAN:
                    return leftValue > rightValue ? 1n : 0n;
                case BinaryOp.LESS_THAN_OR_EQUAL:
                    return leftValue <= rightValue ? 1n : 0n;
                case BinaryOp.GREATER_THAN_OR_EQUAL:
                    return leftValue >= rightValue ? 1n : 0n;
                default:
                    return null;
            }
        }
        case AstKind.TERNARY: {
            const numericValue = evalRegistrationConstant(expression.condition, programAnalysis);
            if (numericValue === null)
                return null;
            const branch = numericValue !== 0n ? expression.then : expression.else_;
            return evalRegistrationConstant(branch, programAnalysis);
        }
        case AstKind.C_CAST:
        case AstKind.STATIC_CAST:
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
    const regFn = contract.members.find((member) => member.kind === AstKind.FUNCTION && (member as FunctionDecl).name === "__registerUserFunctionsAndProcedures") as FunctionDecl | undefined;
    if (!regFn?.body || regFn.body.kind !== AstKind.COMPOUND)
        return regs;
    for (const statement of regFn.body.body) {
        if (statement.kind !== AstKind.EXPRESSION)
            continue;
        const expression = statement.expression;
        if (expression.kind !== AstKind.CALL)
            continue;
        if (expression.callee.kind !== AstKind.MEMBER_ACCESS)
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
        if (fnArg?.kind === AstKind.C_CAST && fnArg.expression.kind === AstKind.IDENTIFIER)
            fnName = fnArg.expression.name;
        else if (fnArg?.kind === AstKind.IDENTIFIER)
            fnName = fnArg.name;
        const itArg = expression.callArguments[1];
        const evaluated = evalRegistrationConstant(itArg, programAnalysis);
        let inputType = evaluated === null ? 0 : Number(evaluated);
        // Use the synthetic procedure ID for oracle-reply notifications.
        if (isNotif && fnName) {
            const def = contract.members.find((member) => member.kind === AstKind.FUNCTION && (member as FunctionDecl).name === fnName) as FunctionDecl | undefined;
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

export function validateContractRegistrations(
    contract: StructDecl,
    programAnalysis: ProgramAnalysis,
): ContractRegistration[] {
    const extracted = extractRegistrations(contract, programAnalysis);

    for (const registration of extracted) {
        if (!registration.constant) {
            programAnalysis.error(
                `registration input type for '${registration.fnName}' must be an integral constant expression`,
                registration.line,
            );
            continue;
        }

        if (
            registration.inputType < MIN_INPUT_TYPE ||
            registration.inputType > MAX_INPUT_TYPE
        ) {
            programAnalysis.error(
                `registration input type for '${registration.fnName}' must be in the range 1..65535`,
                registration.line,
            );
        }
    }

    const valid = extracted.filter((registration) => {
        return (
            registration.constant &&
            registration.inputType >= MIN_INPUT_TYPE &&
            registration.inputType <= MAX_INPUT_TYPE
        );
    });

    validateUniqueRegistrationKeys(valid, programAnalysis);
    return valid;
}

export function validateRegistrationInterfaces(
    contract: StructDecl,
    registrations: ContractRegistration[],
    programAnalysis: ProgramAnalysis,
    layouts: ContractLayoutResolver,
): void {
    for (const registration of registrations) {
        const declaration = findMemberFn(contract, registration.fnName);

        if (!declaration?.body) {
            programAnalysis.error(
                `registered ${registrationKindName(registration.kind)} '${registration.fnName}' has no implementation body`,
                registration.line,
            );
            continue;
        }

        validateRegistrationKind(registration, declaration, programAnalysis);
        validateRegistrationLayouts(registration, programAnalysis, layouts);
    }
}

export function registerEntryDispatchTargets(
    registrations: ContractRegistration[],
    programAnalysis: ProgramAnalysis,
    layouts: ContractLayoutResolver,
): void {
    for (const [index, registration] of registrations.entries()) {
        programAnalysis.registered.set(registration.fnName, {
            label: `$user_${index}`,
            localsSize: layouts.resolve(`${registration.fnName}_locals`).size,
        });
    }
}

export interface RegisteredEntryEmission {
    entries: UserEntry[];
    functionWat: string[];
}

export function emitRegisteredEntries(
    contract: StructDecl,
    registrations: ContractRegistration[],
    programAnalysis: ProgramAnalysis,
    stateLayout: StructLayout,
    layouts: ContractLayoutResolver,
): RegisteredEntryEmission {
    const entries: UserEntry[] = [];
    const functionWat: string[] = [];

    for (const [index, registration] of registrations.entries()) {
        const declaration = findMemberFn(contract, registration.fnName);
        const inputLayout = layouts.resolve(`${registration.fnName}_input`);
        const outputLayout = layouts.resolve(`${registration.fnName}_output`);
        const localsLayout = layouts.resolve(`${registration.fnName}_locals`);
        const label = `$user_${index}`;

        functionWat.push(
            emitFunction(
                programAnalysis,
                label,
                declaration,
                stateLayout,
                inputLayout,
                outputLayout,
                localsLayout,
            ),
        );

        entries.push({
            inputType: registration.inputType,
            kind: registration.kind,
            inSize: inputLayout.size,
            outSize: outputLayout.size,
            localsSize: localsLayout.size,
            label,
        });
    }

    return {
        entries,
        functionWat,
    };
}

function validateUniqueRegistrationKeys(
    registrations: ContractRegistration[],
    programAnalysis: ProgramAnalysis,
): void {
    const registeredNames = new Map<string, string>();

    for (const registration of registrations) {
        const key = `${registration.kind}:${registration.inputType}`;
        const previousName = registeredNames.get(key);

        if (previousName) {
            programAnalysis.error(
                `${registrationKindName(registration.kind)} input type ${registration.inputType} is registered twice ('${previousName}' and '${registration.fnName}')`,
                0,
            );
        }

        registeredNames.set(key, registration.fnName);
    }
}

function validateRegistrationKind(
    registration: ContractRegistration,
    declaration: FunctionDecl,
    programAnalysis: ProgramAnalysis,
): void {
    const contextType = programAnalysis.derefType(
        declaration.params[0]?.type ?? { kind: AstKind.VOID },
    );
    const actualKind = (
        contextType.kind === AstKind.NAME &&
        contextType.name === "QpiContextFunctionCall"
    )
        ? 0
        : (
            contextType.kind === AstKind.NAME &&
            contextType.name === "QpiContextProcedureCall"
        )
            ? 1
            : -1;

    if (actualKind >= 0 && actualKind !== registration.kind) {
        programAnalysis.error(
            `'${registration.fnName}' is a ${registrationKindName(actualKind)} but is registered as a ${registrationKindName(registration.kind)}`,
            registration.line,
        );
    }
}

function validateRegistrationLayouts(
    registration: ContractRegistration,
    programAnalysis: ProgramAnalysis,
    layouts: ContractLayoutResolver,
): void {
    const inputName = `${registration.fnName}_input`;
    const outputName = `${registration.fnName}_output`;
    const localsName = `${registration.fnName}_locals`;

    if (!layouts.hasType(inputName)) {
        programAnalysis.error(
            `entry '${registration.fnName}' is missing required type '${inputName}'`,
            registration.line,
        );
    }

    if (!layouts.hasType(outputName)) {
        programAnalysis.error(
            `entry '${registration.fnName}' is missing required type '${outputName}'`,
            registration.line,
        );
    }

    const inputSize = layouts.resolve(inputName).size;
    const outputSize = layouts.resolve(outputName).size;
    const localsSize = layouts.resolve(localsName).size;

    if (registration.kind === 1 && inputSize > MAX_PROCEDURE_INPUT_SIZE) {
        programAnalysis.error(
            `${inputName} exceeds MAX_INPUT_SIZE (1024 bytes)`,
            registration.line,
        );
    }

    if (outputSize > MAX_ENTRY_OUTPUT_SIZE) {
        programAnalysis.error(
            `${outputName} is too large; maximum output size is 65535 bytes`,
            registration.line,
        );
    }

    if (localsSize > MAX_ENTRY_LOCALS_SIZE) {
        programAnalysis.error(
            `${localsName} exceeds MAX_SIZE_OF_CONTRACT_LOCALS (32768 bytes)`,
            registration.line,
        );
    }
}

function registrationKindName(kind: number): QpiContextKind {
    return kind === 0
        ? QpiContextKind.FUNCTION
        : QpiContextKind.PROCEDURE;
}
