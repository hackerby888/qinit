import {
  NODE_RUNTIMES,
  savedRuntime,
  setSavedRuntime,
  type NodeRuntime,
} from "../../config";
import type { CommandArguments } from "../../args";
import { BackendPicker } from "./backend-picker";

const DESC: Record<NodeRuntime, string> = {
  core: "core-lite node reached through RPC (`qinit node run` can launch one)",
  simulator: "in-process Qinit simulator (no node binary)",
};

export function RuntimeCmd({ commandArgs }: { commandArgs: CommandArguments }) {
  return (
    <BackendPicker
      commandArgs={commandArgs}
      command="runtime"
      label="runtime"
      backends={NODE_RUNTIMES}
      descriptions={DESC}
      current={savedRuntime() ?? "core"}
      width={12}
      save={setSavedRuntime}
    />
  );
}
