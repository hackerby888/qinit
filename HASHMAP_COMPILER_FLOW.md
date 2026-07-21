# HashMap Contract: Compiler and VirtualEngine Flow

## 1. Example smart contract

This contract deliberately uses:

- A custom hash function, so `HashMap` itself needs no host call.
- `qpi.tick()`, so one real VirtualEngine import can be traced separately.

```cpp
using namespace QPI;

struct KeyHash
{
    static uint64 hash(const uint64& key)
    {
        return key & 7;
    }
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        HashMap<uint64, uint64, 8, KeyHash> values;
        uint32 lastWriteTick;
    };

    struct Put_input
    {
        uint64 key;
        uint64 value;
    };

    struct Put_output
    {
        sint64 index;
        uint64 population;
        uint32 tick;
    };

    PUBLIC_PROCEDURE(Put)
    {
        output.index = state.mut().values.set(input.key, input.value);
        output.population = state.get().values.population();

        state.mut().lastWriteTick = qpi.tick();
        output.tick = state.get().lastWriteTick;
    }

    struct Get_input
    {
        uint64 key;
    };

    struct Get_output
    {
        uint64 found;
        uint64 value;
    };

    PUBLIC_FUNCTION(Get)
    {
        output.value = 0;
        output.found =
            state.get().values.get(input.key, output.value)
                ? 1
                : 0;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Put, 1);
        REGISTER_USER_FUNCTION(Get, 2);
    }
};
```

The fundamental architecture is:

```text
core-lite C++ headers
|-- HashMap declaration and layout
|-- HashMap method implementations
|-- QPI method implementations
`-- lhost declarations and ABI metadata
              |
              v
       Qinit compiler library
              |
user source --+--> generated WAT/Wasm
              |
              v
     VirtualNode/Sim/Contract
       only provides lhost
```

The VirtualEngine does not provide `HashMap`. It provides environmental operations such as `tick`, `k12`, transfers, assets, and inter-contract calls.

---

# Part A: How core-lite is wired into the compiler

## 2. Public `compileContract()` loads core-lite

A caller does approximately:

```ts
const result = await compileContract({
  name: "HashMapDemo",
  slot: 28,
  source,
});
```

The public API inserts a QPI header snapshot when the caller did not provide one:

```ts
return compileContractWithHeader({
  ...options,
  qpiHeader: options.qpiHeader ?? loadQpiHeader(),
});
```

See [`packages/compile/src/index.ts`](packages/compile/src/index.ts#L19).

For Node/Bun, `loadQpiHeader()` reads:

```text
QINIT_CORE=/home/kali/Projects/core-lite
```

and calls:

```ts
assembleQpiHeader(configuredCorePath)
```

See [`packages/compile/src/compiler/header.ts`](packages/compile/src/compiler/header.ts#L4).

This means the Node compiler uses the selected live core-lite checkout. The browser compiler instead uses the generated snapshot because a browser cannot read `/home/kali/Projects/core-lite`.

## 3. `assembleQpiHeader()` builds one compiler snapshot

The snapshot has several logically different sections:

```text
QPI_PRELUDE
canonical Lite ABI JSON
contract index macros
pre_qpi_def.h
qpi.h
proposal and oracle declarations
QpiContext size metadata
IMPL_BOUNDARY
m256 implementation
IMPL_BOUNDARY
random implementation
IMPL_BOUNDARY
uint128 implementation
IMPL_BOUNDARY
qpi_hash_map_impl.h
IMPL_BOUNDARY
other implementations
IMPL_BOUNDARY
lhost declarations and QPI host wrappers
```

See [`packages/compile/src/qpi-snapshot.ts`](packages/compile/src/qpi-snapshot.ts#L55).

For this example, the two important core files are:

### Declaration and layout

[`core-lite/src/contracts/qpi.h`](/home/kali/Projects/core-lite/src/contracts/qpi.h#L1137) provides:

```cpp
template <
    typename KeyT,
    typename ValueT,
    uint64 L,
    typename HashFunc = HashFunction<KeyT>
