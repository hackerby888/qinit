// The corpus the differential runs. Every probe is one contract, and every shape that should be refused
// sits beside a control spelling that should build, so a rule that simply refuses more is not read as a fix.
export interface Probe {
    name: string;
    source: string;
    /** A `qpi/*` code the editor must emit at any severity — policy rules are warnings, and clang compiles them happily. */
    code?: string;
    /** clang must refuse this source, and the editor must show an error rather than stay silent. */
    refused?: boolean;
    /** clang builds it and the editor must say nothing at all. */
    clean?: boolean;
    /** clang accepts it and no oracle objects, but the editor is the last thing that could warn. */
    wantsWarning?: string;
    expect: string;
}

/** The smallest contract that builds, with holes for the parts a probe wants to vary. */
function contract(parts: { globals?: string; state?: string; types?: string; body?: string; extra?: string; registers?: string }): string {
    return `using namespace QPI;
${parts.globals ?? ""}
struct DiffProbe2
{
};

struct DiffProbe : public ContractBase
{
${parts.types ?? ""}
    struct StateData
    {
        uint64 counter;
${parts.state ?? ""}
    };

    struct Go_input {};
    struct Go_output { uint64 value; };
${parts.extra ?? ""}
    PUBLIC_PROCEDURE(Go)
    {
        state.mut().counter += 1;
${parts.body ?? ""}
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
${parts.registers ?? "        REGISTER_USER_PROCEDURE(Go, 1);"}
    }
};
`;
}

/** Same, but the entry carries locals — the shape most real contracts use. */
function withLocals(parts: { state?: string; types?: string; locals: string; body: string; globals?: string }): string {
    return contract({
        globals: parts.globals,
        state: parts.state,
        types: `${parts.types ?? ""}
    struct Go_locals
    {
${parts.locals}
    };
`,
        body: parts.body,
    }).replace("PUBLIC_PROCEDURE(Go)", "PUBLIC_PROCEDURE_WITH_LOCALS(Go)");
}

/** The same contract with one state field's type changed across the migration boundary. */
function migration(oldType: string, newType: string): string {
    return `using namespace QPI;

struct DiffProbe2
{
};

struct DiffProbe : public ContractBase
{
    struct StateData { ${newType} counter; };
    struct OldStateData { ${oldType} counter; };
    struct Go_input {};
    struct Go_output {};
    PUBLIC_PROCEDURE(Go) { state.mut().counter += 1; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
    MIGRATE()
    {
        state.mut().counter = oldState.counter;
    }
};
`;
}

