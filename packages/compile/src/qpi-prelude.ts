// Prelude injected before the real core-lite headers when parsing qpi.h.
export const QPI_PRELUDE = `
namespace std {
  template<typename T> struct is_same { static constexpr bool value = false; };
  template<typename T> struct is_integral { static constexpr bool value = false; };
  template<typename T> struct is_signed { static constexpr bool value = false; };
  template<typename T> struct is_unsigned { static constexpr bool value = false; };
  template<typename T> struct is_pointer { static constexpr bool value = false; };
  template<typename T> struct is_void { static constexpr bool value = false; };
  template<typename T> struct is_floating_point { static constexpr bool value = false; };
  template<typename T> struct remove_reference { typedef T type; };
  template<typename T> struct remove_cv { typedef T type; };
  template<typename T> struct decay { typedef T type; };
  template<bool B, typename T> struct enable_if {};
  template<bool B, typename T, typename F> struct conditional { typedef T type; };
}
typedef unsigned long size_t;
typedef signed long ptrdiff_t;
typedef unsigned long long uint64_t;
typedef unsigned int uint32_t;
typedef unsigned short uint16_t;
typedef unsigned char uint8_t;
typedef signed long long int64_t;
typedef signed int int32_t;
typedef signed short int16_t;
typedef signed char int8_t;

// Define protocol amounts and integer limits omitted from parsed headers.
#define MAX_NUMBER_OF_CONTRACTS 1024
#define ISSUANCE_RATE 1000000000000LL
#define MAX_AMOUNT (ISSUANCE_RATE * 1000LL)
#define MAX_SUPPLY (ISSUANCE_RATE * 200ULL)
#define INT64_MAX 9223372036854775807LL
#define INT64_MIN (-9223372036854775807LL - 1)
#define UINT64_MAX 18446744073709551615ULL
#define INT32_MAX 2147483647
#define INT32_MIN (-2147483647 - 1)
#define UINT32_MAX 4294967295U
#define INT16_MAX 32767
#define UINT16_MAX 65535
#define INT8_MAX 127
#define UINT8_MAX 255

// Oracle query/reply size limits (network_messages/common_def.h: MAX_INPUT_SIZE(1024) - 16), referenced by the oracle interface headers.
#define MAX_ORACLE_QUERY_SIZE 1008
#define MAX_ORACLE_REPLY_SIZE 1008

// Oracle query statuses from network_messages/common_def.h.
constexpr uint8_t ORACLE_QUERY_STATUS_UNKNOWN = 0;
constexpr uint8_t ORACLE_QUERY_STATUS_PENDING = 1;
constexpr uint8_t ORACLE_QUERY_STATUS_COMMITTED = 2;
constexpr uint8_t ORACLE_QUERY_STATUS_SUCCESS = 3;
constexpr uint8_t ORACLE_QUERY_STATUS_TIMEOUT = 4;
constexpr uint8_t ORACLE_QUERY_STATUS_UNRESOLVABLE = 5;
`;

// Defines fed to the preprocessor when parsing the real qpi.h (the lite wasm build profile).
export const QPI_DEFINES: Record<string, string> = {
  NO_UEFI: "",
  LITE_WASM_TU_BUILD: "",
  __CHAR_BIT__: "8",
};
