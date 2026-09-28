// drives the gtest host's thost/lhost imports from a hand-written runner, so the state-shadow bookkeeping and the
// INITIALIZE timing are pinned without clang or a core checkout.
import { expect, test } from "bun:test";
import { SYSTEM_PROCEDURES } from "@qinit/core";
import { CONTRACT_ENTRY_KIND, QubicSimulator, initK12, runContractTesting } from "@qinit/engine";
import { compileContractWithTypeScript } from "../../src/browser";
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
const SYSTEM = 4096;
const ETALON = 4160;
// oracle rows: a computor key, the OracleProbe input, an oracle machine reply, a transaction, a notification, a looked-up procedure or subscription.
// A row starts with all of it zero and the clock where the first row found it, so nothing a row reads is what an earlier one left.
const KEY = 4224;
const ORACLE_IN = 4352;
const REPLY = 4608;
const FOUND = 4736;
const NOTIFICATION = 8192;
const TRANSACTION = 12288;

const VAULT = 28;
const MAIN = 29;
const INIT_COUNT = 27;

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
const notify = `(drop (call $firePit (i32.const ${USER}) (i32.const ${VAULT_ID}) (i64.const 100) (i32.const 0)))`;
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

const balanceOf = (register: "a" | "b", id: number) => `(global.set $${register} (call $balance (i32.const ${id})))`;

// core's harness helpers move only the qu core moves, and the runner's QPI and clock reach the engine
const HELPER_ROWS: Row[] = [
    {
        name: "a procedure context runs the procedure and moves no reward",
        body: [
            `(drop (call $callProcedure (i32.const ${VAULT}) (i32.const 1) (i32.const ${IN}) (i32.const 0) (i64.const 5) (i32.const ${USER}) (i32.const ${OUT}) (i32.const 0)))`,
            get(VAULT),
            observe("a", OUT),
            balanceOf("b", VAULT_ID),
        ].join(" "),
        expect: [5, 0],
    },
    {
        name: "control: invoking from an unfunded caller runs nothing",
        body: [
            `(drop (call $invoke (i32.const ${VAULT}) (i32.const 1) (i32.const ${IN}) (i32.const 0) (i64.const 5) (i32.const ${USER}) (i32.const ${OUT}) (i32.const 0)))`,
            get(VAULT),
            observe("a", OUT),
            balanceOf("b", VAULT_ID),
        ].join(" "),
        expect: [0, 0],
    },
    {
        name: "an incoming-transfer callback from an unfunded source moves nothing",
        body: [notify, get(VAULT), observe("a", OUT + 8), balanceOf("b", VAULT_ID)].join(" "),
        expect: [1, 0],
    },
    {
        name: "decreaseEnergy refuses an overdraft",
        body: [
            fund(USER),
            `(global.set $a (i64.extend_i32_u (call $decrease (call $spectrum (i32.const ${USER})) (i64.const 2000000))))`,
            `(global.set $b (call $energy (call $spectrum (i32.const ${USER}))))`,
        ].join(" "),
        expect: [0, 1000000],
    },
    {
        name: "runner qpi reaches the engine",
        body: [
            "(global.set $a (i64.extend_i32_u (call $dayOfWeek (i32.const 24) (i32.const 1) (i32.const 1))))",
            `(global.set $b (i64.extend_i32_u (call $isContractId (i32.const ${VAULT_ID}))))`,
        ].join(" "),
        expect: [5, 1],
    },
    {
        name: "the runner's system global is the engine's clock",
        body: [
            `(i32.store16 (i32.const ${SYSTEM}) (i32.const 7))`,
            `(i32.store (i32.const ${SYSTEM + 4}) (i32.const 1234))`,
            "(global.set $a (i64.extend_i32_u (call $epoch)))",
            "(global.set $b (i64.extend_i32_u (call $tick)))",
        ].join(" "),
        expect: [7, 1234],
    },
];

// StateData { uint64 inits; } with INITIALIZE adding 1, so the count is the number of runs
const INIT_ROWS: Row[] = [
    { name: "deploy runs no INITIALIZE", body: [shadow(INIT_COUNT), observe("a", SHADOW), sameAsA].join(" "), expect: [0, 0] },
    {
        name: "an explicit INITIALIZE runs once",
        body: [`(call $sysproc (i32.const ${INIT_COUNT}) (i32.const ${SYSTEM_PROCEDURES.INITIALIZE}))`, shadow(INIT_COUNT), observe("a", SHADOW), sameAsA].join(" "),
        expect: [1, 1],
    },
];

