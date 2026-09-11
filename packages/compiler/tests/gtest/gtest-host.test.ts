// drives the gtest host's thost/lhost imports from a hand-written runner, so the state-shadow bookkeeping is pinned
// without clang or a core checkout.
import { expect, test } from "bun:test";
import { runContractTesting } from "@qinit/engine";
import { loadWasmFixture } from "../../../../test-utils/wasm-fixtures";

// runner memory: ids, the state shadow, an output buffer, an empty input, the report message, itoa scratch, row names
const USER = 0;
const VAULT_ID = 32;
const MAIN_ID = 64;
const SHADOW = 256;
const OUT = 512;
const IN = 768;
const MESSAGE = 1024;
const DIGITS = 1536;
const NAMES = 2048;

const VAULT = 28;
const MAIN = 29;

// a row's body leaves what it observed in $a and $b; the report message carries both, so a failure shows the values
interface Row {
    name: string;
    body: string;
    expect: [number, number];
}

const shadow = (slot: number) => `(call $shadow (i32.const ${slot}))`;
const get = (slot: number) => `(call $get (i32.const ${slot}))`;
const observe = (register: "a" | "b", at: number) => `(global.set $${register} (i64.load (i32.const ${at})))`;
const fund = (id: number) => `(call $fund (i32.const ${id}) (i64.const 1000000))`;
const notify = `(call $notify (i32.const ${USER}) (i32.const ${VAULT_ID}) (i64.const 100) (i32.const 0))`;
const sameAsA = "(global.set $b (global.get $a))";

// Vault state: totalReceived@0, incomingCount@8 (POST_INCOMING_TRANSFER adds 1). Get is function 1, Deposit procedure 1.
const SYNC_ROWS: Row[] = [
    {
        name: "notify",
        body: [fund(USER), shadow(VAULT), notify, shadow(VAULT), observe("a", SHADOW + 8), get(VAULT), observe("b", OUT + 8)].join(" "),
        expect: [1, 1],
    },
    {
        name: "runner transfer",
        body: [
            fund(MAIN_ID),
            shadow(VAULT),
            `(drop (call $transfer (i32.const ${VAULT_ID}) (i64.const 50)))`,
            shadow(VAULT),
            observe("a", SHADOW + 8),
            get(VAULT),
            observe("b", OUT + 8),
        ].join(" "),
        expect: [1, 1],
    },
    {
        name: "runner invoke",
        body: [
            fund(MAIN_ID),
            shadow(VAULT),
            `(drop (call $liteInvoke (i32.const ${VAULT}) (i32.const 1) (i32.const ${IN}) (i32.const 0) (i32.const ${OUT}) (i32.const 0) (i64.const 7)))`,
            shadow(VAULT),
            observe("a", SHADOW),
            get(VAULT),
            observe("b", OUT),
        ].join(" "),
        expect: [7, 7],
    },
    {
        name: "runner function sees a shadow write",
        body: [
            shadow(VAULT),
            `(i64.store (i32.const ${SHADOW}) (i64.const 1234))`,
            `(drop (call $liteCall (i32.const ${VAULT}) (i32.const 1) (i32.const ${IN}) (i32.const 0) (i32.const ${OUT}) (i32.const 32)))`,
            observe("a", OUT),
            get(VAULT),
            observe("b", OUT),
        ].join(" "),
        expect: [1234, 1234],
    },
    // controls: paths that already synced, and a mutation with no shadow in play
    {
        name: "control: q_invoke",
        body: [
            fund(USER),
            shadow(VAULT),
            `(drop (call $invoke (i32.const ${VAULT}) (i32.const 1) (i32.const ${IN}) (i32.const 0) (i64.const 5) (i32.const ${USER}) (i32.const ${OUT}) (i32.const 0)))`,
            shadow(VAULT),
            observe("a", SHADOW),
            get(VAULT),
            observe("b", OUT),
        ].join(" "),
        expect: [5, 5],
    },
    {
        name: "control: q_query pushes a shadow write",
        body: [shadow(VAULT), `(i64.store (i32.const ${SHADOW}) (i64.const 1234))`, get(VAULT), observe("a", OUT), sameAsA].join(" "),
        expect: [1234, 1234],
    },
    {
        name: "control: no shadow",
        body: [fund(USER), notify, get(VAULT), observe("a", OUT + 8), sameAsA].join(" "),
        expect: [1, 1],
    },
];

const byte = (value: number) => `\\${value.toString(16).padStart(2, "0")}`;

