import { parseToAst } from '../packages/compile/src/compiler/parse-ast';
import { readFileSync } from 'fs';
import { resolve } from 'node:path';

const core = process.env.CORE_PATH || process.env.QINIT_CORE || resolve(import.meta.dir, "..", "..", "core-lite");
const headers = readFileSync(`${core}/src/contracts/qpi.h`, 'utf8');
const source = `using namespace QPI;\nuint16 test(uint16 x) { return ProposalTypes::cls(x); }`;
const r = parseToAst({source, qpiHeader: headers, name: 'T', slot: 0});
console.log('errors', r.diagnostics);
console.dir(r.ast, {depth:25});
