# Qinit Compiler Architecture

The compiler is organized by responsibility. Root-level files such as `parser.ts`,
`validate.ts`, and `framework.ts` are compatibility facades; compiler logic lives in
the directories described below.

## Pipeline

```text
contract source
  -> preprocessing
  -> tokenization
  -> parsing
  -> validation
  -> program analysis
  -> Wasm lowering
  -> module and framework assembly
  -> WAT text
```

`src/compiler/compile-contract.ts` coordinates these stages. It prepares the QPI
context, preprocesses the contract, parses and validates the resulting translation
unit, creates `ProgramAnalysis`, and asks the Wasm backend to build the module.

## Dependency Direction

```text
shared / ast
      ^
      |
  frontend
      ^
      |
  analysis
      ^
      |
   backend
      ^
      |
  compiler
```

Dependencies point upward in this diagram toward simpler layers. Frontend code does
not import analysis or backend code. Analysis does not import the backend. Backend
code does not import compiler orchestration.

`tests/architecture/module-boundaries.test.ts` enforces the dependency direction,
detects runtime import cycles, rejects internal imports through legacy `codegen`
facades, and limits handwritten source files to 500 lines.

## Source Map

| Question | Implementation |
| --- | --- |
| Where is a source file compiled? | `src/compiler/compile-contract.ts` |
| Where is QPI/core context assembled? | `src/compiler/qpi-context.ts` |
| Where are preprocessor directives handled? | `src/frontend/preprocessor/directives.ts` |
| Where are macros expanded? | `src/frontend/preprocessor/macro-expander.ts` |
| Where are tokens produced? | `src/frontend/lexer/` |
| Where are declarations dispatched? | `src/frontend/parser/declarations/declaration-parser.ts` |
| Where are structs and classes parsed? | `src/frontend/parser/declarations/record-parser.ts` |
| Where are functions parsed? | `src/frontend/parser/declarations/function-parser.ts` |
| Where are templates parsed? | `src/frontend/parser/declarations/template-parser.ts` |
| Where are statements parsed? | `src/frontend/parser/statement-parser.ts` |
| Where are expressions parsed? | `src/frontend/parser/expressions/` |
| Where are types parsed? | `src/frontend/parser/types/` |
| Where is semantic validity checked? | `src/frontend/validation/` |
| Where are declarations indexed? | `src/analysis/declaration-index.ts` |
| Where are template types resolved? | `src/analysis/template-resolver.ts` |
| Where are struct layout and inheritance resolved? | `src/analysis/struct-layout.ts` |
| Where are type size and alignment resolved? | `src/analysis/type-layout.ts` |
| Where are functions found? | `src/analysis/function-index.ts` |
| Where are constants evaluated? | `src/analysis/constant-evaluator.ts` |
| Where does function Wasm emission begin? | `src/backend/wasm/functions/function-emitter.ts` |
| Where are locals collected? | `src/backend/wasm/functions/local-collector.ts` |
| Where are statements lowered? | `src/backend/wasm/statements/` |
| Where are value expressions lowered? | `src/backend/wasm/expressions/value-expression.ts` |
| Where are assignments lowered? | `src/backend/wasm/expressions/assignment.ts` |
| Where are calls dispatched? | `src/backend/wasm/calls/dispatcher.ts` |
| Where are QPI calls lowered? | `src/backend/wasm/calls/qpi.ts` |
| Where are library calls lowered? | `src/backend/wasm/calls/library-call.ts` |
| Where are addresses resolved? | `src/backend/wasm/memory/address-resolution.ts` |
| Where are loads and stores emitted? | `src/backend/wasm/memory/memory-operations.ts` |
| Where is the contract module assembled? | `src/backend/wasm/module/module-generator.ts` |
| Where is the QPI framework emitted? | `src/backend/wasm/framework/module-emitter.ts` |
| Where are framework dispatchers emitted? | `src/backend/wasm/framework/dispatch.ts` |
| Where are WAT nodes defined? | `src/wat-ir.ts` |
| Where is generated Wasm inspected? | `src/compiler/wasm-inspection/` |

## Main Representations

`TranslationUnit` is the parser output. It contains declarations for the contract and
for parsed QPI implementation chunks.

`ProgramAnalysis` is the reusable semantic view consumed by lowering. It indexes
declarations, resolves names and templates, calculates layouts, evaluates constants,
and exposes function and container metadata. It does not emit WAT.

`FunctionEmissionContext` contains the mutable state for one emitted function,
including locals, labels, template bindings, analysis, and lowering services.

The Wasm backend produces nodes from `wat-ir.ts`. Module assembly then serializes
those nodes as WAT text.

## Backend Organization

`backend/wasm/functions` owns function-level setup and local discovery.

`backend/wasm/statements` owns control flow and statement lowering.

`backend/wasm/expressions` owns values, operators, conversions, and assignments.

`backend/wasm/memory` owns address calculation, construction, loads, and stores.

`backend/wasm/calls` owns call classification and specialized call lowering.

`backend/wasm/module` owns declaration registration and final contract module
assembly.

`backend/wasm/framework` owns host imports, runtime helpers, dispatchers, metadata,
and other framework code surrounding the contract.

## Compatibility Facades

The files under `src/codegen/` and the root files `ast.ts`, `lexer.ts`, `parser.ts`,
`preprocess.ts`, `validate.ts`, `sema.ts`, and `framework.ts` preserve existing import
paths. New implementation code should import the owning module directly rather than
using these facades.

## Naming Rules

- Name functions after the work they perform, such as `collectLocalVariables` or
  `resolveSourceModule`.
- Name state objects after their role: `programAnalysis`, `parserContext`, or
  `functionContext`.
- Avoid one-letter names except conventional short loop indexes.
- Prefer `emit` for WAT generation, `resolve` for semantic lookup, `collect` for
  traversal without mutation, and `register` for adding indexed declarations.
- Keep public compatibility names only in facade modules.

## Adding Compiler Support

1. Extend the AST only when the syntax needs a new representation.
2. Add parsing in the narrow frontend parser module that owns the construct.
3. Add validation before relying on the construct in analysis or lowering.
4. Add reusable semantic lookup or layout behavior under `analysis`.
5. Lower the construct in the matching backend domain.
6. Add focused tests beside the existing parser, edge, QPI, or architecture tests.

Do not put feature logic into a compatibility facade or into compile orchestration.
