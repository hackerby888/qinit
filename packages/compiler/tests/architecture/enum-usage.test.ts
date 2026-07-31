import { describe, expect, test } from "bun:test";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const CONFIG_PATH = fileURLToPath(
  new URL("../../tsconfig.json", import.meta.url),
);
const SOURCE_ROOT = fileURLToPath(new URL("../../src/", import.meta.url));

function createCompilerProgram(): ts.Program {
  const configFile = ts.readConfigFile(CONFIG_PATH, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
    );
  }

  const config = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    resolve(CONFIG_PATH, ".."),
  );
  return ts.createProgram(config.fileNames, config.options);
}

function sourceLocation(source: ts.SourceFile, node: ts.Node): string {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  const path = relative(SOURCE_ROOT, source.fileName).split(sep).join("/");
  return `${path}:${position.line + 1}:${position.character + 1}`;
}

function containsNode(parent: ts.Node, child: ts.Node): boolean {
  return parent.pos <= child.pos && parent.end >= child.end;
}

function isPropertyKeyLiteral(node: ts.LiteralTypeNode): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isImportTypeNode(current)) {
      return true;
    }

    if (
      ts.isIndexedAccessTypeNode(current) &&
      containsNode(current.indexType, node)
    ) {
      return true;
    }

    if (ts.isTypeReferenceNode(current)) {
      const name = current.typeName.getText();
      const argumentIndex = current.typeArguments?.findIndex((argument) => {
        return containsNode(argument, node);
      });
      return (
        ((name === "Pick" || name === "Omit") && argumentIndex === 1) ||
        (name === "Record" && argumentIndex === 0)
      );
    }
  }

  return false;
}

function isEnumType(type: ts.Type): boolean {
  if ((type.flags & (ts.TypeFlags.Enum | ts.TypeFlags.EnumLiteral)) !== 0) {
    return true;
  }
  return type.isUnion() && type.types.some(isEnumType);
}

function isEqualityOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
  );
}

describe("compiler enum usage", () => {
  test("keeps finite domains and comparisons enum-backed", () => {
    const program = createCompilerProgram();
    const checker = program.getTypeChecker();
    const violations: string[] = [];

    for (const source of program.getSourceFiles()) {
      if (
        source.isDeclarationFile ||
        !source.fileName.startsWith(SOURCE_ROOT)
      ) {
        continue;
      }

      const addViolation = (node: ts.Node, reason: string): void => {
        violations.push(`${sourceLocation(source, node)} ${reason}`);
      };

      const visit = (node: ts.Node): void => {
        if (
          ts.isLiteralTypeNode(node) &&
          ts.isStringLiteral(node.literal) &&
          !isPropertyKeyLiteral(node)
        ) {
          addViolation(node, `uses raw string type ${node.getText(source)}`);
        }

        if (
          ts.isBinaryExpression(node) &&
          isEqualityOperator(node.operatorToken.kind)
        ) {
          const stringOperand = ts.isStringLiteral(node.left)
            ? node.left
            : ts.isStringLiteral(node.right)
              ? node.right
              : undefined;
          const enumOperand = stringOperand === node.left
            ? node.right
            : node.left;

          if (
            stringOperand &&
            isEnumType(checker.getTypeAtLocation(enumOperand))
          ) {
            addViolation(
              stringOperand,
              `compares enum to ${stringOperand.getText(source)}`,
            );
          }
        }

        if (
          ts.isCaseClause(node) &&
          ts.isStringLiteral(node.expression) &&
          isEnumType(
            checker.getTypeAtLocation(node.parent.parent.expression),
          )
        ) {
          addViolation(
            node.expression,
            `switches on raw enum value ${node.expression.getText(source)}`,
          );
        }

        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "includes" &&
          node.arguments[0] &&
          isEnumType(checker.getTypeAtLocation(node.arguments[0])) &&
          ts.isArrayLiteralExpression(node.expression.expression)
        ) {
          for (const element of node.expression.expression.elements) {
            if (ts.isStringLiteral(element)) {
              addViolation(
                element,
                `searches enum with ${element.getText(source)}`,
              );
            }
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(source);
    }

    expect(violations).toEqual([]);
  });
});
