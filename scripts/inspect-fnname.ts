import { parseToAst } from '../packages/compile/src/compiler/parse-ast';
import type { FunctionDecl, NamespaceDecl } from '../packages/compile/src/ast';
import { readFileSync } from 'fs';
import { resolve } from 'node:path';

const core = process.env.CORE_PATH || process.env.QINIT_CORE || resolve(import.meta.dir, "..", "..", "core-lite");
const source = readFileSync(`${core}/src/contracts/qpi.h`, 'utf8');
const r = parseToAst({source, qpiHeader: undefined, name:'T', slot:0});
const qpiNs = r.ast.declarations.find((d): d is NamespaceDecl => d.kind === 'namespace' && d.name === 'QPI');
console.log('has qpi', !!qpiNs, 'items', (qpiNs?.body||[]).length);
const proposalNs = (qpiNs?.body || []).find((d): d is NamespaceDecl => d.kind === 'namespace' && d.name === 'ProposalTypes');
console.log('proposalNs', !!proposalNs, 'body', proposalNs?.body?.length);
if (proposalNs) {
  const fns = proposalNs.body.filter((d): d is FunctionDecl => d.kind === 'function');
  console.log('fn names', fns.map((f) => f.name));
}
