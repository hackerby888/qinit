// Render a parsed TranslationUnit as an indented connector tree for inspection/debugging.
// Spans and the `kind` tag are elided from each line; short scalar fields (name/op/member/value)
// are folded into the node's own line, and object/array fields recurse as child branches.

import type { TranslationUnit } from "./ast";

const HEAD_KEYS = ["name", "member", "op", "value", "text"];

export function formatAst(tu: TranslationUnit): string {
  const lines: string[] = ["TranslationUnit"];
  const decls = tu.declarations ?? [];

  decls.forEach((decl, i) => {
    renderNode("", decl, "", i === decls.length - 1, lines);
  });

  return lines.join("\n");
}

function renderNode(label: string, value: unknown, prefix: string, isLast: boolean, lines: string[]): void {
  const branch = isLast ? "└─ " : "├─ ";
  const childPrefix = prefix + (isLast ? "   " : "│  ");

  if (Array.isArray(value)) {
    lines.push(`${prefix}${branch}${label} [${value.length}]`);
    value.forEach((el, i) => {
      renderNode("", el, childPrefix, i === value.length - 1, lines);
    });
    return;
  }

  if (value !== null && typeof value === "object") {
    const node = value as Record<string, unknown>;
    const head = headText(node);
    lines.push(`${prefix}${branch}${label ? `${label}: ${head}` : head}`);

    const kids = childrenOf(node);
    kids.forEach((c, i) => {
      renderNode(c.label, c.value, childPrefix, i === kids.length - 1, lines);
    });
    return;
  }

  const leaf = label ? `${label}: ${JSON.stringify(value)}` : JSON.stringify(value);
  lines.push(`${prefix}${branch}${leaf}`);
}

function headText(node: Record<string, unknown>): string {
  const kind = typeof node.kind === "string" ? node.kind : "node";
  const parts: string[] = [];

  for (const k of HEAD_KEYS) {
    const v = node[k];
    if (v === undefined || v === null || typeof v === "object") continue;
    parts.push(typeof v === "string" ? `${k}="${v}"` : `${k}=${v}`);
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
