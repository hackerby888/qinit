// Data structures built on top of the QPI containers, ported from OpenZeppelin's `utils/structs/*`.

import { singleProcedureArchetype } from "./common";
import { capacityOf, fillCount } from "../axes";
import { u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const OZ = "OpenZeppelin utils/structs";

function drivePairs(pairs: [bigint, bigint][]): CallStep[] {
    const steps: CallStep[] = [];
    for (const [a, b] of pairs) {
        steps.push({ kind: "procedure", entry: 1, in: u64(a) + u64(b), invocator: 0, note: `${a}, ${b}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

export const CONTAINER_STRUCTURE_ARCHETYPES: Archetype[] = [
    singleProcedureArchetype(
        {
            name: "SetSwapPopIndexBookkeeping",
            family: "containers",
            solidity: `${OZ}/EnumerableSet.sol` + " (`_removeValueAt`)",
            stresses: "remove-by-swap-with-last: the moved element's stored index must be rewritten, and removing the last element must not move anything",
            caveat: "OpenZeppelin stores position+1 so that 0 means absent; QPI's HashMap leaves the out-param untouched on a miss, so the port keeps the +1 convention and pre-zeroes every read.",
            axes: ["capacity", "fill", "placement"],
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            const fill = fillCount(axis, capacity);
            return {
                extraState: `Array<uint64, ${capacity}> values;\nHashMap<uint64, uint64, ${capacity}> positions;\nuint64 length;\nuint64 corrupted;`,
                input: "uint64 count;\nuint64 removeAt;",
                locals: "uint64 i;\nuint64 bound;\nuint64 last;\nuint64 moved;\nuint64 stored;\nuint64 mismatches;",
                body: `
                    locals.bound = input.count;
                    if (locals.bound > ${capacity})
                    {
                        locals.bound = ${capacity};
                    }
                    state.mut().positions.reset();
                    state.mut().length = 0;
                    for (locals.i = 0; locals.i < locals.bound; locals.i++)
                    {
                        state.mut().values.set(locals.i, locals.i + 1000);
                        state.mut().positions.set(locals.i + 1000, locals.i + 1);
                        state.mut().length++;
                    }
                    if (state.get().length > 0 && input.removeAt < state.get().length)
                    {
                        locals.last = state.get().length - 1;
                        locals.moved = state.get().values.get(locals.last);
                        state.mut().values.set(input.removeAt, locals.moved);
                        state.mut().positions.set(locals.moved, input.removeAt + 1);
                        state.mut().length--;
                    }
                    // Every surviving element's recorded position must match where it actually sits.
                    locals.mismatches = 0;
                    for (locals.i = 0; locals.i < state.get().length; locals.i++)
                    {
                        locals.stored = 0;
                        state.get().positions.get(state.get().values.get(locals.i), locals.stored);
                        if (locals.stored != locals.i + 1)
                        {
                            locals.mismatches++;
                        }
                    }
                    state.mut().corrupted = locals.mismatches;
                    state.mut().accumulator = state.get().length * 1000 + locals.mismatches;
                `,
                steps: drivePairs([
                    [BigInt(fill), 0n],
                    [BigInt(capacity), 0n],
                    [BigInt(capacity), BigInt(capacity - 1)],
                    [BigInt(capacity), BigInt(capacity)],
                    [0n, 0n],
                ]),
            };
        },
    ),

    singleProcedureArchetype(
        {
            name: "HeapSiftUpDownIterative",
            family: "containers",
            solidity: `${OZ}/Heap.sol`,
            stresses: "parent `(i-1)/2` and children `2i+1` / `2i+2` index arithmetic through QPI::div, with the sift loops written iteratively",
            caveat: "OpenZeppelin's sift is recursive; QPI forbids recursion, so both directions are bounded loops. That rewrite is part of what is under test.",
            axes: ["capacity", "loopShape", "placement"],
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            return {
                extraState: `Array<uint64, ${capacity}> heap;\nuint64 size;\nuint64 violations;\nuint64 root;`,
                input: "uint64 count;\nuint64 seed;",
                locals: "uint64 i;\nuint64 bound;\nuint64 child;\nuint64 parent;\nuint64 swap;\nuint64 bad;",
                body: `
                    locals.bound = input.count;
                    if (locals.bound > ${capacity})
                    {
                        locals.bound = ${capacity};
                    }
                    state.mut().size = 0;
                    for (locals.i = 0; locals.i < locals.bound; locals.i++)
                    {
                        // Insert at the end, then sift up.
                        state.mut().heap.set(state.get().size, QPI::mod(input.seed + locals.i * 37, 1000ULL));
                        state.mut().size++;
                        locals.child = state.get().size - 1;
                        while (locals.child > 0)
                        {
                            locals.parent = QPI::div(locals.child - 1, 2ULL);
                            if (state.get().heap.get(locals.parent) <= state.get().heap.get(locals.child))
                            {
                                break;
                            }
                            locals.swap = state.get().heap.get(locals.parent);
                            state.mut().heap.set(locals.parent, state.get().heap.get(locals.child));
                            state.mut().heap.set(locals.child, locals.swap);
                            locals.child = locals.parent;
                        }
                    }
                    // The heap property is the assertion: no parent may exceed a child.
                    locals.bad = 0;
                    for (locals.i = 1; locals.i < state.get().size; locals.i++)
                    {
                        locals.parent = QPI::div(locals.i - 1, 2ULL);
                        if (state.get().heap.get(locals.parent) > state.get().heap.get(locals.i))
                        {
                            locals.bad++;
                        }
                    }
                    state.mut().violations = locals.bad;
                    state.mut().root = state.get().size > 0 ? state.get().heap.get(0) : 0;
                    state.mut().accumulator = state.get().root * 100 + locals.bad;
                `,
                steps: drivePairs([
                    [BigInt(capacity), 7n],
                    [BigInt(capacity), 0n],
                    [1n, 5n],
                    [0n, 5n],
                    [BigInt(capacity * 2), 13n],
                ]),
            };
        },
    ),

    singleProcedureArchetype(
        {
            name: "CircularBufferWrapIndex",
            family: "containers",
            solidity: `${OZ}/CircularBuffer.sol`,
            stresses: "`count % length` as the write cursor — with a power-of-two capacity this is exactly QPI's Array mask, so the two spellings must agree at and past the wrap",
            axes: ["capacity", "fill", "placement", "loopShape"],
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            return {
                extraState: `Array<uint64, ${capacity}> ring;\nuint64 count;\nuint64 viaMod;\nuint64 viaMask;\nuint64 disagreements;`,
                input: "uint64 pushes;\nuint64 seed;",
                locals: "uint64 i;\nuint64 bound;\nuint64 slotMod;\nuint64 slotMask;",
                body: `
                    locals.bound = input.pushes;
                    if (locals.bound > 64)
                    {
                        locals.bound = 64;
                    }
                    for (locals.i = 0; locals.i < locals.bound; locals.i++)
                    {
                        locals.slotMod = QPI::mod(state.get().count, ${capacity}ULL);
                        locals.slotMask = state.get().count & (${capacity} - 1);
                        if (locals.slotMod != locals.slotMask)
                        {
                            state.mut().disagreements++;
                        }
                        state.mut().ring.set(locals.slotMod, input.seed + locals.i);
                        state.mut().count++;
                    }
                    state.mut().viaMod = QPI::mod(state.get().count, ${capacity}ULL);
                    state.mut().viaMask = state.get().count & (${capacity} - 1);
                    state.mut().accumulator = state.get().count;
                `,
                steps: drivePairs([
                    [1n, 5n],
                    [BigInt(capacity), 5n],
                    [BigInt(capacity + 3), 5n],
                    [64n, 1n],
                ]),
            };
        },
    ),

    singleProcedureArchetype(
        {
            name: "CheckpointBinarySearch",
            family: "containers",
            solidity: `${OZ}/Checkpoints.sol` + " (`_upperBinaryLookup`)",
            stresses: "a bisection whose midpoint uses the overflow-free average, against a linear scan over the same array — the two must agree on every key, including duplicates and both ends",
            axes: ["capacity", "placement", "loopShape"],
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            return {
                extraState: `Array<uint64, ${capacity}> keys;\nuint64 length;\nuint64 viaBisect;\nuint64 viaScan;\nuint64 disagreements;`,
                input: "uint64 count;\nuint64 needle;",
                locals: "uint64 i;\nuint64 bound;\nuint64 low;\nuint64 high;\nuint64 mid;\nuint64 scan;",
                body: `
                    locals.bound = input.count;
                    if (locals.bound > ${capacity})
                    {
                        locals.bound = ${capacity};
                    }
                    state.mut().length = locals.bound;
                    for (locals.i = 0; locals.i < locals.bound; locals.i++)
                    {
                        // Non-decreasing with a deliberate duplicate, which is where a bisection's
                        // boundary condition usually goes wrong.
                        state.mut().keys.set(locals.i, QPI::div(locals.i, 2ULL) * 10);
                    }
                    locals.low = 0;
                    locals.high = state.get().length;
                    while (locals.low < locals.high)
                    {
                        locals.mid = (locals.low & locals.high) + ((locals.low ^ locals.high) >> 1);
                        if (state.get().keys.get(locals.mid) > input.needle)
                        {
                            locals.high = locals.mid;
                        }
                        else
                        {
                            locals.low = locals.mid + 1;
                        }
                    }
                    state.mut().viaBisect = locals.low;
                    locals.scan = 0;
                    for (locals.i = 0; locals.i < state.get().length; locals.i++)
                    {
                        if (state.get().keys.get(locals.i) <= input.needle)
                        {
                            locals.scan = locals.i + 1;
                        }
                    }
                    state.mut().viaScan = locals.scan;
                    if (locals.low != locals.scan)
                    {
                        state.mut().disagreements++;
                    }
                    state.mut().accumulator = locals.low * 1000 + locals.scan;
                `,
                steps: drivePairs([
                    [BigInt(capacity), 0n],
                    [BigInt(capacity), 10n],
                    [BigInt(capacity), 1000n],
                    [1n, 0n],
                    [0n, 5n],
                ]),
            };
        },
    ),

    singleProcedureArchetype(
        {
            name: "MerkleProofIterativeVerify",
            family: "containers",
            solidity: "OpenZeppelin utils/cryptography/MerkleProof.sol (`processProof`)",
            stresses: "a fixed-depth fold over an Array<id,N> with a commutative pair hash — the branch that decides operand order is the whole correctness argument",
            caveat: "keccak256 becomes qpi.K12; the proof depth is fixed rather than dynamic.",
            axes: ["capacity", "placement", "loopShape"],
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            return {
                extraState: `Array<id, ${capacity}> proof;\nid root;\nid leaf;\nuint64 depth;`,
                input: "uint64 depth;\nuint64 seed;",
                locals: "uint64 i;\nuint64 bound;\nid running;\nid sibling;\nPair pair;\nuint64 seedSlot;",
                prelude: "struct Pair\n{\n    id left;\n    id right;\n};",
                body: `
                    locals.bound = input.depth;
                    if (locals.bound > ${capacity})
                    {
                        locals.bound = ${capacity};
                    }
                    state.mut().depth = locals.bound;
                    for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                    {
                        // Hashed through a named local: qpi.K12 of a computed expression is F203.
                        locals.seedSlot = input.seed + locals.i;
                        state.mut().proof.set(locals.i, qpi.K12(locals.seedSlot));
                    }
                    locals.running = qpi.K12(input.seed);
                    state.mut().leaf = locals.running;
                    for (locals.i = 0; locals.i < locals.bound; locals.i++)
                    {
                        locals.sibling = state.get().proof.get(locals.i);
                        // Commutative: order the pair so the same set of siblings gives one root.
                        if (locals.running < locals.sibling)
                        {
                            locals.pair.left = locals.running;
                            locals.pair.right = locals.sibling;
                        }
                        else
                        {
                            locals.pair.left = locals.sibling;
                            locals.pair.right = locals.running;
                        }
                        locals.running = qpi.K12(locals.pair);
                    }
                    state.mut().root = locals.running;
                    state.mut().accumulator = locals.bound;
                `,
                steps: drivePairs([
                    [0n, 1n],
                    [1n, 1n],
                    [BigInt(capacity), 1n],
                    [BigInt(capacity + 4), 9n],
                ]),
            };
        },
    ),

    singleProcedureArchetype(
        {
            name: "DequeBeginEndAmbiguity",
            family: "containers",
            solidity: `${OZ}/DoubleEndedQueue.sol`,
            stresses: "front and back cursors into a ring: empty and full are the same cursor relationship, so the port has to carry a count as well",
            caveat: "OpenZeppelin uses uint128 cursors and reverts on an empty pop; the port uses uint32 indices and returns a flag, since QPI has no revert.",
            axes: ["capacity", "fill", "placement"],
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            return {
                extraState: `Array<uint64, ${capacity}> items;\nuint32 begin;\nuint32 end;\nuint64 size;\nuint64 emptyPops;\nuint64 overflowPushes;`,
                input: "uint64 pushes;\nuint64 pops;",
                locals: "uint64 i;\nuint64 bound;",
                body: `
                    locals.bound = input.pushes;
                    if (locals.bound > 64)
                    {
                        locals.bound = 64;
                    }
                    for (locals.i = 0; locals.i < locals.bound; locals.i++)
                    {
                        if (state.get().size == ${capacity})
                        {
                            state.mut().overflowPushes++;
                        }
                        else
                        {
                            state.mut().items.set(state.get().end, locals.i + 1);
                            state.mut().end = (uint32)((state.get().end + 1) & (${capacity} - 1));
                            state.mut().size++;
                        }
                    }
                    locals.bound = input.pops;
                    if (locals.bound > 64)
                    {
                        locals.bound = 64;
                    }
                    for (locals.i = 0; locals.i < locals.bound; locals.i++)
                    {
                        if (state.get().size == 0)
                        {
                            state.mut().emptyPops++;
                        }
                        else
                        {
                            state.mut().begin = (uint32)((state.get().begin + 1) & (${capacity} - 1));
                            state.mut().size--;
                        }
                    }
                    state.mut().accumulator = state.get().size * 1000 + state.get().emptyPops * 10 + state.get().overflowPushes;
                `,
                steps: drivePairs([
                    [1n, 0n],
                    [BigInt(capacity), 0n],
                    [BigInt(capacity), BigInt(capacity)],
                    [0n, 3n],
                    [BigInt(capacity + 5), 2n],
                ]),
            };
        },
    ),

    singleProcedureArchetype(
        {
            name: "MapZeroValueVersusAbsent",
            family: "containers",
            solidity: "test/libsolidity/semanticTests/storage/mapping_state.sol",
            stresses: "distinguishing a stored zero from an absent key — Solidity's mapping cannot, so the port pairs a HashMap with a HashSet and checks the two agree",
            caveat: "This is the sharpest Solidity/QPI semantic gap in the container family: `HashMap::get` reports presence through its return value, which a Solidity mapping has no equivalent for.",
            axes: ["capacity", "fill", "placement", "temporaries"],
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            const fill = fillCount(axis, capacity);
            return {
                extraState: `HashMap<uint64, uint64, ${capacity}> values;\nHashSet<uint64, ${capacity}> present;\nuint64 storedZeros;\nuint64 absent;\nuint64 disagreements;`,
                input: "uint64 count;\nuint64 probe;",
                locals: "uint64 i;\nuint64 bound;\nuint64 fetched;\nuint64 hit;\nuint64 inSet;",
                body: `
                    locals.bound = input.count;
                    if (locals.bound > ${capacity})
                    {
                        locals.bound = ${capacity};
                    }
                    state.mut().values.reset();
                    state.mut().present.reset();
                    state.mut().storedZeros = 0;
                    state.mut().absent = 0;
                    for (locals.i = 0; locals.i < locals.bound; locals.i++)
                    {
                        // Every other key stores a deliberate zero.
                        state.mut().values.set(locals.i, QPI::mod(locals.i, 2ULL) == 0 ? 0 : locals.i);
                        state.mut().present.add(locals.i);
                    }
                    for (locals.i = 0; locals.i < ${capacity} + 2; locals.i++)
                    {
                        locals.fetched = 0;
                        locals.hit = state.get().values.get(locals.i, locals.fetched) ? 1 : 0;
                        locals.inSet = state.get().present.contains(locals.i) ? 1 : 0;
                        if (locals.hit != locals.inSet)
                        {
                            state.mut().disagreements++;
                        }
                        if (locals.hit == 1 && locals.fetched == 0)
                        {
                            state.mut().storedZeros++;
                        }
                        if (locals.hit == 0)
                        {
                            state.mut().absent++;
                        }
                    }
                    state.mut().accumulator = state.get().storedZeros * 1000 + state.get().absent;
                `,
                steps: drivePairs([
                    [BigInt(fill), 0n],
                    [BigInt(capacity), 0n],
                    [0n, 0n],
                    [BigInt(capacity + 4), 1n],
                ]),
            };
        },
    ),
];