export const PROBES: Probe[] = [
    // ---- the banned surface: each must squiggle, and the control beside it must build ----
    {
        name: "banned/float-local",
        source: withLocals({ locals: "        float ratio;", body: "        locals.ratio = 1;" }),
        code: "qpi/no-float",
        expect: "qpi/no-float",
    },
    { name: "banned/double-in-state", source: contract({ state: "        double rate;" }), code: "qpi/no-float", expect: "qpi/no-float" },
    { name: "control/uint64-in-state", source: contract({ state: "        uint64 rate;" }), clean: true, expect: "builds clean" },
    {
        name: "banned/union-in-state",
        source: contract({ globals: "union Mix { uint64 a; sint64 b; };", state: "        Mix mix;" }),
        code: "qpi/no-union",
        expect: "qpi/no-union",
    },
    {
        name: "banned/std-string",
        source: withLocals({ locals: "        uint64 unused;", body: '        state.mut().counter += sizeof("abc");' }),
        code: "qpi/no-string",
        expect: "qpi/no-string",
    },
    { name: "banned/char-literal", source: contract({ body: "        state.mut().counter += 'a';" }), code: "qpi/no-char", expect: "qpi/no-char" },
    {
        name: "banned/division",
        source: contract({ body: "        state.mut().counter = state.get().counter / 2;" }),
        code: "qpi/no-division",
        expect: "qpi/no-division",
    },
    {
        name: "control/div-qualified",
        source: contract({ body: "        state.mut().counter = QPI::div(state.get().counter, 2ULL);" }),
        clean: true,
        expect: "builds clean",
    },
    {
        name: "banned/modulo",
        source: contract({ body: "        state.mut().counter = state.get().counter % 2;" }),
        code: "qpi/no-modulo",
        expect: "qpi/no-modulo",
    },
    {
        name: "control/mod-qualified",
        source: contract({ body: "        state.mut().counter = QPI::mod(state.get().counter, 2ULL);" }),
        clean: true,
        expect: "builds clean",
    },
    {
        name: "banned/unqualified-div",
        source: contract({ body: "        state.mut().counter = div(state.get().counter, 2ULL);" }),
        code: "qpi/unqualified-div",
        expect: "qpi/unqualified-div",
    },
    {
        name: "banned/unqualified-mod",
        source: contract({ body: "        state.mut().counter = mod(state.get().counter, 2ULL);" }),
        code: "qpi/unqualified-mod",
        expect: "qpi/unqualified-mod",
    },
    { name: "banned/preprocessor", source: contract({ globals: "#define SNEAKY 1" }), code: "qpi/no-preprocessor", expect: "qpi/no-preprocessor" },
    { name: "banned/global-typedef", source: contract({ globals: "typedef uint64 Alias;" }), code: "qpi/no-global-typedef", expect: "qpi/no-global-typedef" },
    { name: "banned/global-using-alias", source: contract({ globals: "using Alias = uint64;" }), code: "qpi/no-global-using", expect: "qpi/no-global-using" },
    {
        name: "banned/const-cast",
        source: contract({ body: "        const_cast<QPI::uint64&>(state.get().counter) = 7;" }),
        code: "qpi/no-const-cast",
        expect: "qpi/no-const-cast",
    },
    {
        name: "banned/dunder-name",
        source: withLocals({ locals: "        uint64 __hidden;", body: "        locals.__hidden = 1;" }),
        code: "qpi/no-dunder",
        expect: "qpi/no-dunder",
    },
    { name: "banned/brackets-new", source: contract({ body: "        uint64* p = new uint64[4];" }), code: "qpi/no-brackets", expect: "qpi/no-brackets" },
    {
        name: "banned/qpicontext",
        source: contract({ body: "        QpiContextFunctionCall* ctx = nullptr;" }),
        code: "qpi/no-qpicontext",
        expect: "qpi/no-qpicontext",
    },

    // ---- width types: legal to write but flagged, so the editor must not error on them ----
    {
        name: "width/long-local",
        source: withLocals({ locals: "        long wide;", body: "        locals.wide = 1;" }),
        code: "qpi/lp64-width-type",
        expect: "qpi/lp64-width-type, builds",
    },
    {
        name: "width/size_t-local",
        source: withLocals({ locals: "        size_t n;", body: "        locals.n = 1;" }),
        code: "qpi/lp64-width-type",
        expect: "qpi/lp64-width-type, builds",
    },

    // ---- registration and entry shapes ----
    {
        name: "registration/duplicate-index",
        source: contract({
            types: "    struct Two_input {};\n    struct Two_output {};\n",
            extra: "    PUBLIC_PROCEDURE(Two) { state.mut().counter += 2; }\n",
            registers: "        REGISTER_USER_PROCEDURE(Go, 1);\n        REGISTER_USER_PROCEDURE(Two, 1);",
        }),
        code: "qpi/dup-proc-index",
        expect: "qpi/dup-proc-index",
    },
    {
        name: "control/distinct-indexes",
        source: contract({
            types: "    struct Two_input {};\n    struct Two_output {};\n",
            extra: "    PUBLIC_PROCEDURE(Two) { state.mut().counter += 2; }\n",
            registers: "        REGISTER_USER_PROCEDURE(Go, 1);\n        REGISTER_USER_PROCEDURE(Two, 2);",
        }),
        clean: true,
        expect: "builds clean",
    },
    {
        name: "entry/locals-without-with-locals",
        source: contract({ types: "    struct Go_locals { uint64 scratch; };\n", body: "        state.mut().counter += 1;" }),
        code: "qpi/needs-with-locals",
        expect: "qpi/needs-with-locals",
    },
    {
        name: "entry/stack-local-in-body",
        source: contract({ body: "        uint64 scratch = 3;\n        state.mut().counter += scratch;" }),
        code: "qpi/stack-local",
        expect: "qpi/stack-local",
    },
    {
        name: "entry/invocator-in-function",
        source: contract({
            types: "    struct Peek_input {};\n    struct Peek_output { id who; };\n",
            extra: "    PUBLIC_FUNCTION(Peek) { output.who = qpi.invocator(); }\n",
            registers: "        REGISTER_USER_PROCEDURE(Go, 1);\n        REGISTER_USER_FUNCTION(Peek, 2);",
        }),
        code: "qpi/invocator-in-function",
        expect: "qpi/invocator-in-function",
    },
    {
        name: "control/invocator-in-procedure",
        source: withLocals({ locals: "        id who;", body: "        locals.who = qpi.invocator();" }),
        clean: true,
        expect: "builds clean",
    },
    {
        name: "entry/unregistered",
        source: contract({
            types: "    struct Ghost_input {};\n    struct Ghost_output {};\n",
            extra: "    PUBLIC_PROCEDURE(Ghost) { state.mut().counter += 9; }\n",
        }),
        code: "qpi/unregistered",
        expect: "qpi/unregistered",
    },

    // ---- the container zoo, in state and in locals: these must all build ----
    { name: "container/array-pow2", source: contract({ state: "        Array<uint64, 8> slots;" }), clean: true, expect: "builds clean" },
    { name: "container/array-non-pow2", source: contract({ state: "        Array<uint64, 6> slots;" }), refused: true, expect: "clang refuses: N must be 2^n" },
    { name: "container/bitarray", source: contract({ state: "        BitArray<64> flags;" }), clean: true, expect: "builds clean" },
    { name: "container/hashmap-id-key", source: contract({ state: "        HashMap<id, uint64, 64> balances;" }), clean: true, expect: "builds clean" },
    { name: "container/hashset", source: contract({ state: "        HashSet<id, 64> members;" }), clean: true, expect: "builds clean" },
    { name: "container/collection", source: contract({ state: "        Collection<uint64, 64> queue;" }), clean: true, expect: "builds clean" },
    {
        name: "container/nested-array-of-hashmap",
        source: contract({ state: "        Array<HashMap<id, uint64, 16>, 4> books;" }),
        clean: true,
        expect: "builds clean",
    },
    {
        name: "container/array-of-array-of-struct",
        source: contract({
            types: "    struct Cell { uint64 qty; BitArray<8> bits; };\n",
            state: "        Array<Array<Cell, 4>, 4> grid;",
        }),
        clean: true,
        expect: "builds clean",
    },
    {
        name: "container/struct-key-with-padding",
        source: contract({
            types: "    struct Key { uint8 tag; uint64 wide; uint16 mid; };\n",
            state: "        HashMap<Key, uint64, 32> byKey;",
        }),
        clean: true,
        expect: "builds clean",
    },
    {
        name: "container/hashmap-of-array-value",
        source: contract({ state: "        HashMap<id, Array<uint64, 8>, 32> lots;" }),
        clean: true,
        expect: "builds clean",
    },

    // ---- public entry payload rules ----
    {
        name: "public/complex-input-type",
        source: contract({
            types: "    struct Bag { Collection<uint64, 16> items; };\n    struct Take_input { Bag bag; };\n    struct Take_output {};\n",
            extra: "    PUBLIC_PROCEDURE(Take) { state.mut().counter += 1; }\n",
            registers: "        REGISTER_USER_PROCEDURE(Go, 1);\n        REGISTER_USER_PROCEDURE(Take, 2);",
        }),
        refused: true,
        expect: "clang refuses; the editor errors — though nested one struct deep it is reported as compiler/semantic, not qpi/public-complex-type",
    },
    {
        name: "control/plain-input-struct",
        source: contract({
            types: "    struct Take_input { uint64 amount; id who; };\n    struct Take_output { uint64 left; };\n",
            extra: "    PUBLIC_PROCEDURE(Take) { output.left = input.amount; }\n",
            registers: "        REGISTER_USER_PROCEDURE(Go, 1);\n        REGISTER_USER_PROCEDURE(Take, 2);",
        }),
        clean: true,
        expect: "builds clean",
    },

    // ---- scalar and id surface ----
    {
        name: "scalar/id-limbs",
        source: withLocals({
            locals: "        id who;\n        uint64 limb;",
            body: "        locals.who = qpi.invocator();\n        locals.limb = state.get().counter;",
        }),
        clean: true,
        expect: "builds clean",
    },
    {
        name: "scalar/every-width",
        source: withLocals({
            locals: "        bit b;\n        uint8 u8;\n        sint8 s8;\n        uint16 u16;\n        sint16 s16;\n        uint32 u32;\n        sint32 s32;\n        sint64 s64;",
            body: "        locals.b = 1;\n        locals.u8 = 1;\n        locals.s8 = 1;\n        locals.u16 = 1;\n        locals.s16 = 1;\n        locals.u32 = 1;\n        locals.s32 = 1;\n        locals.s64 = 1;",
        }),
        clean: true,
        expect: "builds clean",
    },

    // ---- shapes clang is known to police that an editor could miss ----
    {
        name: "semantic/function-calls-procedure",
        source: contract({
            types: "    struct Bump_input {};\n    struct Bump_output {};\n    struct Peek_input {};\n    struct Peek_output { uint64 v; };\n    struct Peek_locals { Bump_input bi; Bump_output bo; };\n",
            extra: "    PRIVATE_PROCEDURE(Bump) { state.mut().counter += 1; }\n    PUBLIC_FUNCTION_WITH_LOCALS(Peek) { CALL(Bump, locals.bi, locals.bo); output.v = state.get().counter; }\n",
            registers: "        REGISTER_USER_PROCEDURE(Go, 1);\n        REGISTER_USER_FUNCTION(Peek, 2);",
        }),
        refused: true,
        expect: "clang refuses: a read-only context cannot call a mutating entry",
    },
    {
        name: "control/procedure-calls-procedure",
        source: contract({
            types: "    struct Bump_input {};\n    struct Bump_output {};\n    struct Drive_input {};\n    struct Drive_output { uint64 v; };\n    struct Drive_locals { Bump_input bi; Bump_output bo; };\n",
            extra: "    PRIVATE_PROCEDURE(Bump) { state.mut().counter += 1; }\n    PUBLIC_PROCEDURE_WITH_LOCALS(Drive) { CALL(Bump, locals.bi, locals.bo); output.v = state.get().counter; }\n",
            registers: "        REGISTER_USER_PROCEDURE(Go, 1);\n        REGISTER_USER_PROCEDURE(Drive, 2);",
        }),
        clean: true,
        expect: "builds clean",
    },
    {
        name: "semantic/enum-constant-hidden-by-member",
        source: contract({
            globals: "enum Kind { Helper = 3, Solo = 4 };",
            types: "    struct Helper_input { uint64 value; };\n    struct Helper_output { uint64 doubled; };\n",
            extra: "    PRIVATE_FUNCTION(Helper) { output.doubled = input.value * 2; }\n",
            body: "        state.mut().counter = Helper;",
        }),
        refused: true,
        expect: "clang refuses: the member function hides the enum constant",
    },
    {
        name: "control/enum-constant-no-member-hides",
        source: contract({ globals: "enum Kind { Helper = 3, Solo = 4 };", body: "        state.mut().counter = Solo;" }),
        clean: true,
        expect: "builds clean",
    },
    {
        name: "semantic/default-constructed-asset-iterator",
        source: withLocals({
            locals: "        AssetOwnershipIterator it;\n        Asset asset;",
            body: "        it.begin(locals.asset);\n        state.mut().counter += 1;",
        }),
        refused: true,
        expect: "clang refuses: the default constructor is protected",
    },

    // ---- logging ----
    {
        name: "log/in-function",
        source: contract({
            globals: "struct Noted { uint64 v; char _terminator; };",
            types: "    struct Peek_input {};\n    struct Peek_output { uint64 v; };\n    struct Peek_locals { Noted note; };\n",
            extra: "    PUBLIC_FUNCTION_WITH_LOCALS(Peek) { LOG_INFO(locals.note); output.v = 1; }\n",
            registers: "        REGISTER_USER_PROCEDURE(Go, 1);\n        REGISTER_USER_FUNCTION(Peek, 2);",
        }),
        code: "qpi/log-in-function",
        expect: "qpi/log-in-function",
    },

    // ---- deep nesting: the shapes the completion campaigns found hardest ----
    {
        name: "deep/three-level-nested-struct",
        source: withLocals({
            types: "    struct Tier { uint64 rank; BitArray<8> bits; };\n    struct Tranche { Tier tier; Array<Tier, 4> hist; };\n    struct Lot { Tranche tranche; Array<Tranche, 2> more; };\n",
            locals: "        Lot lot;",
            body: "        locals.lot.tranche.tier.rank = 1;\n        locals.lot.tranche.hist.get(0);\n        locals.lot.tranche.tier.bits.setAll(0);",
        }),
        clean: true,
        expect: "builds clean",
    },
    {
        name: "deep/state-holding-everything",
        source: contract({
            types: "    struct Tier { uint64 rank; BitArray<16> bits; };\n",
            state: "        Array<Tier, 8> tiers;\n        HashMap<id, Tier, 32> byOwner;\n        HashSet<id, 32> seen;\n        Collection<Tier, 32> queue;\n        BitArray<128> flags;\n        Array<Array<uint64, 4>, 4> grid;",
        }),
        clean: true,
        expect: "builds clean",
    },

    // ---- diagnostics raised while lowering a body: the editor stops at module preparation, so these
    // ---- never reach a squiggle even though both backends refuse the source ----
    {
        name: "lowering/no-viable-operator",
        source: withLocals({ locals: "        BitArray<8> flags;", body: "        state.mut().counter = locals.flags + 1;" }),
        refused: true,
        expect: "clang refuses: no viable operator+ for a BitArray",
    },
    {
        name: "lowering/aggregate-to-scalar",
        source: withLocals({
            types: "    struct Pair { uint64 a; uint64 b; };\n",
            locals: "        Pair pair;",
            body: "        state.mut().counter = locals.pair;",
        }),
        refused: true,
        expect: "clang refuses: an aggregate is not a scalar",
    },

    // ---- MIGRATE: the one entry that runs against a state layout the contract no longer declares.
    // ---- A mistake here corrupts a deployed contract's state, so what the editor says about it matters.
    {
        name: "migrate/well-formed",
        source: `using namespace QPI;

struct DiffProbe2
{
};

struct DiffProbe : public ContractBase
{
    struct StateData { uint64 counter; uint64 migratedAt; };
    struct OldStateData { uint64 counter; };
    struct Go_input {};
    struct Go_output {};
    PUBLIC_PROCEDURE(Go) { state.mut().counter += 1; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
    MIGRATE()
    {
        state.mut().counter = oldState.counter;
        state.mut().migratedAt = qpi.tick();
    }
};
`,
        clean: true,
        expect: "builds clean",
    },
    {
        name: "migrate/reads-a-field-the-old-state-lacks",
        source: `using namespace QPI;

struct DiffProbe2
{
};

struct DiffProbe : public ContractBase
{
    struct StateData { uint64 counter; uint64 migratedAt; };
    struct OldStateData { uint64 counter; };
    struct Go_input {};
    struct Go_output {};
    PUBLIC_PROCEDURE(Go) { state.mut().counter += 1; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
    MIGRATE()
    {
        state.mut().counter = oldState.counter;
        state.mut().migratedAt = oldState.migratedAt;
    }
};
`,
        refused: true,
        expect: "clang refuses: OldStateData has no migratedAt",
    },
    {
        name: "migrate/assigns-to-the-old-state",
        source: `using namespace QPI;

struct DiffProbe2
{
};

struct DiffProbe : public ContractBase
{
    struct StateData { uint64 counter; };
    struct OldStateData { uint64 counter; };
    struct Go_input {};
    struct Go_output {};
    PUBLIC_PROCEDURE(Go) { state.mut().counter += 1; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
    MIGRATE()
    {
        oldState.counter = 7;
        state.mut().counter = oldState.counter;
    }
};
`,
        refused: true,
        expect: "clang refuses: the old state is what is being migrated from, not written to",
    },
    {
        name: "migrate/without-an-old-state-declared",
        source: `using namespace QPI;

struct DiffProbe2
{
};

struct DiffProbe : public ContractBase
{
    struct StateData { uint64 counter; };
    struct Go_input {};
    struct Go_output {};
    PUBLIC_PROCEDURE(Go) { state.mut().counter += 1; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
    MIGRATE()
    {
        state.mut().counter = oldState.counter;
    }
};
`,
        refused: true,
        expect: "clang refuses: there is no OldStateData to read",
    },

    // ---- a migration that changes a field's width or signedness. C++ permits the implicit conversion,
    // ---- so clang is right to accept it and there is no oracle at all — but the value being converted
    // ---- is a deployed contract's persisted state, and the conversion happens once, irreversibly.
    {
        name: "migrate/narrows-uint64-to-uint32",
        source: migration("uint64", "uint32"),
        wantsWarning: "every persisted value above 2^32 is truncated, once, on a live contract",
        expect: "clang accepts; nothing warns",
    },
    {
        name: "migrate/flips-sint64-to-uint64",
        source: migration("sint64", "uint64"),
        wantsWarning: "every persisted negative value becomes a very large positive one",
        expect: "clang accepts; nothing warns",
    },
    {
        name: "control/migrate-widens-uint32-to-uint64",
        source: migration("uint32", "uint64"),
        clean: true,
        expect: "widening loses nothing and must stay quiet",
    },
];
