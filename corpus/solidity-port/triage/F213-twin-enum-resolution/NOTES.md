# F213 — a constant name is effectively global, and the last declaration of it wins

`TwinEnum.h` declares four enums in four namespaces and reads seven fully qualified constants:

    namespace Alpha     { enum Level      { Low = 1,  High = 2   }; }
    namespace Beta      { enum Level      { Low = 100, High = 200 }; }
    namespace TwinName  { enum FirstKind  { Only = 7 }; }
    namespace OtherName { enum SecondKind { Only = 9 }; }

    bun run scripts/solidity-port/triage.ts \
        corpus/solidity-port/triage/F213-twin-enum-resolution/TwinEnum.h \
        corpus/solidity-port/triage/F213-twin-enum-resolution/script.json

| read              | clang | TypeScript backend |
| ----------------- | ----: | -----------------: |
| `Alpha::Low`      |     1 |            **100** |
| `Alpha::High`     |     2 |            **200** |
| `Beta::Low`       |   100 |                100 |
| `Beta::High`      |   200 |                200 |
| `Alpha::High * Beta::Low` | 200 |      **20000** |
| `TwinName::Only`  |     7 |              **9** |
| `OtherName::Only` |     9 |                  9 |
| `Shared` (file-scope `constexpr uint64 = 5`) | 5 | **55** |
| `WithEnum::Shared` (enum constant `= 55`)    | 55 |    55 |

clang's column is what C++ says: every read is qualified, so there is nothing to disambiguate. The
TypeScript backend returns, for every one of them, the value of the **last constant declared with that
name** — `Alpha::Low` becomes `Beta::Low`, and `TwinName::Only` becomes `OtherName::Only`.

The last four rows pin the rule down.

- `FirstKind` and `SecondKind` are *different enum names* in different namespaces; only the constant
  name `Only` is shared, and that is enough.
- `Shared` is not an enum constant at all on one side — it is a file-scope `static constexpr uint64` —
  and the enum constant declared after it still overwrites it.

So the collision is on the **constant identifier alone**. Neither the enclosing namespace, nor the enum
type, nor even the kind of declaration participates in the lookup: the last declaration of a name is
what every read of that name returns.

A four-namespace ladder in the corpus (`namespaces/NsTwinEnumsAcrossFourNamespaces`) shows the same
thing at every position rather than only the last: with `K1::Tag = 1`, `K2::Tag = 2`, `K3::Tag = 4` and
`K4::Tag = 8`, clang reads 1, 2, 4, 8 and ORs them to 15; the TypeScript backend reads **8 four times**
and ORs them to 8.

Why this is the worst finding in the ledger so far:

- **It is silent and it is arithmetic.** No diagnostic on either side; the contract compiles, runs, and
  writes a different number into state. F200 traps, F201/F205/F209/F211 refuse to compile, F212 needs a
  read-only entry to call a procedure. This one just returns the wrong value.
- **The spelling that is supposed to disambiguate does not.** Qualifying a name is the fix a developer
  reaches for when two declarations collide; here the qualification is accepted and ignored.
- **Two enums in two namespaces is ordinary code.** A contract that defines `enum Status { Active }` in
  its own namespace, alongside a library that defines `enum State { Active }`, is already exposed.

Corpus rows: `namespaces/NsTwinEnumSameConstantNames__*` — all 12 variants are red, and deliberately not
pinned with `expectedVerdict`, because unlike F205/F209/F211/F212 this is a wrong answer rather than a
documented asymmetry. They should go green when it is fixed.
