// Build a source-line map for trap backtraces from objdump and DWARF output.
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

function run(bin: string, args: string[]): string | null {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 256 << 20 });
  return result.status === 0 ? result.stdout : null;
}

export function buildLineMap(wasm: string, tools: { objdump: string; dwarfdump: string }): LineMap | null {
  const disassembly = run(tools.objdump, ["-d", wasm]);
  const debugInfo = run(tools.dwarfdump, ["--debug-info", wasm]);
  const debugLines = run(tools.dwarfdump, ["--debug-line", wasm]);
  if (!disassembly || !debugInfo || !debugLines) return null;

  // function file-starts + names from objdump labels (e.g. "000000c9 <do_div>:")
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
    } else if (currentSubprogram) {
      const lowPc = line.match(/DW_AT_low_pc\s+\(0x([0-9a-fA-F]+)\)/);
      if (lowPc && currentSubprogram.low === undefined) {
        currentSubprogram.low = parseInt(lowPc[1], 16);
      }
      const name = line.match(/DW_AT_name\s+\("(.+?)"\)/);
      if (name && currentSubprogram.name === undefined) {
        currentSubprogram.name = name[1];
      }
    }
  }
  const byName = new Map(labels.map(([o, n]) => [n, o]));
  // base = (objdump function file-start) − (DW_AT_low_pc), the same constant for every function. A few
  // entries can disagree (duplicate names, odd local-decl encodings), so take the MODE: the dominant value.
  const votes = new Map<number, number>();
  for (const subprogram of subprograms) {
    if (subprogram.low === undefined || !subprogram.name || !byName.has(subprogram.name)) continue;
    const candidateBase = byName.get(subprogram.name)! - subprogram.low;
    votes.set(candidateBase, (votes.get(candidateBase) ?? 0) + 1);
  }
  if (!votes.size) return null;
  let base = 0;
  let bestVotes = -1;
  for (const [candidateBase, count] of votes) {
    if (count > bestVotes) {
      bestVotes = count;
      base = candidateBase;
    }
  }

  // --debug-line emits one program per CU; file_names indices are PER-program, so reset the file table at
  // each `debug_line[0x..]` boundary and resolve each row's File column against its own program's table.
  const entries: LineEntry[] = [];
  const functionAt = (offset: number) => {
    let name = "?";
    for (const [labelOffset, labelName] of labels) {
      if (labelOffset <= offset) name = labelName;
      else break;
    }
    return name;
  };
  let files = new Map<number, string>();
  let pendingFile: number | null = null;
  let inRows = false;
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
    if (!inRows) continue;
    const row = line.match(/^\s*0x([0-9a-fA-F]{16})\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (!row || Number(row[2]) === 0) continue;
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
  const lm = buildLineMap(wasm, tools);
  if (!lm) return false;
  writeFileSync(outJson, JSON.stringify(lm));
  return true;
}
