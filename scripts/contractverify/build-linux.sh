#!/usr/bin/env bash
set -euo pipefail

readonly ALPINE_X64_IMAGE="docker.io/library/alpine@sha256:7c8cb692ae09657cbc4a3f3cbd0e8d5a2690ba38386aaaf252dbb060bf5eb2e6"
readonly ALPINE_ARM64_IMAGE="docker.io/library/alpine@sha256:2c9d26f410d032d5b1525aa8a873e238b05b90c4ae8618743d4311f0cc827e37"

usage() {
  echo "Usage: $0 <upstream-source-dir> <output-path> <x64|arm64>" >&2
}

die() {
  echo "error: $*" >&2
  exit 1
}

if [[ $# -ne 3 ]]; then
  usage
  exit 2
fi

source_arg=$1
output_arg=$2
target_arch=$3

[[ -d "$source_arg" ]] || die "upstream source directory not found: $source_arg"
[[ -n "$output_arg" ]] || die "output path must not be empty"

source_dir=$(cd -- "$source_arg" && pwd -P)

required_sources=(
  "CMakeLists.txt"
  "src/CMakeLists.txt"
  "deps/CppParser/CMakeLists.txt"
  "deps/CppParser/cppparser/CMakeLists.txt"
  "deps/CppParser/cppparser/src/parser.y"
  "test/testfiles/test_ok.h"
  "test/testfiles/test_fail_type_float.h"
  "test/testfiles/oracle_interfaces/test_ok_Mock.h"
  "test/testfiles/oracle_interfaces/test_fail_forbidden_locals_type.h"
)

for required_source in "${required_sources[@]}"; do
  [[ -f "$source_dir/$required_source" ]] ||
    die "incomplete upstream source or CppParser submodule: $required_source"
done

case "$target_arch" in
  x64)
    image=$ALPINE_X64_IMAGE
    docker_platform="linux/amd64"
    cpu_flags="-march=x86-64 -mtune=generic"
    expected_host_arch="x86_64"
    expected_elf_machine="Advanced Micro Devices X86-64"
    run_ctest=ON
    ;;
  arm64)
    image=$ALPINE_ARM64_IMAGE
    docker_platform="linux/arm64"
    cpu_flags="-march=armv8-a -mtune=generic"
    expected_host_arch="aarch64"
    expected_elf_machine="AArch64"
    run_ctest=OFF
    ;;
  *)
    usage
    die "unsupported architecture: $target_arch"
    ;;
esac

host_arch=$(uname -m)
[[ "$host_arch" == "$expected_host_arch" ]] ||
  die "$target_arch must be built natively on $expected_host_arch, not $host_arch"

for command_name in docker file readelf; do
  command -v "$command_name" >/dev/null ||
    die "required host command not found: $command_name"
done

output_parent_arg=$(dirname -- "$output_arg")
output_name=$(basename -- "$output_arg")
mkdir -p -- "$output_parent_arg"
output_parent=$(cd -- "$output_parent_arg" && pwd -P)
output_path="$output_parent/$output_name"

[[ ! -d "$output_path" ]] || die "output path is a directory: $output_path"

staging_dir=$(mktemp -d "$output_parent/.contractverify-linux.XXXXXX")
candidate="$staging_dir/contractverify"

cleanup() {
  rm -f -- "$candidate" 2>/dev/null || true
  rmdir -- "$staging_dir" 2>/dev/null || true
}
trap cleanup EXIT

