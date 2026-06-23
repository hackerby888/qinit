import { useEffect } from "react";
import { Box, Text, useApp } from "ink";
import { Grad, Panel, theme } from "../ui";

// qinit cheat-sheet — one-screen guide: setup -> contract -> deploy -> call (incl input/output formats).
const C = ({ children }: { children: React.ReactNode }) => <Text color={theme.accent}>{children}</Text>; // command
const D = ({ children }: { children: React.ReactNode }) => <Text dimColor>{children}</Text>;             // comment

// ---- minimal QPI syntax highlighter (good enough for the cheat-sheet snippet) -------------------------
const TYPES = new Set(["uint8", "uint16", "uint32", "uint64", "sint8", "sint16", "sint32", "sint64", "bit", "id", "m256i", "bool", "void", "HashMap", "HashSet", "Array", "Collection", "ContractBase"]);
const MACROS = new Set(["PUBLIC_PROCEDURE", "PUBLIC_FUNCTION", "REGISTER_USER_FUNCTIONS_AND_PROCEDURES", "REGISTER_USER_PROCEDURE", "REGISTER_USER_FUNCTION", "INITIALIZE", "BEGIN_TICK", "END_TICK", "BEGIN_EPOCH", "END_EPOCH", "CONTRACT_STATE_TYPE", "CONTRACT_STATE2_TYPE"]);
const KEYWORDS = new Set(["struct", "public", "return", "using", "namespace"]);
const BUILTINS = new Set(["state", "input", "output", "qpi", "mut", "get", "set"]);
function tokenColor(t: string): string | undefined {
  if (KEYWORDS.has(t)) return theme.accent;   // pink
  if (MACROS.has(t)) return theme.brand;       // violet
  if (TYPES.has(t)) return theme.info;         // cyan
  if (BUILTINS.has(t)) return theme.ok;        // green
  if (/^\d+$/.test(t)) return theme.warn;      // orange numbers
  return undefined;
}
// one highlighted line — returns a <Text> so it can nest inline (in a row) or stack (in Code).
const CodeLine = ({ ln }: { ln: string }) => {
  const ci = ln.indexOf("//");
  const code = ci >= 0 ? ln.slice(0, ci) : ln;
  const cmt = ci >= 0 ? ln.slice(ci) : "";
  const parts = code.split(/([A-Za-z_][A-Za-z0-9_]*|\d+)/);
  return (
    <Text>
      {parts.map((p, j) => <Text key={j} color={/^[A-Za-z0-9_]+$/.test(p) ? tokenColor(p) : undefined}>{p}</Text>)}
      {cmt ? <Text dimColor>{cmt}</Text> : null}
    </Text>
  );
};
const Code = ({ lines }: { lines: string[] }) => (
  <Box flexDirection="column">{lines.map((ln, i) => <CodeLine key={i} ln={ln} />)}</Box>
);

// aligned "format" row: name + example (highlighted) + optional note
const Fmt = ({ k, ex, note }: { k: string; ex: string; note?: string }) => (
  <Text>{"  "}<Text color={theme.info}>{k.padEnd(9)}</Text> <CodeLine ln={ex} />{note ? <Text dimColor>   {note}</Text> : null}</Text>
);

const CONTRACT = [
  "struct CONTRACT_STATE_TYPE : public ContractBase {",
  "  struct StateData { uint64 supply; HashMap<id, uint64, 1024> bal; };",
  " ",
  "  struct Mint_input       { id to; uint64 amount; };",
  "  struct Mint_output      { };",
  "  struct BalanceOf_input  { id who; };",
  "  struct BalanceOf_output { uint64 amount; };",
  " ",
  "  PUBLIC_PROCEDURE(Mint) {",
  "    state.mut().bal.set(input.to, input.amount);",
  "  }",
  " ",
  "  PUBLIC_FUNCTION(BalanceOf) {",
  "    output.amount = state.get().bal.get(input.who);",
  "  }",
  " ",
  "  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {",
  "    REGISTER_USER_PROCEDURE(Mint, 1);",
  "    REGISTER_USER_FUNCTION(BalanceOf, 1);",
  "  }",
  " ",
  "  INITIALIZE() { }",
  "};",
];

export function Cheat() {
  const { exit } = useApp();
  useEffect(() => { const t = setTimeout(() => exit(), 30); return () => clearTimeout(t); }, []);
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}><Grad text="qinit cheat-sheet" /><Text dimColor>  — set up · deploy · call</Text></Box>

      <Panel title="1 · setup" color={theme.brand}>
        <Text><C>curl -fsSL .../install.sh | sh</C>  <D>install qinit</D></Text>
        <Text><C>qinit node run</C>  <D>fetch node + headers, run a local testnet node</D></Text>
        <Text><C>qinit new mytoken && cd mytoken</C>  <D>scaffold (contracts/Mytoken.h, qinit.json)</D></Text>
      </Panel>

      <Panel title="2 · contract  (contracts/Mytoken.h)" color={theme.info}>
        <Code lines={CONTRACT} />
      </Panel>

      <Panel title="3 · deploy + call" color={theme.ok}>
        <Text><C>qinit deploy</C>  <D>build + upload + arm</D></Text>
        <Text><C>qinit call</C>  <D>interactive picker (Tab-completes types; auto-fills known in/out)</D></Text>
        <D>non-interactive (--in "&lt;format&gt;", the standard):</D>
        <Text>{"  "}<C>{`qinit call --proc Mytoken 1 --in "<ID>id, 100uint64"`}</C></Text>
        <Text>{"  "}<C>{`qinit call --fn   Mytoken 1 --in "<ID>id" --out uint64`}</C></Text>
        <D>{"  "}(JSON also works: --args {`'{"to":"<ID>","amount":100}'`})</D>
      </Panel>

      <Panel title="4 · input / output formats" color={theme.accent}>
        <Text bold>input</Text>
        <D>  value+type per field, comma-separated:</D>
        <Fmt k="scalar" ex="5uint64, -7sint32, 1bit" />
        <Fmt k="id" ex="<60 chars A-Z>id" note="a wallet id" />
        <Fmt k="m256i" ex="<64 hex>m256i" note="a digest" />
        <Fmt k="struct" ex="{ 5uint64, 1bit }" />
        <Fmt k="array" ex="[3; 1uint64, 2uint64, 3uint64]" />
        <Fmt k="json" ex={`--args '{"to":"<ID>","amount":100}'`} note="optional alt, keyed by field name" />
        <Box marginTop={1}><Text bold>output</Text></Box>
        <D>  types only (no values):</D>
        <Fmt k="scalar" ex="uint64" />
        <Fmt k="struct" ex="{ id, uint16 }" />
        <D>  the picker fills these from the contract — no-input / known-output ⇒ no prompt.</D>
      </Panel>

      <Panel title="5 · inspect" color={theme.mute}>
        <Text><C>qinit ls</C> <D>deployed contracts</D>   <C>qinit state {"<name>"}</C> <D>decoded state</D>   <C>qinit debug</C> <D>live call tracer</D></Text>
      </Panel>
    </Box>
  );
}
