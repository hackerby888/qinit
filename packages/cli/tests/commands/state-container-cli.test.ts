import { expect, test } from "bun:test";
import { join } from "node:path";

const cli = join(import.meta.dir, "../../src/index.tsx");

async function runState(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "state", "29", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

test("state validates lazy container options before contacting the node", async () => {
  const [zero, unsafe, conflicting, dump] = await Promise.all([
    runState("--container", "0"),
    runState("--container", "9007199254740992"),
    runState("--all", "--container", "1"),
    runState("--dump", "--container", "1"),
  ]);

  expect(zero.stdout).toContain("--container must be a positive safe integer");
  expect(unsafe.stdout).toContain("--container must be a positive safe integer");
  expect(conflicting.stdout).toContain("--all cannot be combined with --container");
  expect(dump.stdout).toContain("only apply to decoded state output");
  for (const result of [zero, unsafe, conflicting, dump]) {
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
  }
});
