# F209 — the global-scope qualifier `::name` is rejected by the TypeScript backend and accepted by clang

`GlobalScope.h` declares `threshold` twice — once at file scope, once inside `namespace Port` — and
reads both from one procedure: `::threshold` for the file-scope one and `Port::threshold` for the other.

    bun run scripts/solidity-port/triage.ts \
        corpus/solidity-port/triage/F209-global-scope-qualifier/GlobalScope.h \
        corpus/solidity-port/triage/F209-global-scope-qualifier/script.json

    GlobalScope: one-side-rejected
    TypeScript backend:
      status rejected
      ! error: Expected expression but got d_colon (::)
    clang backend:
      status ok  digest 0e6e1cfc6e47f575…  stateSize 24
      [ 1] function 1  out 0100000000000000 0000000000000000 0100000000000000
                           ^ 50 > 7 (file scope)  ^ 50 > 100 (Port)

`Port::threshold` in the same file parses, so the refusal is specific to the leading `::`. The corpus
pins this as `namespaces/NsGlobalScopeQualifier__*`, scored through `expectedVerdict`: those rows pass
while the divergence holds and fail the moment it stops.
