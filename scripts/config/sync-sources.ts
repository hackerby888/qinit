import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface RepositoriesConfig {
  qinit: {
    repository: string;
    defaultBranch: string;
  };
  coreLite: {
    repository: string;
    developmentRef: string;
    pinnedCommit: string;
  };
}

interface ToolchainsConfig {
  bun: { version: string };
  wasiSdk: {
    repository: string;
    releaseTag: string;
    assetVersion: string;
  };
  clangd: { repository: string; version: string };
  contractVerifier: { repository: string };
  qubicCli: { repository: string };
  qlogging: { repository: string };
}

interface Edit {
  pattern: RegExp;
  replacement: string;
  count?: number;
}

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const valuePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const commitPattern = /^[0-9a-f]{40}$/;

export const synchronizedSourceFiles = [
  "README.md",
  "AGENTS.md",
  "docs/BROWSER_COMPILER_INTEGRATION.md",
  "install.sh",
  "install.ps1",
  "package.json",
  "packages/vscode/package.json",
  ".github/workflows/test.yml",
  ".github/workflows/release.yml",
  ".github/workflows/release-vscode.yml",
  ".github/workflows/verify-tool.yml",
] as const;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${String(error)}`);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requireValue(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`invalid ${name}: ${String(value)}`);
  }
  return value;
}

export function loadSourceConfig(root: string): {
  repositories: RepositoriesConfig;
  toolchains: ToolchainsConfig;
} {
  const repositoriesJson = record(readJson(resolve(root, "config/repositories.json")));
  const toolchainsJson = record(readJson(resolve(root, "config/toolchains.json")));
  const qinit = record(repositoriesJson.qinit);
  const coreLite = record(repositoriesJson.coreLite);
  const bun = record(toolchainsJson.bun);
  const wasiSdk = record(toolchainsJson.wasiSdk);
  const clangd = record(toolchainsJson.clangd);
  const contractVerifier = record(toolchainsJson.contractVerifier);
  const qubicCli = record(toolchainsJson.qubicCli);
  const qlogging = record(toolchainsJson.qlogging);

  const qinitRepository = requireValue(
    qinit.repository,
    "qinit.repository",
    repositoryPattern,
  );
  const branch = requireValue(
    qinit.defaultBranch,
    "qinit.defaultBranch",
    branchPattern,
  );
  if (branch.includes("..") || branch.includes("//") || branch.endsWith("/")) {
    throw new Error(`invalid qinit.defaultBranch: ${branch}`);
  }
  const coreRepository = requireValue(
    coreLite.repository,
    "coreLite.repository",
    repositoryPattern,
  );
  const developmentRef = requireValue(
    coreLite.developmentRef,
    "coreLite.developmentRef",
    branchPattern,
  );
  if (
    developmentRef.includes("..") ||
    developmentRef.includes("//") ||
    developmentRef.endsWith("/")
  ) {
    throw new Error(`invalid coreLite.developmentRef: ${developmentRef}`);
  }
  const pinnedCommit = coreLite.pinnedCommit;
  if (
    typeof pinnedCommit !== "string" ||
    (pinnedCommit !== "" && !commitPattern.test(pinnedCommit))
  ) {
    throw new Error("coreLite.pinnedCommit must be empty or a full lowercase commit SHA");
  }

  const toolchains: ToolchainsConfig = {
    bun: { version: requireValue(bun.version, "bun.version", valuePattern) },
    wasiSdk: {
      repository: requireValue(wasiSdk.repository, "wasiSdk.repository", repositoryPattern),
      releaseTag: requireValue(wasiSdk.releaseTag, "wasiSdk.releaseTag", valuePattern),
      assetVersion: requireValue(wasiSdk.assetVersion, "wasiSdk.assetVersion", valuePattern),
    },
    clangd: {
      repository: requireValue(clangd.repository, "clangd.repository", repositoryPattern),
      version: requireValue(clangd.version, "clangd.version", valuePattern),
    },
    contractVerifier: {
      repository: requireValue(
        contractVerifier.repository,
        "contractVerifier.repository",
        repositoryPattern,
      ),
    },
    qubicCli: {
      repository: requireValue(qubicCli.repository, "qubicCli.repository", repositoryPattern),
    },
    qlogging: {
      repository: requireValue(qlogging.repository, "qlogging.repository", repositoryPattern),
    },
  };

  return {
    repositories: {
      qinit: { repository: qinitRepository, defaultBranch: branch },
      coreLite: {
        repository: coreRepository,
        developmentRef,
        pinnedCommit,
      },
    },
    toolchains,
  };
}

export function replaceExactly(
  source: string,
  edit: Edit,
  label: string,
): string {
  const flags = edit.pattern.flags.includes("g")
    ? edit.pattern.flags
    : `${edit.pattern.flags}g`;
  const pattern = new RegExp(edit.pattern.source, flags);
  const matches = [...source.matchAll(pattern)];
  const expected = edit.count ?? 1;
  if (matches.length !== expected) {
    throw new Error(
      `${label}: expected ${expected} match(es) for ${edit.pattern}, found ${matches.length}`,
    );
  }
  return source.replace(pattern, () => edit.replacement);
}

function editsFor(
  path: (typeof synchronizedSourceFiles)[number],
  repositories: RepositoriesConfig,
  toolchains: ToolchainsConfig,
): Edit[] {
  const qinit = repositories.qinit;
  const rawBase = `https://raw.githubusercontent.com/${qinit.repository}/${qinit.defaultBranch}`;
  const workflowValues: Record<string, string> = {
    BUN_VERSION: toolchains.bun.version,
    WASI_SDK_REPOSITORY: toolchains.wasiSdk.repository,
    WASI_SDK_RELEASE_TAG: toolchains.wasiSdk.releaseTag,
    WASI_SDK_ASSET_VERSION: toolchains.wasiSdk.assetVersion,
    CLANGD_REPOSITORY: toolchains.clangd.repository,
    CLANGD_VERSION: toolchains.clangd.version,
    QUBIC_CLI_REPOSITORY: toolchains.qubicCli.repository,
    QLOGGING_REPOSITORY: toolchains.qlogging.repository,
  };
  const workflowEdits = (...names: string[]): Edit[] =>
    names.map((name) => ({
      pattern: new RegExp(`  ${name}: "[^"\\r\\n]+"`, "g"),
      replacement: `  ${name}: "${workflowValues[name]}"`,
    }));

  switch (path) {
    case "README.md":
      return [
        {
          pattern: /curl -fsSL https:\/\/raw\.githubusercontent\.com\/[^\s]+\/install\.sh \| sh/g,
          replacement: `curl -fsSL ${rawBase}/install.sh | sh`,
        },
        {
          pattern: /irm https:\/\/raw\.githubusercontent\.com\/[^\s]+\/install\.ps1 \| iex/g,
          replacement: `irm ${rawBase}/install.ps1 | iex`,
        },
        {
          pattern: /Use Bun [A-Za-z0-9._-]+, matching CI:/g,
          replacement: `Use Bun ${toolchains.bun.version}, matching CI:`,
        },
      ];
    case "AGENTS.md":
      return [{
        pattern: /Use Bun [A-Za-z0-9._-]+, matching CI\./g,
        replacement: `Use Bun ${toolchains.bun.version}, matching CI.`,
      }];
    case "docs/BROWSER_COMPILER_INTEGRATION.md":
      return [{
        pattern: /Use Bun [A-Za-z0-9._-]+:/g,
        replacement: `Use Bun ${toolchains.bun.version}:`,
      }];
    case "install.sh":
      return [
        {
          pattern: /curl -fsSL https:\/\/raw\.githubusercontent\.com\/[^\s]+\/install\.sh \| sh/g,
          replacement: `curl -fsSL ${rawBase}/install.sh | sh`,
        },
        {
          pattern: /REPO="\$\{QINIT_REPOSITORY:-[^}]+\}"/g,
          replacement: `REPO="\${QINIT_REPOSITORY:-${qinit.repository}}"`,
        },
      ];
    case "install.ps1":
      return [{
        pattern: /\$Repo = if \(\$env:QINIT_REPOSITORY\) \{ \$env:QINIT_REPOSITORY \} else \{ "[^"]+" \}/g,
        replacement: `$Repo = if ($env:QINIT_REPOSITORY) { $env:QINIT_REPOSITORY } else { "${qinit.repository}" }`,
      }];
    case "package.json":
      return [{
        pattern: /"bun-types": "[A-Za-z0-9._-]+"/g,
        replacement: `"bun-types": "${toolchains.bun.version}"`,
      }];
    case "packages/vscode/package.json":
      return [{
        pattern: /"repository": \{ "type": "git", "url": "https:\/\/github\.com\/[^"]+\.git" \}/g,
        replacement: `"repository": { "type": "git", "url": "https://github.com/${qinit.repository}.git" }`,
      }];
    case ".github/workflows/test.yml":
      return [
        {
          pattern: /    branches: \[[A-Za-z0-9._/-]+\]/g,
          replacement: `    branches: [${qinit.defaultBranch}]`,
          count: 2,
        },
        ...workflowEdits(
          "BUN_VERSION",
          "WASI_SDK_REPOSITORY",
          "WASI_SDK_RELEASE_TAG",
          "WASI_SDK_ASSET_VERSION",
          "CLANGD_REPOSITORY",
          "CLANGD_VERSION",
          "QUBIC_CLI_REPOSITORY",
          "QLOGGING_REPOSITORY",
        ),
      ];
    case ".github/workflows/release.yml":
      return workflowEdits("BUN_VERSION");
    case ".github/workflows/release-vscode.yml":
      return workflowEdits(
        "BUN_VERSION",
        "WASI_SDK_REPOSITORY",
        "WASI_SDK_RELEASE_TAG",
        "WASI_SDK_ASSET_VERSION",
      );
    case ".github/workflows/verify-tool.yml":
      return [
        {
          pattern: /  push:\r?\n    branches:\r?\n      - [A-Za-z0-9._/-]+/g,
          replacement: `  push:\n    branches:\n      - ${qinit.defaultBranch}`,
        },
        {
          pattern: /github\.ref == 'refs\/heads\/[A-Za-z0-9._/-]+'/g,
          replacement: `github.ref == 'refs/heads/${qinit.defaultBranch}'`,
        },
      ];
  }
}

