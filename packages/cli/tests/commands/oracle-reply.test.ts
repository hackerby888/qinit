import { expect, test } from "bun:test";
import { encodeReply } from "../../src/commands/node/oracle";

const PRICE = 0;
const DOGE = 2;

test("a price reply encodes from value text", async () => {
    const reply = await encodeReply(PRICE, "123456sint64, 1000sint64", undefined);
    const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);

    expect(reply.length).toBe(16);
    expect([view.getBigInt64(0, true), view.getBigInt64(8, true)]).toEqual([123456n, 1000n]);
});

test("a reply needs no types, the interface supplies them", async () => {
    expect(await encodeReply(PRICE, "123456, -1000", undefined)).toEqual(await encodeReply(PRICE, "123456sint64, -1000sint64", undefined));
});

test("a mis-spelled member names the field and shows the shape to copy", async () => {
    expect(encodeReply(PRICE, "1000uint64, 10uint64", undefined)).rejects.toThrow("input.numerator is sint64");
    expect(encodeReply(PRICE, "1000uint64, 10uint64", undefined)).rejects.toThrow("Price reply looks like: 0sint64, 0sint64");
});

test("a value out of its type's range is refused", async () => {
    expect(encodeReply(DOGE, "99999999999uint32, 1bit", undefined)).rejects.toThrow("out of range");
});

test("hex bytes are accepted for a layout too large to type, but only at the right size", async () => {
    expect(await encodeReply(PRICE, "", "40e2010000000000e803000000000000")).toHaveLength(16);
    expect(await encodeReply(PRICE, "", "0x40e2010000000000e803000000000000")).toHaveLength(16);
    expect(encodeReply(PRICE, "", "40e201")).rejects.toThrow("wants 16");
    expect(encodeReply(PRICE, "", "zz")).rejects.toThrow("whole hex bytes");
});

test("an unknown interface is refused", async () => {
    expect(encodeReply(99, "1sint64", undefined)).rejects.toThrow("unknown oracle interface 99");
});

test("an empty --reply-hex is a zero-byte hex reply, and the 0X prefix is accepted too", async () => {
    await expect(encodeReply(PRICE, "", "")).rejects.toThrow("wants 16");
    expect(await encodeReply(PRICE, "", "0X40e2010000000000e803000000000000")).toHaveLength(16);
});
