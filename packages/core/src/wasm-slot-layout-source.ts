export interface WasmSlotLayout {
  slotBase: number;
  slotCount: number;
}

const STANDARD_PROFILE = new Map<string, string>([
  ["TESTNET", "1"],
  ["TESTNET_LITE_RAM", "1"],
  ["LITE_WASM_SC", "1"],
]);

interface ConditionalFrame {
  parentActive: boolean;
  branchTaken: boolean;
  active: boolean;
}

function evaluateIntegerExpression(
  expression: string,
  values: ReadonlyMap<string, string>,
  resolving: Set<string> = new Set(),
): number {
  const source = expression
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/, "")
    .trim();
  let position = 0;

  const skipWhitespace = () => {
    while (/\s/.test(source[position] ?? "")) position++;
  };

  const parsePrimary = (): number => {
    skipWhitespace();
    if (source[position] === "(") {
      position++;
      const value = parseExpression();
      skipWhitespace();
      if (source[position] !== ")") {
        throw new Error(`unterminated integer expression '${expression}'`);
      }
      position++;
      return value;
    }

    const numberMatch = /^(?:0x[0-9a-f]+|\d+)[uUlL]*/i.exec(source.slice(position));
    if (numberMatch) {
      position += numberMatch[0].length;
      return Number.parseInt(numberMatch[0].replace(/[uUlL]+$/g, ""), 0);
    }

    const identifierMatch = /^[A-Za-z_]\w*/.exec(source.slice(position));
    if (!identifierMatch) {
      throw new Error(`unsupported integer expression '${expression}'`);
    }
    const name = identifierMatch[0];
    position += name.length;
    const replacement = values.get(name);
    if (replacement === undefined) {
      throw new Error(`unknown integer identifier '${name}' in '${expression}'`);
    }
    if (resolving.has(name)) {
      throw new Error(`cyclic integer definition involving '${name}'`);
    }
    const nextResolving = new Set(resolving);
    nextResolving.add(name);
    return evaluateIntegerExpression(replacement, values, nextResolving);
  };

  const parseUnary = (): number => {
    skipWhitespace();
    if (source[position] === "+") {
      position++;
      return parseUnary();
    }
    if (source[position] === "-") {
      position++;
      return -parseUnary();
    }
    return parsePrimary();
  };

  const parseExpression = (): number => {
    let value = parseUnary();
    while (true) {
      skipWhitespace();
      const operator = source[position];
      if (operator !== "+" && operator !== "-") break;
      position++;
      const right = parseUnary();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };

  const value = parseExpression();
  skipWhitespace();
  if (position !== source.length || !Number.isSafeInteger(value)) {
    throw new Error(`unsupported integer expression '${expression}'`);
  }
  return value;
}

function evaluateCondition(expression: string, macros: ReadonlyMap<string, string>): boolean {
  const substituted = expression
    .replace(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_, name: string) =>
      macros.has(name) ? "1" : "0",
    )
    .replace(/defined\s+([A-Za-z_]\w*)/g, (_, name: string) =>
      macros.has(name) ? "1" : "0",
    )
    .replace(/\b([A-Za-z_]\w*)\b/g, (name) => {
      const value = macros.get(name);
      if (value === undefined) return "0";
      try {
        return String(evaluateIntegerExpression(value, macros));
      } catch {
        return "1";
      }
    });

  if (!/^[\d\s!&|()]+$/.test(substituted)) {
    throw new Error(`unsupported preprocessor condition '${expression}'`);
  }

  const tokens = substituted.match(/\d+|&&|\|\||!|\(|\)/g) ?? [];
  let position = 0;
  const parsePrimary = (): boolean => {
    const token = tokens[position++];
    if (token === "(") {
      const value = parseOr();
      if (tokens[position++] !== ")") {
        throw new Error(`unterminated preprocessor condition '${expression}'`);
      }
      return value;
    }
    if (!token || !/^\d+$/.test(token)) {
      throw new Error(`unsupported preprocessor condition '${expression}'`);
    }
    return Number(token) !== 0;
  };
  const parseNot = (): boolean => {
    if (tokens[position] === "!") {
      position++;
      return !parseNot();
    }
    return parsePrimary();
  };
  const parseAnd = (): boolean => {
    let value = parseNot();
    while (tokens[position] === "&&") {
      position++;
      const right = parseNot();
      value = value && right;
    }
    return value;
  };
  const parseOr = (): boolean => {
    let value = parseAnd();
    while (tokens[position] === "||") {
      position++;
      const right = parseAnd();
      value = value || right;
    }
    return value;
  };

  const result = parseOr();
  if (position !== tokens.length) {
    throw new Error(`unsupported preprocessor condition '${expression}'`);
  }
  return result;
}

