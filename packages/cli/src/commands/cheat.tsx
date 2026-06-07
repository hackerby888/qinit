import { useEffect } from "react";
import { Box, Text, useApp } from "ink";
import { Grad, Panel, theme } from "../ui";

// qinit cheat-sheet — one-screen guide: setup -> contract -> deploy -> call (incl input/output formats).
const C = ({ children }: { children: React.ReactNode }) => <Text color={theme.accent}>{children}</Text>; // command
const D = ({ children }: { children: React.ReactNode }) => <Text dimColor>{children}</Text>;             // comment/code

export function Cheat() {
  const { exit } = useApp();
  useEffect(() => { const t = setTimeout(() => exit(), 30); return () => clearTimeout(t); }, []);
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}><Grad text="qinit cheat-sheet" /><Text dimColor>  — set up · deploy · call</Text></Box>

      <Panel title="1 · setup" color={theme.brand}>
        <Text><C>curl -fsSL .../install.sh | sh</C>  <D>install qinit</D></Text>
        <Text><C>qinit up</C>  <D>fetch node + headers, run a local testnet node</D></Text>
        <Text><C>qinit new mytoken && cd mytoken</C>  <D>scaffold (contracts/Mytoken.h, qinit.json)</D></Text>
      </Panel>

      <Panel title="2 · contract  (contracts/Mytoken.h)" color={theme.info}>
        <D>struct CONTRACT_STATE_TYPE : public ContractBase {`{`}</D>
        <D>{"  "}struct StateData {`{`} uint64 supply; HashMap&lt;id,uint64,1024&gt; bal; {`}`};</D>
        <D>{"  "}struct Mint_input {`{`} id to; uint64 amount; {`}`};  struct Mint_output {`{}`};</D>
        <D>{"  "}struct BalanceOf_input {`{`} id who; {`}`};  struct BalanceOf_output {`{`} uint64 amount; {`}`};</D>
        <D>{"  "}PUBLIC_PROCEDURE(Mint) {`{`} state.mut().bal.set(input.to, input.amount); {`}`}</D>
        <D>{"  "}PUBLIC_FUNCTION(BalanceOf) {`{`} output.amount = state.get().bal.get(input.who); {`}`}</D>
        <D>{"  "}REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {`{`} REGISTER_USER_PROCEDURE(Mint,1); REGISTER_USER_FUNCTION(BalanceOf,1); {`}`}</D>
        <D>{"  "}INITIALIZE() {`{}`}</D>
        <D>{`}`};</D>
      </Panel>

      <Panel title="3 · deploy + call" color={theme.ok}>
        <Text><C>qinit deploy</C>  <D>build + upload + arm</D></Text>
        <Text><C>qinit call</C>  <D>interactive picker (Tab-completes types; auto-fills known in/out)</D></Text>
        <D>non-interactive:</D>
        <Text>{"  "}<C>{`qinit call --proc Mytoken 1 --args '{"to":"<ID>","amount":100}'`}</C></Text>
        <Text>{"  "}<C>{`qinit call --fn   Mytoken 1 --args '{"who":"<ID>"}' --out uint64`}</C></Text>
      </Panel>

      <Panel title="4 · input / output formats" color={theme.accent}>
        <Text><Text bold>input</Text> = value+type per field, comma-separated:</Text>
        <D>{"  "}scalar   5uint64   -7sint32   1bit</D>
        <D>{"  "}id       ABCD…WXYZid          (60 uppercase A–Z)</D>
        <D>{"  "}m256i    00ff…ddeeffm256i      (64 hex = a digest)</D>
        <D>{"  "}struct   {`{ 5uint64, 1bit }`}     array  [3; 1uint64, 2uint64, 3uint64]</D>
        <D>{"  "}or JSON  --args '{`{"to":"ABC…","amount":100}`}'   (keyed by field name)</D>
        <Text><Text bold>output</Text> = types only:  <D>uint64{"   "}{`{ id, uint16 }`}</D></Text>
        <D>(the picker fills these from the contract; no-input / known-output → no prompt)</D>
      </Panel>

      <Panel title="5 · inspect" color={theme.mute}>
        <Text><C>qinit ls</C> <D>deployed contracts</D>   <C>qinit state {"<name>"}</C> <D>decoded state</D>   <C>qinit debug</C> <D>live call tracer</D></Text>
      </Panel>
    </Box>
  );
}
