// Dump the parsed AST of a QPI contract as an indented tree.
//   bun packages/compile/tools/ast-dump.ts <contract.h> [outFile]
// Core headers resolve from QINIT_CORE (default /home/kali/Projects/core-lite).

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseToAst, formatAst, loadQpiHeader } from "../src/index";

const CORE = process.env.QINIT_CORE ?? "/home/kali/Projects/core-lite";

const input = process.argv[2];
if (!input) {
  console.error("usage: bun tools/ast-dump.ts <contract.h> [outFile]");
  process.exit(1);
}

const source = readFileSync(input, "utf8");
const name = basename(input).replace(/\.[^.]+$/, "");

const { ast, diagnostics } = parseToAst({ source, qpiHeader: loadQpiHeader(CORE), name });
const tree = formatAst(ast);

const outFile = process.argv[3] ?? input.replace(/\.[^.]+$/, "") + ".ast.txt";
writeFileSync(outFile, `${tree}\n`);

console.log(tree);

if (diagnostics.length) {
  console.error(`\n${diagnostics.length} diagnostic(s):`);
  for (const d of diagnostics) {
    console.error(`  ${d.severity} @${d.span.line}: ${d.message}`);
  }
}

console.error(`\nwrote ${outFile}`);
