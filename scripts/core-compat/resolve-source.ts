import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface SourceConfig {
    repository: string;
    developmentRef: string;
    pinnedCommit: string;
}

interface ResolveOptions {
    source: SourceConfig;
    repositoryOverride?: string;
    refOverride?: string;
}

export interface ResolvedSource {
    repository: string;
    ref: string;
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

    const pinnedCommit = options.source.pinnedCommit.trim();
    if (!refOverride && pinnedCommit && !commitPattern.test(pinnedCommit)) {
        throw new Error("pinnedCommit must be empty or a full lowercase commit SHA");
    }

    const developmentRef = options.source.developmentRef.trim();
    const ref = refOverride || pinnedCommit || developmentRef;
    if (!ref) {
        throw new Error("developmentRef must not be empty when pinnedCommit is empty");
    }

    return { repository, ref };
}

if (import.meta.main) {
    const repositories = JSON.parse(readFileSync(resolve("config/repositories.json"), "utf8")) as {
        coreLite: SourceConfig;
    };
    const source = resolveSource({
        source: repositories.coreLite,
        repositoryOverride: process.env.CORE_REPOSITORY,
        refOverride: process.env.CORE_REF,
    });

    const lines = [`repository=${source.repository}`, `ref=${source.ref}`];
    const output = process.env.GITHUB_OUTPUT;
    if (output) {
        appendFileSync(output, `${lines.join("\n")}\n`);
    } else {
        console.log(lines.join("\n"));
    }
}
