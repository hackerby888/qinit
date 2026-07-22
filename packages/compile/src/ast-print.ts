// Render a parsed TranslationUnit as an indented connector tree for inspection/debugging.
import type { TranslationUnit } from "./ast";

const HEAD_KEYS = ["name", "member", "op", "value", "text"];

export function formatAst(translationUnit: TranslationUnit): string {
  const lines: string[] = ["TranslationUnit"];
  const declarations = translationUnit.declarations ?? [];

  declarations.forEach((declaration, declarationIndex) => {
    renderNode("", declaration, "", declarationIndex === declarations.length - 1, lines);
  });

  return lines.join("\n");
}

function renderNode(
  label: string,
  value: unknown,
  prefix: string,
  isLast: boolean,
  lines: string[],
): void {
  const branch = isLast ? "└─ " : "├─ ";
  const childPrefix = prefix + (isLast ? "   " : "│  ");

  if (Array.isArray(value)) {
    lines.push(`${prefix}${branch}${label} [${value.length}]`);
    value.forEach((element, valueItemIndex) => {
      renderNode("", element, childPrefix, valueItemIndex === value.length - 1, lines);
    });
    return;
  }

  if (value !== null && typeof value === "object") {
    const node = value as Record<string, unknown>;
    const head = headText(node);
    lines.push(`${prefix}${branch}${label ? `${label}: ${head}` : head}`);

    const children = childrenOf(node);
    children.forEach((child, childIndex) => {
      renderNode(child.label, child.value, childPrefix, childIndex === children.length - 1, lines);
    });
    return;
  }

  const leaf = label ? `${label}: ${JSON.stringify(value)}` : JSON.stringify(value);
  lines.push(`${prefix}${branch}${leaf}`);
}

function headText(node: Record<string, unknown>): string {
  const kind = typeof node.kind === "string" ? node.kind : "node";
  const parts: string[] = [];

  for (const headKey of HEAD_KEYS) {
    const nodeItem = node[headKey];
    if (nodeItem === undefined || nodeItem === null || typeof nodeItem === "object") {
      continue;
    }
    parts.push(
      typeof nodeItem === "string" ? `${headKey}="${nodeItem}"` : `${headKey}=${nodeItem}`,
    );
  }

  return parts.length ? `${kind}  ${parts.join(" ")}` : kind;
}

function childrenOf(node: Record<string, unknown>): Array<{ label: string; value: unknown }> {
  const children: Array<{ label: string; value: unknown }> = [];

  for (const [key, value] of Object.entries(node)) {
    if (key === "span" || key === "kind") {
      continue;
    }
    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value !== "object") {
      if (!HEAD_KEYS.includes(key)) {
        children.push({ label: key, value });
      }
      continue;
    }

    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    children.push({ label: key, value });
  }

  return children;
}
