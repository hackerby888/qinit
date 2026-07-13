// Validation runs after parse and before codegen.

import type {
  Declaration,
  StructDecl,
  FunctionDecl,
  VariableDecl,
  Statement,
  Expression,
  TypeSpec,
  Span,
} from "./ast";
import { parseIntLiteral } from "./lexer";

export interface ValidateDiagnostic {
  severity: "error";
  message: string;
  span: Span;
}

interface FnSig {
  declaration: FunctionDecl;
  minArgs: number;
  maxArgs: number;
}

const NO_SPAN: Span = { start: 0, end: 0, line: 0, column: 0 };

function validateAndDesugarBase(translationUnit: { declarations: Declaration[] }): ValidateDiagnostic[] {
  const value = new Validator();
  value.runTopLevel(translationUnit.declarations);
  return value.diagnostics;
}

// Strip const/reference wrappers down to the underlying type.
function unwrapType(type: TypeSpec): TypeSpec {
  if (type.kind === "const") {
    return unwrapType(type.valueType);
  }
  if (type.kind === "reference") {
    return unwrapType(type.referentType);
  }
  return type;
}

function isVoidType(type: TypeSpec): boolean {
  const unwrappedType = unwrapType(type);
  return unwrappedType.kind === "void" ||
    (unwrappedType.kind === "name" && unwrappedType.name === "void");
}

function isConstType(type: TypeSpec): boolean {
  if (type.kind === "const") {
    return true;
  }
  if (type.kind === "reference") {
    return type.referentType.kind === "const";
  }
  return false;
}

// Canonical key for a case label / constant operand: numeric literals normalize through BigInt (0x1 and 1 collide),
function constKey(expression: Expression): string | null {
  if (expression.kind === "int_literal") {
    try {
      return `#${BigInt(expression.value.replace(/[uUlL]+$/, ""))}`;
    } catch {
      return `#${expression.value}`;
    }
  }
  if (expression.kind === "char_literal") {
    return `#${expression.value}`;
  }
  if (expression.kind === "bool_literal") {
    return `#${expression.value ? 1 : 0}`;
  }
  if (expression.kind === "unary_op" && expression.operator === "-") {
    const inner = constKey(expression.argument);
    return inner?.startsWith("#") ? `#${-BigInt(inner.slice(1))}` : null;
  }
  if (expression.kind === "identifier") {
    return `id:${expression.name}`;
  }
  if (expression.kind === "qualified_name") {
    return `id:${expression.namespace}::${expression.name}`;
  }
  return null;
}

// True when the literal is integer zero (any radix/suffix).
function isZeroLiteral(expression: Expression): boolean {
  return constKey(expression) === "#0";
}

function isLiteral(expression: Expression): boolean {
  return (
    expression.kind === "int_literal" ||
    expression.kind === "float_literal" ||
    expression.kind === "bool_literal" ||
    expression.kind === "char_literal" ||
    expression.kind === "string_literal"
  );
}

const CONST_TYPE_SIZE: Record<string, bigint> = {
  bool: 1n,
  bit: 1n,
  sint8: 1n,
  uint8: 1n,
  sint16: 2n,
  uint16: 2n,
  sint32: 4n,
  uint32: 4n,
  sint64: 8n,
  uint64: 8n,
  uint128: 16n,
  id: 32n,
  m256i: 32n,
  int: 4n,
  unsigned: 4n,
  signed: 4n,
};

