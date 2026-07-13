// Pure parsing/decision logic for Tier-B (contractverify) — kept vscode-free so it's unit-testable
// under `bun test`. The vscode-facing spawner lives in verify-runner.ts.

export interface VerifyJson {
  ok?: boolean;
  available?: boolean;
  oracle?: boolean;
  errors?: string[];
}

// `qinit verify --json` writes one JSON line to stdout; read the last non-empty line. null if unparseable.
export function parseVerifyJson(stdout: string): VerifyJson | null {
  const line = (stdout || "").trim().split("\n").pop() || "";
  try {
    const o = JSON.parse(line);
    return o && typeof o === "object" ? (o as VerifyJson) : null;
  } catch {
    return null;
  }
}

// Which violation messages to surface. Empty when the tool was unavailable (skipped), the contract
// passed, or the output was unparseable — so a missing/broken verifier never shows phantom errors.
export function verifyErrors(res: VerifyJson | null): string[] {
  if (!res || res.available === false || res.ok) return [];
  return res.errors ?? [];
}