>
class HashMap
{
    struct Element
    {
        KeyT key;
        ValueT value;
    } _elements[L];

    uint64 _occupationFlags[(L * 2 + 63) / 64];
    uint64 _population;
    uint64 _markRemovalCounter;

public:
    bool get(const KeyT& key, ValueT& value) const;
    sint64 set(const KeyT& key, const ValueT& value);
    uint64 population() const;
};
```

### Method implementations

[`core-lite/src/contract_core/qpi_hash_map_impl.h`](/home/kali/Projects/core-lite/src/contract_core/qpi_hash_map_impl.h#L109) provides the real `set()` algorithm:

```cpp
template <typename KeyT, typename ValueT, uint64 L, typename HashFunc>
sint64 HashMap<KeyT, ValueT, L, HashFunc>::set(
    const KeyT& key,
    const ValueT& value
)
{
    if (_population < capacity())
    {
        sint64 markedForRemovalIndexForReuse = NULL_INDEX;
        sint64 index = HashFunc::hash(key) & (L - 1);

        // Search slots, resolve collisions, update flags,
        // copy key/value, and increment population.
        // ...
    }

    return NULL_INDEX;
}
```

Qinit is not implementing this algorithm in JavaScript. It parses and compiles this C++ body.

## 4. Why `IMPL_BOUNDARY` exists

The compiler does not parse everything as one enormous translation unit.

`getQpiContext()` splits the assembled snapshot:

```ts
const [mainHeaders, ...implChunks] =
    headers.split(IMPL_BOUNDARY);
```

See [`packages/compile/src/compiler/qpi-context.ts`](packages/compile/src/compiler/qpi-context.ts#L36).

The main section provides:

```text
types
class templates
field declarations
method declarations
typedefs
constants
macros
```

Each implementation chunk provides:

```text
out-of-class method bodies
free helper function bodies
template method implementations
lhost wrapper bodies
```

For `HashMap`, the resulting reusable library contains approximately:

```ts
library.templates.get("HashMap")
```

with the declaration and fields, and:

```ts
library.templateMethods.get("HashMap")
```

with entries such as:

```text
set/2
get/2
population/0
getElementIndex/1
_getEncodedOccupationFlags/2
capacity/0
```

Out-of-class definitions such as `HashMap::set` are captured in [`packages/compile/src/analysis/declaration-index.ts`](packages/compile/src/analysis/declaration-index.ts#L139).

The result is cached by the complete header text. Multiple contracts using the same core snapshot do not repeatedly parse all core headers.

---

# Part B: How user source is wired to the core library

## 5. Core headers are not pasted before the user contract

This is the most important distinction.

The user source is preprocessed separately:

```ts
const source = [
  SCAFFOLD_MACROS,
  "struct __qinit_user_boundary {};",
  options.source,
].join("\n");
```

The preprocessor receives core's macro table:

```ts
new Preprocessor().preprocess({
  source,
  qpiHeader: "",
  contractName: options.name,
  contractIndex: options.slot,
  seedMacros: qpiContext.macros,
});
```

See [`packages/compile/src/compiler/contract-frontend.ts`](packages/compile/src/compiler/contract-frontend.ts#L23).

So there are two separate objects:

```text
QpiContext.lib
    Core declarations, templates, method bodies, imports

TranslationUnit
    User contract declarations and function bodies
```

They are combined semantically during code generation, not textually before parsing.

## 6. Macro expansion produces ordinary functions

The scaffold replaces Qubic macros with parser-friendly declarations.

For example:

```cpp
PUBLIC_PROCEDURE(Put)
```

expands to approximately:

```cpp
typedef NoData Put_locals;

