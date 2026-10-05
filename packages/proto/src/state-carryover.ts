// The layout fields a redeploy check reads; a full ContractIdl satisfies it, and so does a host's trimmed view.
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
    const changed = `state layout changed — was ${before.size} B (${before.format || "empty"}), now ${after.size} B (${after.format || "empty"}) — `;

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
