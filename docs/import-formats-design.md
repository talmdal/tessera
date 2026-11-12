# Design and implementation: CSV, QBO and QIF import formats

| | |
|---|---|
| **Status** | Reviewed 2026-11-11: every open question was answered, and the answers are applied throughout (see [Decisions taken in review](#decisions-taken-in-review)). **Phase F0 (the groundwork) done** ([results](#phase-f0-results)), and checked by hand in the dark theme. **Phase F1 (QBO and the anonymiser) done** ([results](#phase-f1-results)), with the first real files. **Phase F2 (duplicates across sources) done** ([results](#phase-f2-results)), checked on Windows. **Phase F3 (the sign cross-check) done** ([results](#phase-f3-results)). **Phase F4 (CSV) done** ([results](#phase-f4-results)), with two banks' real exports, and seen on Windows. **Phase F5 (QIF) done** ([results](#phase-f5-results)), waiting for real Money and Quicken exports and the check by hand. **Phase F6 (remembered choices) done** ([results](#phase-f6-results)): *File › Saved Import Choices…* |
| **Date** | 2026-11-11 |
| **Scope** | Three more file types for *File › Import…*: **CSV** exports from banks' websites, **QBO** (QuickBooks Web Connect) statements, and **QIF** (Quicken Interchange Format) files from banks, Quicken and Microsoft Money. Also what the import manager and its contract need so that these formats are safe: format dialogs that aren't cut off by the parse time limit, bank ids that can't be trusted, the same transaction arriving from two kinds of file, and amounts signed the wrong way round. And a tool that removes personal data from real statement files, so they can be used to test the formats |
| **Builds on** | [import-manager-design.md](import-manager-design.md): the `import.formats` point, `ParsedStatement`, account resolution, import ids and fingerprints, matching, review in the register. [plugin-creation.md](plugin-creation.md#adding-an-import-format): how a format plugin is written |
| **Replaces** | [import-manager-design.md › Phase 3: CSV](import-manager-design.md#phase-3-csv-m), and two rows of its [Later](import-manager-design.md#later-not-scheduled) table: *QIF format plugin* and *Probable-duplicate warning* |
| **Amends** | [import-manager-design.md](import-manager-design.md): `ParseContext` gains `prompt`, and the parse time limit doesn't count time spent in a format's dialog ([Format dialogs](#format-dialogs-and-the-parse-time-limit)). A `CANCELLED` thrown by `parse` stops the import. `ParsedStatement` gains `stableIds`, and `StatementLine` gains `category`. A bank id that names a different transaction is no longer taken as a duplicate ([Bank ids that collide](#bank-ids-that-collide)). A line that looks like one **already imported from another source** is proposed as such, not added ([Duplicates across sources](#duplicates-across-sources)). Every import gets a **sign cross-check** once its account is known ([Sign cross-check](#sign-cross-check)). When a file's category and the payee's usual one disagree, the user chooses which wins, per source ([Category hints](#category-hints)). Decision 10 is narrowed: a CSV file with an account-number column has a strong key |
| **Layout** | [Part 1](#part-1-design) is the design (*what and why*), and [Part 2](#part-2-implementation) is the phased plan (*how and in what order*), in the style of [import-manager-design.md](import-manager-design.md). This note's phases are numbered **F0 to F6** (F for *formats*) so they aren't confused with the import manager's phases 0 to 4 |

- [Summary](#summary)
- [Naming](#naming)
- [Context](#context)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- **Part 1: Design**
  - [Shared groundwork](#shared-groundwork)
  - [Duplicates across sources](#duplicates-across-sources)
  - [Sign cross-check](#sign-cross-check)
  - [QBO: QuickBooks Web Connect](#qbo-quickbooks-web-connect)
  - [CSV](#csv)
  - [QIF](#qif)
  - [Anonymising real statement files](#anonymising-real-statement-files)
  - [How each format meets the import manager](#how-each-format-meets-the-import-manager)
  - [Contract changes, together](#contract-changes-together)
  - [Alternatives considered](#alternatives-considered)
  - [Risks](#risks)
  - [Later](#later)
  - [Decisions taken in review](#decisions-taken-in-review)
- **Part 2: Implementation**
  - [Ground rules](#ground-rules)
  - [Dependency graph and order](#dependency-graph-and-order)
  - [Phase F0: contract and import-manager groundwork (M)](#phase-f0-contract-and-import-manager-groundwork-m)
  - [Phase F1: QBO, and the anonymiser (M)](#phase-f1-qbo-and-the-anonymiser-m)
  - [Phase F2: duplicates across sources (M)](#phase-f2-duplicates-across-sources-m)
  - [Phase F3: the sign cross-check (M)](#phase-f3-the-sign-cross-check-m)
  - [Phase F4: CSV (L)](#phase-f4-csv-l)
  - [Phase F5: QIF (M)](#phase-f5-qif-m)
  - [Phase F6: remembered choices (S)](#phase-f6-remembered-choices-s)
  - [Sample files](#sample-files)
  - [Documentation changes](#documentation-changes)
  - [Definition of done](#definition-of-done)
  - [Phases](#phases)

---

## Summary

- **Three file types, with the import manager unchanged in its role.** Each format turns bytes into neutral
  `ParsedStatement`s. The import manager still finds the account, leaves out lines imported before, matches, adds and
  reviews, as for OFX today.
- **QBO is OFX.** QuickBooks' Web Connect files are OFX 1.x with Intuit tags, exactly as QFX is. The existing
  `import-ofx` plugin learns the `.qbo` extension, and a QBO file and an OFX file for the same account share saved
  account matches and bank ids. The one thing QBO adds is **made-up bank ids**: QuickBooks accepts only QBO, so many
  QBO files come from conversion tools, and some of these number their transactions 1, 2, 3… in every file. Those ids
  are detected and not trusted.
- **CSV gets a new `import-csv` plugin.** It reads any delimited export: signed amounts or debit and credit columns, a
  header row or none, preamble lines, day-first or month-first dates, comma decimals, pending rows, and a running
  balance. It **guesses the column layout**, and the **CSV Columns** dialog shows it **for every CSV file**, with a live
  preview of what will be imported. A layout seen before is filled in from the ledger's memory, and a confident guess
  is filled in as it stands, so when nothing has changed one key (Enter) confirms it.
- **QIF gets a new `import-qif` plugin.** It reads bank, cash, card and other-asset/liability sections, single- and
  multi-account files (Quicken's `!Option:AutoSwitch`), two-digit and apostrophe years (`10/05'26`), opening-balance
  records, splits (kept as the total), and categories. It skips investment sections with a warning. It asks (a small
  **QIF Options** dialog) only when the dates or decimals could be read two ways, or the first time a card's signs
  need confirming. QIF is also how a Microsoft Money or Quicken user brings an account's history into Tessera.
- **Groundwork in the import manager and its contract** (`@tessera/import-api` 1.3):
  - `ParseContext.prompt` opens a format's own dialog with the **parse time limit paused**. Today `parse` has 30
    seconds in total, so a user who took longer than 30 seconds in a layout dialog would have the import aborted;
  - a `CANCELLED` thrown by `parse` stops the import;
  - a per-statement `stableIds`, so a format can distrust one file's bank ids rather than all of them;
  - an optional `category` hint on a line, used only when it names a category the ledger already has. When it differs
    from the payee's usual category, **the user chooses which wins**, once per source, and the choice is remembered;
  - `file.text('auto')` for files that don't declare an encoding;
  - date helpers for two-digit years and month names, and guessers for date order and decimal separator;
  - a guard against **bank ids that collide**: an id seen before, on a line dated more than 3 days from what it named,
    or with both another amount and another payee, is a different transaction, not a duplicate.
- **Duplicates across sources.** CSV and QIF lines have no bank ids, so they are known by fingerprint. Today a
  transaction imported from a CSV file and then again from an OFX file is **added twice**: the ids differ, and
  matching skips transactions that already carry one. A line that looks like a transaction **already imported from
  another source** (same amount, dates within 3 days, payees alike) is now **proposed as *Already imported?***
  against that transaction, and nothing is added. *Accept* confirms it's the same transaction; *Change…* adds it after
  all. The same rule catches a bank's CSV that changed a line's text between two downloads (pending, then posted).
- **A sign cross-check on every import.** Once the account is known, the import manager checks that the amounts aren't
  reversed. It tries the statement both ways against the account's own entries, its earlier imports and the bank's
  balance. On the **first import from a source** it also uses the account's type. It asks (*Amounts Reversed?*) only
  when the evidence points the other way. What was confirmed is retained per source and account, so a later file whose
  amounts suddenly run the other way is caught too.
- **An anonymiser for real files**, `npm run anonymise`. It replaces account numbers, names, payees, memos, addresses
  and ids with consistent made-up ones, and changes amounts while keeping the balances adding up. It keeps the file's
  dialect (layout, dates, encoding, line ends), which is what the tests need. It then **scans its own output** for
  anything that still looks personal, and refuses to write a file that fails.
- **The plan: F0 to F6.**
  - **F0**, the contract and the import manager's groundwork (M);
  - **F1**, QBO, and the anonymiser (M);
  - **F2**, duplicates across sources (M);
  - **F3**, the sign cross-check (M);
  - **F4**, CSV (L);
  - **F5**, QIF (M);
  - **F6**, a place to see and forget remembered choices: QIF options, category and sign choices, CSV layouts (S),
    with the import manager's phase 4.

  F2 and F3 must land before CSV or QIF ships. F4 and F5 can be built in parallel once F0 is done. The anonymiser
  arrives with F1 for OFX, QFX and QBO, and learns CSV and QIF at the start of F4 and F5, so real files can be
  collected before the guessers are tuned.

---

## Naming

| Concept | User-facing name | Code name | Notes |
|---|---|---|---|
| How a CSV file's columns are laid out | **Columns** (*CSV Columns* dialog) | `CsvLayout` | Kept in the ledger, per signature |
| What identifies a layout across files | (not shown) | layout **signature** | A hash of the normalised header row, or of the column shapes when there is no header |
| What a column holds | **Column role**: *Date*, *Payee*, *Amount*, *Money out*, *Money in*, … | `ColumnRole` | Picked per column in the dialog |
| QIF's choices for one source | **QIF Options** | `QifOptions` | Date order, decimal separator, and whether the source's signs are reversed |
| A line that looks like a transaction imported from another file | **Already imported?** (register); *looks like one already imported* (summary) | `MatchState` `'duplicate'`; `import.lines.duplicateOf` | A proposal of its own kind ([Duplicates across sources](#duplicates-across-sources)) |
| A bank id that names a different transaction than last time | (warning text only) | id **collision**; `ImportCounts.idConflicts` | [Bank ids that collide](#bank-ids-that-collide) |
| QuickBooks Web Connect | **QBO** in the file dialog's label | extension `qbo` on `import-ofx.ofx` | |
| Checking that amounts aren't reversed | **Amounts Reversed?** (dialog) | sign cross-check; `matching/signs.ts`; `IMPORT_DIALOGS.signs` | [Sign cross-check](#sign-cross-check) |
| Which category a new line takes when the file and the payee disagree | **Categories from the File** (dialog) | `CategorySource` (`'file'` \| `'payee'`); `IMPORT_DIALOGS.categories` | [Category hints](#category-hints) |
| What the import manager remembers per source | (F6: *Remembered choices*) | `import.memory` records with `formatId: 'import'` | A key without a dot can't clash with a format's id |
| The tool that removes personal data from statement files | `npm run anonymise` | `scripts/anonymise.mts` | [Anonymising real statement files](#anonymising-real-statement-files) |

---

## Context

### What exists today

| Facility | Used for |
|---|---|
| The `import.formats` point and the `ImportFormat` service ([contract.ts](../packages/import-api/contract.ts)) | Each new format is one contribution and one service |
| `ParseContext.memory` (`import.memory` in the ledger, keyed by format and key) | Remembering a CSV layout or QIF options per ledger |
| `shell.dialogs` contributions, opened through `shell.prompts.show` | The CSV Columns and QIF Options dialogs, in each format plugin's renderer |
| Account keys and strength; the file-name key fallback (`import-qif.qif:file:checking`) | CSV's layout key, QIF's account-name key, and QIF files without an account |
| Fingerprints (`fp:` + SHA-256 of date, amount, normalised payee, memo; `#n` for repeats) | Recognising CSV and QIF lines imported before |
| `canonicalDecimal`, `isoDate` | Amounts and dates in CSV and QIF |
| `ImportFile.text(encoding)` with windows-1252 decoded correctly | CSV and QIF, which rarely declare an encoding |
| The OFX reader (`plugins/import-ofx`: `sgml.ts`, `statements.ts`), which ignores unknown tags such as `<INTU.BID>` | QBO |
| `drafts.ts` (payee, then category from the payee's history or the line's kind) | Where a QIF or CSV category hint is used |
| The matcher's candidates: not void, not reconciled, **no `externalId`**, not already proposed | Why a transaction imported from another file is never matched today ([Duplicates across sources](#duplicates-across-sources)) |

### The three formats

| | QBO | CSV | QIF |
|---|---|---|---|
| Made by | Banks, for QuickBooks (Web Connect); conversion tools (PDF or CSV to QBO) | Every bank's website, and many apps | Some banks; Quicken and Microsoft Money when exporting an account |
| Structure | OFX 1.x (SGML), with `<INTU.BID>` and sometimes `<INTU.USERID>` | Rows and columns, in one of many layouts | Records of one-letter fields, ended by `^`, in sections (`!Type:Bank`) |
| Names its account | Yes: bank id and account number | Usually not; sometimes an account-number column | Sometimes: an `!Account` name, never a number |
| Bank ids | Yes (`FITID`), though conversion tools may make them up | Rarely (a *Transaction ID* column) | Never |
| Signs | As OFX: from the account holder's side | Any: signed, two columns, a `DR`/`CR` column, or reversed for cards | From the account's side (a card's charges negative), with exceptions |
| Dates | `YYYYMMDD` | Any order, any separator, sometimes month names | `MM/DD/YY`, `MM/DD'YY`, `DD/MM/YYYY`, with spaces for padding |
| Balance | `LEDGERBAL` | Sometimes a running-balance column | Sometimes an opening-balance record |
| Categories | No | Sometimes (the bank's own) | Often, when exported from Quicken or Money |
| Hard part | Made-up ids | The layout | Dates, and the many dialects |

### Gaps, and how this design handles each

| Gap | Handling |
|---|---|
| `parse` has 30 seconds in total (`IMPORT_LIMITS.parseTimeoutMs`, enforced by `within` in `run.ts`), and a format's dialog is opened inside `parse` | **`ParseContext.prompt`**: the import manager opens the dialog and pauses the clock while it is open ([below](#format-dialogs-and-the-parse-time-limit)) |
| A format's *Cancel Import* has no way to stop the import: a throw from `parse` fails that file only | `ImportError('CANCELLED')` from `parse` stops this file and the rest, as *Cancel Import* in the Account dialog does |
| `stableIds` is per contribution, so one converter-made QBO file would make every OFX file's ids untrusted | **`ParsedStatement.stableIds`**, per statement |
| A bank id seen before is always a duplicate, even when it names a different transaction (a converter's `1`, `2`, `3`) | **The collision guard** ([below](#bank-ids-that-collide)) |
| A transaction already imported from another kind of file is never a candidate, so the same line from a second source is added again | **Already imported?** proposals ([Duplicates across sources](#duplicates-across-sources)) |
| `isoDate` refuses two-digit years and month names | Options for both ([Dates](#dates-two-digit-years-month-names-and-guessing)) |
| A file that doesn't declare its encoding: UTF-8 or windows-1252? | **`file.text('auto')`**: a byte-order mark, else UTF-8 if the bytes are valid UTF-8, else windows-1252 |
| `StatementLine` has no category | **`StatementLine.category`**, a hint, with the user choosing between it and the payee's usual category ([Category hints](#category-hints)) |
| Nothing checks a statement's signs. A reversed CSV or card file imports as plausible-looking transactions, and matching then finds nothing (a match needs the same sign), so everything is added | **The sign cross-check** ([Sign cross-check](#sign-cross-check)) |
| Real statement files can't be added to the tests without exposing account numbers, names and spending | **`npm run anonymise`** ([Anonymising real statement files](#anonymising-real-statement-files)) |
| No format plugin has a renderer yet | `import-csv` and `import-qif` are the first. They expose their dialog modules as the import plugin does, and need nothing new from the framework |

---

## Goals and non-goals

**Goals**

- Import the CSV files banks' websites export, whatever their layout. The layout is shown for confirmation with every
  file, filled in from last time, so next month's file takes one key.
- Import QBO files as OFX files are imported, without being fooled by made-up ids.
- Import QIF files from banks, Quicken and Money: single accounts and whole-file exports, with the dates read right.
- **Never double a transaction** because it arrived from two kinds of file, or because a bank changed its text
  between two downloads.
- **Never import a statement the wrong way round** without the user being asked, whatever the format.
- **Let the user decide** what only they know: whether a file's categories or their own usual ones should win.
- Make it safe to add **real statement files** to the tests, with nothing personal left in them.
- Keep format plugins small and pure (bytes in, statements out), testable without a ledger.

**Non-goals**

- **Investment transactions** (QIF `!Type:Invst`, OFX `INVSTMTRS`): the neutral model is cash lines only (import
  manager non-goal). They are skipped with a warning.
- **Creating transfers** from QIF's `L[Account]`, or from two sides found in one file: transfers aren't created by
  import (import manager non-goal). The lines are imported as ordinary lines, with `kind: 'transfer'`.
- **Splits**: `accounts` has none yet. A split QIF transaction is imported as its total, with the split shown in the
  memo.
- **Creating categories** from a file. A category hint is used only when the ledger already has it.
- **A full migration from Money or Quicken** (the chart of accounts, payees, budgets, investments, reconciled
  history). QIF brings in an account's transactions; a migration tool is separate work.
- **Exporting** to any of these formats.
- **Excel files** (`.xls`, `.xlsx`). Some banks offer them; a later format plugin could turn their first sheet into
  rows for the same layout code.

---

## Decisions

| # | Decision | Why |
|---|---|---|
| F-1 | **QBO is read by `import-ofx`**, which adds `qbo` to its extensions. There is no `import-qbo` plugin | A QBO file *is* an OFX 1.x file, as QFX is (import manager phase 1 decided the same for QFX). One reader means one set of fixes. The same account in an OFX and a QBO file shares its key (`ofx:bank:…`) and its bank ids, so a saved account match and duplicate detection work across the two. Plugins can't import each other's code (`tests/architecture/boundaries.test.ts`), so a separate plugin would first need the OFX reader moved into a shared package, for no gain to the user. See [Alternatives](#alternatives-considered). Agreed in review |
| F-2 | **Formats ask through `ParseContext.prompt`**, not `shell.prompts` directly. The parse time limit is paused while a format's dialog is open | The limit exists to stop a hung or slow format, not a user reading a preview. Going through the import manager also opens the dialog in the import's window. Format plugins then need no services, so they stay easy to test |
| F-3 | **Bank ids can be distrusted per statement** (`ParsedStatement.stableIds: false`), and the import manager **checks ids seen before** against what they named then | A converter-made file's made-up ids are a property of that file, not of OFX. A collision is also cheap to detect, because `import.lines` keeps the bank's version of every line. Without the check, a made-up id silently drops a real transaction as a "duplicate", which is worse than adding one twice |
| F-4 | **A line that looks like one already imported from another source is proposed, not added** (*Already imported?*) | Adding it and flagging it would put a duplicate in the balance until reviewed. Leaving it out silently could lose a real transaction. A proposal adds nothing, is seen, and is undone with one click. It reuses the review machinery (decision 5 of the import manager: a match is a proposal). Agreed in review |
| F-5 | **The CSV Columns dialog is shown for every CSV file**, with the remembered layout, or the guess when it is confident, filled in for confirmation | Decided in review. A wrong sign or date order imports a whole file of wrong transactions that *look* plausible, and a bank can change its export without changing its header row. When nothing has changed, confirming is one key (Enter), and the preview shows exactly what will be imported |
| F-6 | **CSV layouts and QIF options are remembered in the ledger** (`context.memory`), per layout signature or per source key. So are the import manager's own per-source choices (category choice, sign records), in the same collection under `formatId: 'import'` | They describe a bank's files, as saved account matches do, and they travel with the ledger. Nothing per-file is stored in application settings. Reusing `import.memory` needs no schema change |
| F-7 | **A CSV file with an account-number column has a strong key** (`csv:account:<number>`), one statement per account | It then names its account as an OFX file does, so decision 10's reason for asking every time (a layout is the file's only identity) doesn't apply. Without that column, decision 10 stands: weak key, and the Account dialog every time unless *Don't ask again* |
| F-8 | **QIF account names are weak keys** (`qif:account:<name>`) | "Checking" names one account in one user's Quicken file, and a different one in the next file from a different bank. A name suggests an account; only a number identifies one |
| F-9 | **Category hints are used only when they name an existing category, by full path. When a hint and the payee's usual category disagree, the user chooses which wins, per source, and the choice is remembered** | Decided in review. In a Quicken or Money export the file's category is the user's own decision for that transaction; in a bank's CSV the user's own history is usually better. Only the user knows which kind of file a source gives, and that doesn't change from one file to the next. Nothing is created, so a bank's *Shopping* never clutters the category list |
| F-10 | **Pending rows in CSV files are left out**, with a count in the summary | Their text and date usually change once posted, so they would come back under a second fingerprint. They arrive with the next export, once posted |
| F-11 | **Phases F4 (CSV) and F5 (QIF) ship only after F2** (duplicates across sources) **and F3** (the sign cross-check) | Both are fingerprint formats, and users switching between a bank's CSV and its OFX is the common case that doubles transactions. They are also the formats whose signs are most often reversed |
| F-12 | **Every import gets a sign cross-check once its account is known**, from every kind of evidence available, and asks only when the evidence says the amounts are reversed. What the user confirms is **retained per source and account** | Decided in review. A reversed file is the most damaging mistake a format can make, and the first import from a source is when it is most likely. The format can't check it, because it doesn't know the account. Retaining a small profile per source is cheap (one record), and it catches a later file that suddenly runs the other way |
| F-13 | **A script, `npm run anonymise`, removes personal data from real statement files** and keeps their dialect. It **refuses to write** a file in which its own scan still finds something that looks personal | Decided in review. The guessers and dialect readers are only as good as the real files they are tested on. Finding every account number, name and e-transfer recipient by hand is error-prone, and a mistake committed to the repository is hard to undo. A development script rather than an app command, because it serves the tests ([Later](#later)) |
| F-14 | **CSV doesn't claim `.txt`.** A CSV export named `.txt` is imported by choosing *All files*, and sniffing picks the CSV format | Decided in review. Claiming `txt` would put every text file in the *All supported statements* filter |

---

# Part 1: Design

## Shared groundwork

### Format dialogs and the parse time limit

```ts
// @tessera/import-api, ParseContext
/**
 * Opens a dialog this format contributed to `shell.dialogs`, in the window the import was started from, and resolves
 * with what it closed with, or undefined if the user cancelled it. The parse time limit is paused while the dialog is
 * open. Resolves undefined at once, without opening anything, if `signal` has been aborted.
 */
prompt<TResult = unknown, TInput = unknown>(dialogId: string, input: TInput, options?: { title?: string }): Promise<TResult | undefined>
```

- **The clock.** `within` in `run.ts` becomes a stopwatch: `prompt` pauses it on entry and resumes it when the
  dialog closes, so `parse` gets 30 seconds of *its own* time. The prompt itself has no limit: the import is the
  ledger's operation, so nothing else waits on it except the user.
- **The window.** `windowId` from the run is passed to `shell.prompts.show`, so a format never needs to handle it.
- **Abort.** `shell.prompts.show` can't close a dialog it opened. If the run is aborted while a format's dialog is open,
  the dialog stays until the user closes it, and its result is ignored. This is rare: the import holds the ledger's
  operation, so Close and Open wait for it, and quitting asks first. So it is accepted and documented rather than
  given a new shell API.
- **Skip and cancel.** A format resolves `parse` with `undefined` for *Skip This File* (unchanged). For *Cancel
  Import* it throws `ImportError('CANCELLED', …)`, which `importFile` now treats as the user stopping the import: the
  file is reported `cancelled` and no later file is read. Today it would be reported as a failure.
- **Dialog ids** must start with the format plugin's id (`import-csv.dialog.layout`), as for any `shell.dialogs`
  contribution.
- `ParseContext.windowId` stays for compatibility. Formats written against 1.2 that call `shell.prompts` themselves
  keep working, but their dialogs still count against the limit. The guide says to use `prompt`.

### Per-statement `stableIds`

```ts
// ParsedStatement
/**
 * False when this statement's bank ids (`StatementLine.externalId`) can't be trusted to name the same transaction in
 * another file: lines are then known by fingerprint. Overrides the contribution's `stableIds` for this statement only.
 */
stableIds?: boolean
```

`convertLines` takes the statement's value when given, otherwise the contribution's. `import-ofx` sets it for files
whose ids look made up ([QBO](#made-up-bank-ids)), and `import-csv` for a *Transaction ID* column whose values repeat
within the file.

### Bank ids that collide

Today a line whose bank id is already in the account, or in `import.lines`, is a duplicate, whatever it says. With
made-up ids (`1`, `2`, `3` in every file) the second file's lines would all be dropped as duplicates of the first
file's. That is a silent loss, and it is the worst outcome an import can have.

**The check.** For each line whose import id is a **bank id** (not a fingerprint) and is already known, the import
manager compares the line with what that id named before. That is the `bank` fields of its `import.lines` record, or,
when the record has gone (archiving prunes some), the transaction's date and amount, with the payee counted as
agreeing. The two **disagree** on:
- the amount, when the amounts differ at all;
- the date, when they are more than 3 days apart;
- the payee, when both have one and their similarity ([payee similarity](import-manager-design.md#payee-similarity))
  is under 0.5.

The id is a **collision** when the **dates** disagree, or when **both the amount and the payee** do. A bank that sends a
line again keeps its date within a few days, and keeps its amount or its payee: a corrected amount keeps the payee, a
renamed line keeps the amount.

The date decides on its own because of recurring payments. Next month's rent, with the same payee and amount under a
reused id, disagrees only on its date. The first version of this rule, "any two of the three", took it for this month's
rent sent again and dropped it; the phase F0 tests found this ([results](#phase-f0-results)). The rule leans towards
importing: a line kept by mistake is seen in the register, and a line dropped by mistake is lost.

**Then:**
- the line is known by its **fingerprint** instead, and goes through the duplicate check again under that id;
- a warning names it: "Line 12: the bank's id 7 was used before for a different transaction (Oct 3, THE KEG #12,
  57.50), so this line is recognised by its content instead";
- `ImportCounts.idConflicts` counts it, and the summary says "3 recognised by their content, as the bank had used
  their ids before for other transactions".

If more than half a statement's known ids collide, the whole statement switches to fingerprints, with one warning
rather than one per line.

### Category hints

```ts
// StatementLine
/**
 * The category the file gives the line, as a path from the top: 'Food:Groceries'. A hint, never applied on its own:
 * used only when it names a category the ledger has, and only for sources whose files the user said to take
 * categories from. Never a transfer ('[Savings]').
 */
category?: string
```

**Resolving.** A hint resolves when the ledger has a category at exactly that path, each part compared as the accounts
plugin compares category names (ignoring case and the spaces around `:`). A hint that doesn't resolve is dropped
without a warning: a bank's own categories (*Shopping*, *Restaurants*) rarely match a user's scheme. A hint never
creates anything, and matching ignores categories.

**Never applied on its own** ([F-9](#decisions); decided in review: "don't automatically accept categories from
files"). A file's categories are used only for a source the user has said to take them from. This holds even when the
payee has no usual category of its own. Each source has a **category choice**:

| The source's choice | A new line's category |
|---|---|
| `'file'`: *The file's categories* | The file's, when it resolves; otherwise the payee's usual category; otherwise from the line's `kind` |
| `'payee'`: *My usual category for each payee* (also when nothing was asked) | The payee's usual category; otherwise from the line's `kind`. The file's is not used. This is how imports behaved before files could give categories |

The payee's usual category follows today's rules, including that a payee last used for a transfer gives none.

**The source's category choice** is kept in `import.memory` as `categories:<statement key>`, with `formatId: 'import'`.
The statement key is the format's key or the file-name key, so there is always one. A key without a dot can't clash
with a format's id. The first time a statement's new lines include any whose file category resolves, and its source
has no choice yet, the import manager asks, after the account is known and before anything is applied. A file whose
categories the ledger doesn't have asks nothing.

```
┌ Categories from the File ───────────────────────────────────────────────────────────────┐
│ Checking.qif gives a category for 42 new transactions, and your ledger has them. For 9   │
│ of them, you usually use a different category for the payee.                             │
│                                                                                          │
│   Payee          The file says             You usually use                               │
│   Costco         Food : Groceries          Household                                     │
│   Hydro One      Utilities : Electricity   Utilities                                     │
│   Shell          Transportation : Fuel     Nothing yet                                   │
│                                                                                          │
│ For new transactions, use:                                                               │
│   ( ) The file's categories                                                              │
│       Where the file gives one your ledger has; otherwise the payee's usual category.    │
│   ( ) My usual category for each payee                                                   │
│       The file's categories aren't used.                                                 │
│                                                                                          │
│ [✓] Remember this for files from “Maple Chequing”                                        │
│                                                          [Cancel Import]  [Continue]     │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- `import.dialog.categories`, size `sm`, in the import plugin's renderer.
- **The examples**: up to five, one per payee, those whose payee usually has another category first.
- **Nothing is preselected.** The user decides ([F-9](#decisions)), and *Continue* is enabled once they have. It
  happens once per source.
- **Remember** is ticked by default. Unticked, the choice applies to this statement only, and the next file from the
  source asks again.
- **Results**: `{ source: 'file' | 'payee', remember }`; no result is *Cancel Import*.
- **Without a dialog** (`importStatements` with `interactive: false`), a source with no choice is treated as
  `'payee'`: the file's categories aren't used, and the report says how many lines had one.
- The choice applies only to **new** lines. Accepting a match never changes the user's category (import manager
  decision 9).
- **The summary says what happened**, under the statement's sentence:
  - "12 new transactions took their categories from the file, as you chose for “Maple Chequing”. *Change…*";
  - "The file gave categories for 12 new transactions, which weren't used, as you chose for “Maple Chequing”.
    *Change…*";
  - "…, this time." for an answer not remembered (no link);
  - "…, which weren't used: this import didn't ask." for a non-interactive import.
- **Changing it later.** *Change…* opens the same dialog, starting from the answer kept, with *Cancel* and *Save*.
  The new answer applies from the next import, and unticking *Remember* forgets it, so the next file asks again. Lines
  already added keep their categories. F6's *Remembered choices* lists every source's choice too.

### Text in an unknown encoding

`ImportFile.text('auto')`:
1. a byte-order mark wins (UTF-8, UTF-16 LE or BE, as today);
2. otherwise the bytes are decoded as UTF-8 with `fatal: true`, and used if that succeeds;
3. otherwise windows-1252, with the plugin's own table for 0x80–0x9F.

Valid UTF-8 is almost never an accident in a file written as windows-1252 that contains accented letters, so the
order is safe. Pure ASCII files read the same either way.

### Dates: two-digit years, month names and guessing

`isoDate(text, order, options?)` gains two options, both off by default so that every existing caller is unchanged:

| Option | Effect |
|---|---|
| `pivot: number` | Two-digit years are accepted: `yy` is the latest year ending in `yy` that is not after `pivot`. Callers pass the current year plus 10, so in 2026 `26` is 2026, `36` is 2036, and `37` is 1937. Still pure: the caller supplies the year. Only a year written **last** (MDY, DMY) may have two digits: with YMD allowed too, `10/05/26` would also read as 2010-05-26, and almost every QIF file would look ambiguous |
| `monthNames: true` | `5 Oct 2026`, `05-Oct-2026`, `Oct 5, 2026`, `October 5 2026`, `2026-Oct-05`, `5 octobre 2026`, `5 oct. 2026`: English and French names, in full or cut to at least three letters that start only one month's names (`jui` could be *juin* or *juillet*, so it is refused). The name's position says the order, so `order` isn't used for these |

Two pure guessers, also in `helpers.ts`, for the column or field that holds every date or amount in a file:

```ts
/** The orders that read every sample as a real date. One → decided; several → ambiguous (ask, or use a remembered choice). */
guessDateOrder(samples: string[], options?: { pivot?: number, monthNames?: boolean }): DateOrder[]
/** The decimal separators that read every sample. '1,234' fits both; '1,234.56' and '12,50' decide. */
guessDecimal(samples: string[]): DecimalSeparator[]
```

A file decides for all its rows. `03/04/2026` is ambiguous alone, and a file with `13/04/2026` anywhere is day-first
throughout. Dates are never guessed row by row.

---

## Duplicates across sources

### The problem

Every imported line carries its import id as the transaction's `externalId`: the bank's id, or a fingerprint. A line
is a duplicate only when its own id is already known. Ids from different sources never agree:

| What the user does | Today |
|---|---|
| Imports October from the bank's CSV export, then starts using the bank's OFX, whose file covers 26 October onwards | The overlapping week is **added twice**: the OFX lines have FITIDs, the CSV lines fingerprints |
| Exports CSV mid-month while a purchase is pending (`PENDING – COSTCO`, dated the purchase day), and again at month end (`COSTCO WHSE #0123`, dated the posting day) | Two fingerprints: **added twice** (pending rows are also left out by the CSV format, [F-10](#decisions), but not every export marks them) |
| Brings a year of history in from Money as QIF, then imports the bank's OFX for the latest month | The overlap is **added twice** |

Matching doesn't catch them either: a candidate must have no `externalId`, because a transaction that carries one is
already some bank line's.

### The rule

After the duplicate check and **before** matching, each fresh line is compared with the **earlier imported lines** of
the same account: the `import.lines` records (outcome `added`, or `matched` and accepted) whose transaction still
exists and isn't void. They are found through the transactions `list()` already loads for matching (those with an
`externalId`), then their lines by `byTransaction`. No new index is needed. A pair is an **already-imported
candidate** when all of these hold:

| Condition | Why |
|---|---|
| **Not two trusted bank ids from the same format.** At least one of the two import ids is a fingerprint (which is also what `stableIds: false` gives), or both formats are known (`batch.formatId`) and differ | Two different FITIDs from the same bank's OFX are two transactions by the bank's own word. Formats not known to differ count as the same |
| **The same amount**, exactly | Both sides are what a bank reported, not what a user typed, so amounts agree |
| **Dates within 3 days**, either way | A CSV's *transaction date* against an OFX's *posting date*, or a pending date against a posted one |
| **Payees alike**: similarity ≥ 0.75 between the two **bank texts**, or either has none | Both are bank text, so aliases aren't needed. The words a pending or pre-authorised line adds are ignored. The matcher's 0.5 proved too loose here: the payee is what tells two same-amount purchases apart ([Phase F2 results](#phase-f2-results)) |
| The earlier line's transaction may be **reconciled** | Unlike ordinary matching: last month's CSV import was very likely reconciled before this month's OFX arrived |
| **Or, for cheques** (added in [F5](#phase-f5-results)): both lines have a cheque number, the same one, the same amount, and dates within **30 days**, whatever the payees. Two different numbers are two cheques, whatever else agrees | A Money or Quicken export names the person paid (*Landlord*) where the bank writes *CHEQUE 101*, and a bank posts a cheque when it clears, sometimes weeks after it was written |

Pairs are taken one to one, best first (payee similarity, then fewest days apart, then the earlier transaction),
exactly as [matching assigns](import-manager-design.md#one-line-one-transaction). The lines left over go on to
ordinary matching, then are added.

### What is recorded

The line is recorded in `import.lines` as a proposal of its own kind:
- `outcome: 'matched'`, `review: 'pending'`;
- `proposedId`: the earlier transaction;
- **`duplicateOf`**: the earlier line's id (new, optional field);
- no `score` is shown for these, though one is recorded for ordering.

Nothing is written to `accounts`, so the balance is already right. The new line's import id is recorded, so the same
file imported again finds it as an ordinary duplicate.

`lineState.ts` gains the state `duplicate`. A duplicate proposal whose transaction is **reconciled** is still
pending, not unresolved. One whose transaction was deleted or voided is unresolved, as for any proposal.

### What the user sees

The summary counts them: "5 transactions added to “Maple Trust Bank 5678”, 5 looked like transactions imported before
from another file and weren't added: check them in the register." The review bar: "10 imported transactions to review
(5 new, 5 possibly already imported), from maple-trust-chequing-2026-11.ofx."

In the register, the earlier transaction's row is marked:

```
│ ▌        Oct 28, 2026  Costco         Food : Groceries      84.12          2,302.51   [✓ Accept]  [⇄ Change…]   │
│ ▌   ⧉ Already imported? Oct 29 · COSTCO WHSE #0123 · 84.12 in November.ofx looks like this, from October.csv    │
```

- **Tone** `warning`; **icon** a new standard icon, `ContentCopy`.
- **✓ Accept**: "It's the same transaction: don't add it again". The line becomes `skipped` with `review: 'done'`.
  Nothing in `accounts` changes.
- **⇄ Change…** opens the Change Match dialog with the state `duplicate`:
  - ***Add it as a new transaction***: the line is added (`createMany`), already acknowledged, as *Unmatch* does for
    a proposal;
  - ***Match it to another transaction***: the ordinary candidates, as for any line;
  - *Don't import* is the same as *Accept* here, so it isn't offered.
- **Accept All…** includes them, and its question says so: "Accept 5 new transactions and 5 lines already imported?",
  with "The 5 lines already imported from another file won't be added again."
- **A row already under review** (the earlier line is itself still *New from the bank*) shows the duplicate mark. It
  carries more information, and accepting it acknowledges both lines.

### Why not the alternatives

- **Add and flag**: the balance is wrong until the user reviews, and a missed flag leaves a real duplicate.
- **Leave out silently**: two genuine coffees on the same day from two sources would lose one. A proposal costs one
  click, and *Accept All* exists.
- **Re-key the earlier transaction to the bank id on Accept**: attractive, since future files would match by id, but
  the earlier line's record would then point at a transaction that no longer carries its id, which `lineState` reads as
  *unresolved*. Recording the new line's id in `import.lines` gets the same result for future imports, without
  touching `accounts`.

---

## Sign cross-check

### Why here

A format reads signs as the file writes them. CSV's *amounts are reversed* and QIF's card option can turn them round,
but both are decided **before the account is known**. A reversed statement is hard to see there: a chequing export
with money out shown as positive just looks like a month of deposits. Once imported, the damage is complete. Matching
needs the same sign, so nothing matches, everything is added as new, and the balance runs the wrong way.

After account resolution, the import manager knows the account's type, its entries, its earlier imports and its
balance. That is where the evidence is, and it is the same for every format ([F-12](#decisions)). So the check is
a step of the run: after converting and dropping duplicates, and before matching.

### The evidence

The statement's fresh lines are looked at twice: **as read**, and **reversed** (every amount negated). Each piece of
evidence says *as read*, *reversed*, or nothing.

| Evidence | Says *reversed* when | Strength | Available when |
|---|---|---|---|
| **Matching both ways** | Matching the reversed lines proposes at least 3 pairs, and at least three times as many as matching them as read. Says *as read* the other way round | strong | The user has entered transactions in the statement's window |
| **Earlier imports both ways** | The [already-imported rule](#the-rule) pairs at least 3 reversed lines, and three times as many as it pairs as read | strong | Earlier imports overlap the statement (F2) |
| **The bank's balance** | With `balance` (amount *b*, as of *d*), the account's balance on *d* before this import is *A*, and *S* is the sum of the fresh lines dated on or before *d*. Then *A* + *S* = *b* says *as read*, and *A* − *S* = −*b* says *reversed*: a format that reads the amounts the wrong way reads the balance the same way. Only exact equality counts | strong | The statement has a balance, the account existed before this import (one just made from the statement opened at the balance the statement gave, so it would agree with anything), and its history covers *d* |
| **The account's type** | A card or line of credit where more than two thirds of the lines as read are positive (payments and refunds outnumbering charges); a chequing or cash account where more than 80% are positive. Savings, investment and other accounts: nothing, because mostly deposits is normal | weak | Only on the **first import from this source into this account** |
| **The retained profile** | Earlier imports from this source into this account were mostly money out (a share of 0.7 or more), and this statement as read is mostly money in (0.3 or less), or the other way round | weak | From the second import on ([What is retained](#what-is-retained)) |

For statements over 500 lines, the two "both ways" passes use the first 500, which is ample evidence and keeps the
extra matching pass well under the [matcher's measured time](import-manager-design.md#phase-2-results).

**Deciding:**

| Evidence | Then |
|---|---|
| Any strong evidence says *reversed* | Ask |
| Only weak evidence says *reversed*, and no strong evidence says *as read* | Ask |
| Anything else, including nothing at all | Import as read, silently |

The question is asked at most once per statement, before the [category question](#category-hints).

### The question

```
┌ Amounts Reversed? ──────────────────────────────────────────────────────────────────────────┐
│ The amounts in October-activity.csv may be the wrong way round for “Visa” (credit card):    │
│  • 38 of its 41 lines would lower what you owe, and only 3 would add to it.                  │
│  • Reversed, 6 of them match transactions you entered; as they are, none do.                 │
│                                                                                              │
│    Oct 3   AMAZON.CA           as they are  +45.00     reversed   −45.00                    │
│    Oct 15  PAYMENT - THANK YOU as they are −500.00     reversed  +500.00                    │
│                                                                                              │
│   (•) Reverse the amounts                                                                    │
│   ( ) Import them as they are                                                                │
│                                                                                              │
│  [✓] Remember for files like this one going into “Visa”                                      │
│                                                         [Cancel Import]  [Continue]          │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- `import.dialog.signs`, size `sm`, in the import plugin's renderer.
- **It says why**: each piece of evidence that fired, in words. It shows a charge and a payment both ways, in the
  account's own terms (*Charge* and *Payment* for a card, through `AMOUNT_COLUMNS`).
- **Reverse** is preselected, because the evidence points that way. The user can always choose otherwise.
- **Results**: `{ reverse: boolean, remember: boolean }`; no result is *Cancel Import*.
- **Reversing** negates every line of the statement and its `balance`. The import then goes on as usual: duplicates
  (by fingerprint, which includes the amount, so it is worked out again), matching, adding.
- **Without a dialog** (`importStatements` with `interactive: false`), a statement that would be asked about isn't
  imported. It is reported with the new outcome `needsConfirmation`, and its reasons. Importing a statement whose
  signs may be wrong is never silent.
- The summary says when amounts were reversed: "Amounts reversed, as you chose; files like this one will be too", or
  "…, this time", or, by a kept correction, "Amounts reversed, as you chose for files like this one".
- **An account made from the statement** opened at the balance the statement gave as read. When its amounts are
  reversed, it is given the opening balance the reversed statement gives, unless the user changed the form's figure.

### Where a correction is remembered

A reversal has **one owner**, so the format and the import manager never both reverse a file:
- **The format, when it can express it.** CSV has *Money out is shown as positive* and QIF a sign option per source.
  The import manager calls the format's new optional hook:

  ```ts
  // ImportFormat (1.5)
  /**
   * The user corrected a statement this format read. Update what the format remembers for `key`, so the next file is
   * read correctly; resolve true if it has, false if it can't (the import manager then keeps the correction itself).
   */
  correct?(correction: { kind: 'signsReversed', key: string }, context: { memory: FormatMemory }): Promise<boolean>
  ```

  CSV flips the remembered layout's `reversed` (it keeps which layout produced each statement key), and QIF flips the
  source's sign option. The next CSV Columns dialog then shows the corrected layout, and its preview is right.
- **The import manager, otherwise** (OFX, or a format without the hook): its record for the source and account
  (below) holds `reverse: true`, and it negates that source's statements for that account before checking them. The
  check always runs on the corrected statement, so if the bank fixes its files later, the check fires again, and
  answering *Reverse* turns the correction off.

With *Remember* unticked, only this statement is reversed, and nothing is kept.

### What is retained

One small record per source and account, in `import.memory` (`formatId: 'import'`), keyed
`signs:<statement key>:<account id>`:

```ts
interface SignRecord {
  /** The import manager's own correction, for formats that can't keep one. */
  reverse: boolean
  /** Of the lines imported from this source into this account, the share that were money out (after any correction). */
  outShare: number
  /** How many lines `outShare` is based on (capped at 500, so it follows a source that changes slowly). */
  lines: number
  lastImportAt: string
}
```

- **Updated** whenever a statement from the source is applied to the account.
- **No record** is what makes an import the *first from this source into this account*, which is when the account's
  type counts as evidence.
- **Removed** with the account, as saved account matches are, and listed in F6's *Remembered choices*.
- **Cost**: one read and one write per statement, and a second pass of matching over at most 500 lines. Retaining the
  information is cheap, as hoped in review.

---

## QBO: QuickBooks Web Connect

### What a QBO file is

QuickBooks imports bank statements only as **Web Connect** files, `.qbo`. They are OFX 1.02 or 1.03 in SGML, as QFX
is, with Intuit's tags in the sign-on:

```
OFXHEADER:100
DATA:OFXSGML
VERSION:102
…
<OFX><SIGNONMSGSRSV1><SONRS>…<FI><ORG>Lakeside Credit Union<FID>2290</FI>
<INTU.BID>2290<INTU.USERID>lakeside-demo</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS>…<STMTRS><CURDEF>CAD<BANKACCTFROM><BANKID>…<ACCTID>…<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>…<STMTTRN>…<FITID>…</STMTTRN>…
```

`sgml.ts` already reads tags with dots (`[\w.]*`), and `statements.ts` ignores what it doesn't use. So a QBO file
reads today if it is renamed `.ofx`. The differences that matter:

| QBO trait | Handling |
|---|---|
| The extension | `import-ofx.ofx` gains `qbo`; label *OFX / QFX / QBO statement (Microsoft Money, Quicken, QuickBooks)*; description adds QuickBooks |
| `INTU.BID` is a QuickBooks institution number, and files made by converters may carry one that isn't the issuer's | Never used for the key, the label or the institution. `FI/ORG` and `BANKID` are, as for OFX |
| Business accounts, often with many lines a month | Nothing special: the import manager's scale tests cover 2,000 lines |
| **Made-up FITIDs** in files from conversion tools | [Below](#made-up-bank-ids) |

Because the key is built the same way (`ofx:bank:<BANKID>:<ACCTID>`, `ofx:card:<ACCTID>`), a user who downloads OFX
one month and QBO the next for the same account gets the same saved account match and the same bank ids, so nothing
is asked or doubled.

### Made-up bank ids

QuickBooks accepts nothing but QBO, so tools that turn a PDF or CSV statement into QBO are common. Their FITIDs vary:
some hash the line (stable, fine), and some number the lines of each file (`1`, `2`, `3`…), which collide from one
file to the next. `statementsOf` checks each statement's ids, and sets `stableIds: false` when either is true:

- **a counter**: the statement has at least 3 lines, every id is a plain number of at most 6 digits, and the ids,
  sorted, are consecutive (a run such as `1…n` or `1001…1040`);
- **not unique**: two different lines share an id. Today `convertLines` keeps only the first of them, as the bank
  sending one line twice, so a converter that reuses ids loses lines silently.

The statement then gives a warning: "The transaction ids in this file look made up (1, 2, 3…), so lines are
recognised by their content instead." The collision guard ([above](#bank-ids-that-collide)) catches what the check
misses. The check applies to every OFX file, not only QBO, because the same tools make QFX and OFX too.

Real FITIDs look nothing like a short consecutive run: they are long, or dated, or sparse. A bank whose real ids
happen to be consecutive loses nothing but exactness: its lines are known by fingerprint, which still recognises
re-imports.

---

## CSV

### What banks' CSV files look like

| Variation | Examples | Handled by |
|---|---|---|
| Delimiter | `,` `;` tab `\|` | Detection ([Reading rows](#reading-rows)) |
| Encoding | UTF-8 with or without a BOM, windows-1252, UTF-16 with a BOM (Excel's *Unicode text*, usually named `.txt`, so imported through *All files* and sniffing: [F-14](#decisions)) | `text('auto')` |
| Preamble | `Account,Chequing 5678` / `From,2026-10-01` / blank, then the header | `skip` in the layout |
| Header | Present (most), absent (some), in English or French | `header` in the layout; the header dictionary |
| Amounts | One signed column; **Money out** and **Money in** columns; an amount and a `DR`/`CR` (*Debit*/*Credit*) column; `12.50 CR` in the cell; parentheses; currency signs | Column roles, `direction`, `canonicalDecimal` plus `CR`/`DR` |
| Sign | Money out negative, or **positive** (many card exports) | `reversed` |
| Dates | `2026-10-05`, `10/05/2026`, `05/10/2026`, `05.10.2026`, `05-Oct-2026`, `Oct 5, 2026`; sometimes two date columns (transaction and posted) | `dateOrder`, month names, `date` and `userDate` roles |
| Decimal | `1,234.56` or `1 234,56` | `decimal` |
| Excel's marks | `="00123"` to keep leading zeros; a leading `'` | Stripped when reading a cell |
| Extra rows | A totals row, a *Balance forward* row with no amount, trailing blank lines | Left out: quietly when they have no amount, with a warning otherwise |
| Status | A *Status* column with *Pending* / *Posted* | `status` role: pending rows left out ([F-10](#decisions)) |
| Several accounts | An *Account Number* column | `account` role: one statement per account, strong keys ([F-7](#decisions)) |
| Currency | A *Currency* column | `currency` role: the statement's currency when every row agrees; otherwise the file is refused with a message |
| Running balance | A *Balance* column | `balance` role: the statement's closing balance, and a check of the rows' order |
| Row order | Oldest first or newest first | Worked out from the dates; it only matters for the balance |

### Reading rows

`csv.ts` reads RFC 4180 and what real files do beyond it:
- quoted cells with doubled quotes and embedded newlines;
- `\r\n`, `\n` or `\r` line ends;
- a trailing empty line;
- ragged rows (fewer or more cells than the header);
- stray spaces around quoted cells.

**The delimiter** is detected from the first 50 non-empty lines. For each of `,` `;` `\t` `|`, the cells per line are
counted (outside quotes), and the delimiter that gives the same count of 2 or more on the most lines wins. A tie is
broken in the order tab, `;`, `,`, `|`, because a semicolon file with comma decimals splits on commas too, but
unevenly.

### The layout

```ts
// plugins/import-csv/src/shared/layout.ts: used by both halves (the dialog's live preview runs the same code)
export interface CsvLayout {
  version: 1
  delimiter: ',' | ';' | '\t' | '|'
  /** Lines before the header (or before the first data row when there is no header). */
  skip: number
  header: boolean
  columns: {
    date: number                          // the posting date
    userDate?: number                     // the transaction date, when the file has both
    amount?: number                       // one signed column …
    debit?: number                        // … or money out …
    credit?: number                       // … and money in
    direction?: { column: number, debit: string[], credit: string[] }   // 'DR'/'CR', 'Debit'/'Credit'
    payee?: number
    memo?: number[]                       // several are joined with ' · '
    number?: number                       // a cheque number
    id?: number                           // the bank's transaction id; never guessed from 'Reference'
    balance?: number
    status?: { column: number, pending: string[] }
    currency?: number
    account?: number
    category?: number
  }
  dateOrder: DateOrder
  decimal: DecimalSeparator
  /** Money out is shown as positive: every amount is negated. */
  reversed: boolean
}
```

A layout is **valid** when it has a date column and either `amount` or `debit` and `credit`, no column has two roles,
and every index is inside the rows. The dialog can't confirm an invalid layout.

**The signature** identifies a layout across files:
- with a header, a SHA-256 of the delimiter and the header's cells, each trimmed, lower-cased and stripped of
  accents;
- without one, of the column count and each column's shape in the first rows (date, number, text or empty).

It is cut to 16 hex digits, as fingerprints are. Memory keys and the account key use it.

A headerless file's shapes can change from one month to the next: a month without deposits leaves the *Money in*
column empty. So when no layout is remembered for a headerless file's signature, the remembered headerless layouts of
the same width and separator are tried, and the first that reads the file ([fits](#what-the-dialog-starts-from)) is
used, with its own signature, so the account key stays the same.

### Guessing the layout

`guessLayout(rows)` (pure) works in two passes:

1. **The header dictionary.** The first row of data is the first with a date and a number, at the file's usual width.
   The nearest row above it whose cells are all words is the header, looking past blank rows and rows without a date
   (a *Balance forward* under the header), three rows up at most. The rows above the header are the preamble. Each header cell is looked up, normalised, in a table of known
   names, English and French to begin with:

   | Role | Names (examples) |
   |---|---|
   | `date` | *Date*, *Posted Date*, *Posting Date*, *Date Posted*, *Value Date*, *Date de l'opération*, *Date de valeur* |
   | `userDate` | *Transaction Date*, *Trans. Date*, *Date de transaction* (when a posting date is also present; otherwise it is `date`) |
   | `payee` | *Description*, *Payee*, *Merchant*, *Name*, *Details*, *Transaction Details*, *Description 1*, *Libellé*, *Bénéficiaire* |
   | `memo` | *Memo*, *Notes*, *Description 2*, *Additional Info*, *Remarque* |
   | `amount` | *Amount*, *Transaction Amount*, *Value*, *Montant* |
   | `debit` | *Debit*, *Withdrawal(s)*, *Money Out*, *Paid Out*, *Charges*, *Débit*, *Retrait(s)* |
   | `credit` | *Credit*, *Deposit(s)*, *Money In*, *Paid In*, *Payments*, *Crédit*, *Dépôt(s)* |
   | `balance` | *Balance*, *Running Balance*, *Solde* |
   | `number` | *Cheque Number*, *Check Number*, *Cheque #*, *Chq No*, *Numéro de chèque* |
   | `direction` | *Type*, *DR/CR*, *Debit/Credit*, when its values are only `DR`/`CR`, `D`/`C` or *Debit*/*Credit* |
   | `status` | *Status*, *État* |
   | `currency` | *Currency*, *Devise* |
   | `account` | *Account Number*, *Account*, *Numéro de compte*, when its values look like account numbers |
   | `category` | *Category*, *Catégorie* |
   | `id` | *Transaction ID*, *FITID*, *Unique ID* (never *Reference*: too often not unique) |

2. **The data.** Every guess is checked against the rows, and columns without a header are guessed from their
   contents:
   - "nearly all" of a column below means 90% of its filled cells, or all but two in a short file (a *TOTAL* row) as
     long as that is still 60%;
   - a date column must read as dates in one order for nearly all rows, and `guessDateOrder` on that column
     decides the order, or leaves it ambiguous;
   - amount columns must read as decimals, and `guessDecimal` decides the separator;
   - without a header, the date column is the first that reads as dates, the payee the text column with the most
     distinct values, and the amounts the number columns that aren't a running balance;
   - a balance column is a number column where each row's value is the previous row's plus the row's amount.

   The result carries, for each choice, whether it is **sure** or a **guess**, and why ("the dates could be
   day/month or month/day"). The dialog highlights the guesses.

**Signs.** Most lines in almost every account are money out. So when more than two thirds of a signed amount column
is positive, `reversed` is guessed true, and the dialog says why. It is always marked as a guess, because a savings
account can be mostly deposits. With *Money out* and *Money in* columns, or a direction column, the columns say the
sign, and nothing is guessed. With a balance column, the rows' order is worked out
from the dates, and the balance's own sign from whether it rises with the amounts or against them. The statement's
closing balance is then signed the Tessera way too. Once the account is known, the import manager's
[sign cross-check](#sign-cross-check) checks the result again. If the user reverses the amounts there, the CSV
format's `correct` hook flips the remembered layout's `reversed`, so the next CSV Columns dialog shows it.

### The CSV Columns dialog

`import-csv.dialog.layout`, size `lg`, opened through `context.prompt`.

```
┌ CSV Columns: October-activity.csv ─────────────────────────────────────────────────────────────────────────┐
│ Tessera guessed these columns. Check the preview, then Import: they'll be remembered for files like this.  │
│                                                                                                            │
│ Separator [Comma ▾]   Start at [Row 4 (header) ▾]   Dates [Day/Month/Year ▾] ⚠   Decimal [1,234.56 ▾]       │
│ [ ] Money out is shown as positive (amounts are reversed)                                                  │
│ ⚠ The dates could be day/month or month/day: every day in this file is 12 or less. Check the preview.      │
│                                                                                                            │
│  ┌──────────────┬─────────────────────────────┬──────────────┬──────────────┬──────────────┐               │
│  │ [Date     ▾] │ [Payee                ▾]    │ [Money out ▾]│ [Money in  ▾]│ [Balance   ▾]│               │
│  │ Date         │ Description                 │ Withdrawals  │ Deposits     │ Balance      │               │
│  │ 02/10/2026   │ CHQ#00101                   │ 1,200.00     │              │ -200.00      │               │
│  │ 05/10/2026   │ POS COSTCO WHSE #0123       │ 84.12        │              │ -284.12      │               │
│  │ 09/10/2026   │ PAYROLL NORTHERN LIGHTS     │              │ 3,000.00     │ 2,715.88     │               │
│  │ …            │                             │              │              │              │               │
│  └──────────────┴─────────────────────────────┴──────────────┴──────────────┴──────────────┘               │
│                                                                                                            │
│ What will be imported                                                                                      │
│   Oct 2, 2026    CHQ#00101                        −1,200.00                                                │
│   Oct 5, 2026    POS COSTCO WHSE #0123               −84.12                                                │
│   Oct 9, 2026    PAYROLL NORTHERN LIGHTS          3,000.00                                                 │
│   41 lines · Oct 1 – Oct 31, 2026 · closing balance 2,700.00 · 1 row left out ▸                            │
│                                                                                                            │
│                                                        [Skip This File]  [Cancel Import]  [Import]         │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Input**: the file's name, its **decoded text** (cut at a row's end past 2,000,000 characters, and said so), the
  guessed or remembered layout with its sure/guess marks, and, when a remembered layout no longer fits, why not. The
  dialog splits the text itself, so changing the separator splits it again, and its preview counts every row.
- **Options**: *Separator*, *Start at* (a row, shown with its first cells) with *Row N is the header*, *Dates*,
  *Decimal*, and *Money out is shown as positive*. They, and the role pickers, are MUI selects, whose menus follow the
  theme. (Native selects were tried first, for being light, but Windows draws their open list itself, and its
  highlight was hard to read in the dark theme.) A role picker with a doubt is outlined in the warning colour and says
  *A guess: check it*.
- **Column roles**: a drop-down (`TextField select`) over each column, listing every role and *Ignore*. Choosing a
  role another column holds moves it. *Money out* and *Money in* come as a pair.
- **The preview** runs the same `shared/` code as the privileged side, so what it shows is what will be imported:
  - signed amounts in the Money style (negatives in red, theme colours only), the line count, the period and the
    closing balance;
  - the rows that would be left out, and why (▸ opens the list).
- **Accessible**: each role picker is labelled by its column's header ("Role for column 3, Withdrawals"), the preview
  is a table, and the warnings are text, not colour.
- **Results**: *Import* → `{ kind: 'layout', layout }`; *Skip This File* → `{ kind: 'skip' }`; *Cancel Import* or
  Escape → no result. The format throws `CANCELLED` for no result, and resolves `undefined` for `skip`.
- **Import is disabled** while the layout is invalid, or while it would import no lines.
- **Import is the default button**, so when the layout shown is right, Enter confirms it. Focus starts on *Import*
  when the layout was remembered and still fits, and on the first uncertain choice otherwise.

### What the dialog starts from

The dialog is shown for **every** CSV file ([F-5](#decisions)). What it starts from, and what its first line says:

| Situation | Filled in with | The dialog's first line |
|---|---|---|
| A layout remembered for this signature, and it fits this file: every row is a line or left out quietly (a *Balance forward* or totals row), and at most 2% of rows are left out with a warning | The remembered layout | "Same columns as last time (files like this one, last imported 5 Nov 2026). Check the preview, then Import." |
| No layout remembered, and every choice of the guess is sure | The guess | "Tessera recognised these columns. Check the preview, then Import: they'll be remembered for files like this." |
| No layout remembered, and some choices are guesses | The guess, with those choices highlighted and explained | "Tessera guessed these columns. Check the highlighted ones…" |
| A layout remembered, but it doesn't fit (a column it needs is missing, or more than 2% of rows fail) | The remembered layout, with what fails | "These columns worked last time, but not for this file: column 4 (Deposits) is missing." |
| The same signature, but the remembered date order no longer reads the file (a `13` where a month was expected) | The remembered layout, with the order corrected by `guessDateOrder` and highlighted | "The dates in this file are day first; last time they were read month first. Check the preview." |

Together with the Account dialog, which a CSV file without an account column also gets every time (decision 10), a
CSV import whose layout and account are unchanged takes two presses of Enter.

What the dialog confirms is saved before `parse` returns, in the format's memory:

| Key | Value |
|---|---|
| `layout:<signature>` | `{ layout, lastUsed }`: the layout confirmed, and the day (for *last imported …*) |
| `signatures` | Every signature remembered, for the headerless search above |
| `key:<statement key>` | The signature whose layout made that statement key, so `correct` finds the layout for a `csv:account:…` key |

### From rows to statements

- **One statement**, or one per value of the `account` column.
- **Each row** becomes a line:
  - `date` (and `userDate`) read with the layout's order, with month names and a pivot;
  - `amount` from the amount column, or `credit − debit` with each taken as its absolute value, then negated when
    `reversed`, or signed by `direction`;
  - `payee`, `memo`, `number`, `category` as given;
  - `externalId` from `id`, when the layout has it.
- **Left out quietly**: empty rows, rows with no amount (*Balance forward*, totals), and rows with no date that say
  they are totals or balances (*Total*, *Opening balance*, *Solde reporté*…).
- **Left out with a warning**:
  - rows whose date or amount can't be read, by the file's line (the summary shows *Line 47: Left out: “TOTAL”
    isn't a date.*);
  - pending rows, counted together ("3 pending transactions were left out; they'll come with a later export, once the
    bank posts them").
- **`id` values that repeat** within the file set the statement's `stableIds: false`, with a warning.
- **The account**:

  | The file | `key` | `keyStrength` | `label` |
  |---|---|---|---|
  | Has an `account` column | `csv:account:<number>` | strong | *Account •••• 5678 (CSV)* |
  | Doesn't | `csv:layout:<signature>` | weak | *CSV file with columns Date, Description, Withdrawals, Deposits, Balance*; without a header, *CSV file with 5 columns: Date, Payee, Money out, Money in, Balance* |

  `accountNumber` is set from the column, with `numberIsPartial` when it is masked, so step 2 of account resolution
  (the account number) can find it. A weak key's label describes the file, not an account, so the import manager
  doesn't offer it as the name of a new account: the New Account form's name is left for the user (a CSV file says
  nothing about the account's name or type).
- **`currency`** from the `currency` column when every row agrees.
- **`balance`** from the chronologically last row's balance, signed as worked out above, `asOf` its date.
- **No `period`**: a CSV export doesn't state one. The Account dialog shows the lines' dates.

---

## QIF

### What a QIF file looks like

```
!Account
NMaple Chequing
TBank
^
!Type:Bank
D09/01'26
T1,000.00
POpening Balance
L[Maple Chequing]
^
D09/02'26
T-1,200.00
N101
PLandlord
LHousing:Rent
^
D09/05'26
T-84.12
PCostco
MWeekly shop
SFood:Groceries
$-64.12
SHousehold
$-20.00
^
```

Each record is lines of one-letter codes and values, ended by `^`. Lines starting with `!` begin a section or set an
option.

### Reading records

`qif.ts` (pure):
1. **Text**: `file.text('auto')`; line ends of any kind; trailing spaces trimmed; blank lines ignored.
2. **Sections**: a `!` line sets the current section. Its name is compared ignoring case and spaces (`!Type:Oth A`,
   `!type:othA`).
3. **Records**: fields are collected until `^`, or until the next `!` line or the end of the file for a last record
   without its `^`. Repeated codes (`A` address lines, split `S`/`E`/`$` groups) are kept in order.
4. **Each record is read by its section.** What can't be read becomes a warning with its line number, and the rest
   of the file imports.

### Sections

| Section | Handling |
|---|---|
| `!Type:Bank` | Statement lines; account type `chequing` |
| `!Type:CCard` | Statement lines; `creditCard` |
| `!Type:Cash` | Statement lines; `cash` |
| `!Type:Oth A` / `!Type:Oth L` | Statement lines; `otherAsset` / `otherLiability` |
| `!Type:Invst`, and an `!Account` whose `T` is an investment type (`Invst`, or the types Quicken writes for brokerage and retirement accounts, such as `Port`) | **Skipped**, one warning per section: "An investment account (“RRSP”) was left out: Tessera doesn't import investment transactions yet" |
| `!Account` | Sets the current account for the sections that follow: `N` name, `T` type, `D` description, `$` balance and `/` its date, when given. See below |
| `!Option:AutoSwitch` … `!Clear:AutoSwitch` | Quicken's whole-file export: the `!Account` records between them are an **account list** without transactions, and are read for their names and types only |
| `!Type:Cat`, `!Type:Class`, `!Type:Memorized`, `!Type:Prices`, `!Type:Security`, `!Type:Bill`, `!Type:Invoice`, `!Option:*` | Skipped quietly: lists and settings, not transactions |
| Anything else | Skipped, one warning per section name |

**Statements.** A new statement starts when a transaction section begins under a different `!Account` (or the first
one without any). A single-account file gives one statement. A Quicken whole-file export gives one per non-investment
account, in file order, and the Account dialog asks for each unsettled one (*Statement 3 of 12*).

### Fields

| Code | Meaning | Becomes |
|---|---|---|
| `D` | Date | `date` ([Dates](#qif-dates)) |
| `T` | Amount | `amount`. `U` (Quicken's copy of `T`) when `T` is missing |
| `P` | Payee | `payee` |
| `M` | Memo | `memo` |
| `N` | Number | Digits only → `number` and `kind: 'cheque'`. `ATM` → `kind: 'atm'`; `DEP`, `Deposit` → `'deposit'`; `EFT`, `XFER`, `TXFR`, `Transfer` → `'transfer'`; `Print`, `To Print` and anything else → nothing |
| `C` | Cleared (`*`, `c`, `X`, `R`) | Ignored: imported lines are marked `electronic`, as from any file |
| `L` | Category, or `[Account]` for a transfer; `/Class` may follow either | `category` for a category (class removed). For `[Account]`: `kind: 'transfer'`, no category |
| `S`, `E`, `$`, `%` | A split's category, memo, amount and percentage | The line keeps `T`, its total. The memo gains "Split: Food:Groceries 64.12 · Household 20.00", within the memo's length limit. No category hint |
| `A` | Address (up to six lines) | Ignored |
| `F` | Reimbursable business expense | Ignored |
| `1`…`7`, `I`, `Q`, `Y`, `O` | Investment fields | Only in skipped sections |

**The opening-balance record.** Quicken and Money begin an exported account with a record whose payee is *Opening
Balance* and whose `L` names the account itself (`L[Maple Chequing]`). It isn't a transaction at the bank. It is read
as the statement's **opening balance** instead of a line. The statement's `balance` is then the opening balance plus
every line, as of the last line's date, and the *Create a new account…* prefill therefore gets that opening balance
(prefill's rule: the balance less the sum of the lines). Into an existing account, it is simply not imported.

### QIF dates

QIF dates come in many dialects, and the file rarely says which:

| Written | Means | Rule |
|---|---|---|
| `10/05'26`, `10/ 5'26`, `1/ 5'2026` | 2026-10-05 (Quicken: the apostrophe marks the 2000s) | `'` before the year: a two-digit year is 20yy |
| `10/05/26` | 2026-10-05 or 1926? | Two-digit year with `/`: `isoDate` with `pivot` = this year + 10 |
| `10/05/2026`, `10-05-2026`, `10.05.2026` | Month first or day first? | `guessDateOrder` over **every** `D` in the file; if ambiguous, the remembered option or the dialog |
| `2026-10-05` | ISO | Always YMD |

Spaces used as padding (`10/ 5'26`) are removed before reading. The file's order is decided once, from all its dates
together, never record by record.

### Amounts and signs

- **Amounts**: `canonicalDecimal` with the file's decimal separator, decided by `guessDecimal` over every `T` (`1,234.56`
  vs `1.234,56`), or asked when every amount fits both.
- **Signs**: QIF from Quicken and Money signs amounts from the account's side, as Tessera does (a card's charges
  negative), so they pass through. Some banks' QIF card files write charges as positive. The
  [sign cross-check](#sign-cross-check) catches those once the account is known: on a card's first import, its type is
  evidence, so a file that is mostly payments is asked about. The answer is kept as the source's `reversed` option,
  through QIF's `correct` hook, and the next file is read reversed without a question. (The plan had QIF Options ask
  about the signs of every card's first file too. Built after F3, that would have asked without evidence, which review
  ruled out for the sign question: see [Phase F5 results](#phase-f5-results).)

### The account and its key

| The file | `key` | `keyStrength` | `name`, `label`, `type` |
|---|---|---|---|
| An `!Account` with `N`, or an opening-balance record naming the account (`L[Maple Chequing]`, as Money's one-account export has) | `qif:account:<name, normalised>` | weak ([F-8](#decisions)) | `name` and `label` from `N` or the record; `type` from `T` or the section, and *savings* for a bank account whose name says so |
| Neither | `qif:file:<stem>`, the file's name as the import manager keys a file (`fileNameStem`, import-api 1.6): `Checking 2026-10 (2).qif` → `qif:file:checking` | weak | `label` from the file's name; `type` from the section |

Every statement has a key the format made, so what it remembers (`options:<key>`) and what `correct` is told are the
same key.

QIF never has an account number, so step 2 of account resolution doesn't apply, and the Account dialog appears each
time with the remembered account chosen, unless *Don't ask again*.

### The QIF Options dialog

`import-qif.dialog.options`, size `sm`, opened through `context.prompt` only when one of these is true, and the
source's remembered options don't answer it:
- the dates can be read two ways (every day 12 or less);
- the decimal separator can be read two ways (every amount fits both, as `1,234` does).

```
┌ QIF Options: Savings.qif ─────────────────────────────────────────────────────────┐
│ Savings.qif can be read more than one way. Choose how, and files like it will be  │
│ read the same way.                                                                │
│                                                                                   │
│ Dates: every day in the file is 12 or less, so “01/08/2026” could be either       │
│   ( ) Month/Day/Year: 01/08/2026 is Jan 8, 2026                                   │
│   (•) Day/Month/Year: 01/08/2026 is Aug 1, 2026                                   │
│                                                                                   │
│                                         [Skip This File]  [Cancel Import]  [OK]   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

Only the questions that apply are shown. The order offered first is the one whose dates span the shortest time, as for
CSV. The answers are saved as `options:<key>` in `context.memory`, for each statement's key, so the next file from the
same source isn't asked again, unless its dates stop fitting the remembered order.

### Microsoft Money and Quicken exports

For a Tessera user coming from Money, QIF is the practical way to bring an account's history across. Money and Quicken
both export accounts as QIF. What this design does with such an export:
- each account's transactions, with payees, memos and cheque numbers;
- its **categories, when the ledger has the same ones** (Tessera's seeded categories use similar names, and a user can
  create the rest first). Where they differ from the payees' usual categories, the user chooses once which win
  ([Category hints](#category-hints)): for a first import from Money, usually the file's;
- its opening balance, for a new account.

What it does not do:
- transfers become ordinary lines on each side, not transfer pairs;
- splits become their totals, their parts written in the memo;
- reconciled marks become `E`;
- investments are left out.

Because it goes through the ordinary import, every line is known by fingerprint, so exporting again later adds only
what is new. And [duplicates across sources](#duplicates-across-sources) stops the overlap with the bank's own OFX
from being doubled. A user's payees in Money (*Costco*, *Hydro One*) are still alike enough to the bank's text
(*POS PURCHASE COSTCO WHSE #0123*: 0.91). A cheque's payee isn't (*Landlord* against *CHEQUE 101*), so cheques are
paired by their number ([F5](#phase-f5-results)).

---

## Anonymising real statement files

### What it is for

The CSV guesser, the QIF dialects and the OFX quirks should be tested on real files, and real files are full of
personal data: account and card numbers, the user's name and address, who they sent money to, what they earn and
spend. The tests need a real file's **shape**, not its contents:
- its layout, header names, preamble and quoting;
- its date and number formats, encoding and line ends;
- its tag order and id style;
- which payees recur, and that its balances add up.

`npm run anonymise` keeps the shape and replaces the contents ([F-13](#decisions)).

### Using it

```
npm run anonymise -- ~/Downloads/chequing-oct.csv ~/Downloads/chequing-nov.csv ~/Downloads/visa.qfx
        [--out tests/fixtures/import/real]   where to write (default: beside each file, as <name>.anon.<ext>)
        [--keep-amounts]                     leave amounts as they are (default: changed, balances kept consistent)
        [--shift-dates <weeks>]              move every date by whole weeks (default: dates kept)
        [--keep-institution]                 keep the bank's name and ids (default: kept; --hide-institution replaces them)
        [--keep-words <file>]                words to leave alone, such as well-known merchants, one per line
        [--map <file>]                       keep the mapping, to anonymise next month's file the same way
        [--allow-like <example>]             keep what the scan finds in values shaped like the example (AB12345678)
        [--allow <regex>] [--allow-file <f>] the same, as a regular expression, or a file of them
        [--check]                            scan files without changing them; exit 1 if anything is found
```

- **One run, one mapping.** Files anonymised together stay consistent with each other: the same payee gets the same
  made-up name, the same account number the same fake number, and the same FITID the same fake id. So two overlapping
  exports still overlap, which is what duplicate detection is tested on.
- **Originals are never changed.**
- **The mapping holds the originals**, so it is kept only in memory unless `--map` is given. The tool refuses a
  `--map` path inside the repository.
- **It prints a report** of what it replaced, by kind, never the original values ("1 account number, 14 payees,
  6 memos, 41 amounts; balances recomputed"), then a reminder to read the file before committing it.

### What is replaced, by format

The tool uses each format's own reader (bundled with esbuild, as `sample:archive` does) to find **what** each piece of
text is, and rewrites only those pieces. Everything else stays as it was, byte for byte.

| Format | Replaced | Kept |
|---|---|---|
| OFX, QFX, QBO | `ACCTID`, `BANKID`, `BRANCHID`; `NAME`, `MEMO`, `PAYEEID`, the `PAYEE` aggregate's address and phone; `USERID`, `INTU.USERID`, cookies and `TRNUID`s; `FITID`s (see below); amounts (`TRNAMT`, `BALAMT`) | Tags, header, `ORG` and `FID` (unless `--hide-institution`), `CHECKNUM` of up to 6 digits (a longer one is given another of its shape), `TRNTYPE`, currency, dates |
| CSV | Cells in the payee, memo, category, account and id columns of the guessed layout; cheque numbers longer than 6 digits; every cell of the preamble but dates; in a column the layout doesn't use, every text cell, numbers of 5 digits or more, and amounts; amounts and balances (a *Balance forward* row's too) | The header row (the layout corpus needs it), and its words wherever they appear; delimiters, quoting, padding and line ends; dates; debit/credit words, status and currency cells; cheque numbers of up to 6 digits |
| QIF | `P`, `M`, `A`, `E`; `!Account` `N` and `D`; categories not among Tessera's seeded ones (made-up names, same depth); `N` when it isn't a cheque number or words (a reference); amounts `T`, `U`, `$` and the opening balance | Section headers, codes, dates, `N` cheque numbers (6 digits at most) and words, `C`, seeded category names and their words wherever they appear, classes' shape |

**How things are replaced:**
- **Words in payees and memos** are replaced consistently with made-up words from a built-in list, keeping the case
  style and roughly the length. The payee noise words (`POS`, `PURCHASE`, `INTERAC`, `E-TRANSFER`, …), region codes and
  punctuation are kept, and store numbers become other digits of the same length. So
  `POS PURCHASE COSTCO WHSE #0123 OTTAWA ON` becomes something like `POS PURCHASE BRAMBLE FOLD #4817 LINDEN ON`: the
  same shape for the payee rules and fingerprints. Every other word is replaced, because a merchant's name and an
  e-transfer recipient's can't be told apart reliably. `--keep-words` lets the user keep a list of merchants, for a
  more realistic matching corpus.
- **Account numbers and ids** keep their length, character classes and masking (`XXXXXXXX3456` becomes `XXXXXXXX` and
  four other digits). Short numeric FITIDs (6 digits or fewer) are kept as they are, because they are the made-up
  counters F1 detects, and not personal.
- **Amounts** are changed by a factor between 0.8 and 1.25, chosen per distinct amount, so amounts that were equal
  stay equal (identical coffees, a repeated bill). They are rounded to the original's decimals and written in the
  original's style (grouping, decimal separator, sign, parentheses, currency sign). Balances are then **recomputed**:
  a CSV running balance in date order from a changed starting balance, OFX `LEDGERBAL` from the changed lines, and a
  QIF split's total from its parts. The file still adds up.
- **Dates** are kept by default: they aren't personal, and their ambiguity (every day 12 or less) is what date-order
  tests need. `--shift-dates` moves them by whole weeks, keeping weekdays, and warns if the shift changes whether the
  file's date order is ambiguous. A CSV date is written back as it was: its order, separators, year digits, English
  month names, and padding as the rest of its column pads (`02/10` or `2/10`).
- **A CSV file is read by the CSV format's own reader and guesser**, so what a column holds is decided the way the
  import decides it. Its rows are its lines: a pending row's amount isn't in the running balance, and doesn't move
  it. A totals row's amounts are changed one by one, so they no longer add up; the format leaves totals rows out
  anyway.

### The scan: refusing to write

After rewriting, the tool scans its own output before writing it. `--check` runs the same scan on any files.

| Looks like | Found by |
|---|---|
| Anything it replaced | Every original value it replaced (account numbers, ids, and payee and memo words of 4 letters or more), searched for in the output, ignoring case |
| A card number | 13 to 19 digits, with spaces or dashes allowed, passing the Luhn check |
| An account or reference number | A run of 7 or more digits that the reader didn't identify as a date, an amount or a kept id |
| An email address, a phone number | The usual shapes, North American and international |
| A postal code | Canadian (`K1A 0B1`), US ZIP and ZIP+4, UK postcodes |
| A social insurance or security number | `123-456-789`, `123-45-6789` |
| An IBAN | Two letters, two check digits, up to 30 letters and digits |

- **If anything is found, nothing is written.** The findings are printed with their line numbers, where they are (a QIF
  field, a CSV column, an OFX tag), masked except for their last two characters, and the **shape** of the value around
  them (letters as `A`, digits as `9`: `CA12345678` is `AA99999999`). The exit code is 1.
- A known false positive (a bank's public phone number in a preamble) can be allowed, and is then written as it is:
  - `--allow-like <example>`: values shaped like the example, letter for letter and digit for digit. The report prints
    the `--allow-like` for each finding's shape (`--allow-like AA99999999`), which can be typed as it is in any shell:
    no regular expression, nothing to quote;
  - `--allow <regex>`, for a pattern the shape can't say;
  - `--allow-file <file>`, one per line: `like <example>`, or a regular expression; `#` starts a comment.

  A pattern is tested against the finding and against the whole value around it, so `--allow '[A-Z]{2}\d{8}'` allows
  `CA12345678` although only its digits look like a number. Whatever was allowed is listed after the file is written,
  to be read before it is committed.
- The scan is a safety net, not a guarantee. The report still asks the user to read the file before committing it.

### A test that keeps fixtures clean

`tests/fixtures/privacy.test.ts` runs the scan's patterns (all but the first row, which needs the originals) over every
file in `samples/statements/` and `tests/fixtures/import/`. A file with something that looks personal then fails the
suite before it can be committed unnoticed. Made-up values that trip a pattern on purpose (the samples' account
numbers) are listed beside the test, each with a reason.

### Encodings and line ends

Bytes that aren't UTF-8 don't survive every copy: the [first Windows run](import-manager-design.md#fixes-after-the-first-windows-run)
lost a sample's accents. Git can also rewrite line ends. So an anonymised file whose encoding isn't UTF-8 or ASCII is
written as **UTF-8**, with a sidecar, `<name>.meta.json`, holding:

```json
{ "encoding": "windows-1252", "bom": false, "lineEnd": "\r\n" }
```

The test helper that reads fixtures rebuilds the original bytes from the sidecar, so a test sees exactly what the bank
sent. Real files go under `tests/fixtures/import/real/<format>/`, and `samples/statements/` stays made up and ASCII.

### Where it lives

- `scripts/anonymise.mts`, run as `npm run anonymise`.
- `scripts/anonymise/`: `ofx.ts`, `csv.ts`, `qif.ts`, `words.ts` (the made-up words and consistent replacement),
  `amounts.ts`, `scan.ts`. Everything but the command line is pure.
- Tested in `tests/scripts/anonymise.test.ts`.
- Built in steps: the tool, the scan and OFX in F1; CSV at the start of F4, right after `csv.ts` and `guess.ts`; QIF at
  the start of F5, right after `qif.ts`. Real files can then be collected before each guesser is tuned.

---

## How each format meets the import manager

| | OFX / QFX / QBO | CSV | QIF |
|---|---|---|---|
| Plugin | `import-ofx` | `import-csv` | `import-qif` |
| Extensions | `ofx`, `qfx`, `qbo` | `csv` (a `.txt` export through *All files* and sniffing) | `qif` |
| `sniff` | `OFXHEADER` or `<OFX>` | Delimited lines of equal width, first line not starting `!` or `<` | First non-blank line starts `!Type:`, `!Account` or `!Option:` |
| Statements per file | One per `STMTRS` / `CCSTMTRS` | One, or one per account number | One per account section |
| `key` | `ofx:bank:…` / `ofx:card:…` | `csv:account:<n>` or `csv:layout:<sig>` | `qif:account:<name>` or `qif:file:<stem>` |
| Strength | strong | strong / weak | weak |
| Ids | `FITID`, unless made up | A *Transaction ID* column, rarely; else fingerprints | Fingerprints |
| `balance` | `LEDGERBAL` | The last row's balance | Opening balance + lines |
| `period` | `DTSTART`–`DTEND` | None | None |
| `category` | None | A *Category* column | `L` |
| The format asks | Never | CSV Columns: every file, filled in | QIF Options: dates or decimals that read two ways |
| The format remembers | Nothing | `layout:<signature>` | `options:<key>` |
| `correct` (signs reversed) | Not provided: the import manager keeps the correction | Flips the layout's `reversed` | Flips the source's `reversed` |

Whatever the format, the import manager may then ask three things, each only when it applies:
- the **Account dialog** (decision 10: every time for weak keys, unless *Don't ask again*);
- **Amounts Reversed?**, when the [sign cross-check](#sign-cross-check) finds evidence;
- **Categories from the File**, the first time a file from a source gives categories the ledger has.

---

## Contract changes, together

`@tessera/import-api` **1.3.0** (phase F0), **1.4.0** (F2), **1.5.0** (F3), **1.6.0** (F5) and **1.7.0** (F6). Every
addition is optional, so 1.2 format plugins keep working unchanged.

```ts
// contract.ts
export interface ImportFile extends ImportSample {
  /** … 'auto': a byte-order mark, else UTF-8 when the bytes are valid UTF-8, else windows-1252. */
  text(encoding?: string | 'auto'): string
}

export interface ParseContext {
  signal: AbortSignal
  memory: FormatMemory
  windowId?: number
  log: Logger
  /** 1.3: opens this format's own dialog; the parse time limit is paused while it is open. */
  prompt<TResult = unknown, TInput = unknown>(dialogId: string, input: TInput, options?: { title?: string }): Promise<TResult | undefined>
}

export interface ParsedStatement {
  // … as before
  /** 1.3: false when this statement's bank ids can't be trusted; overrides the contribution's. */
  stableIds?: boolean
}

export interface StatementLine {
  // … as before
  /** 1.3: the file's category for the line, as a path ('Food:Groceries'); a hint, used only if the ledger has it. */
  category?: string
}

// helpers.ts (1.3)
isoDate(text: string, order: DateOrder, options?: { pivot?: number, monthNames?: boolean }): string | undefined
guessDateOrder(samples: string[], options?: { pivot?: number, monthNames?: boolean }): DateOrder[]
guessDecimal(samples: string[]): DecimalSeparator[]
// helpers.ts (1.6)
fileNameStem(fileName: string): string      // 'Checking 2026-10 (2).qif' → 'checking': the import manager's file-name key, for formats

// manager.ts
export interface ImportCounts {
  // … as before
  /** 1.3: lines whose bank id had named a different transaction before; imported by their content. */
  idConflicts?: number
  /** 1.4: lines proposed as already imported from another source; nothing added for them. */
  alreadyImported?: number
}

// model.ts (1.4)
export type MatchState = 'proposed' | 'accepted' | 'new' | 'unresolved' | 'duplicate'

// contract.ts (1.5)
export interface ImportFormat {
  // … sniff, parse as before
  /** The user reversed a statement's amounts: remember it for `key`; false if the format can't. */
  correct?(correction: { kind: 'signsReversed', key: string }, context: { memory: FormatMemory }): Promise<boolean>
  /** 1.7: how one of its remembered values reads in Saved Import Choices; undefined: not listed. */
  describeMemory?(key: string, value: unknown): { what: string, source: string, detail?: string } | undefined
}

// manager.ts (1.5)
export type StatementOutcome = /* … as before */ | 'needsConfirmation'   // interactive: false, and the signs look reversed
export interface StatementReport {
  // … as before
  /** 1.5: the amounts were reversed, by the user's answer now or a correction kept from an earlier one. */
  reversed?: { decidedBy: 'asked' | 'remembered', remembered: boolean }
  /** 1.3: new lines whose category came from the file, and the source's choice that decided conflicts. */
  categories?: { fromFile: number, choice?: 'file' | 'payee', remembered: boolean }
}

// protocol.ts
IMPORT_DIALOGS.categories   // 1.3: CategoriesDialogInput → { source: 'file' | 'payee', remember: boolean }
IMPORT_DIALOGS.signs        // 1.5: SignsDialogInput (the evidence, in words; two sample lines) → { reverse: boolean, remember: boolean }
```

Behaviour changes in the import plugin, with no type change:
- `ImportError('CANCELLED')` from `parse` stops the import;
- the parse time limit excludes time in `prompt`;
- the collision guard;
- category hints in drafts, and the source's category choice (`categories:<key>` in `import.memory`);
- *Already imported?* proposals (F2);
- the sign cross-check, and its retained `signs:<key>:<account>` records (F3).

---

## Alternatives considered

| Alternative | Why not |
|---|---|
| **A separate `import-qbo` plugin** | It would read exactly what `import-ofx` reads. Plugins can't share source, so the OFX reader would move to a `packages/ofx-kit` first: a refactor with no gain to the user, and two filters in the file dialog for one file type. The cost is small if it is ever wanted (for example to let a user disable QBO alone), and F1 keeps the QBO-specific code (made-up ids) in one place, which makes that move easy |
| **A second contribution `import-ofx.qbo`** with its own label, sharing the service | For a file with an unknown extension, both contributions would sniff *yes*, and the user would be asked to choose between two names for the same reader |
| **CSV: no dialog when the guess is sure** | A "sure" guess can still be a reversed sign or a swapped date order on a file where every day is 12 or less. The cost of a wrong guess (a month of wrong transactions, matched against the user's) is far higher than one confirmation ([F-5](#decisions)) |
| **CSV: the dialog only the first time a layout is seen**, and again when it stops fitting (the first proposal) | Turned down in review in favour of every file ([F-5](#decisions)). A bank can change what a column means without changing its header, and seeing the preview each time costs one key |
| **Categories: a fixed order** (the file's first, or the payee's first) | Turned down in review ([F-9](#decisions)): which is better depends on where the file came from, which only the user knows |
| **Categories: a setting on the Import options page** | A setting is per application, but the answer differs per source: a Money export and a bank's CSV in the same ledger want opposite answers |
| **CSV: the user names the bank, and layouts ship per bank** | A list of banks' layouts goes stale as banks change their exports, and needs real files from each. Guessing with a dictionary, confirming once and remembering works for banks nobody listed. Presets can still be added as fixtures for the guesser |
| **CSV: ask for the account first, then guess signs from its type** | The import manager resolves the account after `parse`, and changing that order for one format would complicate every format's flow. The [sign cross-check](#sign-cross-check) gets the same benefit, for every format, after the account is known |
| **Signs: the import manager always keeps its own correction**, even for CSV and QIF | The CSV Columns preview would then show the amounts one way and the import would bring them in the other. One owner per correction (`correct`) keeps what the user sees and what is imported the same |
| **Signs: always ask on the first import from a source** | It would add a question to every first OFX import, whose signs are almost always right. On a first import the account's type counts as evidence, so a card statement that looks reversed is still asked about |
| **Anonymising by hand, or with a generic text scrubber** | By hand misses things. A generic scrubber can't tell a payee from a header or an amount from an account number, so it either leaves personal data or destroys the dialect the file was collected for. Using each format's reader avoids both |
| **QIF: strong keys from account names** | Names collide across banks and users ("Checking"). A wrong strong key imports into the wrong account without asking |
| **QIF: read the cleared flag (`R`, `X`) as reconciled** | Reconciled means "agreed with a statement in *this* ledger". Marking imported lines reconciled would skip the user's own check, and `accounts` doesn't allow creating reconciled transactions (import manager decision on `match`) |
| **Duplicates across sources: add and flag, or leave out** | See [Why not the alternatives](#why-not-the-alternatives) |
| **Duplicates across sources: compare every line against every transaction, not only imported ones** | That is ordinary matching, which already handles the user's own entries. The new rule is deliberately narrow (both sides bank-reported, exact amount) so it stays precise |
| **A generic "import wizard" for all formats, in the import manager** | Only CSV needs columns mapped, and QIF's questions are different. Each format owning its dialog keeps the manager format-blind (import manager decision 3) |

---

## Risks

| Risk | Mitigation |
|---|---|
| **A CSV layout guessed wrong** (reversed signs, swapped dates) and confirmed without reading | The dialog highlights guesses and explains them ("every day is 12 or less"). The preview shows signed amounts and the closing balance, which a user can compare with the bank's website. The [sign cross-check](#sign-cross-check) checks the signs again once the account is known. Every line is reviewed in the register (decision 13). The dialog appears for every file, so a wrong layout is corrected on the next one, and Import History and Undo Import (import manager phase 4) remove a wrong import in one step |
| **Confirming becomes a habit**: the CSV Columns dialog every time, and the Account dialog every time for CSV, so the user presses Enter twice without looking | The dialog's first line says what changed, if anything ("These columns worked last time, but not for this file…"), and focus starts on the uncertain choice rather than *Import* whenever something is uncertain or no longer fits. The sign cross-check doesn't depend on the user looking |
| **The sign cross-check asks when the signs are right** (a card with many refunds, a user who typed entries with the wrong sign) | It is a question, and *Import them as they are* is one click. The answer updates the retained profile, so weak evidence doesn't fire again for that source. Strong evidence needs three or more pairs, and three times as many one way as the other |
| **The anonymiser leaves personal data in a file** | It replaces every word of payees and memos, not only names it recognises. Its scan checks the output against every original value it replaced and against the usual shapes of personal numbers, and it writes nothing when anything is found. `privacy.test.ts` runs the same patterns over every committed fixture. The report still asks the user to read the file before committing it |
| **Two accounts at one bank export the same CSV layout** (chequing and savings) | The key is weak, so the Account dialog asks every time with the last account chosen ([decision 10](import-manager-design.md#decisions)). The label names the columns, and the preview's balance helps tell the accounts apart |
| **QIF date order wrong in a file where every day is 12 or less** | Asked, never guessed. The answer is remembered per source and re-checked on every file |
| **Made-up ids not detected**, so a line is silently dropped | The collision guard compares what the id named before. The heuristic and the guard are tested on converter-style fixtures |
| **A real transaction proposed as *Already imported?*** (two identical purchases on nearby days, one from each source) | It is a proposal: nothing is lost, and *Change…* › *Add it as a new transaction* restores it. The rule needs an exact amount and alike payees. Identical lines *within* one file are numbered (`#n`), never proposed against each other |
| **Very large QIF or CSV files** (twenty years of Quicken history: 50,000 lines) | The 25 MB limit stays, and parsing is linear and well under the time limit. Importing holds the main process while matching (0.3 s per 1,000 lines against an empty account, recorded in todo.md as *Yield while matching*), so a whole history could freeze the window for many seconds. F5 measures a 50,000-line file; if the window stalls for more than a few seconds, yielding while matching is done before F5 ships |
| **Format plugins' dialogs break the import flow** (a dialog that never resolves) | The user can always close it (Escape). `prompt` resolves `undefined` and the format cancels or skips. Tests cover every result |
| **Windows-1252 vs UTF-8 guessed wrong** | `text('auto')` only chooses windows-1252 when the bytes aren't valid UTF-8, and a file that is windows-1252 with accents is almost never valid UTF-8. Samples with both encodings are built in the tests, as for OFX |
| **No real files to tune the guesser** | Real exports, anonymised with `npm run anonymise`, go into the layout corpus and the QIF fixtures. The tool arrives before each guesser is tuned (F1, then the start of F4 and F5). The guesser is built to be extended by adding a fixture and a dictionary entry |

---

## Later

Not scheduled; listed so the design leaves room for them.

| Item | Notes |
|---|---|
| **Save an anonymised copy, from the app** | For a user whose bank's file Tessera can't read: *Help › Save Anonymised Copy of a Statement…*, using the same modules as `npm run anonymise`, so the file can be sent with a bug report |
| **Excel files** (`.xls`, `.xlsx`) | A format plugin that turns the first sheet into rows, and reuses CSV's layout code and dialog |
| **Transfer pairs from a QIF whole-file export** | Both sides of a transfer arrive, in two accounts. Pairing them belongs with the import manager's *Transfer detection* (its Later table) |
| **A hint from the file name** | `chequing-5678.csv`: digits in the file name as a partial account number, for the Account dialog's ranking only, never as a key |
| **Per-bank CSV presets** | Only if the guesser falls short on real files: a preset is a layout fixture shipped as data |
| **A file's categories, beyond exact paths** | Money's defaults (*Groceries*, *Dining Out*, *Bills:Telephone*) rarely match Tessera's starter paths (*Food : Groceries*). Two ways, each needing a decision against [F-9](#decisions): a hint resolving by its last part when exactly one category has that name; or *Categories from the File* offering to create the file's categories that don't exist. Seen on the first real Money export ([F5](#phase-f5-results)) |

---

## Decisions taken in review

Decided on 2026-11-11, and applied throughout this note. No open questions remain.

| # | Question | Decision | Where it lands |
|---|---|---|---|
| 1 | QBO inside `import-ofx`, or its own plugin? | Inside `import-ofx`: agreed | [F-1](#decisions); [QBO](#qbo-quickbooks-web-connect) |
| 2 | When a file's category and the payee's usual one differ, which wins? | **The user decides, and the decision is remembered**, per source | [F-9](#decisions); [Category hints](#category-hints): the *Categories from the File* dialog, `categories:<key>`, *Change…* in the summary |
| 3 | Show the CSV Columns dialog the first time per layout, or every time? | **Every time.** A remembered layout, or a confident guess, is shown filled in, for confirmation | [F-5](#decisions); [What the dialog starts from](#what-the-dialog-starts-from) |
| 4 | *Already imported?*: add nothing until confirmed? | Agreed | [F-4](#decisions); [Duplicates across sources](#duplicates-across-sources) |
| 5 | A sign cross-check once the account is known? | **Yes, especially on the first import**, retaining what is needed if it isn't much work. It is one small record per source and account | [F-12](#decisions); [Sign cross-check](#sign-cross-check); phase F3 |
| 6 | Can real files be collected? | Yes, with **a tool that ensures personal data is removed** | [F-13](#decisions); [Anonymising real statement files](#anonymising-real-statement-files) |
| 7 | Should CSV claim `.txt`? | **No**: `.txt` files go through *All files* and sniffing | [F-14](#decisions) |
| 8 | (When F0 was started) | **Don't automatically accept categories from files**: a file's categories aren't used for a source until its user says so, even where a payee has no category of its own | [Category hints](#category-hints); [Phase F0 results](#phase-f0-results) |

Smaller choices made while applying them. Each is easy to change; flag any that are wrong:
- **The category question preselects nothing**, and *Remember* is ticked. The user decides (answer 2), and it happens
  once per source.
- **A remembered category choice can be changed from the import summary** (*Change…*), ahead of F6's list.
- **The sign question preselects *Reverse***, because it only appears when the evidence points that way.
- **A reversal has one owner.** A format that can remember it (CSV, QIF) does, through the new `correct` hook, so its
  own dialog shows the corrected setting next time. The import manager keeps it only for formats that can't (OFX).
- **On a first import, the account's type counts as evidence, but there is no question without evidence.** Always
  asking would add a question to every first OFX import, whose signs are almost always right.
- **A non-interactive import never reverses on its own**: a statement whose signs look wrong is reported as
  `needsConfirmation`, and not imported.
- **The anonymiser changes amounts by default** and keeps the balances adding up. Dates are kept by default, because
  their ambiguity is what date tests need.
- **The sign cross-check is its own phase, F3**, before CSV and QIF. So CSV, QIF and forgetting are now F4, F5 and F6.

---

# Part 2: Implementation

## Ground rules

The [import manager's ground rules](import-manager-design.md#ground-rules) apply:
- every phase ends with a working app and a green `npm test`;
- tests mirror the source folders;
- the architecture test keeps passing;
- `tsc --noEmit` adds no new errors;
- each phase ends with a manual smoke test in `npm run dev`, in light and dark themes.

Three more, for this work:
- **Format code is pure and test-first**: bytes or text in, statements or layouts out. Every parser and guesser is
  tested without a ledger, from fixture files and strings built in the test.
- **Every sample file is plain ASCII** (as for OFX), except the encoding tests' files, which the tests build from
  bytes.
- **Every dialog's result is tested through the format** (layout, skip, cancel), and the run is tested with the
  dialog answered by a fake `prompt`.

Sizes: **S** is about a day, **M** a few days, **L** about a week.

## Dependency graph and order

```
F0 (contract, groundwork) ─┬─► F1 (QBO; the anonymiser, for OFX)
                           ├─► F2 (duplicates across sources) ──► F3 (sign cross-check)
                           ├─► F4 (CSV) ──┐
                           └─► F5 (QIF) ──┴─► each released only once F2 and F3 are done
F4, F5, import manager phase 4 ──► F6 (remembered choices)
```

F3 uses F2's rule as one of its pieces of evidence, so it follows F2. Without F2 it would still work, with one piece
of evidence fewer.

**Recommended order: F0 → F1 → F2 → F3 → F4 → F5 → F6.**
- **F1 first after F0**: it is the smallest, it gives users something at once, and it exercises the per-statement
  `stableIds` and the collision guard on real-looking files. It also brings the anonymiser, so real files can be
  collected from then on.
- **F2 and F3 before F4 and F5**: CSV and QIF are fingerprint formats, and the ones whose signs are most often
  reversed ([F-11](#decisions)). Both phases are in the import manager, and are tested with the fixture format plugin
  and the OFX and QBO samples, without waiting for either format.
- **CSV before QIF**: CSV is far more common, and it builds the first format dialog through `prompt`, which QIF then
  reuses.

F4 and F5 can be built in parallel by two people once F0 is done, as long as neither ships before F2 and F3.

---

## Phase F0: contract and import-manager groundwork (M)

At the end of this phase OFX imports look the same as before, except for files that reuse ids. Format plugins can ask
the user without a time limit, distrust one file's ids, and hint categories, which are used only for a source the user
says to take them from. The import manager no longer drops a line whose id collides.

| Task | Files |
|---|---|
| `ParseContext.prompt`; `ParsedStatement.stableIds`; `StatementLine.category`; `ImportFile.text('auto')`; `ImportCounts.idConflicts`; `IMPORT_API_VERSION` 1.3.0 | `packages/import-api/{contract,manager,index}.ts` |
| `isoDate` options `pivot` and `monthNames`; `guessDateOrder`; `guessDecimal` | `packages/import-api/helpers.ts` |
| `prompt` in the run: `shell.prompts.show` with the run's window; the stopwatch replaces `within`'s timer, paused during `prompt`; resolves `undefined` once aborted | `plugins/import/src/privileged/run.ts` |
| `ImportError('CANCELLED')` from `parse`: outcome `cancelled`, and the run stops | `run.ts` |
| `'auto'` decoding | `plugins/import/src/privileged/files.ts` |
| Per-statement `stableIds` in `convertLines` | `convert.ts`, `run.ts` |
| The collision guard: `importedBefore` returns what each known bank id named (the line's `bank`, or the transaction); the collision rule; fingerprint fallback; the more-than-half rule; warning and count | `run.ts`, new `collisions.ts` (pure) |
| Category hints: resolve a path against `categories.list()`; used only under the source's `'file'` choice | `drafts.ts` |
| The source's category choice: `categories:<key>` in `import.memory` under `formatId: 'import'`; asked once per source, the first time its new lines have categories the ledger has; `interactive: false` uses the payee's | new `categoryChoice.ts`, `run.ts` |
| The *Categories from the File* dialog (`IMPORT_DIALOGS.categories`) | `renderer/CategoriesDialog.tsx` (new), `contributions.ts`, `manifest.json` (`renderer.expose`) |
| The summary shows `idConflicts`, and `categories` with *Change…* reopening the dialog | `renderer/SummaryDialog.tsx` |
| The test harness's `importFile` helper and fake `ParseContext` gain `prompt` and `'auto'` | `tests/plugins/import/harness.ts` |

Tests:

| File | Covers |
|---|---|
| `tests/packages/importApi.test.ts` (extended) | `pivot` around the boundary (`36`, `37` with pivot 2036); `'26` forms aren't `isoDate`'s job (QIF's); month names in English and French, with and without commas and dots; `order` breaking ties only; `guessDateOrder` (decided, ambiguous, none); `guessDecimal` (`1,234` both, `1,234.56` one, `12,50` one, mixed) |
| `tests/plugins/import/units.test.ts` (extended) | `'auto'`: BOMs, valid UTF-8 with accents, windows-1252 bytes with `é` and `’`, pure ASCII. Category paths: exact, case and spaces, a missing level, a transfer-like `[Savings]` ignored. Each row of the choosing table: neither, one, both the same, a conflict under each choice |
| `tests/plugins/import/categoryChoice.test.ts` (new) | No conflicts → no question; a conflict → asked once, with up to 5 examples and the count; *Remember* saves the choice and the next statement from the source isn't asked; unticked → asked again; another source → asked; *Cancel Import* stops; `interactive: false` → the payee's, with the count in the report; *Change…* from the summary saves a new choice for the next import |
| `tests/plugins/import/renderer/categoriesDialog.test.tsx` (new) | Nothing preselected, *Continue* disabled until a choice; the examples; the results |
| `tests/plugins/import/collisions.test.ts` (new) | Two of three disagree → collision; one → duplicate; no payees; a pruned line record (transaction comparison); the more-than-half switch; a fingerprint never checked |
| `tests/plugins/import/run.test.ts` (extended) | A fixture format that prompts: it answers after a (fake) 60 seconds and the import succeeds; a format that spins for 31 s of its own time still fails; `CANCELLED` stops later files; `skip` skips one. A fixture format with ids `1…5` in two files of different lines: with the guard, all ten are added, with five warnings; with per-statement `stableIds: false`, all ten are added silently |

**Exit criteria:** all tests green. In `npm run dev`, OFX imports behave exactly as before (the sample walkthrough's
numbers are unchanged, which `walkthrough.test.ts` checks). OFX files carry no categories, so the category question
is seen only through the tests until F4.

The test files as built differ from the table above: see [Phase F0 results](#phase-f0-results).

### Phase F0 results

Done on 2026-11-11. With only OFX and QFX installed, nothing looks different except for a file whose bank reused its
ids, which is now imported instead of dropped. The rest is ready for CSV and QIF:
- a format can ask the user without running out of time, and can cancel the import;
- a statement can say its ids can't be trusted;
- a file's categories are used only for a source whose user said so.

| Piece | Where | What it does |
|---|---|---|
| The contract, 1.3.0 | `packages/import-api/{contract,manager,protocol,index}.ts` | `ParseContext.prompt`; `ParsedStatement.stableIds`; `StatementLine.category`; `text('auto')`; `ImportCounts.idConflicts`; `CategorySource`, `CategoryExample`, `StatementCategories` and `StatementReport.categories`; `IMPORT_DIALOGS.categories` with `CategoriesDialogInput` and `CategoriesDialogResult`; `SummaryDialogResult.changeCategories` |
| Date helpers | `packages/import-api/helpers.ts` | `isoDate`'s `pivot` and `monthNames`; `guessDateOrder`, `guessDecimal`; `monthOf`, exported because formats can use it on a lone month column |
| The clock | `plugins/import/src/privileged/run.ts` (`ParseClock`) | Replaces the fixed timer: paused while `prompt` is open, pauses nest, and it never fires once the parse is over. `prompt` opens nothing once the parse was aborted, and ignores an answer that comes after |
| Cancel Import from a format | `run.ts` | `CANCELLED` from `parse`, or from the category question, reports the file or statement `cancelled` and stops the run |
| Reading | `files.ts` | `'auto'`: a byte-order mark, else strict UTF-8, else windows-1252 |
| The collision guard | `collisions.ts` (pure), `run.ts`, `convert.ts` | What each known id named (`import.lines`' bank line, or else the transaction); the rule; lines known by fingerprint instead (`convertLines`' `distrust`), or the whole statement when more than half collide; a warning per line, or one for the statement |
| Category hints | `convert.ts`, `drafts.ts` | The hint travels with the converted line but isn't kept with the bank's line. It resolves by path, part by part, with the accounts plugin's name key. It is used only under `'file'` |
| The category question | `categoryChoice.ts`, `run.ts`, `renderer/CategoriesDialog.tsx`, `service.ts` | Asked once per source, after the account is known and before anything is applied; remembered in `import.memory` under `formatId: 'import'`. *Change…* in the summary reopens it, saving or forgetting the answer |
| The summary | `renderer/SummaryDialog.tsx` | The collision count in the statement's sentence; a line about the categories, with *Change…* when the answer is remembered |
| Samples | `samples/statements/cedar-savings-2026-{09,10}.ofx`, README | A bank that restarts its ids every month, to see the guard by hand ([Ids a bank used before](../samples/statements/README.md#ids-a-bank-used-before)) |
| Guides | `plugin-creation.md`, `import-manager-design.md` | `prompt`, `CANCELLED`, `'auto'`, `stableIds` per statement, `category`, the date helpers; the collision rule where duplicates are described |

Where it differs from the plan, and why:
- **The collision rule changed.** As designed, "any two of date, amount and payee" made a collision. The first run
  test showed why that is wrong. A bank that numbers each file's lines from 1 gives next month's rent the id this
  month's had, with the same payee and amount: only the date disagrees, so the rent was taken for this month's sent
  again, and **dropped**. Now the date decides on its own (more than 3 days apart), or the amount and payee together.
  [Bank ids that collide](#bank-ids-that-collide) explains the rule.
- **The category question is asked whenever a file offers categories the ledger has**, not only when one differs from
  the payee's usual category. That was decided in review ("don't automatically accept categories from files"). A new
  payee with no usual category would otherwise have taken the file's without anyone being asked. Under
  *My usual category for each payee*, the file's category is never used, even where the payee has none.
- **Two-digit years only when the year comes last.** With a pivot, `10/05/26` also reads as 2010-05-26 in YMD, so
  `guessDateOrder` would have called almost every QIF file ambiguous.
- **`prompt` doesn't check that the dialog is the format's own.** Plugin ids can contain dots (`app.state`), so a
  format's id doesn't say where its plugin's id ends. The shell already requires a dialog's id to start with its
  plugin's id.
- **Drafting takes a `DraftLine`** (`importId`, `bank`, `category`), so the Change Match dialog's drafts, made from a
  stored line with no place in a statement, need no made-up line number.
- **Tests were arranged differently.**
  - Whole imports are in one new file, `groundwork.test.ts`, rather than `run.test.ts` and a `categoryChoice.test.ts`.
  - The renderer tests joined `renderer/dialogs.test.tsx`.
  - Time is tested with real timers and short limits (a 100 ms limit, a 400 ms answer) rather than fake ones. These
    can only get slower under load, never faster, so a busy machine can't make them pass wrongly.
  - The harness needed no change: `prompt` comes from the run, not from the test.
- **Not planned: the Cedar Credit Union samples**, so the one visible change can be tried, and screenshotted, by hand.
- The import plugin is **0.3.0**, and `@tessera/import-api` **1.3.0**.

Verification:
- **`tests/plugins/import/groundwork.test.ts`** (16 tests, new), the plugins activated together with fixture formats:
  - a dialog answered after four times the limit still imports;
  - 70 ms before and 70 ms after a dialog, against a 100 ms limit, still fails;
  - nothing opens once the time is up;
  - *Skip This File* and *Cancel Import* from a format's dialog;
  - two converter files whose ids restart, all eight lines added, and nothing added on a re-import;
  - one reused id among re-sent lines, named in its warning;
  - a corrected amount and a re-dated line still duplicates;
  - the Cedar samples through the real OFX plugin, ending at the bank's balance;
  - `stableIds: false` on a statement;
  - categories: none offered, nothing asked; asked once, with the input checked field by field; *My usual category*;
    each source asked for itself; *Cancel Import*; a non-interactive import; *Change…* saving and forgetting.
- **`tests/plugins/import/collisions.test.ts`** (8, new): each disagreement, the rule, next month's rent, fingerprints
  never checked, the more-than-half switch.
- **`tests/packages/importApi.test.ts`** (10 new, 28 in all): pivots at the boundary; years of 1 or 3 digits; names in
  both languages, cut short, with times, and ambiguous ones refused; `guessDateOrder` and `guessDecimal` in every case.
- **`tests/plugins/import/units.test.ts`** (7 new, 30 in all): `'auto'`; the hint kept, transfers and long paths
  dropped, line numbers; distrusted ids; category paths; never used by default; used under `'file'`; offers and
  examples.
- **`tests/plugins/import/renderer/dialogs.test.tsx`** (8 new, 21 in all):
  - the categories sentence in every case, and *Change…* only beside a remembered answer;
  - the collision count in the summary;
  - the Categories from the File dialog: its sentence and table, nothing preselected and *Continue* waiting, *Cancel
    Import*, and changing an answer.
- **`apply.test.ts`** lists the new dialog, and **`pipeline.test.ts`** checks that the built renderer exposes
  `./CategoriesDialog`.
- **Checking that the tests can fail:**
  - `prompt` not pausing the clock fails the long-answer test;
  - no collision guard fails three tests, the Cedar one among them: October then adds 0 and counts 5 duplicates, which
    is what happened before;
  - file categories by default fail the unit test;
  - `CANCELLED` treated as a failure fails the cancel test.
- **The full suite:** 155 files and 2,455 tests pass; 153 and 2,406 before. `tsc -p plugins` is clean, and
  `tsc -p tests` has only the errors listed in todo.md (*Stale imports from the restructure*), none in the import code.

**Not yet done: the manual check in `npm run dev`.** There is no display where this was built. The summary for the
Cedar samples, and the dialogs in light and dark themes, still need a person. Until a format gives categories (F4, F5),
the Categories from the File dialog can't be reached from the app, only from the tests.

---

## Phase F1: QBO, and the anonymiser (M)

At the end of this phase *File › Import…* lists and imports `.qbo` files, and `npm run anonymise` prepares real
OFX, QFX and QBO files for the tests.

| Task | Files |
|---|---|
| `extensions: ['ofx', 'qfx', 'qbo']`; the label and description; plugin version 0.2.0 | `plugins/import-ofx/src/privileged/index.ts`, `manifest.json` |
| Made-up id detection per statement (a counter, or not unique), setting `stableIds: false` with one warning | `plugins/import-ofx/src/privileged/statements.ts` |
| `INTU.BID` never used: covered by a test, as the code already ignores it | `tests/plugins/import-ofx/ofx.test.ts` |
| Sample files ([Sample files](#sample-files)) and the samples README | `samples/statements/` |
| **The anonymiser**: the command line, consistent replacement, amounts with recomputed balances, the scan and its refusal, sidecars for encodings and line ends; the OFX, QFX and QBO handler | `scripts/anonymise.mts`, `scripts/anonymise/{ofx,words,amounts,scan}.ts`, `package.json` (`anonymise`) |
| **The fixtures' privacy test**, with its allow-list for the samples' made-up account numbers | `tests/fixtures/privacy.test.ts` |
| The test helper that rebuilds a fixture's bytes from its sidecar | `tests/plugins/import/harness.ts` |

Tests:

| File | Covers |
|---|---|
| `import-ofx/ofx.test.ts` (extended) | The QBO sample: key, label (from `ORG`, not `INTU.BID`), type, lines, balance. The made-up-ids rules: `1…n`, `1001…1040`, one id on two different lines → `stableIds: false`; real-looking ids (long, dated, sparse, fewer than 3 lines) → unset. The converted October sample: every line kept, fingerprints used. The same rules on an OFX file |
| `import/run.test.ts` (extended) | The file dialog's filters include `qbo`. An OFX and a QBO file of **the same account** share one saved match, and the QBO file's overlapping FITIDs are duplicates. Two converter-style QBO files with ids `1…n` and different lines: every line is added, none is dropped |
| `tests/scripts/anonymise.test.ts` (new) | On every OFX sample and fixture, anonymised: no original account number, name, memo word or id remains; tags, header, dates and `CHECKNUM` are byte-identical; amounts differ but equal amounts stay equal; `LEDGERBAL` still equals the lines' sum plus the opening; two overlapping files anonymised together still share FITIDs and payees. The anonymised file still imports, with the same number of lines, duplicates and matches as the original. The scan: each pattern found, the refusal (nothing written, exit 1), `--allow`, `--check`; `--map` refused inside the repository |
| `tests/fixtures/privacy.test.ts` (new) | Every committed sample and fixture passes the scan's patterns; a planted card number and email fail it |

**Exit criteria (manual):**
- import `lakeside-business-2026-10.qbo` into a new account, then `lakeside-business-2026-11.qbo`: no dialog the
  second time, and only the new lines are added;
- import `maple-trust-chequing-2026-10-converted.qbo`: its 17 lines are added, and the summary says the ids looked
  made up;
- import it again: nothing is added (its lines are known by fingerprint);
- run `npm run anonymise` on a real OFX or QFX download, read the result, and import it.

### Phase F1 results

Done on 2026-11-11.
- *File › Import…* reads QBO files, and an OFX, QFX or QBO file whose ids a tool made up is recognised: its lines are
  known by their content, so none is lost.
- `npm run anonymise` takes the personal data out of real OFX, QFX and QBO files, keeping their dialect.
- A test keeps every statement the repository holds free of anything that looks personal.

| Piece | Where | What it does |
|---|---|---|
| QBO | `plugins/import-ofx/src/privileged/index.ts`, `manifest.json` | `qbo` beside `ofx` and `qfx`, the label *OFX / QFX / QBO statement (Microsoft Money, Quicken, QuickBooks)*, a description naming Web Connect; plugin 0.2.0. `INTU.BID` and `INTU.USERID` were already ignored, and a test now says so |
| Made-up ids | `statements.ts` (`madeUpIds`) | A counter (at least 3 lines, every id a plain number of at most 6 digits, consecutive once sorted), or one id on two different lines, sets the statement's `stableIds: false`, with one warning. A line sent twice, alike in everything, is still just a repeat |
| Where values are written | `sgml.ts` | `OfxNode.span`: each value's place in the text, entities and all, for tools that rewrite values in place. `declaredEncoding` moved here from `index.ts`, so the anonymiser decodes a file as the plugin does |
| The anonymiser | `scripts/anonymise.mts`; `scripts/anonymise/{index,ofx,words,amounts,scan,encoding,random}.ts` | As designed: `--out`, `--keep-amounts`, `--shift-dates`, `--hide-institution`, `--keep-words`, `--map`, `--allow`, `--check`. It reads every file of a run first, so nothing made up is any file's original and balances know every file's lines. Then it rewrites each file and scans it |
| Fixtures' privacy | `tests/fixtures/privacy.test.ts` | The scan over `samples/statements/` and `tests/fixtures/import/`, with the samples' made-up account numbers, a ticket number and a phone number allowed by name, each with its reason |
| Rebuilding bytes | `tests/helpers/importFile.ts` (`fixtureBytes`, `fixtureFile`) | A fixture's original bytes from its `.meta.json` |
| Samples | `samples/statements/lakeside-business-2026-{10,11}.qbo`, `maple-trust-chequing-2026-10-converted.qbo`; `tests/fixtures/import/qbo/converter-{a,b}.qbo` | As planned, with walkthroughs in the samples README |
| Guides | `tests/fixtures/import/real/README.md`, `README.md` | How to add a real file (anonymise, read, copy with its sidecar, run the tests); QBO and `npm run anonymise` in the README |

Where it differs from the plan, and why:
- **Balances are worked out across a run's files, not file by file.** The design said "OFX `LEDGERBAL` from the changed
  lines". Done file by file, two overlapping statements would each have been made to add up on their own, but not
  with each other: the account would end somewhere other than November's balance once both were imported. So every
  balance of an account moves by one offset for the account, plus the changes of every line the run knows up to the
  balance's date, whichever file the line is in. The mapping keeps these, so `--map` carries them to a later run. A
  test imports anonymised October and November and ends at anonymised November's balance.
- **What the scan looks at, precisely.** Each output character is marked:
  - *hidden*: tags, the header, dates, codes and the bank, which are never personal;
  - *from the original*: copied and not vetted, such as text outside any value, a comment, or a word kept with
    `--keep-words`.

  A shape (a card number, a phone number) is reported only where one of its letters or digits is from the original.
  So the tool's own made-up account numbers never stop it, while anything it couldn't see still does. The test plants
  a phone number, an email and a card number after `</OFX>` and in a comment, and each is found. A long number inside
  a card number or an IBAN isn't reported twice.
- **`--check` hides ids, and shows account numbers.** On committed files, FITIDs are made up or already anonymised.
  An account number is what a real file committed by mistake would give away, so it is flagged, and the samples'
  made-up ones are allowed by name.
- **Character references are kept as the original wrote them.** The Maple Trust sample writes *DÉPÔT* as
  `D&#201;P&#212;T`, a bank's word the anonymiser keeps. The first version wrote the letters themselves, so the
  ASCII file stopped being ASCII and needed a sidecar. Now a value that used references gets them back.
- **Small additions:**
  - the tool won't overwrite an existing output;
  - `--keep-institution` is accepted, as the default;
  - `seed` is an option of the module only, for the tests;
  - the report counts payees, memos, other text, amounts, ids and account numbers separately.
- **Not done as the plan listed:** the fixture helper is in `tests/helpers/importFile.ts`, beside `importFile`, not
  in the import harness. It serves the OFX tests too.

Verification:
- **`tests/scripts/anonymise.test.ts`** (24 tests, new):
  - October and November together: nothing personal left; every tag, the header and the spacing byte for byte; dates,
    types, cheque numbers and the bank kept; still ASCII; payees' shape; equal amounts equal; the overlap identical
    in both files;
  - **both imported, ending at the anonymised November's balance**, with the overlap a duplicate;
  - seeds; `--map` across two runs with balances agreeing;
  - a card's mask; a converter's counters kept and still detected; `--hide-institution`, `--keep-amounts` and
    `--shift-dates`; `--keep-words`;
  - windows-1252 with CRLF, and a byte-order mark, through their sidecars and back to the bank's bytes;
  - files it can't read yet;
  - the scan: things left where the reader couldn't see them, an original left behind, every pattern, the original
    and hidden rules, replaced words, `--allow`, masking, `--check`;
  - amounts' style and signs; words' case and shape; encodings;
  - **the command line itself**: output names, the report, a mapping outside the repository, no overwriting, a
    mapping inside the repository refused (exit 2), `--check` exiting 1.
- **`tests/fixtures/privacy.test.ts`** (3, new): every statement kept is clean; a planted card number and email are
  caught; every allowed value is still in its file.
- **`tests/plugins/import-ofx/ofx.test.ts`** (7 new, 22 in all): QBO read as OFX, never naming the bank from
  `INTU.BID`; QBO and OFX sharing a key; the made-up-id rules each way; the warning and `stableIds`; value spans.
- **`tests/plugins/import/run.test.ts`** (4 new, 27 in all): Lakeside in two months, ending at the bank's balance;
  a QBO file after an OFX file for the same account, with no dialog and the overlap recognised; the converted sample
  twice; the two converter fixtures, with all eight lines kept.

- **Checking that the tests can fail:**
  - without made-up-id detection, three tests fail. The converter pair still keeps its eight lines, thanks to F0's
    collision guard, but only after the ids clash;
  - balances worked out file by file fail the cross-file import and the `--map` test;
  - a scan reporting shapes whatever their origin refuses the tool's own output, failing four tests, the command line's
    among them.
- **The full suite:** 157 files and 2,493 tests pass; 155 and 2,455 before. `tsc -p plugins` and `tsc -p scripts` are
  clean, and `tsc -p tests` has only the errors listed in todo.md.

**Not yet done: the manual checks in `npm run dev`**, which need a display. Neither has running the anonymiser on a
real download, which needs a real file.

#### Fixes after the first Windows run

Three tests failed on Windows and passed here, and the anonymiser couldn't find a file that was there. Each had its
own cause:

| Failure | Cause | Fix |
|---|---|---|
| *keeps the dialect…*: a sidecar where none was expected; *npm run anonymise*: a `.meta.json` among the outputs | Git on Windows (`core.autocrlf`) checks the samples out with CRLF line ends. The anonymiser rightly wrote a sidecar saying so (`lineEnd: '\r\n'`, its carriage return invisible in the terminal). The tests assumed `\n` | The tests expect a sidecar exactly when the checked-out sample has CRLF. A copy of the repository with every text file converted to CRLF, as such a checkout has, now passes the whole suite (158 files, 2,498 tests). That is how this was found and checked here |
| *the Restore dialog › says what an archive file holds*: `Cannot read properties of undefined (reading 'invoke')` | A race in the tests, not in the app, and older than this phase. Thirteen renderer test files deleted the fake `window.api` in their own `afterEach`, which runs **before** the shared cleanup that unmounts what the test rendered (hooks run last-registered first). Unmounting runs a component's pending effects, and on a machine where the dialog's plan request came late, that effect found `window.api` gone. Reproduced here under the old order, now and then | `tests/setup/setupTests.ts` puts `window.api` back as it was before each test, **after** unmounting: a bridge the test added goes, and one that was there already (the preload's) stays. The thirteen files' own deletes are gone. `tests/setup/bridgeCleanup.test.tsx` fails every time under the old order (an effect's cleanup calls `window.api` at unmount), and checks that a bridge from before the tests is put back |
| `npm run anonymise`: *…bank1-checking.qbo doesn't exist*, for a file that was there | The file was `bank1-chequing.qbo`: a typo, which the message didn't help with. Also found: `npm run` runs scripts from the project's root, so a relative path given from another folder was looked for in the root | A missing file's message suggests the closest names in its folder (*Did you mean “bank1-chequing.qbo” or “bank1-checking.csv”…?*). Relative paths are read from the folder the command was run in (npm's `INIT_CWD`). Both are tested through the command line |

#### The first real files

Two real QBO downloads, anonymised by `npm run anonymise`, are kept in `tests/fixtures/import/real/ofx/`
(`bank1-chequing.anon.qbo`, with its sidecar, and `bank2-chequing.anon.qbo`). `realFiles.test.ts` reads each with its
original bytes rebuilt, imports it into a new account at the bank's balance, and imports it again to add nothing. A
new real file fails that test until it is described there. What they brought:
- **A period that ends before it starts.** `bank2` says `DTSTART 20261112`, `DTEND 20261111`, while its 63 lines run
  from Oct 13 to Nov 12, and the Account dialog would have shown "Nov 12 – 11". The OFX reader now drops a period like
  that, and the lines' dates stand for it.
- **How to check an anonymised file.** A scan of the anonymiser's output can't tell its made-up account numbers, ids and
  reference numbers from real ones: `bank2` has sixteen-digit made-up references in its payees, where the bank had
  card or account numbers. So a file named as the anonymiser names its output (`*.anon.*`) is checked, by `--check`
  and by the privacy test, only where the anonymiser keeps the original (codes, the bank, cheque numbers, stray
  text). A raw file, which isn't named so, is checked in full. Its own output then passes its own `--check`.
- Dialects the samples hadn't covered, all read cleanly:
  - one tag per line, with closing tags;
  - no bank name;
  - an available balance above the ledger balance;
  - newest first;
  - values followed by blank lines;
  - ids mixing digits, letters and dashes.

Not changed: no `.gitattributes` pins the samples' line ends. The tests now hold either way. Pinning them (`eol=lf`)
would make every checkout byte for byte the same, at the cost of a one-time renormalisation of existing Windows
checkouts. That is left for the repository's owner to decide.

---

## Phase F2: duplicates across sources (M)

At the end of this phase a line that looks like one already imported from another kind of file is proposed as
*Already imported?* instead of being added.

| Task | Files |
|---|---|
| `MatchState` `'duplicate'`; `ImportCounts.alreadyImported`; `IMPORT_API_VERSION` 1.4.0 | `packages/import-api/{model,manager,index}.ts` |
| The rule, pure: earlier lines in, one-to-one pairs out, with the conditions table | `plugins/import/src/privileged/matching/duplicates.ts` (new) |
| The words a pending line adds, ignored by the rule (not added to the payee noise words: see the results) | `matching/duplicates.ts` |
| In the run: earlier imported lines from the matching window's transactions (`byTransaction`), their batches' formats, the rule before `propose`, the proposals recorded with `duplicateOf` | `run.ts`, `apply.ts` |
| `import.lines.duplicateOf` (an optional field; no index, no schema version change) | `store.ts` |
| `lineState`: the `duplicate` view; reconciled targets stay pending | `lineState.ts` |
| The annotator: the mark, tone, icon, tooltips; a row already under review shows the duplicate mark | `annotator.ts` |
| Review: *Accept* skips the line with `review: 'done'` (and acknowledges an earlier line still pending on the same row); *Change…* › *Add it as a new transaction*; *Accept All*'s question | `review.ts` |
| The Change Match dialog's `duplicate` state and wording | `renderer/MatchDialog.tsx` |
| The summary's sentence | `renderer/SummaryDialog.tsx` |
| Standard icon `ContentCopy`; `@tessera/ui` minor version | `tessera-types/icons.ts`, `tessera-ui/standardIcons.ts` |

Tests:

| File | Covers |
|---|---|
| `matching/duplicates.test.ts` (new) | Each condition in the table, each way. Two trusted ids from the same format are never paired; a fingerprint and an id are; ids from two formats are. One to one with two identical lines on each side. Reconciled targets allowed. The order of pairing |
| `run.test.ts` (extended) | Maple Trust October through a **fixture fingerprint format**, then November's OFX: the 5 overlapping lines are *Already imported?*, nothing is added for them, the balance is right, and importing November again adds nothing. A pending-then-posted pair (different text and a day apart) is proposed. Two genuinely different same-amount purchases with different payees aren't |
| `review.test.ts` (extended) | *Accept* skips the line and changes nothing in `accounts`; *Add it as a new transaction* adds it, acknowledged; *Match it to another* works; *Accept All* counts and wording; an interrupted *Add* is settled by its carrier, as the other changes are |
| `annotator.test.ts` (extended) | The mark's text, tone and icon; a row with two lines under review; an earlier transaction deleted after the proposal → unresolved; reconciled → still pending |
| `renderer/matchDialog.test.tsx` (extended) | The `duplicate` state's options and wording |
| `archive.test.ts` (extended) | Archiving prunes a skipped duplicate line as it prunes other skipped lines, and a re-import after the archive date behaves as the archive rules say |

**Exit criteria (manual):** F2 comes before CSV and QIF, so the check uses F1's converter-style sample, whose made-up
ids make it a fingerprint source. Create an account from `maple-trust-chequing-2026-10-converted.qbo`, reconcile it,
then import `maple-trust-chequing-2026-11.ofx`:
- 5 rows show *Already imported?* on the reconciled transactions, and 5 new lines are added;
- *Accept* one; *Change…* › *Add it as a new transaction* on another, then *Don't import* it from its new row;
- *Accept All* the rest;
- import the November file again: nothing is added.

### Phase F2 results

Done on 2026-11-12. A line that looks like a transaction imported before from another kind of file is proposed as
*Already imported?* on that transaction, and nothing is added for it until the user says so. The register marks it,
with *Accept* (it is the same) and *Change…* (add it after all, or match it elsewhere).

| Piece | Where | What it does |
|---|---|---|
| The contract, 1.4.0 | `packages/import-api/{model,manager,index}.ts` | `MatchState` `'duplicate'`; `ImportCounts.alreadyImported` |
| The rule | `matching/duplicates.ts` (pure) | The conditions table; one to one, best first |
| The run | `run.ts`, `apply.ts`, `store.ts` | Earlier lines found through the transactions dated near the statement (their carriers, reconciled or not, not void, not already taken by another line's proposal), then by `byTransaction`; pairs recorded with `duplicateOf`, before matching; the rest matched and added as before. Every batch now records the format it came through, `plugin:<label>` for another plugin's statements, so later imports can tell sources apart |
| Where a line stands | `lineState.ts` | The `duplicate` view: on its transaction even when reconciled; unresolved when that is deleted or voided. A change that adds the line, or matches it elsewhere, ends it being a duplicate |
| The register | `annotator.ts` | The mark (warning tone, `ContentCopy`, the bank's line, both files' names, the date emphasised when it differs); *Accept* and *Change…* with their tooltips; the mark in place of the earlier line's own row; "possibly already imported" in the review bar |
| Review | `review.ts` | *Accept*, *Change…* › the same transaction, and *Don't import* all confirm the duplicate: the line is left out, nothing in `accounts` changes, and the earlier line is acknowledged if it was waiting. *Add it as a new transaction* is Unmatch's path. Matching elsewhere is as for any line. *Accept All…* counts and words them |
| The dialog | `renderer/MatchDialog.tsx` | The `duplicate` state: "It is the same as:", the transaction marked *already imported*, *It's a different transaction: add the bank line as a new one*, no *Don't import*, and no payee to remember when confirming |
| The summary | `renderer/SummaryDialog.tsx` | "5 looked like transactions imported before from another file and weren't added: check them in the register"; *Review in Register* for those alone |
| Payee names | `matching/payees.ts` | A new payee's name, and the bank's name shown in *Remember that…*, leave out *PENDING* and *PREAUTH* |
| Icon | `tessera-types/icons.ts`, `tessera-ui/standardIcons.ts` | `ContentCopy`; `@tessera/ui` 1.4.0 |
| Samples | `samples/statements/northwind-visa-2026-10-16-converted.qbo`, README | A mid-month card download with two pending lines; walkthroughs for the chequing account and the card |

Where it differs from the plan, and why:
- **Payees must be 0.75 alike, not 0.5.** A test found *PINE HARDWARE* and *CORNER BAKERY*, the same amount on the same
  day, paired at 0.55. Measured on real-looking pairs, the same payee written by two sources scored 0.82 and up (*AMAZON.CA*
  against *AMZN MKTP CA*), and unrelated names up to 0.70 (*HYDRO ONE NETWORKS* against *HOME DEPOT*). One pair scored
  0.87 (*CANADIAN TIRE* against *CANADA POST*, through their first words); it would also need the same amount within 3
  days. In matching, the payee is one signal among several; here it is what tells two same-amount purchases apart.
- **Pending words are ignored by the rule, not added to the payee noise words.** The noise words shape the normalised
  name fingerprints are made from, so adding to them would change the ids of lines already imported, and re-importing
  an old file would add its lines again. The rule strips them itself. A new payee's name (`tidyPayee`) and the bank's
  name shown to the user (`bankName`) leave them out too, so a pending line doesn't create *Pending Canadian Tire*.
- **Two bank ids pair only when both formats are known and differ.** Batches imported by another plugin recorded no
  format, so "from the same format" couldn't be told. They now record `plugin:<label>`, as account resolution names
  them. Older batches with no format count as the same format as anything, so nothing is paired wrongly.
- **Tests were arranged differently.** The run, the register, review and the README's walkthrough are in one new file,
  `alreadyImported.test.ts`, rather than in `run.test.ts`, `review.test.ts` and `annotator.test.ts`.

Verification:
- **`tests/plugins/import/matching/duplicates.test.ts`** (10 tests, new): each condition each way; payees only somewhat
  alike; missing payees; pending and pre-authorised words; bank ids from one format, from formats not known, and from
  two; fingerprints from the same format; one to one with identical coffees; the order of pairing; scores.
- **`tests/plugins/import/alreadyImported.test.ts`** (17, new):
  - the run: the converted October then the bank's November (5 proposed, 5 added, the bank's balance), reconciled
    targets, one to one, a re-import, the card's pending lines once posted, two OFX files from one bank, and different
    purchases;
  - the register: the mark, both files, its buttons, one row per transaction, the bar's message, a deleted
    transaction;
  - review: *Accept*, *Add it as a new transaction*, the same transaction and *Don't import*, another transaction, the
    dialog's list with the reconciled transaction first, *Accept All…*;
  - **the samples README's walkthrough, step by step**, for the chequing account and the card.
- **`archive.test.ts`** (2 new): archiving prunes the lines that looked already imported, accepted or still waiting,
  and re-importing both files afterwards adds nothing.
- **`renderer/matchDialog.test.tsx`** (1 new) and **`renderer/dialogs.test.tsx`** (1 new): the dialog's `duplicate`
  state; the summary's sentence and *Review in Register*.
- **`units.test.ts`** (1 new): payee names without pending words, fingerprints unchanged.
- **Checking that the tests can fail:**
  - without the rule, 14 tests fail;
  - with a reconciled transaction treated as lost, as an ordinary proposal's would be, 2 fail;
  - without the earlier line's row giving way to the mark, 2 fail.

**Not yet done: the manual walkthrough in `npm run dev`**, in light and dark themes:
[The same transactions from another file](../samples/statements/README.md#the-same-transactions-from-another-file).

---

## Phase F3: the sign cross-check (M)

At the end of this phase every import checks, once its account is known, that its amounts aren't reversed. It asks
when the evidence says they are, and it retains what it needs per source and account.

| Task | Files |
|---|---|
| `ImportFormat.correct`; `StatementOutcome` `'needsConfirmation'`; `StatementReport.reversed`; `IMPORT_DIALOGS.signs` and its types; `IMPORT_API_VERSION` 1.5.0 | `packages/import-api/{contract,manager,protocol,index}.ts` |
| The evidence and the decision, pure: matching both ways, the already-imported rule both ways, the balance equation, the account's type, the retained profile; the words for each | `plugins/import/src/privileged/matching/signs.ts` (new) |
| `SignRecord` in `import.memory` (`signs:<key>:<account>`): read before the check, updated after a statement is applied, deleted with the account | new `signRecords.ts`, `run.ts`, the `accounts.onDidChange` follower |
| In the run, after converting and dropping duplicates: apply a kept correction, gather the evidence, ask, reverse (then convert and check duplicates again), hand a remembered reversal to the format's `correct` or keep it; `needsConfirmation` when not interactive | `run.ts` |
| The *Amounts Reversed?* dialog | `renderer/SignsDialog.tsx` (new), `contributions.ts`, `manifest.json` |
| The summary's "Amounts reversed, as you chose", and the `needsConfirmation` outcome in words | `renderer/SummaryDialog.tsx` |

Tests:

| File | Covers |
|---|---|
| `matching/signs.test.ts` (new) | Each piece of evidence, each way, and its threshold (2 pairs isn't enough, 3 is; three times as many); the balance equation exact or silent, including an account with no history on the date; the type rule for cards, chequing and savings (none); the profile both ways; the decision table; the 500-line cap |
| `run.test.ts` (extended) | The Northwind card through a fixture format with its amounts negated, into an account holding a few typed charges: asked, with the evidence in words; *Reverse* imports them right, matches the typed charges, and the balance is the bank's. A first import into a new card account with no entries: asked on the type alone. A second, correctly signed import from the same source: not asked. A source whose files flip sign: asked on the profile. `interactive: false` → `needsConfirmation`, nothing imported. *Cancel Import* stops |
| `run.test.ts` (extended) | The correction's owner: a fixture format with `correct` gets the call and the import manager keeps nothing; one without it gets `reverse: true` kept, applied to the next file, and turned off by answering *Reverse* when the bank's files come right |
| `annotator.test.ts`, `review.test.ts` | Nothing changes for reversed statements once imported (they are ordinary lines) |
| `renderer/signsDialog.test.tsx` (new) | The evidence and the sample lines in the account's terms; *Reverse* preselected; the results |
| `apply.test.ts` (extended) | Deleting an account removes its sign records |

**Exit criteria (manual):**
- in a new ledger, import `northwind-visa-2026-10.qfx` into a new card account: no question;
- in another new ledger, create a credit card account, type three of October's charges, and import
  `northwind-visa-2026-10-reversed.qfx` into it: the *Amounts Reversed?* question appears, saying the typed charges
  match only when the amounts are reversed;
- *Reverse*: the three charges are proposed as matches, the rest are added as charges, and the balance is the bank's
  (owing 464.77);
- import the reversed file again: no question (the kept correction applies), and nothing is added.

### Phase F3 results

Done on 2026-11-12. Every import checks, once its account is known, that its amounts aren't the wrong way round, and
asks (*Amounts Reversed?*) only when the evidence says they are. Reversing imports them right. The answer is kept for
the source and account: by the format when it can keep it, by the import manager otherwise. What the source's files
are like is retained to catch one that runs the other way.

| Piece | Where | What it does |
|---|---|---|
| The contract, 1.5.0 | `packages/import-api/{contract,manager,protocol,index}.ts` | `ImportFormat.correct` and `FormatCorrection`; `StatementOutcome` `'needsConfirmation'`; `StatementReport.reversed` (`{ decidedBy, remembered }`, not the plan's boolean, so the summary can say how); `IMPORT_DIALOGS.signs` with `SignsDialogInput`, `SignExample`, `SignsDialogResult` |
| The evidence | `matching/signs.ts` (pure) | `bothWays`, `balanceSays`, `typeSays`, `profileSays`, `shouldAsk`, and each piece in words |
| What is kept | `signRecords.ts` | `SignRecord` in `import.memory` (`signs:<key>:<account>`); the profile weighted by lines, capped at 500; forgotten with the account |
| The run | `run.ts` | The line preparation (converting, collisions, duplicates) is its own step, run again after a reversal. The check comes after it and before matching: a kept correction applied first; matching and earlier imports both ways over at most 500 new lines; the balance; the type on a first import, the profile after. Then the question, the reversal, the correction's owner (`correct`, or the record), and an account made from the statement reopened at the reversed balance. `needsConfirmation` when the import can't ask |
| The dialog | `renderer/SignsDialog.tsx` | As designed: the reasons, two lines both ways in the account's terms, *Reverse* chosen, *Remember* ticked, a note when a kept correction is in force |
| The summary | `renderer/SummaryDialog.tsx` | "Amounts reversed, as you chose; files like this one will be too" (or "this time", or "as you chose for files like this one"); the `needsConfirmation` outcome as a warning |
| Samples | `samples/statements/{northwind-visa-2026-10-reversed.qfx, northwind-visa-2026-11.qfx, maple-trust-chequing-2026-11-reversed.ofx}`, README | A reversed card statement, the card's next month the right way round, a reversed chequing month; a walkthrough for each |

Where it differs from the plan, and why:
- **An account made from the statement.** The Account dialog makes the account before the check can run, from the
  statement as read, so a card made from a reversed file opened at +540.00 instead of owing 540.00. When the answer is
  *Reverse*, such an account gets the opening balance the reversed statement gives, unless the user changed the form's
  figure. The plan didn't mention it; the walkthrough's first step found it.
- **No balance evidence for an account made from the statement.** Its opening balance came from this statement, so
  the balance always agreed as read. That strong *as read* silenced the account type's weak *reversed*, on exactly
  the first import the type is for. Only the check's own tests showed this.
- **Which lines each piece looks at.** Matching, earlier imports and the balance use the lines not imported before,
  the ones the account will take. The type and the profile describe how a source writes its amounts, so they use all
  of the statement's lines.
- **A card's balance in words** is what the user owes: *"…the bank's balance on Nov 30, 2026 (you owe 163.26)…"*, not
  *-163.26*.
- **Tests were arranged differently.** The run's cases are in a new `signs.test.ts`, not in `run.test.ts`. Deleting an
  account and its records is there too, not in `apply.test.ts`. `annotator.test.ts` and `review.test.ts` didn't need
  changes: a reversed statement's lines are ordinary lines.
- **One more sample than planned:** `northwind-visa-2026-11.qfx`, the right way round, so the kept correction can be
  seen coming off.

Verification:
- **`tests/plugins/import/matching/signs.test.ts`** (14 tests, new): each piece each way at its thresholds (2 pairs
  aren't enough, 3 are; three times as many; exactly two thirds and exactly 80% aren't enough; savings and the rest say
  nothing); the balance exact or silent; the profile both ways, and its weighting past the cap; the decision table; the
  words.
- **`tests/plugins/import/signs.test.ts`** (13, new):
  - a card statement and savings the right way round, no question;
  - the reversed card into a new account, asked on the type alone, with the dialog's input checked field by field, the
    account reopened owing 540.00, and the card owing 464.77;
  - the next reversed file, no question;
  - with charges typed, matching as well, and three matches;
  - November reversed after October, asked on the balance and the profile;
  - *Import them as they are*; *Remember* unticked; *Cancel Import*; `needsConfirmation`;
  - the correction's owner: a format that keeps it, told and reading the next file right; the import manager
    otherwise, until the bank's files come right and the question takes it off;
  - records forgotten with the account.
- **`renderer/dialogs.test.tsx`** (6 new): the dialog's sentence, reasons and table, what is chosen to begin with, the
  three answers, the note; the summary's lines.
- **`apply.test.ts`** lists the new dialog, and **`pipeline.test.ts`** checks the built renderer exposes
  `./SignsDialog`.
- **Every earlier test passes unchanged:** no statement in the samples, fixtures or corpus was asked about when it
  shouldn't have been.
- **The full suite:** 163 files. 161 pass outright. Two files had tests pass Vitest's 15-second limit under load, both
  shell dialogs that don't touch importing: the account dialog, already noted in [the todo list](todo.md), and the
  Fonts page. Both files pass when run alone. `tsc` is clean for `plugins` and `scripts`, and `tests` has the same 28
  errors as before, none of them in import code.
- **Checking that the tests can fail:**
  - never asking fails 9 tests;
  - not reopening an account made from the statement fails 2;
  - the balance evidence for such an account fails 5;
  - the format never told fails 1.

**Not yet done: the manual walkthrough in `npm run dev`**, in light and dark themes:
[Amounts the wrong way round](../samples/statements/README.md#amounts-the-wrong-way-round).

---

## Phase F4: CSV (L)

At the end of this phase *File › Import…* reads banks' CSV exports. Every file's layout is shown for confirmation: guessed
the first time, then remembered.

### Files

```
plugins/import-csv/
├── manifest.json                 id "import-csv"; provides import-csv.format;
│                                 renderer.expose { "./LayoutDialog" }
└── src/
    ├── shared/                   pure, used by both halves
    │   ├── csv.ts                rows from text: quotes, newlines in cells, delimiters (detected), Excel's ="…"
    │   ├── cells.ts              (built) dates and amounts in a cell; sums as whole numbers
    │   ├── layout.ts             CsvLayout, validity, signature
    │   ├── dictionary.ts         header names by role, English and French; pending words
    │   ├── guess.ts              guessLayout(rows): header and preamble, roles, date order, decimal, signs, balance
    │   ├── lines.ts              rows + layout → statements, left-out rows with reasons; the preview uses it too
    │   ├── fit.ts                (built) whether a remembered layout still reads a file
    │   └── dialog.ts             (built) the dialog's input and result, and its first line
    ├── privileged/
    │   ├── index.ts              the contribution { extensions: ['csv'] }, the service (sniff for .txt and other
    │   │                         names through All files; correct), the dialog contribution
    │   └── parse.ts              text('auto') → rows → remembered layout or guess → the dialog, every file →
    │                             statements; saves the confirmed layout, and which layout made each statement key
    └── renderer/
        └── LayoutDialog.tsx      the options, a role picker per column, the rows, the live preview, the results
```

### Tasks, in order

1. **`csv.ts`**, test-first against hostile input: quotes, BOMs (already removed by `text`), `\r\n` and `\r`, a
   trailing empty line, ragged rows, `="00123"`, a semicolon file with comma decimals.
2. **`layout.ts`**: validity and the signature.
3. **The anonymiser's CSV handler** (`scripts/anonymise/csv.ts`), on `csv.ts` and a first `guess.ts` that finds the
   payee, memo, account and amount columns. Real exports can then be collected and anonymised while the guesser is
   being built.
4. **`dictionary.ts` and `guess.ts`**, test-first from the layout fixture corpus (below): header and preamble, roles
   from names then data, headerless files, date order and decimal, `reversed` from the share of positives, the
   balance column and the rows' order.
5. **`lines.ts`**: amounts in every form (`CR`/`DR`, parentheses, two columns, direction column, reversed), dates with
   month names and the pivot, pending rows, quiet and warned left-outs, `account` splitting, `currency`, `balance`,
   `id` with the repeat rule.
6. **`parse.ts`**: the remembered layout and whether it fits; the dialog for every file, starting from what the table
   in [What the dialog starts from](#what-the-dialog-starts-from) says; `skip` and `CANCELLED`; saving the layout.
7. **`correct`**: a reversal from the sign cross-check flips the `reversed` of the layout that made the statement's
   key.
8. **`LayoutDialog.tsx`**: as designed, with the preview from `lines.ts`, the first line for each starting point, and
   focus on *Import* or on the first uncertain choice.
9. **Samples**, the samples README, and `plugin-creation.md` (the CSV plugin as the example of a format with a
   dialog).

### Tests

| File | Covers |
|---|---|
| `import-csv/csv.test.ts` | The parser's edge cases; delimiter detection, including ties |
| `import-csv/guess.test.ts` | The **layout corpus**: each fixture's guessed layout equals its expected one, and each guess is marked sure or not as expected. Headerless files; preambles; French headers; two date columns; direction columns; reversed signs; balance order both ways |
| `import-csv/lines.test.ts` | Rows to lines for every amount form; left-outs and their reasons; pending; several accounts; mixed currencies refused; `id` repeats → `stableIds: false`; closing balance newest-first and oldest-first |
| `import-csv/parse.test.ts` | The dialog on **every** file: first sight → the guess, with its sure/guess marks; remembered and fitting → the remembered layout, with *Same columns as last time*; remembered and failing → with the reason; changed date order → corrected and highlighted. The saved layout; `skip`; `CANCELLED`; the keys (weak by layout, strong by account) and labels; the signature stable for the same header and different for another. `sniff`: a CSV named `.txt` says yes, a QIF or OFX file says no. `correct` flips the right layout's `reversed` |
| `import-csv/renderer/layoutDialog.test.tsx` | Picking roles (and moving one held elsewhere); the preview follows every option; invalid layouts can't be confirmed; the warnings; each starting point's first line; focus on *Import* for a remembered layout that fits, on the first uncertain choice otherwise, and Enter confirming; the three results; labels for screen readers |
| `tests/scripts/anonymise.test.ts` (extended) | Every CSV sample and corpus file: header, preamble shape, delimiters, quoting, dates and line ends kept; payee, memo, account and id cells and preamble text replaced; the running balance still adds up; the scan passes |
| `import/run.test.ts` (extended) | With the built-in dialog answered: a CSV import shows the Account dialog with the last account chosen; *Don't ask again* makes the next one silent; overlapping CSV exports add nothing twice; a CSV with an account column is found by number with no Account dialog; CSV then OFX for the same account → *Already imported?* (F2); a card CSV confirmed without *reversed* into a card account → *Amounts Reversed?* (F3), and after *Reverse* the next file's CSV Columns dialog shows *reversed* ticked; a `.txt` CSV through *All files* |
| `pipeline.test.ts` (extended) | The **built** `import-csv` activates, contributes its format and dialog, and its renderer exposes `./LayoutDialog` |

**The layout corpus** (`tests/fixtures/import/csv/layouts/`): one small file per layout (header or none, preamble,
three to six rows), each with a `.expected.json` of the layout and its sure/guess marks. It starts with the sample
files' layouts and made-up ones for each variation in the table above. Each real bank's layout is added as its export
is collected and anonymised (`npm run anonymise`, real files under `tests/fixtures/import/real/csv/`). A README says
how to add one, as for the matching corpus.

**Exit criteria (manual):**
- import two monthly CSV exports of one account, with one overlapping week: the CSV Columns dialog is shown both
  times, the second time with *Same columns as last time* and Enter confirming; the Account dialog each time with the
  account chosen; the overlapping week isn't doubled;
- import the French semicolon sample: the dates and comma decimals are read, and the dialog says it recognised the
  columns;
- import the card sample: the dialog guesses *amounts are reversed* and says why; the register shows charges as
  charges;
- import the two-account sample: no Account dialog, each account found by its number;
- rename a CSV sample to `.txt`: it isn't listed under *All supported statements*, and imports through *All files*;
- anonymise a real CSV export with `npm run anonymise`, read it, and import it.

### Phase F4 results

The pieces:

| Piece | Where |
|---|---|
| Rows from text: quotes, line breaks in cells, every line end, ragged rows, Excel's `="00123"`, `'00123` and `'…'`; each cell's place in the text; the delimiter detected | `plugins/import-csv/src/shared/csv.ts` |
| Cells: dates in an order (month names, two-digit years), amounts with `CR`/`DR` before or after, and sums as whole numbers (`BigInt`), never floats | `shared/cells.ts` |
| `CsvLayout`, its roles and their names, `withRole` (as the pickers set them), `problemsOf`, `signatureBasis` | `shared/layout.ts` |
| Header names by role, English and French; debit/credit words; pending words; currency codes | `shared/dictionary.ts` |
| `guessLayout`: header and preamble, roles from names then data, headerless files, two date columns, direction, currency, status and account columns, the amount columns worked out together with a running balance, date order, decimal, reversed; each doubt with its reason | `shared/guess.ts` |
| `readLines`: rows to statements, what is left out and why, pending rows, one statement per account, currency, the closing balance from the rows' order and the balance's sense; `balanceFit` | `shared/lines.ts` |
| Whether a remembered layout still reads a file, and whether only its date order changed | `shared/fit.ts` |
| The dialog's input, result, and first line for each starting point | `shared/dialog.ts` |
| `parse` (the starting point, the dialog on every file, the statements, what is remembered), `correct`, `sniff` | `privileged/parse.ts`, `privileged/index.ts` |
| CSV Columns | `renderer/LayoutDialog.tsx` |
| The anonymiser's CSV handler: cells by their column's role, running balances worked out again across files (a *Balance forward* row too), dates moved in their own style, `checkableCsv` | `scripts/anonymise/csv.ts`; `index.ts` and `words.ts` (header words kept, totals words kept) |
| A weak key's label isn't offered as a new account's name | `plugins/import/src/privileged/accountResolution.ts` |
| The layout corpus: 21 made-up layouts, each with its expected guess | `tests/fixtures/import/csv/layouts/` and its README |
| Samples: October and November chequing (header, pending row), French with a preamble, a headerless card with charges positive, two accounts in one file | `samples/statements/*.csv`, and the README's [CSV files](../samples/statements/README.md#csv-files) |
| Real CSV exports: the test reads and imports them once they are added, and checks their guessed layout | `tests/plugins/import/realFiles.test.ts`, `tests/fixtures/import/real/README.md` |

Where it differs from the plan, and why:
- **The dialog gets the file's text, not its first 200 rows.** Changing the separator splits the file again, and the
  preview's line count, dates and closing balance are the whole file's. Past 2,000,000 characters the text is cut at a
  row's end and the preview says it counts only that part.
- **A header is found by looking up from the first row of data**, past blank rows and rows without a date, rather than
  as the first row of words. A *Balance forward* row between the header and the data hid the header otherwise.
- **"Most rows" allows two odd cells in a short file.** A 90% rule made a three-row file with a *TOTAL* row lose its
  date column. A column now counts when 90% of its filled cells fit, or all but two of them, if that is still 60%.
- **Rows that say they are totals or balances, and have no date, are left out quietly**, not warned about: *Total*,
  *Opening balance*, *Solde reporté*…
- **A headerless file's remembered layout is found even when a column's shape changed** (a month with no deposits), by
  trying the remembered headerless layouts of the same width; the account key stays the same. The plan's signature
  alone would have treated such a month as a new kind of file.
- **Money out is the left column of a pair**, as banks write them, and that is marked as a guess in a headerless file.
  A running balance can't decide it: a chequing account's balance and a card's balance owed both fit one way round.
- **Warnings say *Left out: …*** with the file's line, since the summary already writes *Line 47:*.
- **The New Account form isn't given a CSV file's label as the account's name** (*CSV file with columns Date, …*).
  A weak key's label describes the file; the user names the account. This is the one change in the import plugin.
- ***Start at* has a *Row N is the header* box beside it**, rather than listing each row twice (as the header, and as
  the first row of data).
- **One more sample than planned:** `maple-trust-chequing-2026-11.csv`, for the exit criterion's two monthly exports.
  The October file's pending row (the Costco of Nov 1) is posted in it, on Nov 2.
- **The anonymiser notes** when moving dates changes whether their order is ambiguous, and keeps a CSV header's words
  wherever they appear: a payee sharing a header word would otherwise leave the header looking like a leak.
- **Real CSV exports** came after the first version: see [The first real CSV files](#the-first-real-csv-files).

Verification:
- **`tests/plugins/import-csv/csv.test.ts`** (10 tests, new): quotes, line ends, blank and ragged rows, Excel's marks,
  cells' places, every delimiter, and ties (a semicolon file with comma decimals).
- **`guess.test.ts`** (57, new): the corpus, each file guessed as expected with the same doubts, and read without a
  warning; then each rule on its own (preamble, an unknown header, a name that its data contradicts, date order and
  the shortest span, decimals, the two-thirds rule at its edge, a running balance each way, a pair, account numbers,
  currency, status and direction columns, `CAD$` and `USD$`, two date columns, a file with no dates).
- **`lines.test.ts`** (19, new): every way of writing an amount, pairs, direction, reversed, sums; dates and memos;
  what is left out and why; pending; accounts; currencies; repeated ids; the closing balance oldest first, newest
  first, owed, reversed, and on one day.
- **`parse.test.ts`** (25, new): the contributions; sniffing (a CSV named `.txt`, UTF-16, not QIF, OFX or prose); each
  starting point of the table, with its first line; a headerless month without deposits; what is remembered; another
  separator; skip, cancel, an unusable layout, an empty file; keys and labels; line numbers in warnings; repeated ids;
  currencies; a file past 2,000,000 characters; `correct`, by layout and by account.
- **`renderer/layoutDialog.test.tsx`** (15, new): the table and preview, rows left out, each first line, role pickers
  and the pair, guesses highlighted until changed, reversed, date order, separator and start, no lines, where focus
  starts and Enter, skip and cancel, several accounts.
- **`tests/plugins/import/csv.test.ts`** (14, new): CSV Columns then the Account dialog; the next month with the
  account chosen and the layout remembered; *Don't ask again*; skip and cancel; an account column found by number;
  CSV then OFX (*Already imported?*); a card reversed, the question, and the layout keeping the answer; a `.txt` file
  through *All files*; and the README's walkthrough, figure by figure.
- **`tests/scripts/anonymiseCsv.test.ts`** (37, new): the samples and every corpus file keep their layout, structure,
  dates and rows, with nothing personal left; balances add up across overlapping files, which still import; account
  numbers, French files, a balance forward, header words, moved dates and their note, kept amounts; `--check` and
  refusing a file.
- **Changed:** `pipeline.test.ts` builds and loads `import-csv`, and imports a CSV file through it; `units.test.ts`
  (a weak key's label isn't a name); `realFiles.test.ts` reads CSV files; `privacy.test.ts` checks CSV files as the
  anonymiser does (two made-up values allowed); `ofx.test.ts` keeps the CSV samples ASCII too; `anonymise.test.ts`
  (QIF is now what it can't read).
- **The full suite:** 170 files, all passing. `tsc` is clean for `plugins` and `scripts`; `tests` has the same 28
  errors as before, none in import code. One earlier run had the CSV Columns tests pass 15 seconds under load, as the
  account dialog's sometimes do ([todo](todo.md)): they now find the role pickers by their labels rather than by role
  and accessible name, and the file's rows are drawn once per start row. They take 5 seconds alone, and 7.5 under a
  full run.
- **Checking that the tests can fail:**
  - never guessing amounts reversed fails 7 tests;
  - money out and money in swapped fails 4;
  - pending rows kept fails 10;
  - a balance's sign never against the amounts fails 2;
  - the layout never remembered fails 11;
  - no search for a headerless layout fails 1;
  - `correct` never keeping a reversal fails 3;
  - a remembered layout fitting whatever share of rows fails fails 2;
  - the anonymiser not working balances out again fails 8, keeping payees fails 3, replacing header words fails 1;
  - *Money out* not taking the place of the amount column fails 1, *Import* enabled with no lines fails 2;
  - a weak key's label offered as an account's name fails 4.

#### Fixes after the first Windows run

The import worked on Windows (the file dialog's *CSV file* filter, CSV Columns and its preview, the October CSV into a
new account at 4,677.80), in the dark theme. Two things needed fixing:

| Seen | Cause | Fix |
|---|---|---|
| Two anonymiser tests failed: a line ended `…6448\r`, and a *Balance forward* balance didn't add up | Git on Windows (`core.autocrlf`) checks every text file out with CRLF line ends, and the tests split the output on `\n` alone | The tests split on either line end, and expect a sidecar only when the checkout has CRLF. Every CSV test was run here twice more, with every sample and fixture converted to CRLF and then to LF: all pass both ways. The samples README no longer says which line ends a sample has, since git decides |
| The role pickers' open list was hard to read in the dark theme: the chosen role pale grey on light blue | They were native selects, whose list Windows draws itself, outside the theme | MUI selects, whose menus follow the theme as every other dialog's do. The tests open a menu with a press and click an option found by its text (by role and name, a choice took 0.3 seconds); the two longest were split. 17 tests, 5 seconds, none over 0.7, 11 seconds in all under a full run |

#### The first real CSV files

Two banks' exports, anonymised on Windows with `npm run anonymise`, are in `tests/fixtures/import/real/csv/`:

| File | Layout | Guessed |
|---|---|---|
| `bank1-chequing.anon.csv` | No header, 5 columns: date, description, money out, money in, balance; every cell quoted; ISO dates | Right, with the one doubt a headerless pair always has (which of the two is money out) |
| `bank2-chequing.anon.csv` | A header of 7 columns: *Filter* (text on the first row only), *Date*, *Description*, *Sub-description*, *Type of Transaction* (*Debit*/*Credit* beside signed amounts), *Amount*, *Balance*; newest first; CRLF | Read without a warning, but with the wrong payee, fixed below |

**Bank 2's payee.** Its *Description* holds the kind of transaction (*pos purchase*, *deposit*, *mortgage payment*) and
*Sub-description* who it was with, which is what the bank's own QBO file gives as the payee. The dictionary took
*Description* as the payee, so the same transaction from its CSV and its QBO had different payees, which matters for
*Already imported?* and for matching. Now *Sub-description* is a known memo name, and when the column named as the
payee holds few different values beside a text column with at least twice as many (and three or more), the varied one
is the payee and the other the memo, marked as a guess with the reason. `22-kind-and-name.csv` in the corpus has the
layout, made up. Turning the rule off fails 2 tests.

Bank 2's file came without its `.meta.json`; the sidecar the anonymiser writes for CRLF line ends (UTF-8, no
byte-order mark) was added by hand.

Each file is described in `realFiles.test.ts`, with the layout the dialog should start from: read cleanly, imported into
a new account at the bank's balance, and adding nothing the second time. The two files were anonymised on their own,
apart from their banks' QBO files, so they can't test *Already imported?* against them.

Verification, after these: `guess.test.ts` 59 tests (the corpus is 22 files), `realFiles.test.ts` 9,
`anonymiseCsv.test.ts` 38, the dialog's 17 with menus. The full suite passes but for other plugins' dialog tests that
pass 15 seconds under load and pass alone ([todo](todo.md)).

**Not yet done:**
- **The rest of the manual walkthrough** in `npm run dev`, in light and dark themes:
  [CSV files](../samples/statements/README.md#csv-files). The October chequing and French files were seen on Windows.
- **A bank's CSV and QBO anonymised together** (`npm run anonymise -- bank2.qbo bank2.csv`), so the same made-up
  words and amounts are in both, and *Already imported?* can be tested on a real pair.

---

## Phase F5: QIF (M)

At the end of this phase *File › Import…* reads QIF files from banks, Quicken and Money.

### Files

```
plugins/import-qif/
├── manifest.json                 id "import-qif"; provides import-qif.format; renderer.expose { "./OptionsDialog" }
└── src/
    ├── shared/
    │   └── options.ts            QifOptions, and the questions a file raises
    ├── privileged/
    │   ├── index.ts              the contribution { extensions: ['qif'] }, the service, the dialog contribution
    │   ├── qif.ts                text → sections and records, with line numbers
    │   ├── dates.ts              QIF's date dialects: apostrophe years, padding spaces, the file's order
    │   ├── statements.ts         records → statements: accounts, AutoSwitch lists, fields, splits, the opening
    │   │                         balance, categories, kinds, skipped sections and their warnings
    │   └── parse.ts              the remembered options, the dialog when needed, saving the answers
    └── renderer/
        └── OptionsDialog.tsx     only the questions that apply
```

### Tasks, in order

1. **`qif.ts`**, test-first: sections, records, a last record without `^`, repeated codes, case and spaces in
   headers, blank lines, every line-end style.
2. **The anonymiser's QIF handler** (`scripts/anonymise/qif.ts`), on `qif.ts`, so Money and Quicken exports can be
   collected and anonymised while the rest is built.
3. **`dates.ts`**: every dialect in the dates table; the file's order from all its dates.
4. **`statements.ts`**: the sections table; `!Account` and AutoSwitch; fields; `N` to number or kind; `L` to category or
   transfer; splits to the total and the memo; the opening-balance record to `balance`; keys and labels.
5. **`parse.ts`** and **`OptionsDialog.tsx`**: the three questions, asked only when they apply; remembered per key;
   re-asked when the dates stop fitting.
6. **`correct`**: a reversal from the sign cross-check flips the source's `reversed` option.
7. **Samples**, the samples README (a section on bringing an account over from Money), and `plugin-creation.md`.

### Tests

| File | Covers |
|---|---|
| `import-qif/qif.test.ts` | Records and sections, including hostile input: no trailing `^`, a `^` alone, unknown codes, a `!` line mid-record |
| `import-qif/dates.test.ts` | `10/05'26`, `10/ 5'26`, `1/ 5'2026`, `10/05/26` with the pivot, `05.10.2026`, ISO; the file deciding the order; an ambiguous file |
| `import-qif/statements.test.ts` | Each sample: statements, keys, types, lines, kinds, categories, split memos, balances from the opening record. Investment sections skipped with one warning each; lists skipped quietly; a whole-file export with AutoSwitch giving one statement per cash account |
| `import-qif/parse.test.ts` | No question → no dialog; each question alone and together; answers remembered per key; a later file whose dates contradict the remembered order → asked again; `skip`, `CANCELLED`; `correct` flips the source's `reversed`, and the next file is read the other way without asking |
| `tests/scripts/anonymise.test.ts` (extended) | Every QIF sample: codes, sections, dates and `N` kept; `P`, `M`, `A`, `E`, account names and unseeded categories replaced; split totals still equal their parts; the scan passes |
| `import-qif/renderer/optionsDialog.test.tsx` | Only the questions asked; the examples shown; the results |
| `import/run.test.ts` (extended) | A Money-style account into a new account: the prefill's opening balance from the opening record; categories used where they exist; re-importing adds nothing; a whole-file export asks *Statement n of m*; the QIF September (which runs into October) then the October OFX → *Already imported?* (F2); into a ledger whose payees usually have other categories → *Categories from the File*, answered once for the source |
| `pipeline.test.ts` (extended) | The built `import-qif` activates, contributes, exposes `./OptionsDialog` |

**Exit criteria (manual):**
- import `maple-trust-chequing-2026-09.qif` into a new account: the New Account form's opening balance comes from the
  QIF's opening record; *Rent* and *Groceries* are categorised; the split shows in the memo;
- import `household-quicken-export.qif`: one Account dialog per cash account, and the RRSP left out with a warning;
- import `northwind-visa-2026-09.qif`: the QIF Options dialog asks about the card's signs once; the next card file
  from that source isn't asked;
- in a ledger where *Costco* was last categorised *Household*, import `maple-trust-chequing-2026-09.qif`: *Categories
  from the File* asks once; choose the file's, and Costco's new line is *Food : Groceries*;
- anonymise a real Money or Quicken QIF export with `npm run anonymise`, read it, and import it.

### Phase F5 results

The pieces:

| Piece | Where |
|---|---|
| Records from text: sections, fields with their lines and places, every line end, a last record without `^`, a `!` line ending a record | `plugins/import-qif/src/privileged/qif.ts` |
| Apostrophe years, padding spaces, two-digit years, dots and dashes, ISO; the file's order from all its dates; the order with the shortest span, to offer first | `privileged/dates.ts` |
| Sections into accounts (`collect`): `!Account`, AutoSwitch lists, investment accounts and lists left out. Records into lines (`readStatement`): `N`, `L`, classes, splits, the opening-balance record, keys and types | `privileged/statements.ts` |
| The file's date order and decimal separator, decided, remembered or asked; a statement per account; what is remembered; `correct` | `privileged/parse.ts` |
| The contribution, sniffing, the dialog's contribution | `privileged/index.ts`, `manifest.json` |
| `QifOptions`, the dialog's input and result | `shared/options.ts` |
| QIF Options | `renderer/OptionsDialog.tsx` |
| `fileNameStem`, the import manager's file-name rule, now shared | `packages/import-api/helpers.ts` (1.6.0); `accountResolution.ts` uses it |
| Cheques paired by number across sources | `plugins/import/src/privileged/matching/duplicates.ts`, and the window `run.ts` reads |
| The anonymiser's QIF handler: values by code, starter categories kept, account names the same everywhere, split totals worked out again, dates moved in Quicken's style, `checkableQif` | `scripts/anonymise/qif.ts`; `index.ts` |
| Samples: a Money export of one account, a Quicken whole file, a bank's card file, a mid-month file with day-first dates | `samples/statements/*.qif`, and the README's [Bringing accounts over from Money or Quicken](../samples/statements/README.md#bringing-accounts-over-from-money-or-quicken) |
| Real QIF files: the test reads and imports them once added, several accounts each | `tests/plugins/import/realFiles.test.ts`, `tests/fixtures/import/real/README.md` |

Where it differs from the plan, and why:
- **QIF Options doesn't ask about a card's signs.** The plan had it confirm the signs of every card's first file from a
  source. The sign cross-check (F3), built since, already does that with evidence: on a card's first import its type
  counts, so a file that is mostly payments is asked about (*Amounts Reversed?*), and one the right way round isn't.
  Review ruled out asking without evidence for the sign question ("there is no question without evidence"), and asking
  twice would be worse. The answer is still kept as the source's `reversed` QIF option, through `correct`.
- **Every statement has a key the format made**: `qif:account:<name>`, or `qif:file:<stem>` without a name. The plan
  left the second to the import manager's file-name key, which the format can't know, so its remembered options and
  `correct` would have used another key. The file-name rule moved into `@tessera/import-api` as `fileNameStem`
  (1.6.0), so both make the same stem.
- **A one-account export names its account in its opening-balance record** (`L[Maple Trust Chequing]`), as Money's
  does, with no `!Account`. That name is used as `!Account`'s would be. The Money sample is written so.
- **A bank account whose name says *savings* is made a savings account** (the New Account form's type), not chequing.
- **Cheques are paired by number across sources** (F2's rule): same number and amount, within 30 days, whatever the
  payees; two numbers are two cheques. Money names a cheque's payee (*Landlord*) where the bank writes *CHEQUE 101*,
  so the Money export's last week and the bank's OFX would otherwise have doubled the cheque. Other payees Money users
  keep are alike enough to the bank's text (0.82 to 1.00, measured on the samples).
- **An account with no transactions is left out, with a warning**, rather than giving an empty statement.
- **A fourth sample**, `cedar-savings-2026-08-12.qif`, so QIF Options can be seen by hand.
- **The dialog offers first the order with the shortest span**, as CSV Columns does, and says why it asks.

Verification:
- **`tests/plugins/import-qif/qif.test.ts`** (6 tests, new): sections and records, every line end, blank lines, a last
  record without `^`, a `!` line mid-record, a `^` alone, headers' case and spaces, records before any header, values'
  places, unknown codes.
- **`dates.test.ts`** (4, new): apostrophe years with and without padding, `' 6`, the pivot, dots, dashes, ISO; the
  file's order, and none; the shortest span.
- **`statements.test.ts`** (18, new): the three samples; `!Account`, AutoSwitch lists (and transactions after one),
  types, lists left out quietly, unknown sections, investment accounts by section and by type, records before a header;
  `N`, `L` with classes and transfers, splits (with and without an `L`), the memo's limit, `U`, what is left out and
  why, decimals, reversal; the opening balance (only the first record, only naming an account, reversed, alone); keys.
- **`parse.test.ts`** (12, new): contributions, sniffing; no dialog for the Money export; the dates question, its example
  and the order offered; answers remembered and not asked again; asked again when the remembered order no longer
  fits; the decimal question, alone and with the dates; skip and cancel; a file that isn't QIF, one of investments only,
  an account with no transactions; `correct` both ways, and for a key it didn't make.
- **`renderer/optionsDialog.test.tsx`** (4, new): only the questions asked, the choice offered first and focused, the
  answers.
- **`tests/plugins/import/qif.test.ts`** (11, new): the Money export into a new account (the New Account form's name,
  type and opening balance, *Categories from the File*, the split's memo, the balance); again, adding nothing; in a
  ledger where Costco is usually something else; the Quicken whole file (*Statement n of 3*, the RRSP's warning, each
  balance and type); the Money export then the bank's OFX (4 already imported, the cheque by number, the bank's
  balance); the card reversed by the sign check and read reversed the next time; QIF Options before the Account dialog;
  and the README's walkthrough, figure by figure.
- **`tests/scripts/anonymiseQif.test.ts`** (11, new): nothing personal left; headers, codes, dates, `N`, `C` and line
  ends kept; starter categories kept and the rest replaced; account names the same in transfers; split totals; read
  back as the same statements; securities; moved dates; kept amounts; `--check`; refusing a file.
- **Changed:** `duplicates.test.ts` (cheques by number, each way); `importApi.test.ts` (`fileNameStem`);
  `pipeline.test.ts` builds and loads `import-qif` and imports a QIF file through it; `realFiles.test.ts` reads QIF
  files, with several statements and their warnings; `privacy.test.ts` checks QIF files as the anonymiser does;
  `ofx.test.ts` keeps the QIF samples ASCII; `anonymise.test.ts` (a PDF is what it can't read).
- **The full suite:** 177 files, all passing. `tsc` is clean for `plugins` and `scripts`; `tests` has the same 28
  errors as before.
- **Checking that the tests can fail:**
  - the opening-balance record not recognised fails 14 tests;
  - AutoSwitch's list taken as accounts fails 1; investment accounts imported fails 1;
  - apostrophe years read as the 1900s fails 7;
  - dates that read two ways never asked about fails 7; remembered options ignored fails 5;
  - `correct` never keeping a reversal fails 2;
  - a split's total given a category fails 1; a category's class kept fails 2;
  - cheques not paired by number fails 3;
  - the anonymiser not working split totals out again fails 1, keeping account names in transfers fails 2;
  - QIF Options closing without the dates chosen fails 1.

#### The first real Money exports

One chequing account, exported by Microsoft Money twice, both anonymised and kept in `tests/fixtures/import/real/qif/`:

| File | What it is |
|---|---|
| `current_loose.anon.qif` | Money's "loose" QIF: `!Type:Bank` with no `!Account`, the account named only by its opening-balance record (`L[…]`, 0.00); **ISO dates** (`D2026-02-26`, as Windows' short date was set); payees as the bank sent them (Money downloaded them); `N` holding cheque numbers, and references on other lines; transfers to four other accounts; splits (a mortgage payment into its principal and interest). 466 transactions, Feb 26 to Nov 30, 2026 |
| `current_strict.anon.qif` | The same account as "strict" QIF, which every QIF reader takes: the same, except that every category and account name is **cut to 15 characters** (`Credit Card Payments-Transfers` → `Credit Card Pay`, and the account's own name too) |

Both are read without a warning or a question, imported into a new account at the file's balance, and add nothing the
second time. What they showed:
- **The sample was right about Money's shape** (`!Type:Bank`, no `!Account`, the name in the opening record), and
  wrong only about its dates: these are ISO, not apostrophe years, because Money writes dates as Windows is set to.
  Both are read.
- **Strict cuts the account's name**, so a strict export is another source (`qif:account:<the cut name>`) than a loose
  one of the same account, and the New Account form would get the cut name. **Loose is the better choice for
  Tessera**: the samples README says so. Imported after a loose export, a strict one adds nothing: 458 lines are known
  by their fingerprints, and the 8 whose split memos name cut categories are proposed as *Already imported?* (a test
  checks it).
- **Categories: few of Money's default names are Tessera's starter paths.** In a new ledger, 9 of the file's lines
  have a category Tessera has (*Entertainment*, *Taxes*); *Groceries* (38 lines) and *Dining Out* (12) don't resolve,
  as Tessera has them as *Food : Groceries* and *Food : Dining out*, and a hint must name the whole path
  ([F-9](#decisions)). Creating the categories first, as this note says, works; see [Later](#later).

#### Fixes after the first Money export

Anonymising a real Money export on Windows was refused: a value the QIF handler kept as it was still looked personal,
and the finding couldn't be allowed from the command line. Three causes, all fixed:

| Cause | Fix |
|---|---|
| **`N` was kept whole.** It holds cheque numbers and words (*ATM*, *XFER*), but Money writes other references there too: an Interac transfer's *CA12345678*, whose 8 digits look like an account number | `N` is kept only when it is a cheque number (6 digits at most) or words; anything else gets a made-up value of the same shape. The same for an OFX `CHECKNUM` longer than 6 digits |
| **The starter categories are kept as they are**, so a payee word replaced elsewhere (*Fresh Groceries*) could be found in a kept category (*Food:Groceries*) | The starter categories' words are kept everywhere in the file, as a CSV header's words are |
| **`--allow` was tested against the flagged part only**: the digits `12345678`, not `CA12345678`, so no pattern written for the value could match. And a regular expression is hard to quote on Windows (`^` is cmd's escape, `$` and `{}` PowerShell's) | A pattern is tested against the whole value around a finding too. `--allow-like <example>` takes an example of the value instead of a pattern, and the refusal prints the one to use for each finding's shape. `--allow-file` takes them one per line. The refusal says which field, column or tag each finding is in, and what was allowed is listed once the file is written |

Tests: `anonymiseQif.test.ts` (references in `N`, starter words in payees, the field named), `anonymise.test.ts`
(allowing by the whole value, `--allow-like`, shapes, where a finding is, a long `CHECKNUM`, the command refusing with
its suggestion, then writing with `--allow-like` and with `--allow-file`). Breaking each fix fails 1 to 4 tests.

**Not yet done:**
- **The manual walkthrough** in `npm run dev`, in light and dark themes:
  [Bringing accounts over from Money or Quicken](../samples/statements/README.md#bringing-accounts-over-from-money-or-quicken).
- **Real exports from Money and Quicken**, anonymised (`npm run anonymise -- <files> --out <folder>`), so the dialects
  this was written from are checked against the programs' own files.

---

## Phase F6: remembered choices (S)

With the import manager's phase 4 (the **Saved Account Matches** dialog, `import.links.manage`). What the import
remembers, besides account matches and payee aliases, in one place.

| Task | Files |
|---|---|
| `ImportFormat.describeMemory?(key, value): { label: string, detail?: string } \| undefined`: how a format names one of its remembered values ("CSV columns: Date, Description, Withdrawals, Deposits, Balance"; "QIF options for Checking.qif: day/month/year"). Entries it returns `undefined` for aren't listed | `packages/import-api/contract.ts` |
| The import manager describes its own records: "Categories from the file, for “Maple Chequing”"; "Amounts reversed, for Northwind Card Services •••• 3456 into Visa" | `categoryChoice.ts`, `signRecords.ts` |
| `import:memory.list`, `import:memory.forget` and `import:memory.update` (a category choice changed in place) | `plugins/import/src/privileged/ipc.ts` |
| A third tab, **Remembered choices**, in the Saved Account Matches dialog: by source, each remembered layout, option, category choice and sign correction, with *Forget* (and *Change* for a category choice) | `plugins/import/src/renderer/LinksDialog.tsx` |
| `describeMemory` in `import-csv` and `import-qif` | their `privileged/index.ts` |

Tests:
- forgetting a CSV layout makes the next file's dialog start from a guess;
- forgetting a QIF option brings its question back;
- forgetting a category choice brings *Categories from the File* back at the next conflict;
- forgetting a sign correction makes the next file be read as it is, and checked;
- a format without `describeMemory` lists nothing;
- forgetting one value leaves the others.

**Until this phase:**
- a CSV layout is corrected in its dialog, which every CSV file shows;
- a category choice is changed from the import summary (*Change…*);
- a sign correction is undone by answering the sign question the other way, which happens as soon as files arrive
  the right way round;
- a QIF option is asked again whenever a file doesn't fit it.

### Phase F6 results

Built ahead of the import manager's phase 4, whose *Saved Account Matches* dialog it was to join: the dialog is built
here, with all three kinds of thing in it. **File › Saved Import Choices…** (`import.links.manage`) opens **Saved Import
Choices** (`import.dialog.links`, size `lg`):

```
┌ Saved Import Choices ───────────────────────────────────────────────────────────────────────────────┐
│ What Tessera remembers from your imports, for this ledger. Change or forget anything here: a        │
│ forgotten choice is asked about, or worked out again, with the next file it applies to.             │
│ [ Accounts (4) ] [ Payees (1) ] [ Files and choices (8) ]                                           │
│                                                                                                     │
│  Statements from                     Go to                       Ask every time  Last used          │
│  Northwind Card Services •••• 3456   [Northwind Card …    ▾]     [ ]             Nov 6, 2026 Forget │
│    OFX / QFX / QBO statement (…)                                                                    │
│  CSV file with columns Date, …       [Chequing            ▾]     [✓]             Nov 6, 2026 Forget │
│                                                                                         [Close]     │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Tab | What it lists | What can be done |
|---|---|---|
| **Accounts** | Saved account matches: the source as its file named it, its format, the account, whether it is used without asking, when last used | Point it at another open account; tick or untick *Ask every time*; *Forget* |
| **Payees** | Payee names learnt from the bank's text (*costco whse* → *Costco*), and how often imports used them | *Forget* |
| **Files and choices** | By source: each format's values it describes (*CSV columns*, *QIF options*), and the import manager's own (*Categories from the file*, *Amounts reversed*, *How its amounts usually run*) | *Forget*; a category choice changed in place |

Everything was already kept in one place, the ledger's import collections: `import.accountLinks`,
`import.payeeAliases`, and `import.memory` (each format's values under its id, the import manager's under `import`).
Nothing moved; what was missing was a place to see it.

The pieces:

| Piece | Where |
|---|---|
| `ImportFormat.describeMemory?(key, value)` → `RememberedDescription { what, source, detail? }`; the channels `import:links`, `links.update`, `links.forget`, `aliases`, `aliases.forget`, `remembered`, `remembered.forget`, `remembered.update`, and their types (`SavedLinks`, `PayeeAliasView`, `RememberedChoice`, `RememberedUpdateRequest`) | `@tessera/import-api` **1.7.0** |
| The lists, changes and forgetting; the import manager's records described | `plugins/import/src/privileged/savedChoices.ts` |
| The command, the menu item (*File › Saved Import Choices…*, beside *Import…*), the channels, the dialog's contribution | `privileged/index.ts`, `contributions.ts`; the plugin is 0.6.0 |
| The dialog | `renderer/SavedChoicesDialog.tsx` |
| `describeMemory`: a CSV layout by its columns (now remembered with the layout) and settings; QIF options by the source's name (now remembered with them). Each format's own index (CSV's signatures and key pointers) isn't listed | `import-csv`, `import-qif`: `privileged/parse.ts`, `index.ts` |

Where it differs from the plan, and why:
- **Its own dialog and menu item, not a third tab of Saved Account Matches**, because that dialog didn't exist: the
  account matches and payee names it was to hold are the first two tabs here. The rest of phase 4 (history, undo,
  badges) is still to come.
- **The sign check's profile is listed too** (*How its amounts usually run: 82% money out, over 17 lines*), beside
  its corrections, so a source whose files changed for good can start afresh.
- **Changes take effect at once**, without OK or Cancel: each only changes what the next import does, and forgetting
  is undone by the next file asking again.
- **Grouped by source** (a source's QIF options, its category choice and its sign records together), the format's
  values first.

Also fixed, from the Windows screenshots:
- **The register's *Payee* and *Category* columns collapsed** while its review column was shown: the columns with a
  width add up to 836 with it, and the table's minimum was 820, so in a window narrower than that the two columns
  without a width got none. The minimum is now 1030 with the review column, and the table scrolls sideways instead
  (`plugins/accounts/src/renderer/register/Register.tsx`).

Verification:
- **`tests/plugins/import/savedChoices.test.ts`** (11 tests, new), through the plugin's channels on a ledger where each
  kind of thing was remembered by real imports: the command and menu item; every choice described and grouped; the
  account matches and payee names; nothing listed that a format doesn't describe, or a format no longer installed kept;
  forgetting a CSV layout (the next file's dialog starts from a guess, the rest kept), a QIF option (its question comes
  back), a category choice (changed in place, then forgotten: *Categories from the File* asks again), a sign correction
  (the next file read as it is, and checked), an account match (pointed elsewhere, set to ask, forgotten), a payee
  name; refusals.
- **`renderer/savedChoicesDialog.test.tsx`** (7, new): each tab and its counts; changing an account, *Ask every time*,
  forgetting, a category choice in its menu; the empty state; an error; Close.
- **`describeMemory`** in `import-csv/parse.test.ts` and `import-qif/parse.test.ts` (1 each, new), a layout remembered
  before its columns' names were included.
- **Changed:** `apply.test.ts` (the menu item, the dialog, the command), `pipeline.test.ts` (the built renderer exposes
  `./SavedChoicesDialog`), the CSV and QIF tests that check what is remembered, `annotations.test.tsx` (the register's
  minimum width with its review column).
- **Checking that the tests can fail:** the CSV format not describing what it keeps fails 4 tests; forgetting doing
  nothing fails 4; a category choice not changed fails 1; a match pointed at a missing account fails 1; sign records not
  described fails 2; the register's old minimum width fails 1; the dialog not reloading after a change fails 3.

**Not yet done: the manual walkthrough** in `npm run dev`: *File › Saved Import Choices…* after the samples
READMEs' walkthroughs, in light and dark themes.

---

## Sample files

All made up, plain ASCII, each file's balances adding up, like the existing ones in
[samples/statements](../samples/statements/README.md).

| File | Phase | What it shows |
|---|---|---|
| `lakeside-business-2026-10.qbo`, `…-11.qbo` | F1 | A business chequing account at Lakeside Credit Union, with `INTU.BID` and `INTU.USERID`; November overlaps October by a week with the same FITIDs |
| `maple-trust-chequing-2026-10-converted.qbo` | F1, F2 | The October statement as a conversion tool might write it: the same lines, with FITIDs `1…17` and an `INTU.BID` of another bank. Imported before November's OFX, it shows the made-up ids detected (F1) and the overlapping week proposed as *Already imported?* (F2) |
| `tests/fixtures/import/qbo/converter-{a,b}.qbo` (tests only) | F1 | Made-up FITIDs `1…n` in two files of different lines |
| `northwind-visa-2026-10-reversed.qfx` | F3 | The October card statement as some banks write it: charges positive, payments negative, and the balance positive. Same card and FITIDs as the `.qfx` sample |
| `northwind-visa-2026-11.qfx` | F3 | The card's November, the right way round: after the reversed October, the bank has fixed its files, and the kept correction comes off |
| `maple-trust-chequing-2026-11-reversed.ofx` | F3 | November's chequing statement reversed: after October, the bank's balance and the source's profile say so |
| `maple-trust-chequing-2026-10.csv` | F4 | The same October as the OFX sample: header, `Withdrawals`/`Deposits`, a running balance, month-first dates, a pending row |
| `maple-trust-cheques-2026-10-fr.csv` | F4 | French headers, `;`, comma decimals, day-first dates, a preamble |
| `northwind-visa-2026-10.csv` | F4 | A card export with charges positive and no header |
| `harbour-bank-2026-10.csv` | F4 | An *Account Number* column with chequing and savings |
| `maple-trust-chequing-2026-09.qif` | F5 | Money-style, as Money exports one account: `!Type:Bank` (no `!Account`), an opening-balance record naming the account, categories, a split, cheques, apostrophe years padded with spaces. September and October's first week, so that the October OFX follows it with a week of overlap |
| `household-quicken-export.qif` | F5 | Quicken-style whole-file export: AutoSwitch account list, two bank accounts, a card, an RRSP (skipped), category and class lists (skipped), transfers between the accounts, a split, a class |
| `northwind-visa-2026-09.qif` | F5 | A card QIF with charges positive, for the signs question (now the sign cross-check's) |
| `cedar-savings-2026-08-12.qif` | F5 (added) | A bank's mid-month QIF with day-first dates, every day 12 or less: QIF Options asks |

The samples README gains a walkthrough for each phase, and `walkthrough.test.ts` checks every number in it, as it does
for OFX.

---

## Documentation changes

| When | Change |
|---|---|
| This note | [import-manager-design.md](import-manager-design.md): status, Phase 3 and the Later table point here; the components table lists `import-csv` and `import-qif`; decision 10 notes F-7. [todo.md](todo.md): the import items point here |
| F0 | `plugin-creation.md` › *Adding an import format*: `context.prompt` (and why not `shell.prompts`), `CANCELLED` vs `undefined`, `text('auto')`, per-statement `stableIds`, `category`, the new date helpers. The import manager note: `ParseContext` and the time limit, the collision guard in *Recognising lines imported before* |
| F1 | `README.md`: QBO in *What works today*; `npm run anonymise` under the scripts. Samples README: the QBO files. A new guide section, *Contributing a real statement file*, in `samples/statements/README.md` (or `tests/fixtures/import/README.md`): anonymise, read, then commit, with the sidecar |
| F2 | The import manager note: *Duplicates across sources* summarised in *Matching* and *What the import plugin annotates*, with a link here. `README.md`: a line under *Importing statements* |
| F3 | The import manager note: the sign cross-check as a step of *The import flow*, with a link here. `plugin-creation.md`: `correct`. `README.md`: a line under *Importing statements* |
| F4 | `README.md`: CSV; `import-csv` in *Project layout*. `plugin-creation.md`: the CSV plugin as the example of a format with a dialog and a `correct` hook. Samples README. The anonymiser's guide: CSV |
| F5 | `README.md`: QIF, and bringing accounts over from Money or Quicken; `import-qif` in *Project layout*. Samples README. The anonymiser's guide: QIF |
| F6 | `plugin-creation.md`: `describeMemory` |
| Each phase | Tick it in `todo.md`; record results and departures from this note in a *Phase Fn results* section here |

## Definition of done

Every phase:
- [ ] `npm test` green, including the architecture boundaries (the new plugins import only `@tessera/*`)
- [ ] No new errors from `npx tsc --noEmit -p plugins` (and `-p tests` when touched)
- [ ] Every disposable pushed onto `context.subscriptions`
- [ ] The phase's manual checklist done in `npm run dev`, in light and dark themes
- [ ] Docs updated as listed above

## Phases

| Phase | Delivers | Size | Depends on |
|---|---|---|---|
| F0 | `@tessera/import-api` 1.3: `prompt` with the clock paused, `CANCELLED` stopping the import, per-statement `stableIds`, `category` hints with the *Categories from the File* choice per source, `text('auto')`, date helpers and guessers; the id-collision guard | M | — |
| F1 | `.qbo` in `import-ofx`; made-up id detection; samples. `npm run anonymise` (with its scan) for OFX, QFX and QBO, and the fixtures' privacy test | M | F0 |
| F2 | *Already imported?* proposals for lines seen from another source: rule, run, review, annotator, dialog, summary; `@tessera/import-api` 1.4 | M | F0 |
| F3 | The sign cross-check: evidence both ways, the *Amounts Reversed?* question, retained sign records, `correct`; `@tessera/import-api` 1.5 | M | F2 |
| F4 | The `import-csv` plugin: reading, guessing, the CSV Columns dialog on every file, remembered layouts, account columns, pending rows, `correct`; the anonymiser for CSV; samples and the layout corpus | L | F0; ships once F2 and F3 are done |
| F5 | The `import-qif` plugin: sections, accounts, dates, splits, opening balances, categories, the QIF Options dialog, `correct`; the anonymiser for QIF; samples | M | F0; ships once F2 and F3 are done |
| F6 | *Remembered choices*: layouts, QIF options, category choices and sign corrections, seen and forgotten in the Saved Account Matches dialog | S | F4, F5, import manager phase 4 |
