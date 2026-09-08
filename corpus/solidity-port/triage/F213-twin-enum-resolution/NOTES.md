# F213 — a qualified enum constant resolves to the last-declared constant of that name

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

clang's column is what C++ says: every read is qualified, so there is nothing to disambiguate. The
TypeScript backend returns, for every one of them, the value of the **last constant declared with that
name** — `Alpha::Low` becomes `Beta::Low`, and `TwinName::Only` becomes `OtherName::Only`.

The last two rows are what pins the rule down. `FirstKind` and `SecondKind` are *different enum names*
in different namespaces; only the constant name `Only` is shared, and that is enough. So the collision
is on the constant identifier alone — neither the enclosing namespace nor the enum type participates in
the lookup.

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
