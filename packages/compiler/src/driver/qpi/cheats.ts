// Development cheatcodes. Injected ahead of user source and stripped again before a contract is
// submitted to Core, so nothing here may outlive a dev build.
//
// CC_PRINT is variadic and takes any mix of string literals and typed values. Literals never reach the
// wasm: the compiler interns them in the IDL and emits nothing, which is what keeps QPI's string ban
// intact and works around the backend having no string codegen at all.

/** Arguments per call, since the ordinal rides in the low byte of the tag the contract sends. */
export const CHEAT_MAX_PARTS = 255;

/** How a cheat build treats the macros: expand them, define them away, or leave them undeclared. */
export type CheatMode = "on" | "noop" | "off";

const ACTIVE = `#define QINIT_CC_LINE_BASE __QINIT_CC_LINE_BASE__
#define CC_PRINT(...) __qinit_cheat_print(__LINE__ - QINIT_CC_LINE_BASE, __VA_ARGS__);
#define CC_ASSERT(c) if (!(c)) { qpi.__qpiAbort(0xCC000000u | (__LINE__ - QINIT_CC_LINE_BASE)); }
#define CC_PAY(dest, amount) qpi.transfer(dest, amount);
#define CC_DEAL(who, amount) __qinit_cheat_call(2u, (uint64)(amount), 0, who);
#define CC_WARP_TICK(n) __qinit_cheat_call(3u, (uint64)(n), 0, NULL_ID);
#define CC_WARP_EPOCH(n) __qinit_cheat_call(4u, (uint64)(n), 0, NULL_ID);
#define CC_PRANK(who, reward) __qinit_cheat_call(5u, (uint64)(reward), 0, who);
#define CC_UNPRANK() __qinit_cheat_call(6u, 0, 0, NULL_ID);
`;

// Same names, no bodies. This is the reference build the strip is proved against: it must erase the
// call sites exactly as stripping does, so the two artifacts can be compared byte for byte.
const NEUTERED = `#define CC_PRINT(...)
#define CC_ASSERT(c)
#define CC_PAY(dest, amount)
#define CC_DEAL(who, amount)
#define CC_WARP_TICK(n)
#define CC_WARP_EPOCH(n)
#define CC_PRANK(who, reward)
#define CC_UNPRANK()
`;

/**
 * The macro block to inject ahead of user source. `lineBase` is how many lines the caller prepended,
 * so `__LINE__` reports the user's own line; it is computed from the real prelude rather than pinned,
 * because injecting this block changes it.
 */
export function cheatMacros(mode: CheatMode, lineBase: number): string {
    if (mode === "off") {
        return "";
    }

    // No trailing newline: the caller joins with one, and a spare blank line here would shift every
    // user line by one and land in the diagnostics the remapper reports.
    const block = mode === "noop" ? NEUTERED : ACTIVE.replace("__QINIT_CC_LINE_BASE__", String(lineBase));

    return block.replace(/\n$/, "");
}