static void Put(
    const QpiContextProcedureCall& qpi,
    void* state,
    Put_input& input,
    Put_output& output,
    Put_locals& locals
)
```

See [`packages/compile/src/qpi-scaffold.ts`](packages/compile/src/qpi-scaffold.ts#L77).

Registration expands from:

```cpp
REGISTER_USER_PROCEDURE(Put, 1);
```

to:

```cpp
qpi.__registerUserProcedure(
    (void*)Put,
    1,
    sizeof(Put_input),
    sizeof(Put_output),
    sizeof(Put_locals)
);
```

See [`packages/compile/src/qpi-scaffold.ts`](packages/compile/src/qpi-scaffold.ts#L86).

The parser therefore receives ordinary C++-like functions and calls rather than opaque Qubic macros.

## 7. The user AST for the map declaration

The field:

```cpp
HashMap<uint64, uint64, 8, KeyHash> values;
```

becomes approximately:

```ts
{
  kind: "variable",
  name: "values",
  type: {
    kind: "template_instance",
    name: "HashMap",
    callArguments: [
      { kind: "name", name: "uint64" },
      { kind: "name", name: "uint64" },
      { kind: "expr_value", value: 8 },
      { kind: "name", name: "KeyHash" }
    ]
  }
}
```

The user AST does not contain the `HashMap` field definitions or `set()` body. It only contains the template instance.

Those details are resolved from `qpiContext.lib`.

## 8. Code generation merges the two models

The compile pipeline performs these phases:

```text
loading qpi.h
preprocessing
parsing
validating
analyzing
generating wasm
assembling wasm
```

See [`packages/compile/src/compiler/compile-contract.ts`](packages/compile/src/compiler/compile-contract.ts#L25).

During module generation:

```ts
registerLibraryMetadata(programAnalysis, qpiContext.lib);
registerModuleDeclarations(programAnalysis, userDeclarations, ...);
```

Conceptually, `ProgramAnalysis` now contains:

```text
Core:
  templates["HashMap"]
  templateMethods["HashMap"]
  typedefs["uint64"]
  globalStructs["QpiContextProcedureCall"]
  helpers["__lhost_tick"]
  ...

User:
  globalStructs["KeyHash"]
  globalStructs["CONTRACT_STATE_TYPE"]
  nested["StateData"]
  nested["Put_input"]
  nested["Put_output"]
  ...
```

The core and user ASTs remain separate, but symbol lookup sees both.

---

# Part C: Layout generation

## 9. Binding the concrete `HashMap` template

For:

```cpp
HashMap<uint64, uint64, 8, KeyHash>
```

`bindContainer()` creates:

```text
Type bindings:
  KeyT      -> uint64
  ValueT    -> uint64
  HashFunc  -> KeyHash

Value bindings:
  L              -> 8
  _nEncodedFlags -> 8

Nested structs:
  Element -> {
      KeyT key;
      ValueT value;
  }
```

See [`packages/compile/src/analysis/template-resolver.ts`](packages/compile/src/analysis/template-resolver.ts#L154).

The compiler then computes the layout from the parsed core declaration.

For this instance:

| Field | Offset | Size |
|---|---:|---:|
| `_elements[8]` | 0 | 128 |
| `_occupationFlags[1]` | 128 | 8 |
| `_population` | 136 | 8 |
| `_markRemovalCounter` | 144 | 8 |
| Entire `HashMap` | 0 | 152 |

Each `Element` is:

```text
key:   offset 0, size 8
value: offset 8, size 8
total: 16
```

The contract state is therefore:

| Field | Offset | Size |
|---|---:|---:|
| `values` | 0 | 152 |
| `lastWriteTick` | 152 | 4 |
| tail padding | 156 | 4 |
| `StateData` | 0 | 160 |

The VirtualEngine does not know any of these fields. To it, state is simply 160 persistent bytes.

---

# Part D: Lowering `HashMap::set`

## 10. AST shape of the call

This expression:

```cpp
state.mut().values.set(input.key, input.value)
```

has a shape approximately like:

```text
call
|-- callee: member_access ".set"
|   `-- object: member_access ".values"
|       `-- object: call ".mut"
|           `-- object: identifier "state"
`-- arguments
    |-- member_access input.key
    `-- member_access input.value
```

