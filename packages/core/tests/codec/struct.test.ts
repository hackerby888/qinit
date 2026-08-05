import { expect, test } from "bun:test";

import { defineStruct, u56 } from "../../src/struct";

const SevenByteValue = defineStruct("SevenByteValue", {
  value: u56,
});

test("u56 reads and writes the low 56 bits in little-endian order", () => {
  const value = SevenByteValue.alloc();

  value.value = 0x01020304050607n;
  expect(value.bytes).toEqual(
    Uint8Array.of(0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01),
  );
  expect(value.value).toBe(0x01020304050607n);

  value.value = 0xab01020304050607n;
  expect(value.bytes).toEqual(
    Uint8Array.of(0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01),
  );
  expect(value.value).toBe(0x01020304050607n);
});