const NUMBER_OF_COMPUTORS = 676;
const PRICE_QUERY_SIZE = 104;
const PRICE_REPLY_SIZE = 16;
const QUERY_ID = `(i64.load (i32.const ${OUT}))`;
const status = (register: "a" | "b") => `(global.set $${register} (i64.extend_i32_u (call $queryStatus ${QUERY_ID})))`;
// OracleProbe's Query is procedure 2 and Subscribe 3; both take the Price query and a time in milliseconds behind it
const ask = (procedure: number, milliseconds: number) =>
    [
        fund(MAIN_ID),
        `(i32.store (i32.const ${ORACLE_IN + PRICE_QUERY_SIZE}) (i32.const ${milliseconds}))`,
        `(drop (call $invoke (i32.const ${MAIN}) (i32.const ${procedure}) (i32.const ${ORACLE_IN}) (i32.const 112) (i64.const 0) (i32.const ${USER}) (i32.const ${OUT}) (i32.const 8)))`,
    ].join(" ");
const machineReply = (numerator: number, replySize = PRICE_REPLY_SIZE) =>
    [
        `(i64.store (i32.const ${REPLY}) ${QUERY_ID})`,
        `(i64.store (i32.const ${REPLY + 16}) (i64.const ${numerator}))`,
        `(i64.store (i32.const ${REPLY + 24}) (i64.const 1))`,
        `(call $machineReply (i32.const ${REPLY}) (i32.const ${16 + replySize}))`,
    ].join(" ");
const answer = (numerator: number) => [ask(2, 60_000), machineReply(numerator), "(call $commitAndReveal)"].join(" ");
const last = (register: "a" | "b") => [get(MAIN), observe(register, OUT)].join(" ");

