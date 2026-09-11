# F221 — `DateAndTime::addMillisec` silently drops the day carry

Severity: **high**. Silent wrong answer in date arithmetic; the call reports success.

## What happens

Adding a whole number of days' worth of milliseconds advances the time-of-day correctly but never
advances the date.

Starting from `2024-01-01 00:00:00.000` and calling `addMillisec(n)`:

| n | meaning | clang | typescript |
| --- | --- | --- | --- |
| 1 | 1 ms | 2024-01-01 00:00:00.001 | same |
| 1,000 | 1 s | 2024-01-01 00:00:01.000 | same |
| 61,000 | 1 min 1 s | 2024-01-01 00:01:01.000 | same |
| 86,399,999 | one ms short of a day | 2024-01-01 23:59:59.999 | same |
| **86,400,000** | **exactly one day** | **2024-01-02** 00:00:00.000 | **2024-01-01** 00:00:00.000 |
| **86,400,001** | one day + 1 ms | **2024-01-02** 00:00:00.001 | **2024-01-01** 00:00:00.001 |
| **172,800,000** | **two days** | **2024-01-03** 00:00:00.000 | **2024-01-01** 00:00:00.000 |

`addMillisec` returns **true** in every row, on both backends. Nothing reports a problem.

The boundary is exact: everything below one full day agrees, and the divergence appears the moment the
carry chain has to produce a day. Two days lose two days, so the carry is discarded rather than
truncated or wrapped.

## Where it comes from

`addMillisec` (`src/qpi/qpi_date_time.h:515`) forwards to the eight-argument
`add(0,0,0,0,0,0,millisec,0)` at `:271`. That function carries microseconds into milliseconds into
seconds into minutes into hours through `addAndComputeCarry`, and the hour carry produces a **day
carry**. It then writes the time fields with `setTime(...)` and, only if the day carry (or any of the
year/month/day arguments) is non-zero, folds the day carry into `days` and tail-calls the three-argument
`add(years, months, days)` at `:340` to move the date.

Everything up to and including `setTime` matches. The date half does not run on the TypeScript backend.

## Reproducing

```sh
export QINIT_CORE=/path/to/core-lite
# Build both backends from AddMillisecDayCarry.h, deploy each at slot 29, then for each input call
# procedure 1 with a uint64 millisecond count and read function 1.
```

`Read` returns, in order: `ok`, `year`, `month`, `day`, `hour`, `minute`, `second`, `millisec`, `calls`.
The two rows that matter are `86399999` (agrees) and `86400000` (differs) — keeping both in one script
makes the boundary self-evident and rules out "date arithmetic is broken generally".

## How it was found

`integers/DateAddMillisecCarryChain`, one of ten archetypes added in round 7 for `DateAndTime`, which
had zero call sites in the corpus before this round. It is one of the two archetypes in that file
deliberately shipped **without** hand-derived `expect` rows, because the eight-argument `add()` folds
five carries and then branches into a 160-line day loop — too much to derive by hand reliably, after
round 6 produced 47 false violations doing exactly that.

So the secondary oracle could not have caught this, and did not. The two-backend differential did:
six variants came back `step-mismatch` at the fifth operand pair, which is the `86_400_000` row. Worth
recording as a case where declining to hand-derive was the right call *and* the finding still landed.

## Corpus rows

`integers/DateAddMillisecCarryChain__*` — currently unpinned, so they show as live divergences on the
scoreboard rather than as expected ones.
