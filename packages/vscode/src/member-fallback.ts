// A clangd bug (17-22) returns an empty completion list through a field whose preamble type holds a
// template member. The QPI compiler resolves those types, so an empty list is re-asked of it in-process.
import {
    completeMembersAt,
    completeMembersOfType,
    declaredTypeOf,
    MemberCompletionKind,
    splitReceiver,
    type MemberQueryOptions,
} from "@qinit/compiler/analyzer";

export interface FallbackItem {
    /** The typed text: what filtering matches and what gets inserted. */
    name: string;
    /** One entry per parameter, e.g. `uint64 indexBegin`, each a snippet placeholder. */
    placeholders: string[];
    returnType?: string;
    kind: "field" | "method";
}

export interface Cancellable {
    isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface FallbackRequest {
    bufferText: string;
    /** 0-based cursor position, VS Code convention (character in UTF-16 units). */
    line: number;
    character: number;
    /** The project's analysis inputs — contract name, slot, qpi.h and callee sources. */
    context?: Omit<MemberQueryOptions, "source" | "offset">;
    cancel?: Cancellable;
    /**
     * The declared type at an offset, as the language server spells it. A gtest is general C++, so its
     * receiver root is resolved there; the field hops after it come back to the compiler.
     */
    rootType?: (offset: number) => Promise<string | undefined>;
}

function offsetOf(text: string, line: number, character: number): number {
    let offset = 0;
    for (let index = 0; index < line; index++) {
        const newline = text.indexOf("\n", offset);
        if (newline < 0) return text.length;
        offset = newline + 1;
    }
    return Math.min(offset + character, text.length);
}

// A contract document resolves entirely from its own AST; a gtest does not parse as a contract, so the
// root's type is asked of `rootType` and only the hops after it go back through the compiler.
async function completions(request: FallbackRequest, offset: number) {
    const contractItems = completeMembersAt({ ...request.context, source: request.bufferText, offset });
    if (contractItems) return contractItems;

    const receiver = splitReceiver(request.bufferText, offset);
    if (!receiver) return undefined;

    // Hover is the better answer — it deduces `auto` and resolves typedefs — but a language server drops
    // the statement it is being typed into, so the declaration in the text is what usually answers.
    const rootTypeText =
        (await request.rootType?.(receiver.rootOffset)) ?? declaredTypeOf(request.bufferText, receiver.rootOffset, receiver.rootText);
    return rootTypeText ? completeMembersOfType({ ...request.context, rootTypeText, path: receiver.path }) : undefined;
}

/** Completion at the cursor from the QPI compiler's own semantics; undefined when nothing resolves. */
export async function memberFallbackCompletions(request: FallbackRequest): Promise<FallbackItem[] | undefined> {
    if (request.cancel?.isCancellationRequested) return undefined;

    const items = await completions(request, offsetOf(request.bufferText, request.line, request.character));
    if (!items || items.length === 0 || request.cancel?.isCancellationRequested) return undefined;

    return items.map((item) => ({
        name: item.name,
        placeholders: item.parameters,
        returnType: item.typeText,
        kind: item.kind === MemberCompletionKind.METHOD ? "method" : "field",
    }));
}