// core's oracleEngine as a test drives it, with OracleProbe as the contract that asks. Last is function 1 and starts with the numerator.
const ORACLE_ROWS: Row[] = [
    {
        name: "a reply goes through commit and reveal, and the notification runs the procedure that asked for it",
        body: [
            answer(42),
            status("a"),
            `(drop (call $getNotification (i32.const ${NOTIFICATION})))`,
            `(drop (call $userProcedure (i32.load (i32.const ${NOTIFICATION})) (i32.const ${FOUND})))`,
            `(drop (call $callNotification (i32.load (i32.const ${FOUND + 4})) (i32.load (i32.const ${FOUND})) (i32.const ${NOTIFICATION + 8}) (i32.load16_u (i32.const ${FOUND + 12}))))`,
            last("b"),
            "(call $checkState)",
        ].join(" "),
        expect: [3, 42],
    },
    {
        name: "a notification call keeps the state shadow in step",
        body: [
            shadow(MAIN),
            answer(42),
            `(drop (call $getNotification (i32.const ${NOTIFICATION})))`,
            `(drop (call $userProcedure (i32.load (i32.const ${NOTIFICATION})) (i32.const ${FOUND})))`,
            `(drop (call $callNotification (i32.load (i32.const ${FOUND + 4})) (i32.load (i32.const ${FOUND})) (i32.const ${NOTIFICATION + 8}) (i32.load16_u (i32.const ${FOUND + 12}))))`,
            shadow(MAIN),
            observe("a", SHADOW),
            last("b"),
        ].join(" "),
        expect: [42, 42],
    },
    {
        name: "the procedure is not run before the notification is",
        body: [answer(42), `(global.set $a (i64.extend_i32_u (call $getNotification (i32.const ${NOTIFICATION}))))`, last("b")].join(" "),
        expect: [1, 0],
    },
    {
        name: "a notification says whom to call and with what",
        body: [
            answer(42),
            `(drop (call $getNotification (i32.const ${NOTIFICATION})))`,
            `(global.set $a (i64.or (i64.shl (i64.load16_u (i32.const ${NOTIFICATION + 4})) (i64.const 16)) (i64.load16_u (i32.const ${NOTIFICATION + 6}))))`,
            `(global.set $b (i64.add (i64.load (i32.const ${NOTIFICATION + 8 + 16})) (i64.extend_i32_u (call $getNotification (i32.const ${NOTIFICATION})))))`,
        ].join(" "),
        expect: [(MAIN << 16) | (16 + PRICE_REPLY_SIZE), 42],
    },
    {
        name: "the reply and the query are read back in the size the interface has",
        body: [
            answer(42),
            `(drop (call $getReply ${QUERY_ID} (i32.const ${FOUND}) (i32.const ${PRICE_REPLY_SIZE})))`,
            observe("a", FOUND),
            `(global.set $b (i64.extend_i32_u (i32.add
                (i32.mul (call $getReply ${QUERY_ID} (i32.const ${FOUND}) (i32.const ${PRICE_REPLY_SIZE - 1})) (i32.const 100))
                (i32.add
                    (i32.mul (call $getQuery ${QUERY_ID} (i32.const ${FOUND}) (i32.const ${PRICE_QUERY_SIZE})) (i32.const 10))
                    (call $getQuery ${QUERY_ID} (i32.const ${FOUND}) (i32.const ${PRICE_QUERY_SIZE + 1}))))))`,
        ].join(" "),
        expect: [42, 10],
    },
    {
        name: "a reply is not there before it is revealed",
        body: [
            ask(2, 60_000),
            machineReply(42),
            `(global.set $a (i64.extend_i32_u (call $getReply ${QUERY_ID} (i32.const ${FOUND}) (i32.const ${PRICE_REPLY_SIZE}))))`,
            `(global.set $b (i64.extend_i32_u (call $statusFlags ${QUERY_ID})))`,
        ].join(" "),
        expect: [0, 0x100],
    },
    {
        name: "a reply of the wrong size is flagged and the query stays pending",
        body: [ask(2, 60_000), machineReply(42, PRICE_REPLY_SIZE - 1), `(global.set $a (i64.extend_i32_u (call $statusFlags ${QUERY_ID})))`, status("b")].join(" "),
        expect: [0x200, 1],
    },
    {
        name: "a query nobody answers times out when the test moves the clock",
        body: [
            ask(2, 1_000),
            "(call $processTimeouts)",
            status("a"),
            `(i32.store8 (i32.const ${ETALON + 34}) (i32.const 5))`,
            "(call $processTimeouts)",
            `(drop (call $getNotification (i32.const ${NOTIFICATION})))`,
            `(global.set $b (i64.load8_u (i32.const ${NOTIFICATION + 8 + 12})))`,
        ].join(" "),
        expect: [1, 4],
    },
    {
        name: "a query the test starts is one the engine lists",
        body: [
            `(i64.store (i32.const ${OUT}) (call $startQuery (i32.const ${VAULT}) (i32.const 0) (i32.const ${ORACLE_IN}) (i32.const ${PRICE_QUERY_SIZE}) (i32.const 60000) (i32.const 7)))`,
            `(global.set $a (i64.extend_i32_u (call $pendingQueries (i32.const ${FOUND}) (i32.const 4))))`,
            `(global.set $b (i64.add
                (i64.mul (i64.extend_i32_u (i64.eq (i64.load (i32.const ${FOUND})) ${QUERY_ID})) (i64.const 100))
                (i64.load16_u (i32.const ${FOUND + 12}))))`,
        ].join(" "),
        expect: [1, 100 + VAULT],
    },
    {
        name: "a subscription the test starts is the one the contract has",
        body: [
            ask(3, 60_000),
            `(global.set $a (i64.extend_i32_s (call $startSubscription (i32.const ${VAULT}) (i32.const 0) (i32.const ${ORACLE_IN}) (i32.const ${PRICE_QUERY_SIZE}) (i32.const 120000) (i32.const 7) (i32.const 32))))`,
            `(drop (call $getSubscription (i32.load (i32.const ${OUT})) (i32.const ${FOUND})))`,
            `(global.set $b (i64.load16_u (i32.const ${FOUND + 14})))`,
        ].join(" "),
        expect: [0, 2],
    },
    {
        name: "a subscription asks when its queries are generated, and not once its subscriber left",
        body: [
            ask(3, 60_000),
            "(call $generateQueries)",
            `(global.set $a (i64.extend_i32_u (call $pendingQueries (i32.const ${FOUND}) (i32.const 4))))`,
            `(drop (call $stopSubscription (i32.load (i32.const ${OUT})) (i32.const ${MAIN})))`,
            `(i32.store8 (i32.const ${ETALON + 35}) (i32.const 2))`,
            "(call $generateQueries)",
            `(global.set $b (i64.add
                (i64.mul (i64.extend_i32_u (call $stopSubscription (i32.load (i32.const ${OUT})) (i32.const ${MAIN}))) (i64.const 100))
                (i64.extend_i32_u (call $pendingQueries (i32.const ${FOUND}) (i32.const 4)))))`,
        ].join(" "),
        expect: [1, 1],
    },
    {
        name: "a reset drops the queries and the subscriptions",
        body: [
            ask(3, 60_000),
            ask(2, 60_000),
            "(call $oracleReset)",
            status("a"),
            `(global.set $b (i64.extend_i32_u (call $getSubscription (i32.const 0) (i32.const ${FOUND}))))`,
        ].join(" "),
        expect: [0, 0],
    },
    {
        name: "a procedure no contract registered is not found",
        body: [
            `(global.set $a (i64.extend_i32_u (call $userProcedure (i32.const ${(MAIN << 22) | 1}) (i32.const ${FOUND}))))`,
            `(global.set $b (i64.extend_i32_u (call $userProcedure (i32.const ${(5 << 22) | 2}) (i32.const ${FOUND}))))`,
        ].join(" "),
        expect: [0, 0],
    },
];

