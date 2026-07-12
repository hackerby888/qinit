#pragma once
// Qinit-private Wasm test registry and assertion shim. User tests use core-lite's
// contract_testing.h / ContractTesting source format; this header is injected by
#ifdef QINIT_WASM_GTEST

// The virtual node receives one final result for each registered test.
#define QINIT_TEST_IMPORT(name) __attribute__((import_module("thost"), import_name(#name)))
extern "C" {
QINIT_TEST_IMPORT(t_report) void th_report(const void* name, unsigned int nameLen, unsigned int passed, const void* msg, unsigned int msgLen);
}
#undef QINIT_TEST_IMPORT

namespace qinit_gtest {

// ---- minimal string ops + value formatting (no libc <stdio>/<string>; freestanding wasm) ----
inline unsigned int slen(const char* s) {
    unsigned int n = 0;
    while (s[n]) {
        ++n;
    }
    return n;
}

// Per-test failure accumulator. One test runs at a time, so a single static buffer is enough.
struct Ctx {
    char         msg[2048];
    unsigned int msgLen;
    bool         failed;
};
static Ctx g_ctx;

inline void appendBytes(const char* s, unsigned int n) {
    for (unsigned int i = 0; i < n && g_ctx.msgLen < sizeof(g_ctx.msg) - 1; ++i) {
        g_ctx.msg[g_ctx.msgLen++] = s[i];
    }
}
inline void appendStr(const char* s) {
    appendBytes(s, slen(s));
}

inline void appendI64(long long v) {
    char buf[24];
    int  i = 0;
    bool neg = v < 0;
    unsigned long long u = neg ? (unsigned long long)(-(v + 1)) + 1ull : (unsigned long long)v;
    if (u == 0) {
        buf[i++] = '0';
    }
    while (u) {
        buf[i++] = (char)('0' + (int)(u % 10));
        u /= 10;
    }
    if (neg) {
        buf[i++] = '-';
    }
    while (i > 0) {
        char c = buf[--i];
        appendBytes(&c, 1);
    }
}
inline void appendU64(unsigned long long u) {
    char buf[24];
    int  i = 0;
    if (u == 0) {
        buf[i++] = '0';
    }
    while (u) {
        buf[i++] = (char)('0' + (int)(u % 10));
        u /= 10;
    }
    while (i > 0) {
        char c = buf[--i];
        appendBytes(&c, 1);
    }
}

// Render a compared value into the failure message: bool -> true/false, integral -> decimal, else -> "(value)".
template <typename T>
inline void appendVal(const T& v) {
    if constexpr (std::is_same_v<T, bool>) {
        appendStr(v ? "true" : "false");
    } else if constexpr (std::is_integral_v<T>) {
        if constexpr (std::is_signed_v<T>) {
            appendI64((long long)v);
        } else {
            appendU64((unsigned long long)v);
        }
    } else {
        appendStr("(value)");
    }
}

// ---- test registry: populated at module init (reactor _initialize runs the Registrar ctors) ----
typedef void (*TestFn)();
struct Entry {
    const char* name;
    TestFn      fn;
};
#ifndef QINIT_GTEST_MAX
#define QINIT_GTEST_MAX 512
#endif
static Entry        g_tests[QINIT_GTEST_MAX];
static unsigned int g_testCount = 0;

struct Registrar {
    Registrar(const char* name, TestFn fn) {
        if (g_testCount < QINIT_GTEST_MAX) {
            g_tests[g_testCount].name = name;
            g_tests[g_testCount].fn = fn;
            ++g_testCount;
        }
    }
};

inline void failAt(const char* file, int line, const char* what) {
    g_ctx.failed = true;
    appendStr("\n  ");
    appendStr(file);
    appendStr(":");
    appendI64(line);
    appendStr(": ");
    appendStr(what);
}

} // namespace qinit_gtest

// Googletest-compatible test environment surface (GGWP and other corpora use ::testing::Environment
// + AddGlobalTestEnvironment to run setup before the first test). Native gtest is unavailable in
namespace testing {
class Environment {
public:
    virtual ~Environment() {}
    virtual void SetUp() {}
    virtual void TearDown() {}
};
static inline Environment* AddGlobalTestEnvironment(Environment* e) {
    e->SetUp();
    return e;
}
} // namespace testing

// ---- googletest-compatible macros ----
#define TEST(suite, name)                                                                       \
    static void qinit_gtest_body_##suite##_##name();                                               \
    static ::qinit_gtest::Registrar qinit_gtest_reg_##suite##_##name(#suite "." #name,                \
                                                                &qinit_gtest_body_##suite##_##name); \
    static void qinit_gtest_body_##suite##_##name()

