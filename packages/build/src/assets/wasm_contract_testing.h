#pragma once

#include <algorithm>
#include <map>
#include <set>
#include <vector>

// Wasm-mode replacement for core-lite contract_testing.h.
// Routes ContractTesting / free-helper calls to "thost" imports bound by
// @qinit/engine runContractTesting(). Included after extensions/lite_test.h
// inside the wrapper TU; relies on types already in scope: QPI::id, QPI::Asset,
// QPI::sint64, setMem, copyMem, malloc.

// ---- thost import declarations (module "thost", names fixed by runContractTesting) ----

#define QBCT_IMPORT(n) __attribute__((import_module("thost"), import_name(#n)))

extern "C" {
QBCT_IMPORT(q_reset)     void          bq_reset();
QBCT_IMPORT(q_init)      void          bq_init(unsigned int idx);
QBCT_IMPORT(q_invoke)    unsigned int  bq_invoke(unsigned int idx, unsigned int it, const void* in, unsigned int inLen, long long amount, const void* origin32, void* out, unsigned int outCap);
QBCT_IMPORT(q_query)     unsigned int  bq_query(unsigned int idx, unsigned int it, const void* in, unsigned int inLen, void* out, unsigned int outCap);
QBCT_IMPORT(q_sysproc)   void          bq_sysproc(unsigned int idx, unsigned int sp);
QBCT_IMPORT(q_fund)      void          bq_fund(const void* id32, long long amount);
QBCT_IMPORT(q_balance)   long long     bq_balance(const void* id32);
QBCT_IMPORT(q_shares)    long long     bq_shares(const void* issuer32, unsigned long long assetName);
QBCT_IMPORT(q_possessed) long long     bq_possessed(unsigned long long name, const void* issuer32, const void* owner32, const void* possessor32, unsigned int om, unsigned int pm);
QBCT_IMPORT(q_spectrum)  int           bq_spectrum(const void* id32);
QBCT_IMPORT(q_decrease)  void          bq_decrease(int idx, long long amount);
QBCT_IMPORT(q_state_size) unsigned int bq_state_size(unsigned int i);
QBCT_IMPORT(q_state_in)   void         bq_state_in(unsigned int i, void* dst, unsigned int len);
QBCT_IMPORT(q_set_epoch)  void         bq_set_epoch(unsigned int e);
QBCT_IMPORT(q_get_epoch)  unsigned int bq_get_epoch();
QBCT_IMPORT(q_set_tick)   void         bq_set_tick(unsigned int t);
QBCT_IMPORT(q_get_tick)   unsigned int bq_get_tick();
QBCT_IMPORT(q_set_datetime) void       bq_set_datetime(unsigned int y, unsigned int mo, unsigned int d, unsigned int h, unsigned int mi, unsigned int s);
QBCT_IMPORT(q_set_computor) void       bq_set_computor(unsigned int i, const void* id32);
}

#undef QBCT_IMPORT

// ---- std::cout / std::cerr / std::endl: no-op sinks ----
// The wasm TU has no <iostream>; corpora stream PRINT_TEST_INFO debug output through std::cout.
// A null stream swallows every `<<` (values and the std::endl manipulator) so the prints type-check
// and compile away. std::vector/map/set/min/max resolve from the container/<algorithm> includes above.
//
// Skipped when the corpus pulls real <iostream> itself: buildCorpusRunner defines QINIT_HAVE_IOSTREAM
// in that case, so the real std::cout is used and these stubs don't collide with it.

#ifndef QINIT_HAVE_IOSTREAM

namespace std {

struct QbNullStream {
    template <typename T>
    const QbNullStream& operator<<(const T&) const {
        return *this;
    }

    const QbNullStream& operator<<(const QbNullStream& (*)(const QbNullStream&)) const {
        return *this;
    }
};

inline const QbNullStream& endl(const QbNullStream& s) {
    return s;
}

static const QbNullStream cout;
static const QbNullStream cerr;

}

#endif

