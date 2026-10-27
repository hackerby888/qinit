// the layout fields a redeploy check reads; a full ContractIdl satisfies it, and so does a host's trimmed view.
export interface StateLayoutView {
    state?: { size: number; format: string };
    migration?: { oldState: { size: number } };
}

const NODE_RECOVERY = "restart the node for a clean slot, or pass --allow-state-carryover to keep the bytes as they are";

// Why a redeploy of `next` over `previous` must not proceed, or null when the bytes stay readable: a changed layout is reinterpreted unless a MIGRATE handler that can actually run rewrites it.
export function stateCarryoverRejection(name: string, previous: StateLayoutView, next: StateLayoutView, recovery: string = NODE_RECOVERY): string | null {
    const before = previous.state;
    const after = next.state;
    if (!before || !after) {
        return null;
    }
    if (before.size === after.size && before.format === after.format) {
        return null;
    }
    const changed = `state layout changed — was ${before.size} B, now ${after.size} B (${layoutDiff(before.format, after.format)}) — `;

    // A handler only answers a changed layout when it can run: the runtime fires MIGRATE only if
    // OldStateData is exactly the deployed state's size, and a wrong one is skipped in silence.
    if (next.migration) {
        const declared = next.migration.oldState.size;
        if (declared === before.size) {
            return null;
        }
        return (
            changed +
            `and ${name}'s MIGRATE declares an OldStateData of ${declared} B, not the ${before.size} B the node holds, ` +
            "so the handler would be skipped and the old state bytes reinterpreted under the new offsets. " +
            `Make OldStateData match the deployed StateData, ${recovery}.`
        );
    }

    return changed + `and ${name} has no MIGRATE handler, so the old state bytes would be reinterpreted under the new offsets. ` + `Add a MIGRATE handler, ${recovery}.`;
}

// the top-level entries of a layout format; a nested struct or array counts as one field
function topLevelFields(format: string): string[] {
    const fields: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < format.length; index++) {
        const char = format[index];
        if (char === "{" || char === "[") depth++;
        else if (char === "}" || char === "]") depth--;
        else if (char === "," && depth === 0) {
            fields.push(format.slice(start, index).trim());
            start = index + 1;
        }
    }
    const last = format.slice(start).trim();
    if (last) fields.push(last);
    return fields;
}

// the fields between the two layouts' common prefix and suffix, so a 400 MB state reports "added 1: sint64 at the end" instead of both full formats
function layoutDiff(before: string, after: string): string {
    const old = topLevelFields(before);
    const now = topLevelFields(after);
    let prefix = 0;
    while (prefix < old.length && prefix < now.length && old[prefix] === now[prefix]) prefix++;
    let suffix = 0;
    while (suffix < old.length - prefix && suffix < now.length - prefix && old[old.length - 1 - suffix] === now[now.length - 1 - suffix]) suffix++;
    const removed = old.slice(prefix, old.length - suffix);
    const added = now.slice(prefix, now.length - suffix);
    const list = (fields: string[]) => fields.map((field) => (field.length > 40 ? `${field.slice(0, 37)}…` : field)).join(", ");
    const parts = [];
    if (removed.length) parts.push(`removed ${removed.length}: ${list(removed)}`);
    if (added.length) parts.push(`added ${added.length}: ${list(added)}`);
    if (!parts.length) return "same fields, different size";
    return `${parts.join("; ")} ${prefix === old.length ? "at the end" : `at field #${prefix + 1}`}`;
}
