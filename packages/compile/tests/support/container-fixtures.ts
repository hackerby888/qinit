import type { ContainerFixture, ContainerOperation } from "./container-harness";

const boundary = (...operations: ContainerOperation[]): ContainerOperation[] => operations;

function contract(
  name: string,
  family: string,
  stateFields: string,
  localsFields: string,
  body: string,
  operations: ContainerOperation[],
): ContainerFixture {
  return {
    name,
    family,
    boundary: operations,
    source: `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  ${stateFields}
  struct Run_input { uint64 op; uint64 a; uint64 b; uint64 c; uint64 d; uint64 e; };
  struct Run_output { uint64 r0; uint64 r1; uint64 r2; uint64 r3; };
  struct Run_locals { ${localsFields} };
  PUBLIC_PROCEDURE_WITH_LOCALS(Run) {
    state.mut().r0 = 0; state.mut().r1 = 0; state.mut().r2 = 0; state.mut().r3 = 0;
    ${body}
    state.mut().step += 1;
    output.r0 = state.get().r0; output.r1 = state.get().r1;
    output.r2 = state.get().r2; output.r3 = state.get().r3;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Run, 1); }
};`,
  };
}

const arrayFixture = contract(
  "ArrayParity",
  "Array",
  `struct Pair { uint64 first; uint64 second; };
  struct StateData {
    Array<uint64, 8> values;
    Array<uint64, 8> copy;
    Array<Pair, 4> pairs;
    Array<uint64, 1> memory;
    uint64 rawMemory;
    uint64 step; uint64 r0; uint64 r1; uint64 r2; uint64 r3;
  };`,
  "Pair pair;",
  `if (input.op == 0) {
      state.mut().values.setAll(input.a);
      state.mut().r0 = state.get().values.capacity();
      state.mut().r1 = state.get().values.get(0);
      state.mut().r2 = state.get().values.get(7);
    } else if (input.op == 1) {
      state.mut().values.set(input.a, input.b);
      state.mut().r0 = state.get().values.get(input.a);
      state.mut().r1 = state.get().values.get(input.a & 7);
    } else if (input.op == 2) {
      state.mut().values.setRange(input.a, input.b, input.c);
      state.mut().r0 = state.get().values.get(0);
      state.mut().r1 = state.get().values.get(7);
    } else if (input.op == 3) {
      state.mut().r0 = state.get().values.rangeEquals(input.a, input.b, input.c) ? 1 : 0;
    } else if (input.op == 4) {
      state.mut().rawMemory = input.a;
      state.mut().memory.setMem(state.get().rawMemory);
      state.mut().r0 = state.get().memory.get(0);
    } else if (input.op == 5) {
      locals.pair.first = input.b; locals.pair.second = input.c;
      state.mut().pairs.set(input.a, locals.pair);
      state.mut().r0 = state.get().pairs.get(input.a).first;
      state.mut().r1 = state.get().pairs.get(input.a).second;
    } else if (input.op == 6) {
      state.mut().copy = state.get().values;
      state.mut().r0 = state.get().copy.get(0); state.mut().r1 = state.get().copy.get(7);
    } else {
      Array<uint64, 8> copied = state.get().values;
      state.mut().copy = copied;
      state.mut().r0 = state.get().copy.rangeEquals(0, 8, input.a) ? 1 : 0;
    }`,
  boundary(
    { operator: 0n, a: 9n },
    { operator: 1n, a: 8n, b: 17n },
    { operator: 1n, a: 15n, b: 23n },
    { operator: 2n, a: 2n, b: 5n, c: 44n },
    { operator: 2n, a: 4n, b: 4n, c: 88n },
    { operator: 3n, a: 2n, b: 5n, c: 44n },
    { operator: 3n, a: 5n, b: 2n, c: 44n },
    { operator: 3n, a: 0n, b: 9n, c: 0n },
    { operator: 4n, a: 1n, b: 2n, c: 3n, d: 4n },
    { operator: 5n, a: 5n, b: 55n, c: 66n },
    { operator: 6n },
    { operator: 7n, a: 9n },
  ),
);

