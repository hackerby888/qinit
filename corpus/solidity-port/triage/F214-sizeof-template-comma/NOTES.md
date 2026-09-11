# F214 — `sizeof` of a template with two arguments does not parse

`SizeofTemplate.h` measures one type twice: directly, and through an alias.

    using Aliased = Array<uint64, 8>;
    ...
    state.mut().direct   = sizeof(Array<uint64, 8>);   // TypeScript backend: parse error
    state.mut().viaAlias = sizeof(Aliased);            // both backends: 64

clang compiles the file and both measurements come back 64. The TypeScript backend stops at the comma
inside the template argument list:

    error: Expected r_paren but got comma (,) in sizeof expr
    error: Expected semicolon but got comma (,) in expression statement

so the whole contract is refused. The alias spelling parses, which is the workaround and also the proof
that nothing else in the contract is at fault.

Found while writing round 5's layout archetypes: five of them measured `sizeof(Array<...>)`,
`sizeof(BitArray<N>)` and `sizeof(HashMap<...>)` directly, and all five were refused by one backend.
They now alias the type first, so they test layout instead of the parser, and this contract is what
carries the parser question. It is pinned in the corpus as `layout/SizeofMultiArgTemplate__*` through
`expectedVerdict`.

Same family as F209 (`::name`): legal C++ that one backend cannot parse. Loud rather than silent, so it
costs a developer time rather than money — but `sizeof(Array<T, N>)` is how a contract asks how big its
own state is, and every QPI container takes at least two template arguments.
