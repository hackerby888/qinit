// Decode a contract LOG_* call. Qubic SCs cannot use strings (qpi forbids ""), so logs are NUMERIC STRUCTS.
// A log struct ends with a `sint8 _terminator`; the node logs offsetof(_terminator) bytes = every field BEFORE
// the terminator, WITH internal alignment padding but WITHOUT the struct's tail padding. So the match size is
// the end of the last real field (structFieldOffsets), NOT layoutOf().size (which adds tail pad). We size-match
// the logged byte count against the contract's log-struct catalog; a unique hit decodes via decodeOutput.
import { decodeOutput, structFieldOffsets } from "./abi-fmt";
import { LOG_SEVERITY as SEVERITY } from "./protocol";

export interface LogCatalogEntry { name: string; fmt: string; fields: string[] } // fmt = comma-joined types; fields = names
export interface DecodedLog { severity: string; type: number; size: number; name?: string; typeName?: string; fields?: Record<string, unknown>; hex: string }

// offsetof(_terminator): end of the last field — internal padding included, tail padding excluded.
export function loggedSizeOf(fmt: string): number {
  const fo = structFieldOffsets(fmt);
  if (!fo.length) return 0;
  const last = fo[fo.length - 1];
  return last.off + last.size;
}

function hexToBytes(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Match a log's full byte size (NOT the possibly-capped hex) against the catalog; a unique struct decodes.
// `enums` (value -> member name) resolves the `_type` discriminator field to its enum name (DecodedLog.typeName).
export async function decodeLog(type: number, size: number, hex: string, catalog: LogCatalogEntry[], enums?: Record<string, string>): Promise<DecodedLog> {
  const severity = SEVERITY[type] ?? `type${type}`;
  const base: DecodedLog = { severity, type, size, hex: "0x" + (hex.startsWith("0x") ? hex.slice(2) : hex) };
  const hit = catalog.filter((s) => { try { return loggedSizeOf(s.fmt) === size; } catch { return false; } });
  if (hit.length === 1) {
    try {
      const decoded = await decodeOutput(hexToBytes(hex), hit[0].fmt);
      const vals = Array.isArray(decoded) ? decoded : [decoded];
      const fields: Record<string, unknown> = {};
      hit[0].fields.forEach((n, i) => { fields[n] = vals[i]; });
      const tv = fields["_type"];
      const typeName = enums && (typeof tv === "number" || typeof tv === "bigint") ? enums[String(tv)] : undefined;
      return { ...base, name: hit[0].name, ...(typeName ? { typeName } : {}), fields };
    } catch {}
  }
  return base;   // 0 or >1 size matches, or decode threw -> hex + severity only
}
