# Qinit Compiler Architecture

The compiler is organized by layer. `src/` holds nothing but the two bundler entry points; every
other file belongs to one of the directories below.

```text
src/
  index.ts  browser.ts   the two entry points (plus ./analyzer, which is analyzer/index.ts)
  generated/             committed build artefacts — the embedded QPI header snapshot
  shared/                enums, scalar sizes, entry-ABI constants
  ast/                   the C++-subset AST and its debug printer
  frontend/              lexer, preprocessor, parser, validation
  analysis/              ProgramAnalysis — the reusable semantic view
  backend/wasm/          lowering to WAT: the IR, expressions, memory, calls, module, framework, idl
  driver/                orchestration: options, phases, QPI context, diagnostics, wasm inspection
  analyzer/              the IDE lint product, on top of everything else
```

## Pipeline

```text
contract source
  -> preprocessing
  -> tokenization
  -> parsing
  -> validation
  -> Wasm lowering (program analysis happens here — see below)
  -> module and framework assembly
  -> WAT text
  -> wabt encode + inspect
```

`src/driver/compile-contract.ts` coordinates these stages. It prepares the QPI context,
preprocesses the contract, parses and validates the resulting translation unit, then asks the Wasm
backend to build the module.

**Known divergence — the declared phases do not match the real ones.** The phase named `analyzing`
only constructs `SemanticAnalyzer`, a diagnostics and constexpr bag. The real semantic model,
`ProgramAnalysis`, is built inside the backend by `backend/wasm/module/module-analysis.ts` during the
`generating wasm` phase. Fixing this means moving that construction up into the driver and declaring
the phase list as data in one file, the way GCC's `passes.def` does. Until then, treat `analysis/` as
a backend sub-phase rather than a pipeline stage.

## Dependency Direction

```text
generated < shared < ast < frontend < analysis < backend < driver < analyzer
```

A layer may import anything to its left and nothing to its right. `tests/architecture/module-boundaries.test.ts`
enforces this, and four more rules that keep the tree honest:

- the source root contains only `index.ts` and `browser.ts`,
- every other file sits under one of the layers named above,
- runtime imports are acyclic, and type-only cycles never cross a layer boundary — the `*-context.ts`
  pattern, where a split class hands itself back to its own parts, stays inside one layer,
- no file exceeds 700 lines.

## Source Map

