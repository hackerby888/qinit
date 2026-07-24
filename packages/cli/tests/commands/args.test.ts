// Pin the shared parser's flag, positional, and nearest-match behavior.
import { test, expect } from "bun:test";
import { parseArgs, nearest, initOutput, output } from "../../src/args";

test("parseArgs: positionals collected in order, separate from flags", () => {
  const p = parseArgs(["run", "status", "--rpc", "http://x"], {
    strings: ["rpc"],
  });

  expect(p.pos).toEqual(["run", "status"]);
  expect(p.flags.rpc).toBe("http://x");
  expect(p.get("rpc")).toBe("http://x");
});

test("parseArgs: declared strings and booleans keep their existing result shape", () => {
  const p = parseArgs(["--ref", "v1.2", "--restart"], {
    strings: ["ref"],
    booleans: ["restart"],
  });

  expect(p.flags.ref).toBe("v1.2");
  expect(p.flags.restart).toBe("");
  expect(p.has("restart")).toBe(true);
});

test("parseArgs: supports equals syntax and the option separator", () => {
  const p = parseArgs(["--rpc=http://x", "--", "--literal"], {
    strings: ["rpc"],
  });

  expect(p.flags.rpc).toBe("http://x");
  expect(p.pos).toEqual(["--literal"]);
});

test("parseArgs: declared booleans never consume the next token, even as the first arg", () => {
  const p = parseArgs(["--restart", "run"], { booleans: ["restart"] });

  expect(p.flags.restart).toBe("");
  expect(p.pos).toEqual(["run"]);
});

test("parseArgs: multi keys collect repeats and stay out of flags", () => {
  const p = parseArgs(["--callee", "A=a@1", "--callee=B=b@2"], {
    multi: ["callee"],
  });

  expect(p.multi.callee).toEqual(["A=a@1", "B=b@2"]);
  expect(p.has("callee")).toBe(true);
  expect("callee" in p.flags).toBe(false);
  expect(p.get("callee", "DEF")).toBe("DEF");
});

test("parseArgs: --help / -h set the help flag without becoming positionals", () => {
  expect(parseArgs(["build", "--help"]).help).toBe(true);
  expect(parseArgs(["-h"]).help).toBe(true);
  expect(parseArgs(["build", "--help"]).pos).toEqual(["build"]);
});

test("parseArgs: json/plain are booleans by default — value follows as a positional", () => {
  const p = parseArgs(["--json", "extra"]);

  expect(p.flags.json).toBe("");
  expect(p.pos).toEqual(["extra"]);
});

test("parseArgs: get returns the default when the flag is absent", () => {
  const p = parseArgs(["build"]);

  expect(p.get("missing", "fallback")).toBe("fallback");
  expect(p.has("missing")).toBe(false);
});

test("parseArgs: rejects unknown flags and missing string values", () => {
  expect(() => parseArgs(["--rpx", "http://x"], { strings: ["rpc"] })).toThrow(
    "Unknown option '--rpx'",
  );
  expect(() => parseArgs(["--rpc"], { strings: ["rpc"] })).toThrow(
    "argument missing",
  );
});

test("nearest: suggests a plausible typo within the edit-distance threshold", () => {
  expect(nearest("buld", ["build", "deploy", "verify"])).toBe("build");
  expect(nearest("dpeloy", ["build", "deploy", "verify"])).toBe("deploy");
});

test("nearest: returns undefined when nothing is close enough", () => {
  expect(nearest("xyzzy", ["build", "deploy"])).toBeUndefined();
  expect(nearest("", ["build"])).toBeUndefined();
});

test("initOutput: --json forces both json and plain on", () => {
  initOutput(["--json"]);

  expect(output.json).toBe(true);
  expect(output.plain).toBe(true);
});

test("initOutput: --plain sets plain without json", () => {
  initOutput(["--plain"]);

  expect(output.json).toBe(false);
  expect(output.plain).toBe(true);
});
