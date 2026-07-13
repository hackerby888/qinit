# Qinit Compiler: Source to WAT/Wasm

The compiler's real job is:

```text
QPI-flavored C++ source
+ core-lite ABI/types
+ contract name and slot
        |
        v
preprocessed restricted C++
        |
        v
AST
        |
        v
type/layout/registration analysis
        |
        v
user WAT functions
        |
        v
core-lite runtime framework
        |
        v
complete WAT module
        |
        v
Wasm binary
```

Qinit does not use Clang internally. It directly compiles a restricted C++/QPI subset to WAT.

## Example input

This example comes from [`edge-audit-idl.test.ts`](../packages/compile/tests/edge/edge-audit-idl.test.ts):

```cpp
using namespace QPI;

struct CONTRACT_STATE2_TYPE {};

struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    uint64 balance;
    uint32 flags;
  };

  struct Put_input {
    uint32 tag;
    uint64 amount;
  };

  struct Put_output {
    uint8 ok;
    uint32 code;
  };

  struct Get_input {
    uint16 selector;
  };

  struct Get_output {
    uint64 amount;
  };

  PUBLIC_PROCEDURE(Put) {
    state.mut().balance = input.amount;
    output.ok = 1;
  }

  PUBLIC_FUNCTION(Get) {
    output.amount = state.get().balance;
  }

  INITIALIZE() {
    state.mut().flags = 1;
  }

  END_EPOCH() {
    state.mut().flags += 1;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Put, 7);
    REGISTER_USER_FUNCTION(Get, 9);
  }
};
```

With:

```ts
compileContract({
  source,
  name: "IdlEdge",
  slot: 27,
});
```

the resulting contract metadata is:

```ts
{
  name: "IdlEdge",
  slot: 27,
  stateSize: 16,
  procedures: [
    { name: "Put", inputType: 7, inSize: 16, outSize: 8 }
  ],
  functions: [
    { name: "Get", inputType: 9, inSize: 2, outSize: 8 }
  ],
  sysprocMask: 5
}
```

## 1. Public compiler entrypoint

The public function in [`index.ts`](../packages/compile/src/index.ts) is:

```ts
export async function compileContract(opts: CompileOpts): Promise<CompileResult> {
  return compileContractWithHeader({
    ...opts,
    qpiHeader: opts.qpiHeader ?? loadQpiHeader(),
  });
}
```

The caller supplies source, contract name, contract slot, optional callees, and compiler options.

The returned value is:

```ts
interface CompileResult {
  wasm: Uint8Array;
  diagnostics: ParserDiagnostic[];
  idl: ContractIdl;
  timings?: Record<string, number>;
}
```

`compileContract()` does not return WAT. WAT exists temporarily inside the pipeline. `generateWasmModule()` returns WAT, then the pipeline assembles it into Wasm.

## 2. Loading core-lite's QPI definitions

Qinit must know core-lite's:

- QPI structs and typedefs.
- Templates and container implementations.
- System procedure IDs.
- LHOST import names and signatures.
- `QpiContext` layout.
- Contract index definitions.

`loadQpiHeader()` therefore calls:

```ts
assembleQpiHeader(corePath);
```

See [`compiler/header.ts`](../packages/compile/src/compiler/header.ts) and [`qpi-snapshot.ts`](../packages/compile/src/qpi-snapshot.ts).

### 2.1 Why core-lite contains no JSON

Core declares the ABI with C preprocessor rows:

```cpp
#define LITE_DYN_ABI_VERSION 1u

#define LITE_SYSTEM_PROCEDURE_ROWS(X) \
    X(INITIALIZE, 0, initialize, __initializeEmpty) \
    X(BEGIN_EPOCH, 1, beginEpoch, __beginEpochEmpty) \
    /* ... */

#define LITE_LHOST_ABI_ROWS(GQ, GI, HQ, HI) \
    GQ("tick", tick, "()i") \
    HQ("transfer", transfer, w_transfer, "(iI)I") \
    /* ... */
```