const bitArrayFixture = contract(
  "BitArrayParity",
  "BitArray",
  `struct StateData {
    BitArray<2> b2; BitArray<64> b64; BitArray<128> b128; BitArray<128> other128; bit_4096 b4096;
    uint64 memory;
    uint64 step; uint64 r0; uint64 r1; uint64 r2; uint64 r3;
  };`,
  "uint64 unused;",
  `if (input.op == 0) {
      state.mut().b2.set(input.a, input.b ? 1 : 0);
      state.mut().r0 = state.get().b2.get(input.a) ? 1 : 0; state.mut().r1 = state.get().b2.capacity();
    } else if (input.op == 1) {
      state.mut().b64.set(input.a, input.b ? 1 : 0);
      state.mut().r0 = state.get().b64.get(input.a) ? 1 : 0; state.mut().r1 = state.get().b64.capacity();
    } else if (input.op == 2) {
      state.mut().b128.set(input.a, input.b ? 1 : 0);
      state.mut().r0 = state.get().b128.get(input.a) ? 1 : 0; state.mut().r1 = state.get().b128.capacity();
    } else if (input.op == 3) {
      state.mut().b4096.set(input.a, input.b ? 1 : 0);
      state.mut().r0 = state.get().b4096.get(input.a) ? 1 : 0; state.mut().r1 = state.get().b4096.capacity();
    } else if (input.op == 4) {
      state.mut().b128.setAll(input.a ? 1 : 0);
      state.mut().r0 = state.get().b128.get(0) ? 1 : 0; state.mut().r1 = state.get().b128.get(127) ? 1 : 0;
    } else if (input.op == 5) {
      state.mut().memory = input.a; state.mut().b64.setMem(state.get().memory);
      state.mut().r0 = state.get().b64.get(0) ? 1 : 0; state.mut().r1 = state.get().b64.get(63) ? 1 : 0;
    } else if (input.op == 6) {
      state.mut().other128.setAll(input.a ? 1 : 0);
      state.mut().r0 = state.get().b128 == state.get().other128 ? 1 : 0;
      state.mut().r1 = state.get().b128 != state.get().other128 ? 1 : 0;
    } else {
      state.mut().b4096.setAll(input.a ? 1 : 0);
      state.mut().r0 = state.get().b4096.get(63) ? 1 : 0;
      state.mut().r1 = state.get().b4096.get(64) ? 1 : 0;
      state.mut().r2 = state.get().b4096.get(4095) ? 1 : 0;
    }`,
  boundary(
    { operator: 0n, a: 0n, b: 1n },
    { operator: 0n, a: 2n, b: 1n },
    { operator: 1n, a: 63n, b: 1n },
    { operator: 1n, a: 64n, b: 1n },
    { operator: 2n, a: 63n, b: 1n },
    { operator: 2n, a: 64n, b: 1n },
    { operator: 2n, a: 127n, b: 1n },
    { operator: 3n, a: 4095n, b: 1n },
    { operator: 3n, a: 4096n, b: 1n },
    { operator: 4n, a: 1n },
    { operator: 6n, a: 1n },
    { operator: 4n, a: 0n },
    { operator: 6n, a: 1n },
    { operator: 5n, a: 0x8000000000000001n },
    { operator: 7n, a: 1n },
  ),
);

