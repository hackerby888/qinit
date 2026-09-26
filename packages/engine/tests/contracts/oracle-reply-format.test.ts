import { expect, test } from "bun:test";
import { abiTypeFromFormat, encodeInputFormatAs, layoutOf, zeroInputFormat } from "@qinit/proto";
import { ORACLE_INTERFACES } from "../../src/oracle-interfaces/registry";

// replyFormat and the defineStruct mirror describe the same bytes, so a dev tool can encode a reply from text the user typed.
test.each(ORACLE_INTERFACES.map((oracleInterface) => [oracleInterface.name, oracleInterface] as const))(
    "%s reply format matches its layout",
    (_name, oracleInterface) => {
        expect(layoutOf(oracleInterface.replyFormat).size).toBe(oracleInterface.reply.SIZE);
        expect(abiTypeFromFormat(oracleInterface.replyFormat).size).toBe(oracleInterface.reply.SIZE);
    },
);

test("a typed reply encodes at the layout's offsets", async () => {
    const price = abiTypeFromFormat(ORACLE_INTERFACES[0].replyFormat);
    const bytes = await encodeInputFormatAs(price, "123456sint64, 1000sint64");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(bytes.length).toBe(16);
    expect([view.getBigInt64(0, true), view.getBigInt64(8, true)]).toEqual([123456n, 1000n]);
});

test("a mis-spelled or short reply is refused, and the zero sample is the shape to copy", async () => {
    const price = abiTypeFromFormat(ORACLE_INTERFACES[0].replyFormat);

    expect(encodeInputFormatAs(price, "1000uint64, 10uint64")).rejects.toThrow("sint64");
    expect(encodeInputFormatAs(price, "1sint64")).rejects.toThrow("2 field(s)");
    expect(zeroInputFormat(price)).toBe("0sint64, 0sint64");
});

test("the doge reply spells its bit member and keeps the trailing pad", async () => {
    const doge = ORACLE_INTERFACES[2];
    const bytes = await encodeInputFormatAs(abiTypeFromFormat(doge.replyFormat), "7uint32, 1bit");

    expect(bytes.length).toBe(doge.reply.SIZE);
    expect(Buffer.from(bytes).toString("hex")).toBe("0700000001000000");
});