async function runner(rows: readonly Row[]): Promise<Uint8Array> {
    let nameAt = NAMES;
    const dispatch = rows.map((row, index) => {
        const at = nameAt;
        nameAt += row.name.length;
        return `(if (i32.eq (local.get $i) (i32.const ${index})) (then (call $row${index}) (call $finish (i32.const ${at}) (i32.const ${row.name.length}) (i64.const ${row.expect[0]}) (i64.const ${row.expect[1]}))))`;
    });

    const wat = `(module
  (import "thost" "q_reset" (func $reset))
  (import "thost" "q_fund" (func $fund (param i32 i64)))
  (import "thost" "q_notify_pit" (func $notify (param i32 i32 i64 i32)))
  (import "thost" "q_invoke" (func $invoke (param i32 i32 i32 i32 i64 i32 i32 i32) (result i32)))
  (import "thost" "q_query" (func $query (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "thost" "q_sysproc" (func $sysproc (param i32 i32)))
  (import "thost" "q_state_size" (func $stateSize (param i32) (result i32)))
  (import "thost" "q_state_in" (func $stateIn (param i32 i32 i32)))
  (import "thost" "t_report" (func $report (param i32 i32 i32 i32 i32)))
  (import "lhost" "transfer" (func $transfer (param i32 i64) (result i64)))
  (import "lhost" "liteInvokeProcedure" (func $liteInvoke (param i32 i32 i32 i32 i32 i32 i64) (result i32)))
  (import "lhost" "liteCallFunction" (func $liteCall (param i32 i32 i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const ${USER}) "${byte(7).repeat(32)}")
  (data (i32.const ${VAULT_ID}) "${byte(VAULT)}")
  (data (i32.const ${MAIN_ID}) "${byte(MAIN)}")
  (data (i32.const ${NAMES}) "${rows.map((row) => row.name).join("")}")
  (global $a (mut i64) (i64.const -1))
  (global $b (mut i64) (i64.const -1))
  (func $shadow (param $slot i32)
    (call $stateIn (local.get $slot) (i32.const ${SHADOW}) (call $stateSize (local.get $slot))))
  (func $get (param $slot i32)
    (drop (call $query (local.get $slot) (i32.const 1) (i32.const ${IN}) (i32.const 0) (i32.const ${OUT}) (i32.const 32))))
  (func $dec (param $value i64) (param $at i32) (result i32)
    (local $count i32)
    (loop $digit
      (i32.store8 (i32.add (i32.const ${DIGITS}) (local.get $count))
        (i32.add (i32.const 48) (i32.wrap_i64 (i64.rem_u (local.get $value) (i64.const 10)))))
      (local.set $count (i32.add (local.get $count) (i32.const 1)))
      (local.set $value (i64.div_u (local.get $value) (i64.const 10)))
      (br_if $digit (i64.ne (local.get $value) (i64.const 0))))
    (block $done
      (loop $copy
        (br_if $done (i32.eqz (local.get $count)))
        (local.set $count (i32.sub (local.get $count) (i32.const 1)))
        (i32.store8 (local.get $at) (i32.load8_u (i32.add (i32.const ${DIGITS}) (local.get $count))))
        (local.set $at (i32.add (local.get $at) (i32.const 1)))
        (br $copy)))
    (local.get $at))
  (func $finish (param $name i32) (param $length i32) (param $expectA i64) (param $expectB i64)
    (local $at i32)
    (i32.store16 (i32.const ${MESSAGE}) (i32.const 0x3d61))
    (local.set $at (call $dec (global.get $a) (i32.const ${MESSAGE + 2})))
    (i32.store8 (local.get $at) (i32.const 32))
    (i32.store16 (i32.add (local.get $at) (i32.const 1)) (i32.const 0x3d62))
    (local.set $at (call $dec (global.get $b) (i32.add (local.get $at) (i32.const 3))))
    (call $report (local.get $name) (local.get $length)
      (i32.and (i64.eq (global.get $a) (local.get $expectA)) (i64.eq (global.get $b) (local.get $expectB)))
      (i32.const ${MESSAGE}) (i32.sub (local.get $at) (i32.const ${MESSAGE}))))
  ${rows.map((row, index) => `(func $row${index} ${row.body})`).join("\n  ")}
  (func (export "test_count") (result i32) (i32.const ${rows.length}))
  (func (export "run_test") (param $i i32) (result i32)
    (global.set $a (i64.const -1))
    (global.set $b (i64.const -1))
    (call $reset)
    ${dispatch.join("\n    ")}
    (i32.const 0))
)`;

    const wabt = await (await import("wabt")).default();
    const parsed = wabt.parseWat("runner.wat", wat);
    parsed.validate();
    return new Uint8Array(parsed.toBinary({}).buffer);
}

const observed = (results: { name: string; message: string }[]) => Object.fromEntries(results.map((result) => [result.name, result.message]));
const expected = (rows: readonly Row[]) => Object.fromEntries(rows.map((row) => [row.name, `a=${row.expect[0]} b=${row.expect[1]}`]));

test("host calls that run contract code keep the runner's state shadow in step with the engine", async () => {
    const results = await runContractTesting(await runner(SYNC_ROWS), {
        [VAULT]: await loadWasmFixture("Vault"),
        [MAIN]: await loadWasmFixture("Vault29"),
    });
    expect(observed(results)).toEqual(expected(SYNC_ROWS));
    expect(results.every((result) => result.passed)).toBe(true);
}, 60_000);
