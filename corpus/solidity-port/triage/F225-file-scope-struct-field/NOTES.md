# F225 — a file-scope struct's field resolves in the contract's scope

    T_BASE=$PWD/corpus/solidity-port/triage/F225-file-scope-struct-field T_NAME=FileScopeField \
      bun run scripts/solidity-port/triage-probe.ts

    clang       8 16 1
    typescript  8  8 1

`sizeof(Inner)` is the control and agrees at 8: read from inside the contract, the contract's own
nested `Inner` really does win, which is ordinary C++ name hiding.

`sizeof(Outer)` is the finding. `Outer` is declared at file scope, so its member `Inner inner` names
the file-scope `Inner` (two uint64s, 16 bytes). Class scope does not reach into a file-scope struct's
body. clang says 16; the TypeScript backend says 8, having resolved `Outer`'s field against the
contract's nested `Inner` instead of `Outer`'s own scope.

Silent and structural: a wrong `sizeof` means wrong offsets for everything laid out after it.

Related to F211, which fixed the same family of leak for the layout and ABI walks, and reproduces on
unpatched main — this path was never covered. Not fixed.