export function syncSources(
  root: string,
  check = false,
): string[] {
  const { repositories, toolchains } = loadSourceConfig(root);
  const changed: string[] = [];

  for (const relativePath of synchronizedSourceFiles) {
    const path = resolve(root, relativePath);
    const source = readFileSync(path, "utf8");
    const generated = editsFor(relativePath, repositories, toolchains).reduce(
      (text, edit) => replaceExactly(text, edit, relativePath),
      source,
    );
    if (generated === source) continue;
    changed.push(relativePath);
    if (!check) writeFileSync(path, generated);
  }

  if (check && changed.length > 0) {
    throw new Error(
      `source configuration is out of date: ${changed.join(", ")}\nRun bun run sources:sync`,
    );
  }
  if (check) {
    const lock = readFileSync(resolve(root, "bun.lock"), "utf8");
    const version = toolchains.bun.version;
    const workspaceEntry = `"bun-types": "${version}"`;
    const packageEntry = `"bun-types": ["bun-types@${version}"`;
    if (!lock.includes(workspaceEntry) || !lock.includes(packageEntry)) {
      throw new Error(`bun.lock does not match bun.version ${version}; run bun install`);
    }
  }
  return changed;
}

if (import.meta.main) {
  const check = process.argv.slice(2).includes("--check");
  const root = resolve(import.meta.dir, "../..");
  try {
    const changed = syncSources(root, check);
    console.log(changed.length > 0 ? `updated ${changed.join(", ")}` : "source configuration is current");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
