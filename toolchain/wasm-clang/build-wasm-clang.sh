#!/bin/bash
# Build the multi-target clang+lld "llvm" multitool as wasm32-wasip1, with X86;AArch64;WebAssembly
# backends so the wasm-hosted clang cross-emits native ELF/Mach-O contract objects.
# Recipe = YoWASP/clang build.sh (their proven wasi config) + our two extra backends. Their llvmorg-21.1.4+wasm
# source carries the wasi posix-stub patch set. We skip their compiler-rt/wasi-libc/libcxx steps — those build a
# *wasm* sysroot; we target *native* (the contract .so is freestanding, host-resolved — see WASM_TOOLCHAIN.md).
set -euo pipefail
TC="$HOME/wasm-toolchain"
export PATH="$HOME/.local/bin:$PATH"
WASI="$TC/wasi-sdk-29"
SRC="$TC/llvm-yowasp"

# --- toolchain file (verbatim from YoWASP build.sh: wasip1, lime1, mman-only, stack-first, LTO) ---
cat > "$TC/Toolchain-WASI-LLVM.cmake" <<END
set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
set(CMAKE_C_COMPILER ${WASI}/bin/clang)
set(CMAKE_C_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_CXX_COMPILER ${WASI}/bin/clang++)
set(CMAKE_CXX_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_LINKER ${WASI}/bin/wasm-ld)
set(CMAKE_AR ${WASI}/bin/ar)
set(CMAKE_RANLIB ${WASI}/bin/ranlib)
set(CMAKE_C_FLAGS "--sysroot ${WASI}/share/wasi-sysroot -mcpu=lime1 -D_WASI_EMULATED_MMAN -flto")
set(CMAKE_CXX_FLAGS "--sysroot ${WASI}/share/wasi-sysroot -mcpu=lime1 -D_WASI_EMULATED_MMAN -flto")
set(CMAKE_EXE_LINKER_FLAGS "--sysroot ${WASI}/share/wasi-sysroot -lwasi-emulated-mman -Wl,--max-memory=4294967296 -Wl,-z,stack-size=8388608,--stack-first -flto -Wl,--strip-all")
END

COMMON_OFF="-DLLVM_BUILD_RUNTIME=OFF -DLLVM_BUILD_TOOLS=OFF -DLLVM_INCLUDE_UTILS=OFF -DLLVM_INCLUDE_RUNTIMES=OFF -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_DOCS=OFF"

# --- 1) native tblgen (matches the 21.1.4 source; host compiler) ---
if ! [ -f "$TC/tblgen-build/bin/llvm-tblgen" -a -f "$TC/tblgen-build/bin/clang-tblgen" ]; then
  cmake -G Ninja -B "$TC/tblgen-build" -S "$SRC/llvm" \
    -DCMAKE_BUILD_TYPE=MinSizeRel $COMMON_OFF \
    -DLLVM_TARGETS_TO_BUILD=WebAssembly -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-wasip1 \
    -DLLVM_ENABLE_PROJECTS="clang" -DCLANG_BUILD_TOOLS=OFF -DCLANG_INCLUDE_TESTS=OFF
  ninja -C "$TC/tblgen-build" llvm-tblgen clang-tblgen
fi

# --- 2) the wasm clang+lld multitool, with X86;AArch64 added ---
# Reuse YoWASP's exact per-tool ON/OFF set — they disable ~90 tools (gsymutil, clang-check, clang-repl, …)
# that call wasi-stubbed Support symbols (e.g. PrintStackTraceOnErrorSignal); building extras breaks the link.
REF=/home/kali/Projects/Qinit/toolchain/wasm-clang/yowasp-build.sh.ref
TOOL_FLAGS=$(grep -oE '\-D(LLVM_TOOL_[A-Z0-9_]+_BUILD|CLANG_TOOL_[A-Z0-9_]+_BUILD|LLD_BUILD_TOOLS|CLANG_BUILD_TOOLS|CLANG_LINKS_TO_CREATE)=[^ ]+' "$REF" | sort -u | tr '\n' ' ')
cmake -G Ninja -B "$TC/build" -S "$SRC/llvm" \
  $TOOL_FLAGS \
  -DCMAKE_TOOLCHAIN_FILE="$TC/Toolchain-WASI-LLVM.cmake" \
  -DLLVM_NATIVE_TOOL_DIR="$TC/tblgen-build/bin" \
  -DCMAKE_BUILD_TYPE=MinSizeRel -DLLVM_ENABLE_ASSERTIONS=ON \
  -DLLVM_BUILD_SHARED_LIBS=OFF -DLLVM_ENABLE_PIC=OFF -DLLVM_BUILD_STATIC=ON -DLLVM_ENABLE_THREADS=OFF \
  $COMMON_OFF -DLLVM_BUILD_UTILS=OFF \
  -DLLVM_TARGETS_TO_BUILD="X86;AArch64;WebAssembly" \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-wasip1 \
  -DLLVM_TOOL_LLVM_DRIVER_BUILD=ON \
  -DLLVM_ENABLE_PROJECTS="clang;lld" \
  -DCLANG_ENABLE_ARCMT=OFF -DCLANG_ENABLE_STATIC_ANALYZER=OFF -DCLANG_INCLUDE_TESTS=OFF \
  -DCLANG_BUILD_TOOLS=OFF -DCLANG_BUILD_EXAMPLES=OFF -DCLANG_INCLUDE_DOCS=OFF \
  -DCLANG_LINKS_TO_CREATE="clang;clang++" -DLLD_BUILD_TOOLS=OFF \
  -DCMAKE_INSTALL_PREFIX="$TC/llvm-prefix" -DDEFAULT_SYSROOT=/usr -DCLANG_RESOURCE_DIR=/usr

ninja -C "$TC/build" llvm-driver clang-resource-headers
echo "BUILD DONE"; ls -la "$TC/build/bin/" | grep -iE 'llvm|clang|lld' | head
