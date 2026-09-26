import type { BuildProfile } from "@qinit/core/wasm/slot-layout-source";
import { QPI_PRELUDE } from "./qpi/prelude";
import { assembleQpiHeader, QPI_BUILD_PROFILE_BLOCK } from "./qpi/snapshot";

// the header is assembled under the node's profile; core's own contract gtests are written for its default constants and drop the block.
export function loadQpiHeader(corePath?: string, profile: BuildProfile = "node"): string {
    if (typeof process !== "undefined" && (process.versions?.bun || process.versions?.node)) {
        const configured = corePath ?? process.env.QINIT_CORE;
        if (!configured) {
            throw new Error("cannot load live qpi.h: pass a core-lite path or set QINIT_CORE");
        }
        const header = assembleQpiHeader(configured);
        if (profile === "node") {
            return header;
        }
        if (!header.includes(QPI_BUILD_PROFILE_BLOCK)) {
            throw new Error("the assembled qpi.h carries no build profile block to drop");
        }
        return header.replace(QPI_BUILD_PROFILE_BLOCK, "");
    }
    throw new Error("cannot load live qpi.h in a browser; use @qinit/compiler/browser so the generated core snapshot is supplied");
}

export function withPrelude(headers: string): string {
    return QPI_PRELUDE + "\n" + headers;
}
