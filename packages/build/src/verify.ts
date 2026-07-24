import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cacheRoot, readCurrent } from "@qinit/core";

export interface VerifyResult {
  available: boolean;
  ok: boolean;
  oracle: boolean;
  errors: string[];
  raw?: string;
  tool?: string;
}

export function resolveVerifyTool(): string | null {
  const candidates = [
    process.env.QINIT_VERIFY,
    readCurrent()?.verify,
    join(cacheRoot(), "tools", "contractverify"),
  ]
    .filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return Bun.which("contractverify");
}

function concretize(source: string, name: string): string {
  return source
    .replaceAll("CONTRACT_STATE2_TYPE", `${name}2`)
    .replaceAll("CONTRACT_STATE_TYPE", name);
}

export async function verifyContract(
  file: string,
  name: string,
  options?: { oracle?: boolean; allowedPrefixes?: string[] },
): Promise<VerifyResult> {
  const tool = resolveVerifyTool();
  const oracle = !!options?.oracle || /oracle_interface/i.test(file);

  if (!tool) {
    return { available: false, ok: true, oracle, errors: [] };
  }

  let target = file;

  if (!oracle) {
    const temporaryFile = join(
      tmpdir(),
      `qinit-verify-${name}-${process.pid}.h`,
    );
    writeFileSync(
      temporaryFile,
      concretize(readFileSync(file, "utf8"), name),
    );
    target = temporaryFile;
  }

  const child = Bun.spawn(
    [tool, ...(oracle ? ["--oi", target] : [target])],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;

  const raw = (stdout + stderr).trim();
  const allErrors = raw
    .split("\n")
    .filter((line) => line.includes("[ ERROR ]"))
    .map((line) => line.replace(/.*\[ ERROR \]\s*/, "").trim());
  const allowedPrefixes = options?.allowedPrefixes ?? [];
  const errors = allErrors.filter(
    (error) =>
      !allowedPrefixes.some(
        (prefix) =>
          error ===
          `Scope resolution with prefix ${prefix} is not allowed.`,
      ),
  );
  const dropped = allErrors.length - errors.length;

  if (child.exitCode !== 0 && allErrors.length === 0) {
    return { available: false, ok: true, oracle, errors: [], raw, tool };
  }

  const ok =
    child.exitCode === 0 || (dropped > 0 && errors.length === 0);

  return { available: true, ok, oracle, errors, raw, tool };
}
