import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateClangdConfig } from "../src/clangd-config";
import {
  completionScope,
  documentIdentifiers,
  keepCompletionLabel,
  keepMemberLabel,
  keepQualifiedScope,
  qpiAllowedIdentifiers,
} from "../src/completion-filter";

const CLANGD = process.env.CLANGD ?? "clangd";
const core =
  process.env.QPI_VSCODE_HEADERS ??
  resolve(import.meta.dir, "..", "resources", "core-headers");
if (!existsSync(join(core, "src", "qpi", "qpi.h"))) {
  console.error("bundled QPI headers are missing — run `bun run prepare:headers`");
  process.exit(2);
}

const workspace = mkdtempSync(join(tmpdir(), "qpi-complete-"));

// Cross-call pair mirroring the field-completion clangd bug: callee input holds an Array member.
const CALLEE = `using namespace QPI;
struct Callee : public ContractBase {
  struct StateData { uint64 counter; };
  struct Get_input {
    Array<uint64, 8> bc;
    sint16 a;
  };
  struct Get_output { uint64 value; };
  PUBLIC_FUNCTION(Get) {
    output.value = state.get().counter;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};
`;
const CALLER = `using namespace QPI;
struct Caller : public ContractBase {
  struct StateData { uint64 dummy; };
  struct Read_input {}; struct Read_output { uint64 value; };
  struct Read_locals { Callee::Get_input gi; Callee::Get_output go; };
  PUBLIC_FUNCTION_WITH_LOCALS(Read) {
    CALL_OTHER_CONTRACT_FUNCTION(Callee, Get, locals.gi, locals.go);
    locals.gi.a = 0;
    output.value = locals.go.value;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Read, 1); }
};
`;

const PROBE = `#include "qpi/qpi.h"
using namespace QPI;
struct Probe2 {};
struct Probe : public ContractBase {
  struct StateData { uint64 counter; Array<uint64, 8> nums; };
  struct Go_input {}; struct Go_output {};
  struct Go_locals { uint64 x; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) {
    state.mut().counter = 0;
    locals.x = state.get().nums.get(0);
    qpi.invocator();
    locals.x = std::is_same<uint64, uint64>::value;
    locals.x = 0;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};
`;
const file = join(workspace, "Probe.h");
writeFileSync(file, PROBE);
const config = generateClangdConfig({
  contractPath: file,
  corePath: core,
  dataRoot: workspace,
  workspaceRoot: workspace,
  name: "Probe",
});
const uri = pathToFileURL(config.contractFile).href;

const calleeFile = join(workspace, "Callee.h");
const callerFile = join(workspace, "Caller.h");
writeFileSync(calleeFile, CALLEE);
writeFileSync(callerFile, CALLER);
const callerConfig = generateClangdConfig({
  contractPath: callerFile,
  corePath: core,
  dataRoot: workspace,
  workspaceRoot: workspace,
  name: "Caller",
  slot: 30,
  dynCallees: { Callee: { header: calleeFile, index: 29 } },
});
const callerUri = pathToFileURL(callerConfig.contractFile).href;

const posIn = (source: string, offset: number) => {
  const prefix = source.slice(0, offset);
  const line = prefix.split("\n").length - 1;
  return { line, character: offset - (prefix.lastIndexOf("\n") + 1) };
};
const posAt = (offset: number) => posIn(PROBE, offset);
const afterDot = (find: string, dot: string) => posAt(PROBE.indexOf(find) + dot.length);
const callerAfterDot = (find: string, dot: string) =>
  posIn(CALLER, CALLER.indexOf(find) + dot.length);

