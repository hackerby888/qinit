import { expect, test } from "bun:test";
import {
  initOutput,
  nearest,
  output,
  parseArgs,
  parseCommandInvocation,
} from "../../src/args";

test("parseArgs collects positionals separately from options", () => {
  const parsed = parseArgs(["run", "status", "--rpc", "http://x"], {
    strings: ["rpc"],
  });

  expect(parsed.positionals).toEqual(["run", "status"]);
  expect(parsed.get("rpc")).toBe("http://x");
  expect(parsed.has("rpc")).toBe(true);
});

test("parseArgs exposes booleans through has", () => {
  const parsed = parseArgs(["--ref", "v1.2", "--restart"], {
    strings: ["ref"],
    booleans: ["restart"],
  });

  expect(parsed.get("ref")).toBe("v1.2");
  expect(parsed.get("restart")).toBeUndefined();
  expect(parsed.has("restart")).toBe(true);
});

test("parseArgs supports equals syntax and the option separator", () => {
  const parsed = parseArgs(["--rpc=http://x", "--", "--literal"], {
    strings: ["rpc"],
  });

  expect(parsed.get("rpc")).toBe("http://x");
  expect(parsed.positionals).toEqual(["--literal"]);
});

test("parseArgs booleans never consume the next positional", () => {
  const parsed = parseArgs(["--restart", "run"], {
    booleans: ["restart"],
  });

  expect(parsed.has("restart")).toBe(true);
  expect(parsed.positionals).toEqual(["run"]);
});

test("parseArgs exposes repeated values only through getAll", () => {
  const parsed = parseArgs(["--callee", "A=a@1", "--callee=B=b@2"], {
    multi: ["callee"],
  });

  expect(parsed.getAll("callee")).toEqual(["A=a@1", "B=b@2"]);
  expect(parsed.getAll("missing")).toEqual([]);
  expect(parsed.get("callee")).toBeUndefined();
  expect(parsed.has("callee")).toBe(true);
});

test("parseArgs accepts global help, json, and plain options", () => {
  const parsed = parseArgs(["build", "-h", "--json", "--plain"]);

  expect(parsed.positionals).toEqual(["build"]);
  expect(parsed.has("help")).toBe(true);
  expect(parsed.has("json")).toBe(true);
  expect(parsed.has("plain")).toBe(true);
});

test("parseArgs returns undefined and false for absent options", () => {
  const parsed = parseArgs(["build"]);

  expect(parsed.get("missing")).toBeUndefined();
  expect(parsed.has("missing")).toBe(false);
});

test("parseArgs rejects unknown options and missing string values", () => {
  expect(() => parseArgs(["--rpx", "http://x"], { strings: ["rpc"] })).toThrow(
    "Unknown option '--rpx'",
  );
  expect(() => parseArgs(["--rpc"], { strings: ["rpc"] })).toThrow(
    "argument missing",
  );
});

test("parseCommandInvocation gets definitions from command metadata", () => {
  const invocation = parseCommandInvocation("build", [
    "Counter.h",
    "--rpc",
    "http://x",
    "--callee",
    "A=a.h@1",
    "--callee=B=b.h@2",
    "--compiler",
    "typescript",
    "--contract-name",
    "Counter",
  ]);

  expect(invocation.command).toBe("build");
  expect(invocation.subcommand).toBeUndefined();
  expect(invocation.commandArgs.positionals).toEqual(["Counter.h"]);
  expect(invocation.commandArgs.get("rpc")).toBe("http://x");
  expect(invocation.commandArgs.get("compiler")).toBe("typescript");
  expect(invocation.commandArgs.get("contract-name")).toBe("Counter");
  expect(invocation.commandArgs.getAll("callee")).toEqual([
    "A=a.h@1",
    "B=b.h@2",
  ]);
});

test("parseCommandInvocation resolves and strips a known first subcommand", () => {
  const invocation = parseCommandInvocation("node", [
    "run",
    "--restart",
    "--rpc",
    "http://x",
  ]);

  expect(invocation.subcommand).toBe("run");
  expect(invocation.commandArgs.positionals).toEqual([]);
  expect(invocation.commandArgs.has("restart")).toBe(true);
  expect(invocation.commandArgs.get("rpc")).toBe("http://x");
});

test("parseCommandInvocation scopes options to the resolved subcommand", () => {
  expect(() =>
    parseCommandInvocation("node", ["status", "--restart"]),
  ).toThrow("Unknown option '--restart'");

  const unknown = parseCommandInvocation("node", ["unknown", "--rpc", "http://x"]);
  expect(unknown.subcommand).toBeUndefined();
  expect(unknown.commandArgs.positionals).toEqual(["unknown"]);
});

test("nearest suggests a plausible typo within the edit-distance threshold", () => {
  expect(nearest("buld", ["build", "deploy", "verify"])).toBe("build");
  expect(nearest("dpeloy", ["build", "deploy", "verify"])).toBe("deploy");
});

test("nearest returns undefined when nothing is close enough", () => {
  expect(nearest("xyzzy", ["build", "deploy"])).toBeUndefined();
  expect(nearest("", ["build"])).toBeUndefined();
});

test("initOutput makes json output plain", () => {
  initOutput(["--json"]);

  expect(output.json).toBe(true);
  expect(output.plain).toBe(true);
});

test("initOutput enables plain output without json", () => {
  initOutput(["--plain"]);

  expect(output.json).toBe(false);
  expect(output.plain).toBe(true);
});
