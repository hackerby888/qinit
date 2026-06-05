#!/bin/bash
# Assemble the compileWasm header bundle: the curated transitive header set a contract needs
# (libstdc++ + clang-resource + glibc), captured via `clang -M`, copied preserving host abs paths so the
# in-memory WASI FS can serve them. Writes $OUT/{llvm.wasm, bundle/, bundle.json}. See ../../packages/build/src/wasm-toolchain.ts.
#
#   CORE=<core checkout> WRAP=<a .wrapper.cpp> bash make-bundle.sh
# (WRAP = what `qinit build` emits at dist/contracts/<Name>.wrapper.cpp.)
set -euo pipefail
TC=${TC:-$HOME/wasm-toolchain}
OUT=${OUT:-$HOME/.cache/qinit/wasm-clang}
WT=$(echo "$TC"/wasmtime-*-x86_64-linux/wasmtime); LLVM="$TC/build/bin/llvm"
GV=${GV:-15}; GXX1=/usr/include/c++/$GV; GXX2=/usr/include/x86_64-linux-gnu/c++/$GV
CR=$(echo "$TC"/wasi-sdk-29/lib/clang/*/include)
: "${CORE:?set CORE=<core checkout>}"; : "${WRAP:?set WRAP=<a contract .wrapper.cpp>}"

# 1) capture the transitive headers. -O2 matches compileWasm (catches optimization-conditional glibc bits);
#    libstdc++ (not libc++) so the .so's std:: symbols match the linux node's libstdc++.so.6. Absolute -o/-MF
#    (wasmtime denies relative writes). Then add the bits/ + ext/ dirs wholesale (conditional includes).
"$WT" --dir / "$LLVM" clang --target=x86_64-unknown-linux-gnu -std=c++20 -O2 -fPIC -fno-rtti -fno-exceptions \
  -DLITEDYN_CONTRACT_TU -mavx2 -nostdinc -nostdinc++ -isystem "$GXX1" -isystem "$GXX2" -isystem "$CR" \
  -isystem /usr/include -isystem /usr/include/x86_64-linux-gnu -I "$CORE" -I "$CORE/src" \
  -M -MF /tmp/.wb-deps -c "$WRAP" -o /tmp/.wb.o
tr ' \\' '\n\n' < /tmp/.wb-deps | grep '^/' | grep -vE "$CORE|\.cpp$" | sort -u > /tmp/.wb-hdrs
find /usr/include/bits /usr/include/x86_64-linux-gnu/bits "$GXX1/bits" "$GXX2/bits" "$GXX1/ext" -name '*.h' 2>/dev/null >> /tmp/.wb-hdrs
sort -u /tmp/.wb-hdrs -o /tmp/.wb-hdrs

# 2) copy preserving abs paths + manifest + wasm.
rm -rf "$OUT/bundle"; mkdir -p "$OUT/bundle"
xargs -a /tmp/.wb-hdrs -I{} cp --parents {} "$OUT/bundle/"
cp "$LLVM" "$OUT/llvm.wasm"
printf '{ "wasm":"llvm.wasm", "isystem":["%s","%s","%s","/usr/include","/usr/include/x86_64-linux-gnu"] }\n' "$GXX1" "$GXX2" "$CR" > "$OUT/bundle.json"
echo "bundle: $(find "$OUT/bundle" -type f | wc -l) files, $(du -sh "$OUT/bundle" | cut -f1) at $OUT"
# NOTE: bundle.json's clang-resource path is machine-specific; normalize for shipping (relocate under bundle/).
