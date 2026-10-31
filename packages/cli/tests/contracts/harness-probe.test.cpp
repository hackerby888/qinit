// Probes for the harness globals a core test may touch directly: assets[], spectrumIndex/energy, contractStates[],
// system and the fee reserve. Each probe does what core's own tests do and checks the engine agrees with core's rules.
#define NO_UEFI

#include "contract_testing.h"

class ContractTestingHarnessProbe : protected ContractTesting
{
public:
    ContractTestingHarnessProbe()
    {
        initEmptySpectrum();
        initEmptyUniverse();
        INIT_CONTRACT(HarnessProbe);
        callSystemProcedure(HarnessProbe_CONTRACT_INDEX, INITIALIZE);
    }

    HarnessProbe::Now_output now() const
    {
        HarnessProbe::Now_input in{};
        HarnessProbe::Now_output out{};
        callFunction(HarnessProbe_CONTRACT_INDEX, 1, in, out);
        return out;
    }

    sint64 shares(const Asset& asset) const
    {
        HarnessProbe::Shares_input in{ asset };
        HarnessProbe::Shares_output out{};
        callFunction(HarnessProbe_CONTRACT_INDEX, 2, in, out);
        return out.shares;
    }

    uint64 read() const
    {
        HarnessProbe::Read_input in{};
        HarnessProbe::Read_output out{};
        callFunction(HarnessProbe_CONTRACT_INDEX, 3, in, out);
        return out.value;
    }

    bool set(const id& user, uint64 value, sint64 reward = 0)
    {
        HarnessProbe::Set_input in{ value };
        HarnessProbe::Set_output out{};
        return invokeUserProcedure(HarnessProbe_CONTRACT_INDEX, 1, in, out, user, reward);
    }

    sint64 pay(const id& user, const id& dest, sint64 amount)
    {
        HarnessProbe::Pay_input in{ dest, amount };
        HarnessProbe::Pay_output out{};
        invokeUserProcedure(HarnessProbe_CONTRACT_INDEX, 2, in, out, user, 0);
        return out.remaining;
    }

    HarnessProbe::StateData& state() const
    {
        return *(HarnessProbe::StateData*)contractStates[HarnessProbe_CONTRACT_INDEX];
    }
};

static const char* const UNIT = "0000000";

// a random id whose first word is pinned, so its hash slot is known and free on a fresh ledger
static id idAt(uint32 firstWord)
{
    id who = id::randomValue();
    who.m256i_u32[0] = firstWord;
    return who;
}

static unsigned int hashSlot(const id& who)
{
    return who.m256i_u32[0] & (unsigned int)(ASSETS_CAPACITY - 1);
}

static unsigned long long storedName(const char* name)
{
    unsigned long long value = 0;
    copyMem(&value, name, 7);
    return value;
}

TEST(HarnessProbe, IssueAssetReturnsUniverseIndices)
{
    ContractTestingHarnessProbe t;
    const id issuer = idAt(0x00400000);
    int ii = -1, oi = -1, pi = -1;
    EXPECT_EQ(issueAsset(issuer, "ALPHA", 2, UNIT, 1000, HarnessProbe_CONTRACT_INDEX, &ii, &oi, &pi), 1000LL);

    // core: the issuance at the issuer's hash, ownership and possession at the next free slots
    EXPECT_EQ(ii, (int)hashSlot(issuer));
    EXPECT_EQ(oi, ii + 1);
    EXPECT_EQ(pi, oi + 1);

    const AssetRecord& issuance = assets[ii];
    EXPECT_EQ((int)issuance.varStruct.issuance.type, ISSUANCE);
    EXPECT_EQ(issuance.varStruct.issuance.publicKey, issuer);
    EXPECT_EQ((int)issuance.varStruct.issuance.numberOfDecimalPlaces, 2);
    EXPECT_EQ(storedName(issuance.varStruct.issuance.name), assetNameFromString("ALPHA"));

    const AssetRecord& ownership = assets[oi];
    EXPECT_EQ((int)ownership.varStruct.ownership.type, OWNERSHIP);
    EXPECT_EQ(ownership.varStruct.ownership.publicKey, issuer);
    EXPECT_EQ(ownership.varStruct.ownership.issuanceIndex, (unsigned int)ii);
    EXPECT_EQ(ownership.varStruct.ownership.managingContractIndex, (unsigned short)HarnessProbe_CONTRACT_INDEX);
    EXPECT_EQ(ownership.varStruct.ownership.numberOfShares, 1000LL);

    const AssetRecord& possession = assets[pi];
    EXPECT_EQ((int)possession.varStruct.possession.type, POSSESSION);
    EXPECT_EQ(possession.varStruct.possession.publicKey, issuer);
    EXPECT_EQ(possession.varStruct.possession.ownershipIndex, (unsigned int)oi);
    EXPECT_EQ(possession.varStruct.possession.numberOfShares, 1000LL);
}