// ---- system procedure identifiers (matches core-lite SystemProcedureID values) ----

enum SystemProcedureID {
    INITIALIZE  = 0,
    BEGIN_EPOCH = 1,
    END_EPOCH   = 2,
    BEGIN_TICK  = 3,
    END_TICK    = 4,
};

// ---- contractStates: lazy shadow-buffer proxy synced from engine on each access ----

static void* qb_state_bufs[64];

static inline void* qb_state_ptr(unsigned int i) {
    if (!qb_state_bufs[i]) {
        qb_state_bufs[i] = malloc(bq_state_size(i));
    }
    bq_state_in(i, qb_state_bufs[i], bq_state_size(i));
    return qb_state_bufs[i];
}

struct QbStatesProxy {
    void* operator[](unsigned int i) const {
        return qb_state_ptr(i);
    }
};

static QbStatesProxy contractStates;

// ---- ContractTesting class: same public surface as core-lite ContractTesting ----

class ContractTesting {
public:
    ContractTesting() {
        bq_reset();
    }

    void initEmptySpectrum() {
    }

    void initEmptyUniverse() {
    }

    template <typename InputType, typename OutputType>
    unsigned int callFunction(unsigned int contractIndex, unsigned short fnInputType, const InputType& input, OutputType& output, bool checkInputSize = true, bool expectSuccess = true) const {
        bq_query(contractIndex, fnInputType, &input, sizeof(input), &output, sizeof(output));
        return 0;
    }

    template <typename InputType, typename OutputType>
    bool invokeUserProcedure(unsigned int contractIndex, unsigned short procInputType, const InputType& input, OutputType& output, const QPI::id& user, QPI::sint64 amount, bool checkInputSize = true, bool expectSuccess = true) {
        setMem(&output, sizeof(output), 0);
        // Mirror core-lite contract_testing.h: the invocation fails (no procedure run, nothing transferred)
        // when the user can't fund the attached amount (fee / invocation reward). Corpora assert this return
        // for unfunded/insufficient callers (e.g. QEARN's lock-before-INITIAL_EPOCH cases).
        if (amount > 0 && bq_balance(&user) < amount) {
            return false;
        }
        bq_invoke(contractIndex, procInputType, &input, sizeof(input), (long long)amount, &user, &output, sizeof(output));
        return true;
    }

    void callSystemProcedure(unsigned int contractIndex, SystemProcedureID sysProcId, bool expectSuccess = true) {
        bq_sysproc(contractIndex, (unsigned int)sysProcId);
    }
};

// ---- system.epoch / system.tick control: proxy through q_get/set_epoch and q_get/set_tick ----

struct QbEpochProxy {
    operator unsigned short() const {
        return (unsigned short)bq_get_epoch();
    }

    void operator=(unsigned int e) {
        bq_set_epoch(e);
    }

    QbEpochProxy& operator++() {  // ++epoch
        bq_set_epoch(bq_get_epoch() + 1u);
        return *this;
    }

    unsigned int operator++(int) {  // epoch++ (corpora advance the epoch this way)
        unsigned int v = bq_get_epoch();
        bq_set_epoch(v + 1u);
        return v;
    }
};

struct QbTickProxy {
    operator unsigned int() const {
        return bq_get_tick();
    }

    void operator=(unsigned int t) {
        bq_set_tick(t);
    }

    QbTickProxy& operator++() {
        bq_set_tick(bq_get_tick() + 1u);
        return *this;
    }

    unsigned int operator++(int) {
        unsigned int v = bq_get_tick();
        bq_set_tick(v + 1u);
        return v;
    }
};

struct QbSystemStruct {
    QbEpochProxy epoch;
    QbTickProxy tick;
};

// ---- utcTime / updateTime / updateQpiTime: corpus time control ----
// utcTime is the EFI_TIME (lib/platform_efi/uefi.h, already in scope) a corpus sets, then pushes to the chain
// clock via updateQpiTime() so the contract's qpi.year()/month()/day()/... reflect it. updateTime() (native:
// read the wall clock) is a no-op here — the corpus always overwrites the fields it cares about, then pushes.
static EFI_TIME utcTime = { 2024, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0 };

