import { test, expect } from "bun:test";
import { assertSeed, buildSignedTx, LITE_DEPLOY_ADDRESS } from "../../src/tx";

const hx = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

test("LITE_DEPLOY_ADDRESS = id(99999,0,0,0) little-endian (NOT the zero core address)", () => {
  expect(LITE_DEPLOY_ADDRESS.length).toBe(32);
  expect(hx(LITE_DEPLOY_ADDRESS.slice(0, 8))).toBe("9f86010000000000"); // 99999 LE
  expect(hx(LITE_DEPLOY_ADDRESS.slice(8))).toBe("00".repeat(24));
});

test("buildSignedTx: bytes = 144 + payload, 60-char id, tick passthrough, deterministic", async () => {
  const t = { tick: 1000, inputType: 1, payload: new Uint8Array([1, 2, 3]) };
  const a = await buildSignedTx("a".repeat(55), t);
  expect(a.bytes.length).toBe(147); // src32+dst32+amount8+tick4+inputType2+inputSize2+payload3+sig64
  expect(a.id).toMatch(/^[a-z]{60}$/);
  expect(a.tick).toBe(1000);
  const b = await buildSignedTx("a".repeat(55), t);
  expect(b.id).toBe(a.id); // schnorrq deterministic -> same inputs, same id
});

test("buildSignedTx: destination defaults to LITE_DEPLOY_ADDRESS (bytes[32:64])", async () => {
  const a = await buildSignedTx("a".repeat(55), {
    tick: 5,
    inputType: 1,
    payload: new Uint8Array([9]),
  });
  expect(hx(a.bytes.slice(32, 64))).toBe(hx(LITE_DEPLOY_ADDRESS));
});

test("assertSeed accepts 55 lowercase a-z, rejects everything else", () => {
  expect(() => assertSeed("a".repeat(55))).not.toThrow();
  for (const bad of [
    "",
    "a".repeat(54),
    "a".repeat(56),
    "A".repeat(55),
    "a".repeat(54) + "1",
    "a".repeat(54) + " ",
    "a".repeat(54) + "é",
  ])
    expect(() => assertSeed(bad)).toThrow(/invalid seed/);
});

test("buildSignedTx rejects bad seed / tick / amount before signing", async () => {
  const p = new Uint8Array();
  await expect(buildSignedTx("nope", { tick: 1, inputType: 0, payload: p })).rejects.toThrow(
    /invalid seed/,
  );
  await expect(
    buildSignedTx("a".repeat(55), { tick: 0, inputType: 0, payload: p }),
  ).rejects.toThrow(/invalid tick/);
  await expect(
    buildSignedTx("a".repeat(55), { tick: -1, inputType: 0, payload: p }),
  ).rejects.toThrow(/invalid tick/);
  await expect(
    buildSignedTx("a".repeat(55), { tick: 1.5, inputType: 0, payload: p }),
  ).rejects.toThrow(/invalid tick/);
  await expect(
    buildSignedTx("a".repeat(55), { tick: 1, inputType: 0, amount: -5, payload: p }),
  ).rejects.toThrow(/invalid amount/);
  await expect(
    buildSignedTx("a".repeat(55), { tick: 1, inputType: 0, amount: Infinity, payload: p }),
  ).rejects.toThrow(/invalid amount/);
});