Core's C++ build expands those rows directly. Core does not need JSON.

Qinit reads those rows and converts them into a TypeScript object:

```ts
{
  abiVersion: 1,
  lhost: [
    { name: "tick", params: [], results: ["i32"] },
    {
      name: "transfer",
      params: ["i32", "i64"],
      results: ["i64"]
    }
  ],
  systemProcedures: [
    { name: "INITIALIZE", id: 0, method: "initialize" }
  ]
}
```

Then `assembleQpiHeader()` inserts a generated comment into its returned string:

```text
//__QINIT_LITE_ABI__{"abiVersion":1,...}
```

That JSON exists only in Qinit's assembled in-memory header snapshot. It is not expected to exist in core's physical header files.

`embeddedLiteAbi()` reads it back:

```ts
export function embeddedLiteAbi(headers: string): LiteAbiSource {
  const line = headers
    .split(/\r?\n/)
    .find((value) => value.startsWith(LITE_ABI_MARKER));

  if (!line) {
    throw new Error("QPI headers are missing embedded core ABI metadata");
  }

  return JSON.parse(line.slice(LITE_ABI_MARKER.length)) as LiteAbiSource;
}
```

The marker is a comment, so the C++ parser ignores it. Qinit can still extract it from the original header string before preprocessing.

### 2.2 WAMR signature conversion

In the ABI signatures:

```text
i = i32
I = i64
```

Therefore:

```cpp
GQ("tick", tick, "()i")
```

means:

```wat
(import "lhost" "tick"
  (func $lh_tick (result i32)))
```

And:

```cpp
HQ("transfer", transfer, w_transfer, "(iI)I")
```

means:

```wat
(import "lhost" "transfer"
  (func $lh_transfer
    (param i32 i64)
    (result i64)))
```

The first `i32` is a linear-memory address to an aggregate such as `QPI::id`. The second parameter and result are 64-bit amounts.

### 2.3 What `assembleQpiHeader()` returns

Conceptually, it returns one large string:

```text
QPI compiler prelude

generated ABI JSON comment

contract index macros

pre_qpi_def.h
qpi.h
qpi_proposal_voting.h
oracle interface definitions

QpiContext buffer-size constant

implementation boundary
m256 implementation

implementation boundary
random implementation

implementation boundary
uint128 implementation

implementation boundary
container implementations

implementation boundary
normalized __lhost_* declarations
QpiContext wrapper implementations
```

`#pragma once` is not related to the ABI. Qinit explicitly reads each selected file once, so include guarding is not what makes this work.

## 3. Creating the reusable QPI context

`getQpiContext()` creates:

```ts
interface QpiContext {
  macros: Map<string, MacroDef>;
  lib: LibTypes;
}
```

It preprocesses and parses the main core headers:

```ts
const coreHeaderTu = new Parser(
  new Lexer(libText).tokenize(),
).parseTranslationUnit();

const coreLibrary = collectLibraryTypes(coreHeaderTu.declarations);
```

`collectLibraryTypes()` produces lookup tables containing:

```text
global structs
typedefs
templates
template specializations
enum values
constexpr values
QPI method bodies
namespace functions
host import declarations
namespace lookup contexts
```

It does not generate WAT. It creates the compiler's reusable representation of core's type library.

Implementation chunks are parsed separately and merged into that library. The result is cached so every contract does not need to reparse all core headers.

Separating declarations from implementation chunks also allows Qinit to attach real method bodies from headers such as container implementations without treating the entire assembled snapshot as one enormous translation unit.

## 4. Preprocessing user source

The pipeline constructs:

```ts
const source = `${SCAFFOLD_MACROS}
struct ${USER_BOUNDARY} {};
${sourceWithoutLeadingBom(opts.source)}`;
```

It runs the preprocessor with core's macro table:

```ts
const text = new Preprocessor().preprocess({
  source,
  qpiHeader: "",
  contractName: opts.name,
  contractIndex: opts.slot,
  seedMacros: qpi.macros,
});
```

`qpiHeader` is empty here because core's declarations have already been parsed into `qpi.lib`. The user source only needs the macro definitions from core, supplied through `seedMacros`.

The preprocessor defines contract-specific macros:

```cpp
#define CONTRACT_INDEX 27
#define IdlEdge_CONTRACT_INDEX 27
#define CONTRACT_STATE_TYPE IdlEdge
#define CONTRACT_STATE2_TYPE IdlEdge2
```

So:

```cpp
struct CONTRACT_STATE_TYPE : public ContractBase
```

becomes:

```cpp
struct IdlEdge : public ContractBase
```

### 4.1 Expanding `PUBLIC_PROCEDURE`

This:

```cpp
PUBLIC_PROCEDURE(Put) {
  state.mut().balance = input.amount;
}
```

becomes approximately:

```cpp
typedef NoData Put_locals;

static void Put(
  const QpiContextProcedureCall& qpi,
  void* state,
  Put_input& input,
  Put_output& output,
  Put_locals& locals
) {
  state.mut().balance = input.amount;
}
```

The macro is necessary because the parser needs to see a real function declaration with explicit parameter types.

### 4.2 Expanding registration macros

This:

```cpp
REGISTER_USER_PROCEDURE(Put, 7);
```

becomes approximately:

```cpp
qpi.__registerUserProcedure(
  (void*)Put,
  7,
  sizeof(Put_input),
  sizeof(Put_output),
  sizeof(Put_locals)
);
```

The compiler does not execute this call. It parses the call later to recover the ABI registration.

### 4.3 Expanding lifecycle methods

This:

```cpp
INITIALIZE() {
  state.mut().flags = 1;
}
```

becomes approximately:

```cpp
static void __impl_initialize(
  const QpiContextProcedureCall& qpi,
  void* state,
  NoData& input,
  NoData& output,
  void* locals
) {
  state.mut().flags = 1;
}
```

The synthetic name `__impl_initialize` is later matched with system procedure ID `0`.

## 5. Why the user-boundary struct exists

Qinit inserts:

```cpp
struct __qinit_user_boundary {};
```

The parser processes generated scaffold code before user code. Without a boundary, parser errors would refer to generated line numbers.

The boundary allows Qinit to:

- Ignore diagnostics from generated scaffolding.
- Remap line numbers back to the original source.
- Report errors against the user contract.

It has no runtime meaning and does not emit WAT.

## 6. Lexing

The lexer turns preprocessed source into tokens:

```text
kw_struct
identifier("IdlEdge")
colon
kw_public
identifier("ContractBase")
l_brace
...
```

Each token contains a source span:

```ts
{
  kind,
  text,
  span: {
    start,
    end,
    line,
    col,
  },
}
```

The lexer is needed so the parser reasons about language elements rather than individual characters. It also recognizes multiword built-in types and appends an explicit EOF token.

## 7. Parsing into an AST

The parser returns:

```ts
interface TranslationUnit {
  declarations: Declaration[];
  span: Span;
}
```

The example becomes conceptually:

```text
TranslationUnit
|- using namespace QPI
|- struct __qinit_user_boundary
|- struct IdlEdge2
`- struct IdlEdge : ContractBase
   |- struct StateData
   |- struct Put_input
   |- struct Put_output
   |- struct Get_input
   |- struct Get_output
   |- function Put
   |- function Get
   |- function __impl_initialize
   |- function __impl_endEpoch
   `- function __registerUserFunctionsAndProcedures
```

The expression:

```cpp
output.amount = state.get().balance;
```

becomes approximately:

```ts
{
  kind: "assign",
  op: "=",
  left: {
    kind: "member_access",
    object: {
      kind: "identifier",
      name: "output"
    },
    member: "amount"
  },
  right: {
    kind: "member_access",
    object: {
      kind: "call",
      callee: {
        kind: "member_access",
        object: {
          kind: "identifier",
          name: "state"
        },
        member: "get"
      },
      args: []
    },
    member: "balance"
  }
}
```

At this point codegen can operate on structured nodes instead of source text.

## 8. Validation

`validateAndDesugar(unit)` checks the supported contract language.

It detects problems such as:

- Duplicate definitions.
- Unsupported shadowing.
- Direct and mutual recursion.
- Invalid calls.
- Incorrect argument counts.
- Invalid control flow.
- Failed `static_assert` declarations.
- Invalid constant expressions.
- Unsupported mutation patterns.

Recursion is rejected because contract stack and locals usage need to remain statically bounded.

This is not a complete ISO C++ semantic analyzer. It validates the restricted C++/QPI subset that Qinit can faithfully lower.

## 9. The analyzing phase and `Sema`

The pipeline creates:

```ts
const sema = new Sema();
const calleeContext = collectCalleeContext(opts, qpi);
```

`Sema` currently owns:

- Errors.
- Warnings.
- Fidelity diagnostics.
- Constant-expression evaluation.

A lot of semantic work happens later inside `Codegen`:

- Name resolution.
- Namespace lookup.
- Struct layout.
- Typedef resolution.
- Template binding.
- Overload selection.
- Address-versus-value decisions.

So the current architecture is:

```text
syntax AST
    |
    v
validation
    |
    v
late semantic resolution during codegen
    |
    v
typed Wasm instruction IR
```

It does not first build a completely typed C++ AST.

### 9.1 Callee context

If the contract calls another contract, Qinit needs that contract's input and output types:

```cpp
CALL_OTHER_CONTRACT_FUNCTION(QX, GetFee, input, output)
```

`calleeSources` are separately preprocessed and parsed. Their declarations can be registered under qualified names such as:

```text
QX::GetFee_input
QX::GetFee_output
```

The corresponding `CalleeIdl` supplies:

- Contract index.
- Function/procedure kind.
- Numeric input type.
- Input size.
- Output size.

Without this information Qinit could not safely allocate cross-contract buffers or call `liteCallFunction` and `liteInvokeProcedure` with the correct ABI.

## 10. Starting WAT generation

The pipeline calls:

```ts
generateWasmModule(
  unit,
  sema,
  contractName,
  slot,
  arenaSize,
  qpi.lib,
  callees,
  calleeStructs,
  calleeTranslationUnits,
  sharedMemBase,
  metadata,
);
```

This creates:

```ts
const cg = new Codegen(sema);
```

Then it registers core library information, user declarations, callee declarations, and ABI metadata.

## 11. Registering core's library metadata

`registerLibraryMetadata(cg, lib)` copies into codegen:

```text
QPI structs
typedefs
templates
specializations
constants
enum values
QPI methods
namespace helper functions
host import declarations
```

It derives Wasm host signatures from parsed C++ declarations.

For example:

```cpp
unsigned int __lhost_tick();
```

becomes:

```wat
(import "lhost" "tick"
  (func $lh_tick (result i32)))
```

A pointer, reference, or aggregate parameter becomes `i32`, because it is represented by a linear-memory address. An eight-byte scalar becomes `i64`.

The derived signature is compared with the canonical ABI metadata extracted from core's macro rows. That prevents Qinit from compiling against one signature while WAMR registers another.

## 12. What `registerTopLevelDeclarations()` does

This line:

```ts
cg.registerTopLevelDeclarations(tu.declarations);
```

does not emit WAT.

It builds codegen lookup tables for:

- Namespaces.
- `using namespace` directives.
- `extern "C"` blocks.
- Global structs.
- Typedefs.
- Enums.
- Constants.
- Templates.
- Template specializations.
- Inline struct methods.
- Namespace helper functions.

For this contract it registers names such as:

```text
IdlEdge
IdlEdge2
StateData
Put_input
Put_output
Get_input
Get_output
Put
Get
__impl_initialize
__impl_endEpoch
__registerUserFunctionsAndProcedures
```

This is required before emission because functions can reference declarations appearing later:

```cpp
PUBLIC_PROCEDURE(Put) {
  Helper(input.amount);
}

static void Helper(uint64 amount) {
  // ...
}
```

Codegen must know about `Helper` before it starts emitting `Put`.

`registerTopLevelDeclarations()` is therefore codegen's symbol-indexing pass.

## 13. Finding the contract struct

Qinit searches for a struct inheriting from `ContractBase`.

For the example:

```cpp
struct IdlEdge : public ContractBase
```

is identified as the contract.

It then collects nested declarations such as:

```text
StateData
Put_input
Put_output
Put_locals
Get_input
Get_output
Get_locals
```

## 14. Computing memory layouts

Qinit implements C/C++-style struct alignment:

```text
align field offset
place field
advance by field size
round final struct size to maximum alignment
```

The layouts are:

| Struct | Field | Offset | Size |
|---|---|---:|---:|
| `StateData` | `balance` | 0 | 8 |
| `StateData` | `flags` | 8 | 4 |
| `StateData` | trailing padding | 12 | 4 |
| `Put_input` | `tag` | 0 | 4 |
| `Put_input` | padding | 4 | 4 |
| `Put_input` | `amount` | 8 | 8 |
| `Put_output` | `ok` | 0 | 1 |
| `Put_output` | padding | 1 | 3 |
| `Put_output` | `code` | 4 | 4 |

Therefore:

```text
sizeof(StateData) = 16
sizeof(Put_input) = 16
sizeof(Put_output) = 8
sizeof(Get_input) = 2
sizeof(Get_output) = 8
```

This is necessary because core and Wasm exchange raw bytes. If Qinit used the wrong offset, the Wasm contract would interpret the wrong memory.

## 15. Extracting registrations

After preprocessing, the registration function contains ordinary calls:

```cpp
qpi.__registerUserProcedure((void*)Put, 7, ...);
qpi.__registerUserFunction((void*)Get, 9, ...);
```

`extractRegistrations()` reads those calls and produces:

```ts
[
  {
    fnName: "Put",
    kind: 1,
    inputType: 7,
    constant: true
  },
  {
    fnName: "Get",
    kind: 0,
    inputType: 9,
    constant: true
  }
]
```

Runtime kinds are:

```text
0 = user function
1 = user procedure
2 = system procedure
3 = migration
```

The compiler verifies:

- Input type is a constant.
- Input type is in `1..65535`.
- No duplicate `(kind, inputType)` exists.
- The registered method has a body.
- Function/procedure context matches its registration.
- Input and output types exist.
- Input, output, and locals sizes fit ABI limits.

Registration order assigns labels:

```text
Put -> $user_0
Get -> $user_1
```

All registered labels are added before bodies are emitted so forward calls and recursive lookup can resolve consistently, even though recursive contract call cycles are rejected by validation.

## 16. Common five-pointer Wasm ABI

Every contract entry becomes:

```wat
(func $user_0
  (param $__qinit_ctx i32)
  (param $__qinit_state i32)
  (param $__qinit_in i32)
  (param $__qinit_out i32)
  (param $__qinit_locals i32)
  ;; body
)
```

The parameters are memory addresses:

```text
__qinit_ctx    -> QpiContext
__qinit_state  -> persistent StateData
__qinit_in     -> input bytes
__qinit_out    -> output bytes
__qinit_locals -> locals bytes
```

This common ABI lets core dispatch every entry uniformly. Type-specific information is represented by memory layouts and metadata instead of different Wasm signatures.

## 17. Lowering `Put`

Source:

```cpp
state.mut().balance = input.amount;
```

### 17.1 Resolve the destination

`state.mut()` resolves to:

