#!/bin/bash
# Assemble a per-platform compileWasm header bundle: the curated transitive header set a contract needs for
# a given node platform, captured via `clang -M`, copied preserving host abs paths so the in-memory WASI FS
# can serve them. Writes $OUT/{llvm.wasm, bundle-<platform>/, bundle-<platform>.json}.
# Each bundle uses the STL the node links: linux = libstdc++ (matches libstdc++.so.6); darwin = libc++ (TODO).
#
#   PLATFORM=linux-arm64 CORE=<core checkout> WRAP=<a .wrapper.cpp> bash make-bundle.sh
# (WRAP = what `qinit build` emits at dist/contracts/<Name>.wrapper.cpp.)
set -euo pipefail
TC=${TC:-$HOME/wasm-toolchain}; OUT=${OUT:-$HOME/.cache/qinit/wasm-clang}
WT=$(echo "$TC"/wasmtime-*-x86_64-linux/wasmtime); LLVM="$TC/build/bin/llvm"
CR="$TC/build/usr/include"  # our clang.wasm's own resource headers (full arch set: arm_neon.h, immintrin.h, stdint.h…)
GV=${GV:-15}; PLATFORM=${PLATFORM:-linux-x64}
: "${CORE:?set CORE=<core checkout>}"; : "${WRAP:?set WRAP=<a contract .wrapper.cpp>}"

case "$PLATFORM" in
  linux-x64)   TRIPLE=x86_64-unknown-linux-gnu
    ISYS=(/usr/include/c++/$GV /usr/include/x86_64-linux-gnu/c++/$GV "$CR" /usr/include /usr/include/x86_64-linux-gnu)
    EXTRA=(-mavx2)
    BITS=(/usr/include/bits /usr/include/x86_64-linux-gnu/bits /usr/include/c++/$GV/bits /usr/include/x86_64-linux-gnu/c++/$GV/bits /usr/include/c++/$GV/ext) ;;
  linux-arm64) TRIPLE=aarch64-unknown-linux-gnu; A=/usr/aarch64-linux-gnu
    ISYS=($A/include/c++/$GV $A/include/c++/$GV/aarch64-linux-gnu "$CR" $A/include)
    EXTRA=()
    BITS=($A/include/bits $A/include/c++/$GV/bits $A/include/c++/$GV/ext) ;;
  *) echo "unknown PLATFORM=$PLATFORM (linux-x64|linux-arm64)"; exit 1 ;;
esac
ISYSFLAGS=(); for d in "${ISYS[@]}"; do ISYSFLAGS+=(-isystem "$d"); done

# 1) capture the transitive headers (-O2 to catch conditional includes; absolute -o/-MF — wasmtime denies relative).
"$WT" --dir / "$LLVM" clang --target=$TRIPLE -std=c++20 -O2 -fPIC -fno-rtti -fno-exceptions -DLITEDYN_CONTRACT_TU \
  "${EXTRA[@]}" -nostdinc -nostdinc++ "${ISYSFLAGS[@]}" -I "$CORE" -I "$CORE/src" -M -MF /tmp/.wb-deps -c "$WRAP" -o /tmp/.wb.o
tr ' \\' '\n\n' < /tmp/.wb-deps | grep '^/' | grep -vE "$CORE|\.cpp$" | sort -u > /tmp/.wb-hdrs
for d in "${BITS[@]}"; do [ -d "$d" ] && find "$d" -name '*.h' >> /tmp/.wb-hdrs; done
sort -u /tmp/.wb-hdrs -o /tmp/.wb-hdrs

# 2) copy preserving abs paths + per-platform manifest + the shared wasm.
rm -rf "$OUT/bundle-$PLATFORM"; mkdir -p "$OUT/bundle-$PLATFORM"
xargs -a /tmp/.wb-hdrs -I{} cp --parents {} "$OUT/bundle-$PLATFORM/"
cp "$LLVM" "$OUT/llvm.wasm"
printf '{ "wasm":"llvm.wasm", "isystem":[%s] }\n' "$(printf '"%s",' "${ISYS[@]}" | sed 's/,$//')" > "$OUT/bundle-$PLATFORM.json"
echo "bundle-$PLATFORM: $(find "$OUT/bundle-$PLATFORM" -type f | wc -l) files, $(du -sh "$OUT/bundle-$PLATFORM" | cut -f1)"
