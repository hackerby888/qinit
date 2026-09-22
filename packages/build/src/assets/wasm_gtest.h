#pragma once
// Qinit-private Wasm registry for core-lite ContractTesting sources.
#ifdef QINIT_WASM_GTEST

// The simulator receives one final result for each registered test.
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
    bool         truncated;
};
static Ctx g_ctx;

inline void appendBytes(const char* s, unsigned int n) {
    for (unsigned int i = 0; i < n; ++i) {
        if (g_ctx.msgLen >= sizeof(g_ctx.msg) - 1) {
            g_ctx.truncated = true;
            return;
        }
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

// fixed point with up to six decimals, trailing zeros dropped; a magnitude past 1e18 goes scientific since its integer part outgrows u64.
inline void appendF64(double v) {
    if (v != v) {
        appendStr("nan");
        return;
    }
    if (v < 0) {
        appendStr("-");
        v = -v;
    }
    if (v > 1.7976931348623157e308) {
        appendStr("inf");
        return;
    }
    int exponent = 0;
    if (v >= 1e18) {
        while (v >= 10) {
            v /= 10;
            exponent++;
        }
    }
    unsigned long long whole = (unsigned long long)v;
    unsigned long long micros = (unsigned long long)((v - (double)whole) * 1e6 + 0.5);
    if (micros == 1000000) {
        whole++;
        micros = 0;
    }
    appendU64(whole);
    if (micros) {
        char digits[7] = {'.', 0, 0, 0, 0, 0, 0};
        for (int i = 6; i >= 1; i--) {
            digits[i] = (char)('0' + micros % 10);
            micros /= 10;
        }
        int end = 7;
        while (digits[end - 1] == '0') {
            end--;
        }
        appendBytes(digits, (unsigned int)end);
    }
    if (exponent) {
        appendStr("e+");
        appendU64((unsigned long long)exponent);
    }
}

inline void appendHex(const void* p, unsigned int n) {
    const unsigned char* b = (const unsigned char*)p;
    for (unsigned int i = 0; i < n; ++i) {
        const char* digits = "0123456789abcdef";
        char        pair[2] = {digits[b[i] >> 4], digits[b[i] & 0xf]};
        appendBytes(pair, 2);
    }
}

// Render a compared value into the failure message: bool -> true/false, integral -> decimal, floating -> decimal,
// any 32-byte value -> hex (that is QPI::id, which the corpora compare constantly), else -> "(value)".
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
    } else if constexpr (std::is_floating_point_v<T>) {
        appendF64((double)v);
    } else if constexpr (sizeof(T) == 32) {
        appendHex(&v, 32);
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
static unsigned int g_droppedTests = 0;

struct Registrar {
    Registrar(const char* name, TestFn fn) {
        if (g_testCount >= QINIT_GTEST_MAX) {
            ++g_droppedTests;
            return;
        }
        g_tests[g_testCount].name = name;
        g_tests[g_testCount].fn = fn;
        ++g_testCount;
    }
};

// the SCOPED_TRACEs a failure happens inside, innermost first, so a failure in a loop names its iteration.
struct Trace {
    const char*  file;
    int          line;
    const char*  text;
    const Trace* outer;
};
static const Trace* g_trace = nullptr;

inline void failAt(const char* file, int line, const char* what) {
    g_ctx.failed = true;
    appendStr("\n  ");
    appendStr(file);
    appendStr(":");
    appendI64(line);
    appendStr(": ");
    appendStr(what);
    for (const Trace* trace = g_trace; trace; trace = trace->outer) {
        appendStr("\n    trace ");
        appendStr(trace->file);
        appendStr(":");
        appendI64(trace->line);
        appendStr(": ");
        appendStr(trace->text);
    }
}

} // namespace qinit_gtest

// Minimal test environment surface for setup hooks; native gtest is unavailable in Wasm.
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

// the text a SCOPED_TRACE carries. the corpora stream only strings and integers into it.
class Message {
public:
    char         text[160] = {};
    unsigned int len = 0;

    Message& operator<<(const char* s) {
        while (*s) {
            put(*s++);
        }
        return *this;
    }

    Message& operator<<(const Message& other) {
        return *this << other.text;
    }

    template <typename T>
    Message& operator<<(const T& v) {
        if constexpr (std::is_same_v<T, bool>) {
            return *this << (v ? "true" : "false");
        } else if constexpr (std::is_integral_v<T> || std::is_enum_v<T>) {
            unsigned long long u = (unsigned long long)v;
            if (std::is_signed_v<T> && (long long)v < 0) {
                put('-');
                u = 0ull - u;
            }
            char digits[24];
            int  n = 0;
            do {
                digits[n++] = (char)('0' + (int)(u % 10));
                u /= 10;
            } while (u);
            while (n > 0) {
                put(digits[--n]);
            }
            return *this;
        } else {
            return *this << "(value)";
        }
    }

private:
    void put(char c) {
        if (len < sizeof(text) - 1) {
            text[len++] = c;
        }
    }
};
} // namespace testing

