import {
  NODE_BACKENDS,
  savedNodeBackend,
  setSavedNodeBackend,
  type NodeBackend,
} from "../config";
import { BackendPicker } from "./backend-picker";

const DESC: Record<NodeBackend, string> = {
  core: "core-lite node reached through RPC (`qinit node run` can launch one)",
  simulator: "in-process Qinit simulator (no node binary)",
};

export function NodeBackendCmd({ args }: { args: string[] }) {
  return (
    <BackendPicker
      args={args}
      command="node-backend"
      label="node backend"
      backends={NODE_BACKENDS}
      descriptions={DESC}
      current={savedNodeBackend() ?? "core"}
      width={12}
      save={setSavedNodeBackend}
    />
  );
}
