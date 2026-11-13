# Design, definition and implementation: importing CSV, OFX, QFX, QBO and QIF files

| | |
|---|---|
| **Status** | **Built; this note brings the design together in one place.** All five file types import today through *File › Import…*. The import manager's phases 0 to 2 and the formats' phases F0 to F6 are done. Checked on 2026-11-12: the import suites pass (44 files, 690 tests; see [Verification](#verification)). What is still open is in [Remaining work](#remaining-work): manual checks, real-file coverage, three gaps found while writing this note, large files, and import history and undo. **Renamed 2026-11-12:** the format plugins `import-ofx`, `import-csv` and `import-qif` are now the file-type plugins `format-ofx`, `format-csv` and `format-qif`, which will also write their file types ([export-design.md](export-design.md), Q1 and Q8). This note uses the new names; the phase records it links to use the old ones |
| **Date** | 2026-11-12 |
| **Scope** | The five statement file types Tessera imports: **CSV** (bank exports), **OFX** (Open Financial Exchange, Microsoft Money's download format), **QFX** (Quicken's Web Connect), **QBO** (QuickBooks' Web Connect) and **QIF** (Quicken Interchange Format). What each is, exactly what Tessera accepts and how each field maps into a statement, the shared pipeline they all go through, and the plan for what is left |
| **Consolidates** | [import-manager-design.md](import-manager-design.md) (the `import` plugin, the `import.formats` extension point, OFX and QFX, matching and review) and [import-formats-design.md](import-formats-design.md) (CSV, QBO, QIF, and the safeguards they needed). Those two remain the **detailed record**: rationale, alternatives, review decisions and phase results. This note replaces neither and amends neither. Where it and the code differ from them, the code wins and the difference is listed in [Known gaps and discrepancies](#known-gaps-and-discrepancies) |
| **Related** | [plugin-creation.md › Adding an import format](plugin-creation.md#adding-an-import-format) (how to write a format plugin); [samples/statements](../samples/statements/README.md) (files and walkthroughs to try by hand); [tests/fixtures/import/real](../tests/fixtures/import/real/README.md) (anonymised real files) |
| **Layout** | [Part 1](#part-1-design) is the design (*how importing works*). [Part 2](#part-2-definition-of-each-file-type) is the definition (*exactly what each file type is and how it is read*). [Part 3](#part-3-implementation-plan) is the implementation plan (*what was built, in what order, how it is verified, and what remains*). Remaining work is numbered **R1 to R6** so it isn't confused with phases 0 to 4 and F0 to F6 |

- [Summary](#summary)
- [The five file types at a glance](#the-five-file-types-at-a-glance)
- [Naming](#naming)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- **Part 1: Design**
  - [Architecture](#architecture)
  - [The contract: `@tessera/import-api`](#the-contract-tesseraimport-api)
  - [The import flow](#the-import-flow)
  - [Identity: keys, import ids and fingerprints](#identity-keys-import-ids-and-fingerprints)
  - [Safeguards every format gets](#safeguards-every-format-gets)
  - [What imports remember](#what-imports-remember)
  - [Text encodings](#text-encodings)
  - [Errors and outcomes](#errors-and-outcomes)
- **Part 2: Definition of each file type**
  - [Choosing a format for a file](#choosing-a-format-for-a-file)
  - [OFX, QFX and QBO](#ofx-qfx-and-qbo)
  - [CSV](#csv)
  - [QIF](#qif)
  - [The same account from several file types](#the-same-account-from-several-file-types)
- **Part 3: Implementation plan**
  - [What was built, and in what order](#what-was-built-and-in-what-order)
  - [Code map](#code-map)
  - [Verification](#verification)
  - [Known gaps and discrepancies](#known-gaps-and-discrepancies)
  - [Remaining work](#remaining-work)
  - [Later (not scheduled)](#later-not-scheduled)
  - [Open questions](#open-questions)
  - [Definition of done](#definition-of-done)
  - [Documentation changes](#documentation-changes)

---

## Summary

- **One import manager, three format plugins, five file types.** The `import` plugin owns *File › Import…* and knows
  no file format. Format plugins contribute to its **`import.formats`** extension point and turn bytes into neutral
  **`ParsedStatement`s**:
  - **`format-ofx`** reads **OFX, QFX and QBO**. QFX and QBO are OFX 1.x with a few Intuit tags, so one reader
    serves all three, and an account keeps the same identity whichever of the three a bank gives;
  - **`format-csv`** reads **CSV** exports in any layout. It guesses the columns, shows them in the **CSV Columns**
    dialog for every file, and remembers what the user confirms;
  - **`format-qif`** reads **QIF** from banks, Quicken and Microsoft Money, including Quicken's whole-file export.
    It asks (**QIF Options**) only when the dates or decimals could be read two ways.
- **Everything after parsing is shared.** The import manager finds the account, leaves out lines imported before,
  checks the amounts aren't reversed, spots lines already imported from another file type, proposes matches with
  what the user entered, and adds the rest for review in the register. A new format gets all of this without
  writing any of it.
- **Formats differ in how much they tell.** OFX-family files name their account and give each line a bank id. CSV
  and QIF files usually do neither. The design makes up the difference: **weak keys** that make the Account dialog
  ask, **fingerprints** in place of bank ids, and safeguards against the same transaction arriving twice from
  different file types.
- **Status:** all five file types are built and tested. The remaining work ([R1 to R6](#remaining-work)) is mostly
  checking by hand and collecting real files. Three small gaps found while writing this note are also on the list,
  along with making very large imports responsive and the import manager's history and undo.

---

## The five file types at a glance

| | OFX | QFX | QBO | CSV | QIF |
|---|---|---|---|---|---|
| **Full name** | Open Financial Exchange | Quicken Financial Exchange (Web Connect) | QuickBooks Web Connect | Comma-separated values | Quicken Interchange Format |
| **Typical source** | Banks' "Microsoft Money" download | Banks' "Quicken" download | Banks' "QuickBooks" download; PDF/CSV-to-QBO converters | Every bank's website | Quicken and Money exports; some banks |
| **Extension claimed** | `.ofx` | `.qfx` | `.qbo` | `.csv` (not `.txt`) | `.qif` |
| **Plugin** | `format-ofx` | `format-ofx` | `format-ofx` | `format-csv` | `format-qif` |
| **Structure** | SGML (1.x) or XML (2.x) tags | As OFX 1.x, plus `<INTU.*>` | As OFX 1.x, plus `<INTU.*>` | Rows and columns, any layout | One-letter fields, `^`-ended records, `!` sections |
| **Names its account** | Yes: bank id + account number | Yes | Yes | Only with an account-number column | Sometimes, by name only |
| **Account key** | `ofx:bank:<BANKID>:<ACCTID>` / `ofx:card:<ACCTID>`, strong | same | same | `csv:account:<n>` (strong) or `csv:layout:<sig>` (weak) | `qif:account:<name>` or `qif:file:<stem>`, weak |
| **Bank ids** | `FITID` | `FITID` | `FITID`, sometimes made up | Rarely (an id column) | Never |
| **Lines known by** | Bank id (fingerprint if distrusted) | same | same | Fingerprint (bank id if a trusted id column) | Fingerprint |
| **Statements per file** | One per account | same | same | One, or one per account-number value | One per non-investment account |
| **Bank balance** | `LEDGERBAL` | same | same | Running-balance column, if any | Opening-balance record + lines |
| **Categories** | No | No | No | A category column, if any (hint) | `L` field (hint) |
| **Asks the user** | No | No | No | **Every file** (CSV Columns) | Only when ambiguous (QIF Options) |
| **Hard part** | Dialects of SGML | — | Made-up ids | The layout | Dates and dialects |

---

## Naming

| Term | Meaning | Code |
|---|---|---|
| **Import manager** | The `import` plugin: the flow, accounts, duplicates, matching, review | `plugins/import/` |
| **Format**, **format plugin** | A plugin that reads one or more file types into statements | `ImportFormatContribution`, `ImportFormat` |
| **Statement** | One account's lines for a period, as a file gives them | `ParsedStatement` |
| **Line** | One transaction in a statement, as the bank wrote it | `StatementLine`; `BankLine` once converted to minor units |
| **Source** | Where a statement comes from, from one file to the next: an account at a bank, a CSV layout, a QIF account name | The statement's **key** |
| **Key**, **strong / weak** | A source's identity. *Strong* names one account (an account number); *weak* only suggests one (a layout, a name), so the Account dialog still asks | `StatementAccount.key`, `keyStrength` |
| **Bank id** | The bank's own id for a line | `StatementLine.externalId` (OFX `FITID`) |
| **Fingerprint** | An id made from a line's content when there is no trusted bank id | `fp:` + SHA-256 of date, amount, normalised payee and memo |
| **Import id** | Whichever of the two a line is known by | `import.lines.importId` |
| **Saved account match** | "Statements from this source go to that account", kept in the ledger | `AccountLink` |

---

## Goals and non-goals

**Goals**

- Import the statement files a user can actually get from a bank, Quicken or Microsoft Money, in all five types.
- **Never add a transaction twice**: not when a file is imported again, not when files overlap, not when the same
  month arrives as a CSV and then as an OFX, and not when a bank changes a line's text between downloads.
- **Never drop a real transaction silently**: not even when a bank id is reused or made up.
- **Never import amounts the wrong way round without asking.**
- Ask only what the file can't answer, and remember the answer for the next file from the same source.
- Keep format plugins small and pure (bytes in, statements out), so they can be tested without a ledger and new
  formats can be added as plugins.

**Non-goals** (each is skipped with a warning, or left for [Later](#later-not-scheduled))

- **Investment transactions** (QIF `!Type:Invst`, OFX `INVSTMTRS`): the neutral model is cash lines only.
- **Splits**: `accounts` has none yet. A QIF split imports as its total, and its parts go into the memo.
- **Creating transfers** from QIF's `L[Account]`: such lines import as ordinary lines of kind `transfer`.
- **Creating categories** from a file: a file's category is only a hint, used when the ledger already has it.
- **A full migration from Money or Quicken** (`.mny`, budgets, reconciled history), and **exporting**.
- **Excel** (`.xls`, `.xlsx`) and **direct bank connections**. The contract leaves room for both
  (`import.manager.importStatements`).

---

## Decisions

These are the decisions that shape all five file types. Each links to the record where it was argued and reviewed.

| # | Decision | Why | Record |
|---|---|---|---|
| D1 | **Formats are plugins**: plain-data contributions to `import.formats`, each naming an `ImportFormat` service | A new file type changes nothing else; a broken format plugin can't break importing | [Decisions](import-manager-design.md#decisions) |
| D2 | **A format only turns bytes into statements.** It never opens files, touches the ledger or knows the account | Keeps formats pure and testable; the hard, shared parts are written once | [Writing a format plugin](import-manager-design.md#writing-a-format-plugin) |
| D3 | **OFX, QFX and QBO share one reader** (`format-ofx`) | They are the same format. One reader means one set of fixes, and an account keeps the same key and bank ids across all three | [F-1](import-formats-design.md#decisions) |
| D4 | **Amounts cross the contract as canonical decimal strings**, signed from the account holder's side (money out is negative, on a card too) | Never floating point; the import manager converts them once it knows the currency | [The neutral statement](import-manager-design.md#the-neutral-statement) |
| D5 | **A line is known by its bank id when it can be trusted, otherwise by a fingerprint.** Ids can be distrusted per statement, and ids seen before are checked against what they named | Made-up ids must never drop a real transaction as a duplicate | [F-3](import-formats-design.md#decisions) |
| D6 | **Formats ask the user through `ParseContext.prompt`**, which pauses the 30-second parse limit | The limit is there to stop a hung format, not a user reading a preview | [F-2](import-formats-design.md#decisions) |
| D7 | **The CSV Columns dialog is shown for every CSV file**, filled in from memory or a guess | A wrong sign or date order imports a month of plausible-looking wrong transactions; confirming takes one key | [F-5](import-formats-design.md#decisions) |
| D8 | **Every import gets a sign cross-check** once its account is known | The format can't check signs because it doesn't know the account; a reversed file is the most damaging mistake | [F-12](import-formats-design.md#decisions) |
| D9 | **A line that looks already imported from another file type is proposed, not added** (*Already imported?*) | Adding would double the balance; dropping could lose a real transaction | [F-4](import-formats-design.md#decisions) |
| D10 | **A file's categories are hints**, used only when they name an existing category, and only once the user has said so for that source | Only the user knows whether a source's categories (Quicken's, the bank's) beat their own history | [F-9](import-formats-design.md#decisions) |
| D11 | **Weak keys ask; strong keys don't.** CSV without an account column and all QIF are weak | A layout or a name suggests an account but doesn't prove it | [Decision 10](import-manager-design.md#decisions), [F-7, F-8](import-formats-design.md#decisions) |
| D12 | **CSV doesn't claim `.txt`**; such files import through *All files*, and sniffing picks the format | Claiming `.txt` would offer every text file as a statement | [F-14](import-formats-design.md#decisions) |
| D13 | **What imports remember is kept in the ledger**, not in application settings, and can be seen and forgotten in *File › Saved Import Choices…* | It describes a bank's files and travels with the ledger | [F-6](import-formats-design.md#decisions) |

---

# Part 1: Design

## Architecture

```
                         File › Import…          import.manager (other plugins)
                               │                          │
                               ▼                          ▼
┌──────────────────────────── import (the import manager) ───────────────────────────────┐
│ file dialog · read bytes · choose format · parse clock · account resolution ·          │
│ convert · duplicates · collision guard · sign cross-check · already imported ·         │
│ matching · categories · apply · summary · review annotations · Saved Import Choices    │
└───────┬──────────────────────────────┬───────────────────────────────┬─────────────────┘
        │ import.formats (data)        │ ImportFormat service          │ accounts.service,
        │                              │ parse(file, context)          │ ledger.session,
        ▼                              ▼                               │ shell.files/prompts
┌──────────────┐   ┌────────────────────────────┐   ┌──────────────────────────────┐
│ format-ofx   │   │ format-csv                 │   │ format-qif                   │
│ .ofx .qfx    │   │ .csv                       │   │ .qif                         │
│ .qbo         │   │ renderer: CSV Columns      │   │ renderer: QIF Options        │
└──────────────┘   └────────────────────────────┘   └──────────────────────────────┘
        all three depend only on @tessera/import-api (and @tessera/types, accounts-api)
```

- **Format plugins can't import each other or the import manager**: `tests/architecture/boundaries.test.ts`
  enforces it. They share only the published contract, `@tessera/import-api` (`packages/import-api/`), which is
  types, constants and pure helpers.
- **A format plugin has a privileged half** (the parser, in the main process) **and, if it asks anything, a
  renderer half** (its dialog, a Module Federation remote contributed to `shell.dialogs`). The CSV and QIF plugins
  keep their pure reading code in `src/shared/`, so the dialog's live preview runs exactly the code that imports.
- **The import manager requires** `accounts.service`, `ledger.session`, `shell.files`, `shell.prompts` and
  `app.state`, and **provides** `import.manager`, `import.annotator` (the register's review marks) and
  `import.migrator` (its ledger schema).

## The contract: `@tessera/import-api`

Version **1.7.0** (`IMPORT_API_VERSION`). Full text: [contract.ts](../packages/import-api/contract.ts). In short:

```ts
// Contributed as data to 'import.formats'
interface ImportFormatContribution {
  id: string              // '<pluginId>.<name>': 'format-ofx.ofx'
  label: string           // the file dialog's filter name
  extensions: string[]    // lower case, no dots: ['ofx', 'qfx', 'qbo']
  service: string         // the ImportFormat service: 'format-ofx.import'
  description?: string    // one sentence, for the Choose Format dialog
  stableIds?: boolean     // default true: bank ids survive a re-download
  order?: number          // lower first in the file dialog
}

// Provided as a service by the same plugin
interface ImportFormat {
  sniff?(sample: ImportSample): boolean | Promise<boolean>     // first 4 KB; only when the extension doesn't decide
  parse(file: ImportFile, context: ParseContext): Promise<ParseResult | undefined>  // undefined = Skip This File
  correct?(correction: FormatCorrection, context: { memory: FormatMemory }): Promise<boolean>  // since 1.5
  describeMemory?(key: string, value: unknown): RememberedDescription | undefined           // since 1.7
}

interface ParseContext {
  signal: AbortSignal     // ledger closed, import cancelled, or time up
  memory: FormatMemory    // small JSON values kept in the ledger, per format
  log: Logger
  windowId?: number
  prompt(dialogId, input, options?): Promise<result | undefined>  // opens the format's dialog; the clock pauses
}

interface ParsedStatement {
  account: StatementAccount          // key, keyStrength, label, institution, accountNumber, numberIsPartial, type, name
  currency?: string                  // ISO 4217, when the file says
  period?: { from?: string, to?: string }
  balance?: { amount: string, asOf: string }   // the bank's balance, canonical decimal
  stableIds?: boolean                // false: this statement's bank ids can't be trusted (since 1.3)
  lines: StatementLine[]
}

interface StatementLine {
  date: string            // YYYY-MM-DD, posted
  userDate?: string       // YYYY-MM-DD, when the user made it (matching only)
  amount: string          // canonical decimal, signed from the account's side
  payee?: string; memo?: string; number?: string
  externalId?: string     // the bank's id
  kind?: StatementLineKind // debit, credit, cheque, deposit, payment, transfer, fee, serviceCharge, interest, …
  category?: string       // 'Food:Groceries', a hint (since 1.3)
}
```

**Rules a format follows**, whatever its file type:

1. **Bytes in, statements out.** The import manager reads the file (`ImportFile`: `bytes`, `head`, `text(encoding)`).
2. **Amounts** are made with `canonicalDecimal(text, { decimal })`, **dates** with `isoDate(text, order, options)`.
   Both refuse text that could mean two things rather than guess. A line whose date or amount can't be read is left
   out with a `ParseWarning` (with its line number), and the rest of the file imports.
3. **Signs** are from the account holder's side. If a file is written the other way, the format either knows (a
   CSV layout's `reversed`) or leaves it to the [sign cross-check](#safeguards-every-format-gets).
4. **Ask only through `context.prompt`.** Return `undefined` for *Skip This File*; throw
   `ImportError('CANCELLED')` for *Cancel Import* (stops this file and those after it); throw
   `ImportError('UNREADABLE', message)` for a file that can't be read (the message is shown).
5. **Give every statement a key if the file offers any identity**, and say how strong it is. With no key, the import
   manager makes a weak one from the file's name (`<formatId>:file:<stem>`, using `fileNameStem`).
6. **Remember only through `context.memory`**, and describe what is remembered (`describeMemory`) so the user can
   see and forget it. Read a missing value as "nothing remembered".

Helpers for format authors (all pure, in [helpers.ts](../packages/import-api/helpers.ts)): `canonicalDecimal`,
`isCanonicalDecimal`, `isoDate` (with `pivot` for two-digit years and `monthNames` for English and French month
names), `guessDateOrder`, `guessDecimal`, `monthOf`, `fileNameStem`.

## The import flow

One import runs at a time, and it holds the ledger's *long operation* for its whole run, dialogs included, so no
backup or Close Ledger happens in the middle (`Importer.exclusively`, [run.ts](../plugins/import/src/privileged/run.ts)).

| # | Step | What happens | Where |
|---|---|---|---|
| 1 | **Choose files** | *File › Import…* opens a multi-select file dialog in the last folder used (or Downloads). Filters: *All supported statements* (default), one per format, *All files* | `run.ts` `chooseFiles`; `formats.ts` `filters` |
| 2 | **Read** | Refused over 25 MB (`TOO_LARGE`); a missing or unreadable file fails alone. `head` is the first 4,096 bytes | `files.ts` `readImportFile` |
| 3 | **Choose the format** | By extension; if several formats (or none) claim it, by `sniff`; if still several, the **Choose Format** dialog | `formats.ts` `choose`; see [Choosing a format](#choosing-a-format-for-a-file) |
| 4 | **Parse** | `parse` runs with a 30-second clock that **pauses while the format's dialog is open**. `undefined` → skipped; `CANCELLED` → stop; any other throw → this file failed, the rest continue | `run.ts` `ParseClock`, `importFile` |
| 5 | **Find the account** (per statement) | A saved account match (used without asking if strong, or if the user ticked *Don't ask again*); else the account number, if exactly one open account has it; else the **Account dialog**: pick, create (pre-filled from the statement) or skip | `accountResolution.ts` |
| 6 | **Check the account** | Closed → `ACCOUNT_CLOSED`; statement currency differs → `CURRENCY_MISMATCH` | `run.ts` `importStatement` |
| 7 | **Convert** | Amounts to minor units (extra non-zero decimals refused, never rounded); text cut to the ledger's limits; zero amounts left out; each line's **import id** decided | `convert.ts` |
| 8 | **Leave out lines imported before** | Lines whose import id is known in this account are duplicates — unless the [collision guard](#safeguards-every-format-gets) says the id now names a different transaction | `run.ts`, `collisions.ts` |
| 9 | **Sign cross-check** | Evidence from matching both ways, earlier imports, the bank's balance, the account's type (first import only) and the source's profile. Asks *Amounts Reversed?* only when the evidence says so | `matching/signs.ts`, `signRecords.ts` |
| 10 | **Already imported?** | Lines that look like ones imported from another file type are proposed against them, not added | `matching/duplicates.ts` |
| 11 | **Match** | The rest are matched fuzzily (date, amount, payee) against transactions the user entered; tolerances from the *Strict / Balanced / Lenient* setting | `matching/score.ts`, `assign.ts`, `tuning.ts` |
| 12 | **Archive cut-off** | Unmatched lines dated before the account's last archival date aren't added | `run.ts` |
| 13 | **Categories** | If new lines carry file categories the ledger has, and the user hasn't answered for this source, *Categories from the File* asks which wins | `categoryChoice.ts`, `drafts.ts` |
| 14 | **Apply** | One batch: new transactions added, proposals recorded, bank lines kept; recoverable if interrupted. Then an account that was already there gets what the file says about it where the account has nothing: its bank number and Intuit bank id, and its account number when the statement's match is remembered (never overwritten; a difference is a warning; [export-design.md](export-design.md#account-fields-for-ofx), Q9) | `apply.ts`; `run.ts` `fillAccountIds` |
| 15 | **Summary and review** | The summary dialog per statement (counts, warnings, *Review in Register*). In the register, each imported row shows the bank's version with **Accept** and **Change…** | `SummaryDialog.tsx`; `annotator.ts`, `review.ts` |

Steps 5 onwards are the same for every file type, and for statements another plugin passes to
`import.manager.importStatements` (a non-interactive call reports `needsAccount` or `needsConfirmation` instead of
asking).

## Identity: keys, import ids and fingerprints

Two identities matter: **which account** a statement is for (its key), and **which transaction** a line is (its
import id).

**Keys** (`StatementAccount.key`), by file type:

| File type | Key | Strength | Effect |
|---|---|---|---|
| OFX / QFX / QBO, bank | `ofx:bank:<BANKID>:<ACCTID>` | strong | A saved match is used without asking |
| OFX / QFX / QBO, card | `ofx:card:<ACCTID>` | strong | same |
| CSV with an account-number column | `csv:account:<number>` | strong | same; one statement per number |
| CSV without | `csv:layout:<signature>` | weak | The Account dialog asks, with the last account chosen, unless *Don't ask again* |
| QIF with an account name | `qif:account:<name, lower case>` | weak | same |
| QIF without | `qif:file:<file-name stem>` | weak | same |
| Any statement without a key | `<formatId>:file:<stem>` (made by the import manager) | weak | same |

**Import ids**, per line:
- the **bank id** (`externalId`) when there is one, it's at most the ledger's id length, and it's trusted: the
  contribution's `stableIds` is not false, the statement's `stableIds` is not false, and the collision guard hasn't
  distrusted it;
- otherwise a **fingerprint**: `fp:` + the first 16 hex digits of SHA-256 over date, amount (minor units),
  normalised payee and lower-cased memo. Identical lines within one statement are numbered (`fp:…#1`, `fp:…#2`), so
  two real coffees on the same day stay two.

## Safeguards every format gets

| Safeguard | The problem | The rule | Since |
|---|---|---|---|
| **Made-up id detection** (OFX family) | Converters number lines 1, 2, 3… in every file | ≥ 3 lines, all ids ≤ 6 digits and consecutive, or one id on two different lines → `stableIds: false` for that statement, with a warning | F1 |
| **Collision guard** (all) | A known bank id now names a different transaction | A known id whose line is dated > 3 days from what it named, or has both another amount and another payee, is a new transaction, known by fingerprint. If more than half of a statement's known ids collide, none of its ids are trusted | F0 |
| **Already imported?** (all) | The same transaction from two file types has two different import ids | Same exact amount, dates ≤ 3 days apart, payees ≥ 0.75 alike (or either missing); or the same cheque number and amount ≤ 30 days apart. Never two bank ids from the same format. Proposed, not added | F2 |
| **Sign cross-check** (all) | A file with reversed signs imports plausible nonsense | Strong evidence for *reversed* asks; weak evidence asks unless strong evidence disagrees. A correction is kept by the format if it can (`correct`: CSV, QIF) or by the import manager (OFX family) | F3 |
| **Archive cut-off** (all) | A line before the archive date may be a transaction the archive removed | Such lines are never added, though they may still match | Ledger compaction phase 2 |
| **Parse clock** (all) | A hung format | 30 s of the format's own work; dialog time isn't counted | F0 |

## What imports remember

All of it is in the open ledger. *File › Saved Import Choices…* lists every item and can change or forget it.

| What | Owner | Where | Key |
|---|---|---|---|
| Saved account matches | import manager | `import.accountLinks` | statement key |
| Payee names learnt from the bank's text | import manager | `import.payeeAliases` | normalised bank text |
| Category choice per source (*file* or *payee*) | import manager | `import.memory`, format `import` | `categories:<key>` |
| Sign records: the source's profile and any kept reversal | import manager | `import.memory`, format `import` | per source and account |
| CSV layouts | `format-csv` | `import.memory`, format `format-csv.csv` | `layout:<signature>`, plus its own index `signatures` and `key:<statement key>` |
| QIF options (date order, decimal, reversed) | `format-qif` | `import.memory`, format `format-qif.qif` | `options:<statement key>` |
| The last folder used | import manager | application state (`app.state`), not the ledger | `import.lastFolder` |

## Text encodings

`ImportFile.text(encoding)` ([files.ts](../plugins/import/src/privileged/files.ts)): a byte-order mark (UTF-8,
UTF-16 LE/BE) always wins. Windows-1252 is decoded by Tessera itself, because Node's decoder turns `€ ‘ ’ “ ”` into
control characters.

| File type | Encoding asked for |
|---|---|
| OFX 2.x | The XML declaration's `encoding` |
| OFX 1.x / QFX / QBO | `CHARSET:` — `1252` → windows-1252; `ISO-8859-1` → Latin-1 (decoded as windows-1252); `UTF-8`, `NONE` or missing → UTF-8 |
| CSV, QIF | `'auto'`: UTF-8 if the bytes are valid UTF-8, otherwise windows-1252 |

## Errors and outcomes

Each statement ends in one `StatementOutcome`: `imported`, `skipped`, `cancelled`, `failed`, or, for
non-interactive imports only, `needsAccount` or `needsConfirmation`. A failed file never stops the others.
The `ImportErrorCode`s an import can end with: `NO_LEDGER`, `READ_ONLY`, `BUSY`, `TOO_LARGE`, `UNREADABLE`,
`NO_FORMAT`, `EMPTY`, `CANCELLED`, `ACCOUNT_CLOSED`, `CURRENCY_MISMATCH` (review requests add `NOT_FOUND` and
`REFUSED`). Per-line problems are **warnings** on the statement, with the
file's line number where the format knows it. The summary counts `added`, `matched`, `possible`, `duplicates`,
`invalid`, and, when non-zero, `archived`, `idConflicts` and `alreadyImported`.

---

# Part 2: Definition of each file type

This part defines what Tessera accepts for each file type, and exactly how each field becomes part of a
`ParsedStatement`. It describes the code as it is on 2026-11-12.

## Choosing a format for a file

| Format | Contribution | Extensions | Order | `sniff` says yes when… |
|---|---|---|---|---|
| OFX / QFX / QBO | `format-ofx.ofx` | `ofx`, `qfx`, `qbo` | 0 | the first 4 KB contain `OFXHEADER` or `<OFX>` (any case) |
| CSV | `format-csv.csv` | `csv` | 10 | the first line doesn't start with `!`, `<` or `OFXHEADER`, and at least 60% of the first 30 non-blank lines (and at least 2) split into the same number (≥ 2) of cells on the detected delimiter |
| QIF | `format-qif.qif` | `qif` | 20 | the first non-blank line is `!Type:…`, `!Account` or `!Option:…` |

- **Exactly one format claims the extension** → it is used (no sniff).
- **None or several claim it** (a `.txt`, a `.dat`, a `.qif` named `.csv`) → the candidates sniff. A format that says
  yes beats formats that can't sniff. If one remains, it is used; if several, **Choose Format** asks; if none,
  `NO_FORMAT` names the types that can be imported.

## OFX, QFX and QBO

### What the files are

- **OFX 1.x** is SGML: a `KEY:VALUE` header (`OFXHEADER:100`, `DATA:OFXSGML`, `VERSION:102`, `CHARSET:1252`, …),
  then tags where aggregates are closed (`</STMTTRN>`) but values aren't (`<TRNAMT>-84.12`).
- **OFX 2.x** is XML, with an `<?xml …?>` declaration and an `<?OFX …?>` processing instruction.
- **QFX** is OFX 1.x for Quicken, with `<INTU.BID>` (and sometimes `<INTU.USERID>`) in the sign-on.
- **QBO** is OFX 1.02/1.03 for QuickBooks, with the same Intuit tags. Many QBO files come from PDF- or CSV-to-QBO
  converters rather than banks.

### Reading

One tolerant tokenizer reads both dialects ([sgml.ts](../plugins/format-ofx/src/privileged/sgml.ts)):
- text before `<OFX>` is the header; no `<OFX>` → `UNREADABLE` ("isn't an OFX statement");
- an element that has received text is a value, and the next tag closes it; a closing tag closes everything still
  open down to the element it names; a closing tag that matches nothing is ignored;
- tag names are case-insensitive and may contain dots (`INTU.BID`); comments and processing instructions are skipped;
- entities are decoded (`&amp;`, `&lt;`, `&#233;`, `&#xE9;`, `&nbsp;`, …);
- values are found anywhere below their aggregate. That copes with an empty SGML value (`<MEMO>` followed directly by
  the next tag), which SGML can't tell from an aggregate.

### Statements

| Aggregate | Statement | Account |
|---|---|---|
| `BANKMSGSRSV1 › … › STMTRS` | One per `STMTRS` | `BANKACCTFROM` |
| `CREDITCARDMSGSRSV1 › … › CCSTMTRS` | One per `CCSTMTRS` | `CCACCTFROM`, type `creditCard` |
| `INVSTMTRS` (investment) | **Not read** (see [gap G1](#known-gaps-and-discrepancies)) | — |

If no statement is found, the file is `UNREADABLE`. If the file holds a `STATUS` with `SEVERITY` `ERROR`, the bank's
`MESSAGE` (or its code) is quoted: "holds no statement. The bank said: …".

### Field mapping

| OFX | Becomes | Notes |
|---|---|---|
| `SONRS › FI › ORG` | `account.institution`, and the label's bank name | `INTU.BID` is **never** used: a converter may borrow another bank's |
| `BANKID` + `ACCTID` | `key: ofx:bank:<BANKID>:<ACCTID>` (strong), `accountNumber` | Card: `ofx:card:<ACCTID>` |
| `ACCTID` masked (`X`, `*`, `#`, `•`) | `numberIsPartial: true` | Account resolution then matches by the last four |
| `ACCTTYPE` | `account.type` | `CHECKING` → chequing; `SAVINGS`, `MONEYMRKT`, `CD` → savings; `CREDITLINE` → lineOfCredit |
| — | `account.label` | `<ORG or "Bank <BANKID>"> •••• <last 4>` |
| `CURDEF` | `currency` (upper case) | |
| `BANKTRANLIST › DTSTART`, `DTEND` | `period` | Dropped if it ends before it starts (a bank seen doing so) |
| `LEDGERBAL › BALAMT`, `DTASOF` | `balance` | Only when both read |
| `STMTTRN › DTPOSTED` | `date` | `YYYYMMDD`, time and zone ignored |
| `DTUSER` | `userDate` | Only when it differs from `date` |
| `TRNAMT` | `amount` | `.` or `,` as the decimal separator; **passed through as signed**, since OFX signs from the holder's side |
| `NAME` (or `PAYEE › NAME`) | `payee` | |
| `MEMO` | `memo` | |
| `CHECKNUM` | `number` | |
| `FITID` | `externalId` | Subject to [made-up id detection](#safeguards-every-format-gets) |
| `TRNTYPE` | `kind` | `CREDIT` credit, `DEBIT` debit, `INT` interest, `DIV` dividend, `FEE` fee, `SRVCHG` serviceCharge, `DEP`/`DIRECTDEP` deposit, `ATM`/`CASH` atm, `POS` pos, `XFER` transfer, `CHECK` cheque, `PAYMENT`/`REPEATPMT` payment, `DIRECTDEBIT` directDebit, `OTHER` other |

A transaction whose `DTPOSTED` or `TRNAMT` can't be read is left out with a warning naming its `FITID`.

### Why QFX and QBO need nothing more

They are read by exactly the same code. Because the key is built the same way from `BANKID` and `ACCTID`, an account
downloaded as OFX one month and QBO the next keeps its saved match and its bank ids, so nothing is asked again and
nothing is doubled. The one trait that is really QBO's, made-up ids, is detected for every OFX-family file, because
the same converters also write QFX and OFX.

## CSV

### What Tessera accepts

- RFC 4180 and what real exports do beyond it: quoted cells with doubled quotes and line breaks, `\r\n`, `\n` or
  `\r` line ends, rows of different widths, stray spaces around quoted cells, Excel's `="00123"` and `'00123` marks.
- **Delimiter** `,` `;` tab or `|`, detected from the first 50 non-blank lines (the one splitting most lines alike;
  ties: tab, `;`, `,`, `|`).
- **A header row or none**, with **preamble lines** before it (an account summary, a title).
- **Amounts**: one signed column; money out and money in columns; an unsigned amount with a debit/credit column
  (`DR`/`CR`, `Debit`/`Credit`); `12.50 CR` / `DR 12.50` suffixes and prefixes; parentheses for negatives; currency
  signs and codes; grouping by `,` `.` space or apostrophe; `.` or `,` as the decimal separator.
- **Dates** in any order (YMD, MDY, DMY), with `/ - .` or space, two-digit years (pivot: this year + 10), and
  English or French month names (`5 Oct 2026`, `05-oct.-2026`, `5 octobre 2026`).
- **English and French** header names: 147 names for 14 roles, plus the words cells use for pending rows and for
  debits and credits ([dictionary.ts](../plugins/format-csv/src/shared/dictionary.ts)).

### The layout

A layout (`CsvLayout`, version 1) says which column plays which **role**, and how the file is written:

| Field | Meaning |
|---|---|
| `delimiter`, `skip`, `header` | How rows are split; rows before the header (or data); whether there is a header |
| `dateOrder`, `decimal` | `YMD` / `MDY` / `DMY`; `.` or `,` |
| `reversed` | Every amount negated (money out written as positive) |
| `columns` | Roles: **Date** (required), **Transaction date**, **Amount**, or **Money out** + **Money in** (one of the two is required), **Debit or credit**, **Payee**, **Memo** (several, joined with ` · `), **Cheque number**, **Bank id**, **Balance**, **Status** (with its pending words), **Currency**, **Account number**, **Category** |

A layout is remembered by its **signature**: a hash of the delimiter and the normalised header cells, or, with no
header, of the column count and each column's shape (date, number, text, empty) in the first rows.

### Guessing, and the CSV Columns dialog

The guess ([guess.ts](../plugins/format-csv/src/shared/guess.ts)) looks at up to 1,000 rows. It finds the first row
that has both a date and a number, and the header as the nearest all-text row above it. It names columns from the
header's words (each checked against its column's data), then fills in the unnamed ones from their data. For the
amounts it tries the plausible readings (one signed column, or a money out and money in pair) and prefers the one that
reads the most rows, then the one that uses the most columns, then the one whose running balance adds up best.
Every choice it isn't sure of carries a reason, and the dialog highlights it.

The **CSV Columns** dialog (`format-csv.dialog.layout`) is shown **for every CSV file**. It has the options, a role
picker over each column, the file's first rows, and a **live preview** made by the same code that imports. What it
starts from:

| Start | When | First line of the dialog |
|---|---|---|
| `remembered` | A layout is remembered for this signature and still reads the file | "Same columns as last time…" |
| `recognised` | Nothing remembered; the guess is sure of everything | "Tessera recognised these columns…" |
| `guessed` | Nothing remembered; something is a guess | "Tessera guessed these columns. Check the highlighted ones…" |
| `dateOrderChanged` | Remembered, and reads the file once the date order is changed | "The dates in this file are day first; last time they were read month first…" |
| `misfit` | Remembered, but doesn't read the file (more than 2% of rows left out with a warning, or a column missing) | "These columns worked last time, but not for this file: …" |

For a headerless file whose column shapes changed (a month with no deposits), a remembered layout of the same width
and delimiter that still reads the file is used. The confirmed layout is saved under the signature, with the date
it was last used.

### Rows to lines

| Role | Becomes |
|---|---|
| Date / Transaction date | `date` / `userDate` |
| Amount | `amount`, signed by a Debit-or-credit column or a `CR`/`DR` mark, negated if `reversed` |
| Money out, Money in | `amount` = money in − money out, each taken as its absolute value |
| Payee | `payee` |
| Memo(s) | `memo`, joined with ` · `, leaving out any equal to the payee |
| Cheque number | `number` |
| Category | `category` (a hint) |
| Bank id | `externalId`; if any repeat within the file, the statement gets `stableIds: false` |
| Balance | The statement's `balance`: the chronologically last row's, signed the Tessera way (the sign worked out from how the balance moves with the amounts) |
| Currency | `currency` when every row agrees; several currencies → `UNREADABLE` ("Export each currency separately") |
| Account number | One statement per value; key `csv:account:<number>` (strong), `numberIsPartial` if masked |

**Left out quietly**: blank rows; rows with no amount (*Balance forward*, totals); rows with no date that say they
are totals or balances (*Total*, *Opening balance*, *Solde reporté*, …). **Left out with a warning**: rows whose
date or amount can't be read (by file line); **pending** rows, counted in one warning ("they'll come with a later
export, once the bank posts them"). The rows' order (oldest or newest first) is worked out from the dates, or the
balances when the dates don't say.

**No `period`**: a CSV export doesn't state one. The statement's key without an account column is
`csv:layout:<signature>`, labelled by its columns ("CSV file with columns Date, Description, Withdrawals, …").

### Corrections

When the sign cross-check reverses a CSV statement and the user ticks *Remember*, `correct` flips the remembered
layout's `reversed`. The next CSV Columns dialog shows it, and the import manager keeps no reversal of its own.

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

### Reading records

Lines starting with `!` open a section or set an option; other lines are a one-letter code and a value; `^` ends a
record. Every line end is accepted; blank lines and trailing spaces are ignored; a last record may lack its `^`; a `!`
line ends the record before it. Section names are compared ignoring case and spaces (`!Type:Oth A` = `!type:otha`).
No `!Type` or `!Account` line at all → `UNREADABLE`.

### Sections

| Section | Handling |
|---|---|
| `!Type:Bank` | Lines; account type chequing (savings if the account's name says *savings* or *épargne*) |
| `!Type:CCard` | Lines; creditCard |
| `!Type:Cash` | Lines; cash |
| `!Type:Oth A` / `!Type:Oth L` | Lines; otherAsset / otherLiability |
| `!Account` | Sets the account (`N` name, `T` type, `D` description) for the sections after it |
| `!Option:AutoSwitch` … `!Clear:AutoSwitch` | Quicken's whole-file account list: its `!Account` records are names only, not the current account |
| `!Type:Invst`, or transactions under an investment `!Account` type (`Invst`, `Port`, `401(k)`, `403(b)`, `Mutual`, `Brokerage`, `IRA`, `RRSP`, `TFSA`, `RRIF`, `RESP`) | **Left out**, one warning per account: "Tessera doesn't import investment transactions yet" |
| `!Type:Cat`, `Class`, `Memorized`, `Prices`, `Security`, `Bill`, `Invoice`, `Tag`, `Budget`, other `!Option:` / `!Clear:` | Left out quietly (lists and settings) |
| Anything else | Left out, one warning per section name |
| Records before any `!` line | Left out, with a warning |

A new statement starts when transaction sections appear under a different account. A single-account file gives one
statement; a Quicken whole-file export gives one per non-investment account, and an account with no transactions
gives a warning instead.

### Fields

| Code | Meaning | Becomes |
|---|---|---|
| `D` | Date | `date` (below) |
| `T` (or `U` when `T` is missing) | Amount | `amount` |
| `P` | Payee | `payee` |
| `M` | Memo | `memo` |
| `N` | Number | Digits → `number` and kind `cheque`; `ATM` → atm; `DEP`/`Deposit` → deposit; `EFT`/`XFER`/`TXFR`/`Transfer` → transfer; anything else → nothing |
| `L` | Category (with optional `/Class`), or `[Account]` for a transfer | A category → `category` hint, class removed. `[Account]` → kind `transfer`, no category |
| `S` / `$` (and `E`, `%`) | Split category / amount | The line keeps `T`; its memo gains "Split: Food:Groceries 64.12 · Household 20.00", cut to the memo limit. No category hint |
| `C`, `A`, `F`, investment codes | Cleared, address, reimbursable, … | Ignored |

**The opening-balance record.** A statement whose first record has payee *Opening Balance* (or *Solde d'ouverture*,
*Solde initial*) and an `L[Account]` isn't a bank transaction. It becomes the statement's `balance` (opening + every
line, as of the last line's date), so a new account is pre-filled with the right opening balance, and it also names
the account when there's no `!Account`.

### Dates, decimals and signs

- **Dates**: Quicken's apostrophe years (`10/05'26`, `1/ 5'26` → 2026), two-digit years (pivot this year + 10),
  `/ - .` separators, ISO always YMD. Padding spaces are removed. The order is decided **once per file, from every
  date together**, never record by record.
- **Decimals**: decided from every `T`, `U` and `$` together.
- **When the file can be read two ways** (every day ≤ 12; every amount fits both separators), the source's
  remembered option answers. Otherwise the **QIF Options** dialog (`format-qif.dialog.options`) asks, showing the
  file's own example read each way, with the order whose dates span the shortest time offered first. The answer is
  saved as `options:<key>` for every statement key in the file.
- **Signs** pass through as written (Quicken and Money sign from the account's side). A bank's QIF with card charges
  written as positive is caught by the sign cross-check, and a remembered reversal is kept in the source's QIF
  options through `correct`.

### The account

| The file | Key | Label |
|---|---|---|
| An `!Account N`, or an opening-balance record naming the account | `qif:account:<name, lower case, spaces collapsed>` (weak) | The name |
| Neither | `qif:file:<file-name stem>` (weak): `Checking 2026-10 (2).qif` → `qif:file:checking` | "<file> (no account name)" |

QIF has no account numbers, so the Account dialog appears each time (with the last account chosen) unless the user
ticks *Don't ask again*.

### Microsoft Money and Quicken exports

QIF is how a Money or Quicken user brings an account's history into Tessera: payees, memos, cheque numbers, the
opening balance for a new account, and categories where the ledger has the same ones (the user is asked once per
source whether the file's or the payee's usual category wins). Transfers become ordinary lines on each side; splits
become their totals; investments are left out. Because every line is known by fingerprint, exporting again later adds
only what is new, and *Already imported?* stops the overlap with the bank's own OFX or CSV from being doubled.
Cheques are paired by number, since Money names the person paid where the bank writes *CHEQUE 101*.

## The same account from several file types

| Imported first | Then | What happens |
|---|---|---|
| OFX | QFX or QBO of the same account | Same key and same bank ids: no question, no duplicates |
| OFX / QFX / QBO | CSV or QIF of the same period | Different keys (the CSV/QIF source is matched to the account once). Different import ids, so the overlap is proposed as **Already imported?**, not added |
| CSV | OFX of the same period | The same, the other way round |
| CSV | The same bank's CSV, a line's text changed (pending → posted) | Different fingerprint; caught by *Already imported?* (exact amount, ≤ 3 days, payees alike) |
| QBO from a converter | The next month's QBO from the same converter | Made-up ids detected, lines known by fingerprint; anything missed is caught by the collision guard |

---

# Part 3: Implementation plan

## What was built, and in what order

The work was planned and delivered in two series, recorded in the two source notes. Each phase has a *results*
section there, describing what was built, what was tested and anything that departed from the plan.

| Phase | Delivered | File types it enabled | Size | Record |
|---|---|---|---|---|
| 0 | `@tessera/import-api`; `shell.files` multi-select and Downloads; `accounts` bank-line methods (`externalId`, `createMany`, `match`, `unmatch`); register annotations; New Account with initial values | — (prerequisites) | M | [Phase 0](import-manager-design.md#phase-0-prerequisites-m) |
| 1 | The `import` plugin: *File › Import…*, formats, account resolution, duplicates, apply, recovery, summary, `import.manager`; **`format-ofx`** | **OFX, QFX** | L | [Phase 1 results](import-manager-design.md#phase-1-results) |
| 2 | Fuzzy matching, review in the register, Change Match, payee aliases, Strict/Balanced/Lenient | all | L | [Phase 2 results](import-manager-design.md#phase-2-results) |
| F0 | import-api 1.3: `prompt` with the paused clock, `CANCELLED`, per-statement `stableIds`, category hints, `text('auto')`, date helpers; the collision guard | groundwork for CSV, QIF | M | [F0 results](import-formats-design.md#phase-f0-results) |
| F1 | `qbo` in `format-ofx`, made-up id detection; `npm run anonymise` for the OFX family; the fixtures' privacy test | **QBO** | M | [F1 results](import-formats-design.md#phase-f1-results) |
| F2 | *Already imported?* proposals | all (required before CSV/QIF) | M | [F2 results](import-formats-design.md#phase-f2-results) |
| F3 | The sign cross-check (*Amounts Reversed?*), sign records, `correct` | all (required before CSV/QIF) | M | [F3 results](import-formats-design.md#phase-f3-results) |
| F4 | **`format-csv`**: rows, guess, CSV Columns dialog, remembered layouts; the anonymiser for CSV | **CSV** | L | [F4 results](import-formats-design.md#phase-f4-results) |
| F5 | **`format-qif`**: sections, dialects, QIF Options, Money and Quicken exports; the anonymiser for QIF | **QIF** | M | [F5 results](import-formats-design.md#phase-f5-results) |
| F6 | *File › Saved Import Choices…* (`describeMemory`, import-api 1.7) | all | S | [F6 results](import-formats-design.md#phase-f6-results) |

The order mattered. **F2 and F3 had to land before CSV and QIF shipped.** Both are fingerprint formats, the CSV-then-OFX
overlap is the common way transactions get doubled, and they are the formats whose signs are most often reversed.

## Code map

| Piece | Files |
|---|---|
| Contract | `packages/import-api/`: `contract.ts` (formats), `manager.ts` (service, report), `model.ts`, `protocol.ts` (ids, commands, dialogs, channels), `helpers.ts`, `errors.ts` |
| Import manager | `plugins/import/src/privileged/`: `run.ts` (the flow), `formats.ts`, `files.ts`, `accountResolution.ts`, `convert.ts`, `collisions.ts`, `matching/` (`duplicates`, `signs`, `score`, `assign`, `payees`, `tuning`), `signRecords.ts`, `categoryChoice.ts`, `drafts.ts`, `apply.ts`, `review.ts`, `annotator.ts`, `savedChoices.ts`, `memory.ts`, `store.ts`, `schema.ts`, `archive.ts`. Renderer dialogs: Format, Account, Signs, Categories, Summary, Match, Saved Choices |
| OFX / QFX / QBO | `plugins/format-ofx/src/privileged/`: `index.ts` (contribution, sniff, encoding), `sgml.ts` (tokenizer), `statements.ts` (statements, mapping, made-up ids) |
| CSV | `plugins/format-csv/src/shared/`: `csv.ts` (rows, delimiter), `cells.ts`, `dictionary.ts`, `guess.ts`, `layout.ts`, `lines.ts`, `fit.ts`, `dialog.ts`; `privileged/`: `index.ts` (sniff), `parse.ts` (flow, memory, `correct`); `renderer/LayoutDialog.tsx` |
| QIF | `plugins/format-qif/src/privileged/`: `qif.ts` (records), `statements.ts` (sections, fields, keys), `dates.ts`, `parse.ts` (flow, options, `correct`), `index.ts` (sniff); `shared/options.ts`; `renderer/OptionsDialog.tsx` |
| Anonymiser | `scripts/anonymise.mts`, `scripts/anonymise/` (`ofx.ts`, `csv.ts`, `qif.ts`, `scan.ts`, …) |

## Verification

**Automated.** Run on 2026-11-12 while writing this note:

```
npx vitest run tests/plugins/import tests/plugins/format-ofx tests/plugins/format-csv \
  tests/plugins/format-qif tests/packages/importApi.test.ts tests/scripts tests/fixtures/privacy.test.ts
→ Test Files 44 passed (44) · Tests 690 passed (690)
```

| Suite | Covers |
|---|---|
| `tests/plugins/format-ofx/` | Both dialects, encodings, QFX/QBO, `INTU.BID` ignored, made-up ids, bank errors |
| `tests/plugins/format-csv/` | Rows and delimiters, guessing over the layout corpus, lines, the CSV Columns dialog |
| `tests/plugins/format-qif/` | Records, sections, dates, statements, the QIF Options dialog |
| `tests/plugins/import/` | The flow, account resolution, duplicates, collisions, *Already imported?*, signs, matching (including a 2,000-line × 10,000-transaction scale test), review, saved choices, archive, real files, and the built plugins end to end (`pipeline.test.ts`) |
| `tests/scripts/`, `tests/fixtures/privacy.test.ts` | The anonymiser, and that no committed fixture looks personal |

**Fixtures.** 22 CSV layouts with expected results (`tests/fixtures/import/csv/layouts/`), a 12-case matching corpus,
2 preset cases, 2 converter-made QBO files, and anonymised real files: 2 banks' QBO, 2 banks' CSV, and a Money account
as loose and strict QIF (`tests/fixtures/import/real/`). There are **no real `.ofx` or `.qfx` downloads, and no real
Quicken export**, among them.

**By hand.** 22 sample statements in `samples/statements/`, with walkthroughs for each behaviour (see R1 for what
hasn't been walked through yet).

## Known gaps and discrepancies

Found while writing this note, by reading the code against the two source designs. G1 was confirmed by running the
reader on a small file.

| # | What | Evidence | Impact | Fix |
|---|---|---|---|---|
| G1 | **An OFX file's investment statement is dropped with no warning.** `statementsOf` reads only `STMTRS` and `CCSTMTRS`. A file with a bank statement and an `INVSTMTRS` imports the bank part, and the summary says nothing about the rest. A file with only an investment statement fails with "holds no bank or credit card statement" | Ran `statementsOf` on a file with both: 1 statement, 0 warnings. QIF warns in the same case | The user can think an investment account was imported | R3 |
| G2 | **QIF `!Account` balance (`$`, `/`) isn't read**, though the design's Sections table says it is "when given". Only the opening-balance record gives a QIF statement its balance | `QifAccount` holds only `N`, `T`, `D` (`plugins/format-qif/src/privileged/statements.ts`) | A QIF with an `!Account` balance but no opening-balance record has no bank balance, so the sign cross-check loses its balance evidence, and a new account isn't pre-filled with an opening balance | R3 (decide: read it, or correct the design) |
| G3 | **The 50,000-line QIF measurement wasn't recorded.** The formats design's Risks said F5 would measure a whole-history file, and would make matching yield before shipping if the window stalled for more than a few seconds. The F5 results record no measurement, and no test uses a file that size | No match for such a measurement in the F5 results or the tests; `todo.md` still lists *Yield while matching* as open | A Money or Quicken user importing 20 years of history may see the window freeze | R4 |

## Remaining work

Everything below is either listed as open in [todo.md](todo.md) or is one of the gaps above. Sizes follow the house
convention (S, M, L).

```
R1 manual checks ─────────────┐
R2 real files ──► R3 format fixes (G1, G2) ──► done for the formats
R4 large imports (G3) ────────┘
R5 history and undo (import-manager phase 4): independent
R6 categories beyond exact paths: a decision first
```

### R1: finish the checks by hand (S)

The behaviours are tested, but several haven't been seen in the app. In `npm run dev`, with a fresh
`--user-data-dir`, in **light and dark** themes:
- [ ] F0: the Cedar Credit Union walkthrough in the light theme (dark done).
- [ ] F3: [Amounts the wrong way round](../samples/statements/README.md#amounts-the-wrong-way-round).
- [ ] F4: the rest of [CSV files](../samples/statements/README.md#csv-files): the role pickers' menus, and the CSV
  Columns dialog with a wide file.
- [ ] F5: [Bringing accounts over from Money or Quicken](../samples/statements/README.md#bringing-accounts-over-from-money-or-quicken),
  including QIF Options.
- [ ] F6: *File › Saved Import Choices…* after the walkthroughs above.
- [ ] Phase 2: [Matching and review](../samples/statements/README.md#matching-and-review): the register's marks, buttons,
  review bar and Change Match.

**Done when:** each item is ticked in `todo.md`, with anything found fixed or filed.

### R2: real-file coverage (S, depends on users' downloads)

Using `npm run anonymise` ([how](../tests/fixtures/import/real/README.md)):
- [ ] a **Quicken export**, a whole file if possible (AutoSwitch, several accounts, an investment account to be left
  out);
- [ ] a **bank's CSV and QBO (or OFX) of the same period**, anonymised together, to test *Already imported?* on a
  real pair;
- [ ] a real **`.ofx`** and a real **`.qfx`** download: today only QBO represents the OFX family among the real files.

**Done when:** each file is in `tests/fixtures/import/real/` with its `.meta.json`, `realFiles.test.ts` imports it,
and the privacy test passes.

### R3: format fixes from this review (S)

1. **G1, OFX investment statements.** In `statements.ts`, count `INVSTMTRS` aggregates and add one warning each, in
   the QIF wording: "An investment account (•••• 1234) was left out: Tessera doesn't import investment transactions
   yet." When a file holds *only* investment statements, make the `UNREADABLE` message say so rather than "no bank or
   credit card statement".
   *Tests* (`tests/plugins/format-ofx/ofx.test.ts`): a bank statement plus an investment statement gives 1 statement
   and 1 warning; an investment-only file gives the new message.
2. **G2, QIF `!Account` balance.** Decide first ([Open questions](#open-questions)). If it is read: keep `$` and `/`
   on `QifAccount`, and when the statement has no opening-balance record, use them as `balance` (`asOf` from `/`,
   read with the file's date order). The opening-balance record still wins when both are present. If it isn't read:
   correct the Sections table in import-formats-design.md.
   *Tests* (`tests/plugins/format-qif/statements.test.ts`): balance from `!Account` alone; the opening record
   winning; a `/` date in the file's order.

**Done when:** tests pass, the summary shows the new warning on a sample file, and the gap rows above are marked done.

### R4: large imports stay responsive (M)

1. **Measure** first (G3): generate a 50,000-line QIF (20 years, one account) and a 50,000-line CSV, and import each
   into an empty account and into one with 20,000 transactions. Record the parse time, the main-process stall, and
   the time to the summary.
2. **If the window stalls for more than about 2 seconds**, make matching and applying yield to the event loop in
   chunks (for example every 500 lines), keeping one import at a time and the ledger's long operation. Show progress
   in the status bar (`import.isRunning` already exists).
3. Check the 25 MB limit and the 30-second parse clock against the measured parse times.

*Tests:* a scale test at 50,000 lines with a CPU-time budget, alongside `matching/scale.test.ts`; a test that IPC is
answered while a large import runs.
**Done when:** the measurements are recorded in todo.md, and *Yield while matching* is ticked or explicitly deferred
with the numbers.

### R5: import history and undo (M)

This is the import manager's [phase 4](import-manager-design.md#phase-4-history-undo-and-saved-matches-m), less
the Saved Account Matches dialog, which F6 built as *Saved Import Choices*. It applies to all five file types alike:
- **Import History** view (`import.history`, *File › Import History*): every batch with its date, file, format,
  account and counts; its lines and their outcomes; *Show in Register*.
- **Undo Import** (`import.batch.undo`): remove what a batch added, put back what it matched, mark it undone, and
  refuse, with a list, if any of it has since been reconciled.
- **Navigator badges**: a count of rows to review beside each account.

The commands, channel and view ids are already reserved in `protocol.ts` (`showHistory`, `undoImport`, `history`).
**Done when:** phase 4's tests (undo in every combination, badges following reviews) pass and its walkthrough has been
done by hand.

### R6: a file's categories beyond exact paths (decision, then S)

Money's default categories (*Groceries*, *Bills:Telephone*) rarely match Tessera's starter paths (*Food : Groceries*),
so many QIF hints go unused today. The [options](import-formats-design.md#later) are: resolve a hint by its last part
when exactly one category has that name, or let *Categories from the File* offer to create the missing ones. Either
changes decision F-9, so it needs a decision before it is built ([Open questions](#open-questions)).

## Later (not scheduled)

From both source notes; listed so the design leaves room for them.

| Item | Notes |
|---|---|
| **Excel** (`.xls`, `.xlsx`) | A format plugin that turns the first sheet into rows and reuses CSV's layout code and dialog |
| **Investments** | Needs holdings in `accounts` first; then OFX `INVSTMTRS` and QIF `!Type:Invst` |
| **Transfer pairs** | Pair a new line in one account with its mirror in another (also the two sides in a QIF whole-file export) |
| **Reconcile with the downloaded statement** | An `accounts.reconcile.actions` contribution using the batch's period and bank balance |
| **A hint from the file name** | `chequing-5678.csv`: digits as a partial account number, for the Account dialog's ranking only |
| **Save an anonymised copy from the app** | *Help › Save Anonymised Copy of a Statement…*, for bug reports |
| **Per-bank CSV presets** | Only if the guesser falls short on real files |
| **Downloads inbox, drag and drop** | Start an import without the menu (needs a shell facility for file drops) |
| **`.mny` reader, bank connections** | Other plugins calling `import.manager.importStatements` |

## Open questions

| # | Question | Options | Suggested |
|---|---|---|---|
| Q1 | Should a QIF `!Account` `$` balance be read (G2)? | (a) Read it when there is no opening-balance record; (b) don't read it, and correct the design | **(a)**: it gives the sign cross-check its strongest evidence and new accounts their opening balance, at little cost. But check it on a real Quicken whole-file export (R2) first, as the `$` may be the *current* balance rather than one matching the lines |
| Q2 | Categories beyond exact paths (R6) | Match by the last part when unique; offer to create; both; neither | Needs the owner's decision: both options change F-9 |
| Q3 | What stall is acceptable for R4? | A number of seconds, or "always yield" | About 2 s before yielding is needed; confirm once measured |

## Definition of done

For each item of remaining work, as for the phases before it:
- [ ] `npm test` green, including the architecture boundaries and the fixtures' privacy test
- [ ] No new errors from `npx tsc --noEmit -p plugins` (and `-p tests` when tests are touched)
- [ ] Every disposable pushed onto `context.subscriptions`
- [ ] Checked by hand in `npm run dev`, in light and dark themes, where anything visible changed
- [ ] `todo.md` ticked; results recorded in the source note's phase results, or here for R3

## Documentation changes

| When | Change |
|---|---|
| With this note | None required elsewhere. Optional: list this note in README's *Documentation* section. import-formats-design.md isn't listed there either |
| R3 | Mark G1/G2 fixed here; if Q1 is (b), correct the QIF Sections table in import-formats-design.md |
| R4 | Record the measurements in todo.md and here (G3) |
| R5 | README: history and undo under *Importing statements*; plugin-creation.md if `RegisterAnnotator.counts()` is added |
| R6 | Amend F-9 in import-formats-design.md; *Category hints* there and the QIF section here |