/** Derive the dynamic Wasm slot window from core's standard lite-Wasm profile. */
export function parseWasmSlotLayoutSource(source: string): WasmSlotLayout {
  const macros = new Map(STANDARD_PROFILE);
  const values = new Map<string, string>(macros);
  const conditionals: ConditionalFrame[] = [];
  const dynamicSlots = new Map<number, number>();

  const currentActive = (): boolean => conditionals.every((frame) => frame.active);

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    let match: RegExpExecArray | null;

    if ((match = /^#\s*ifdef\s+([A-Za-z_]\w*)/.exec(line))) {
      const parentActive = currentActive();
      const condition = macros.has(match[1]);
      conditionals.push({ parentActive, branchTaken: condition, active: parentActive && condition });
      continue;
    }
    if ((match = /^#\s*ifndef\s+([A-Za-z_]\w*)/.exec(line))) {
      const parentActive = currentActive();
      const condition = !macros.has(match[1]);
      conditionals.push({ parentActive, branchTaken: condition, active: parentActive && condition });
      continue;
    }
    if ((match = /^#\s*if\s+(.+)$/.exec(line))) {
      const parentActive = currentActive();
      const condition = evaluateCondition(match[1], macros);
      conditionals.push({ parentActive, branchTaken: condition, active: parentActive && condition });
      continue;
    }
    if ((match = /^#\s*elif\s+(.+)$/.exec(line))) {
      const frame = conditionals.at(-1);
      if (!frame) throw new Error("unexpected #elif in core contract definition");
      const condition = !frame.branchTaken && evaluateCondition(match[1], macros);
      frame.active = frame.parentActive && condition;
      frame.branchTaken ||= condition;
      continue;
    }
    if (/^#\s*else\b/.test(line)) {
      const frame = conditionals.at(-1);
      if (!frame) throw new Error("unexpected #else in core contract definition");
      const condition = !frame.branchTaken;
      frame.active = frame.parentActive && condition;
      frame.branchTaken = true;
      continue;
    }
    if (/^#\s*endif\b/.test(line)) {
      if (!conditionals.pop()) throw new Error("unexpected #endif in core contract definition");
      continue;
    }
    if (!currentActive()) continue;

    if ((match = /^#\s*define\s+([A-Za-z_]\w*)(?:\s+(.+?))?\s*$/.exec(line))) {
      const value = match[2] ?? "1";
      macros.set(match[1], value);
      values.set(match[1], value);
      continue;
    }
    if ((match = /^#\s*undef\s+([A-Za-z_]\w*)/.exec(line))) {
      macros.delete(match[1]);
      values.delete(match[1]);
      continue;
    }
    if (/^#\s*error\b/.test(line)) {
      throw new Error(`active core preprocessor error: ${line}`);
    }

    match = /^constexpr\s+[\w\s]+?\s+([A-Za-z_]\w*)\s*=\s*(.+?)\s*;/.exec(line);
    if (!match) continue;
    if (
      !match[1].endsWith("_CONTRACT_INDEX") &&
      match[1] !== "WASM_RESERVED_SLOT_BASE" &&
      match[1] !== "WASM_RESERVED_SLOT_COUNT"
    ) {
      continue;
    }
    if (values.has(match[1])) {
      throw new Error(`duplicate integer declaration '${match[1]}'`);
    }
    const declarationValue = evaluateIntegerExpression(match[2], values);
    values.set(match[1], String(declarationValue));

    const dynamicMatch = /^LITEDYN(\d+)_CONTRACT_INDEX$/.exec(match[1]);
    if (dynamicMatch) {
      const suffix = Number(dynamicMatch[1]);
      if (dynamicSlots.has(suffix)) {
        throw new Error(`duplicate dynamic Wasm slot LITEDYN${suffix}`);
      }
      dynamicSlots.set(suffix, declarationValue);
    }
  }

  if (conditionals.length) {
    throw new Error("unterminated preprocessor conditional in core contract definition");
  }

  const baseExpression = values.get("WASM_RESERVED_SLOT_BASE");
  const countExpression = values.get("WASM_RESERVED_SLOT_COUNT");
  if (baseExpression === undefined) {
    throw new Error("core contract definition does not declare WASM_RESERVED_SLOT_BASE");
  }
  if (countExpression === undefined) {
    throw new Error("core contract definition does not declare WASM_RESERVED_SLOT_COUNT");
  }

  const slotBase = evaluateIntegerExpression(baseExpression, values);
  const slotCount = evaluateIntegerExpression(countExpression, values);
  if (!Number.isInteger(slotBase) || slotBase < 1 || slotBase > 0xffff) {
    throw new Error(`invalid WASM_RESERVED_SLOT_BASE ${slotBase}`);
  }
  if (!Number.isInteger(slotCount) || slotCount < 1 || slotBase + slotCount > 0x10000) {
    throw new Error(`invalid WASM_RESERVED_SLOT_COUNT ${slotCount}`);
  }
  if (dynamicSlots.size !== slotCount) {
    throw new Error(
      `dynamic Wasm slot count mismatch: declared ${slotCount}, found ${dynamicSlots.size}`,
    );
  }
  for (let index = 0; index < slotCount; index++) {
    const actual = dynamicSlots.get(index);
    if (actual === undefined) {
      throw new Error(`dynamic Wasm slots are not contiguous: missing LITEDYN${index}`);
    }
    const expected = slotBase + index;
    if (actual !== expected) {
      throw new Error(
        `dynamic Wasm slot LITEDYN${index} has index ${actual}, expected ${expected}`,
      );
    }
  }

  return { slotBase, slotCount };
}
