# F212 — a read-only entry can CALL a procedure and mutate state under the TypeScript backend

`FunctionCallsProcedure.h` is a `PUBLIC_FUNCTION` whose body `CALL`s a `PRIVATE_PROCEDURE` that does
`state.mut().counter += input.value`.

    bun run scripts/solidity-port/triage.ts \
        corpus/solidity-port/triage/F212-function-calls-procedure/FunctionCallsProcedure.h \
        corpus/solidity-port/triage/F212-function-calls-procedure/script.json

clang refuses to compile it, because the CALL macro passes the caller's context straight through and a
function's context is a different type:

    error: no viable conversion from 'const QPI::QpiContextFunctionCall'
                                  to 'const QPI::QpiContextProcedureCall'
        CALL(Bump, locals.request, locals.reply);

The TypeScript backend compiles the same file and runs it. The first call returns 1 — the write
happened inside an entry that is supposed to be read-only — and the contract's state digest moves across
a function call, which every other row in this corpus relies on never happening.

Two reasons this matters more than the earlier name-resolution findings:

- **It is a semantic rule, not a spelling.** QPI's read-only guarantee for functions is what lets a node
  answer a query without a transaction. A backend that lets a function write is not implementing the
  same language.
- **The corpus has a negative control that assumes the opposite.** `lifecycle/FunctionMustNotMutate`
  exists precisely to assert that a function call leaves the digest alone; this contract is the shape
  that breaks that assumption, and it only fails to reach the chain because clang is what builds for it.

Pinned in the corpus as `controlflow/ReadOnlyFunctionCallsPrivateProcedure__*` through
`expectedVerdict`, so the rows pass while the divergence holds and fail the moment either side changes.