const hashMapFixture = contract(
  "HashMapParity",
  "HashMap",
  `struct WrapHash { static uint64 hash(const uint64& key) { return key & 15; } };
  struct StateData {
    HashMap<uint64, uint64, 16, WrapHash> map;
    uint64 step; uint64 r0; uint64 r1; uint64 r2; uint64 r3;
  };`,
  "uint64 value; sint64 index;",
  `if (input.op == 0) {
      locals.index = state.mut().map.set(input.a, input.b);
      state.mut().r0 = locals.index; state.mut().r1 = state.get().map.population();
    } else if (input.op == 1) {
      locals.value = 0; state.mut().r0 = state.get().map.get(input.a, locals.value) ? 1 : 0;
      state.mut().r1 = locals.value; state.mut().r2 = state.get().map.contains(input.a) ? 1 : 0;
    } else if (input.op == 2) {
      state.mut().r0 = state.get().map.getElementIndex(input.a);
    } else if (input.op == 3) {
      state.mut().r0 = state.mut().map.replace(input.a, input.b) ? 1 : 0;
    } else if (input.op == 4) {
      state.mut().r0 = state.mut().map.removeByKey(input.a); state.mut().r1 = state.get().map.population();
    } else if (input.op == 5) {
      state.mut().map.removeByIndex((sint64)input.a); state.mut().r0 = state.get().map.population();
    } else if (input.op == 6) {
      locals.index = state.get().map.nextElementIndex((sint64)input.a);
      state.mut().r0 = locals.index;
      if (locals.index >= 0) { state.mut().r1 = state.get().map.key(locals.index); state.mut().r2 = state.get().map.value(locals.index); }
    } else if (input.op == 7) {
      state.mut().r0 = state.get().map.isEmptySlot((sint64)input.a) ? 1 : 0;
    } else if (input.op == 8) {
      state.mut().r0 = state.get().map.needsCleanup(input.a) ? 1 : 0;
    } else if (input.op == 9) {
      state.mut().map.cleanupIfNeeded(input.a); state.mut().r0 = state.get().map.population();
    } else if (input.op == 10) {
      state.mut().map.cleanup(); state.mut().r0 = state.get().map.population();
    } else if (input.op == 11) {
      state.mut().map.reset(); state.mut().r0 = state.get().map.population();
    } else {
      state.mut().r0 = state.get().map.capacity(); state.mut().r1 = state.get().map.population();
    }`,
  boundary(
    { operator: 12n },
    { operator: 1n, a: 999n },
    { operator: 0n, a: 15n, b: 10n },
    { operator: 0n, a: 31n, b: 20n },
    { operator: 0n, a: 47n, b: 30n },
    { operator: 0n, a: 31n, b: 22n },
    { operator: 1n, a: 31n },
    { operator: 2n, a: 47n },
    ...Array.from({ length: 13 }, (_, index) => ({
      operator: 0n,
      a: BigInt(index + 100),
      b: BigInt(index),
    })),
    { operator: 0n, a: 999n, b: 1n },
    { operator: 7n, a: 99n },
    { operator: 5n, a: 99n },
    { operator: 4n, a: 15n },
    { operator: 0n, a: 63n, b: 40n },
    { operator: 8n, a: 1n },
    { operator: 9n, a: 1n },
    { operator: 6n, a: 0xffffffffffffffffn },
    { operator: 10n },
    { operator: 11n },
  ),
);