TEST(HarnessProbe, DuplicateIssuanceReturnsZeroAndTheExistingIndex)
{
    ContractTestingHarnessProbe t;
    const id issuer = idAt(0x00400000);
    int ii = -1, oi = -1, pi = -1;
    EXPECT_EQ(issueAsset(issuer, "ALPHA", 0, UNIT, 1000, HarnessProbe_CONTRACT_INDEX, &ii, &oi, &pi), 1000LL);

    // core reports the existing issuance and leaves the ownership and possession outputs alone
    int again = -1, oiAgain = -7, piAgain = -7;
    EXPECT_EQ(issueAsset(issuer, "ALPHA", 0, UNIT, 500, HarnessProbe_CONTRACT_INDEX, &again, &oiAgain, &piAgain), 0LL);
    EXPECT_EQ(again, ii);
    EXPECT_EQ(oiAgain, -7);
    EXPECT_EQ(piAgain, -7);
    EXPECT_EQ(assets[oi].varStruct.ownership.numberOfShares, 1000LL);
}

TEST(HarnessProbe, TransferByIndexPlacesTheOwnerAtItsHash)
{
    ContractTestingHarnessProbe t;
    const id alice = idAt(0x00400000);
    const id bob = idAt(0x00200000);
    int ii = -1, oi = -1, pi = -1;
    EXPECT_EQ(issueAsset(alice, "ALPHA", 0, UNIT, 1000, HarnessProbe_CONTRACT_INDEX, &ii, &oi, &pi), 1000LL);

    // the destination ownership sits at bob's hash; his possession probes from the same hash and lands right after it
    int dstOi = -1, dstPi = -1;
    EXPECT_TRUE(transferShareOwnershipAndPossession(oi, pi, bob, 300, &dstOi, &dstPi, true));
    EXPECT_EQ(dstOi, (int)hashSlot(bob));
    EXPECT_EQ(dstPi, dstOi + 1);
    EXPECT_EQ(assets[dstOi].varStruct.ownership.numberOfShares, 300LL);
    EXPECT_EQ(assets[dstOi].varStruct.ownership.issuanceIndex, (unsigned int)ii);
    EXPECT_EQ(assets[dstPi].varStruct.possession.ownershipIndex, (unsigned int)dstOi);
    EXPECT_EQ(assets[oi].varStruct.ownership.numberOfShares, 700LL);

    // a second transfer to the same owner reuses his records
    int dstOi2 = -1, dstPi2 = -1;
    EXPECT_TRUE(transferShareOwnershipAndPossession(oi, pi, bob, 100, &dstOi2, &dstPi2, true));
    EXPECT_EQ(dstOi2, dstOi);
    EXPECT_EQ(dstPi2, dstPi);
    EXPECT_EQ(assets[dstOi].varStruct.ownership.numberOfShares, 400LL);

    // core refuses a possession that does not belong to the ownership, too many shares, and zero shares
    EXPECT_FALSE(transferShareOwnershipAndPossession(oi, oi, bob, 1, &dstOi2, &dstPi2, true));
    EXPECT_FALSE(transferShareOwnershipAndPossession(oi, pi, bob, 601, &dstOi2, &dstPi2, true));
    EXPECT_FALSE(transferShareOwnershipAndPossession(oi, pi, bob, 0, &dstOi2, &dstPi2, true));
    EXPECT_EQ(assets[oi].varStruct.ownership.numberOfShares, 600LL);

    const Asset asset{ alice, assetNameFromString("ALPHA") };
    EXPECT_EQ(numberOfShares(asset), 1000LL);
    EXPECT_EQ(numberOfShares(asset, AssetOwnershipSelect::byOwner(bob), AssetPossessionSelect::byPossessor(bob)), 400LL);
}

