import { AstKind, QpiContextKind } from "../../../shared/enums";
import { ProgramAnalysis } from "../../../analysis/program-analysis";
import type { StructLayout } from "../../../analysis/types";
import type { Expression, StructDecl, FunctionDecl } from "../../../ast";
import { evalIntegralConst } from "../../../frontend/validation/validation-helpers";
import type { UserEntry } from "../framework/framework-types";
import { emitFunction } from "../functions/function-emitter";
import { findMemberFn } from "./contract-discovery";
import type { ContractLayoutResolver } from "./named-layouts";
import {
    MAX_ENTRY_LOCALS_SIZE_BYTES,
    MAX_ENTRY_OUTPUT_SIZE_BYTES,
    MAX_PROCEDURE_INPUT_SIZE_BYTES,
    MAX_USER_INPUT_TYPE,
    MIN_USER_INPUT_TYPE,
    USER_FUNCTION_KIND,
    USER_PROCEDURE_KIND,
    type UserEntryKind,
} from "../../../shared/entry-abi";

export interface ContractRegistration {
    fnName: string;
    kind: UserEntryKind;
    inputType: number;
    constant: boolean;
    line: number;
    notification: boolean; // oracle-reply callback: dispatched by the node, not invoked by users
}
export function evalRegistrationConstant(
    expression: Expression | undefined,
    programAnalysis: ProgramAnalysis,
): bigint | null {
    if (!expression) return null;

    const resolving = new Set<string>();
    const resolve = (name: string): bigint | null => {
        const separator = name.lastIndexOf("::");
        const candidates = separator >= 0 ? [name, name.slice(separator + 2)] : [name];

        for (const candidate of candidates) {
            const enumValue = programAnalysis.enumConst.get(candidate);
            if (enumValue !== undefined) return enumValue;

            const initializer = programAnalysis.constexprInit.get(candidate);
            if (!initializer) continue;
            if (resolving.has(candidate)) return null;

            resolving.add(candidate);
            const value = evalIntegralConst(initializer, resolve);
            resolving.delete(candidate);
            if (value === null) return null;

            return programAnalysis.resolveConst(candidate) ?? value;
        }

        const contractIndex = /^(\w+)_CONTRACT_INDEX$/.exec(name);
        const callee = contractIndex ? programAnalysis.callees.get(contractIndex[1]) : undefined;
        return callee ? BigInt(callee.index) : null;
    };

    return evalIntegralConst(expression, resolve);
}
export function lexRegistrationLiteral(value: string): bigint {
    const cleaned = value.replace(/[uUlL]+$/, "").replace(/'/g, "");
    if (/^0[0-7]+$/.test(cleaned)) return BigInt(`0o${cleaned.slice(1)}`);
    return BigInt(cleaned);
}
export function extractRegistrations(
    contract: StructDecl,
    programAnalysis: ProgramAnalysis,
): ContractRegistration[] {
    const regs: ContractRegistration[] = [];
    const regFn = contract.members.find(
        (member) =>
            member.kind === AstKind.FUNCTION &&
            (member as FunctionDecl).name === "__registerUserFunctionsAndProcedures",
    ) as FunctionDecl | undefined;
    if (!regFn?.body || regFn.body.kind !== AstKind.COMPOUND) return regs;
    for (const statement of regFn.body.body) {
        if (statement.kind !== AstKind.EXPRESSION) continue;
        const expression = statement.expression;
        if (expression.kind !== AstKind.CALL) continue;
        if (expression.callee.kind !== AstKind.MEMBER_ACCESS) continue;
        const method = expression.callee.member;
        const isFn = method === "__registerUserFunction";
        const isProc = method === "__registerUserProcedure";
        const isNotif = method === "__registerUserProcedureNotification";
        if (!isFn && !isProc && !isNotif) continue;
        // args: (void*)fnName, inputType, sizeof(...), ...
        const fnArg = expression.callArguments[0];
        let fnName = "";
        if (fnArg?.kind === AstKind.C_CAST && fnArg.expression.kind === AstKind.IDENTIFIER)
            fnName = fnArg.expression.name;
        else if (fnArg?.kind === AstKind.IDENTIFIER) fnName = fnArg.name;
        const itArg = expression.callArguments[1];
        const evaluated = evalRegistrationConstant(itArg, programAnalysis);
        let inputType = evaluated === null ? 0 : Number(evaluated);
        // Use the synthetic procedure ID for oracle-reply notifications. memberFnLine holds the raw-source
        // line, which is what __LINE__ resolves to inside qpi's PUBLIC/PRIVATE_PROCEDURE macros.
        if (isNotif && fnName) {
            inputType = (programAnalysis.memberFnLine.get(fnName) ?? 0) & 0xffff;
        }
        if (fnName) {
            regs.push({
                fnName,
                kind: isFn ? USER_FUNCTION_KIND : USER_PROCEDURE_KIND,
                inputType,
                constant: isNotif || evaluated !== null,
                line: expression.span.line,
                notification: isNotif,
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
            registration.inputType < MIN_USER_INPUT_TYPE ||
            registration.inputType > MAX_USER_INPUT_TYPE
        ) {
            programAnalysis.error(
                `registration input type for '${registration.fnName}' must be in the range ${MIN_USER_INPUT_TYPE}..${MAX_USER_INPUT_TYPE}`,
                registration.line,
            );
        }
    }

    const valid = extracted.filter((registration) => {
        return (
            registration.constant &&
            registration.inputType >= MIN_USER_INPUT_TYPE &&
            registration.inputType <= MAX_USER_INPUT_TYPE
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
    const actualKind: UserEntryKind | undefined =
        contextType.kind === AstKind.NAME && contextType.name === "QpiContextFunctionCall"
            ? USER_FUNCTION_KIND
            : contextType.kind === AstKind.NAME && contextType.name === "QpiContextProcedureCall"
              ? USER_PROCEDURE_KIND
              : undefined;

    if (actualKind !== undefined && actualKind !== registration.kind) {
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

    if (registration.kind === USER_PROCEDURE_KIND && inputSize > MAX_PROCEDURE_INPUT_SIZE_BYTES) {
        programAnalysis.error(
            `${inputName} exceeds MAX_INPUT_SIZE (${MAX_PROCEDURE_INPUT_SIZE_BYTES} bytes)`,
            registration.line,
        );
    }

    if (outputSize > MAX_ENTRY_OUTPUT_SIZE_BYTES) {
        programAnalysis.error(
            `${outputName} is too large; maximum output size is ${MAX_ENTRY_OUTPUT_SIZE_BYTES} bytes`,
            registration.line,
        );
    }

    if (localsSize > MAX_ENTRY_LOCALS_SIZE_BYTES) {
        programAnalysis.error(
            `${localsName} exceeds MAX_SIZE_OF_CONTRACT_LOCALS (${MAX_ENTRY_LOCALS_SIZE_BYTES} bytes)`,
            registration.line,
        );
    }
}

function registrationKindName(kind: UserEntryKind): QpiContextKind {
    return kind === USER_FUNCTION_KIND ? QpiContextKind.FUNCTION : QpiContextKind.PROCEDURE;
}