#define QINIT_GTEST_BOOL(cond, what, fatal)                                                       \
    do {                                                                                        \
        if (!(cond)) {                                                                          \
            ::qinit_gtest::failAt(__FILE__, __LINE__, what);                                       \
            if (fatal) return;                                                                  \
        }                                                                                       \
    } while (0)

#define QINIT_GTEST_CMP(a, b, op, label, fatal)                                                   \
    do {                                                                                        \
        auto qinit_gtest_va = (a);                                                                 \
        auto qinit_gtest_vb = (b);                                                                 \
        if (!(qinit_gtest_va op qinit_gtest_vb)) {                                                    \
            ::qinit_gtest::failAt(__FILE__, __LINE__, label "(" #a ", " #b ")");                   \
            ::qinit_gtest::appendStr(" (");                                                        \
            ::qinit_gtest::appendVal(qinit_gtest_va);                                                 \
            ::qinit_gtest::appendStr(" vs ");                                                      \
            ::qinit_gtest::appendVal(qinit_gtest_vb);                                                 \
            ::qinit_gtest::appendStr(")");                                                         \
            if (fatal) return;                                                                  \
        }                                                                                       \
    } while (0)

#define EXPECT_TRUE(x)  QINIT_GTEST_BOOL((x), "EXPECT_TRUE(" #x ")", false)
#define EXPECT_FALSE(x) QINIT_GTEST_BOOL(!(x), "EXPECT_FALSE(" #x ")", false)
#define ASSERT_TRUE(x)  QINIT_GTEST_BOOL((x), "ASSERT_TRUE(" #x ")", true)
#define ASSERT_FALSE(x) QINIT_GTEST_BOOL(!(x), "ASSERT_FALSE(" #x ")", true)

#define EXPECT_EQ(a, b) QINIT_GTEST_CMP(a, b, ==, "EXPECT_EQ", false)
#define EXPECT_NE(a, b) QINIT_GTEST_CMP(a, b, !=, "EXPECT_NE", false)
#define EXPECT_LT(a, b) QINIT_GTEST_CMP(a, b, <,  "EXPECT_LT", false)
#define EXPECT_LE(a, b) QINIT_GTEST_CMP(a, b, <=, "EXPECT_LE", false)
#define EXPECT_GT(a, b) QINIT_GTEST_CMP(a, b, >,  "EXPECT_GT", false)
#define EXPECT_GE(a, b) QINIT_GTEST_CMP(a, b, >=, "EXPECT_GE", false)
#define ASSERT_EQ(a, b) QINIT_GTEST_CMP(a, b, ==, "ASSERT_EQ", true)
#define ASSERT_NE(a, b) QINIT_GTEST_CMP(a, b, !=, "ASSERT_NE", true)
#define ASSERT_LT(a, b) QINIT_GTEST_CMP(a, b, <,  "ASSERT_LT", true)
#define ASSERT_LE(a, b) QINIT_GTEST_CMP(a, b, <=, "ASSERT_LE", true)
#define ASSERT_GT(a, b) QINIT_GTEST_CMP(a, b, >,  "ASSERT_GT", true)
#define ASSERT_GE(a, b) QINIT_GTEST_CMP(a, b, >=, "ASSERT_GE", true)

// ---- runner exports the engine calls to enumerate + run tests ----
extern "C" {
__attribute__((export_name("test_count")))
unsigned int test_count() {
    return ::qinit_gtest::g_testCount;
}

__attribute__((export_name("test_name")))
unsigned int test_name(unsigned int i, void* out, unsigned int cap) {
    if (i >= ::qinit_gtest::g_testCount) {
        return 0;
    }
    const char*  nm = ::qinit_gtest::g_tests[i].name;
    unsigned int n = ::qinit_gtest::slen(nm);
    if (n > cap) {
        n = cap;
    }
    copyMem(out, nm, n);
    return n;
}

__attribute__((export_name("run_test")))
unsigned int run_test(unsigned int i) {
    if (i >= ::qinit_gtest::g_testCount) {
        return 0;
    }
    ::qinit_gtest::g_ctx.failed = false;
    ::qinit_gtest::g_ctx.msgLen = 0;
    ::qinit_gtest::g_tests[i].fn();
    const char* nm = ::qinit_gtest::g_tests[i].name;
    const unsigned int passed = ::qinit_gtest::g_ctx.failed ? 0u : 1u;
    th_report(nm, ::qinit_gtest::slen(nm), passed, ::qinit_gtest::g_ctx.msg, ::qinit_gtest::g_ctx.msgLen);
    return passed;
}
} // extern "C"

#endif // QINIT_WASM_GTEST