```wat
(local.get $__qinit_state)
```

`balance` is at offset `0`, so its address remains the state base. Its size is eight bytes.

### 17.2 Resolve the source

`input.amount` is at input offset `8`:

```wat
(i64.load
  (i32.add
    (local.get $__qinit_in)
    (i32.const 8)))
```

### 17.3 Emit the assignment

Because `balance` is eight bytes, assignment uses `i64.store`:

```wat
(i64.store
  (local.get $__qinit_state)
  (i64.load
    (i32.add
      (local.get $__qinit_in)
      (i32.const 8))))
```

The second statement:

```cpp
output.ok = 1;
```

stores one byte:

```wat
(i32.store8
  (local.get $__qinit_out)
  (i32.wrap_i64
    (i64.const 1)))
```

The abridged generated function is:

```wat
(func $user_0
  (param $__qinit_ctx i32)
  (param $__qinit_state i32)
  (param $__qinit_in i32)
  (param $__qinit_out i32)
  (param $__qinit_locals i32)

  (i64.store
    (local.get $__qinit_state)
    (i64.load
      (i32.add
        (local.get $__qinit_in)
        (i32.const 8))))

  (i32.store8
    (local.get $__qinit_out)
    (i32.wrap_i64
      (i64.const 1)))
)
```

Qinit uses an internal `i64` scalar value model. Storage narrows according to field size:

```text
8 bytes -> i64.store
4 bytes -> i32.store
2 bytes -> i32.store16
1 byte  -> i32.store8
```

## 18. Lowering `Get`

Source:

```cpp
output.amount = state.get().balance;
```

Both fields are eight bytes at offset zero:

```wat
(func $user_1
  (param $__qinit_ctx i32)
  (param $__qinit_state i32)
  (param $__qinit_in i32)
  (param $__qinit_out i32)
  (param $__qinit_locals i32)

  (i64.store
    (local.get $__qinit_out)
    (i64.load
      (local.get $__qinit_state)))
)
```

C++ objects and references have disappeared. They have become memory addresses, offsets, loads, and stores.

## 19. Lowering system procedures

Core metadata maps:

```text
INITIALIZE -> ID 0
END_EPOCH  -> ID 2
```

The scaffold produced:

```text
__impl_initialize
__impl_endEpoch
```

Codegen maps those names to IDs and emits labels such as:

```text
$sys_0 -> INITIALIZE, ID 0
$sys_1 -> END_EPOCH, ID 2
```

Because IDs `0` and `2` are implemented:

```text
sysprocMask = (1 << 0) | (1 << 2)
            = 1 | 4
            = 5
```

`INITIALIZE` stores `flags` at state offset `8`:

```wat
(i32.store
  (i32.add
    (local.get $__qinit_state)
    (i32.const 8))
  (i32.wrap_i64
    (i64.const 1)))
```

`END_EPOCH` approximately becomes:

```wat
(i32.store
  (i32.add
    (local.get $__qinit_state)
    (i32.const 8))
  (i32.wrap_i64
    (i64.add
      (i64.extend_i32_u
        (i32.load
          (i32.add
            (local.get $__qinit_state)
            (i32.const 8))))
      (i64.const 1))))
```

## 20. QPI calls become LHOST calls

If the source contains:

```cpp
output.amount = qpi.tick();
```

core's QPI wrapper is equivalent to:

```cpp
uint32 QpiContextFunctionCall::tick() const {
  return __lhost_tick();
}
```

The Wasm import is:

```wat
(import "lhost" "tick"
  (func $lh_tick (result i32)))
```

The call is lowered approximately to:

```wat
(i64.store
  (local.get $__qinit_out)
  (i64.extend_i32_u
    (call $lh_tick)))
```

For aggregate parameters such as `QPI::id`, codegen passes an `i32` address into linear memory.

This same mechanism handles calls such as:

