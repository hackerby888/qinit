import { CORE_PATH } from "../../../../test-utils/paths";
import { test, expect } from "bun:test";
import { deriveQpiContextLayout } from "../../src/backend/wasm/module/library-index";
import { getQpiContext } from "../../src/driver/qpi-context";
import { loadQpiHeader } from "../../src/driver/header";
import { scalarKindForSize } from "../../src/backend/wasm/idl/scalars";
// Compare compiler and engine context layouts derived from core headers.
import { AbiScalarKind } from "@qinit/proto/contract-idl";
import { QpiContext } from "@qinit/engine/contract/abi";

test("live qpi.h context layout matches the engine ABI", () => {
    const layout = deriveQpiContextLayout(getQpiContext(loadQpiHeader(CORE_PATH)).lib);
    const O = (QpiContext as unknown as { OFFSETS: Record<string, number> }).OFFSETS;
    expect(layout.size).toBe((QpiContext as unknown as { SIZE: number }).SIZE);
    expect(layout.contractIndex).toBe(O.currentContractIndex);
    expect(layout.originator).toBe(O.originator);
    expect(layout.invocator).toBe(O.invocator);
    expect(layout.invocationReward).toBe(O.invocationReward);
});

// The last-resort mapping for an unresolvable named type in a public struct — an unexpected width silently
// becomes UINT32 on the wire, so the fallback is pinned alongside the sizes it does recognise.
test("scalar widths map to their wire kinds", () => {
    const kinds: Record<number, AbiScalarKind> = {
        1: AbiScalarKind.UINT8,
        2: AbiScalarKind.UINT16,
        4: AbiScalarKind.UINT32,
        8: AbiScalarKind.UINT64,
        16: AbiScalarKind.UINT128,
        32: AbiScalarKind.M256I,
        3: AbiScalarKind.UINT32,
        0: AbiScalarKind.UINT32,
    };

    for (const [size, kind] of Object.entries(kinds)) {
        expect(scalarKindForSize(Number(size))).toBe(kind);
    }
});
