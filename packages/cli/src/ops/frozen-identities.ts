import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrozenIdentities } from "@qinit/engine";

// core fills its frozen set from this header at boot; a core without the header has no isFrozenIdentity either
export function readFrozenIdentities(core: string): ReadonlySet<string> | undefined {
    const path = join(core, "src", "frozen_addresses.h");
    return existsSync(path) ? parseFrozenIdentities(readFileSync(path, "utf8")) : undefined;
}