const hashSetFixture = contract(
  "HashSetParity",
  "HashSet",
  `struct WrapHash { static uint64 hash(const uint64& key) { return key & 15; } };
  struct StateData {
    HashSet<uint64, 16, WrapHash> set;
    uint64 step; uint64 r0; uint64 r1; uint64 r2; uint64 r3;
  };`,
  "sint64 index;",
  `if (input.op == 0) {
      locals.index = state.mut().set.add(input.a); state.mut().r0 = locals.index; state.mut().r1 = state.get().set.population();
    } else if (input.op == 1) {
      state.mut().r0 = state.get().set.contains(input.a) ? 1 : 0; state.mut().r1 = state.get().set.getElementIndex(input.a);
    } else if (input.op == 2) {
      state.mut().r0 = state.mut().set.remove(input.a); state.mut().r1 = state.get().set.population();
    } else if (input.op == 3) {
      state.mut().set.removeByIndex((sint64)input.a); state.mut().r0 = state.get().set.population();
    } else if (input.op == 4) {
      locals.index = state.get().set.nextElementIndex((sint64)input.a); state.mut().r0 = locals.index;
      if (locals.index >= 0) state.mut().r1 = state.get().set.key(locals.index);
    } else if (input.op == 5) {
      state.mut().r0 = state.get().set.isEmptySlot((sint64)input.a) ? 1 : 0;
    } else if (input.op == 6) {
      state.mut().r0 = state.get().set.needsCleanup(input.a) ? 1 : 0;
    } else if (input.op == 7) {
      state.mut().set.cleanupIfNeeded(input.a); state.mut().r0 = state.get().set.population();
    } else if (input.op == 8) {
      state.mut().set.cleanup(); state.mut().r0 = state.get().set.population();
    } else if (input.op == 9) {
      state.mut().set.reset(); state.mut().r0 = state.get().set.population();
    } else if (input.op == 10) {
      state.mut().r0 = state.get().set.capacity(); state.mut().r1 = state.get().set.population();
    } else {
      state.mut().r0 = state.mut().set.add(input.a); state.mut().r1 = state.mut().set.add(input.a);
    }`,
  boundary(
    { operator: 10n },
    { operator: 1n, a: 999n },
    { operator: 11n, a: 15n },
    { operator: 0n, a: 31n },
    { operator: 0n, a: 47n },
    ...Array.from({ length: 13 }, (_, index) => ({ operator: 0n, a: BigInt(index + 100) })),
    { operator: 0n, a: 999n },
    { operator: 5n, a: 99n },
    { operator: 3n, a: 99n },
    { operator: 2n, a: 15n },
    { operator: 0n, a: 63n },
    { operator: 6n, a: 1n },
    { operator: 7n, a: 1n },
    { operator: 4n, a: 0xffffffffffffffffn },
    { operator: 8n },
    { operator: 9n },
  ),
);

