import { CORE_PATH } from "../../../test-utils/paths";
import { AstKind } from "../src/enums";
// Iteration harness: preprocess + parse the REAL core-lite headers, report errors + captured layouts.
import { readFileSync, existsSync } from "node:fs";
import { Preprocessor } from "../src/preprocess";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { QPI_PRELUDE } from "../src/qpi-prelude";

const CORE = CORE_PATH + "/src";

const HEADERS = [
  "contract_core/pre_qpi_def.h",
  "contracts/qpi.h",
];

function loadHeaders(): string {
  let content = QPI_PRELUDE + "\n";
  for (const h of HEADERS) {
    const p = `${CORE}/${h}`;
    if (existsSync(p)) content += readFileSync(p, "utf8") + "\n";
    else console.log("MISSING:", p);
  }
  return content;
}

const raw = loadHeaders();
const pp = new Preprocessor();
const pre = pp.preprocess({ source: "", qpiHeader: raw, contractName: "X", contractIndex: 28 });

const lex = new Lexer(pre);
const toks = lex.tokenize();
const parser = new Parser(toks);
const translationUnit = parser.parseTranslationUnit();
const diags = parser.getDiagnostics();

console.log(`tokens: ${toks.length}, top-level decls: ${translationUnit.declarations.length}, parse errors: ${diags.length}`);
for (const d of translationUnit.declarations) {
  const nm = (d as any).name ?? "";
  const cnt = (d as any).body?.length ?? (d as any).members?.length ?? "";
  console.log(`  top: ${d.kind} ${nm} (${cnt})`);
  if (d.kind === AstKind.NAMESPACE && nm === "QPI") {
    const kinds: Record<string, number> = {};
    for (const m of (d as any).body) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
    console.log("    QPI members:", JSON.stringify(kinds));
    const ct = (d as any).body
      .filter((m: any) => m.kind === AstKind.CLASS_TEMPLATE)
      .map((m: any) => m.name);
    console.log("    templates:", ct.join(", ").slice(0, 200));
  }
}
const first = process.argv[2] ? parseInt(process.argv[2]) : 25;
for (const d of diags.slice(0, first)) {
  console.log(`  L${d.span.line}: ${d.message}`);
}

// Check key templates captured with members
const qpiNs = translationUnit.declarations.find(
  (d) => d.kind === AstKind.NAMESPACE && (d as any).name === "QPI",
) as any;
const captured = new Map<string, number>();
for (const m of qpiNs?.body ?? []) {
  if (m.kind === AstKind.CLASS_TEMPLATE || m.kind === AstKind.STRUCT) {
    captured.set(m.name, m.members?.length ?? 0);
  }
}
for (const name of ["HashMap", "Array", "BitArray", "Collection", "QpiContextFunctionCall"]) {
  const n = captured.get(name);
  if (n !== undefined) console.log(`  captured ${name}: members=${n}`);
  else console.log(`  MISSING ${name}`);
}
