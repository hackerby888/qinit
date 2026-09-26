// loaded ahead of every test file. A node refuses a module whose io region is smaller than core's, and the fixtures are built with a 1 MiB
// arena: at core's 1 GiB each live instance takes over a GiB of the engine's wasm budget, and the suite runs out of it.
import { VirtualNode } from "@qinit/engine";

VirtualNode.defaultMinIoBytes = 0;