static inline void updateTime() {
}

static inline void updateQpiTime() {
    bq_set_datetime(utcTime.Year, utcTime.Month, utcTime.Day, utcTime.Hour, utcTime.Minute, utcTime.Second);
}

static QbSystemStruct qubicSystemStruct;

// Matches core-lite's `#define system qubicSystemStruct`
#define system qubicSystemStruct

// ---- contractDescriptions: constructionEpoch values from contract_def.h; stateSize 0 in wasm mode ----
// Indices mirror the native contract_def.h array. Only constructionEpoch is accessed by EASY-tier corpora.

struct QbContractDescription {
    char assetName[8];
    unsigned short constructionEpoch;
    unsigned short destructionEpoch;
    unsigned long long stateSize;
};

static const QbContractDescription contractDescriptions[] = {
    {"",        0,   0,     0},  // index  0
    {"QX",      66,  10000, 0},  // index  1
    {"QTRY",    72,  10000, 0},  // index  2
    {"RANDOM",  88,  10000, 0},  // index  3
    {"QUTIL",   99,  10000, 0},  // index  4
    {"MLM",     112, 10000, 0},  // index  5
    {"GQMPROP", 123, 10000, 0},  // index  6
    {"SWATCH",  123, 10000, 0},  // index  7
    {"CCF",     127, 10000, 0},  // index  8
    {"QEARN",   137, 10000, 0},  // index  9
    {"QVAULT",  138, 10000, 0},  // index 10
    {"MSVAULT", 149, 10000, 0},  // index 11
    {"QBAY",    154, 10000, 0},  // index 12
    {"QSWAP",   171, 10000, 0},  // index 13
    {"NOST",    172, 10000, 0},  // index 14
    {"QDRAW",   179, 10000, 0},  // index 15
    {"RL",      182, 10000, 0},  // index 16
    {"QBOND",   182, 10000, 0},  // index 17
    {"QIP",     189, 10000, 0},  // index 18
    {"QRAFFLE", 192, 10000, 0},  // index 19
    {"QRWA",    197, 10000, 0},  // index 20
    {"QRP",     199, 10000, 0},  // index 21
    {"QTF",     199, 10000, 0},  // index 22
    {"QDUEL",   199, 10000, 0},  // index 23
    {"PULSE",   204, 10000, 0},  // index 24
    {"VOTTUN",  206, 10000, 0},  // index 25
    {"QUSINO",  208, 10000, 0},  // index 26
    {"ESCROW",  210, 10000, 0},  // index 27
    {"GGWP",    218, 10000, 0},  // index 28
};

static const unsigned int contractCount =
    sizeof(contractDescriptions) / sizeof(contractDescriptions[0]);

// ---- broadcastedComputors: layout-compatible stub of core-lite's global ----
// GQMPROP/CCF corpora seed committee identities via `broadcastedComputors.computors.publicKeys[i] = id`.
// Native pulls this from special_entities.h; the wasm TU does not, so a matching struct is declared here
// (m256i and NUMBER_OF_COMPUTORS come from qpi.h). publicKeys is a write-through proxy: each assignment
// both stores locally (for read-back) and routes to bq_set_computor, so the engine's qpi.computor(i)
// returns the same identity the test seeded and the contract's proposer-is-a-computor check matches.

struct QbComputorKeys {
    m256i _keys[NUMBER_OF_COMPUTORS];

    struct Slot {
        m256i* keys;
        unsigned int idx;

        Slot& operator=(const m256i& v) {
            keys[idx] = v;
            bq_set_computor(idx, &v);
            return *this;
        }

        operator const m256i&() const {
            return keys[idx];
        }
    };

    Slot operator[](unsigned long long i) {
        return Slot{_keys, (unsigned int)i};
    }