// Small, side-effect-free integral constant evaluator used by validation. Unknown identifiers
function evalIntegralConst(
  expression: Expression,
  resolve?: (name: string) => bigint | null,
): bigint | null {
  try {
    switch (expression.kind) {
      case "int_literal":
        return parseIntLiteral(expression.value);
      case "bool_literal":
        return expression.value ? 1n : 0n;
      case "char_literal":
        return BigInt(expression.value);
      case "identifier":
        return resolve?.(expression.name) ?? null;
      case "qualified_name":
        return resolve?.(`${expression.namespace}::${expression.name}`) ?? null;
      case "paren":
        return evalIntegralConst(expression.expression, resolve);
      case "unary_op": {
        const numericValue = evalIntegralConst(expression.argument, resolve);
        if (numericValue === null) return null;
        if (expression.operator === "-") return -numericValue;
        if (expression.operator === "+") return numericValue;
        if (expression.operator === "~") return ~numericValue;
        if (expression.operator === "!") return numericValue === 0n ? 1n : 0n;
        return null;
      }
      case "binary_op": {
        const leftValue = evalIntegralConst(expression.left, resolve);
        const rightValue = evalIntegralConst(expression.right, resolve);
        if (leftValue === null || rightValue === null) return null;
        switch (expression.operator) {
          case "+":
            return leftValue + rightValue;
          case "-":
            return leftValue - rightValue;
          case "*":
            return leftValue * rightValue;
          case "/":
            return rightValue === 0n ? null : leftValue / rightValue;
          case "%":
            return rightValue === 0n ? null : leftValue % rightValue;
          case "<<":
            return leftValue << rightValue;
          case ">>":
            return leftValue >> rightValue;
          case "&":
            return leftValue & rightValue;
          case "|":
            return leftValue | rightValue;
          case "^":
            return leftValue ^ rightValue;
          case "==":
            return leftValue === rightValue ? 1n : 0n;
          case "!=":
            return leftValue !== rightValue ? 1n : 0n;
          case "<":
            return leftValue < rightValue ? 1n : 0n;
          case ">":
            return leftValue > rightValue ? 1n : 0n;
          case "<=":
            return leftValue <= rightValue ? 1n : 0n;
          case ">=":
            return leftValue >= rightValue ? 1n : 0n;
          case "&&":
            return leftValue !== 0n && rightValue !== 0n ? 1n : 0n;
          case "||":
            return leftValue !== 0n || rightValue !== 0n ? 1n : 0n;
          default:
            return null;
        }
      }
      case "ternary": {
        const numericValue = evalIntegralConst(expression.condition, resolve);
        return numericValue === null ? null : evalIntegralConst(numericValue !== 0n ? expression.then : expression.else_, resolve);
      }
      case "c_cast":
      case "static_cast":
        return evalIntegralConst(expression.expression, resolve);
      case "sizeof_type": {
        const type = unwrapType(expression.type);
        return type.kind === "name" ? (CONST_TYPE_SIZE[type.name] ?? null) : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// Canonical spelling of a type for signature comparison.
function typeKey(type: TypeSpec): string {
  switch (type.kind) {
    case "name":
      return type.name;
    case "const":
      return `const ${typeKey(type.valueType)}`;
    case "reference":
      return `${typeKey(type.referentType)}&`;
    case "pointer":
      return `${typeKey(type.pointee)}*`;
    case "template_instance":
      return `${type.name}<${type.callArguments.map(typeKey).join(",")}>`;
    case "array":
      return `${typeKey(type.element)}[]`;
    case "void":
      return "void";
    default:
      return type.kind;
  }
}

function paramSignature(fn: FunctionDecl): string {
  return fn.params.map((parameter) => typeKey(parameter.type)).join(";");
}

class Validator {
  diagnostics: ValidateDiagnostic[] = [];

  private seen = new Set<string>();

  private currentFn: FunctionDecl | null = null;

  private loopDepth = 0;

  private constants = new Map<string, bigint>();

  private aggregateNames = new Set<string>(["id", "m256i", "uint128"]);

  // Typedef aliases, name → target type key: qpi.h's `typedef m256i id` plus the contract's own typedef_decls. Aggregate type
  private typeAliases = new Map<string, string>([
    ["id", "m256i"],
    ["uint128_t", "uint128"],
  ]);

  private aggregateFieldCount = new Map<string, number>();

  private structFields = new Map<string, Map<string, TypeSpec>>();

  private currentTypes = new Map<string, TypeSpec>();

  private currentMemberFns = new Map<string, FnSig>();

  private canonTypeKey(type: TypeSpec): string {
    const unwrappedType = unwrapType(type);

    // Template value arguments canonicalize to their constant values, so Array<uint8, ALIGNED_A> and Array<uint8, ALIGNED_B> compare equal when both
    if (unwrappedType.kind === "template_instance") {
      const callArguments = unwrappedType.callArguments.map((argument) => {
        if (argument.kind === "name") {
          const numericValue = this.constants.get(argument.name);
          if (numericValue !== undefined) {
            return numericValue.toString();
          }
        }
        return this.canonTypeKey(argument);
      });
      return `${unwrappedType.name}<${callArguments.join(",")}>`;
    }

    let text = typeKey(unwrappedType);
    for (let index = 0; index < 8; index++) {
      const next = this.typeAliases.get(text);
      if (!next || next === text) {
        break;
      }
      text = next;
    }
    return text;
  }

  private error(message: string, span: Span | undefined): void {
    const sp = span ?? NO_SPAN;
    const key = `${message}@${sp.line}`;
    if (this.seen.has(key)) {
      return;
    }

    this.seen.add(key);
    this.diagnostics.push({ severity: "error", message, span: sp });
  }

  // ---- Top level ----

  runTopLevel(declarations: Declaration[]): void {
    const typeNames = new Set<string>();
    for (const declaration of declarations) {
      // A memberless struct is a forward declaration (`struct StateData;`), not a definition.
      const isForwardDecl = declaration.kind === "struct" && declaration.members.length === 0;
      if (
        (declaration.kind === "struct" ||
          declaration.kind === "class_template" ||
          declaration.kind === "enum" ||
          declaration.kind === "typedef_decl") &&
        declaration.name &&
        !isForwardDecl
      ) {
        if (typeNames.has(declaration.name)) this.error(`duplicate type definition '${declaration.name}'`, declaration.span);
        typeNames.add(declaration.name);
      }
      if (declaration.kind === "typedef_decl" && declaration.name) {
        this.typeAliases.set(declaration.name, typeKey(unwrapType((declaration as { type: TypeSpec }).type)));
      }
      switch (declaration.kind) {
        case "variable":
          this.checkGlobalVariable(declaration);
          break;
        case "struct":
          this.checkStruct(declaration);
          break;
        case "namespace":
          this.runTopLevel(declaration.body);
          break;
        case "function":
          if (declaration.body) {
            this.checkFunctionBody(declaration, new Map());
          }
          break;
        case "enum":
          this.collectEnumConstants(declaration);
          break;
        case "static_assert_decl":
          this.checkStaticAssert(declaration.condition, declaration.message, declaration.span);
          break;
        case "class_template":
          this.checkStruct(declaration as unknown as StructDecl);
          break;
      }
    }
  }

  // Contracts run on consensus state only: a file-scope mutable lives outside the hashed state and silently diverges between
  private checkGlobalVariable(variableDeclaration: VariableDecl): void {
    if (variableDeclaration.isConstexpr || variableDeclaration.isExtern || isConstType(variableDeclaration.type)) {
      // File-scope constexpr constants feed template-argument canonicalization (canonTypeKey) and static_assert evaluation.
      if (variableDeclaration.initializer) {
        const value = evalIntegralConst(variableDeclaration.initializer, (name) => this.constants.get(name) ?? null);
        if (value !== null) {
          this.constants.set(variableDeclaration.name, value);
        }
      }
      return;
    }

    this.error(
      `global variable '${variableDeclaration.name}' is not allowed in a contract — state must live in the contract state struct`,
      variableDeclaration.span,
    );
  }

  // ---- Structs ----

  private checkStruct(structDeclaration: StructDecl): void {
    if (structDeclaration.name) this.aggregateNames.add(structDeclaration.name);
    if (structDeclaration.name)
      this.aggregateFieldCount.set(
        structDeclaration.name,
        structDeclaration.members.filter((member) => member.kind === "variable" && !member.isStatic && !member.isConstexpr).length,
      );
    if (structDeclaration.name)
      this.structFields.set(
        structDeclaration.name,
        new Map(
          structDeclaration.members
            .filter((member): member is VariableDecl => member.kind === "variable")
            .map((variableDeclaration) => [variableDeclaration.name, variableDeclaration.type]),
        ),
      );
    const fieldNames = new Set<string>();
    const typeNames = new Set<string>();
    const fnBodies = new Map<string, FunctionDecl>();
    const fnSigs = new Map<string, FnSig>();

    for (const member of structDeclaration.members) {
      // A memberless struct is a forward declaration (`struct StateData;`), not a definition.
      const isForwardDecl = member.kind === "struct" && member.members.length === 0;
      if (
        (member.kind === "struct" ||
          member.kind === "class_template" ||
          member.kind === "enum" ||
          member.kind === "typedef_decl") &&
        member.name &&
        !isForwardDecl
      ) {
        if (typeNames.has(member.name))
          this.error(`duplicate type definition '${member.name}' in struct '${structDeclaration.name}'`, member.span);
        typeNames.add(member.name);
      }
      if (member.kind === "typedef_decl" && member.name) {
        this.typeAliases.set(member.name, typeKey(unwrapType((member as { type: TypeSpec }).type)));
      }
      if (member.kind === "variable") {
        // Anonymous-union alternatives intentionally alias storage; only named duplicates in the same struct are redefinitions.
        if (fieldNames.has(member.name)) {
          this.error(`duplicate member '${member.name}' in struct '${structDeclaration.name}'`, member.span);
        }
        fieldNames.add(member.name);
        if (member.initializer && (member.isConstexpr || isConstType(member.type))) {
          const value = evalIntegralConst(member.initializer, (name) => this.constants.get(name) ?? null);
          if (value !== null) this.constants.set(member.name, value);
        }
      }

      if (member.kind === "struct") {
        if (member.name) this.aggregateNames.add(member.name);
        this.checkStruct(member);
      }

      if (member.kind === "enum") {
        this.collectEnumConstants(member);
      }

      if (member.kind === "static_assert_decl") {
        this.checkStaticAssert(member.condition, member.message, member.span);
      }

      if (member.kind === "function") {
        const sig: FnSig = {
          declaration: member,
          minArgs: member.params.filter((parameter) => !parameter.defaultValue).length,
          maxArgs: member.params.length,
        };
        if (member.body) {
          // Two definitions with the same parameter signature are a redefinition. Overloads
          const prev = fnBodies.get(member.name);
          if (prev && paramSignature(prev) === paramSignature(member)) {
            this.error(
              `'${member.name}' is already defined in struct '${structDeclaration.name}' with the same signature`,
              member.span,
            );
          }
          if (!prev) {
            fnBodies.set(member.name, member);
          }
          if (!fnSigs.has(member.name) || fnSigs.get(member.name)!.declaration.body === undefined) {
            fnSigs.set(member.name, sig);
          }
        } else if (!fnSigs.has(member.name)) {
          fnSigs.set(member.name, sig);
        }
      }
    }

    // Overloaded names can't be arity-checked or default-desugared without type-based resolution — exclude them from call checks entirely.
    const bodyCount = new Map<string, number>();
    for (const memberCandidate of structDeclaration.members) {
      if (memberCandidate.kind === "function" && memberCandidate.body) {
        bodyCount.set(memberCandidate.name, (bodyCount.get(memberCandidate.name) ?? 0) + 1);
      }
    }
    for (const [name, n] of bodyCount) {
      if (n > 1) {
        fnSigs.delete(name);
      }
    }

    for (const fn of fnBodies.values()) {
      this.checkFunctionBody(fn, fnSigs);
    }

    this.checkRecursion(structDeclaration, fnBodies);
  }

  // Qubic contracts must have statically bounded stacks: any call cycle among a struct's member functions (direct or mutual)
  private checkRecursion(structDeclaration: StructDecl, fnBodies: Map<string, FunctionDecl>): void {
    const edges = new Map<string, Set<string>>();
    for (const [name, fn] of fnBodies) {
      const callees = new Set<string>();
      this.walkStatements(fn.body!, (statement) => {
        this.walkExpressions(statement, (expression) => {
          if (expression.kind === "call") {
            if (expression.callee.kind === "identifier" && fnBodies.has(expression.callee.name)) {
              callees.add(expression.callee.name);
            }
            if (
              expression.callee.kind === "member_access" &&
              expression.callee.object.kind === "identifier" &&
              expression.callee.object.name === "this" &&
              fnBodies.has(expression.callee.member)
            ) {
              callees.add(expression.callee.member);
            }
          }
        });
      });
      edges.set(name, callees);
    }

    const state = new Map<string, "visiting" | "done">();
    const visit = (name: string, path: string[]): void => {
      const st = state.get(name);
      if (st === "done") {
        return;
      }
      if (st === "visiting") {
        const cycle = [...path.slice(path.indexOf(name)), name].join(" -> ");
        this.error(`recursion is not allowed in a contract: ${cycle}`, fnBodies.get(name)?.span);
        return;
      }

      state.set(name, "visiting");
      for (const callee of edges.get(name) ?? []) {
        visit(callee, [...path, name]);
      }
      state.set(name, "done");
    };
    for (const name of edges.keys()) {
      visit(name, []);
    }
  }

  // ---- Function bodies ----

  private checkFunctionBody(fn: FunctionDecl, memberFns: Map<string, FnSig>): void {
    this.currentFn = fn;
    this.loopDepth = 0;
    this.currentMemberFns = memberFns;
    this.currentTypes = new Map(fn.params.map((parameter) => [parameter.name, parameter.type]));

    // Every local declared anywhere in the function, for classifying bare identifiers: names outside this set belong to members/parameters/constants
    const allLocals = new Set<string>();
    this.walkStatements(fn.body!, (statement) => {
      if (statement.kind === "declaration" && statement.declaration.kind === "variable" && !statement.declaration.isMember) {
        allLocals.add(statement.declaration.name);
        this.currentTypes.set(statement.declaration.name, statement.declaration.type);
      }
    });
    this.checkReturns(fn);

    const constParams = new Set<string>();
    for (const parameter of fn.params) {
      if (isConstType(parameter.type)) {
        constParams.add(parameter.name);
      }
    }

    const scopes: Array<Map<string, { const: boolean }>> = [new Map()];
    this.walkScope(fn.body!, fn, memberFns, allLocals, constParams, scopes);
  }

  private checkReturns(fn: FunctionDecl): void {
    const isVoid = isVoidType(fn.returnType);
    let valueReturns = 0;

    this.walkStatements(fn.body!, (statement) => {
      if (statement.kind !== "return") {
        return;
      }
      if (statement.value && isVoid) {
        this.error(`void function '${fn.name}' cannot return a value`, statement.span);
      }
      if (statement.value) {
        valueReturns++;
        const actual = this.inferSimpleType(statement.value);
        if (this.isAggregateType(fn.returnType) && actual && !this.isAggregateType(actual)) {
          this.error(
            `return type is incompatible: cannot convert scalar expression to aggregate '${typeKey(fn.returnType)}'`,
            statement.span,
          );
        } else if (
          actual &&
          this.isAggregateType(fn.returnType) &&
          this.isAggregateType(actual) &&
          this.canonTypeKey(actual) !== this.canonTypeKey(fn.returnType)
        ) {
          this.error(
            `return type mismatch: cannot convert '${typeKey(actual)}' to '${typeKey(fn.returnType)}'`,
            statement.span,
          );
        }
      }
    });

    if (!isVoid && valueReturns === 0) {
      this.error(`function '${fn.name}' must return a value`, fn.span);
    } else if (!isVoid && !this.guaranteesReturn(fn.body!)) {
      this.error(
        `non-void function '${fn.name}' has a reachable fallthrough path without a return value`,
        fn.span,
      );
    }
  }

  private guaranteesReturn(statement: Statement): boolean {
    if (statement.kind === "return") return true;
    if (statement.kind === "compound") {
      for (const child of statement.body) if (this.guaranteesReturn(child)) return true;
      return false;
    }
    if (statement.kind === "if")
      return !!statement.else_ && this.guaranteesReturn(statement.then) && this.guaranteesReturn(statement.else_);
    if (statement.kind === "switch") {
      // A switch guarantees a return when it has a default label, no arm can break out of it,
      const body = statement.body.kind === "compound" ? statement.body.body : [statement.body];
      const breaksOut = (statement: Statement): boolean => {
        if (statement.kind === "break") return true;
        if (statement.kind === "compound") return statement.body.some(breaksOut);
        if (statement.kind === "if") return breaksOut(statement.then) || (!!statement.else_ && breaksOut(statement.else_));
        return false;
      };
      const last = body[body.length - 1];
      return (
        body.some((bodyItem) => bodyItem.kind === "default") &&
        !body.some(breaksOut) &&
        !!last &&
        this.guaranteesReturn(last)
      );
    }
    return false;
  }

  private collectEnumConstants(entry: Declaration & { kind: "enum" }): void {
    const names = new Set<string>();
    let next = 0n;
    for (const member of entry.members) {
      if (names.has(member.name)) this.error(`duplicate enumerator '${member.name}'`, member.span);
      names.add(member.name);
      const value = member.value
        ? evalIntegralConst(member.value, (name) => this.constants.get(name) ?? null)
        : next;
      if (value !== null) {
        this.constants.set(member.name, value);
        if (entry.name) this.constants.set(`${entry.name}::${member.name}`, value);
        next = value + 1n;
      }
    }
  }

  private checkStaticAssert(condition: Expression, message: Expression | undefined, span: Span): void {
    const value = evalIntegralConst(condition, (name) => this.constants.get(name) ?? null);
    if (value === 0n) {
      const detail = message?.kind === "string_literal" ? `: ${message.value}` : "";
      this.error(`static assertion failed${detail}`, span);
    }
  }

  // Ordered walk with a scope stack: declarations register in the innermost scope, identifier uses must resolve to an
  private walkScope(
    statement: Statement,
    fn: FunctionDecl,
    memberFns: Map<string, FnSig>,
    allLocals: Set<string>,
    constParams: Set<string>,
    scopes: Array<Map<string, { const: boolean }>>,
  ): void {
    const recurse = (statement: Statement) =>
      this.walkScope(statement, fn, memberFns, allLocals, constParams, scopes);
    const inOwnScope = (statement: Statement, extra?: () => void) => {
      scopes.push(new Map());
      if (extra) {
        extra();
      }
      recurse(statement);
      scopes.pop();
    };

    switch (statement.kind) {
      case "compound":
        // A multi-declarator statement (`uint64 x = 1, y = 3;`) is drained by the parser into a synthetic
        if ((statement as any).synthetic) {
          for (const bodyItem of statement.body) {
            recurse(bodyItem);
          }
          break;
        }

        scopes.push(new Map());
        for (const bodyItem of statement.body) {
          recurse(bodyItem);
        }
        scopes.pop();
        break;

      case "declaration":
        this.checkDeclarationStatement(statement, scopes);
        if (statement.declaration.kind === "variable" && statement.declaration.initializer) {
          this.checkExpression(statement.declaration.initializer, memberFns, allLocals, constParams, scopes);
        }
        break;

      case "if":
        this.checkExpression(statement.condition, memberFns, allLocals, constParams, scopes);
        inOwnScope(statement.then);
        if (statement.else_) {
          inOwnScope(statement.else_);
        }
        break;

      case "for":
        scopes.push(new Map());
        if (statement.initializer) {
          recurse(statement.initializer);
        }
        if (statement.condition) {
          this.checkExpression(statement.condition, memberFns, allLocals, constParams, scopes);
        }
        if (statement.update) {
          this.checkExpression(statement.update, memberFns, allLocals, constParams, scopes);
        }
        this.loopDepth++;
        inOwnScope(statement.body);
        this.loopDepth--;
        scopes.pop();
        break;

      case "while":
        this.checkExpression(statement.condition, memberFns, allLocals, constParams, scopes);
        this.loopDepth++;
        inOwnScope(statement.body);
        this.loopDepth--;
        break;

      case "do_while":
        this.loopDepth++;
        inOwnScope(statement.body);
        this.loopDepth--;
        this.checkExpression(statement.condition, memberFns, allLocals, constParams, scopes);
        break;

      case "switch":
        this.checkExpression(statement.condition, memberFns, allLocals, constParams, scopes);
        this.checkSwitchCases(statement.body, allLocals);
        inOwnScope(statement.body);
        break;

      case "continue":
        if (this.loopDepth === 0) this.error(`continue statement is outside a loop`, statement.span);
        break;

      case "static_assert":
        this.checkStaticAssert(statement.condition, statement.message, statement.span);
        break;

      case "return":
        if (statement.value) {
          this.checkExpression(statement.value, memberFns, allLocals, constParams, scopes);
        }
        break;

      case "expression":
        this.checkExpression(statement.expression, memberFns, allLocals, constParams, scopes);
        break;
    }
  }

  private checkDeclarationStatement(
    statement: Statement & { kind: "declaration" },
    scopes: Array<Map<string, { const: boolean }>>,
  ): void {
    const decl = statement.declaration;

    if (decl.kind === "function") {
      if (decl.body) {
        this.error(
          `function '${decl.name}' cannot be defined nested inside another function`,
          statement.span,
        );
      }
      return;
    }
    if (decl.kind === "struct") {
      this.checkStruct(decl);
      return;
    }
    if (decl.kind !== "variable") {
      return;
    }

    if (isVoidType(decl.type)) {
      this.error(`variable '${decl.name}' cannot have type void`, statement.span);
    }
    if (decl.isStatic && !decl.isConstexpr) {
      this.error(
        `static local variable '${decl.name}' is not allowed in a contract — its lifetime would outlive the call and bypass consensus state`,
        statement.span,
      );
    }

    if (decl.initializer) this.checkInitializerCardinality(decl.type, decl.initializer, statement.span);

    const current = scopes[scopes.length - 1];
    if (current.has(decl.name)) {
      this.error(`'${decl.name}' is already declared in this scope`, statement.span);
    } else if (decl.name !== "interContractCallError") {
      // CALL_OTHER_CONTRACT_FUNCTION / INVOKE_OTHER_CONTRACT_PROCEDURE declare `InterContractCallError interContractCallError;` at the call site, so nested calls shadow by design and each
      for (let index = scopes.length - 2; index >= 0; index--) {
        if (scopes[index].has(decl.name)) {
          this.error(
            `'${decl.name}' shadows a declaration in an enclosing scope — locals share one slot per name, so shadowing is not supported`,
            statement.span,
          );
          break;
        }
      }
    }
    current.set(decl.name, { const: isConstType(decl.type) });
  }

  private checkInitializerCardinality(type: TypeSpec, initializer: Expression, span: Span): void {
    const callArguments =
      initializer.kind === "initializer_list" ? initializer.expressions : initializer.kind === "construct" ? initializer.callArguments : null;
    if (!callArguments) return;
    const unwrappedType = unwrapType(type);
    if (unwrappedType.kind === "array") {
      const size = evalIntegralConst(unwrappedType.size, (name) => this.constants.get(name) ?? null);
      if (size !== null && size > 0n && BigInt(callArguments.length) > size) {
        this.error(`too many initializers for array bound ${size}`, span);
      }
      for (const argument of callArguments)
        this.checkInitializerCardinality(unwrappedType.element, argument, argument.span);
      return;
    }
    if (type.kind === "name") {
      const fields = this.aggregateFieldCount.get(type.name);
      if (fields !== undefined && callArguments.length > fields) {
        this.error(`too many initializers for aggregate '${type.name}' (${fields} fields)`, span);
      }
    }
  }

  private checkSwitchCases(body: Statement, allLocals: Set<string>): void {
    const keys = new Set<string>();
    let defaults = 0;

    const scan = (statement: Statement): void => {
      switch (statement.kind) {
        case "case": {
          const value = evalIntegralConst(statement.value, (name) => this.constants.get(name) ?? null);
          const key = value === null ? null : `#${value}`;
          if (value === null && statement.value.kind === "identifier" && allLocals.has(statement.value.name)) {
            this.error(`case label must be an integral constant expression`, statement.span);
          }
          if (key !== null) {
            if (keys.has(key)) {
              this.error(`duplicate case label`, statement.span);
            }
            keys.add(key);
          }
          break;
        }
        case "default":
          defaults++;
          if (defaults > 1) this.error(`duplicate default label`, statement.span);
          break;
        case "compound":
          for (const bodyItem of statement.body) {
            scan(bodyItem);
          }
          break;
        case "if":
          scan(statement.then);
          if (statement.else_) {
            scan(statement.else_);
          }
          break;
        case "for":
        case "while":
        case "do_while":
          scan(statement.body);
          break;
      }
    };
    scan(body);
  }

  // ---- Expressions ----

  private checkExpression(
    root: Expression,
    memberFns: Map<string, FnSig>,
    allLocals: Set<string>,
    constParams: Set<string>,
    scopes: Array<Map<string, { const: boolean }>>,
  ): void {
    const lookup = (name: string): { const: boolean } | null => {
      for (let index = scopes.length - 1; index >= 0; index--) {
        const hit = scopes[index].get(name);
        if (hit) {
          return hit;
        }
      }
      return null;
    };

    const walk = (expression: Expression): void => {
      switch (expression.kind) {
        case "identifier":
          if (allLocals.has(expression.name) && !lookup(expression.name)) {
            this.error(
              `'${expression.name}' is used before its declaration (or outside the scope that declares it)`,
              expression.span,
            );
          }
          break;

        case "assign": {
          const leftType = this.inferSimpleType(expression.left);
          const rightType = this.inferSimpleType(expression.right);
          if (
            leftType &&
            rightType &&
            this.isAggregateType(leftType) &&
            this.isAggregateType(rightType) &&
            this.canonTypeKey(leftType) !== this.canonTypeKey(rightType)
          ) {
            this.error(
              `incompatible aggregate assignment from '${typeKey(rightType)}' to '${typeKey(leftType)}'`,
              expression.span,
            );
          }
          this.checkAssignTarget(expression.left, constParams, lookup);
          walk(expression.left);
          walk(expression.right);
          break;
        }

        case "prefix_op":
        case "postfix_op":
          this.checkAssignTarget(expression.argument, constParams, lookup);
          walk(expression.argument);
          break;

        case "unary_op":
          if (expression.operator === "&" && isLiteral(expression.argument)) {
            this.error(`cannot take the address of a literal`, expression.span);
          }
          walk(expression.argument);
          break;

        case "binary_op":
          if ((expression.operator === "/" || expression.operator === "%") && isZeroLiteral(expression.right)) {
            this.error(`constant division by zero`, expression.span);
          }
          walk(expression.left);
          walk(expression.right);
          break;

        case "call": {
          const name =
            expression.callee.kind === "identifier"
              ? expression.callee.name
              : expression.callee.kind === "member_access" &&
                  expression.callee.object.kind === "identifier" &&
                  expression.callee.object.name === "this"
                ? expression.callee.member
                : null;
          if (expression.callee.kind === "member_access") {
            const method = expression.callee.member;
            const object = expression.callee.object;
            const receiverType = this.inferSimpleType(object);
            const receiver = receiverType ? unwrapType(receiverType) : null;
            const isArray = receiver?.kind === "template_instance" && receiver.name === "Array";
            if (isArray && method === "set" && expression.callArguments.length !== 2) {
              this.error(`container set expects 2 argument(s) but got ${expression.callArguments.length}`, expression.span);
            }
            // state.get() is a zero-argument accessor; a get call with operands is a container get.
            if (isArray && method === "get" && expression.callArguments.length !== 1) {
              this.error(`container get expects 1 argument but got ${expression.callArguments.length}`, expression.span);
            }
            if (
              this.isPublicFunctionContext() &&
              object.kind === "identifier" &&
              object.name === "state" &&
              method === "mut"
            ) {
              this.error(`public function is read-only and cannot call state.mut()`, expression.span);
            }
          }
          const sig =
            name !== null && !lookup(name) && !allLocals.has(name)
              ? memberFns.get(name)
              : undefined;
          if (sig) {
            // Native rejects a bare non-static member call from a static context (every macro-generated entry body is static) —
            if (this.currentFn?.isStatic && !sig.declaration.isStatic) {
              this.error(
                `cannot call non-static member function '${name}' from a static context — declare it static`,
                expression.span,
              );
            }
            if (expression.callArguments.length < sig.minArgs || expression.callArguments.length > sig.maxArgs) {
              const want =
                sig.minArgs === sig.maxArgs ? `${sig.maxArgs}` : `${sig.minArgs}..${sig.maxArgs}`;
              this.error(`'${name}' expects ${want} argument(s) but got ${expression.callArguments.length}`, expression.span);
            } else {
              // Desugar defaults: append the declaration's default expressions so codegen emits the full argument list (C++ evaluates defaults at
              for (let sigItemIndex = expression.callArguments.length; sigItemIndex < sig.maxArgs; sigItemIndex++) {
                expression.callArguments.push(sig.declaration.params[sigItemIndex].defaultValue!);
              }
            }
            for (let index = 0; index < Math.min(expression.callArguments.length, sig.declaration.params.length); index++) {
              const paramType = sig.declaration.params[index].type;
              const argType = this.inferSimpleType(expression.callArguments[index]);
              if (
                argType &&
                this.isAggregateType(paramType) &&
                this.isAggregateType(argType) &&
                this.canonTypeKey(paramType) !== this.canonTypeKey(argType)
              ) {
                this.error(
                  `argument ${index + 1} to '${name}' has incompatible aggregate type '${typeKey(argType)}'; expected '${typeKey(paramType)}'`,
                  expression.callArguments[index].span,
                );
              }
              if (paramType.kind !== "reference" || isConstType(paramType)) continue;
              const argument = expression.callArguments[index];
              if (!this.isWritableReferenceArgument(argument, constParams, lookup)) {
                this.error(
                  `argument ${index + 1} to '${name}' cannot bind to a non-const reference`,
                  argument.span,
                );
              }
            }
          }
          if (expression.callee.kind !== "identifier") {
            walk(expression.callee);
          }
          for (const argument of expression.callArguments) {
            walk(argument);
          }
          break;
        }

        case "template_call":
          for (const argument of expression.callArguments) {
            walk(argument);
          }
          break;

        case "member_access":
          walk(expression.object);
          break;
        case "subscript":
          walk(expression.object);
          walk(expression.index);
          break;
        case "ternary":
          walk(expression.condition);
          walk(expression.then);
          walk(expression.else_);
          break;
        case "sequence":
          for (const sequenceExpression of expression.expressions) {
            walk(sequenceExpression);
          }
          break;
        case "c_cast":
        case "static_cast":
        case "reinterpret_cast":
          walk(expression.expression);
          break;
        case "construct":
        case "initializer_list":
          for (const itemItem of (expression as any).callArguments ?? (expression as any).expressions ?? []) {
            walk(itemItem);
          }
          break;
        case "sizeof_expr":
          walk(expression.expression);
          break;
      }
    };
    walk(root);
  }

  // The root of an assignment target must be mutable: a get() accessor result is a read-only view (writing
  private checkAssignTarget(
    target: Expression,
    constParams: Set<string>,
    lookup: (name: string) => { const: boolean } | null,
  ): void {
    let root = target;
    while (root.kind === "member_access" || root.kind === "subscript") {
      root = root.kind === "member_access" ? root.object : root.object;
    }

    if (
      root.kind === "call" &&
      root.callee.kind === "member_access" &&
      root.callee.member === "get"
    ) {
      this.error(
        `cannot modify through get(): it returns a read-only view — use mut()`,
        target.span,
      );
      return;
    }

    if (root.kind === "identifier") {
      const local = lookup(root.name);
      if (local?.const) {
        this.error(`cannot assign to const '${root.name}'`, target.span);
      } else if (!local && constParams.has(root.name)) {
        this.error(`cannot assign to const parameter '${root.name}'`, target.span);
      }
    }
  }

  private isPublicFunctionContext(): boolean {
    if (this.currentFn?.name === "__impl_migrate") return false;
    const first = this.currentFn?.params[0]?.type;
    if (!first) return false;
    const type = unwrapType(first);
    return type.kind === "name" && type.name === "QpiContextFunctionCall";
  }

  private isAggregateType(type: TypeSpec): boolean {
    const unwrappedType = unwrapType(type);
    return (
      unwrappedType.kind === "inline_struct" ||
      unwrappedType.kind === "array" ||
      unwrappedType.kind === "template_instance" ||
      (unwrappedType.kind === "name" && this.aggregateNames.has(unwrappedType.name))
    );
  }

  private inferSimpleType(expression: Expression): TypeSpec | null {
    switch (expression.kind) {
      case "identifier":
        return this.currentTypes.get(expression.name) ?? null;
      case "int_literal":
        return { kind: "name", name: "uint64" };
      case "bool_literal":
        return { kind: "name", name: "bool" };
      case "char_literal":
        return { kind: "name", name: "int" };
      case "paren":
        return this.inferSimpleType(expression.expression);
      case "c_cast":
      case "static_cast":
      case "reinterpret_cast":
        return expression.type;
      case "construct":
        return expression.type;
      case "call": {
        const name = expression.callee.kind === "identifier" ? expression.callee.name : null;
        if (
          expression.callee.kind === "member_access" &&
          expression.callee.object.kind === "identifier" &&
          expression.callee.object.name === "state" &&
          (expression.callee.member === "get" || expression.callee.member === "mut")
        ) {
          return { kind: "name", name: "StateData" };
        }
        return name ? (this.currentMemberFns.get(name)?.declaration.returnType ?? null) : null;
      }
      case "member_access": {
        const owner = this.inferSimpleType(expression.object);
        const concrete = owner ? unwrapType(owner) : null;
        return concrete?.kind === "name"
          ? (this.structFields.get(concrete.name)?.get(expression.member) ?? null)
          : null;
      }
      default:
        return null;
    }
  }

  private isReadonlyStateExpression(expression: Expression): boolean {
    let root = expression;
    while (root.kind === "member_access" || root.kind === "subscript") root = root.object;
    return (
      root.kind === "call" &&
      root.callee.kind === "member_access" &&
      root.callee.object.kind === "identifier" &&
      root.callee.object.name === "state" &&
      root.callee.member === "get"
    );
  }

  private isWritableReferenceArgument(
    argument: Expression,
    constParams: Set<string>,
    lookup: (name: string) => { const: boolean } | null,
  ): boolean {
    if (this.isReadonlyStateExpression(argument)) return false;
    if (argument.kind === "identifier") {
      const local = lookup(argument.name);
      if (local?.const || (!local && constParams.has(argument.name))) return false;
      return true;
    }
    return (
      argument.kind === "member_access" ||
      argument.kind === "subscript" ||
      (argument.kind === "unary_op" && argument.operator === "*")
    );
  }

  // ---- Generic walkers ----

  private walkStatements(statement: Statement, visit: (statement: Statement) => void): void {
    visit(statement);

    switch (statement.kind) {
      case "compound":
        for (const bodyItem of statement.body) {
          this.walkStatements(bodyItem, visit);
        }
        break;
      case "if":
        this.walkStatements(statement.then, visit);
        if (statement.else_) {
          this.walkStatements(statement.else_, visit);
        }
        break;
      case "for":
        if (statement.initializer) {
          this.walkStatements(statement.initializer, visit);
        }
        this.walkStatements(statement.body, visit);
        break;
      case "while":
      case "do_while":
      case "switch":
        this.walkStatements(statement.body, visit);
        break;
    }
  }

  private walkExpressions(statement: Statement, visit: (expression: Expression) => void): void {
    const walkE = (expression: Expression): void => {
      visit(expression);
      switch (expression.kind) {
        case "assign":
        case "binary_op":
          walkE(expression.left);
          walkE(expression.right);
          break;
        case "unary_op":
          walkE(expression.argument);
          break;
        case "prefix_op":
        case "postfix_op":
          walkE(expression.argument);
          break;
        case "ternary":
          walkE(expression.condition);
          walkE(expression.then);
          walkE(expression.else_);
          break;
        case "member_access":
          walkE(expression.object);
          break;
        case "subscript":
          walkE(expression.object);
          walkE(expression.index);
          break;
        case "call":
          walkE(expression.callee);
          for (const argument of expression.callArguments) {
            walkE(argument);
          }
          break;
        case "template_call":
          for (const argumentCandidate of expression.callArguments) {
            walkE(argumentCandidate);
          }
          break;
        case "sequence":
          for (const sequenceExpression of expression.expressions) {
            walkE(sequenceExpression);
          }
          break;
        case "c_cast":
        case "static_cast":
        case "reinterpret_cast":
          walkE(expression.expression);
          break;
        case "construct":
        case "initializer_list":
          for (const itemItem of (expression as any).callArguments ?? (expression as any).expressions ?? []) {
            walkE(itemItem);
          }
          break;
        case "sizeof_expr":
          walkE(expression.expression);
          break;
      }
    };

    switch (statement.kind) {
      case "expression":
        walkE(statement.expression);
        break;
      case "declaration":
        if (statement.declaration.kind === "variable" && statement.declaration.initializer) {
          walkE(statement.declaration.initializer);
        }
        break;
      case "if":
        walkE(statement.condition);
        break;
      case "for":
        if (statement.condition) {
          walkE(statement.condition);
        }
        if (statement.update) {
          walkE(statement.update);
        }
        break;
      case "while":
      case "do_while":
      case "switch":
        walkE(statement.condition);
        break;
      case "return":
        if (statement.value) {
          walkE(statement.value);
        }
        break;
      case "case":
        walkE(statement.value);
        break;
    }
  }
}

interface SupplementalFlowContext {
  loopDepth: number;
  switchDepth: number;
  runtimeNames: Set<string>;
  initialized: Set<string>;
  labels: Map<string, { span: any; initialized: Set<string> }>;
  gotos: Array<{ label: string; span: any; initialized: Set<string> }>;
}

function supplementalDiagnostic(message: string, span: any): ValidateDiagnostic {
  return { severity: "error", message, span };
}

function isModifiableLvalue(expression: any): boolean {
  if (!expression) return false;
  switch (expression.kind) {
    case "identifier":
    case "member_access":
    case "subscript":
      return true;
    case "paren":
      return isModifiableLvalue(expression.expression);
    case "unary_op":
      return expression.operator === "*";
    default:
      return false;
  }
}

function isMutableReference(type: any): boolean {
  return type?.kind === "reference" && type.referentType?.kind !== "const";
}

function expressionUsesRuntimeName(expression: any, runtimeNames: Set<string>): boolean {
  if (!expression || typeof expression !== "object") return false;
  if (expression.kind === "identifier") return runtimeNames.has(expression.name);
  for (const [key, value] of Object.entries(expression)) {
    if (key === "span" || key === "kind") continue;
    if (Array.isArray(value)) {
      if (value.some((item) => expressionUsesRuntimeName(item, runtimeNames))) return true;
    } else if (
      value &&
      typeof value === "object" &&
      expressionUsesRuntimeName(value, runtimeNames)
    ) {
      return true;
    }
  }
  return false;
}

function validateSupplementalExpression(expression: any, diagnostics: ValidateDiagnostic[]): void {
  if (!expression || typeof expression !== "object") return;

  if (expression.kind === "assign" || (expression.kind === "binary_op" && expression.operator === "=")) {
    if (!isModifiableLvalue(expression.left)) {
      diagnostics.push(
        supplementalDiagnostic(
          "assignment target is not a modifiable lvalue",
          expression.left?.span ?? expression.span,
        ),
      );
    }
  }
  if ((expression.kind === "prefix_op" || expression.kind === "postfix_op") && !isModifiableLvalue(expression.argument)) {
    diagnostics.push(
      supplementalDiagnostic(
        `operand of '${expression.operator}' is not a modifiable lvalue`,
        expression.argument?.span ?? expression.span,
      ),
    );
  }

  for (const [key, value] of Object.entries(expression)) {
    if (key === "span" || key === "kind") continue;
    if (Array.isArray(value)) {
      for (const item of value) validateSupplementalExpression(item, diagnostics);
    } else if (value && typeof value === "object") {
      validateSupplementalExpression(value, diagnostics);
    }
  }
}

function validateSupplementalFunction(fn: any, diagnostics: ValidateDiagnostic[]): void {
  const params = fn.params ?? fn.functionParameters ?? [];
  const context: SupplementalFlowContext = {
    loopDepth: 0,
    switchDepth: 0,
    runtimeNames: new Set(params.map((param: any) => param.name)),
    initialized: new Set(),
    labels: new Map(),
    gotos: [],
  };

  let sawDefault = false;
  for (const param of params) {
    if (param.defaultValue) sawDefault = true;
    else if (sawDefault) {
      diagnostics.push(
        supplementalDiagnostic(
          `parameter '${param.name}' without a default follows a parameter with a default`,
          param.span ?? fn.span,
        ),
      );
    }
  }

  const walk = (statement: any, current: SupplementalFlowContext): void => {
    if (!statement) return;
    switch (statement.kind) {
      case "compound": {
        const scoped: SupplementalFlowContext = {
          ...current,
          runtimeNames: new Set(current.runtimeNames),
          initialized: new Set(current.initialized),
        };
        for (const child of statement.body ?? []) walk(child, scoped);
        return;
      }
      case "declaration": {
        const declaration = statement.declaration;
        if (declaration?.kind === "variable") {
          if (declaration.initializer) validateSupplementalExpression(declaration.initializer, diagnostics);
          if (
            isMutableReference(declaration.type) &&
            declaration.initializer &&
            !isModifiableLvalue(declaration.initializer)
          ) {
            diagnostics.push(
              supplementalDiagnostic(
                `mutable reference '${declaration.name}' cannot bind to a temporary`,
                declaration.initializer.span ?? declaration.span,
              ),
            );
          }
          if (!declaration.isConstexpr) current.runtimeNames.add(declaration.name);
          if (declaration.initializer)
            current.initialized.add(`${declaration.name}@${declaration.span?.start ?? 0}`);
        }
        return;
      }
      case "expression":
        validateSupplementalExpression(statement.expression, diagnostics);
        return;
      case "if":
        validateSupplementalExpression(statement.condition, diagnostics);
        walk(statement.then, {
          ...current,
          runtimeNames: new Set(current.runtimeNames),
          initialized: new Set(current.initialized),
        });
        if (statement.else_)
          walk(statement.else_, {
            ...current,
            runtimeNames: new Set(current.runtimeNames),
            initialized: new Set(current.initialized),
          });
        return;
      case "for": {
        const nested = {
          ...current,
          loopDepth: current.loopDepth + 1,
          runtimeNames: new Set(current.runtimeNames),
          initialized: new Set(current.initialized),
        };
        if (statement.initializer) walk(statement.initializer, nested);
        validateSupplementalExpression(statement.condition, diagnostics);
        validateSupplementalExpression(statement.update, diagnostics);
        walk(statement.body, nested);
        return;
      }
      case "while":
      case "do_while":
        validateSupplementalExpression(statement.condition, diagnostics);
        walk(statement.body, {
          ...current,
          loopDepth: current.loopDepth + 1,
          runtimeNames: new Set(current.runtimeNames),
          initialized: new Set(current.initialized),
        });
        return;
      case "switch":
        validateSupplementalExpression(statement.condition, diagnostics);
        walk(statement.body, {
          ...current,
          switchDepth: current.switchDepth + 1,
          runtimeNames: new Set(current.runtimeNames),
          initialized: new Set(current.initialized),
        });
        return;
      case "case":
        if (current.switchDepth === 0) {
          diagnostics.push(
            supplementalDiagnostic("case label is only valid inside a switch", statement.span),
          );
        } else if (expressionUsesRuntimeName(statement.value, current.runtimeNames)) {
          diagnostics.push(
            supplementalDiagnostic(
              "case label must be a constant expression",
              statement.value?.span ?? statement.span,
            ),
          );
        }
        validateSupplementalExpression(statement.value, diagnostics);
        return;
      case "default":
        if (current.switchDepth === 0) {
          diagnostics.push(
            supplementalDiagnostic("default label is only valid inside a switch", statement.span),
          );
        }
        return;
      case "break":
        if (current.loopDepth === 0 && current.switchDepth === 0) {
          diagnostics.push(
            supplementalDiagnostic("break is only valid inside a loop or switch", statement.span),
          );
        }
        return;
      case "goto":
        current.gotos.push({
          label: statement.label,
          span: statement.span,
          initialized: new Set(current.initialized),
        });
        return;
      case "label":
        if (current.labels.has(statement.name)) {
          diagnostics.push(
            supplementalDiagnostic(`duplicate label '${statement.name}'`, statement.span),
          );
        } else {
          current.labels.set(statement.name, {
            span: statement.span,
            initialized: new Set(current.initialized),
          });
        }
        return;
      case "return":
        validateSupplementalExpression(statement.value, diagnostics);
        return;
    }
  };

  if (fn.body) walk(fn.body, context);

  for (const jump of context.gotos) {
    const target = context.labels.get(jump.label);
    if (!target) {
      diagnostics.push(
        supplementalDiagnostic(`goto target '${jump.label}' is not defined`, jump.span),
      );
      continue;
    }
    if ([...target.initialized].some((declaration) => !jump.initialized.has(declaration))) {
      diagnostics.push(
        supplementalDiagnostic(
          `goto '${jump.label}' crosses an initialized declaration`,
          jump.span,
        ),
      );
    }
  }
}

function validateSupplementalDeclarations(
  declarations: any[],
  diagnostics: ValidateDiagnostic[],
): void {
  for (const declaration of declarations ?? []) {
    if (declaration.kind === "function" || declaration.kind === "function_template") {
      validateSupplementalFunction(declaration, diagnostics);
    }
    if (declaration.kind === "struct" || declaration.kind === "class_template") {
      validateSupplementalDeclarations(declaration.members, diagnostics);
    } else if (declaration.kind === "namespace" || declaration.kind === "extern_block") {
      validateSupplementalDeclarations(declaration.body, diagnostics);
    } else if (declaration.kind === "friend" && declaration.declaration) {
      validateSupplementalDeclarations([declaration.declaration], diagnostics);
    }
  }
}

export function validateAndDesugar(translationUnit: { declarations: Declaration[] }): ValidateDiagnostic[] {
  const diagnostics = validateAndDesugarBase(translationUnit);
  validateSupplementalDeclarations(translationUnit.declarations, diagnostics);

  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.severity}:${diagnostic.span.start}:${diagnostic.span.end}:${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
