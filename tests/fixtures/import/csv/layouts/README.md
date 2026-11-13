# The CSV layout corpus

One small CSV file per layout a bank might use, each with the layout the guesser should make of it. The guesser
(`plugins/format-csv/src/shared/guess.ts`) is tested against every file here by
[guess.test.ts](../../../../plugins/format-csv/guess.test.ts): its guess must equal the expected layout, with the same
choices marked as guesses, and the expected layout must read every transaction row without a warning. The anonymiser
is tested on them too ([anonymiseCsv.test.ts](../../../../scripts/anonymiseCsv.test.ts)): the guess of its output must
be the guess of the file.

The files are made up, three to six rows each, so every variation in the design's table
([What banks' CSV files look like](../../../../../docs/import-formats-design.md#what-banks-csv-files-look-like)) is
here once: a header or none, a preamble, one signed amount column or *Money out* and *Money in*, a running balance, a
direction column, two date columns, a status column, an account column, French names with semicolons and comma
decimals, month names, ambiguous dates, `CR`/`DR`, parentheses, totals and balance forward rows.

## Each file

- `NN-what-it-shows.csv`: the rows, as the bank writes them.
- `NN-what-it-shows.expected.json`:

  ```json
  {
    "about": "One line: what is peculiar about this layout",
    "layout": { "version": 1, "delimiter": ",", "skip": 0, "header": true, "columns": { "date": 0, "payee": 1, "amount": 2 }, "dateOrder": "YMD", "decimal": ".", "reversed": false },
    "uncertain": ["dateOrder", "column:2"]
  }
  ```

  `uncertain` lists the choices the guess should mark as guesses: `start`, `dateOrder`, `decimal`, `reversed`, or
  `column:<n>` for a column's role (from 0).

## Adding one

1. **Write the file** by hand, with made-up payees and amounts, in the layout you want covered. If it comes from a
   real export, anonymise the export first (`npm run anonymise`, see [real/README.md](../../real/README.md)), and copy
   only its shape.
2. **Write the expected layout**: what a person would choose in the CSV Columns dialog, not what the guesser happens to
   say. Mark as uncertain only what the file can't decide (a pair of amount columns without a header, dates whose days
   are all 12 or less).
3. **Run the tests.** If the guess differs, fix the guesser, not the expectation, unless the expectation was wrong.
   Every other file must still pass.
4. Values that look personal on purpose (a made-up account number) need their line in
   [privacy.test.ts](../../../privacy.test.ts)'s allow-list.
