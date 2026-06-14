import { useEffect } from "react";
import { useApp } from "ink";
import { VERSION } from "../version";
import { Banner } from "../ui";
import { output } from "../args";

export function Version() {
  const { exit } = useApp();
  useEffect(() => {
    if (output.json) process.stdout.write(JSON.stringify({ version: VERSION }) + "\n");
    exit();
  }, [exit]);
  if (output.json) return null;
  return <Banner version={VERSION} tagline="Framework for Qubic dynamic contracts" />;
}
