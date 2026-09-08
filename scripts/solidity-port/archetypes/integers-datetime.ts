// QPI::DateAndTime and the calendar arithmetic behind it — a surface the corpus has never touched.
//
// Round 6's inventory found `addDays`, `addMillisec`, `addMicrosec`, `daysInMonth`, `isLeapYear`,
// `durationDays`, `setDate`, `setTime` and every `get*` accessor at zero call sites across all 411
// archetypes. The one near-miss, hostcalls-time.ts's TimePackedDateAndTime, hand-packs its own
// non-QPI bit layout and never constructs a DateAndTime at all.
//
// Why this lane is unusually strong evidence. The TypeScript backend does not reimplement any of
// this: packages/compiler/src/generated/qpi-snapshot.ts embeds core's own qpi_date_time.h verbatim
// (diffed byte-for-byte against the header) and the backend compiles those bodies. So every function
// here except qpi.now() is pure guest computation with no host in the loop, which means
//
//   1. a divergence is a codegen bug in one of the two backends, not a host-model mismatch, and
//   2. the answer has ground truth — a leap year is a leap year — so these rows can be derived from
//      the C++ rule instead of only being compared against the other backend.
//
// `expect` rows are attached only where the rule is short enough to derive reliably: the bit-packing
// setters, the getters, isLeapYear, daysInMonth, and the two single-day add() cases walked through
// step by step below. The 160-line add() with its 400-year fast path and year-skip loops is left to
// the differential and the WAMR oracle rather than to my arithmetic — round 6 produced 47 expect
// violations that were all derivation errors, and the lesson was to derive less, not to guess more.
//
// Family is `integers`, not `hostcalls`: this is bit-packed integer arithmetic with no host call in
// it, and the WAMR parity sweep's family list covers integers but not hostcalls.
import { twoOperandArchetype } from "./common";
import type { Archetype } from "../types";

const DT = "src/qpi/qpi_date_time.h";