const collectionFixture = contract(
  "CollectionParity",
  "Collection",
  `struct StateData {
    Collection<uint64, 16> collection;
    Collection<uint64, 64> rebuild;
    uint64 step; uint64 r0; uint64 r1; uint64 r2; uint64 r3;
  };`,
  "id pov; sint64 index; uint64 count; uint64 chain; uint64 i;",
  `locals.pov = id(input.a, 0, 0, 0);
    if (input.op == 0) {
      state.mut().r0 = state.mut().collection.add(locals.pov, input.b, (sint64)input.c);
      state.mut().r1 = state.get().collection.population(); state.mut().r2 = state.get().collection.population(locals.pov);
    } else if (input.op == 1) {
      state.mut().r0 = state.mut().collection.remove((sint64)input.a); state.mut().r1 = state.get().collection.population();
    } else if (input.op == 2) {
      state.mut().collection.replace((sint64)input.a, input.b); state.mut().r0 = state.get().collection.population();
    } else if (input.op == 3) {
      state.mut().r0 = state.get().collection.headIndex(locals.pov); state.mut().r1 = state.get().collection.headIndex(locals.pov, (sint64)input.b);
      state.mut().r2 = state.get().collection.tailIndex(locals.pov); state.mut().r3 = state.get().collection.tailIndex(locals.pov, (sint64)input.c);
    } else if (input.op == 4) {
      state.mut().r0 = state.get().collection.nextElementIndex((sint64)input.a); state.mut().r1 = state.get().collection.prevElementIndex((sint64)input.a);
    } else if (input.op == 5) {
      state.mut().r0 = state.get().collection.element((sint64)input.a); state.mut().r1 = state.get().collection.priority((sint64)input.a);
      locals.pov = state.get().collection.pov((sint64)input.a); state.mut().r2 = locals.pov.u64._0;
    } else if (input.op == 6) {
      locals.index = state.get().collection.headIndex(locals.pov); locals.count = 0; locals.chain = 0;
      while (locals.index >= 0 && locals.count < 16) {
        locals.chain = locals.chain * 131 + state.get().collection.element(locals.index);
        locals.count += 1; locals.index = state.get().collection.nextElementIndex(locals.index);
      }
      state.mut().r0 = locals.count; state.mut().r1 = locals.chain;
    } else if (input.op == 7) {
      locals.index = state.get().collection.tailIndex(locals.pov); locals.count = 0; locals.chain = 0;
      while (locals.index >= 0 && locals.count < 16) {
        locals.chain = locals.chain * 131 + state.get().collection.element(locals.index);
        locals.count += 1; locals.index = state.get().collection.prevElementIndex(locals.index);
      }
      state.mut().r0 = locals.count; state.mut().r1 = locals.chain;
    } else if (input.op == 8) {
      state.mut().r0 = state.get().collection.needsCleanup(input.a) ? 1 : 0;
    } else if (input.op == 9) {
      state.mut().collection.cleanupIfNeeded(input.a); state.mut().r0 = state.get().collection.population();
    } else if (input.op == 10) {
      state.mut().collection.cleanup(); state.mut().r0 = state.get().collection.population();
    } else if (input.op == 11) {
      state.mut().collection.reset(); state.mut().r0 = state.get().collection.population(); state.mut().r1 = state.get().collection.capacity();
    } else {
      state.mut().rebuild.reset();
      for (locals.i = 0; locals.i < input.a; locals.i += 1) {
        state.mut().rebuild.add(locals.pov, locals.i * 7, (sint64)locals.i);
      }
      state.mut().r0 = state.get().rebuild.population();
    }`,
  boundary(
    { operator: 11n },
    { operator: 0n, a: 1n, b: 0x9358942en, c: 5n },
    { operator: 0n, a: 1n, b: 20n, c: 5n },
    { operator: 0n, a: 1n, b: 30n, c: 0xffffffffffffffffn },
    { operator: 0n, a: 17n, b: 40n, c: 7n },
    { operator: 0n, a: 33n, b: 50n, c: 9n },
    { operator: 3n, a: 1n, b: 5n, c: 5n },
    { operator: 6n, a: 1n },
    { operator: 7n, a: 1n },
    { operator: 5n, a: 0n },
    { operator: 2n, a: 0n, b: 99n },
    { operator: 2n, a: 99n, b: 77n },
    { operator: 1n, a: 2n },
    { operator: 1n, a: 99n },
    { operator: 8n, a: 1n },
    { operator: 9n, a: 1n },
    { operator: 10n },
    ...Array.from({ length: 14 }, (_, index) => ({
      operator: 0n,
      a: 1n,
      b: BigInt(100 + index),
      c: BigInt(index),
    })),
    { operator: 0n, a: 1n, b: 999n, c: 99n },
    { operator: 11n },
    { operator: 0n, a: 5n, b: 40n, c: 4n },
    { operator: 0n, a: 5n, b: 20n, c: 2n },
    { operator: 1n, a: 1n },
    { operator: 11n },
    { operator: 0n, a: 5n, b: 40n, c: 4n },
    { operator: 0n, a: 5n, b: 20n, c: 2n },
    { operator: 0n, a: 5n, b: 10n, c: 1n },
    { operator: 1n, a: 1n },
    { operator: 11n },
    { operator: 0n, a: 5n, b: 40n, c: 4n },
    { operator: 0n, a: 5n, b: 20n, c: 2n },
    { operator: 0n, a: 5n, b: 60n, c: 6n },
    { operator: 0n, a: 5n, b: 10n, c: 1n },
    { operator: 0n, a: 5n, b: 30n, c: 3n },
    { operator: 0n, a: 5n, b: 50n, c: 5n },
    { operator: 0n, a: 5n, b: 70n, c: 7n },
    { operator: 1n, a: 0n },
    { operator: 11n },
    { operator: 12n, a: 48n },
  ),
);

