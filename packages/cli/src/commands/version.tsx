import { useEffect } from "react";
import { Text, useApp } from "ink";
import { VERSION } from "../version";

export function Version() {
  const { exit } = useApp();
  useEffect(() => { exit(); }, [exit]);
  return <Text>qinit {VERSION}</Text>;
}
