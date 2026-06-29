// Ultra-minimal QPI stub — the parser needs type names and struct layouts.
// No array syntax [], no operators, no extern "C", no decltype.
// Everything non-essential is stripped to keep the parser happy.

export const QPI_STUB = `
typedef signed char sint8;
typedef unsigned char uint8;
typedef signed short sint16;
typedef unsigned short uint16;
typedef signed int sint32;
typedef unsigned int uint32;
typedef signed long long sint64;
typedef unsigned long long uint64;

struct uint128_t {
  unsigned long long lo;
  unsigned long long hi;
};
typedef uint128_t uint128;

struct m256i {
  unsigned long long u64_0;
  unsigned long long u64_1;
  unsigned long long u64_2;
  unsigned long long u64_3;
};
typedef m256i id;

struct bit {
  unsigned char v;
};

namespace QPI {

sint32 NULL_INDEX;

struct NoData {};

struct Asset {
  id issuer;
  uint64 assetName;
};
struct AssetOwnershipSelect { uint16 managingContractIndex; };
struct AssetPossessionSelect { uint16 managingContractIndex; };
struct DateAndTime { sint64 value; };
struct Entity { id entityId; sint64 incomingAmount; sint64 outgoingAmount; uint32 numberOfIncomingTransfers; uint32 numberOfOutgoingTransfers; };

template <typename T, unsigned int contractIndex>
struct ContractState {};

template <uint64 L>
struct BitArray {
  unsigned long long values;
};

template <typename T, uint64 L>
struct Array {
  T values;
};

template <typename T, uint64 L>
struct SlowAnySizeArray {
  T values;
};

template <typename KeyT>
struct HashFunction {};

template <typename KeyT, typename ValueT, uint64 L, typename HashFunc>
class HashMap {};

template <typename T, uint64 L>
struct Collection {};

template <typename T, uint64 L>
class LinkedList {};

} // namespace QPI

struct ContractBase {};

// ---- Macros ----
#define INITIALIZE() \\
  static void __impl_initialize()

#define BEGIN_EPOCH() \\
  static void __impl_beginEpoch()

#define END_EPOCH() \\
  static void __impl_endEpoch()

#define BEGIN_TICK() \\
  static void __impl_beginTick()

#define END_TICK() \\
  static void __impl_endTick()

#define PUBLIC_FUNCTION(f) \\
  static void f(const QPI::QpiContextFunctionCall& qpi, QPI::ContractState<CONTRACT_STATE_TYPE::StateData, CONTRACT_INDEX>& state, f##_input& input, f##_output& output, f##_locals& locals)

#define PUBLIC_PROCEDURE(p) \\
  static void p(const QPI::QpiContextProcedureCall& qpi, QPI::ContractState<CONTRACT_STATE_TYPE::StateData, CONTRACT_INDEX>& state, p##_input& input, p##_output& output, p##_locals& locals)

#define PUBLIC_FUNCTION_WITH_LOCALS(f) PUBLIC_FUNCTION(f)
#define PUBLIC_PROCEDURE_WITH_LOCALS(p) PUBLIC_PROCEDURE(p)

#define REGISTER_USER_FUNCTIONS_AND_PROCEDURES() \\
  static void __registerUserFunctionsAndProcedures(const QPI::QpiContextForInit& qpi)

#define REGISTER_USER_FUNCTION(userFunction, inputType) \\
  qpi.__registerUserFunction((void*)userFunction, inputType, sizeof(userFunction##_input), sizeof(userFunction##_output), sizeof(userFunction##_locals))

#define REGISTER_USER_PROCEDURE(userProcedure, inputType) \\
  qpi.__registerUserProcedure((void*)userProcedure, inputType, sizeof(userProcedure##_input), sizeof(userProcedure##_output), sizeof(userProcedure##_locals))

#define LOG_INFO(msg)
#define LOG_ERROR(msg)
#define LOG_WARN(msg)
#define CALL_OTHER_CONTRACT_FUNCTION(calleeType, function, input, output)
#define INVOKE_OTHER_CONTRACT_PROCEDURE(calleeType, procedure, input, output, reward)
#define CALL_OTHER_CONTRACT_FUNCTION_E(calleeType, function, input, output, errorVar)
#define INVOKE_OTHER_CONTRACT_PROCEDURE_E(calleeType, procedure, input, output, reward, errorVar)
#define SELF qpi.invocator()
#define SELF_INDEX (-1)

using namespace QPI;
`;
