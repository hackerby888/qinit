import { expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EngineServer } from "@qinit/engine/server";
import { LiteRpc } from "@qinit/core";
import {
  callFunction,
  invokeProcedure,
  TX_TICK_OFFSET,
} from "@qinit/proto";
import { deployProjectContracts } from "../../src/ops/project-deploy";

const core = process.env.QINIT_CORE?.trim();
const haveCore = !!core && existsSync(join(core, "src", "qpi", "qpi.h"));
const canListen = (() => {
  try {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    probe.stop(true);
    return true;
  } catch {
    return false;
  }
})();

test.skipIf(!haveCore || !canListen)(
  "project deploy auto-slots, deploys, and reuses a custom callee",
  async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "qinit-project-deploy-"));
    const contractsDir = join(projectRoot, "contracts");
    const outDir = join(projectRoot, "dist");
    const counterPath = join(contractsDir, "Counter.h");
    const proxyPath = join(contractsDir, "Proxy.h");
    mkdirSync(contractsDir);
    copyFileSync(
      resolve(import.meta.dir, "../../../../fixtures/Counter.h"),
      counterPath,
    );
    copyFileSync(
      resolve(import.meta.dir, "../../../../fixtures/Proxy.h"),
      proxyPath,
    );

    const server = new EngineServer();
    const handle = await server.start(0);
    const rpc = new LiteRpc(handle.rpcBaseUrl);
    const deploy = () => deployProjectContracts(
      {
        projectRoot,
        contractPath: proxyPath,
        name: "Proxy",
        core: core!,
        rpcBaseUrl: handle.rpcBaseUrl,
        outDir,
        compiler: "typescript",
        rpc,
      },
      () => {},
    );

    try {
      const validProxySource = readFileSync(proxyPath, "utf8");
      writeFileSync(
        proxyPath,
        validProxySource.replace("output.value =", "output.missing ="),
      );
      const failedBuild = await deploy();
      expect(failedBuild.ok).toBe(false);
      expect(failedBuild.deployments).toEqual([]);
      expect(
        (await rpc.dynRegistry()).contracts.some((contract) => contract.armed),
      ).toBe(false);
      writeFileSync(proxyPath, validProxySource);

      const first = await deploy();
      expect(first.ok).toBe(true);
      expect(first.deployments.map(({ name, kind, action }) => ({
        name,
        kind,
        action,
      }))).toEqual([
        { name: "Counter", kind: "custom", action: "deployed" },
        { name: "Proxy", kind: "main", action: "deployed" },
      ]);

      const counter = first.deployments[0];
      const proxy = first.deployments[1];
      expect(counter.slot).toBeLessThan(proxy.slot);
      expect(
        BigInt(await callFunction(rpc, proxy.slot, 1, "", "uint64")),
      ).toBe(0n);

      const tick = (await rpc.tickInfo()).tick + TX_TICK_OFFSET;
      const invoked = await invokeProcedure({
        seed: "a".repeat(55),
        rpcBaseUrl: handle.rpcBaseUrl,
        contractIndex: proxy.slot,
        procedureId: 1,
        amount: 0,
        inputFormat: "",
        tick,
        confirm: true,
        rpc,
      });
      expect(invoked.included).toBe(true);
      expect(
        BigInt(await callFunction(rpc, proxy.slot, 1, "", "uint64")),
      ).toBe(1n);

      const second = await deploy();
      expect(second.ok).toBe(true);
      expect(second.deployments[0]).toMatchObject({
        name: "Counter",
        action: "skipped",
      });
      expect(second.deployments[1]).toMatchObject({
        name: "Proxy",
        action: "updated",
      });

      writeFileSync(
        counterPath,
        readFileSync(counterPath, "utf8").replace("+= 1", "+= 2"),
      );
      const third = await deploy();
      expect(third.ok).toBe(true);
      expect(third.deployments[0]).toMatchObject({
        name: "Counter",
        slot: counter.slot,
        action: "updated",
      });
      const nextTick = (await rpc.tickInfo()).tick + TX_TICK_OFFSET;
      await invokeProcedure({
        seed: "a".repeat(55),
        rpcBaseUrl: handle.rpcBaseUrl,
        contractIndex: proxy.slot,
        procedureId: 1,
        amount: 0,
        inputFormat: "",
        tick: nextTick,
        confirm: true,
        rpc,
      });
      expect(
        BigInt(await callFunction(rpc, proxy.slot, 1, "", "uint64")),
      ).toBe(3n);
    } finally {
      handle.stop();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  },
  120_000,
);
