// The rest of the host surface: digests, fee reserves, K12 over each kind of operand, and the calls a
// hook can make that an entry cannot.
//
// Round 4 covered identity, money and the calendar. What is left is mostly *bytes in, bytes out*:
// `qpi.K12` over a scalar, a struct, an array and an id; the three previous-state digests the protocol
// exposes; and the fee reserve. All of it is pinned by the harness (a fixed spectrum digest, a fixed
// clock, a pinned committee), so anything that moves between the two backends moved because of code
// generation.
//
// F203 lives in this territory — `qpi.K12(<expression>)` hashes different bytes than
// `qpi.K12(<variable>)` — so every K12 here is taken over a named local, which is the spelling that
// agrees, and one archetype deliberately keeps both spellings side by side.

import { twoOperandArchetype } from "./common";
import type { Archetype } from "../types";

export const HOSTCALL_MORE_ARCHETYPES: Archetype[] = [
    twoOperandArchetype(
        {
            name: "HostPreviousDigestsAreStable",
            family: "hostcalls",
            solidity: "no Solidity analogue (blockhash)",
            stresses:
                "the three previous-state digests — spectrum, universe and computer — read twice in one call and compared, which is the property a contract using them for randomness depends on",
            caveat: "Ethereum's nearest equivalent is `blockhash`, which is one value; QPI exposes three, and none of them is a hash of the block.",
        },
        () => ({
            state: "uint64 spectrumWord;\nuint64 universeWord;\nuint64 computerWord;\nuint64 stableWithinCall;\nuint64 allDistinct;",
            locals: "id spectrum;\nid universe;\nid computer;\nid again;",
            body: `
                locals.spectrum = qpi.getPrevSpectrumDigest();
                locals.universe = qpi.getPrevUniverseDigest();
                locals.computer = qpi.getPrevComputerDigest();
                locals.again = qpi.getPrevSpectrumDigest();
                state.mut().spectrumWord = locals.spectrum.u64._0;
                state.mut().universeWord = locals.universe.u64._0;
                state.mut().computerWord = locals.computer.u64._0;
                state.mut().stableWithinCall = locals.spectrum == locals.again ? 1 : 0;
                state.mut().allDistinct = !(locals.spectrum == locals.universe) && !(locals.universe == locals.computer) ? 1 : 0;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [18446744073709551615n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "HostK12OverEveryOperandKind",
            family: "hostcalls",
            solidity: "openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol",
            stresses:
                "K12 taken over a scalar, a struct, a fixed array and an id — four operand kinds, each hashed from a named local, with the first word of each digest stored",
            caveat: "Solidity's keccak256 takes bytes; QPI's K12 takes a typed object, so what is hashed is the object's memory image and its padding is part of the input.",
        },
        () => ({
            extraStructs: "struct Payload\n{\n    uint64 a;\n    uint32 b;\n    uint8 c;\n};",
            state: "uint64 fromScalar;\nuint64 fromStruct;\nuint64 fromArray;\nuint64 fromId;\nuint64 allDistinct;",
            locals: "uint64 scalar;\nPayload payload;\nArray<uint64, 4> values;\nid identity;\nid digest;\nuint64 i;",
            body: `
                locals.scalar = input.a;
                locals.digest = qpi.K12(locals.scalar);
                state.mut().fromScalar = locals.digest.u64._0;

                locals.payload.a = input.a;
                locals.payload.b = (uint32)input.b;
                locals.payload.c = (uint8)input.b;
                locals.digest = qpi.K12(locals.payload);
                state.mut().fromStruct = locals.digest.u64._0;

                for (locals.i = 0; locals.i < 4; locals.i++)
                {
                    locals.values.set(locals.i, input.a + locals.i);
                }
                locals.digest = qpi.K12(locals.values);
                state.mut().fromArray = locals.digest.u64._0;

                locals.identity = qpi.invocator();
                locals.digest = qpi.K12(locals.identity);
                state.mut().fromId = locals.digest.u64._0;

                state.mut().allDistinct =
                    state.get().fromScalar != state.get().fromStruct && state.get().fromStruct != state.get().fromArray ? 1 : 0;
            `,
            pairs: [
                [0n, 0n],
                [1n, 1n],
                [18446744073709551615n, 4294967295n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "HostK12ChainedDigests",
            family: "hostcalls",
            solidity: "openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol (processProof)",
            stresses:
                "a Merkle-style fold where each step hashes a struct holding the previous digest and the next leaf — the shape that produced F203, written the way that agrees",
        },
        () => ({
            extraStructs: "struct Node\n{\n    id left;\n    id right;\n};",
            state: "uint64 rootWord;\nuint64 steps;\nuint64 orderMattered;\nuint64 leafWord;",
            locals: "Node node;\nid running;\nid leaf;\nid swapped;\nuint64 i;\nuint64 seed;",
            body: `
                locals.seed = input.a;
                locals.running = qpi.K12(locals.seed);
                state.mut().leafWord = locals.running.u64._0;
                for (locals.i = 0; locals.i < 4; locals.i++)
                {
                    locals.seed = input.a + locals.i + 1;
                    locals.leaf = qpi.K12(locals.seed);
                    locals.node.left = locals.running;
                    locals.node.right = locals.leaf;
                    locals.running = qpi.K12(locals.node);
                    state.mut().steps++;
                }
                state.mut().rootWord = locals.running.u64._0;
                // The same two leaves in the other order must give a different root.
                locals.node.left = locals.leaf;
                locals.node.right = locals.running;
                locals.swapped = qpi.K12(locals.node);
                state.mut().orderMattered = locals.swapped == locals.running ? 0 : 1;
            `,
            pairs: [
                [0n, 0n],
                [7n, 0n],
                [18446744073709551615n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "HostK12ExpressionVersusVariable",
            family: "hostcalls",
            solidity: "openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol",
            stresses:
                "K12 of a computed expression next to K12 of a named local holding the same value — the exact pair F203 is about, kept as a live probe so a fix shows up here first",
            caveat: "The pair F203 was about, kept as a live probe. The expression spelling used to hash different bytes, because deduction typed no computed expression and sizeof(T) fell to 1. Deliberately never pinned with expectedVerdict — it was a defect to fix, not an asymmetry to document, and these rows went green when it was.",
        },
        () => ({
            state: "uint64 fromExpression;\nuint64 fromVariable;\nuint64 agree;",
            locals: "uint64 value;\nid fromExpr;\nid fromVar;",
            body: `
                locals.value = input.a + input.b;
                locals.fromExpr = qpi.K12(input.a + input.b);
                locals.fromVar = qpi.K12(locals.value);
                state.mut().fromExpression = locals.fromExpr.u64._0;
                state.mut().fromVariable = locals.fromVar.u64._0;
                state.mut().agree = locals.fromExpr == locals.fromVar ? 1 : 0;
            `,
            pairs: [
                [1n, 0n],
                [1n, 1n],
                [4294967296n, 1n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "HostFeeReserveQuery",
            family: "hostcalls",
            solidity: "no Solidity analogue (protocol fee reserve)",
            stresses:
                "qpi.queryFeeReserve for this contract and for a neighbouring slot — a uint32 argument and a sint64 answer, where an out-of-range slot must not read a neighbour's reserve",
        },
        () => ({
            state: "sint64 ownReserve;\nsint64 neighbourReserve;\nsint64 farReserve;\nuint64 negatives;",
            locals: "sint64 value;",
            body: `
                locals.value = qpi.queryFeeReserve(SELF_INDEX);
                state.mut().ownReserve = locals.value;
                locals.value = qpi.queryFeeReserve(SELF_INDEX - 1);
                state.mut().neighbourReserve = locals.value;
                locals.value = qpi.queryFeeReserve((uint32)QPI::mod(input.a, 1024ULL));
                state.mut().farReserve = locals.value;
                state.mut().negatives = state.get().ownReserve < 0 || state.get().neighbourReserve < 0 ? 1 : 0;
            `,
            pairs: [
                [0n, 0n],
                [1023n, 0n],
                [1024n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "HostIdWordAccessors",
            family: "hostcalls",
            solidity: "no Solidity analogue (32-byte identity words)",
            stresses: "all four 64-bit words of an id read individually and recombined — the accessor set every contract uses to derive a key from an identity",
        },
        () => ({
            state: "uint64 word0;\nuint64 word1;\nuint64 word2;\nuint64 word3;\nuint64 xorFold;",
            locals: "id value;",
            body: `
                locals.value = qpi.K12(input.a);
                state.mut().word0 = locals.value.u64._0;
                state.mut().word1 = locals.value.u64._1;
                state.mut().word2 = locals.value.u64._2;
                state.mut().word3 = locals.value.u64._3;
                state.mut().xorFold = locals.value.u64._0 ^ locals.value.u64._1 ^ locals.value.u64._2 ^ locals.value.u64._3;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [18446744073709551615n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "HostNullIdComparisons",
            family: "hostcalls",
            solidity: "test/libsolidity/semanticTests/various/address_zero.sol",
            stresses:
                "NULL_ID compared against SELF, against a derived id and against itself, with the results packed — the zero-address check every access guard opens with",
        },
        () => ({
            state: "uint64 nullIsNull;\nuint64 selfIsNull;\nuint64 derivedIsNull;\nuint64 packed;",
            locals: "id derived;\nid nothing;",
            body: `
                locals.nothing = NULL_ID;
                locals.derived = qpi.K12(input.a);
                state.mut().nullIsNull = locals.nothing == NULL_ID ? 1 : 0;
                state.mut().selfIsNull = SELF == NULL_ID ? 1 : 0;
                state.mut().derivedIsNull = locals.derived == NULL_ID ? 1 : 0;
                state.mut().packed = state.get().nullIsNull + state.get().selfIsNull * 2 + state.get().derivedIsNull * 4;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [18446744073709551615n, 0n],
            ],
            expect: [
                { pair: 0, values: [1n, 0n, 0n, 1n], note: "NULL_ID equals itself; neither SELF nor a K12 digest is null" },
                { pair: 1, values: [1n, 0n, 0n, 1n], note: "and again for a different seed" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "HostInvocationRewardAccumulation",
            family: "hostcalls",
            solidity: "test/libsolidity/semanticTests/various/payable_function.sol",
            stresses:
                "the invocation reward read twice in one call and accumulated across calls — the value must not change within a call and must match what the script attached",
        },
        () => ({
            state: "sint64 total;\nsint64 lastReward;\nuint64 stableWithinCall;\nuint64 calls2;",
            locals: "sint64 first;\nsint64 second;",
            body: `
                locals.first = qpi.invocationReward();
                locals.second = qpi.invocationReward();
                state.mut().lastReward = locals.first;
                state.mut().total += locals.first;
                state.mut().stableWithinCall = locals.first == locals.second ? 1 : 0;
                state.mut().calls2++;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [2n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "HostTickDerivedSeedQuality",
            family: "hostcalls",
            solidity: "not-so-smart-contracts/bad_randomness",
            stresses:
                "a seed built from the tick, the epoch and the spectrum digest, hashed and reduced — the shape a contract reaches for when it wants randomness, with the reduction bias measured",
        },
        () => ({
            extraStructs: "struct Seed\n{\n    uint64 tick;\n    uint64 epoch;\n    id digest;\n    uint64 nonce;\n};",
            state: "uint64 reduced;\nuint64 rawWord;\nuint64 inTopHalf;\nuint64 draws;",
            locals: "Seed seed;\nid hashed;",
            body: `
                locals.seed.tick = (uint64)qpi.tick();
                locals.seed.epoch = (uint64)qpi.epoch();
                locals.seed.digest = qpi.getPrevSpectrumDigest();
                locals.seed.nonce = input.a;
                locals.hashed = qpi.K12(locals.seed);
                state.mut().rawWord = locals.hashed.u64._0;
                state.mut().reduced = QPI::mod(locals.hashed.u64._0, 100ULL);
                state.mut().inTopHalf = locals.hashed.u64._0 > 9223372036854775807ULL ? 1 : 0;
                state.mut().draws++;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [2n, 0n],
                [3n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "HostEntityOfSelfAndCaller",
            family: "hostcalls",
            solidity: "test/libsolidity/semanticTests/various/balance.sol",
            stresses:
                "getEntity on SELF and on the caller in one procedure, with the two records' fields compared — the contract's own balance against the caller's",
        },
        () => ({
            state: "sint64 selfIncoming;\nsint64 callerIncoming;\nuint64 bothFound;\nuint64 selfHasMore;",
            locals: "Entity own;\nEntity caller;\nbit foundOwn;\nbit foundCaller;",
            body: `
                locals.foundOwn = qpi.getEntity(SELF, locals.own);
                locals.foundCaller = qpi.getEntity(qpi.invocator(), locals.caller);
                state.mut().selfIncoming = locals.foundOwn ? locals.own.incomingAmount : -1;
                state.mut().callerIncoming = locals.foundCaller ? locals.caller.incomingAmount : -1;
                state.mut().bothFound = locals.foundOwn && locals.foundCaller ? 1 : 0;
                state.mut().selfHasMore = state.get().selfIncoming > state.get().callerIncoming ? 1 : 0;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "HostAssetIssuedProbe",
            family: "hostcalls",
            solidity: "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol",
            stresses:
                "isAssetIssued for a name this contract never issued, for one it did, and for the null issuer — a bool host call whose three answers the contract stores",
        },
        () => ({
            state: "uint64 beforeIssue;\nuint64 afterIssue;\nuint64 nullIssuer;\nsint64 issueResult;",
            locals: "uint64 name;\nsint64 result;",
            body: `
                locals.name = 5525825;
                state.mut().beforeIssue = qpi.isAssetIssued(SELF, locals.name) ? 1 : 0;
                locals.result = qpi.issueAsset(locals.name, SELF, 0, (sint64)input.a, 0);
                state.mut().issueResult = locals.result;
                state.mut().afterIssue = qpi.isAssetIssued(SELF, locals.name) ? 1 : 0;
                state.mut().nullIssuer = qpi.isAssetIssued(NULL_ID, locals.name) ? 1 : 0;
            `,
            pairs: [
                [0n, 0n],
                [1000n, 0n],
                [1000n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "HostTwoTransfersInOneCall",
            family: "hostcalls",
            solidity: "test/libsolidity/semanticTests/various/send_ether.sol",
            stresses:
                "two transfers in one procedure, where the second sees whatever balance the first left — the returned remaining amounts have to decrease in step",
            caveat: "The typed transfer (`__transfer`) is not reachable from a contract: QPI's source policy forbids double-underscore names, and both backends refuse it. So this archetype uses the plain call twice.",
        },
        () => ({
            state: "sint64 plainResult;\nsint64 secondResult;\nuint64 bothSucceeded;\nsint64 rewardSeen;",
            locals: "id target;\nsint64 amount;",
            body: `
                state.mut().rewardSeen += qpi.invocationReward();
                locals.target = qpi.K12(input.a);
                locals.amount = (sint64)QPI::mod(input.b, 1000ULL);
                state.mut().plainResult = qpi.transfer(locals.target, locals.amount);
                state.mut().secondResult = qpi.transfer(locals.target, locals.amount);
                state.mut().bothSucceeded = state.get().plainResult >= 0 && state.get().secondResult >= 0 ? 1 : 0;
            `,
            pairs: [
                [1n, 0n],
                [1n, 10n],
                [2n, 999n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "HostSelfWordDirectRead",
            family: "hostcalls",
            solidity: "test/libsolidity/semanticTests/various/address_to_uint.sol",
            stresses:
                "reading a 64-bit word out of the SELF identity — directly, which the TypeScript backend refuses, and through a local copy, which it accepts",
            caveat: "Both spellings read the contract's own index and both backends agree. The direct one used to be refused — selecting a member of a class prvalue materialises a temporary, and SELF expands to id(...), which matched no branch (F215).",
            axes: ["placement"],
        },
        () => ({
            state: "uint64 direct;\nuint64 viaLocal;\nuint64 equal;",
            locals: "id copy;",
            body: `
                locals.copy = SELF;
                state.mut().viaLocal = locals.copy.u64._0;
                state.mut().direct = SELF.u64._0;
                state.mut().equal = state.get().direct == state.get().viaLocal ? 1 : 0;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
            ],
        }),
    ),
];
