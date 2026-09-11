# F215 — `SELF.u64._0` is refused; the same read through a local copy is not

`SelfWord.h` reads the first 64-bit word of the contract's own identity twice:

    locals.copy = SELF;
    state.mut().viaLocal = locals.copy.u64._0;   // accepted by both backends
    state.mut().direct   = SELF.u64._0;          // TypeScript backend: refused

    bun run scripts/solidity-port/triage.ts \
        corpus/solidity-port/triage/F215-self-word-read/SelfWord.h \
        corpus/solidity-port/triage/F215-self-word-read/script.json

    SelfWord: one-side-rejected
    TypeScript backend:
      status rejected
      ! error: unsupported member read [id(4).u64._0]
    clang backend:
      status ok  digest cb970dbf1ab39277…  stateSize 24
      [ 1] function 1  out 1d00000000000000 1d00000000000000 0100000000000000
                           ^ direct = 29     ^ viaLocal = 29   ^ they agree

clang compiles the contract and both reads return 29, the contract's own index. The TypeScript backend
refuses only the direct spelling, and its diagnostic names a *folded* identity (`id(4)`), which suggests
the constant is being substituted before the member read is considered rather than after.

Found while writing a cross-contract archetype that wanted to record its own identity alongside the
caller's. The workaround is one assignment, so this costs a developer a minute — but it is another entry
in the same column as F209, F211 and F214: legal C++ that one backend will not compile, where the
program is refused rather than mis-executed.

Pinned in the corpus as `hostcalls/HostSelfWordDirectRead__*` through `expectedVerdict`, with the local
copy in the same contract as the control.