| Question                                          | Implementation                                            |
| ------------------------------------------------- | --------------------------------------------------------- |
| Where is a source file compiled?                  | `src/driver/compile-contract.ts`                          |
| Where is QPI/core context assembled?              | `src/driver/qpi-context.ts`, `src/driver/qpi/`            |
| Where are preprocessor directives handled?        | `src/frontend/preprocessor/directive-handler.ts`          |
| Where are macros expanded?                        | `src/frontend/preprocessor/macro-expander.ts`             |
| Where are tokens produced?                        | `src/frontend/lexer/`                                     |
| Where are declarations dispatched?                | `src/frontend/parser/declarations/declaration-parser.ts`  |
| Where are structs and classes parsed?             | `src/frontend/parser/declarations/record-parser.ts`       |
| Where are functions parsed?                       | `src/frontend/parser/declarations/function-parser.ts`     |
| Where are templates parsed?                       | `src/frontend/parser/declarations/template-parser.ts`     |
| Where are statements parsed?                      | `src/frontend/parser/statement-parser.ts`                 |
| Where are expressions parsed?                     | `src/frontend/parser/expressions/`                        |
| Where are types parsed?                           | `src/frontend/parser/types/`                              |
| Where is semantic validity checked?               | `src/frontend/validation/`                                |
| Where are declarations indexed?                   | `src/analysis/declaration-index.ts`                       |
| Where are template types resolved?                | `src/analysis/template-resolver.ts`                       |
| Where are struct layout and inheritance resolved? | `src/analysis/struct-layout.ts`                           |
| Where are type size and alignment resolved?       | `src/analysis/type-layout.ts`                             |
| Where are functions found?                        | `src/analysis/function-index.ts`                          |
| Where are constants evaluated?                    | `src/analysis/constant-evaluator.ts`                      |
| Where does function Wasm emission begin?          | `src/backend/wasm/functions/function-emitter.ts`          |
| Where are locals collected?                       | `src/backend/wasm/functions/local-collector.ts`           |
| Where are statements lowered?                     | `src/backend/wasm/statements/`                            |
| Where are value expressions lowered?              | `src/backend/wasm/expressions/value-expression.ts`        |
| Where are assignments lowered?                    | `src/backend/wasm/expressions/assignment.ts`              |
| Where are calls dispatched?                       | `src/backend/wasm/calls/dispatcher.ts`                    |
| Where are QPI calls lowered?                      | `src/backend/wasm/calls/qpi.ts`                           |
| Where are library calls lowered?                  | `src/backend/wasm/calls/library-call.ts`                  |
| Where is gtest harness code lowered?              | `src/backend/wasm/gtest/`                                 |
| Where are addresses resolved?                     | `src/backend/wasm/memory/address-resolution.ts`           |
| Where are loads and stores emitted?               | `src/backend/wasm/memory/memory-operations.ts`            |
| Where is the contract module assembled?           | `src/backend/wasm/module/module-generator.ts`             |
| Where is the contract IDL built?                  | `src/backend/wasm/idl/`                                   |
| Where is the QPI framework emitted?               | `src/backend/wasm/framework/module-emitter.ts`            |
| Where are framework dispatchers emitted?          | `src/backend/wasm/framework/dispatch.ts`                  |
| Where are WAT nodes defined?                      | `src/backend/wasm/wat-ir.ts`                              |
| Where is generated Wasm inspected?                | `src/driver/wasm-inspection/`                             |
| Where do the IDE lint rules live?                 | `src/analyzer/source-policy.ts` and `src/analyzer/rules/` |

## Main Representations

`TranslationUnit` is the parser output. It contains declarations for the contract and
for parsed QPI implementation chunks.

`ProgramAnalysis` is the reusable semantic view consumed by lowering. It indexes
declarations, resolves names and templates, calculates layouts, evaluates constants,
and exposes function and container metadata. It does not emit WAT.

`FunctionEmissionContext` contains the mutable state for one emitted function,
including locals, labels, template bindings, analysis, and lowering services.

The Wasm backend produces nodes from `backend/wasm/wat-ir.ts`. Module assembly then serializes
those nodes as WAT text.

## Backend Organization

`backend/wasm/functions` owns function-level setup and local discovery.

`backend/wasm/statements` owns control flow and statement lowering.

`backend/wasm/expressions` owns values, operators, conversions, and assignments.

`backend/wasm/memory` owns address calculation, construction, loads, and stores.

`backend/wasm/calls` owns call classification and specialized call lowering.

`backend/wasm/gtest` owns the harness-only call and assignment lowering, kept out of the
production paths above.

`backend/wasm/module` owns declaration registration and final contract module assembly.

`backend/wasm/idl` owns the second output artifact: the `ContractIdl` a compiled module publishes.

`backend/wasm/framework` owns host imports, runtime helpers, dispatchers, metadata,
and other framework code surrounding the contract.

## Naming Rules

- Name functions after the work they perform, such as `collectLocalVariables` or
  `resolveSourceModule`.
- Name state objects after their role: `programAnalysis`, `parserContext`, or
  `functionContext`.
- Avoid one-letter names except conventional short loop indexes.
- Prefer `emit` for WAT generation, `resolve` for semantic lookup, `collect` for
  traversal without mutation, and `register` for adding indexed declarations.

## Adding Compiler Support

1. Extend the AST only when the syntax needs a new representation.
2. Add parsing in the narrow frontend parser module that owns the construct.
3. Add validation before relying on the construct in analysis or lowering.
4. Add reusable semantic lookup or layout behavior under `analysis`.
5. Lower the construct in the matching backend domain.
6. Add focused tests beside the existing parser, edge, QPI, or architecture tests.

Do not put feature logic into compile orchestration, and do not add a re-export module at the source
root — the boundary test rejects both.
