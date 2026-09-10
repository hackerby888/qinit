# Fixes — what was built, what was measured

Nothing here is applied to the compiler. Each patch was built in a worktree, run against its triage
repro through **both** backends, then against the compiler unit suite and the 6,618-contract corpus.
Every number below is measured.

**clang is the oracle.** Where the two backends disagree, the answer is whatever clang emits, because
that is what the chain runs. A fix is right when it makes the TypeScript backend produce clang's
answer — not when it merely makes the two agree, and not when it refuses the program instead. Two
patches in `superseded/` failed that test and were replaced.

Gate: `bun test packages/compiler/tests/{frontend,edge,qpi,backend,analyzer}` — **1084 pass / 0 fail**
on a clean tree, **1085 / 0** with F217, which adds a toolchain test.

## One patch per finding, sixteen findings

Apply in this order; F201 adds a constant F211 uses, and F213 supersedes the part-1 patch it contains.

| patch | what the backend does now | suite |
| --- | --- | --- |
| `F200-signed-32bit-division.patch` | traps on `INT32_MIN / -1`, as clang does | 1084 / 0 |
| `F201-base-class-alias-chain.patch` | reads through an alias chain of any depth | 1085 / 0 |
| `F203-template-argument-deduction.patch` | deduces `T` from an rvalue's arithmetic type | 1085 / 0 |
| `F204-match-clang-on-out-of-range-shift.patch` | folds a constant out-of-range shift to 0 | 1085 / 0 |
| `F205-class-scope-hides-file-scope.patch` | refuses the hidden read, as clang does | 1085 / 0 |
| `F209-global-scope-qualifier.patch` | parses a leading `::` | 1084 / 0 |
| `F210-identity-alias-hang.patch` | returns in 320ms instead of hanging | 1084 / 0 |
| `F211-nested-struct-scope.patch` | resolves a file-scope struct's fields in its own scope | 1085 / 0 |
| `F212-read-only-entry-context.patch` | refuses a function calling a procedure, as clang does | 1085 / 0 |
| `F213-nearest-scope-owns-bare-name.patch` | gives the bare name to the nearest declaration | 1085 / 0 |
| `F214-sizeof-type-id.patch` | parses `sizeof(Array<uint64, 8>)` | 1084 / 0 |
| `F215-member-of-class-prvalue.patch` | materialises a class prvalue before the member read | 1084 / 0 |
| `F217-block-scope-resolution.patch` | resolves names against the block structure | 1085 / 0 |
| `F220-asset-iterator-selectors.patch` | passes each iterator selector from its own argument | 1084 / 0 |
| `F221-mutable-reference-write-back.patch` | writes back through a mutable reference to a parameter | 1085 / 0 |
| `F222-overload-viability-default-arguments.patch` | counts defaulted parameters when ranking overloads | 1085 / 0 |

`superseded/` holds four patches that were built, measured and replaced, with a note on why.

## The three that took real digging

**F203** had two published root causes before this one, both wrong. The emitted WAT settled it: the
contract compiles *two* K12 instantiations, one hashing 8 bytes and one hashing **1**, because
`methodArgTypes` returned null for every computed expression and `T` was never bound. An rvalue has a
type; `scalarTypeInfo` already computed it for codegen; deduction just never asked.

**F213** was 55 rows across two mechanisms. Part 1 (the enclosing-scope key) fixed 42. The rejected
part 2 fixed the last 13 and broke 17, because it decided precedence by *kind of declaration* — a
`constexpr` beating a later enum member — which is the original bug mirrored. Deciding by **scope**
fixes all 55 and leaves the `logging` family at 306/306.

**F204** is the one the oracle rule caught. The first patch refused the expression on the argument that
it is undefined behaviour and clang contradicts itself between the folded and runtime spellings. But
clang compiles these contracts, so refusing them made 4 rows that agreed with clang stop agreeing. The
rule was then measured off clang — a constant count outside `[0, width)` yields 0, uniformly — and the
backend now reproduces clang's inconsistency, which is what a contract deployed to the chain will meet.

## Two lessons

- **An unbuilt root cause is a guess.** F203's and F221's both survived several rounds of review and
  both were wrong. Building the fix settled each in one step — a WAT dump for F203, one for F221.
- **Matching clang is the bar, not agreement and not fail-closed.** Refusing a program clang accepts is
  a policy choice dressed as a fix, and it is measurable: it cost 4 previously-correct rows.
