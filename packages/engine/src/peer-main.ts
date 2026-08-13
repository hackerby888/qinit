// Standalone runnable: serve an VirtualNode over the Qubic peer protocol (Bun.listen). Run with
//   bun packages/engine/src/peer-main.ts [port] [tickMs]
import { DEFAULT_PEER_PORT, LOOPBACK_HOST } from "@qinit/core";
import { PeerServer } from "./peer-server";
import { VirtualNode } from "./transport";

const port = Number(process.argv[2] ?? DEFAULT_PEER_PORT);
const tickMs = process.argv[3] ? Number(process.argv[3]) : undefined;
const server = new PeerServer(new VirtualNode({ mempool: true, verifySigs: true }));
const handle = await server.start(port, tickMs);

console.log(`peer protocol listening on ${LOOPBACK_HOST}:${handle.port} (tick ${handle.tickMs}ms)`);
