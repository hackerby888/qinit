import { useEffect } from "react";
import { useApp } from "ink";
import { VERSION } from "../version";
import { Banner } from "../ui";

export function Version() {
  const { exit } = useApp();
  useEffect(() => { exit(); }, [exit]);
  return <Banner version={VERSION} tagline="Anchor-like framework for Qubic dynamic contracts" />;
}