TEST(HarnessProbe, ReferenceSurvivesHostCallsAndReset)
{
    ContractTestingHarnessProbe t;
    const id issuer = idAt(0x00400000);
    int ii = -1, oi = -1, pi = -1;
    EXPECT_EQ(issueAsset(issuer, "ALPHA", 0, UNIT, 1000, HarnessProbe_CONTRACT_INDEX, &ii, &oi, &pi), 1000LL);
    AssetRecord& a = assets[ii];
    const AssetRecord* const address = &a;

    // records at lower indices appear; on core's array nothing moves
    for (uint32 k = 1; k <= 20; ++k)
    {
        int bi = -1;
        EXPECT_EQ(issueAsset(idAt(k * 16), "BETA", 0, UNIT, 5, HarnessProbe_CONTRACT_INDEX, &bi, nullptr, nullptr), 5LL);
        EXPECT_EQ(bi, (int)(k * 16));
    }
    EXPECT_EQ(&assets[ii], address);
    EXPECT_EQ((int)a.varStruct.issuance.type, ISSUANCE);
    EXPECT_EQ(a.varStruct.issuance.publicKey, issuer);

    // core's renameIssuance pattern: the edit reaches the engine at the next universe call
    const unsigned long long renamed = assetNameFromString("OMEGA");
    copyMem(a.varStruct.issuance.name, &renamed, 7);
    EXPECT_EQ(numberOfShares(Asset{ issuer, renamed }), 1000LL);
    EXPECT_EQ(numberOfShares(Asset{ issuer, assetNameFromString("ALPHA") }), 0LL);
    EXPECT_EQ(t.shares(Asset{ issuer, renamed }), 1000LL);

    // a reset wipes the universe; the held reference reads EMPTY at the same address, as on core's zeroed array
    ContractTestingHarnessProbe fresh;
    EXPECT_EQ((int)a.varStruct.issuance.type, EMPTY);
    EXPECT_EQ(&assets[ii], address);
}

TEST(HarnessProbe, MirrorReloadsAfterEveryUniverseChange)
{
    ContractTestingHarnessProbe t;
    const id alice = idAt(0x00400000);
    const id bob = idAt(0x00200000);
    int ii = -1, oi = -1, pi = -1;
    EXPECT_EQ(issueAsset(alice, "ALPHA", 0, UNIT, 1000, HarnessProbe_CONTRACT_INDEX, &ii, &oi, &pi), 1000LL);
    const AssetRecord& ownership = assets[oi];
    EXPECT_EQ(ownership.varStruct.ownership.numberOfShares, 1000LL);

    // the held reference follows the transfer without a new subscript
    EXPECT_TRUE(transferShareOwnershipAndPossession(oi, pi, bob, 300, nullptr, nullptr, true));
    EXPECT_EQ(ownership.varStruct.ownership.numberOfShares, 700LL);
    EXPECT_EQ(assets[hashSlot(bob)].varStruct.ownership.numberOfShares, 300LL);
}

TEST(HarnessProbe, ContractSeesTheMirrorWrite)
{
    ContractTestingHarnessProbe t;
    const id issuer = idAt(0x00400000);
    int ii = -1, oi = -1, pi = -1;
    EXPECT_EQ(issueAsset(issuer, "ALPHA", 0, UNIT, 1000, HarnessProbe_CONTRACT_INDEX, &ii, &oi, &pi), 1000LL);

    assets[oi].varStruct.ownership.numberOfShares = 5000;
    EXPECT_EQ(t.shares(Asset{ issuer, assetNameFromString("ALPHA") }), 5000LL);
}

// expected to fail: the harness names the empty index it cannot create a record at, and drops the edit
TEST(HarnessProbe, WriteIntoAnEmptyIndexIsRefused)
{
    ContractTestingHarnessProbe t;
    assets[5].varStruct.issuance.type = ISSUANCE;
    EXPECT_EQ(numberOfShares(Asset{ idAt(0x00400000), assetNameFromString("ALPHA") }), 0LL);
    EXPECT_EQ((int)assets[5].varStruct.issuance.type, EMPTY);
}

static unsigned long long occupiedRecords()
{
    unsigned long long occupied = 0;
    for (unsigned long long i = 0; i < ASSETS_CAPACITY; ++i)
    {
        if (assets[(unsigned int)i].varStruct.issuance.type != EMPTY) ++occupied;
    }
    return occupied;
}

TEST(HarnessProbe, ScanFindsOnlyTheRecordsIssued)
{
    ContractTestingHarnessProbe t;
    const unsigned long long before = occupiedRecords();
    int ii = -1, oi = -1, pi = -1;
    EXPECT_EQ(issueAsset(idAt(0x00400000), "ALPHA", 0, UNIT, 1000, HarnessProbe_CONTRACT_INDEX, &ii, &oi, &pi), 1000LL);
    EXPECT_EQ(occupiedRecords(), before + 3);
}

