// Standalone runnable: serve an InProcessEngine on the Qubic peer protocol for qubic-cli. Run with
//   bun packages/engine/src/peer-main.ts [port]
// then point the cli at it:
//   qubic-cli -nodeip 127.0.0.1 -nodeport 21841 -gettick
import { PeerServer } from "./peer-server";
import { InProcessEngine } from "./transport";

const port = Number(process.argv[2] ?? 21841);
const server = new PeerServer(new InProcessEngine());
const handle = await server.start(port);

console.log(`qubic-cli peer bridge listening on 127.0.0.1:${handle.port}`);
