import { test, expect } from "bun:test";
import { k12Hex, deriveIdentity, bytesToIdentity, identityToBytes } from "../../src/qubic";

const enc = (s: string) => new TextEncoder().encode(s);
const hx = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const PUB = "1f590d03e613bdded38b4c0820ac44615f91af12435980b3ede3c08c315a2544"; // pubkey of seed "a"*55

test("k12Hex: KangarooTwelve KT128 known-answer for empty input", async () => {
  // published K12(M="", C="", 32) vector — a true correctness check, not just regression
  expect(await k12Hex(new Uint8Array(0))).toBe(
    "1ac2d450fc3b4205d19da7bfca1b37513c0803577ac7167f06fe2ce1f0ef39e5",
  );
});

test("k12Hex: golden for 'abc' + deterministic", async () => {
  const h = await k12Hex(enc("abc"));
  expect(h).toBe("ab174f328c55a5510b0b209791bf8b60e801a7cfc2aa42042dcb8f547fbe3a7d");
  expect(await k12Hex(enc("abc"))).toBe(h);
});

test("deriveIdentity: golden FourQ pubkey for seed a*55 + valid identity, deterministic", async () => {
  const id = await deriveIdentity("a".repeat(55));
  expect(id.publicKeyHex).toBe(PUB); // locks K12-subseed + FourQ against a lib bump
  expect(id.identity).toMatch(/^[A-Z]{60}$/);
  expect((await deriveIdentity("a".repeat(55))).identity).toBe(id.identity);
});

test("identity codec: pubkey <-> 60-char identity round-trips", async () => {
  const idn = await bytesToIdentity(bytes(PUB));
  expect(idn).toMatch(/^[A-Z]{60}$/);
  expect(hx(identityToBytes(idn))).toBe(PUB); // 32B -> 60-char -> 32B identity
  expect(identityToBytes(idn).length).toBe(32);
});