const INIT_COUNT_SOURCE = `using namespace QPI;
struct InitCount2 {};
struct InitCount : public ContractBase {
    struct StateData { uint64 inits; };
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {}
    INITIALIZE() { state.mut().inits += 1; }
};`;

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
  (import "thost" "q_fire_pit" (func $firePit (param i32 i32 i64 i32) (result i32)))
  (import "thost" "q_invoke" (func $invoke (param i32 i32 i32 i32 i64 i32 i32 i32) (result i32)))
  (import "thost" "q_call_procedure" (func $callProcedure (param i32 i32 i32 i32 i64 i32 i32 i32) (result i32)))
  (import "thost" "q_balance" (func $balance (param i32) (result i64)))
  (import "thost" "q_spectrum" (func $spectrum (param i32) (result i32)))
  (import "thost" "q_decrease" (func $decrease (param i32 i64) (result i32)))
  (import "thost" "q_energy" (func $energy (param i32) (result i64)))
  (import "thost" "q_query" (func $query (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "thost" "q_sysproc" (func $sysproc (param i32 i32)))
  (import "thost" "q_state_size" (func $stateSize (param i32) (result i32)))
  (import "thost" "q_state_in" (func $stateIn (param i32 i32 i32)))
  (import "thost" "q_set_computor" (func $setComputor (param i32 i32)))
  (import "thost" "q_oracle_reset" (func $oracleReset))
  (import "thost" "q_oracle_start_contract_query" (func $startQuery (param i32 i32 i32 i32 i32 i32) (result i64)))
  (import "thost" "q_oracle_start_contract_subscription" (func $startSubscription (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
  (import "thost" "q_oracle_stop_contract_subscription" (func $stopSubscription (param i32 i32) (result i32)))
  (import "thost" "q_oracle_generate_subscription_queries" (func $generateQueries))
  (import "thost" "q_oracle_process_machine_reply" (func $machineReply (param i32 i32)))
  (import "thost" "q_oracle_get_reply_commit_tx" (func $getCommit (param i32 i32 i32 i32) (result i32)))
  (import "thost" "q_oracle_process_reply_commit_tx" (func $processCommit (param i32) (result i32)))
  (import "thost" "q_oracle_get_reply_reveal_tx" (func $getReveal (param i32 i32 i32 i32) (result i32)))
  (import "thost" "q_oracle_process_reply_reveal_tx" (func $processReveal (param i32 i32) (result i32)))
  (import "thost" "q_oracle_process_timeouts" (func $processTimeouts))
  (import "thost" "q_oracle_get_notification" (func $getNotification (param i32) (result i32)))
  (import "thost" "q_oracle_get_query" (func $getQuery (param i64 i32 i32) (result i32)))
  (import "thost" "q_oracle_get_reply" (func $getReply (param i64 i32 i32) (result i32)))
  (import "thost" "q_oracle_get_query_status" (func $queryStatus (param i64) (result i32)))
  (import "thost" "q_oracle_get_query_status_flags" (func $statusFlags (param i64) (result i32)))
  (import "thost" "q_oracle_get_pending_contract_queries" (func $pendingQueries (param i32 i32) (result i32)))
  (import "thost" "q_oracle_get_subscription" (func $getSubscription (param i32 i32) (result i32)))
  (import "thost" "q_oracle_check_state" (func $checkState))
  (import "thost" "q_user_procedure" (func $userProcedure (param i32 i32) (result i32)))
  (import "thost" "q_call_notification" (func $callNotification (param i32 i32 i32 i32) (result i32)))
  (import "thost" "t_report" (func $report (param i32 i32 i32 i32 i32)))
  (import "lhost" "transfer" (func $transfer (param i32 i64) (result i64)))
  (import "lhost" "liteInvokeProcedure" (func $liteInvoke (param i32 i32 i32 i32 i32 i32 i64) (result i32)))
  (import "lhost" "liteCallFunction" (func $liteCall (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "lhost" "dayOfWeek" (func $dayOfWeek (param i32 i32 i32) (result i32)))
  (import "lhost" "isContractId" (func $isContractId (param i32) (result i32)))
  (import "lhost" "epoch" (func $epoch (result i32)))
  (import "lhost" "tick" (func $tick (result i32)))
  (import "lhost" "abort" (func $abort (param i32)))
  (import "lhost" "queryOracle" (func $queryOracle (param i32 i32 i32 i32 i32 i32 i64) (result i64)))
  (memory (export "memory") 1)
  (data (i32.const ${USER}) "${byte(7).repeat(32)}")
  (data (i32.const ${VAULT_ID}) "${byte(VAULT)}")
  (data (i32.const ${MAIN_ID}) "${byte(MAIN)}")
  (data (i32.const ${NAMES}) "${rows.map((row) => row.name).join("")}")
  (data (i32.const ${ETALON + 37}) "${byte(15)}${byte(12)}${byte(25)}")
  (global $a (mut i64) (i64.const -1))
  (global $b (mut i64) (i64.const -1))
  (func $shadow (param $slot i32)
    (call $stateIn (local.get $slot) (i32.const ${SHADOW}) (call $stateSize (local.get $slot))))
  (func $get (param $slot i32)
    (drop (call $query (local.get $slot) (i32.const 1) (i32.const ${IN}) (i32.const 0) (i32.const ${OUT}) (i32.const 32))))
  (func $commitAndReveal (local $computor i32)
    (loop $seat
      (i32.store (i32.const ${KEY}) (i32.add (local.get $computor) (i32.const 1)))
      (call $setComputor (local.get $computor) (i32.const ${KEY}))
      (local.set $computor (i32.add (local.get $computor) (i32.const 1)))
      (br_if $seat (i32.lt_u (local.get $computor) (i32.const ${NUMBER_OF_COMPUTORS}))))
    (local.set $computor (i32.const 0))
    (loop $commit
      (if (call $getCommit (i32.const ${TRANSACTION}) (local.get $computor) (i32.const 1) (i32.const 0))
        (then (drop (call $processCommit (i32.const ${TRANSACTION})))))
      (local.set $computor (i32.add (local.get $computor) (i32.const 1)))
      (br_if $commit (i32.lt_u (local.get $computor) (i32.const ${NUMBER_OF_COMPUTORS}))))
    (drop (call $getReveal (i32.const ${TRANSACTION}) (i32.const 0) (i32.const 1) (i32.const 0)))
    (i32.store (i32.const ${SYSTEM + 4}) (i32.const 1))
    (drop (call $processReveal (i32.const ${TRANSACTION}) (i32.const 0))))
  (func $forget (local $at i32)
    (i32.store (i32.const ${SYSTEM + 4}) (i32.const 0))
    (i32.store16 (i32.const ${ETALON + 34}) (i32.const 0))
    (local.set $at (i32.const ${KEY}))
    (loop $word
      (i64.store (local.get $at) (i64.const 0))
      (local.set $at (i32.add (local.get $at) (i32.const 8)))
      (br_if $word (i32.lt_u (local.get $at) (i32.const ${TRANSACTION + 2048})))))
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
  (func (export "qinit_system") (result i32) (i32.const ${SYSTEM}))
  (func (export "qinit_etalon") (result i32) (i32.const ${ETALON}))
  (func (export "run_test") (param $i i32) (result i32)
    (global.set $a (i64.const -1))
    (global.set $b (i64.const -1))
    (call $forget)
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

test("a fixture runs INITIALIZE only when the test calls it", async () => {
    const compiled = await compileContractWithTypeScript({ source: INIT_COUNT_SOURCE, contractName: "InitCount", slot: INIT_COUNT, arenaSizeBytes: 1024 * 1024 });
    expect(compiled.wasm.byteLength, JSON.stringify(compiled.diagnostics)).toBeGreaterThan(0);

    const results = await runContractTesting(await runner(INIT_ROWS), { [INIT_COUNT]: Uint8Array.from(compiled.wasm) });
    expect(observed(results)).toEqual(expected(INIT_ROWS));
}, 60_000);

test("core's harness helpers, the runner's qpi and its clock reach the engine the way core's do", async () => {
    const results = await runContractTesting(await runner(HELPER_ROWS), { [VAULT]: await loadWasmFixture("Vault") });
    expect(observed(results)).toEqual(expected(HELPER_ROWS));
    expect(results.every((result) => result.passed)).toBe(true);
}, 60_000);

test("core's oracleEngine is the engine the contract under test asks", async () => {
    const results = await runContractTesting(await runner(ORACLE_ROWS), {
        [VAULT]: await loadWasmFixture("Vault"),
        [MAIN]: await loadWasmFixture("OracleProbe"),
    });
    expect(observed(results)).toEqual(expected(ORACLE_ROWS));
    expect(results.every((result) => result.passed)).toBe(true);
}, 60_000);

// contract code a test runs in the runner asks through the runner's own qpi; core tells it about a refusal before QUERY_ORACLE returns.
test("a query the runner's qpi cannot pay for notifies the contract inside the call", async () => {
    await initK12();
    const probe = await loadWasmFixture("OracleProbe");
    const onReply = new QubicSimulator().deploy(MAIN, probe).entries.find((entry) => entry.kind === CONTRACT_ENTRY_KIND.PROCEDURE && entry.inputSizeBytes === 16 + PRICE_REPLY_SIZE)!;
    const procedureId = (MAIN << 22) | onReply.inputType;
    const queryOracle = `(call $queryOracle (i32.const 0) (i32.const ${ORACLE_IN}) (i32.const ${PRICE_QUERY_SIZE}) (i32.const ${PRICE_REPLY_SIZE}) (i32.const ${procedureId}) (i32.const 60000) (i64.const 0))`;
    // Last is { numerator, denominator, queryId, ... }; the notification of a refusal carries the query id -1
    const rows: Row[] = [
        {
            name: "refused",
            body: [`(global.set $a (i64.add (i64.const 2) ${queryOracle}))`, get(MAIN), `(global.set $b (i64.add (i64.const 2) (i64.load (i32.const ${OUT + 16}))))`].join(" "),
            expect: [1, 1],
        },
        {
            name: "control: a paid query notifies nobody yet",
            body: [fund(MAIN_ID), `(global.set $a (i64.shr_u ${queryOracle} (i64.const 62)))`, get(MAIN), observe("b", OUT + 16)].join(" "),
            expect: [0, 0],
        },
    ];

    const results = await runContractTesting(await runner(rows), { [MAIN]: probe });
    expect(observed(results)).toEqual(expected(rows));
}, 60_000);

test("an abort in contract code the runner runs fails the test", async () => {
    const rows: Row[] = [{ name: "abort", body: "(call $abort (i32.const 7))", expect: [0, 0] }];
    const results = await runContractTesting(await runner(rows), { [VAULT]: await loadWasmFixture("Vault") });
    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.message).toContain("contract abort 7");
}, 60_000);