namespace qinit_gtest {
// keeps its own copy of the text, since the Message it was built from is a temporary.
struct ScopedTrace {
    ::testing::Message message;
    Trace              trace;

    ScopedTrace(const char* file, int line, const ::testing::Message& m) : message(m), trace{file, line, message.text, g_trace} {
        g_trace = &trace;
    }

    ~ScopedTrace() {
        g_trace = trace.outer;
    }
};
} // namespace qinit_gtest

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

#define QINIT_GTEST_JOIN2(a, b) a##b
#define QINIT_GTEST_JOIN(a, b)  QINIT_GTEST_JOIN2(a, b)
#define SCOPED_TRACE(message)                                                                   \
    ::qinit_gtest::ScopedTrace QINIT_GTEST_JOIN(qinit_gtest_trace_, __LINE__)(__FILE__, __LINE__, \
                                                                          ::testing::Message() << (message))

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

// |a - b| <= error, spelled without fabs so the harness stays free of <cmath>.
#define QINIT_GTEST_NEAR(a, b, error, label, fatal)                                                \
    do {                                                                                        \
        auto qinit_gtest_va = (a);                                                                 \
        auto qinit_gtest_vb = (b);                                                                 \
        auto qinit_gtest_err = (error);                                                            \
        if (!(qinit_gtest_va <= qinit_gtest_vb + qinit_gtest_err && qinit_gtest_vb <= qinit_gtest_va + qinit_gtest_err)) { \
            ::qinit_gtest::failAt(__FILE__, __LINE__, label "(" #a ", " #b ", " #error ")");       \
            ::qinit_gtest::appendStr(" (");                                                        \
            ::qinit_gtest::appendVal(qinit_gtest_va);                                                 \
            ::qinit_gtest::appendStr(" vs ");                                                      \
            ::qinit_gtest::appendVal(qinit_gtest_vb);                                                 \
            ::qinit_gtest::appendStr(")");                                                         \
            if (fatal) return;                                                                  \
        }                                                                                       \
    } while (0)

#define EXPECT_NEAR(a, b, error) QINIT_GTEST_NEAR(a, b, error, "EXPECT_NEAR", false)
#define ASSERT_NEAR(a, b, error) QINIT_GTEST_NEAR(a, b, error, "ASSERT_NEAR", true)

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

// Registrations past QINIT_GTEST_MAX are counted rather than silently dropped; the host warns.
__attribute__((export_name("tests_dropped")))
unsigned int tests_dropped() {
    return ::qinit_gtest::g_droppedTests;
}

__attribute__((export_name("run_test")))
unsigned int run_test(unsigned int i) {
    if (i >= ::qinit_gtest::g_testCount) {
        return 0;
    }
    ::qinit_gtest::g_ctx.failed = false;
    ::qinit_gtest::g_ctx.msgLen = 0;
    ::qinit_gtest::g_ctx.truncated = false;
    ::qinit_gtest::g_tests[i].fn();
    // A message that hit the buffer cap ends in a marker, so a clipped failure never reads as complete.
    if (::qinit_gtest::g_ctx.truncated) {
        const char*        mark = " ...[truncated]";
        const unsigned int markLen = ::qinit_gtest::slen(mark);
        if (::qinit_gtest::g_ctx.msgLen >= markLen) {
            copyMem(::qinit_gtest::g_ctx.msg + (::qinit_gtest::g_ctx.msgLen - markLen), mark, markLen);
        }
    }
    const char* nm = ::qinit_gtest::g_tests[i].name;
    const unsigned int passed = ::qinit_gtest::g_ctx.failed ? 0u : 1u;
    th_report(nm, ::qinit_gtest::slen(nm), passed, ::qinit_gtest::g_ctx.msg, ::qinit_gtest::g_ctx.msgLen);
    return passed;
}
} // extern "C"

#endif // QINIT_WASM_GTEST
