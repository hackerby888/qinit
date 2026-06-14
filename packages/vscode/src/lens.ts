// CodeLens computation (pure, no vscode) for QPI contracts: contract-level actions on the state
// struct, and a per-registered-fn "call" lens. The provider in codelens.ts wraps these into
// vscode.CodeLens objects bound to the qpi.* commands.
import { blankComments } from "./lint/idl-checks";

export interface LensSpec {
  line: number; // 0-based line the lens sits on
  title: string;
  command: string; // a registered qpi.* command id
}

const lineAt = (src: string, idx: number): number => {
  let n = 0;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
};

export function computeLenses(source: string): LensSpec[] {
  const src = blankComments(source); // don't lens commented-out code
  const out: LensSpec[] = [];

  // Contract-level actions on the `struct X : public ContractBase` line.
  const m = src.match(/struct\s+\w+\s*:\s*public\s+ContractBase\b/);
  if (m && m.index !== undefined) {
    const ln = lineAt(src, m.index);
    out.push({ line: ln, title: "$(tools) build", command: "qpi.build" });
    out.push({ line: ln, title: "$(rocket) deploy", command: "qpi.deploy" });
    out.push({ line: ln, title: "$(code) gen client", command: "qpi.gen" });
  }

  // A "call" lens on each registered function/procedure.
  for (const r of src.matchAll(/REGISTER_USER_(?:FUNCTION|PROCEDURE)\s*\(\s*(\w+)\s*,\s*\d+\s*\)/g)) {
    out.push({ line: lineAt(src, r.index!), title: `$(play) call ${r[1]}`, command: "qpi.call" });
  }

  return out;
}
