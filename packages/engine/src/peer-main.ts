// Standalone runnable: serve an InProcessEngine on the Qubic peer protocol for qubic-cli. Run with
//   bun packages/engine/src/peer-main.ts [port] [tickMs]
// then point the cli at it:
//   qubic-cli -nodeip 127.0.0.1 -nodeport 21841 -getcurrenttick
import { PeerServer } from "./peer-server";
import { InProcessEngine } from "./transport";

const port = Number(process.argv[2] ?? 21841);
const tickMs = process.argv[3] ? Number(process.argv[3]) : undefined;
const server = new PeerServer(new InProcessEngine());
const handle = await server.start(port, tickMs);

console.log(`qubic-cli peer bridge listening on 127.0.0.1:${handle.port} (tick ${handle.tickMs}ms)`);
