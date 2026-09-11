# F210 — the front end does not terminate on `namespace M { using T = N::T; }`

`AliasSameName.h` is the minimal contract: one struct in a namespace, one namespace-scoped alias whose
name is the same as the aliased type's name, and a state member of the aliased type.

    namespace Inner  { struct Payload { uint64 a; }; }
    namespace Middle { using Payload = Inner::Payload; }   // alias name == target name

Running the analyzer on it does not return:

    bun run scripts/solidity-port/triage.ts \
        corpus/solidity-port/triage/F210-same-name-alias-hang/AliasSameName.h \
        corpus/solidity-port/triage/F210-same-name-alias-hang/script.json
    # never completes — kill it

Three things make this worth its own directory rather than a corpus row:

- **It hangs, it does not reject.** A corpus row would burn a shard deadline on every sweep, so this
  contract is deliberately *not* generated into `variants/`. The archetype that produced it was removed
  from `scripts/solidity-port/archetypes/namespaces-scoping.ts` for the same reason.
- **It takes the clang path down too.** `buildContractWithClang` runs the same shared build gate, so the
  clang half of the differential never gets as far as invoking clang. This is not a divergence between
  the backends; it is one component hanging both pipelines.
- **The construct is ordinary C++.** Both `g++ -std=c++20` and the wasi-sdk `clang++` compile the same
  declaration pair without complaint:

      namespace Inner  { struct Payload { unsigned long long a; }; }
      namespace Middle { using Payload = Inner::Payload; }
      Middle::Payload p;

The control is one character of difference: renaming the alias (`using PayloadB = Inner::Payload;`)
makes the same contract analyze in 183 ms with zero diagnostics. So the trigger is specifically an alias
whose name equals the name of the type it aliases, reached through a different namespace.
