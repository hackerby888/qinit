// Prelude injected before the real core-lite headers when parsing qpi.h.
// Provides minimal, PARSEABLE stubs for the std type-traits and platform symbols the headers
// reference. m256i / uint128 / id stay compiler builtins (sema BUILTIN_SIZES) — not defined here.
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

// Protocol amount constants (network_messages/common_def.h) + standard integer limits, referenced by
// contracts but defined in headers the compiler does not load.
#define ISSUANCE_RATE 1000000000000LL
#define MAX_AMOUNT (ISSUANCE_RATE * 1000LL)
#define MAX_SUPPLY (ISSUANCE_RATE * 200ULL)
#define INT64_MAX 9223372036854775807LL
#define INT64_MIN (-9223372036854775807LL - 1)
#define UINT64_MAX 18446744073709551615ULL
#define INT32_MAX 2147483647
#define UINT32_MAX 4294967295U
#define INT16_MAX 32767
#define UINT16_MAX 65535
#define INT8_MAX 127
#define UINT8_MAX 255
`;

// Defines fed to the preprocessor when parsing the real qpi.h (the lite wasm build profile).
export const QPI_DEFINES: Record<string, string> = {
  NO_UEFI: "",
  LITE_WASM_TU_BUILD: "",
  __CHAR_BIT__: "8",
};
