export const SYSPROC_IMPL: Record<string, number> = {
  __impl_initialize: 0,
  __impl_beginEpoch: 1,
  __impl_endEpoch: 2,
  __impl_beginTick: 3,
  __impl_endTick: 4,
  __impl_preReleaseShares: 5,
  __impl_preAcquireShares: 6,
  __impl_postReleaseShares: 7,
  __impl_postAcquireShares: 8,
  __impl_postIncomingTransfer: 9,
  __impl_setShareholderProposal: 10,
  __impl_setShareholderVotes: 11,
};

// The scaffold renames a lifecycle procedure to its __impl_* name, but its locals struct keeps the macro spelling
export const SYSPROC_LOCALS_PREFIX: Record<string, string> = {
  __impl_initialize: "INITIALIZE",
  __impl_beginEpoch: "BEGIN_EPOCH",
  __impl_endEpoch: "END_EPOCH",
  __impl_beginTick: "BEGIN_TICK",
  __impl_endTick: "END_TICK",
  __impl_preReleaseShares: "PRE_RELEASE_SHARES",
  __impl_preAcquireShares: "PRE_ACQUIRE_SHARES",
  __impl_postReleaseShares: "POST_RELEASE_SHARES",
  __impl_postAcquireShares: "POST_ACQUIRE_SHARES",
  __impl_postIncomingTransfer: "POST_INCOMING_TRANSFER",
  __impl_setShareholderProposal: "SET_SHAREHOLDER_PROPOSAL",
  __impl_setShareholderVotes: "SET_SHAREHOLDER_VOTES",
};

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
