# The matching corpus

Pairs of "the register as the user typed it" and "the statement as the bank sent it", with the pairing a person would
make. `tests/plugins/import/matching/corpus.test.ts` runs the matcher over every file and reports its precision (how
many of its proposals are right) and recall (how many of the right pairings it proposes). The suite fails if either
falls below the figures in the test.

Each file:

| Key | What |
|---|---|
| `about` | What the case is about |
| `currency` | The account's currency |
| `register` | The transactions the user entered: `id`, `date`, `amount` (a decimal string, signed from the account's point of view), and `payee` and `number` when they have one |
| `statement` | The bank's lines: `date`, `amount`, and `payee`, `userDate` and `number` when the bank gives them; `expect` is the `id` of the transaction the line is, or `null` for a line that should be added as new |

To add a case, write a file in the same shape. A case the matcher gets wrong is worth adding: that is what the corpus
is for, and what `matching/tuning.ts` is tuned against.
