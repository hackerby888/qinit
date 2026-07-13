// Share-transfer / incoming-transfer hooks carry real input (and, for the pre-* pair, output) structs — unlike the lifecycle
export const SYSPROC_IO: Record<string, { in?: string; out?: string; typedIO?: boolean }> = {
  __impl_preReleaseShares: { in: "PreManagementRightsTransfer_input", out: "PreManagementRightsTransfer_output" },
  __impl_preAcquireShares: { in: "PreManagementRightsTransfer_input", out: "PreManagementRightsTransfer_output" },
  __impl_postReleaseShares: { in: "PostManagementRightsTransfer_input" },
  __impl_postAcquireShares: { in: "PostManagementRightsTransfer_input" },
  __impl_postIncomingTransfer: { in: "PostIncomingTransfer_input" },
  // The shareholder-governance hooks' io are typedefs to a container (Array<uint8,1024>) and scalars (uint16 / bit) rather than field
  __impl_setShareholderProposal: { in: "SET_SHAREHOLDER_PROPOSAL_input", out: "SET_SHAREHOLDER_PROPOSAL_output", typedIO: true },
  __impl_setShareholderVotes: { in: "SET_SHAREHOLDER_VOTES_input", out: "SET_SHAREHOLDER_VOTES_output", typedIO: true },
};

// Builtin scalar sizes
export const SCALAR_SIZE: Record<string, number> = {
  bool: 1, bit: 1,
  sint8: 1, uint8: 1, "signed char": 1, "unsigned char": 1,
  sint16: 2, uint16: 2, "signed short": 2, "unsigned short": 2,
  sint32: 4, uint32: 4, "signed int": 4, "unsigned int": 4,
  sint64: 8, uint64: 8, "signed long long": 8, "unsigned long long": 8, "long long": 8,
  uint128: 16,
  id: 32, m256i: 32, __m256i: 32,
  auto: 8,   // `auto` locals in qpi.h bodies are integer counters (pointer cases carry a trailing *)
};

// Plain C scalar spellings that SCALAR_SIZE doesn't key (they lower through other paths); listed so the unknown-type check
export const C_SCALAR_NAMES = new Set([
  "int", "unsigned", "signed", "long", "short", "char", "size_t", "unsigned long", "long int",
]);

// QPI safe-math names whose result type follows their arguments. Their bodies are compiled from the
// authoritative qpi.h/math_lib.h sources; this set is used only for type inference.
export const MATH_INTRINSIC_NAMES = new Set(["div", "sdiv", "mod", "min", "max", "abs", "sadd", "ssub", "smul"]);

// Platform free-function namespaces whose bodies must lower without fidelity diagnostics.
// Free helpers (QPI::div, math_lib::max, …); QPI context methods come from parsed core wrapper bodies.
export const AUTHORITATIVE_NAMESPACES = new Set(["QPI", "math_lib"]);

/** True when a qualified symbol lives under an authoritative platform namespace (QPI::div, math_lib::max). */
export function isAuthoritativeSymbol(qualifiedName: string): boolean {
  const sep = qualifiedName.indexOf("::");
  if (sep <= 0) return false;
  return AUTHORITATIVE_NAMESPACES.has(qualifiedName.slice(0, sep));
}

/** Unqualified base of a possibly qualified call name (QPI::div → div). */
export function symbolBaseName(name: string): string {
  const sep = name.lastIndexOf("::");
  return sep >= 0 ? name.slice(sep + 2) : name;
}