export const DATETIME_ARCHETYPES: Archetype[] = [
    twoOperandArchetype(
        {
            name: "DateSetDateFieldBleed",
            family: "integers",
            solidity: "test/libsolidity/semanticTests/various/packed_storage.sol (bit-packed field writes)",
            stresses:
                "setDate ORs its arguments into a packed uint64 without masking them, so an out-of-range month or day silently overwrites the field above it",
            caveat: "Solidity's packed storage traps on an out-of-range write; QPI's setter is documented as unchecked, so the port is about where the bits land rather than about rejection.",
        },
        () => ({
            state: "uint64 year;\nuint64 month;\nuint64 day;",
            locals: "DateAndTime moment;",
            body: `
                locals.moment.setDate(0, input.a, input.b);
                state.mut().year = locals.moment.getYear();
                state.mut().month = locals.moment.getMonth();
                state.mut().day = locals.moment.getDay();
            `,
            pairs: [
                [12n, 31n],
                [20n, 0n],
                [0n, 40n],
                [0n, 0n],
            ],
            expect: [
                {
                    pair: 0,
                    values: [0n, 12n, 31n],
                    note: `${DT}:84 setDate is value |= (year<<46)|(month<<42)|(day<<37). In range, month 12 occupies bits 44-45 and day 31 bits 37-41, so nothing crosses a field boundary and the getters read back 0/12/31.`,
                },
                {
                    pair: 1,
                    values: [1n, 4n, 0n],
                    note: `month 20 = 0b10100 is five bits wide but the month field is four, so 20<<42 sets bits 44 and 46 — and bit 46 is the year's bit 0. getYear() (${DT}:108, an unmasked value>>46) therefore reads 1, while getMonth() masks with 0b1111 and reads 20 & 15 = 4.`,
                },
                {
                    pair: 2,
                    values: [0n, 1n, 8n],
                    note: `day 40 = 0b101000 is six bits wide against a five-bit field, so 40<<37 sets bits 40 and 42 — bit 42 is the month's bit 0. getMonth() reads 1 and getDay() masks with 0b11111 and reads 40 & 31 = 8. The year is untouched because no bit reaches 46.`,
                },
                {
                    pair: 3,
                    values: [0n, 0n, 0n],
                    note: "all-zero writes leave an all-zero value, which is also the struct's documented invalid sentinel.",
                },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "DateSetTimeFieldBleed",
            family: "integers",
            solidity: "test/libsolidity/semanticTests/various/packed_storage.sol (bit-packed field writes)",
            stresses:
                "setTime is unmasked in the same way as setDate, and its top field (hour) borders the day field, so an out-of-range hour walks into the date half of the word",
            caveat: "The Solidity original packs into a 256-bit slot with explicit shifts; the interesting part that carries over is which neighbouring field absorbs the overflow.",
        },
        () => ({
            state: "uint64 hour;\nuint64 minute;\nuint64 day;",
            locals: "DateAndTime moment;",
            body: `
                locals.moment.setDate(0, 0, 0);
                locals.moment.setTime(input.a, input.b, 0);
                state.mut().hour = locals.moment.getHour();
                state.mut().minute = locals.moment.getMinute();
                state.mut().day = locals.moment.getDay();
            `,
            pairs: [
                [23n, 59n],
                [40n, 0n],
                [0n, 70n],
            ],
            expect: [
                {
                    pair: 0,
                    values: [23n, 59n, 0n],
                    note: `${DT}:99 setTime clears bits 0-36 and ORs (hour<<32)|(minute<<26)|(second<<20). Hour 23 fits its five bits and minute 59 its six, so both read back unchanged and the zeroed date is undisturbed.`,
                },
                {
                    pair: 1,
                    values: [8n, 0n, 1n],
                    note: "hour 40 = 0b101000 needs six bits against a five-bit field, so 40<<32 sets bits 35 and 37 — bit 37 is the day field's bit 0. getDay() reads 1 even though setDate wrote day 0, and getHour() masks with 0b11111 to read 40 & 31 = 8.",
                },
                {
                    pair: 2,
                    values: [1n, 6n, 0n],
                    note: "minute 70 = 0b1000110 needs seven bits against a six-bit field, so 70<<26 sets bits 27, 28 and 32 — bit 32 is the hour field's bit 0. getHour() reads 1 and getMinute() masks to 70 & 63 = 6. The day is untouched because nothing reaches bit 37.",
                },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "DateLeapYearLadder",
            family: "integers",
            solidity: "test/libsolidity/semanticTests/various/date_time.sol (calendar predicates)",
            stresses: "the full Gregorian leap rule including the century and 400-year exceptions, plus the boundary years of the 16-bit field",
        },
        () => ({
            state: "uint64 leap;",
            locals: "DateAndTime moment;",
            body: "state.mut().leap = DateAndTime::isLeapYear(input.a) ? 1 : 0;",
            pairs: [
                [0n, 0n],
                [4n, 0n],
                [100n, 0n],
                [400n, 0n],
                [1900n, 0n],
                [2000n, 0n],
                [2023n, 0n],
                [2024n, 0n],
                [65535n, 0n],
            ],
            expect: [
                { pair: 0, values: [1n], note: `${DT}:164 — year 0 passes all three tests (0%4, 0%100, 0%400 are all zero), so the rule calls it a leap year.` },
                { pair: 1, values: [1n], note: "4%4==0 and 4%100!=0, so the century branch is never entered and the answer is true." },
                { pair: 2, values: [0n], note: "100%4==0 and 100%100==0 but 100%400!=0, so the century exception applies and the answer is false." },
                { pair: 3, values: [1n], note: "400 reaches the innermost branch, 400%400==0, so the exception to the exception applies." },
                { pair: 4, values: [0n], note: "1900 is the textbook century non-leap year: divisible by 100, not by 400." },
                { pair: 5, values: [1n], note: "2000 is the textbook 400-year leap year." },
                { pair: 6, values: [0n], note: "2023%4 == 3, so the first test rejects it immediately." },
                { pair: 7, values: [1n], note: "2024%4==0 and 2024%100==24, so it is a plain leap year." },
                { pair: 8, values: [0n], note: "65535 is the largest value the 16-bit year field holds; 65535 = 4*16383 + 3, so it fails the first test." },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "DateDaysInMonthLadder",
            family: "integers",
            solidity: "test/libsolidity/semanticTests/various/date_time.sol (calendar table lookup)",
            stresses:
                "the month-length table, its February leap-year special case, and the out-of-range guard that returns 0 rather than indexing the array",
            caveat: "The local lookup table shadows the function's own name, so this also exercises the name-resolution path that produced nine findings in earlier rounds.",
        },
        () => ({
            state: "uint64 days;",
            locals: "DateAndTime moment;",
            body: "state.mut().days = DateAndTime::daysInMonth(input.a, input.b);",
            pairs: [
                [2024n, 2n],
                [2023n, 2n],
                [2000n, 2n],
                [1900n, 2n],
                [2024n, 0n],
                [2024n, 13n],
                [2024n, 1n],
                [2024n, 4n],
                [2024n, 12n],
            ],
            expect: [
                { pair: 0, values: [29n], note: `${DT}:179 — month 2 of a leap year short-circuits the table and returns 29.` },
                { pair: 1, values: [28n], note: "2023 is not a leap year, so February falls through to the table entry, 28." },
                { pair: 2, values: [29n], note: "2000 is a leap year by the 400-year rule, so February is 29." },
                { pair: 3, values: [28n], note: "1900 is not a leap year by the century rule, so February is 28." },
                { pair: 4, values: [0n], note: "month 0 fails the `month < 1` guard and returns 0 without touching the table — the value that makes add() misbehave on a corrupt month." },
                { pair: 5, values: [0n], note: "month 13 fails the `month > 12` guard and returns 0, even though the table has a 13th element (index 12 holds December)." },
                { pair: 6, values: [31n], note: "January is table index 1, which is 31." },
                { pair: 7, values: [30n], note: "April is table index 4, which is 30." },
                { pair: 8, values: [31n], note: "December is table index 12, the last valid entry, which is 31." },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "DateGetYearUnmaskedTruncation",
            family: "integers",
            solidity: "test/libsolidity/semanticTests/various/packed_storage.sol (narrowing a packed read)",
            stresses:
                "getYear is the only accessor with no mask — it relies on the two reserved top bits being clear and narrows through a uint16 cast, so a year past the field width truncates rather than saturating",
        },
        () => ({
            state: "uint64 year;",
            locals: "DateAndTime moment;",
            body: `
                locals.moment.set(input.a, 1, 1, 0, 0, 0, 0, 0);
                state.mut().year = locals.moment.getYear();
            `,
            pairs: [
                [2024n, 0n],
                [65535n, 0n],
                [65536n, 0n],
                [131071n, 0n],
            ],
            expect: [
                { pair: 0, values: [2024n], note: `${DT}:108 getYear is static_cast<uint16>(value >> 46). 2024 fits the 16-bit field and reads back unchanged.` },
                { pair: 1, values: [65535n], note: "65535 exactly fills the 16-bit year field (bits 46-61); the cast is lossless." },
                {
                    pair: 2,
                    values: [0n],
                    note: "65536 = 2^16, so 65536<<46 lands entirely on bit 62 — one of the two reserved bits, outside the year field. value>>46 is 65536 and the uint16 cast truncates it to 0, so the year reads as zero rather than as anything near what was written.",
                },
                {
                    pair: 3,
                    values: [65535n],
                    note: "131071 = 2^17-1 occupies bits 46-62. value>>46 is 0x1FFFF and the uint16 cast keeps only the low 16 bits, 0xFFFF, so it is indistinguishable from the in-range 65535 above.",
                },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "DateAddDaysAcrossLeapBoundary",
            family: "integers",
            solidity: "test/libsolidity/semanticTests/various/date_time.sol (date advance)",
            stresses:
                "the single-day step of add()'s forward loop, where whether 28 February rolls to the 29th or to 1 March is decided by daysInMonth and the month-overflow fixup",
        },
        () => ({
            state: "uint64 ok;\nuint64 year;\nuint64 month;\nuint64 day;",
            locals: "DateAndTime moment;",
            body: `
                locals.moment.set(input.a, 2, 28, 0, 0, 0, 0, 0);
                state.mut().ok = locals.moment.addDays(input.b) ? 1 : 0;
                state.mut().year = locals.moment.getYear();
                state.mut().month = locals.moment.getMonth();
                state.mut().day = locals.moment.getDay();
            `,
            pairs: [
                [2024n, 1n],
                [2023n, 1n],
                [2024n, 2n],
                [2023n, 0n],
            ],
            expect: [
                {
                    pair: 0,
                    values: [1n, 2024n, 2n, 29n],
                    note: `${DT}:387 forward loop with days=1 on 2024-02-28: monthDays = daysInMonth(2024,2) = 29, and 1 >= 29 is false, so newDay += 1 -> 29 and days -> 0. 29 > monthDays(29) is false, so no month bump; the trailing "newDay > 28" fixup recomputes monthDays as 29 and 29 > 29 is false, so it does nothing. 2024-02-29.`,
                },
                {
                    pair: 1,
                    values: [1n, 2023n, 3n, 1n],
                    note: "same path on 2023-02-28, where monthDays = 28: newDay += 1 -> 29, then 29 > monthDays(28) is true, so the month bumps to 3 and newDay -= 28 -> 1. The trailing fixup sees newDay 1, which is not > 28. 2023-03-01.",
                },
                {
                    pair: 2,
                    values: [1n, 2024n, 3n, 1n],
                    note: "days=2 on 2024-02-28: 2 >= monthDays(29) is false, so newDay += 2 -> 30, days -> 0, and 30 > 29 bumps the month to 3 with newDay -= 29 -> 1. 2024-03-01, one day past the pair-0 result as it should be.",
                },
                {
                    pair: 3,
                    values: [1n, 2023n, 2n, 28n],
                    note: "days=0 enters neither the forward nor the backward loop, so the date is unchanged and add() still reports success.",
                },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "DateAddDaysOnInvalidInstance",
            family: "integers",
            solidity: "test/libsolidity/semanticTests/various/date_time.sol (guarding an uninitialised date)",
            stresses:
                "add() checks isValid() before doing anything, so a default-constructed DateAndTime refuses every day arithmetic — the one guard that fires before any mutation",
        },
        () => ({
            state: "uint64 ok;\nuint64 year;\nuint64 month;\nuint64 day;",
            locals: "DateAndTime moment;",
            body: `
                state.mut().ok = locals.moment.addDays(input.a) ? 1 : 0;
                state.mut().year = locals.moment.getYear();
                state.mut().month = locals.moment.getMonth();
                state.mut().day = locals.moment.getDay();
            `,
            pairs: [
                [1n, 0n],
                [0n, 0n],
                [400n, 0n],
            ],
            expect: [
                {
                    pair: 0,
                    values: [0n, 0n, 0n, 0n],
                    note: `${DT}:346 — the default constructor sets value = 0, which is the invalid sentinel, so add() returns false at its isValid() check before touching any field. Every getter still reads 0.`,
                },
                { pair: 1, values: [0n, 0n, 0n, 0n], note: "the guard runs before the zero-days early exit, so even a no-op add is refused on an invalid instance." },
                { pair: 2, values: [0n, 0n, 0n, 0n], note: "a day count large enough to reach the year-skip loop is still refused by the same guard, so none of the fast paths run." },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "DateDurationDaysIsSymmetric",
            family: "integers",
            solidity: "test/libsolidity/semanticTests/various/date_time.sol (interval length)",
            stresses:
                "durationDays normalises its two endpoints so the earlier one comes first, which makes the result an unsigned absolute difference — a.duration(b) and b.duration(a) must agree",
            caveat: "durationMicrosec underneath is a heuristic capped at ten iterations that answers UINT64_MAX when it fails to converge; these spans are short enough to stay well inside that.",
        },
        () => ({
            state: "uint64 forward;\nuint64 backward;\nuint64 mismatched;",
            locals: "DateAndTime start;\nDateAndTime finish;",
            body: `
                locals.start.set(2024, 1, 1, 0, 0, 0, 0, 0);
                locals.finish.set(2024, 1, 1, 0, 0, 0, 0, 0);
                locals.finish.addDays(input.a);
                state.mut().forward = locals.start.durationDays(locals.finish);
                state.mut().backward = locals.finish.durationDays(locals.start);
                if (state.get().forward != state.get().backward)
                {
                    state.mut().mismatched++;
                }
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [31n, 0n],
                [60n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n], note: `${DT}:591 — identical endpoints give a zero span in both directions.` },
                { pair: 1, values: [1n, 1n, 0n], note: "2024-01-01 to 2024-01-02 is one day, and the normalisation at the top of durationMicrosec makes the reverse query answer the same." },
                { pair: 2, values: [31n, 31n, 0n], note: "January has 31 days, so +31 lands on 2024-02-01 and the span is 31 days each way." },
                { pair: 3, values: [60n, 60n, 0n], note: "2024 is a leap year, so 31 days of January plus 29 of February is 60 days to 2024-03-01 — the span a non-leap year would report as 59." },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "DateAddMillisecCarryChain",
            family: "integers",
            solidity: "test/libsolidity/semanticTests/various/date_time.sol (sub-second arithmetic)",
            stresses:
                "the millisecond-to-second-to-minute carry chain, which runs through addAndComputeCarry — the protected safe-math helper a contract can only reach this way",
            caveat: "No expect rows: the eight-argument add() folds five carries and then hands off to the day loop, and deriving that by hand is exactly the kind of arithmetic that produced 47 false violations in round 6. This row rests on the two backends and the WAMR oracle.",
        },
        () => ({
            state: "uint64 ok;\nuint64 second;\nuint64 millisec;\nuint64 minute;",
            locals: "DateAndTime moment;",
            body: `
                locals.moment.set(2024, 1, 1, 0, 0, 0, 0, 0);
                state.mut().ok = locals.moment.addMillisec(input.a) ? 1 : 0;
                state.mut().second = locals.moment.getSecond();
                state.mut().millisec = locals.moment.getMillisec();
                state.mut().minute = locals.moment.getMinute();
            `,
            pairs: [
                [1n, 0n],
                [999n, 0n],
                [1000n, 0n],
                [61_000n, 0n],
                [86_400_000n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "DateAddMicrosecNegativeCarry",
            family: "integers",
            solidity: "test/libsolidity/semanticTests/various/signed_division.sol (floor versus truncating division)",
            stresses:
                "the negative branch of addAndComputeCarry, which emulates a floor division as (low - factor + 1) / factor on a truncating divide — the sign-handling path a positive-only test never reaches",
            caveat: "No expect rows, for the same reason as the millisecond chain: the carry cascade is too long to derive reliably by hand.",
        },
        () => ({
            state: "uint64 ok;\nuint64 second;\nuint64 millisec;\nuint64 microsec;",
            locals: "DateAndTime moment;\nsint64 delta;",
            body: `
                locals.moment.set(2024, 1, 1, 12, 30, 30, 500, 500);
                locals.delta = input.a;
                state.mut().ok = locals.moment.addMicrosec(-locals.delta) ? 1 : 0;
                state.mut().second = locals.moment.getSecond();
                state.mut().millisec = locals.moment.getMillisec();
                state.mut().microsec = locals.moment.getMicrosecDuringMillisec();
            `,
            pairs: [
                [1n, 0n],
                [501n, 0n],
                [1000n, 0n],
                [1_000_000n, 0n],
            ],
        }),
    ),
];
