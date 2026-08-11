import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  completionScope,
  documentIdentifiers,
  keepCompletionLabel,
  keepMemberLabel,
  keepQualifiedScope,
  qpiAllowedIdentifiers,
} from "../../src/completion-filter";

const BUNDLED_CORE = resolve(import.meta.dir, "..", "..", "resources", "core-headers");
const hasHeaders = existsSync(join(BUNDLED_CORE, "src", "qpi", "qpi.h"));

// The prefix header the extension generates starts with the same includes the contract compile uses.
const PREFIX = `#include <cstdint>
#include <string>
#include "contract_core/pre_qpi_def.h"
#include "qpi/qpi.h"
#include "contracts/math_lib.h"
#include "oracle_core/oracle_interfaces_def.h"
#include "oc_core/oc_interfaces_def.h"
#include "extensions/wasm/sdk/qpi_support.h"
`;

function bundledAllowlist(): ReadonlySet<string> {
  const dir = mkdtempSync(join(tmpdir(), "qpi-allow-"));
  try {
    const prefix = join(dir, "Probe.prefix.h");
    writeFileSync(prefix, PREFIX);
    return qpiAllowedIdentifiers(prefix, BUNDLED_CORE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.if(hasHeaders)("the QPI surface a contract writes is allowed", () => {
  const allowed = bundledAllowlist();
  for (const name of [
    "uint64",
    "sint64",
    "bit",
    "id",
    "Array",
    "HashMap",
    "Collection",
    "m256i",
    "uint128",
    "PUBLIC_PROCEDURE",
    "PRIVATE_FUNCTION_WITH_LOCALS",
    "REGISTER_USER_FUNCTION",
    "INITIALIZE",
    "div",
    "mod",
    "min",
    "max",
    "NULL_ID",
    "invocator",
  ]) {
    expect(allowed.has(name)).toBe(true);
  }
});

// Oracle and outsourced-computation interfaces are contract-facing — see contracts/QUtil.h.
test.if(hasHeaders)("the oracle and OC interfaces are allowed", () => {
  const allowed = bundledAllowlist();
  for (const name of [
    "OI",
    "OCI",
    "Price",
    "Mock",
    "QUERY_ORACLE",
    "SUBSCRIBE_ORACLE",
    "INVOKE_OC",
    "OracleNotificationInput",
    "OracleQuery",
    "OcRequest",
    "oracleInterfaceIndex",
    "getQueryFee",
    "getInvocationFee",
    "unsubscribeOracle",
    "setMemory",
  ]) {
    expect(allowed.has(name)).toBe(true);
  }
});

test.if(hasHeaders)("nothing outside the core source tree gets in", () => {
  const allowed = bundledAllowlist();
  // simde lives under lib/, libc and libc++ arrive through angle includes: neither is walked.
  for (const name of ["simde_mm_add_epi64", "fprintf", "fread", "printf_s", "basic_string"]) {
    expect(allowed.has(name)).toBe(false);
  }
  // Reserved names and the constructs QPI forbids never make the list either.
  for (const name of ["float", "double", "union", "const_cast", "QpiContext"]) {
    expect(allowed.has(name)).toBe(false);
  }
  expect([...allowed].some((name) => name.startsWith("_"))).toBe(false);
});

// The whole point of walking includes instead of listing names: new QPI headers need no change here.
test("a header added to the tree joins the allowlist on its own", () => {
  const root = mkdtempSync(join(tmpdir(), "qpi-core-"));
  try {
    const src = join(root, "src");
    mkdirSync(join(src, "qpi"), { recursive: true });
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(
      join(src, "qpi", "qpi.h"),
      '#include <vector>\n#include "qpi_future.h"\n#include "../../lib/vendored.h"\nstruct id {};\n',
    );
    writeFileSync(join(src, "qpi", "qpi_future.h"), "struct FutureContainer { uint64 futureField; };\n");
    writeFileSync(join(root, "lib", "vendored.h"), "int simde_mm_add_epi64(int);\n");

    const prefix = join(root, "Probe.prefix.h");
    writeFileSync(prefix, '#include "qpi/qpi.h"\n');
    const allowed = qpiAllowedIdentifiers(prefix, root);

    expect(allowed.has("FutureContainer")).toBe(true);
    expect(allowed.has("futureField")).toBe(true);
    expect(allowed.has("simde_mm_add_epi64")).toBe(false);
    expect(allowed.has("vector")).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope is read off the line, not the trigger character", () => {
  expect(completionScope("  locals.x = ")).toEqual({ kind: "identifier" });
  expect(completionScope("  output.value = inp")).toEqual({ kind: "identifier" });
  expect(completionScope("")).toEqual({ kind: "identifier" });
  // A bare `::` is the global scope, as wide open as a plain identifier.
  expect(completionScope("  ::")).toEqual({ kind: "identifier" });

  expect(completionScope("  qpi.")).toEqual({ kind: "member" });
  expect(completionScope("  qpi.invoc")).toEqual({ kind: "member" });
  expect(completionScope("  state.mut().nums.")).toEqual({ kind: "member" });
  expect(completionScope("  entity->incoming")).toEqual({ kind: "member" });

  expect(completionScope("  QX::")).toEqual({ kind: "qualified", qualifier: "QX" });
  expect(completionScope("  OI::Price::getQ")).toEqual({ kind: "qualified", qualifier: "Price" });
  expect(completionScope("  std::vec")).toEqual({ kind: "qualified", qualifier: "std" });
});

// `std::` is how the standard library gets back in: the core headers spell it for their own type traits.
test.if(hasHeaders)("the standard namespace is not part of the surface", () => {
  const allowed = bundledAllowlist();
  expect(allowed.has("std")).toBe(false);
  expect(allowed.has("QPI")).toBe(true);
  expect(allowed.has("OI")).toBe(true);
});

test("a qualified list is shown only for QPI and the contract's own names", () => {
  const allowed = new Set(["QPI", "OI", "Price"]);
  const documentNames = new Set(["QX", "std"]);

  expect(keepQualifiedScope("QPI", allowed, documentNames)).toBe(true);
  expect(keepQualifiedScope("Price", allowed, documentNames)).toBe(true);
  // A callee contract lives in the author's project, so the document is what vouches for it.
  expect(keepQualifiedScope("QX", allowed, documentNames)).toBe(true);
  // Spelling `std` in the file must not hand back the standard library.
  expect(keepQualifiedScope("std", allowed, documentNames)).toBe(false);
  expect(keepQualifiedScope("simde", allowed, documentNames)).toBe(false);
  expect(keepCompletionLabel("std", allowed, documentNames)).toBe(false);
});

test("labels are matched by their leading identifier", () => {
  const allowed = new Set(["uint64", "div"]);
  const documentNames = new Set(["Counter", "myLocal"]);

  expect(keepCompletionLabel(" div(sint64 a, sint64 b)", allowed, documentNames)).toBe(true);
  expect(keepCompletionLabel("uint64", allowed, documentNames)).toBe(true);
  expect(keepCompletionLabel(" myLocal", allowed, documentNames)).toBe(true);
  expect(keepCompletionLabel(" fprintf(FILE *__restrict, ...)", allowed, documentNames)).toBe(false);
  expect(keepCompletionLabel(" __implementQpiFunction()", allowed, documentNames)).toBe(false);
  // No leading identifier to judge (operators, destructors) — left alone.
  expect(keepCompletionLabel("~Counter()", allowed, documentNames)).toBe(true);
});

test("member lists lose the reserved names, the operators and the destructor", () => {
  expect(keepMemberLabel(" get(uint64 index) const")).toBe(true);
  expect(keepMemberLabel(" __reservedSlot")).toBe(false);
  expect(keepMemberLabel(" _internal")).toBe(false);
  expect(keepMemberLabel(" operator=(const Get_input &)")).toBe(false);
  expect(keepMemberLabel(" ~Get_input()")).toBe(false);
  // A member is only an operator when the word ends there.
  expect(keepMemberLabel(" operatorCount")).toBe(true);
});

test("document identifiers cover what the author already wrote", () => {
  const names = documentIdentifiers("struct Counterdemo { uint64 tick; };");
  expect(names.has("Counterdemo")).toBe(true);
  expect(names.has("tick")).toBe(true);
  expect(names.has("uint64")).toBe(true);
});
