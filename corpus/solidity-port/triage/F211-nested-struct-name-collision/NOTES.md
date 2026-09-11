# F211 — a nested struct whose name matches a file-scope struct overflows the front end's stack

`NestedShadow.h` is a generated corpus variant, kept verbatim. Its shape is:

    struct Inner { uint64 wide; uint8 narrow; };      // file scope
    struct Frame { Inner inner; uint64 after; };      // member bound to ::Inner at THIS point

    struct C : public ContractBase {
        struct StateData {
            struct Inner { ... Frame frame; ... };    // a different Inner, in class scope
            Inner inner;
        };
        ...
    };

C++ binds `Frame::inner` to `::Inner` where `Frame` is defined, so nothing about the later class-scope
`Inner` can reach back into it. clang compiles the contract — verified directly through the qinit clang
pipeline, which produced an 18 199-byte module.

The TypeScript front end instead resolves the member's type in the scope where the type is *used*, so
`StateData::Inner` contains `Frame`, whose `inner` resolves back to `StateData::Inner`, and the walk does
not terminate:

    Source analysis failed: Maximum call stack size exceeded.

The corpus pins this as `layout/LayoutNestedStructNameCollision__*`, scored through `expectedVerdict`,
with the nested placement forced rather than taken from the axis so the collision is always present.

Two notes for whoever fixes it:

- It was found by accident. The generator's `placement=nested` axis wraps a contract's state members in
  a struct it calls `Inner`, and an archetype that happened to declare a file-scope `Inner` collided
  with it. Four of that archetype's twelve variants failed; the eight without nested placement passed.
- It is a crash, not a diagnostic. The failure arrives as an exception from the analyzer rather than as
  a rejection with a source location, so a contract author gets no line number to work from.
