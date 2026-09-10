# Superseded patches — kept for the record, do not apply

Each of these was built and measured, and each was replaced by something better. They are here because
the campaign's value is partly in what was tried and rejected, and because two of them encode reasoning
that turned out to be wrong in an instructive way.

| patch | why it was replaced |
| --- | --- |
| `F203-k12-address-hardening.patch` | built on a root cause that was wrong — the code it hardened is never entered for `qpi.K12`. Changed no corpus row. The real cause is template argument deduction; see `../F203-template-argument-deduction.patch`. |
| `F204-out-of-range-shift-count.patch` | **refused** the expression rather than matching clang. clang compiles these contracts, so refusing them made 4 corpus rows that agreed with clang stop agreeing. Replaced by `../F204-match-clang-on-out-of-range-shift.patch`, whose rule was measured off clang. |
| `F213-part1-enclosing-scope-key.patch` | fixed 42 of 55 rows and left the finding red. Contained in `../F213-nearest-scope-owns-bare-name.patch`. |
| `F213-both-parts.patch` | fixed the last 13 rows and broke 17. Decided precedence by *kind* of declaration — a `constexpr` beating a later enum member — which is the original bug mirrored. The replacement decides by scope. |

The two lessons worth carrying forward:

- **A published root cause nobody has built is a guess.** F203's and F221's both survived several rounds
  of review and both were wrong. Building the fix is what settled them, in one step each.
- **clang is the oracle.** Where the two disagree, the answer is whatever clang emits, because that is
  what the chain runs — even when the expression is undefined behaviour and clang's own answer is
  inconsistent between two spellings. "Refuse it instead" is a policy, not a fix.
