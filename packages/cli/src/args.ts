import { parseArgs as parseNodeArgs } from "node:util";
import {
  META,
  commandOptions,
  type CommandMeta,
  type CommandName,
  type OptionMeta,
} from "./meta";

export const output = { json: false, plain: false };

export function initOutput(args: string[]): void {
  output.json = args.includes("--json");
  output.plain =
    output.json ||
    args.includes("--plain") ||
    !process.stdout.isTTY ||
    !!process.env.NO_COLOR;
}

export interface CommandArguments {
  readonly positionals: readonly string[];
  has(name: string): boolean;
  get(name: string): string | undefined;
  getAll(name: string): readonly string[];
}

export interface CommandInvocation {
  readonly command: CommandName;
  readonly subcommand?: string;
  readonly commandArgs: CommandArguments;
}

interface ParseOptions {
  strings?: readonly string[];
  booleans?: readonly string[];
  multi?: readonly string[];
}

function parseOptionsFromMetadata(options: readonly OptionMeta[]): ParseOptions {
  return {
    strings: options
      .filter((option) => option.type === "string" && !option.multiple)
      .map((option) => option.name),
    booleans: options
      .filter((option) => option.type === "boolean")
      .map((option) => option.name),
    multi: options
      .filter((option) => option.type === "string" && option.multiple)
      .map((option) => option.name),
  };
}

function optionDefinitions(options: ParseOptions) {
  const definitions: Record<
    string,
    { type: "string" | "boolean"; multiple?: boolean; short?: string }
  > = {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
    plain: { type: "boolean" },
  };

  for (const name of options.strings ?? []) {
    definitions[name] = { type: "string" };
  }
  for (const name of options.booleans ?? []) {
    definitions[name] = { type: "boolean" };
  }
  for (const name of options.multi ?? []) {
    definitions[name] = { type: "string", multiple: true };
  }

  return definitions;
}

function findSubcommandCandidate(
  args: readonly string[],
  meta: CommandMeta,
): { name: string; index: number } | undefined {
  if (!meta.subcommands) {
    return undefined;
  }

  const options = [
    ...(meta.options ?? []),
    ...Object.values(meta.subcommands).flatMap((subcommand) => subcommand.options),
  ];
  const { tokens } = parseNodeArgs({
    args: [...args],
    options: optionDefinitions(parseOptionsFromMetadata(options)),
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  for (const token of tokens) {
    if (token.kind === "option-terminator") {
      return undefined;
    }
    if (token.kind !== "positional") {
      continue;
    }
    return { name: token.value, index: token.index };
  }

  return undefined;
}

export function parseCommandInvocation(
  command: CommandName,
  args: readonly string[],
): CommandInvocation {
  const meta: CommandMeta = META[command];
  const candidate = findSubcommandCandidate(args, meta);
  const subcommand =
    candidate &&
    meta.subcommands &&
    Object.prototype.hasOwnProperty.call(meta.subcommands, candidate.name)
      ? candidate.name
      : undefined;
  const options = commandOptions(command, subcommand);
  const scopedArgs =
    subcommand && candidate
      ? [
          ...args.slice(0, candidate.index),
          ...args.slice(candidate.index + 1),
        ]
      : args;
  const commandArgs = parseArgs(scopedArgs, parseOptionsFromMetadata(options));
  if (candidate && !subcommand && commandArgs.has("help")) {
    invalidArgs(`unknown subcommand '${candidate.name}' for '${command}'`);
  }
  return {
    command,
    subcommand,
    commandArgs,
  };
}

export function parseArgs(
  args: readonly string[],
  options: ParseOptions = {},
): CommandArguments {
  const { values, positionals } = parseNodeArgs({
    args: [...args],
    options: optionDefinitions(options),
    allowPositionals: true,
    strict: true,
  });

  const scalarValues = new Map<string, string>();
  const repeatedValues = new Map<string, readonly string[]>();
  const present = new Set<string>();
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === false) {
      continue;
    }
    present.add(name);
    if (Array.isArray(value)) {
      repeatedValues.set(name, value.map(String));
    } else if (typeof value !== "boolean") {
      scalarValues.set(name, String(value));
    }
  }

  return {
    positionals,
    has: (name) => present.has(name),
    get: (name) => scalarValues.get(name),
    getAll: (name) => repeatedValues.get(name) ?? [],
  };
}

export function invalidArgs(message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = "ERR_PARSE_ARGS_INVALID_POSITIONAL";
  throw error;
}

function editDistance(left: string, right: string): number {
  const leftLength = left.length;
  const rightLength = right.length;
  const distances: number[][] = Array.from(
    { length: leftLength + 1 },
    () => new Array(rightLength + 1).fill(0),
  );

  for (let i = 0; i <= leftLength; i++) {
    distances[i][0] = i;
  }
  for (let j = 0; j <= rightLength; j++) {
    distances[0][j] = j;
  }

  for (let i = 1; i <= leftLength; i++) {
    for (let j = 1; j <= rightLength; j++) {
      distances[i][j] = Math.min(
        distances[i - 1][j] + 1,
        distances[i][j - 1] + 1,
        distances[i - 1][j - 1] +
          (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
  }

  return distances[leftLength][rightLength];
}

export function nearest(input: string, options: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;

  for (const option of options) {
    const distance = editDistance(input, option);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = option;
    }
  }

  const threshold = Math.max(2, Math.ceil(input.length * 0.4));
  return best && bestDistance <= threshold ? best : undefined;
}