```cpp
qpi.transfer(...);
qpi.K12(...);
qpi.getEntity(...);
qpi.issueAsset(...);
```

Scalar values travel directly as `i32` or `i64`. Aggregate inputs and outputs are materialized in linear memory and passed by address.

## 21. Building the runtime framework

User functions alone are not a usable core-lite contract.

Core-lite also needs:

- LHOST imports.
- Memory.
- State and context addresses.
- Registration metadata.
- System procedure metadata.
- Allocation helpers.
- QPI forwarders.
- Dispatch.
- Migration support.
- Required exports.

`emitModule()` combines these:

```ts
return [
  "(module",
  emitImports(...),
  emitMemory(...),
  emitGlobals(...),
  emitExportList(),
  emitMemOps(),
  emitAllocators(...),
  emitForwarders(...),
  emitIntrinsics(...),
  emitMetadata(...),
  spec.userFunctionsWat,
  emitDispatch(...),
  emitInitialize(),
  ")",
].join("\n");
```

The module's linear memory is conceptually:

```text
linear memory
|- persistent StateData
|- QpiContext buffer
|- input area
|- output area
|- locals area
|- temporary arena
`- asset iterator buffer
```

The framework is necessary because Wasm itself does not know anything about QPI contracts, persistent state, numeric input types, system procedures, or core-lite dispatch.

## 22. Registration metadata in WAT

For this example:

```wat
(func $reg_count (result i32)
  (i32.const 2))
```

`reg_info(0, out)` writes:

```text
inputType = 7
kind      = 1
inSize    = 16
outSize   = 8
```

`reg_info(1, out)` writes:

```text
inputType = 9
kind      = 0
inSize    = 2
outSize   = 8
```

And:

```wat
(func $reg_sysproc_mask (result i32)
  (i32.const 5))
```

The runtime can inspect the Wasm artifact without parsing C++.

The TypeScript IDL is generated from the same `GeneratedContractMetadata`, preventing the returned IDL and emitted Wasm from being calculated independently.

## 23. Runtime dispatch

The dispatch signature is:

```wat
(func $dispatch
  (param $kind i32)
  (param $it i32)
  (param $inOff i32)
  (param $outOff i32)
  (param $localsOff i32))
```

Its arguments mean:

```text
kind      = function/procedure/system/migrate
it        = input type or system procedure ID
inOff     = input address
outOff    = output address
localsOff = locals address
```

For this contract, dispatch behaves conceptually like:

```text
if kind == 2 and it == 0:
    call INITIALIZE

if kind == 2 and it == 2:
    call END_EPOCH

if kind == 1 and (it & 0xffff) == 7:
    call Put

if kind == 0 and (it & 0xffff) == 9:
    call Get
```

The generated `Put` branch is structurally:

```wat
(if
  (i32.and
    (i32.eq
      (i32.and
        (local.get $it)
        (i32.const 0xffff))
      (i32.const 7))
    (i32.eq
      (local.get $kind)
      (i32.const 1)))
  (then
    (call $user_0
      (global.get $ctxBase)
      (global.get $stateBase)
      (local.get $inOff)
      (local.get $outOff)
      (local.get $localsOff))
    (return)))
