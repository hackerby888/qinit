import { expect, test } from "bun:test";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../src/index.tsx");

async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    code: child.exitCode,
    stdout,
    stderr,
  };
}

test("CLI reports unknown options without a crash message", async () => {
  const result = await run("mode", "--bogus");

  expect(result.code).toBe(1);
  expect(result.stdout).toContain("invalid arguments: Unknown option '--bogus'");
  expect(result.stdout).toContain("qinit mode --help");
  expect(result.stdout).not.toContain("qinit crashed");
  expect(result.stderr).toBe("");
});

test("CLI reports missing option values", async () => {
  const result = await run("ls", "--rpc");

  expect(result.code).toBe(1);
  expect(result.stdout).toContain("invalid arguments:");
  expect(result.stdout).toContain("Option '--rpc <value>' argument missing");
  expect(result.stderr).toBe("");
});

test("call mode flags leave contract and entry as positionals", async () => {
  const result = await run("call", "--fn", "Counter");

  expect(result.code).toBe(1);
  expect(result.stdout).toContain(
    "invalid arguments: fn requires <contract> and <entry>",
  );
  expect(result.stderr).toBe("");
});

test("hidden server options are strict too", async () => {
  const result = await run("__serve", "--bogus");

  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("qinit: fatal error: Unknown option '--bogus'");
});