    const m256i& operator[](unsigned long long i) const {
        return _keys[i % NUMBER_OF_COMPUTORS];
    }
};

struct QbBroadcastComputors {
    struct {
        unsigned short epoch;
        QbComputorKeys publicKeys;
        unsigned char signature[64];
    } computors;
};

static QbBroadcastComputors broadcastedComputors;

// ---- free helpers ----

static inline void increaseEnergy(const QPI::id& who, QPI::sint64 amount) {
    bq_fund(&who, (long long)amount);
}

static inline long long getBalance(const QPI::id& who) {
    return bq_balance(&who);
}

static inline int spectrumIndex(const QPI::id& who) {
    return bq_spectrum(&who);
}

static inline bool decreaseEnergy(int idx, QPI::sint64 amount) {
    bq_decrease(idx, (long long)amount);
    return true;
}

static inline QPI::sint64 numberOfShares(const QPI::Asset& a,
    const QPI::AssetOwnershipSelect& own = QPI::AssetOwnershipSelect::any(),
    const QPI::AssetPossessionSelect& pos = QPI::AssetPossessionSelect::any()) {
    // No owner/possessor filter → total issued shares. Otherwise route to the filtered possession query
    // (the host applies the owner/possessor + managing-contract selects).
    if (own.anyOwner && own.anyManagingContract && pos.anyPossessor && pos.anyManagingContract)
        return bq_shares(&a.issuer, a.assetName);
    return bq_possessed(a.assetName, &a.issuer, &own.owner, &pos.possessor, own.managingContract, pos.managingContract);
}

static inline long long numberOfPossessedShares(unsigned long long name, const QPI::id& issuer, const QPI::id& owner, const QPI::id& possessor, unsigned int om, unsigned int pm) {
    return bq_possessed(name, &issuer, &owner, &possessor, om, pm);
}

static inline unsigned long long assetNameFromString(const char* s) {
    unsigned long long n = 0;
    for (int i = 0; i < 8 && s[i]; ++i) {
        n |= (unsigned long long)(unsigned char)s[i] << (8 * i);
    }
    return n;
}

static inline std::string assetNameFromInt64(unsigned long long assetName) {
    char buffer[8];
    copyMem(buffer, &assetName, sizeof(assetName));
    buffer[7] = 0;
    return buffer;
}

static inline void checkContractExecCleanup() {
}

// Identity (56 A-Z chars + 4-char checksum) -> 32-byte public key: base26 decode, 14 chars per 64-bit limb,
// little-endian; the trailing checksum chars are not needed to recover the key. Mirrors core-lite four_q.h
// getPublicKeyFromIdentity. Corpora seed fixed identities this way (QSWAP's invest-rewards address).
static inline bool getPublicKeyFromIdentity(const unsigned char* identity, unsigned char* publicKey) {
    for (int i = 0; i < 4; i++) {
        unsigned long long limb = 0;
        for (int j = 14; j-- > 0; ) {
            unsigned char c = identity[i * 14 + j];
            if (c < 'A' || c > 'Z') {
                return false;
            }
            limb = limb * 26 + (unsigned long long)(c - 'A');
        }
        for (int b = 0; b < 8; b++) {
            publicKey[(i << 3) + b] = (unsigned char)(limb >> (8 * b));
        }
    }
    return true;
}

// State save/load to disk — core-lite platform/file_io.h, which has no wasm equivalent. A corpus may define a
// loadState()/saveState() helper over these (QSWAP) without any test invoking it, so never-called stubs that
// report failure are enough to compile. CHAR16 is already in scope from the included platform headers.
static inline long long load(const CHAR16*, unsigned long long, void*, const CHAR16* = nullptr) {
    return -1;
}

static inline long long save(const CHAR16*, unsigned long long, const void*, const CHAR16* = nullptr) {
    return -1;
}

// ---- INIT_CONTRACT macro ----

#define INIT_CONTRACT(name) bq_init(name##_CONTRACT_INDEX)
