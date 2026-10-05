// how a contract failure is spelled for a developer; node-free, so a browser host words a fault the same way the CLI does.
import { WASM_TRAP_ERROR_CODE } from "../../wasm/lhost-abi";

const ASSERT_CODE_BASE = 0xcc000000;

// abort(3422552174) is how both runtimes spell a cheatcode abort; the hex form is what the developer reads a line number out of, so show both.
export function withHexAbortCode(message: string): string {
    return message.replace(/abort\((\d+)\)/g, (whole, digits: string) => {
        const code = Number(digits);
        return Number.isSafeInteger(code) ? `abort(0x${code.toString(16).toUpperCase()})` : whole;
    });
}

const TRAP_CODE_TEXT = new RegExp(`abort\\(0x${WASM_TRAP_ERROR_CODE.toString(16).toUpperCase()}\\)|\\b${WASM_TRAP_ERROR_CODE}\\b`, "g");
// Core reports a function failure as the bare error code; a code in the assert range is a line number.
const BARE_ASSERT_CODE = /(smart contract function: )(\d+)$/;

/** A contract error line with its codes spelled the way a developer reads them. */
export function describeContractError(message: string): string {
    const named = message.replace(BARE_ASSERT_CODE, (whole, prefix: string, digits: string) => {
        const code = Number(digits);
        return code >= ASSERT_CODE_BASE && code <= ASSERT_CODE_BASE + 0xffffff ? `${prefix}abort(${code})` : whole;
    });
    return withHexAbortCode(named).replace(TRAP_CODE_TEXT, "wasm trap");
}

/** the source line a failed CC_ASSERT names, when the message carries an abort code from that range. */
export function assertLine(message: string): number | undefined {
    const match = /abort\((0x[0-9a-f]+|\d+)\)/i.exec(message);
    if (!match) {
        return undefined;
    }

    // codes from the trap code up belong to the runtime and the cheat mutators, not to a source line.
    const code = Number(match[1]);
    return code > ASSERT_CODE_BASE && code < WASM_TRAP_ERROR_CODE ? code - ASSERT_CODE_BASE : undefined;
}
