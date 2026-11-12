# Real statement files, anonymised

The formats are only as good as the real files they are tested on: each bank's OFX quirks, its CSV layout, Money's
and Quicken's QIF dialects. Real files hold personal data, so they come here only **anonymised**, by
`npm run anonymise` (see [import-formats-design.md](../../../../docs/import-formats-design.md#anonymising-real-statement-files)).

One folder per format: `ofx/` (OFX, QFX and QBO), `csv/` and `qif/`.

## Adding a file

1. **Anonymise it**, outside the repository first:

   ```
   npm run anonymise -- ~/Downloads/chequing-oct.qfx ~/Downloads/chequing-nov.qfx --out ~/anonymised
   npm run anonymise -- ~/Downloads/visa-export.csv ~/Downloads/chequing-export.csv --out ~/anonymised
   npm run anonymise -- ~/Documents/money-chequing.qif ~/Documents/quicken-all.qif --out ~/anonymised
   ```

   For a Money or Quicken export, the anonymiser keeps the categories Tessera starts with (*Food:Groceries*), and
   replaces the others, each account's name (the same way in its transfers), payees, memos and addresses.

   - Paths are read from the folder you run the command in; a name that isn't there gets the closest names in its
     folder suggested.
   - Give **overlapping files together** (or keep `--map ~/private/map.json` between runs). The same payee then gets
     the same made-up name, the same bank id the same made-up id, and the balances still agree, so the files overlap as
     the bank's did.
   - Amounts are changed and balances worked out again. Dates, codes, cheque numbers and the bank's name are kept.
     `--shift-dates <weeks>`, `--hide-institution` and `--keep-amounts` change that.
   - `--keep-words <file>` keeps well-known merchants' names (one per line) for a more realistic matching test.
     Never list a person's name.
   - The mapping (`--map`) holds the original values: keep it private, outside the repository (the tool refuses a path
     inside it).

2. **Read what it says.** It lists what it replaced, by kind. If its scan finds anything that still looks personal, it
   **writes nothing** and shows where (the line, and the QIF field, CSV column or OFX tag), masked, with the value's
   shape:

   ```
   money.qif: not written. After anonymising, this still looks personal:
       line 5, the C field (cleared): phone number: •••-•••-••99  (shaped like 999-999-9999)
       If one is harmless (a bank's public phone number, say), run again allowing its shape; it is then written
       as it is, so allow only what isn't personal:
         --allow-like 999-999-9999
   ```

   Look at that line in your original file. If the value is harmless, add what the report suggests to the command and
   run it again. `--allow-like` takes an example of the value, letters where it has letters and digits where it has
   digits (`--allow-like AB12345678` allows any two letters and eight digits), so there is no regular expression to
   write or to quote, in any shell. Several findings: give `--allow-like` once for each, or list them in a file, one
   per line (`like AA99999999`), and give `--allow-file <file>`. Regular expressions work too (`--allow <regex>`, or a
   line of the file), but need quoting for your shell. What was allowed is written as it was: the report lists it
   again once the file is written.

3. **Read the file.** The scan is a safety net, not a guarantee. Look at every payee, memo and address.

4. **Copy it here**, with its `.meta.json` if it has one. The sidecar says how the original was encoded
   (windows-1252, a byte-order mark, CRLF line ends), and `fixtureBytes` / `fixtureFile` in
   [tests/helpers/importFile.ts](../../../helpers/importFile.ts) rebuild the bank's exact bytes from it, since such
   bytes don't survive every copy or every git setting.

5. **Describe it** in `EXPECTED` in
   [tests/plugins/import/realFiles.test.ts](../../../plugins/import/realFiles.test.ts): how many lines, the bank's
   balance (if the file gives one), the dates, and what is peculiar about it. For a CSV file, also the layout the CSV
   Columns dialog should start from (`layout`), and whether all of it should be recognised rather than guessed
   (`sure`). For a QIF file with several accounts, how many (`statements`), and the warnings it gives (an investment
   account left out). The test reads and imports every file here, and fails on one it doesn't know.

6. **Run `npm test`.** [tests/fixtures/privacy.test.ts](../../privacy.test.ts) scans every statement the repository
   keeps, this folder included, and fails on anything that looks personal. A file named `*.anon.*` is checked where
   the anonymiser keeps the original (codes, the bank, cheque numbers, stray text): its payees, account numbers and ids
   are the anonymiser's own made-up values, which no scan can tell from real ones. So never rename a raw file to
   `.anon.`.

Name files by bank and kind, not by person: `td-chequing-2026-10.anon.qfx`, not `janes-account.anon.qfx`. For Money
and Quicken exports, by program and what they hold: `money-chequing.anon.qif`, `quicken-whole-file.anon.qif`.
