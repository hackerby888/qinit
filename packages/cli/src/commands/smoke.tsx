import { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { cryptoSmoke, type CryptoSmokeResult } from "@qinit/core";
import { Header, Spinner, Panel, Status, KV, theme } from "../ui";

type State =
  { phase: "run" } | { phase: "ok"; r: CryptoSmokeResult } | { phase: "err"; msg: string };

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

  return (
    <Box flexDirection="column">
      <Header cmd="smoke" />
      {s.phase === "run" && <Spinner label="deriving identity (K12 + FourQ)" />}
      {s.phase === "err" && (
        <Panel title="crypto smoke" color={theme.err}>
          <Status ok={false} label="crypto smoke failed" />
          <Text dimColor>{s.msg}</Text>
        </Panel>
      )}
      {s.phase === "ok" && (
        <Panel title="crypto smoke" color={s.r.ok ? theme.ok : theme.err}>
          <Status ok={s.r.ok} label={s.r.note} pad={0} />
          <Box marginTop={1}>
            <KV
              full
              rows={[
                ["identity ", s.r.identity],
                ["publicKey", s.r.publicKeyHex],
              ]}
            />
          </Box>
        </Panel>
      )}
    </Box>
  );
}
