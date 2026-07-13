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
    value.forEach((el, valueItemIndex) => {
      renderNode("", el, childPrefix, valueItemIndex === value.length - 1, lines);
    });
    return;
  }

  if (value !== null && typeof value === "object") {
    const node = value as Record<string, unknown>;
    const head = headText(node);
    lines.push(`${prefix}${branch}${label ? `${label}: ${head}` : head}`);

    const kids = childrenOf(node);
    kids.forEach((kid, kidIndex) => {
      renderNode(kid.label, kid.value, childPrefix, kidIndex === kids.length - 1, lines);
    });
    return;
  }

  const leaf = label ? `${label}: ${JSON.stringify(value)}` : JSON.stringify(value);
  lines.push(`${prefix}${branch}${leaf}`);
}

function headText(node: Record<string, unknown>): string {
  const kind = typeof node.kind === "string" ? node.kind : "node";
  const parts: string[] = [];

  for (const HEAD_KEYSItem of HEAD_KEYS) {
    const nodeItem = node[HEAD_KEYSItem];
    if (nodeItem === undefined || nodeItem === null || typeof nodeItem === "object") continue;
    parts.push(typeof nodeItem === "string" ? `${HEAD_KEYSItem}="${nodeItem}"` : `${HEAD_KEYSItem}=${nodeItem}`);
  }

  return parts.length ? `${kind}  ${parts.join(" ")}` : kind;
}

function childrenOf(node: Record<string, unknown>): Array<{ label: string; value: unknown }> {
  const kids: Array<{ label: string; value: unknown }> = [];

  for (const [k, v] of Object.entries(node)) {
    if (k === "span" || k === "kind") continue;
    if (v === undefined || v === null) continue;

    if (typeof v !== "object") {
      if (!HEAD_KEYS.includes(k)) kids.push({ label: k, value: v });
      continue;
    }

    if (Array.isArray(v) && v.length === 0) continue;
    kids.push({ label: k, value: v });
  }

  return kids;
}
