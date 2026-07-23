import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateClangdConfig } from "../src/clangd-config";

const CLANGD = process.env.CLANGD ?? "clangd";
const core =
  process.env.QPI_VSCODE_HEADERS ??
  resolve(import.meta.dir, "..", "resources", "core-headers");
if (!existsSync(join(core, "src", "contracts", "qpi.h"))) {
  console.error("bundled QPI headers are missing — run `bun run prepare:headers`");
  process.exit(2);
}

const workspace = mkdtempSync(join(tmpdir(), "qpi-complete-"));
const PROBE = `#include "contracts/qpi.h"
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

const posAt = (offset: number) => {
  const prefix = PROBE.slice(0, offset);
  const line = prefix.split("\n").length - 1;
  return { line, character: offset - (prefix.lastIndexOf("\n") + 1) };
};
const afterDot = (find: string, dot: string) => posAt(PROBE.indexOf(find) + dot.length);

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

const labelsAt = async (pos: { line: number; character: number }): Promise<string[]> => {
  const result = await send("textDocument/completion", { textDocument: { uri }, position: pos });
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
} finally {
  clangd.kill();
  rmSync(workspace, { recursive: true, force: true });
}
console.log(
  `\n${failures === 0 ? "COMPLETION PROBE: PASS — public QPI surface completes" : `COMPLETION PROBE: FAIL (${failures})`}`,
);
process.exit(failures === 0 ? 0 : 1);