TEST(HarnessProbe, SpectrumIndexIsCoresHashSlot)
{
    ContractTestingHarnessProbe t;
    const id user = idAt(0x00012345);
    EXPECT_EQ(spectrumIndex(user), -1);
    EXPECT_EQ(getBalance(user), 0LL);

    // core claims the slot at the id's hash even for a zero amount; the first word stays below 2^18 so a lite-depth spectrum agrees
    increaseEnergy(user, 0);
    const int index = spectrumIndex(user);
    EXPECT_EQ(index, 0x12345);
    EXPECT_EQ(energy(index), 0LL);
    EXPECT_EQ(getBalance(user), 0LL);

    increaseEnergy(user, 1000);
    EXPECT_EQ(energy(index), 1000LL);
    EXPECT_FALSE(decreaseEnergy(index, 1001));
    EXPECT_FALSE(decreaseEnergy(index, -1));
    EXPECT_TRUE(decreaseEnergy(index, 0));
    EXPECT_EQ(energy(index), 1000LL);
    EXPECT_TRUE(decreaseEnergy(index, 1000));
    EXPECT_EQ(energy(index), 0LL);
    EXPECT_EQ(spectrumIndex(user), index);

    // a second id with the same hash probes to the next slot
    const id neighbour = idAt(0x00012345);
    increaseEnergy(neighbour, 7);
    EXPECT_EQ(spectrumIndex(neighbour), index + 1);
    EXPECT_EQ(energy(index + 1), 7LL);
}

TEST(HarnessProbe, InvokeWithoutASpectrumRecordIsRefused)
{
    ContractTestingHarnessProbe t;
    const id user = idAt(0x00012345);
    EXPECT_FALSE(t.set(user, 9));
    EXPECT_EQ(t.read(), 0ull);

    // a record with a zero balance is enough for a free invocation, not for a reward
    increaseEnergy(user, 0);
    EXPECT_TRUE(t.set(user, 9));
    EXPECT_EQ(t.read(), 9ull);
    EXPECT_FALSE(t.set(user, 10, 1));
    EXPECT_EQ(t.read(), 9ull);
}

TEST(HarnessProbe, ContractTransferShowsInTheSpectrum)
{
    ContractTestingHarnessProbe t;
    const id user = idAt(0x00012345);
    const id dest = idAt(0x00054321);
    const id contract(HarnessProbe_CONTRACT_INDEX, 0, 0, 0);
    increaseEnergy(user, 1000);
    increaseEnergy(contract, 1000);
    EXPECT_EQ(spectrumIndex(dest), -1);

    EXPECT_EQ(t.pay(user, dest, 400), 600LL);
    EXPECT_EQ(getBalance(dest), 400LL);
    EXPECT_EQ(getBalance(contract), 600LL);
    EXPECT_EQ(spectrumIndex(dest), 0x54321);
}

TEST(HarnessProbe, StateWriteReachesTheContract)
{
    ContractTestingHarnessProbe t;
    const id user = idAt(0x00012345);
    increaseEnergy(user, 1000);

    t.state().value = 42;
    EXPECT_EQ(t.read(), 42ull);
    EXPECT_TRUE(t.set(user, 7));
    EXPECT_EQ(t.state().value, 7ull);
}

TEST(HarnessProbe, SystemEpochAndTickReachTheContract)
{
    ContractTestingHarnessProbe t;
    const unsigned short epochBefore = system.epoch;
    const unsigned int tickBefore = system.tick;

    system.epoch = 190;
    system.tick = 12345;
    EXPECT_EQ(t.now().epoch, (uint16)190);
    EXPECT_EQ(t.now().tick, 12345u);
    system.tick += 1;
    EXPECT_EQ(t.now().tick, 12346u);

    // core's system is a global that outlives the fixture
    ContractTestingHarnessProbe fresh;
    EXPECT_EQ((int)system.epoch, 190);
    EXPECT_EQ(fresh.now().epoch, (uint16)190);

    system.epoch = epochBefore;
    system.tick = tickBefore;
}

TEST(HarnessProbe, SecondFixtureResetsSpectrumAndUniverse)
{
    ContractTestingHarnessProbe t;
    const id user = idAt(0x00012345);
    increaseEnergy(user, 1000);
    int ii = -1, oi = -1, pi = -1;
    EXPECT_EQ(issueAsset(user, "ALPHA", 0, UNIT, 1000, HarnessProbe_CONTRACT_INDEX, &ii, &oi, &pi), 1000LL);
    EXPECT_TRUE(t.set(user, 7));

    ContractTestingHarnessProbe fresh;
    EXPECT_EQ(spectrumIndex(user), -1);
    EXPECT_EQ(getBalance(user), 0LL);
    EXPECT_EQ((int)assets[ii].varStruct.issuance.type, EMPTY);
    EXPECT_EQ(numberOfShares(Asset{ user, assetNameFromString("ALPHA") }), 0LL);
    EXPECT_EQ(fresh.read(), 0ull);
}

TEST(HarnessProbe, FeeReserveRoundTrips)
{
    ContractTestingHarnessProbe t;
    EXPECT_EQ(getContractFeeReserve(HarnessProbe_CONTRACT_INDEX), 10000000LL);
    setContractFeeReserve(HarnessProbe_CONTRACT_INDEX, 123);
    EXPECT_EQ(getContractFeeReserve(HarnessProbe_CONTRACT_INDEX), 123LL);
}