const linkedListFixture = contract(
  "LinkedListParity",
  "LinkedList",
  `struct StateData {
    LinkedList<uint64, 8> list;
    uint64 step; uint64 r0; uint64 r1; uint64 r2; uint64 r3;
  };`,
  "sint64 index; uint64 count; uint64 chain;",
  `if (input.op == 0) {
      state.mut().r0 = state.mut().list.addHead(input.a); state.mut().r1 = state.get().list.population();
    } else if (input.op == 1) {
      state.mut().r0 = state.mut().list.addTail(input.a); state.mut().r1 = state.get().list.population();
    } else if (input.op == 2) {
      state.mut().r0 = state.mut().list.insertAfter((sint64)input.a, input.b); state.mut().r1 = state.get().list.population();
    } else if (input.op == 3) {
      state.mut().r0 = state.mut().list.insertBefore((sint64)input.a, input.b); state.mut().r1 = state.get().list.population();
    } else if (input.op == 4) {
      state.mut().list.remove((sint64)input.a); state.mut().r0 = state.get().list.population();
    } else if (input.op == 5) {
      state.mut().r0 = state.mut().list.replace((sint64)input.a, input.b) ? 1 : 0;
    } else if (input.op == 6) {
      locals.index = state.get().list.headIndex(); locals.count = 0; locals.chain = 0;
      while (locals.index >= 0 && locals.count < 8) {
        locals.chain = locals.chain * 131 + state.get().list.element(locals.index);
        locals.count += 1; locals.index = state.get().list.nextElementIndex(locals.index);
      }
      state.mut().r0 = locals.count; state.mut().r1 = locals.chain;
    } else if (input.op == 7) {
      locals.index = state.get().list.tailIndex(); locals.count = 0; locals.chain = 0;
      while (locals.index >= 0 && locals.count < 8) {
        locals.chain = locals.chain * 131 + state.get().list.element(locals.index);
        locals.count += 1; locals.index = state.get().list.prevElementIndex(locals.index);
      }
      state.mut().r0 = locals.count; state.mut().r1 = locals.chain;
    } else if (input.op == 8) {
      state.mut().r0 = state.get().list.isEmptySlot((sint64)input.a) ? 1 : 0;
      state.mut().r1 = state.get().list.headIndex(); state.mut().r2 = state.get().list.tailIndex(); state.mut().r3 = state.get().list.capacity();
    } else {
      state.mut().list.reset(); state.mut().r0 = state.get().list.population(); state.mut().r1 = state.get().list.headIndex(); state.mut().r2 = state.get().list.tailIndex();
    }`,
  boundary(
    { operator: 9n },
    { operator: 8n, a: 0n },
    { operator: 1n, a: 10n },
    { operator: 0n, a: 20n },
    { operator: 2n, a: 0n, b: 30n },
    { operator: 3n, a: 0n, b: 40n },
    { operator: 2n, a: 99n, b: 50n },
    { operator: 3n, a: 99n, b: 60n },
    { operator: 6n },
    { operator: 7n },
    { operator: 5n, a: 0n, b: 99n },
    { operator: 5n, a: 99n, b: 77n },
    { operator: 4n, a: 0n },
    { operator: 1n, a: 55n },
    ...Array.from({ length: 5 }, (_, index) => ({ operator: 1n, a: BigInt(100 + index) })),
    { operator: 1n, a: 999n },
    { operator: 4n, a: 1n },
    { operator: 0n, a: 77n },
    { operator: 9n },
  ),
);

export const CONTAINER_FIXTURES: readonly ContainerFixture[] = [
  arrayFixture,
  bitArrayFixture,
  hashMapFixture,
  hashSetFixture,
  collectionFixture,
  linkedListFixture,
];

export const CONTAINER_FIXTURE_BY_FAMILY = new Map(
  CONTAINER_FIXTURES.map((fixture) => [fixture.family, fixture]),
);
