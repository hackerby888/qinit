import { AstKind, ContainerLayoutKind } from "../enums";
import { StructLayout, EMPTY_TEMPLATE_BINDINGS, TemplateBindings, ContainerLayoutMetadata } from "./types";
import type { TypeSpec } from "../ast";
import type { ProgramAnalysisInternals } from "./program-analysis-context";

export function containerLayout(context: ProgramAnalysisInternals, name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructLayout {
    // Resolve plain zero-argument struct instances without a template definition.
    if (!context.templates.has(name) && !context.specializations.has(name)) {
        const structDeclaration = context.globalStructs.get(name) ?? context.nested.get(name);
        if (structDeclaration)
            return context.layoutOfStruct(structDeclaration, templateBindings);
    }
    return context.layoutOfTemplate(name, callArguments, templateBindings);
}

export function hashContainerOffsets(context: ProgramAnalysisInternals, name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings, capacity: number): {
    elemSize: number;
    occBase: number;
    popOff: number;
    totalSize: number;
} | null {
    if (!context.templates.has(name) || !capacity)
        return null;
    const lt = context.layoutOfTemplate(name, callArguments, templateBindings);
    const el = lt.fields.get("_elements") ?? lt.fields.get("_keys"); // HashMap: _elements; HashSet: _keys
    const occ = lt.fields.get("_occupationFlags");
    const pop = lt.fields.get("_population");
    if (!el || !occ || !pop)
        return null;
    return {
        elemSize: Math.floor(el.size / capacity),
        occBase: occ.offset,
        popOff: pop.offset,
        totalSize: lt.size,
    };
}

export function hashmapInfo(context: ProgramAnalysisInternals, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): ContainerLayoutMetadata | null {
    if (callArguments.length < 3)
        return null;
    const keySize = context.sizeOfType(callArguments[0], templateBindings);
    const valSize = context.sizeOfType(callArguments[1], templateBindings);
    const capacity = Number(context.evalConstFromType(callArguments[2], templateBindings));
    if (!capacity || keySize <= 0 || valSize <= 0)
        return null;
    const elemAlign = Math.max(context.alignOfType(callArguments[0], templateBindings), context.alignOfType(callArguments[1], templateBindings));
    const valOff = context.alignUp(keySize, context.alignOfType(callArguments[1], templateBindings));
    const parsed = context.hashContainerOffsets("HashMap", callArguments, templateBindings, capacity);
    const elemSize = parsed?.elemSize ?? context.alignUp(valOff + valSize, elemAlign);
    const occBase = parsed?.occBase ?? elemSize * capacity;
    const popOff = parsed?.popOff ?? occBase + Math.floor((capacity * 2 + 63) / 64) * 8;
    const totalSize = parsed?.totalSize ?? popOff + 16;
    const hashMode = keySize === 32 ? 0 : 1;
    return {
        kind: ContainerLayoutKind.HASH_MAP,
        L: capacity,
        elemSize,
        keySize,
        valOff,
        valSize,
        occBase,
        popOff,
        totalSize,
        hashMode,
    };
}

export function hashsetInfo(context: ProgramAnalysisInternals, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): ContainerLayoutMetadata | null {
    if (callArguments.length < 2)
        return null;
    const keySize = context.sizeOfType(callArguments[0], templateBindings);
    const capacity = Number(context.evalConstFromType(callArguments[1], templateBindings));
    if (!capacity || keySize <= 0)
        return null;
    const parsed = context.hashContainerOffsets("HashSet", callArguments, templateBindings, capacity);
    const elemSize = parsed?.elemSize ?? context.alignUp(keySize, context.alignOfType(callArguments[0], templateBindings));
    const occBase = parsed?.occBase ?? elemSize * capacity;
    const popOff = parsed?.popOff ?? occBase + Math.floor((capacity * 2 + 63) / 64) * 8;
    const totalSize = parsed?.totalSize ?? popOff + 16;
    const hashMode = keySize === 32 ? 0 : 1;
    return {
        kind: ContainerLayoutKind.HASH_MAP,
        L: capacity,
        elemSize,
        keySize,
        valOff: 0,
        valSize: 0,
        occBase,
        popOff,
        totalSize,
        hashMode,
    };
}

export function arrayInfo(context: ProgramAnalysisInternals, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): ContainerLayoutMetadata | null {
    if (callArguments.length < 2)
        return null;
    const elemSize = context.sizeOfType(callArguments[0], templateBindings);
    const capacity = Number(context.evalConstFromType(callArguments[1], templateBindings));
    if (!capacity || elemSize <= 0)
        return null;
    return {
        kind: ContainerLayoutKind.ARRAY,
        L: capacity,
        elemSize,
        elemType: callArguments[0],
    };
}

export function collectionInfo(context: ProgramAnalysisInternals, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): {
    L: number;
    elementsOff: number;
    stride: number;
    valueOff: number;
    elemType: TypeSpec;
} | null {
    if (callArguments.length < 2)
        return null;
    const capacity = Number(context.evalConstFromType(callArguments[1], templateBindings));
    if (!capacity)
        return null;
    const elementsF = context.containerLayout("Collection", callArguments, templateBindings).fields.get("_elements");
    const bind = context.bindContainer("Collection", callArguments, templateBindings);
    const elemLayout = context.layoutOfType({ kind: AstKind.NAME, name: "Element" }, bind);
    const valueF = elemLayout?.fields.get("value");
    if (!elementsF || !elemLayout || !valueF)
        return null;
    return {
        L: capacity,
        elementsOff: elementsF.offset,
        stride: elemLayout.size,
        valueOff: valueF.offset,
        elemType: callArguments[0],
    };
}

export function linkedListInfo(context: ProgramAnalysisInternals, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): {
    L: number;
    nodesOff: number;
    stride: number;
    valueOff: number;
    elemType: TypeSpec;
} | null {
    if (callArguments.length < 2)
        return null;
    const capacity = Number(context.evalConstFromType(callArguments[1], templateBindings));
    if (!capacity)
        return null;
    const nodesF = context.containerLayout("LinkedList", callArguments, templateBindings).fields.get("_nodes");
    const bind = context.bindContainer("LinkedList", callArguments, templateBindings);
    const nodeLayout = context.layoutOfType({ kind: AstKind.NAME, name: "Node" }, bind);
    const valueF = nodeLayout?.fields.get("value");
    if (!nodesF || !nodeLayout || !valueF)
        return null;
    return {
        L: capacity,
        nodesOff: nodesF.offset,
        stride: nodeLayout.size,
        valueOff: valueF.offset,
        elemType: callArguments[0],
    };
}