docker run --rm \
  --platform "$docker_platform" \
  --mount "type=bind,src=$source_dir,dst=/source,readonly" \
  --mount "type=bind,src=$staging_dir,dst=/out" \
  --env "CPU_FLAGS=$cpu_flags" \
  --env "HOST_UID=$(id -u)" \
  --env "HOST_GID=$(id -g)" \
  --env "RUN_CTEST=$run_ctest" \
  "$image" \
  /bin/sh -euxc '
    apk add --no-cache \
      build-base \
      clang-extra-tools \
      cmake \
      flex \
      git \
      ninja

    command -v clang-tidy

    mkdir -p /work/source
    cp -a /source/. /work/source/

    cmake \
      -S /work/source/deps/CppParser \
      -B /work/cppparser-build \
      -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      "-DCMAKE_C_FLAGS_RELEASE=-O2 -DNDEBUG ${CPU_FLAGS}" \
      "-DCMAKE_CXX_FLAGS_RELEASE=-O2 -DNDEBUG ${CPU_FLAGS}" \
      -DCPPPARSER_BUILD_TESTS=OFF \
      -DFLEX=/usr/bin/flex
    cmake --build /work/cppparser-build --parallel

    cmake \
      -S /work/source \
      -B /work/contractverify-build \
      -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      "-DBUILD_CONTRACTVERIFY_TESTS=${RUN_CTEST}" \
      -DBUILD_SHARED_LIBS=OFF \
      "-DCMAKE_CXX_FLAGS_RELEASE=-O2 -DNDEBUG ${CPU_FLAGS}" \
      -DCMAKE_EXE_LINKER_FLAGS=-static \
      -Dcppparser_DIR=/work/cppparser-build \
      -DCMAKE_PREFIX_PATH=/work/cppparser-build
    cmake --build /work/contractverify-build --parallel
    if [ "${RUN_CTEST}" = "ON" ]; then
      ctest \
        --test-dir /work/contractverify-build \
        --output-on-failure \
        --no-tests=error
    fi

    install -m 0755 /work/contractverify-build/src/contractverify /out/contractverify
    strip --strip-all /out/contractverify
    chown "${HOST_UID}:${HOST_GID}" /out/contractverify
  '

[[ -x "$candidate" ]] || die "builder did not produce an executable"

file_description=$(file -b "$candidate")
[[ "$file_description" == ELF\ 64-bit* ]] ||
  die "output is not a 64-bit ELF: $file_description"
[[ "$file_description" == *"statically linked"* ]] ||
  die "output is not statically linked: $file_description"

elf_machine=$(
  readelf -h "$candidate" |
    sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p'
)
[[ "$elf_machine" == "$expected_elf_machine" ]] ||
  die "wrong ELF machine: expected $expected_elf_machine, got $elf_machine"

program_headers=$(readelf -l "$candidate")
if grep -q "INTERP" <<<"$program_headers"; then
  die "static ELF unexpectedly contains a program interpreter"
fi

dynamic_section=$(readelf -d "$candidate" 2>&1)
if grep -q "NEEDED" <<<"$dynamic_section"; then
  die "static ELF unexpectedly contains a shared-library dependency"
fi

pass_output=$(
  "$candidate" "$source_dir/test/testfiles/test_ok.h" 2>&1
)
grep -Fq "Contract compliance check PASSED" <<<"$pass_output" ||
  die "valid-contract smoke did not pass"

if fail_output=$(
  "$candidate" "$source_dir/test/testfiles/test_fail_type_float.h" 2>&1
); then
  die "invalid-contract smoke unexpectedly passed"
else
  fail_status=$?
fi

[[ "$fail_status" -eq 1 ]] ||
  die "invalid-contract smoke returned $fail_status instead of 1"
grep -Fq "Type float is not allowed." <<<"$fail_output" ||
  die "invalid-contract smoke returned the wrong diagnostic"
grep -Fq "Contract compliance check FAILED" <<<"$fail_output" ||
  die "invalid-contract smoke did not report failure"

oracle_output=$(
  "$candidate" \
    --oi \
    "$source_dir/test/testfiles/oracle_interfaces/test_ok_Mock.h" \
    2>&1
)
grep -Fq "Oracle interface compliance check PASSED" <<<"$oracle_output" ||
  die "oracle-interface smoke did not pass"

if oracle_fail_output=$(
  "$candidate" \
    --oi \
    "$source_dir/test/testfiles/oracle_interfaces/test_fail_forbidden_locals_type.h" \
    2>&1
); then
  die "invalid oracle interface unexpectedly passed"
else
  oracle_fail_status=$?
fi

[[ "$oracle_fail_status" -eq 1 ]] ||
  die "invalid oracle-interface smoke returned $oracle_fail_status instead of 1"
grep -Fq "Found local variable of forbidden type with name forbidden." <<<"$oracle_fail_output" ||
  die "invalid oracle-interface smoke returned the wrong diagnostic"
grep -Fq "Oracle interface compliance check FAILED" <<<"$oracle_fail_output" ||
  die "invalid oracle-interface smoke did not report failure"

mv -f -- "$candidate" "$output_path"
chmod 0755 "$output_path"
file "$output_path"
