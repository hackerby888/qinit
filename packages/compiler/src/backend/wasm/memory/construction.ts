import { AstKind, WatNodeType } from "../../../shared/enums";
import { FunctionEmissionContext, ResolvedAddress, EMPTY_TEMPLATE_BINDINGS } from "../types";
import type { TypeSpec, Expression } from "../../../ast";
import * as watIr from "../wat-ir";
import { addrIr } from "./memory-operations";
// Resolve a container element getter to an addressable node: Array.get(i) → T, HashMap value(i) → V / key(i)
export function resolveContainerElem(
    context: FunctionEmissionContext,
    expression: Expression & {
        kind: AstKind.CALL;
    },
): ResolvedAddress | null {
    if (expression.callee.kind !== AstKind.MEMBER_ACCESS) return null;
    const cached = context.materializedCalls?.get(expression);
    if (cached) return cached;
    const node = context.lowering.resolveExpressionAddress(context, expression.callee.object);
    if (!node || !node.type) return null;
    // Resolve typedefs and template bindings to the concrete container type.
    let ct: TypeSpec | null = node.type;
    for (let index = 0; index < 8 && ct?.kind === AstKind.NAME; index++) {
        const next: TypeSpec | undefined = context.thisBind?.types.get(ct.name) ?? context.programAnalysis.typedefs.get(ct.name);
        if (!next) break;
        ct = next;
    }
    if (ct?.kind === AstKind.NAME && (context.programAnalysis.globalStructs.has(ct.name) || context.programAnalysis.templateMethods.has(ct.name))) {
        ct = { kind: AstKind.TEMPLATE_INSTANCE, name: ct.name, callArguments: [] };
    }
    if (!ct || ct.kind !== AstKind.TEMPLATE_INSTANCE) return null;
    const ctype = ct;
    const member = expression.callee.member;
    const mk = (addr: string, elemType: TypeSpec): ResolvedAddress => ({
        addr,
        type: elemType,
        size: context.programAnalysis.sizeOfType(elemType),
        layout: context.programAnalysis.layoutOfType(elemType),
    });
    const compiled = context.lowering.callCompiled(context, ctype, member, node.addr, expression.callArguments);
    if (!compiled || (compiled.cm.retKind !== WatNodeType.I32 && !compiled.cm.retAgg)) return null;
    if (!compiled?.cm.retType) {
        throw new Error(`authoritative aggregate/reference method ${ctype.name}::${member} could not be lowered`);
    }
    if (compiled.retDest) context.lines.push(`    ${compiled.call}`);
    const result = mk(compiled.retDest ?? compiled.call, compiled.cm.retType);
    if (compiled.retDest) (context.materializedCalls ??= new WeakMap()).set(expression, result);
    return result;
}
// Zero an aggregate destination, then initialize each supplied field.
/**
 * Run each direct base's constructor on its own subobject.
 *
 * A derived class constructs its bases before its own body runs, whether or not it declares a
 * constructor of its own; without this a base that initialises its fields leaves them zero.
 */
function emitBaseConstructors(context: FunctionEmissionContext, dstAddr: string, type: TypeSpec): void {
    const bind = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
    const layout = context.programAnalysis.layoutOfType(type, bind);

    for (const base of layout?.baseSubobjects ?? []) {
        const resolvedBase = context.programAnalysis.resolveType(base.type, bind);
        const baseName = context.programAnalysis.baseTemplateName(resolvedBase);
        // Only a base that constructs something needs the call; the rest are already zeroed.
        if (!baseName || !context.programAnalysis.hasInstanceMethod(baseName, baseName)) continue;

        const destination = watIr.serializeWatNode(watIr.addressWithOffset(addrIr(dstAddr), base.offset));
        emitConstruct(context, destination, base.type, []);
    }
}
export function emitConstruct(context: FunctionEmissionContext, dstAddr: string, type: TypeSpec, callArguments: Expression[]): boolean {
    const resolved = context.programAnalysis.resolveType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
    const owner =
        resolved.kind === AstKind.NAME
            ? resolved.name
            : resolved.kind === AstKind.TEMPLATE_INSTANCE
              ? resolved.name
              : type.kind === AstKind.NAME
                ? type.name
                : null;
    if (owner && context.programAnalysis.templateMethods.get(owner)?.has(owner)) {
        const instance: TypeSpec & {
            kind: AstKind.TEMPLATE_INSTANCE;
        } = {
            kind: AstKind.TEMPLATE_INSTANCE,
            name: owner,
            callArguments: resolved.kind === AstKind.TEMPLATE_INSTANCE ? resolved.callArguments : [],
        };
        const compiled = context.lowering.callCompiled(context, instance, owner, dstAddr, callArguments);
        if (!compiled || compiled.cm.retKind !== WatNodeType.VOID) {
            throw new Error(`authoritative ${owner} constructor could not be lowered`);
        }
        emitBaseConstructors(context, dstAddr, type);
        context.lines.push(`    ${compiled.call}`);
        return true;
    }
    const layout = context.programAnalysis.layoutOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
    if (!layout) return false;
    const fields = [...layout.fields.values()];
    const destinationBase = context.lowering.allocateTemporaryLocalName(context);
    context.lines.push(`    ${context.lowering.setLocal(context, destinationBase, addrIr(dstAddr))}`);
    context.lines.push(
        `    ${watIr.serializeWatNode(watIr.functionCall("$setMem", watIr.localGet(destinationBase, WatNodeType.I32), watIr.i32Constant(layout.size), watIr.i32Constant(0)))}`,
    );
    // With no arguments this is default construction, so the bases construct themselves. A braced
    // initialiser instead assigns the fields below, which is what aggregate initialisation means.
    if (callArguments.length === 0) emitBaseConstructors(context, `(local.get $${destinationBase})`, type);
    for (let index = 0; index < callArguments.length && index < fields.length; index++) {
        const field = fields[index];
        const fieldDestination = watIr.addressWithOffset(watIr.localGet(destinationBase, WatNodeType.I32), field.offset);
        if (context.lowering.isAggregate(context, field.type, field.size)) {
            const argument = callArguments[index];
            const nestedArgs =
                argument.kind === AstKind.INITIALIZER_LIST ? argument.expressions : argument.kind === AstKind.CONSTRUCT ? argument.callArguments : null;
            if (nestedArgs && emitConstruct(context, watIr.serializeWatNode(fieldDestination), field.type, nestedArgs)) continue;
            const src = context.lowering.emitAddress(context, argument);
            if (src)
                context.lines.push(
                    `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", fieldDestination, addrIr(src), watIr.i32Constant(field.size)))}`,
                );
        } else {
            context.lines.push(
                `    ${watIr.serializeWatNode(watIr.storeScalar(fieldDestination, field.size, context.lowering.lowerValueExpression(context, callArguments[index])))}`,
            );
        }
    }
    return true;
}
