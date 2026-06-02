import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { cryptoSmoke, type CryptoSmokeResult } from "@qinit/core";

type State = { phase: "run" } | { phase: "ok"; r: CryptoSmokeResult } | { phase: "err"; msg: string };

export function Smoke() {
  const { exit } = useApp();
  const [s, setS] = useState<State>({ phase: "run" });

  useEffect(() => {
    cryptoSmoke()
      .then((r) => setS({ phase: "ok", r }))
      .catch((e) => setS({ phase: "err", msg: String(e?.stack ?? e?.message ?? e) }));
  }, []);
  useEffect(() => {
    if (s.phase !== "run") {
      process.exitCode = s.phase === "ok" && s.r.ok ? 0 : 1;
      exit();
    }
  }, [s, exit]);

  if (s.phase === "run") return <Text>deriving identity (K12 + FourQ) …</Text>;
  if (s.phase === "err") {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ crypto smoke failed</Text>
        <Text dimColor>{s.msg}</Text>
      </Box>
    );
  }
  const { r } = s;
  return (
    <Box flexDirection="column">
      <Text color={r.ok ? "green" : "red"}>{r.ok ? "✓" : "✗"} {r.note}</Text>
      <Text dimColor>identity:  {r.identity}</Text>
      <Text dimColor>publicKey: {r.publicKeyHex}</Text>
    </Box>
  );
}
