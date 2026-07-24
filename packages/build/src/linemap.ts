import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export interface LineEntry {
  off: number;
  file: string;
  line: number;
  col: number;
  func: string;
}

export interface LineMap {
  base: number;
  entries: LineEntry[];
}

function runTool(binary: string, args: string[]): string | null {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    maxBuffer: 256 << 20,
  });

  return result.status === 0 ? result.stdout : null;
}

export function buildLineMap(
  wasm: string,
  tools: { objdump: string; dwarfdump: string },
): LineMap | null {
  const disassembly = runTool(tools.objdump, ["-d", wasm]);
  const debugInfo = runTool(tools.dwarfdump, ["--debug-info", wasm]);
  const debugLines = runTool(tools.dwarfdump, ["--debug-line", wasm]);

  if (!disassembly || !debugInfo || !debugLines) {
    return null;
  }

  const labels: [number, string][] = [];

  for (const line of disassembly.split("\n")) {
    const match = line.match(/^([0-9a-fA-F]+) <(.+?)>:/);
    if (match && match[2] !== "CODE") {
      labels.push([parseInt(match[1], 16), match[2]]);
    }
  }
  labels.sort((a, b) => a[0] - b[0]);

  const subprograms: { low?: number; name?: string }[] = [];
  let currentSubprogram: { low?: number; name?: string } | null = null;

  for (const line of debugInfo.split("\n")) {
    if (line.includes("DW_TAG_subprogram")) {
      currentSubprogram = {};
      subprograms.push(currentSubprogram);
      continue;
    }

    if (!currentSubprogram) {
      continue;
    }

    const lowPc = line.match(/DW_AT_low_pc\s+\(0x([0-9a-fA-F]+)\)/);
    if (lowPc && currentSubprogram.low === undefined) {
      currentSubprogram.low = parseInt(lowPc[1], 16);
    }

    const name = line.match(/DW_AT_name\s+\("(.+?)"\)/);
    if (name && currentSubprogram.name === undefined) {
      currentSubprogram.name = name[1];
    }
  }

  const offsetsByName = new Map(
    labels.map(([offset, name]) => [name, offset]),
  );
  const votes = new Map<number, number>();

  // Use the dominant offset to ignore duplicate-name DWARF outliers.
  for (const subprogram of subprograms) {
    if (
      subprogram.low === undefined ||
      !subprogram.name ||
      !offsetsByName.has(subprogram.name)
    ) {
      continue;
    }

    const candidateBase =
      offsetsByName.get(subprogram.name)! - subprogram.low;
    votes.set(candidateBase, (votes.get(candidateBase) ?? 0) + 1);
  }

  if (votes.size === 0) {
    return null;
  }

  let base = 0;
  let bestVotes = -1;

  for (const [candidateBase, count] of votes) {
    if (count > bestVotes) {
      bestVotes = count;
      base = candidateBase;
    }
  }

  const entries: LineEntry[] = [];
  const functionAt = (offset: number): string => {
    let name = "?";

    for (const [labelOffset, labelName] of labels) {
      if (labelOffset > offset) {
        break;
      }

      name = labelName;
    }

    return name;
  };

  let files = new Map<number, string>();
  let pendingFile: number | null = null;
  let inRows = false;

  // File indexes restart for each debug-line compilation unit.
  for (const line of debugLines.split("\n")) {
    if (/debug_line\[0x/.test(line)) {
      files = new Map();
      pendingFile = null;
      inRows = false;
      continue;
    }

    const fileIndex = line.match(/file_names\[\s*(\d+)\]/);
    if (fileIndex) {
      pendingFile = Number(fileIndex[1]);
      continue;
    }

    if (pendingFile !== null) {
      const fileName = line.match(/name:\s+"(.+?)"/);
      if (fileName) {
        files.set(pendingFile, fileName[1]);
        pendingFile = null;
      }
      continue;
    }

    if (/^Address\s+Line\s+Column\s+File/.test(line)) {
      inRows = true;
      continue;
    }

    if (!inRows) {
      continue;
    }

    const row = line.match(
      /^\s*0x([0-9a-fA-F]{16})\s+(\d+)\s+(\d+)\s+(\d+)/,
    );
    if (!row || Number(row[2]) === 0) {
      continue;
    }

    const offset = parseInt(row[1], 16) + base;
    entries.push({
      off: offset,
      file: files.get(Number(row[4])) ?? "",
      line: Number(row[2]),
      col: Number(row[3]),
      func: functionAt(offset),
    });
  }

  entries.sort((a, b) => a.off - b.off);
  return { base, entries };
}

export function writeLineMap(
  wasm: string,
  outJson: string,
  tools: { objdump: string; dwarfdump: string },
): boolean {
  const lineMap = buildLineMap(wasm, tools);
  if (!lineMap) {
    return false;
  }

  writeFileSync(outJson, JSON.stringify(lineMap));
  return true;
}