Address resolution determines:

```text
state.mut() address = $__qinit_state
values offset       = 0
map address         = $__qinit_state + 0

input.key address   = $__qinit_in + 0
input.value address = $__qinit_in + 8
```

No JavaScript object is created.

## 11. `emitContainerCall()` recognizes the method

`emitContainerCall()` resolves the receiver type:

```cpp
HashMap<uint64, uint64, 8, KeyHash>
```

It then calls:

```ts
callCompiled(
  context,
  concreteHashMapType,
  "set",
  mapAddress,
  [inputKey, inputValue]
);
```

See [`packages/compile/src/backend/wasm/calls/containers.ts`](packages/compile/src/backend/wasm/calls/containers.ts#L288).

`compileContainerMethod()` builds a cache key resembling:

```text
HashMap<uint64,uint64,8,KeyHash>::set/2
```

If it has not been generated yet, it asks:

```ts
programAnalysis.methodTemplate(
  "HashMap",
  templateArguments,
  "set",
  2
);
```

That finds the parsed body from `qpi_hash_map_impl.h`.

See [`packages/compile/src/analysis/function-index.ts`](packages/compile/src/analysis/function-index.ts#L38).

## 12. Method parameter ABI

The core method is:

```cpp
sint64 set(
    const KeyT& key,
    const ValueT& value
);
```

Both parameters are references, so the generated Wasm function takes addresses:

```wat
(func $T0_HashMap_set
  (param $this i32)
  (param $key i32)
  (param $value i32)
  (result i64)

  ;; compiled core implementation
)
```

The call from `Put` resembles:

```wat
(call $T0_HashMap_set
  (local.get $__qinit_state)
  (local.get $__qinit_in)
  (i32.add
    (local.get $__qinit_in)
    (i32.const 8)
  )
)
```

The helper number may differ, but the calling convention is as above.

The returned `sint64` index is written to `Put_output.index`:

```wat
(i64.store
  (local.get $__qinit_out)
  (call $T0_HashMap_set ...)
)
```

## 13. Core's algorithm becomes ordinary Wasm

The core statement:

```cpp
sint64 index = HashFunc::hash(key) & (L - 1);
```

becomes conceptually:

```wat
(local.set $index
  (i64.and
    (call $compiled_KeyHash_hash
      (local.get $key)
    )
    (i64.const 7)
  )
)
```

Because:

```text
HashFunc -> KeyHash
L        -> 8
L - 1    -> 7
```

The core statement:

```cpp
_occupationFlags[index >> 5] |=
    1ULL << ((index & 31) << 1);
```

becomes loads, shifts, OR, and a store into:

```text
$this + 128 + ((index >> 5) * 8)
```

The core statements:

```cpp
_elements[index].key = key;
_elements[index].value = value;
```

write to:

```text
key address:
  $this + index * 16

value address:
  $this + index * 16 + 8
```

The core statement:

```cpp
_population++;
```

becomes approximately:

```wat
(i64.store
  (i32.add
    (local.get $this)
    (i32.const 136)
  )
  (i64.add
    (i64.load
      (i32.add
        (local.get $this)
        (i32.const 136)
      )
    )
    (i64.const 1)
  )
)
```

The loops, switch, collision probing, and `goto reuse_slot` are likewise lowered into Wasm blocks, loops, branches, loads, and stores.

There is no call resembling:

```wat
(call $lh_hashMapSet ...)
```

because no such host API exists.

## 14. Sibling methods are generated lazily

While compiling `set()`, the body refers to:

```cpp
capacity()
HashFunc::hash(key)
_getEncodedOccupationFlags(...)
getElementIndex(...)
```

Each dependency is resolved separately:

```text
capacity()
  -> parsed inline HashMap method

HashFunc::hash(key)
  -> template binding HashFunc = KeyHash
  -> user-defined static KeyHash::hash()

_getEncodedOccupationFlags()
  -> parsed qpi_hash_map_impl.h method

getElementIndex()
  -> parsed qpi_hash_map_impl.h method
```

Each concrete method is emitted once and cached.

Therefore, the final module contains only the concrete instantiations needed by this contract:

```text
HashMap<uint64,uint64,8,KeyHash>::set
HashMap<uint64,uint64,8,KeyHash>::population
HashMap<uint64,uint64,8,KeyHash>::get
HashMap<uint64,uint64,8,KeyHash>::getElementIndex
HashMap<uint64,uint64,8,KeyHash>::_getEncodedOccupationFlags
KeyHash::hash
```

It does not generate every method of every core template.

---

# Part E: The separate `qpi.tick()` host path

## 15. Core provides the wrapper body

This line:

```cpp
state.mut().lastWriteTick = qpi.tick();
```

resolves to the core wrapper:

```cpp
unsigned int QPI::QpiContextFunctionCall::tick() const
{
    return lh_tick();
}
```

During snapshot assembly, `lh_tick` is normalized to:

```cpp
__lhost_tick
```

The compiler's library metadata maps:

```text
__lhost_tick -> $lh_tick
```

The generated wrapper resembles:

```wat
(func $T1_QpiContextFunctionCall_tick
  (param $this i32)
  (result i64)

  (return
    (i64.extend_i32_u
      (call $lh_tick)
    )
  )

  (i64.const 0)
)
```

The module import is:

```wat
(import "lhost" "tick"
  (func $lh_tick
    (result i32)
  )
)
```

This is the point where execution leaves the contract Wasm.

---

# Part F: WAT assembly and Wasm validation

## 16. Module assembly

The final module is approximately organized as:

```wat
(module
  ;; lhost imports
  (import "lhost" "tick" ...)
  (import "lhost" "k12" ...)
  (import "lhost" "transfer" ...)
  ;; full canonical ABI

  ;; memory
  (memory (export "memory") ...)

  ;; fixed layout globals
  (global $stateBase ...)
  (global $ctxBase ...)
  (global $ioBase ...)

  ;; temporary allocation is owned by lhost.acquireScratch/releaseScratch

  ;; runtime/framework helpers

  ;; lazily generated core methods
  (func $T0_HashMap_set ...)
  (func $T1_QpiContextFunctionCall_tick ...)
  (func $T2_HashMap_population ...)
  (func $T3_HashMap_get ...)
  ;; ...

  ;; contract entries
  (func $user_0 ...)
  (func $user_1 ...)

  ;; registration metadata and dispatch
  (func $dispatch ...)
)
```

One subtle point: the current TypeScript compiler emits the complete canonical `lhost` import table. Therefore, seeing:

```wat
(import "lhost" "k12" ...)
(import "lhost" "transfer" ...)
```

does not mean the HashMap operation calls them.

You must search for:

```wat
(call $lh_k12)
(call $lh_transfer)
```

to determine whether they are actually used.

## 17. WAT becomes Wasm

The WAT is passed to WABT:

```ts
const parsedModule = wabtModule.parseWat("contract.wat", wat);
parsedModule.validate();

const wasm = new Uint8Array(
  parsedModule.toBinary({}).buffer
);
```

Then Qinit performs:

```ts
WebAssembly.validate(wasm)
```

and inspects:

```text
memory mode
required exports
lhost import names
lhost signatures
registration metadata
```

See [`packages/compile/src/compiler/wasm-encoder.ts`](packages/compile/src/compiler/wasm-encoder.ts#L5).

The normal compile result returns `wasm`. WAT is available through `QINIT_DUMP_WAT`.

---

# Part G: How the VirtualEngine is wired

## 18. `VirtualEngine` is actually several layers

There is no single object that owns everything.

```text
VirtualNode
    Public node/RPC facade

Sim
    Ledger, ticks, assets, fees, oracles, contracts

ContractRegistry
    Deployed contract instances and persistent state

Contract
    One WebAssembly.Instance, memory, dispatch, imports
```

Deployment follows:

```text
VirtualNode.deploy(wasm)
-> Sim.deploy(slot, wasm)
-> ContractRegistry.deploy(slot, wasm, hostServices)
-> Contract.load(...)
-> new WebAssembly.Module(wasm)
-> new WebAssembly.Instance(module, imports)
```

See [`packages/engine/src/transport.ts`](packages/engine/src/transport.ts#L119), [`packages/engine/src/registry.ts`](packages/engine/src/registry.ts#L45), and [`packages/engine/src/runtime.ts`](packages/engine/src/runtime.ts#L330).

## 19. VirtualEngine does not read core headers

This is the exact split:

| Component | Reads core C++ headers? | Responsibility |
|---|---|---|
| Qinit compiler | Yes | Parse layouts and compile method bodies |
| Generated Wasm | No | Contains compiled core and user logic |
| VirtualNode | No | Public node facade |
| Sim | No | Simulated ledger and protocol state |
| Contract | No | Wasm memory, dispatch, host imports |
| Core-lite WAMR | No at runtime | Provides native implementations of the same imports |

The VirtualEngine only knows the dynamic ABI:

```text
lhost.tick: () -> i32
lhost.k12: (i32, i32, i32) -> void
lhost.transfer: (i32, i64) -> i64
...
```

Its JavaScript implementations are manually provided in `Contract.imports()` and checked against generated `LHOST_ABI`.

For example:

```ts
tick: () => this.host.tick() >>> 0
```

See [`packages/engine/src/runtime.ts`](packages/engine/src/runtime.ts#L684).

`Sim` provides:

```ts
tick: () => this.tickN
```

See [`packages/engine/src/sim.ts`](packages/engine/src/sim.ts#L133).

So the compiler and VirtualEngine share an ABI schema, not a C++ runtime.

## 20. Invocation of `Put`

Suppose the caller sends:

```text
key   = 5
value = 900
```

The input bytes are:

```text
offset 0: 05 00 00 00 00 00 00 00
offset 8: 84 03 00 00 00 00 00 00
```

The engine invokes:

```ts
contract.invoke(PROCEDURE_KIND, 1, inputBytes, context);
```

`Contract.invoke()` performs:

```text
1. Select input, output, and locals regions.
2. Reset the arena for an outer dispatch.
3. Zero output memory.
4. Zero locals memory.
5. Copy input bytes into Wasm memory.
6. Write QPI context fields.
7. Call exported dispatch(kind, inputType, ...).
8. Copy output bytes back to JavaScript.
```

See [`packages/engine/src/runtime.ts`](packages/engine/src/runtime.ts#L454).

The dispatcher selects registration:

```text
procedure, input type 1 -> Put
```

The generated `Put` function then:

```text
1. Calls compiled HashMap::set.
2. Hashes key as 5 & 7 = 5.
3. Reads occupation flags at state + 128.
4. Finds slot 5 empty.
5. Writes key at state + 5 * 16.
6. Writes value at state + 5 * 16 + 8.
7. Increments population at state + 136.
8. Returns index 5.
9. Calls $lh_tick.
10. Stores returned tick at state + 152.
11. Writes index, population, and tick to output memory.
```

Only step 9 enters JavaScript.

Steps 2 through 8 execute entirely inside Wasm.

## 21. Invocation of `Get`

For key `5`, `Get` calls the source-compiled core method:

```cpp
HashMap::get(key, output.value)
```

That method calls:

```cpp
getElementIndex(key)
```

The compiled Wasm:

```text
1. Computes the hash.
2. Reads occupation flags.
3. Compares stored key.
4. Finds index 5.
5. Loads value from state + 5 * 16 + 8.
6. Stores it through the output.value reference.
7. Returns true.
```

`output.value` is passed as an `i32` address into output memory.

Again, there is no JavaScript HashMap lookup.

---

# Part H: What changes with the default hash function?

If the field were:

```cpp
HashMap<uint64, uint64, 8> values;
```

then:

```text
HashFunc -> HashFunction<uint64>
```

Core's default implementation is:

```cpp
uint64 ret;
KangarooTwelve(&key, sizeof(KeyT), &ret, 8);
return ret;
```

See [`core-lite/src/contract_core/qpi_hash_map_impl.h`](/home/kali/Projects/core-lite/src/contract_core/qpi_hash_map_impl.h#L17).

That changes the flow to:

```text
HashMap::set
-> source-compiled HashFunction<uint64>::hash
-> KangarooTwelve(...)
-> compiler lowers to $lh_k12
-> VirtualEngine lhost.k12
-> result copied back into Wasm memory
-> HashMap probing continues inside Wasm
```

So even here the VirtualEngine still does not implement HashMap. It only provides the K12 primitive requested by the compiled core hash function.

The custom `KeyHash` in the example was chosen to isolate the pure HashMap path from that host dependency.

---

# Part I: Current ambiguous or misleading areas

## 22. Stale `emitIntrinsics()` comment

[`packages/compile/src/backend/wasm/framework/intrinsics.ts`](packages/compile/src/backend/wasm/framework/intrinsics.ts#L14) currently says:

```ts
// Container + helper intrinsics the codegen targets.
// HashMap helpers reproduce the real qpi.h
```

But the current function contains dispatch, PRNG, self-ID, and uint128 helpers. There are no `$hm_*` HashMap helpers in the current backend.

That comment is stale and misleading. Current HashMap methods are source-compiled through `containers.ts`.

## 23. `emitContainerCall()` is broader than its name

Despite its name, that path can compile:

```text
HashMap methods
Array methods
QPI context methods
plain struct instance methods
other parsed source-backed methods
```

A name such as `emitSourceBackedMethodCall()` would describe its role better.

## 24. The import list does not show actual runtime use

Because the TypeScript compiler emits the full `lhost` ABI, the module may import functions that no generated instruction calls.

The distinction is:

```text
import declared:
  runtime must provide it

call emitted:
  contract actually executes it
```

## 25. Runtime wiring is only partly generated

The ABI names and signatures are generated and checked.

The JavaScript semantics are still manually implemented:

```text
tick        -> Sim.tickN
transfer    -> Sim ledger
issueAsset  -> Sim asset manager
queryOracle -> Sim oracle manager
```

If core adds a new host import:

```text
1. ABI metadata changes.
2. Compiler recognizes the new declaration.
3. Generated LHOST_ABI changes.
4. VirtualEngine drift check fails.
5. A JavaScript implementation must be added.
```

That is intentional. C++ source supplies contract-side behavior, while the simulator must independently model node-side behavior.

---

# Final mental model

```text
HashMap declaration:
    core qpi.h
    -> compiler template/layout model

HashMap implementation:
    core qpi_hash_map_impl.h
    -> compiler templateMethods
    -> lazy concrete Wasm functions

User contract:
    separate AST
    -> references HashMap template instance
    -> calls generated concrete methods

Host ABI:
    core Wasm ABI metadata + sdk/module_runtime.h
    -> compiler import declarations
    -> WAT "lhost" imports
    -> VirtualEngine JavaScript functions

VirtualEngine:
    does not understand C++ or HashMap
    -> stores persistent Wasm memory
    -> dispatches entries
    -> provides environmental host functions
```

A core HashMap algorithm change therefore requires recompiling the contract, but normally requires no VirtualEngine change. A core `lhost` ABI or host-semantics change may require both compiler metadata regeneration and a VirtualEngine implementation update.
