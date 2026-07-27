import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContract } from "@qinit/build";
import { initK12 } from "@qinit/core";
import { wasiSdkPaths } from "@qinit/core/project";
import { Sim } from "@qinit/engine";
import {
  compileContract,
  DiagnosticSeverity,
  loadQpiHeader,
} from "../src/index";

interface FuzzContract {
  seed: number;
  source: string;
  inputs: bigint[][];
}

interface FuzzRunnerOptions {
  corePath: string;
  contractPrefix: string;
  findingsDirectory: string;
  tempPrefix: string;
  generate: (seed: number) => FuzzContract;
  encodeInput: (row: bigint[]) => Uint8Array;
}

interface Finding {
  seed: number;
  kind:
    | "ours-compile-error"
    | "ours-runtime-error"
    | "native-build-fail"
    | "native-runtime-error"
    | "state-mismatch";
  detail: string;
  ours?: string;
  native?: string;
  firstDiff?: number;
  inputs: string[][];
}

interface RunnerArguments {
  count: number;
  startSeed: number;
  jobs: number;
  oursOnly: boolean;
}

function parseArguments(argv: string[]): RunnerArguments {
  const positional = argv.filter((argument) => !argument.startsWith("--"));
  const jobsIndex = argv.indexOf("--jobs");

  return {
    count: Number(positional[0] ?? 100),
    startSeed: Number(positional[1] ?? 1),
    jobs: jobsIndex >= 0 ? Number(argv[jobsIndex + 1]) : 4,
    oursOnly: argv.includes("--ours-only"),
  };
}

function isWasiAvailable(oursOnly: boolean): boolean {
  if (oursOnly) {
    return false;
  }

  try {
    const paths = wasiSdkPaths();
    return Boolean(paths && existsSync(paths.clang));
  } catch {
    return false;
  }
}

function runState(
  wasm: Uint8Array,
  contract: FuzzContract,
  encodeInput: FuzzRunnerOptions["encodeInput"],
): string {
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  const user = new Uint8Array(32).fill(7);
  sim.fund(user, 1_000_000n);
  sim.deploy(27, wasm);

  for (const row of contract.inputs) {
    sim.procedure(27, 1, encodeInput(row), { invocator: user });
  }

  const state = sim.contracts.get(27)!.state();
  return Buffer.from(state.slice(0, 64)).toString("hex");
}

async function checkSeed(
  contract: FuzzContract,
  headers: string,
  wasiAvailable: boolean,
  options: FuzzRunnerOptions,
): Promise<Finding | null> {
  const inputs = contract.inputs.map((row) =>
    row.map((value) => `0x${value.toString(16)}`),
  );

  let oursHex: string;
  try {
    const ours = await compileContract({
      source: contract.source,
      name: `${options.contractPrefix}${contract.seed}`,
      slot: 27,
      qpiHeader: headers,
      arenaSz: 1 << 20,
    });
    const errors = ours.diagnostics.filter(
      (diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR,
    );
    if (errors.length > 0) {
      return {
        seed: contract.seed,
        kind: "ours-compile-error",
        detail: errors.map((error) => error.message).join(" | "),
        inputs,
      };
    }
    oursHex = runState(ours.wasm, contract, options.encodeInput);
  } catch (error) {
    return {
      seed: contract.seed,
      kind: "ours-runtime-error",
      detail: (error as Error).message,
      inputs,
    };
  }

  if (!wasiAvailable) {
    return null;
  }

  const directory = mkdtempSync(
    join(tmpdir(), `${options.tempPrefix}-${contract.seed}-`),
  );
  const contractPath = join(directory, `${options.contractPrefix}.h`);

  try {
    writeFileSync(contractPath, contract.source);
    const built = await buildContract({
      contractPath,
      name: options.contractPrefix,
      slot: 27,
      corePath: options.corePath,
      outDir: directory,
      skipVerify: true,
    });
    if (!built.ok) {
      return {
        seed: contract.seed,
        kind: "native-build-fail",
        detail: built.stderr ?? "unknown",
        ours: oursHex,
        inputs,
      };
    }

    let nativeHex: string;
    try {
      nativeHex = runState(
        new Uint8Array(readFileSync(built.so!)),
        contract,
        options.encodeInput,
      );
    } catch (error) {
      return {
        seed: contract.seed,
        kind: "native-runtime-error",
        detail: (error as Error).message,
        ours: oursHex,
        inputs,
      };
    }

    if (nativeHex === oursHex) {
      return null;
    }

    let firstDiff = 0;
    while (
      firstDiff < 64 &&
      oursHex.slice(firstDiff * 2, firstDiff * 2 + 2) ===
        nativeHex.slice(firstDiff * 2, firstDiff * 2 + 2)
    ) {
      firstDiff++;
    }
    return {
      seed: contract.seed,
      kind: "state-mismatch",
      detail: `state differs from byte ${firstDiff} (field f${firstDiff >> 3})`,
      ours: oursHex,
      native: nativeHex,
      firstDiff,
      inputs,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function runFuzzer(options: FuzzRunnerOptions): Promise<void> {
  const { count, startSeed, jobs, oursOnly } = parseArguments(
    process.argv.slice(2),
  );
  const wasiAvailable = isWasiAvailable(oursOnly);
  const headers = loadQpiHeader(options.corePath);
  const findingsDirectory = join(import.meta.dir, options.findingsDirectory);

  await initK12();
  mkdirSync(findingsDirectory, { recursive: true });

  const seeds = Array.from({ length: count }, (_, index) => startSeed + index);
  const findings: Finding[] = [];
  let completed = 0;
  let cursor = 0;
  const startedAt = performance.now();

  async function worker(): Promise<void> {
    while (cursor < seeds.length) {
      const seed = seeds[cursor++];
      const contract = options.generate(seed);
      const finding = await checkSeed(
        contract,
        headers,
        wasiAvailable,
        options,
      );

      if (finding) {
        findings.push(finding);
        writeFileSync(
          join(findingsDirectory, `seed-${seed}.json`),
          JSON.stringify(finding, null, 2),
        );
        writeFileSync(
          join(findingsDirectory, `seed-${seed}.h`),
          contract.source,
        );
        console.log(
          `seed ${seed}: ${finding.kind} — ${finding.detail.slice(0, 120)}`,
        );
      }

      completed++;
      if (completed % 25 === 0) {
        const rate = completed / ((performance.now() - startedAt) / 1000);
        console.log(
          `[${completed}/${count}] ${findings.length} findings, ${rate.toFixed(1)} seeds/s`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: jobs }, worker));

  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  const findingsByKind = new Map<string, number>();
  for (const finding of findings) {
    findingsByKind.set(
      finding.kind,
      (findingsByKind.get(finding.kind) ?? 0) + 1,
    );
  }

  console.log(
    `\nseeds ${startSeed}..${startSeed + count - 1}: ${count - findings.length} clean, ${findings.length} findings in ${seconds}s (native: ${wasiAvailable ? "on" : "off"})`,
  );
  for (const [kind, total] of findingsByKind) {
    console.log(`  ${kind}: ${total}`);
  }

  process.exit(findings.length > 0 ? 1 : 0);
}
