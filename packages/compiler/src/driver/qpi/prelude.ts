import { QPI_PROTOCOL_PRELUDE } from "../../generated/qpi-protocol-prelude";

// Stable language shims injected before the real core-lite headers when parsing qpi.h.
export const QPI_LANGUAGE_PRELUDE = `
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
`;

const REQUIRED_DEFINES = [
  "MAX_NUMBER_OF_CONTRACTS",
  "MAX_INPUT_SIZE",
  "ISSUANCE_RATE",
  "MAX_AMOUNT",
  "MAX_SUPPLY",
] as const;

const REQUIRED_CONSTANTS = [
  "MAX_ORACLE_QUERY_SIZE",
  "MAX_ORACLE_REPLY_SIZE",
  "ORACLE_QUERY_STATUS_UNKNOWN",
  "ORACLE_QUERY_STATUS_PENDING",
  "ORACLE_QUERY_STATUS_COMMITTED",
  "ORACLE_QUERY_STATUS_SUCCESS",
  "ORACLE_QUERY_STATUS_TIMEOUT",
  "ORACLE_QUERY_STATUS_UNRESOLVABLE",
  "OC_INVOCATION_STATUS_UNKNOWN",
  "OC_INVOCATION_STATUS_PENDING_AUTH",
  "OC_INVOCATION_STATUS_AUTHORIZED",
  "OC_INVOCATION_STATUS_TIMEOUT",
] as const;

function requiredLine(source: string, pattern: RegExp, name: string): string {
  const matches = source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => pattern.test(line));

  if (matches.length !== 1) {
    throw new Error(`core common_def.h must declare ${name} exactly once`);
  }

  return matches[0].replace(/\s*\/\/.*$/, "").trimEnd();
}

/** Core-owned declarations required by the compiler's flattened QPI snapshot. */
export function assembleQpiProtocolPrelude(commonDefinitions: string): string {
  const lines = ["// Protocol declarations copied from core-lite common_def.h."];

  for (const name of REQUIRED_DEFINES) {
    lines.push(
      requiredLine(
        commonDefinitions,
        new RegExp(`^\\s*#define\\s+${name}\\b`),
        name,
      ),
    );
  }

  for (const name of REQUIRED_CONSTANTS) {
    lines.push(
      requiredLine(
        commonDefinitions,
        new RegExp(`^\\s*constexpr\\s+[^;=]+\\s+${name}\\s*=`),
        name,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}

export const QPI_PRELUDE = `${QPI_LANGUAGE_PRELUDE}\n${QPI_PROTOCOL_PRELUDE}`;

// Defines fed to the preprocessor when parsing the real qpi.h (the lite wasm build profile).
export const QPI_DEFINES: Record<string, string> = {
  NO_UEFI: "",
  LITE_WASM_TU_BUILD: "",
  __CHAR_BIT__: "8",
};