const clangd = Bun.spawn(
  [
    CLANGD,
    `--compile-commands-dir=${config.dir}`,
    "--background-index=false",
    "--log=error",
  ],
  { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
);

let sequence = 0;
const pending = new Map<number, (value: any) => void>();
function send(method: string, params: any, isNotification = false) {
  const message: any = { jsonrpc: "2.0", method, params };
  let response: Promise<any> | undefined;
  if (!isNotification) {
    const id = ++sequence;
    message.id = id;
    response = new Promise((resolve) => pending.set(id, resolve));
  }
  const body = JSON.stringify(message);
  clangd.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  clangd.stdin.flush();
  return response;
}

(async () => {
  let buffer = Buffer.alloc(0);
  for await (const chunk of clangd.stdout as any) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const separator = buffer.indexOf("\r\n\r\n");
      if (separator < 0) {
        break;
      }
      const header = buffer.subarray(0, separator).toString();
      const match = header.match(/Content-Length: (\d+)/i);
      if (!match) {
        buffer = buffer.subarray(separator + 4);
        continue;
      }
      const length = Number(match[1]);
      if (buffer.length < separator + 4 + length) {
        break;
      }
      const body = buffer.subarray(separator + 4, separator + 4 + length).toString();
      buffer = buffer.subarray(separator + 4 + length);
      try {
        const message = JSON.parse(body);
        if (message.id != null && pending.has(message.id)) {
          pending.get(message.id)!(message.result);
          pending.delete(message.id);
        }
      } catch {}
    }
  }
})();

const labelsAt = async (
  pos: { line: number; character: number },
  documentUri: string = uri,
): Promise<string[]> => {
  const result = await send("textDocument/completion", {
    textDocument: { uri: documentUri },
    position: pos,
  });
  const items = Array.isArray(result) ? result : (result?.items ?? []);
  return items.map((item: any) => item.label.trim());
};

