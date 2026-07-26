#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <upstream-source-dir> <output-path>" >&2
}

fail() {
  echo "error: $*" >&2
  exit 1
}

require_file() {
  [[ -f "$1" ]] || fail "missing file: $1"
}

audit_binary() {
  local binary="$1"
  local architectures
  local architecture_count
  local build_versions
  local deployment_target_count
  local dependencies
  local non_system_dependencies

  architectures="$(xcrun lipo -archs "$binary")"
  architecture_count="$(printf "%s\n" "$architectures" | awk "{ print NF }")"
  xcrun lipo "$binary" -verify_arch arm64 x86_64
  [[ "$architecture_count" -eq 2 ]] ||
    fail "expected only arm64 and x86_64 slices, got: $architectures"

  build_versions="$(xcrun vtool -show-build "$binary")"
  deployment_target_count="$(
    printf "%s\n" "$build_versions" |
      awk '$1 == "minos" && $2 == "11.0" { count++ } END { print count + 0 }'
  )"
  [[ "$deployment_target_count" -eq 2 ]] ||
    fail "expected macOS 11.0 deployment target in both slices"

  dependencies="$(xcrun otool -L "$binary")"
  non_system_dependencies="$(
    printf "%s\n" "$dependencies" |
      awk '
        /^[[:space:]]/ {
          if ($1 !~ "^/usr/lib/" && $1 !~ "^/System/Library/") {
            print $1
          }
        }
      '
  )"
  if [[ -n "$non_system_dependencies" ]]; then
    printf "Non-system dynamic dependencies:\n%s\n" "$non_system_dependencies" >&2
    exit 1
  fi

  /usr/bin/codesign --verify --strict --verbose=2 "$binary"
  echo "Universal binary: $architectures"
  echo "$build_versions"
  echo "$dependencies"
}

run_smoke_tests() {
  local source_dir="$1"
  local binary="$2"
  local valid_fixture="$source_dir/test/testfiles/test_ok.h"
  local invalid_fixture="$source_dir/test/testfiles/test_fail_div.h"
  local oracle_fixture="$source_dir/test/testfiles/oracle_interfaces/test_ok_Mock.h"
  local invalid_oracle_fixture="$source_dir/test/testfiles/oracle_interfaces/test_fail_forbidden_locals_type.h"
  local invalid_oracle_output
  local invalid_oracle_status
  local invalid_status

  require_file "$valid_fixture"
  require_file "$invalid_fixture"
  require_file "$oracle_fixture"
  require_file "$invalid_oracle_fixture"

  /usr/bin/arch -x86_64 "$binary" "$valid_fixture"

  if /usr/bin/arch -x86_64 "$binary" "$invalid_fixture"; then
    fail "invalid contract was accepted: $invalid_fixture"
  else
    invalid_status=$?
  fi
  [[ "$invalid_status" -eq 1 ]] ||
    fail "invalid contract exited with status $invalid_status instead of 1"

  /usr/bin/arch -x86_64 "$binary" --oi "$oracle_fixture"

  if invalid_oracle_output="$(
    /usr/bin/arch -x86_64 "$binary" --oi "$invalid_oracle_fixture" 2>&1
  )"; then
    fail "invalid oracle interface was accepted: $invalid_oracle_fixture"
  else
    invalid_oracle_status=$?
  fi
  printf "%s\n" "$invalid_oracle_output"
  [[ "$invalid_oracle_status" -eq 1 ]] ||
    fail "invalid oracle interface exited with status $invalid_oracle_status instead of 1"
  grep -Fq "Found local variable of forbidden type with name forbidden." \
    <<< "$invalid_oracle_output" ||
    fail "invalid oracle interface did not report the forbidden local"
  grep -Fq "Oracle interface compliance check FAILED" \
    <<< "$invalid_oracle_output" ||
    fail "invalid oracle interface did not report failed compliance"

  echo "x86_64 verifier smoke tests passed"
}

if [[ "$#" -ne 2 ]]; then
  usage
  exit 2
fi

[[ -d "$1" ]] || fail "upstream source directory not found: $1"
source_dir="$(cd "$1" && pwd -P)"
require_file "$source_dir/CMakeLists.txt"

[[ -f "$2" ]] || fail "verifier binary not found: $2"
binary_parent="$(cd "$(dirname "$2")" && pwd -P)"
binary_path="$binary_parent/$(basename "$2")"
[[ -x "$binary_path" ]] || fail "verifier binary is not executable: $binary_path"

audit_binary "$binary_path"
run_smoke_tests "$source_dir" "$binary_path"
