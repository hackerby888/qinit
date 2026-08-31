// Development cheatcodes for the clang backend. Injected ahead of the contract and stripped again
// before submission to Core, so nothing here may outlive a dev build.
//
// The TypeScript backend lowers CC_PRINT through a compiler intrinsic. Clang has no such hook, so the
// same behaviour is written out here: literals carry no bytes and are skipped, every other argument
// ships with its ordinal. Both backends must put the same (id, part, bytes) on the wire.
#ifdef QINIT_CHEATS

#define QINIT_CC_OP_PRINT 1u
#define QINIT_CC_ORDINALS_PER_LINE 8u

// Matches core-lite's guest declaration; the contract never sees this name.
extern "C" long long lh_cheat(unsigned int op, unsigned long long a, unsigned long long b, void* ptr, unsigned int len);

namespace QinitCheats
{

template <typename T> struct IsLiteral
{
    static constexpr bool value = false;
};

template <unsigned long N> struct IsLiteral<char[N]>
{
    static constexpr bool value = true;
};

template <typename T> static void print(unsigned long long tag, const T& value)
{
    // A literal is already interned in the IDL, so it carries nothing on the wire.
    if constexpr (!IsLiteral<T>::value)
    {
        lh_cheat(QINIT_CC_OP_PRINT, tag, 0ull, (void*)&value, (unsigned int)sizeof(T));
    }
}

static void printAll(unsigned long long, unsigned int) {}

// Ordinals count every argument, literals included, so both backends number the parts identically.
template <typename T, typename... Rest> static void printAll(unsigned long long id, unsigned int part, const T& value, const Rest&... rest)
{
    print(id + part, value);
    printAll(id, part + 1u, rest...);
}

} // namespace QinitCheats

#define CC_PRINT(...) QinitCheats::printAll((unsigned long long)((__LINE__ - QINIT_CC_LINE_BASE) * QINIT_CC_ORDINALS_PER_LINE), 0u, __VA_ARGS__);
#define CC_ASSERT(c) if (!(c)) { qpi.__qpiAbort(0xCC000000u | (__LINE__ - QINIT_CC_LINE_BASE)); }
#define CC_PAY(dest, amount) qpi.transfer(dest, amount);
#define CC_DEAL(who, amount) { QPI::id __qcw = (who); if (lh_cheat(2u, (unsigned long long)(amount), 0ull, &__qcw, 32u) < 0) qpi.__qpiAbort(0xCC1E0002u); }
#define CC_WARP_TICK(n) { if (lh_cheat(3u, (unsigned long long)(n), 0ull, 0, 0u) < 0) qpi.__qpiAbort(0xCC1E0003u); }
#define CC_WARP_EPOCH(n) { if (lh_cheat(4u, (unsigned long long)(n), 0ull, 0, 0u) < 0) qpi.__qpiAbort(0xCC1E0004u); }
#define CC_PRANK(who, reward) { QPI::id __qcw = (who); if (lh_cheat(5u, (unsigned long long)(reward), 0ull, &__qcw, 32u) < 0) qpi.__qpiAbort(0xCC1E0005u); }
#define CC_UNPRANK() { if (lh_cheat(6u, 0ull, 0ull, 0, 0u) < 0) qpi.__qpiAbort(0xCC1E0006u); }

#endif // QINIT_CHEATS