const ok = (condition: boolean, message: string) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${message}`);
  return condition;
};
let failures = 0;
try {
  await send("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(workspace).href,
    capabilities: {
      textDocument: { completion: { completionItem: { snippetSupport: false } } },
    },
  });
  send("initialized", {}, true);
  send(
    "textDocument/didOpen",
    { textDocument: { uri, languageId: "cpp", version: 1, text: PROBE } },
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 4000));

  const stateMembers = await labelsAt(afterDot("state.mut().counter", "state.mut()."));
  const arrayMembers = await labelsAt(afterDot("nums.get(0)", "nums."));
  const qpiMembers = await labelsAt(afterDot("qpi.invocator", "qpi."));
  const stdScope = await labelsAt(afterDot("std::is_same", "std::"));
  const valueScope = await labelsAt(
    posAt(PROBE.lastIndexOf("locals.x = ") + "locals.x = ".length),
  );

  const starts = (items: string[], prefix: string) =>
    items.some((item) => item.startsWith(prefix));
  console.log(`state.mut(). -> ${stateMembers.length} items: ${stateMembers.slice(0, 8).join(", ")}`);
  console.log(
    `Array .      -> ${arrayMembers.length} items: ${arrayMembers.slice(0, 8).join(", ")}`,
  );
  console.log(
    `qpi.         -> ${qpiMembers.length} items; __reserved=${qpiMembers.filter((item) => item.startsWith("__")).length}; public e.g. ${qpiMembers.filter((item) => !item.startsWith("__")).slice(0, 8).join(", ")}`,
  );
  console.log(
    `value scope  -> ${valueScope.length} items; std:: labels=${valueScope.filter((item) => item.startsWith("std::")).length}; e.g. ${valueScope.slice(0, 10).join(", ")}\n`,
  );

  if (
    !ok(
      stateMembers.includes("counter") && stateMembers.includes("nums"),
      "state.mut(). completes StateData members (counter, nums)",
    )
  ) {
    failures++;
  }
  if (
    !ok(
      starts(arrayMembers, "get") && starts(arrayMembers, "capacity"),
      "Array member access completes (get, capacity)",
    )
  ) {
    failures++;
  }
  if (
    !ok(
      qpiMembers.some((item) =>
        /^(invocator|invocationReward|numberOfTickTransactions|transfer|burn)\b/.test(item),
      ),
      "qpi. completes public API members",
    )
  ) {
    failures++;
  }
  if (
    !ok(
      !valueScope.some((item) => item.startsWith("std::")),
      "value scope has no cross-scope std:: flood",
    )
  ) {
    failures++;
  }

  // What the VS Code extension's completion middleware hands the editor.
  const allowed = qpiAllowedIdentifiers(config.prefixPath, core);
  const documentNames = documentIdentifiers(PROBE);
  const filtered = valueScope.filter((item) =>
    keepCompletionLabel(item, allowed, documentNames),
  );
  console.log(
    `\nfiltered     -> ${filtered.length} of ${valueScope.length} items: ${filtered.join(", ")}\n`,
  );

  const noise = /^(simde_|_mm|__|fprintf|fread|fscanf)/;
  if (!ok(!filtered.some((item) => noise.test(item)), "filtered value scope drops libc/SIMD/internals")) {
    failures++;
  }
  // clangd answers with its top 100 ranked items, so the filter can only keep what it was offered.
  const mustSurvive = [
    "state",
    "locals",
    "input",
    "output",
    "qpi",
    "Probe",
    "StateData",
    "sadd",
    "CONTRACT_INDEX",
    "REGISTER_USER_PROCEDURE",
    "uint64",
    "Array",
    "div",
  ];
  const offered = (items: string[], name: string) => items.some((item) => item.startsWith(name));
  const dropped = mustSurvive.filter(
    (name) => offered(valueScope, name) && !offered(filtered, name),
  );
  if (!ok(dropped.length === 0, `filter keeps every QPI symbol clangd offered${dropped.length ? `: lost ${dropped.join(", ")}` : ""}`)) {
    failures++;
  }
  if (
    !ok(
      [stateMembers, arrayMembers, qpiMembers].every(
        (members) => members.filter(keepMemberLabel).length === members.length,
      ),
      "member lists survive the filter unchanged",
    )
  ) {
    failures++;
  }

  // Cross-call probes. clangd cannot complete members through a field whose preamble type carries a
  // template member (upstream, clangd 17-22); the extension covers that with a clang fallback. This
  // canary asserts the raw breakage, so a fixed clangd release flips it and retires the fallback.
  send(
    "textDocument/didOpen",
    { textDocument: { uri: callerUri, languageId: "cpp", version: 1, text: CALLER } },
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 4000));

  const localsMembers = await labelsAt(callerAfterDot("locals.gi, locals.go", "locals."), callerUri);
  const plainFieldMembers = await labelsAt(
    callerAfterDot("locals.go.value", "locals.go."),
    callerUri,
  );
  const brokenFieldMembers = await labelsAt(
    callerAfterDot("locals.gi.a = 0", "locals.gi."),
    callerUri,
  );
  console.log(
    `cross-call   -> locals.=${localsMembers.length}, ` +
      `locals.go.=${plainFieldMembers.length}, locals.gi.=${brokenFieldMembers.length}`,
  );

  if (
    !ok(
      localsMembers.includes("gi") && localsMembers.includes("go"),
      "cross-call locals. completes its fields (gi, go)",
    )
  ) {
    failures++;
  }
  if (
    !ok(
      plainFieldMembers.includes("value"),
      "cross-call locals.go. completes a template-free callee struct",
    )
  ) {
    failures++;
  }
  if (
    !ok(
      brokenFieldMembers.length === 0,
      "KNOWN-BAD canary: raw clangd still returns nothing for locals.gi. — " +
        "if this fails with items present, clangd fixed the upstream bug: retire member-fallback.ts",
    )
  ) {
    failures++;
  }

  // `std::` is a qualified scope, and the standard namespace is not part of the QPI surface — even though
  // this probe spells `std` in its own source, which is what the document-identifier rescue goes by.
  const stdScopeKept =
    completionScope("    locals.x = std::").kind === "qualified" &&
    keepQualifiedScope("std", allowed, documentNames);
  console.log(
    `std::        -> ${stdScope.length} raw, ${stdScopeKept ? stdScope.length : 0} filtered; std offered at value scope: ${filtered.includes("std")}`,
  );
  if (!ok(!stdScopeKept && !filtered.includes("std"), "the standard namespace is not offered")) {
    failures++;
  }
} finally {
  clangd.kill();
  rmSync(workspace, { recursive: true, force: true });
}
console.log(
  `\n${failures === 0 ? "COMPLETION PROBE: PASS — public QPI surface completes" : `COMPLETION PROBE: FAIL (${failures})`}`,
);
process.exit(failures === 0 ? 0 : 1);
