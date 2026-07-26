import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface SourceConfig {
  repository: string;
  developmentRef: string;
  pinnedCommit: string;
}

interface ResolveOptions {
  source: SourceConfig;
  requestedMode?: string;
  repositoryMode?: string;
  eventName?: string;
  repositoryOverride?: string;
  refOverride?: string;
}

export interface ResolvedSource {
  repository: string;
  ref: string;
  mode: "latest" | "pinned" | "override";
}

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const commitPattern = /^[0-9a-f]{40}$/;

export function resolveSource(options: ResolveOptions): ResolvedSource {
  const repositoryOverride = options.repositoryOverride?.trim() ?? "";
  const refOverride = options.refOverride?.trim() ?? "";

  if (repositoryOverride && !refOverride) {
    throw new Error("a repository override requires a ref override");
  }

  const repository = repositoryOverride || options.source.repository;
  if (!repositoryPattern.test(repository)) {
    throw new Error(`invalid GitHub repository: ${repository}`);
  }

  if (refOverride) {
    return { repository, ref: refOverride, mode: "override" };
  }

  let mode = options.requestedMode?.trim() || "default";
  if (mode === "default") {
    mode =
      options.eventName === "schedule"
        ? "latest"
        : options.repositoryMode?.trim() || "latest";
  }

  if (mode === "latest") {
    return {
      repository,
      ref: options.source.developmentRef,
      mode,
    };
  }

  if (mode === "pinned") {
    if (!commitPattern.test(options.source.pinnedCommit)) {
      throw new Error("pinnedCommit must be a full lowercase commit SHA");
    }
    return {
      repository,
      ref: options.source.pinnedCommit,
      mode,
    };
  }

  throw new Error(`invalid compatibility mode: ${mode}`);
}

if (import.meta.main) {
  const repositories = JSON.parse(
    readFileSync(resolve("config/repositories.json"), "utf8"),
  ) as { coreLite: SourceConfig };
  const source = resolveSource({
    source: repositories.coreLite,
    requestedMode: process.env.COMPAT_MODE,
    repositoryMode: process.env.REPOSITORY_COMPAT_MODE,
    eventName: process.env.GITHUB_EVENT_NAME,
    repositoryOverride: process.env.CORE_REPOSITORY,
    refOverride: process.env.CORE_REF,
  });

  const lines = [
    `repository=${source.repository}`,
    `ref=${source.ref}`,
    `mode=${source.mode}`,
  ];
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `${lines.join("\n")}\n`);
  } else {
    console.log(lines.join("\n"));
  }
}
