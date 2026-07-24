import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { systemContracts } from "@qinit/build";
import {
  AbiTypeKind,
  type AbiType,
} from "@qinit/proto/contract-idl";

const coreArg = process.env.QINIT_CORE;
if (!coreArg) {
  throw new Error("QINIT_CORE is required");
}
const nativeClang = process.env.QINIT_NATIVE_CLANG ?? "clang++";

const core = resolve(coreArg);
const contractDefinition = join(
  core,
  "src",
  "contract_core",
  "contract_def.h",
);
if (!existsSync(contractDefinition)) {
  throw new Error(`${core} is not a core-lite checkout`);
}

const lines = [
  "#include <cstddef>",
  "#include <cstdio>",
  "#include <string>",
  "#include <type_traits>",
  "#include <utility>",
  '#include "contract_core/contract_def.h"',
  "",
  "template <typename T>",
  "using QinitClean = std::remove_cv_t<std::remove_reference_t<T>>;",
  "",
  "template <typename T> struct QinitArrayTraits;",
  "template <typename T, std::size_t N>",
  "struct QinitArrayTraits<T[N]> {",
  "  using Element = T;",
  "  static constexpr std::size_t count = N;",
  "};",
  "template <typename T, QPI::uint64 N>",
  "struct QinitArrayTraits<QPI::Array<T, N>> {",
  "  using Element = T;",
  "  static constexpr QPI::uint64 count = N;",
  "};",
  "template <typename T, QPI::uint64 N>",
  "struct QinitArrayTraits<QPI::SlowAnySizeArray<T, N>> {",
  "  using Element = T;",
  "  static constexpr QPI::uint64 count = N;",
  "};",
  "template <QPI::uint64 N>",
  "struct QinitArrayTraits<QPI::BitArray<N>> {",
  "  using Element = QPI::uint64;",
  "  static constexpr QPI::uint64 count = (N + 63) / 64;",
  "};",
  "",
  "template <typename T> struct QinitHashMapTraits;",
  "template <typename K, typename V, QPI::uint64 N, typename H>",
  "struct QinitHashMapTraits<QPI::HashMap<K, V, N, H>> {",
  "  using Key = K;",
  "  using Value = V;",
  "  static constexpr QPI::uint64 capacity = N;",
  "};",
  "",
  "template <typename T> struct QinitHashSetTraits;",
  "template <typename K, QPI::uint64 N, typename H>",
  "struct QinitHashSetTraits<QPI::HashSet<K, N, H>> {",
  "  using Key = K;",
  "  static constexpr QPI::uint64 capacity = N;",
  "};",
  "",
  "template <typename T> struct QinitCollectionTraits;",
  "template <typename V, QPI::uint64 N>",
  "struct QinitCollectionTraits<QPI::Collection<V, N>> {",
  "  using Value = V;",
  "  static constexpr QPI::uint64 capacity = N;",
  "};",
  "",
];

let typeIndex = 0;

function message(
  contract: string,
  path: string,
  metric: string,
  expected: number,
): string {
  return JSON.stringify(
    `QINIT_ABI|${contract}|${path}|${metric}|${expected}`,
  );
}

function alias(expression: string): string {
  const name = `QinitType${typeIndex++}`;
  lines.push(`using ${name} = QinitClean<${expression}>;`);
  return name;
}

