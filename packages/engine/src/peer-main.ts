// Standalone runnable: serve an InProcessEngine over the Qubic peer protocol (Bun.listen). Run with
//   bun packages/engine/src/peer-main.ts [port] [tickMs]
import { PeerServer } from "./peer-server";
import { InProcessEngine } from "./transport";

const port = Number(process.argv[2] ?? 21841);
const tickMs = process.argv[3] ? Number(process.argv[3]) : undefined;
const server = new PeerServer(new InProcessEngine({ mempool: true }));
const handle = await server.start(port, tickMs);

console.log(`peer protocol listening on 127.0.0.1:${handle.port} (tick ${handle.tickMs}ms)`);
