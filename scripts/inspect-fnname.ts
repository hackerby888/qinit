import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FunctionDecl, NamespaceDecl } from "../packages/compile/src/ast";
import { parseToAst } from "../packages/compile/src/compiler/parse-ast";

const core =
  process.env.CORE_PATH ||
  process.env.QINIT_CORE ||
  resolve(import.meta.dir, "..", "..", "core-lite");
const source = readFileSync(`${core}/src/contracts/qpi.h`, "utf8");
const result = parseToAst({ source, qpiHeader: undefined, name: "T", slot: 0 });
const qpiNamespace = result.ast.declarations.find(
  (declaration): declaration is NamespaceDecl =>
    declaration.kind === "namespace" && declaration.name === "QPI",
);
console.log("has qpi", !!qpiNamespace, "items", (qpiNamespace?.body || []).length);
const proposalNamespace = (qpiNamespace?.body || []).find(
  (declaration): declaration is NamespaceDecl =>
    declaration.kind === "namespace" && declaration.name === "ProposalTypes",
);
console.log("proposalNs", !!proposalNamespace, "body", proposalNamespace?.body?.length);
if (proposalNamespace) {
  const functions = proposalNamespace.body.filter(
    (declaration): declaration is FunctionDecl => declaration.kind === "function",
  );
  console.log("fn names", functions.map((fn) => fn.name));
}