function assertType(
  contract: string,
  path: string,
  type: AbiType,
  nativeType: string,
): void {
  lines.push(
    `static_assert(sizeof(${nativeType}) == ${type.size}, ${message(contract, path, "size", type.size)});`,
  );
  lines.push(
    `static_assert(alignof(${nativeType}) == ${type.align}, ${message(contract, path, "align", type.align)});`,
  );

  switch (type.kind) {
    case AbiTypeKind.SCALAR:
      return;
    case AbiTypeKind.STRUCT:
      for (const field of type.fields) {
        lines.push(
          `static_assert(__builtin_offsetof(${nativeType}, ${field.name}) == ${field.offset}, ${message(contract, `${path}.${field.name}`, "offset", field.offset)});`,
        );
        const fieldType = alias(
          `decltype(std::declval<${nativeType}&>().${field.name})`,
        );
        assertType(
          contract,
          `${path}.${field.name}`,
          field.type,
          fieldType,
        );
      }
      return;
    case AbiTypeKind.ARRAY: {
      const traits = `QinitArrayTraits<${nativeType}>`;
      lines.push(
        `static_assert(${traits}::count == ${type.count}, ${message(contract, path, "count", type.count)});`,
      );
      const elementType = alias(`typename ${traits}::Element`);
      assertType(
        contract,
        `${path}[]`,
        type.element,
        elementType,
      );
      return;
    }
    case AbiTypeKind.HASH_MAP: {
      const traits = `QinitHashMapTraits<${nativeType}>`;
      lines.push(
        `static_assert(${traits}::capacity == ${type.capacity}, ${message(contract, path, "capacity", type.capacity)});`,
      );
      const keyType = alias(`typename ${traits}::Key`);
      const valueType = alias(`typename ${traits}::Value`);
      assertType(contract, `${path}.key`, type.key, keyType);
      assertType(contract, `${path}.value`, type.value, valueType);
      return;
    }
    case AbiTypeKind.HASH_SET: {
      const traits = `QinitHashSetTraits<${nativeType}>`;
      lines.push(
        `static_assert(${traits}::capacity == ${type.capacity}, ${message(contract, path, "capacity", type.capacity)});`,
      );
      const keyType = alias(`typename ${traits}::Key`);
      assertType(contract, `${path}.key`, type.key, keyType);
      return;
    }
    case AbiTypeKind.COLLECTION: {
      const traits = `QinitCollectionTraits<${nativeType}>`;
      lines.push(
        `static_assert(${traits}::capacity == ${type.capacity}, ${message(contract, path, "capacity", type.capacity)});`,
      );
      const valueType = alias(`typename ${traits}::Value`);
      assertType(contract, `${path}.value`, type.value, valueType);
    }
  }
}

const catalog = systemContracts(core);
if (!catalog.length) {
  throw new Error("core-lite contract catalog is empty");
}

for (const contract of catalog) {
  const state = alias(`::${contract.stateType}::StateData`);
  assertType(contract.name, "StateData", contract.idl.state, state);

  for (const entry of [
    ...contract.idl.functions,
    ...contract.idl.procedures,
  ]) {
    const input = alias(
      `::${contract.stateType}::${entry.name}_input`,
    );
    const output = alias(
      `::${contract.stateType}::${entry.name}_output`,
    );
    assertType(
      contract.name,
      `${entry.name}.input`,
      entry.input,
      input,
    );
    assertType(
      contract.name,
      `${entry.name}.output`,
      entry.output,
      output,
    );
  }

  if (contract.idl.migration) {
    const oldState = alias(`::${contract.stateType}::OldStateData`);
    assertType(
      contract.name,
      "OldStateData",
      contract.idl.migration.oldState,
      oldState,
    );
  }
}

lines.push("");

const scratch = mkdtempSync(join(tmpdir(), "qinit-idl-native-"));
try {
  const source = join(scratch, "probe.cpp");
  writeFileSync(source, lines.join("\n"));
  const result = Bun.spawnSync(
    [
      nativeClang,
      "-std=c++20",
      "-fno-access-control",
      "-fshort-wchar",
      "-w",
      "-DNO_UEFI",
      `-I${core}`,
      `-I${join(core, "src")}`,
      "-fsyntax-only",
      source,
    ],
    {
      cwd: scratch,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  if (result.exitCode !== 0) {
    const output = [
      result.stdout?.toString() ?? "",
      result.stderr?.toString() ?? "",
    ].join("");
    throw new Error(`native IDL ABI check failed\n${output}`);
  }

  console.log(
    `native IDL ABI OK — ${catalog.length} contracts, ${typeIndex} checked types`,
  );
} finally {
  rmSync(scratch, {
    recursive: true,
    force: true,
  });
}