```

Core does not need to know the generated name `$user_0`. It calls:

```text
dispatch(kind=procedure, inputType=7, ...)
```

The numeric ABI selects the implementation.

## 24. Complete WAT shape

The complete generated WAT is approximately:

```wat
(module
  ;; Host functionality
  (import "lhost" "tick" ...)
  (import "lhost" "transfer" ...)
  (import "lhost" "k12" ...)
  ;; ...

  ;; Linear memory
  (memory (export "memory") ...)

  ;; Runtime addresses
  (global $stateBase i32 ...)
  (global $ctxBase i32 ...)
  (global $arenaBase i32 ...)

  ;; Runtime exports
  (export "dispatch" (func $dispatch))
  (export "state_size" (func $state_size))
  (export "reg_count" (func $reg_count))
  (export "reg_info" (func $reg_info))
  (export "reg_sysproc_mask" (func $reg_sysproc_mask))

  ;; Memory/runtime helpers
  (func $setMem ...)
  (func $copyMem ...)
  (func $qpiAllocLocals ...)

  ;; QPI forwarders
  (func $qpi_transferTyped ...)
  (func $liteCallFunction ...)

  ;; Metadata
  (func $state_size (result i32)
    (i32.const 16))

  (func $reg_count (result i32)
    (i32.const 2))

  (func $reg_sysproc_mask (result i32)
    (i32.const 5))

  ;; User entries
  (func $user_0 ...) ;; Put
  (func $user_1 ...) ;; Get

  ;; System procedures
  (func $sys_0 ...)  ;; INITIALIZE
  (func $sys_1 ...)  ;; END_EPOCH

  ;; Numeric ABI dispatcher
  (func $dispatch ...)
)
```

`generateWasmModule()` returns this complete WAT string.

## 25. WAT to Wasm

Finally, the pipeline uses WABT:

```ts
const wabt = await import("wabt");
const module = await wabt.default();
const parsed = module.parseWat("contract.wat", wat);

parsed.validate();

const wasm = new Uint8Array(
  parsed.toBinary({}).buffer,
);
```

Then Qinit runs:

```ts
WebAssembly.validate(wasm);
inspectLiteWasmModule(wasm, ...);
```

These checks detect:

- Invalid Wasm instruction types.
- Missing required exports.
- Incorrect LHOST imports.
- Wrong import signatures.
- Wrong memory mode.
- Invalid lite runtime ABI shape.

The final result is:

```ts
{
  wasm,
  diagnostics,
  idl,
  timings,
}
```

## Why every layer is needed

| Layer | Why it exists |
|---|---|
| `assembleQpiHeader()` | Turns the live core checkout into one compiler-consumable snapshot. |
| Embedded ABI JSON | Carries core's canonical numeric/Wasm ABI without another handwritten table. |
| QPI library parsing | Gives codegen real QPI types, templates, constants, and method bodies. |
| Preprocessor | Converts QPI macros and contract-specific names into parseable declarations. |
| Lexer | Converts text into structured tokens with source positions. |
| Parser | Converts tokens into declarations, statements, and expressions. |
| Validator | Rejects invalid or unsupported constructs before emission. |
| `registerTopLevelDeclarations()` | Builds symbol/type/namespace lookup tables and enables forward references. |
| Layout computation | Makes Wasm memory byte-compatible with native core structs. |
| Registration extraction | Connects C++ method names to the numeric runtime protocol. |
| Codegen | Converts AST expressions into typed Wasm loads, stores, calls, and control flow. |
| Framework emitter | Adds memory, imports, metadata, helpers, and dispatch required by core-lite. |
| WABT | Encodes textual WAT into binary Wasm. |
| Wasm inspection | Confirms that the final artifact obeys the lite runtime ABI. |

## Shortest accurate summary

```text
1. Qinit reads core-lite and constructs a compiler snapshot.
2. It converts core's ABI macro rows into internal JSON metadata.
3. It preprocesses QPI macros into ordinary restricted C++.
4. It lexes and parses that C++ into an AST.
5. It validates the supported contract subset.
6. It indexes declarations and computes native-compatible layouts.
7. It extracts numeric function/procedure registrations.
8. It lowers C++ references and fields into Wasm memory operations.
9. It wraps user functions with imports, metadata, memory, and dispatch.
10. It returns WAT internally, then assembles it into Wasm.
```

The central idea is:

```text
Qinit first learns core's ABI and QPI type system.

Then it rewrites QPI macro-C++ into a restricted ordinary C++ AST.

Then it converts C++ objects and references into byte offsets in Wasm memory.

Finally it surrounds those lowered functions with the dispatch and metadata
protocol that core-lite expects.
```
