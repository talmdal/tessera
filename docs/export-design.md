# Design and implementation: exporting to CSV, OFX, QFX, QBO and QIF

| | |
|---|---|
| **Status** | **Done 2026-11-12.** Every file type Tessera imports can be exported, from *File › Export…* or *Accounts › Export Account…*: phases X1 to X4 are built, each with its results below, and were checked by hand on Windows as far as Tessera goes (exported, then imported back). Reviewed: Q1 to Q11 answered, and the answers applied throughout ([Decisions taken in review](#decisions-taken-in-review)); no question is open. **Left for later** ([Later](#later)): the checks in other programs (X0's Money, Quicken, QuickBooks, GnuCash and Excel, and the OFX specification's lengths), so assumptions A2 to A16 stay open; and the `export.manager` service for other plugins, until a plugin needs it |
| **Date** | 2026-11-12 |
| **Scope** | *File › Export…*: writing an open ledger's transactions to the five file types Tessera imports, **CSV**, **OFX**, **QFX**, **QBO** and **QIF**, for spreadsheets, for other finance applications (Microsoft Money, Quicken, QuickBooks, GnuCash), for an accountant, and for moving accounts between Tessera ledgers. An `export` plugin (the *export manager*) with an `export.formats` extension point, a contract `@tessera/export-api`, and writer plugins |
| **Builds on** | [import-file-types-design.md](import-file-types-design.md) (what each file type is, as Tessera reads it); [account-manager-design.md](account-manager-design.md) (`accounts.service`, the register, statuses, transfers); [plugin-creation.md](plugin-creation.md) (`shell.dialogs`, `shell.files`, `context.state`); [backup-restore-design.md](backup-restore-design.md) (one long operation at a time, writing a file under a temporary name and renaming it) |
| **Changes to other notes** | None. Exporting stays a non-goal of the *import* designs; this note designs it separately. Nothing in `@tessera/import-api` or the import plugins changes |
| **Layout** | [Part 1](#part-1-design) is the design (*how exporting works*). [Part 2](#part-2-definition-of-each-file-type) is the definition (*exactly what is written for each file type*). [Part 3](#part-3-implementation-plan) is the implementation plan. Phases are numbered **X0 to X4** (X for *export*), so they aren't confused with import's 0 to 4 and F0 to F6 |

- [Summary](#summary)
- [Naming](#naming)
- [Context](#context)
- [Why people export](#why-people-export)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- **Part 1: Design**
  - [Architecture](#architecture)
  - [The contract: `@tessera/export-api`](#the-contract-tesseraexport-api)
  - [The export flow](#the-export-flow)
  - [The Export dialog](#the-export-dialog)
  - [What is exported](#what-is-exported)
  - [Writing the file safely](#writing-the-file-safely)
  - [What exports remember](#what-exports-remember)
  - [Account fields for OFX](#account-fields-for-ofx)
  - [Errors and outcomes](#errors-and-outcomes)
  - [Privacy and security](#privacy-and-security)
- **Part 2: Definition of each file type**
  - [The five file types at a glance](#the-five-file-types-at-a-glance)
  - [CSV](#csv)
  - [QIF](#qif)
  - [OFX](#ofx)
  - [QFX and QBO](#qfx-and-qbo)
  - [What survives a round trip](#what-survives-a-round-trip)
  - [Other applications](#other-applications)
- **Part 3: Implementation plan**
  - [Ground rules](#ground-rules)
  - [Dependency graph and order](#dependency-graph-and-order)
  - [Phase X0: compatibility spike (S)](#phase-x0-compatibility-spike-s), with its [results](#phase-x0-results)
  - [Phase X1: rename, contract, export manager and CSV (L)](#phase-x1-rename-contract-export-manager-and-csv-l)
  - [Phase X2: QIF (M)](#phase-x2-qif-m)
  - [Phase X3: OFX, QFX and QBO, and the account fields (L)](#phase-x3-ofx-qfx-and-qbo-and-the-account-fields-l)
  - [Phase X4: Export Account… (S)](#phase-x4-export-account-s), with its [results](#phase-x4-results)
  - [Testing](#testing)
  - [Alternatives considered](#alternatives-considered)
  - [Risks](#risks)
  - [Decisions taken in review](#decisions-taken-in-review)
  - [Open questions](#open-questions)
  - [Later](#later)
  - [Documentation changes](#documentation-changes)
  - [Definition of done](#definition-of-done)
  - [Phases](#phases)

---

## Summary

- **An export manager, file-type plugins that read and write, and five file types.** This mirrors import:
  - a new **`export`** plugin owns *File › Export…* and knows no file format;
  - each file type's reader and writer live together in one **file-type plugin** (decided in review, Q1):
    **`format-csv`**, **`format-qif`** and **`format-ofx`** (OFX, QFX and QBO), which replace `import-csv`,
    `import-qif` and `import-ofx`. Each contributes to both `import.formats` and **`export.formats`**;
  - a writer is a pure function: neutral, already-resolved data in, bytes out.
- **One dialog, then the usual Save dialog.** *Export* asks for the format, the accounts (one, several or all), the
  dates, and the format's own options. The format's options are declared as data, so a writer plugin needs no UI.
  The dialog shows what will be written, and anything that will be cut or changed, before the user picks a file.
- **Exporting never changes the ledger.** Nothing is marked as exported. So it works on a **read-only ledger**
  too, including an archive file opened for viewing: a way to hand archived years to an accountant.
- **Each file type has one job:**
  - **CSV** is for spreadsheets. Its header uses names Tessera's own CSV import recognises;
  - **QIF** moves whole accounts, or a whole ledger, to Quicken, Money, GnuCash or another Tessera ledger, with
    categories, transfers, statuses and opening balances;
  - **OFX** produces the bank statement Money and most finance applications read, one account at a time;
  - **QFX and QBO** are OFX for Quicken and QuickBooks, which expect the user's bank's Intuit id. The id is kept
    on the account (Q2), with the OFX bank number. Without it the file is written with a warning (Q3). Tessera
    **never makes one up** or borrows another bank's.
- **Tessera's own readers are the test oracle.** Every writer is tested by reading its output back with the reader
  in the same plugin and comparing the result with the source data. A manual compatibility check against the real
  target applications is phase X0, before the defaults are fixed.
- **The plan: X0 to X4.** X0 is the compatibility spike (S). X1 renames the import plugins into the file-type
  plugins and adds the contract, the export manager and CSV (L). X2 is QIF (M). X3 is OFX, QFX and QBO, with the
  account's bank number and Intuit id (L). X4 adds *Export Account…* in the Accounts menu (S). X2 and X3 can be built
  in parallel after X1. All are built; X0's checks in other programs, and an `export.manager` service for other
  plugins (first planned in X4), are left for later.

---

## Naming

| Concept | User-facing name | Code name | Notes |
|---|---|---|---|
| The plugin that runs exports | (not shown) | `export` plugin, the **export manager** | Owns *File › Export…* and `export.formats` |
| A file type it can write | *Format* | `ExportFormatContribution` + `ExportFormat` service | One contribution per file type; one service may back several |
| What is handed to a writer | (not shown) | `ExportData` | Accounts, their transactions in the range, categories: names, not ids |
| The dates covered | *Dates* | `ExportRange` `{ from, to }` | Inclusive, YYYY-MM-DD |
| A choice a format offers | The format's *options* | `ExportOptionField` | Declared as data; drawn by the export dialog |
| A file-type plugin | (the plugin's name: *OFX files*) | `format-ofx`, `format-csv`, `format-qif` | Reads and writes one family of file types |
| An account's ids for OFX | *Bank number*, *Intuit bank id* (Account dialog) | `Account.bankId`, `Account.intuitBankId` | New optional account fields (Q2) |
| The id a bank gives a line, written back out | (not shown) | OFX `FITID` | The bank's own id when the transaction has one, else `TESSERA.<transaction id>` |

---

## Context

What already exists, and what exporting uses from it:

| Facility | Used for |
|---|---|
| `accounts.service`: `list`, `chart`, `transactions(id).register()`, `categories.list()`, `payees.search('')` | Everything exported. `register()` gives rows in register order with running balances that match what the user sees |
| `categoryLabel`, `transferLabel`, `STATUS_LETTERS`, `minorDigits`, `periodStart` (`@tessera/accounts-api`) | Names and labels exactly as the register shows them |
| `amountToInput` (exact) — **not** `formatAmount` | `formatAmount` divides by 10^digits in floating point, which is fine for display but not for a file. Exports convert minor units to text with integers only (a helper in `@tessera/export-api`) |
| `shell.files.showSaveDialog` | Choosing the file. The platform's dialog asks before replacing one |
| `shell.dialogs` + `shell.prompts.show`, `shell.prompts.message` | The Export dialog, and the result message |
| `ledger.session.beginOperation(label)` | One long operation at a time: no import, backup, archive or Close Ledger while an export reads the ledger. Reading and editing carry on |
| `context.state` (application state) | What exports remember between runs |
| The context keys `accounts.register.account`, `accounts.selection.kind`, `accounts.selection.id` | Preselecting the account the user is looking at |
| The ledger plugin's `.partial` file and `renameWithRetry` (`plugins/ledger/src/privileged/backup/`) | The pattern for writing a file safely. Plugins can't share code, so the export plugin has its own small copy |
| The readers, in the file-type plugins (`plugins/format-csv`, `format-qif`, `format-ofx`) | The test oracle: a writer's output is read back by the reader beside it |
| `npm run sample:archive` (`scripts/sample-archive/household.ts`) | A realistic sample ledger for X0 and for checking by hand |

---

## Why people export

| Who | Wants | Format |
|---|---|---|
| Someone doing their taxes or a budget in a spreadsheet | A year of transactions with categories | **CSV** |
| A user leaving Tessera, or trying another application alongside it | Their accounts, with history, categories and balances, in Money, Quicken or GnuCash. Being able to leave is part of trusting an application with your money | **QIF** (whole accounts); **OFX/QFX** (statements) |
| A small business whose bookkeeper uses QuickBooks | The business account's transactions in the only form QuickBooks imports | **QBO** |
| Someone who archived old years | Those years in a portable form, from the archive file | Any, from a read-only archive |
| Someone splitting or merging ledgers | Accounts moved from one Tessera ledger to another | **QIF** (Tessera reads it back, with categories) |

---

## Goals and non-goals

**Goals**

- Write each of the five file types so that **Tessera reads it back** without loss in the fields the format has, and
  so that the usual target application accepts it (checked in X0).
- **Exact amounts**: never floating point, and the currency's own decimals (0 for JPY, 3 for BHD).
- **Never change the ledger**, and work on read-only ledgers.
- **Say what is lost or changed before writing** (a payee cut to OFX's 32 characters, a character the encoding can't
  hold, voided transactions left out), never afterwards.
- **Never leave a half-written file** under the name the user chose.
- Keep writer plugins small and pure, testable without a ledger, and let other plugins add formats.

**Non-goals**

- **Changing the ledger in any way**, including "exported" marks or "export only what's new" tracking. A date range
  covers that need. For OFX, stable FITIDs make overlapping exports harmless in applications that honour them.
- **Splits** (Tessera has none yet), **investment transactions** (none), **budgets, reports, reconciliation history**.
- **A full migration format** (Money's `.mny`, Quicken's `.qdf`). QIF is the portable route.
- **Excel** (`.xlsx`) and **PDF**. See [Later](#later).
- **Impersonating a bank**: QFX and QBO are written only with the Intuit id the user provides for their own bank.
- **Scheduled or automatic exports**: an `export.manager` service would leave room for a plugin that does this ([Later](#later)).

---

## Decisions

| # | Decision | Why |
|---|---|---|
| E-1 | **An export manager plugin, `export`, with an `export.formats` extension point. Each file type's reader and writer are one file-type plugin** (`format-csv`, `format-qif`, `format-ofx`), contributing to both points (Q1) | The manager knows no file format, and a new format is a plugin, as for import. One plugin per file type keeps what Tessera knows about a dialect in one place, with its reader and writer tested together. Tessera is in development, so renaming the import plugins is acceptable |
| E-2 | **Writers get resolved, neutral data and return bytes** (`ExportData` → `Uint8Array`). They never touch the ledger, the file system or the user | Pure and testable. Reading, checking and writing files are written once, in the manager |
| E-3 | **Amounts cross the contract as canonical decimal strings** with the currency's digits (`'-84.12'`, `'1200'` for JPY) | Symmetric with import's `StatementLine.amount`. Exact, and the writer only chooses the separator |
| E-4 | **Format options are declared as data** (`ExportOptionField`: choice, boolean, text) and drawn by the export dialog. The account fields a format writes are declared too (`accountFields`) | A writer plugin needs no renderer. Every format's options look and behave alike. A format that one day needs its own dialog can get a `prompt` as import formats have, without breaking this |
| E-5 | **The ledger is never changed by an export, and read-only ledgers can be exported** | An export is a copy. An archive file is exactly what an accountant may want |
| E-6 | **An export holds the ledger's long operation** ("Exporting transactions") while it reads and writes | No import, archive or close can change what is read halfway through. Edits in the register can still happen, but the Export dialog is modal and the read is short |
| E-7 | **OFX, QFX and QBO stay in one plugin, `format-ofx`**: one reader (as today) and one writer, with three export contributions | They are one format, with two Intuit tags. Separate plugins would need the reader and writer copied or moved into a shared package, because plugins can't share code, and the import design turned down a separate QBO plugin for the same reason. One plugin also keeps an account's key and bank ids the same whichever of the three a bank gives. Three export contributions, because the user chooses the *target*: the extension and the Intuit id differ |
| E-8 | **QFX and QBO write the Intuit bank id (`INTU.BID`) of the user's own bank**, from the account's *Intuit bank id*. **Without one, the file is written without the tag, with a warning** (Q3). Tessera ships no list of ids and no default | Quicken and QuickBooks are expected to accept only ids of institutions they know (checked in X0), so the warning says the file may be refused, and that OFX is the alternative. Writing another bank's id would make a file claim to come from a bank it didn't come from, which converter tools do and Tessera won't |
| E-9 | **An OFX family file holds one bank or card account.** Other account types (cash, loans, assets) are offered only in QIF and CSV | OFX bank and card statements have no types for them. Several accounts in one OFX file is allowed by the standard, but target support is uncertain ([Later](#later)) |
| E-10 | **OFX `FITID` is the bank's own id when the transaction was imported with one, else `TESSERA.<transaction id>`** | Both are stable, so exporting overlapping ranges doesn't double transactions in applications that check FITIDs. Keeping the bank's id also lets a target recognise the line when it later downloads from the same bank. Import fingerprints (`fp:…`) are not bank ids and aren't written |
| E-11 | **Voided transactions are left out by default**, always in OFX, and optionally included in CSV. QIF has no void convention Tessera can rely on | None of Tessera's readers knows "void", so a voided row read back would become a real transaction. The summary counts what was left out |
| E-12 | **CSV headers use names Tessera's CSV import recognises**, and uncleared rows are never labelled "Pending" | A Tessera CSV then reads back as *recognised*, with nothing guessed (checked). "Pending" rows are left out by the CSV import |
| E-13 | **CSV text cells that a spreadsheet would run as a formula are protected** with a leading `'` (on by default) | A payee from a bank's file can start with `=`, `+`, `-` or `@`. Tessera's CSV import takes the `'` off again (checked) |
| E-14 | **Defaults favour the target applications**: QIF and OFX in Windows-1252 with CRLF line ends, QIF dates month first with four-digit years; CSV in UTF-8 with a byte-order mark and ISO dates | Money and Quicken are Windows programs of the 1252 era. A byte-order mark is how Excel knows a CSV is UTF-8, and ISO dates are never ambiguous. Every default is an option, and X0 confirms each |
| E-15 | **An account's OFX ids are account fields** (`bankId`, `intuitBankId`, beside the existing `accountNumber`), edited in the Account dialog (Q2). **Export preferences live in application state** | The ids describe the account, travel with the ledger, and are there in an archive file too. OFX imports can fill them in. Preferences (a CSV's separator, QIF's date order) belong to the user, need no schema, and work for read-only ledgers |

---

# Part 1: Design

## Architecture

```
          File › Export…        Accounts › Export Account… (X4)        export.manager (later)
                 │                        │                                   │
                 ▼                        ▼                                   ▼
┌────────────────────────────── export (the export manager) ─────────────────────────────┐
│ Export dialog · checks and preview · gather (accounts.service) · Save dialog ·         │
│ write .partial → rename · result message · remembered choices                          │
└────────┬───────────────────────────────┬──────────────────────────────┬────────────────┘
         │ export.formats (data)         │ ExportFormat service          │ accounts.service,
         │                               │ check(data) · write(data)     │ ledger.session,
         ▼                               ▼                               │ shell.files/prompts,
┌────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐ │ app.state
│ format-csv     │  │ format-qif      │  │ format-ofx                  │
│ .csv           │  │ .qif            │  │ .ofx · .qfx · .qbo          │
│ read · write   │  │ read · write    │  │ read · write                │
└────────────────┘  └─────────────────┘  └─────────────────────────────┘
        ▲ import.formats (data) + ImportFormat service, to the import manager, as today
   each depends on @tessera/import-api and @tessera/export-api (and @tessera/types, @tessera/accounts-api)
```

- **File-type plugins** (Q1) replace `import-csv`, `import-qif` and `import-ofx`. Each provides two services, its
  `ImportFormat` (`format-csv.import`) and its `ExportFormat` (`format-csv.export`), and contributes to both
  extension points. The import manager and the export manager stay independent of each other: each sees only its
  own point. The writers add nothing to the renderer: their options are data (E-4). `format-csv` and `format-qif`
  keep the renderers they have today for CSV Columns and QIF Options.
- **The export manager** requires `accounts.service`, `ledger.session`, `shell.files`, `shell.prompts` and
  `app.state`. It provides no service: `export.manager` is left for later.
- **`@tessera/export-api`** (`packages/export-api/`) holds types, constants and pure helpers only. It depends on
  `@tessera/types`, `@tessera/ledger-api` and `@tessera/accounts-api`, like `import-api`. The architecture test's list
  of API packages gains it.
- **The import and export managers don't depend on each other.** Without the `export` plugin, the file-type plugins'
  export contributions are simply unused, and the same goes the other way.

## The contract: `@tessera/export-api`

```ts
/** Contributed as data: context.extensions.contribute(pluginId, EXPORT_FORMATS_POINT, c.id, c). */
export interface ExportFormatContribution {
  id: string                 // '<pluginId>.<name>': 'format-qif.qif'
  label: string              // 'QIF file (Quicken, Microsoft Money, GnuCash)'
  extension: string          // one, lower case, no dot: 'qif'
  service: string            // the ExportFormat service: 'format-qif.export'
  description?: string       // one sentence, under the format in the dialog
  order?: number             // lower first; default 0
  /** How many accounts one file holds. */
  accounts: 'one' | 'many'
  /** The account types it can write; all when absent. */
  accountTypes?: AccountType[]
  /** Choices for the whole file, drawn in the dialog. */
  options?: ExportOptionField[]
  /**
   * The account fields the format writes (Q2): shown in the dialog for each chosen account, filled in from the account.
   * 'required': an empty one is a problem; 'recommended': an empty one is a warning (QFX's Intuit id, Q3).
   */
  accountFields?: AccountFieldUse[]   // export-api 1.2: { field, need: 'required' | 'recommended', accountTypes? }
}

/** A field the export dialog draws. The shapes follow the settings framework's fields. */
export type ExportOptionField =
  | { kind: 'choice', key: string, label: string, description?: string, default: string,
      options: { value: string, label: string, description?: string }[] }
  | { kind: 'boolean', key: string, label: string, description?: string, default: boolean }
  | { kind: 'text', key: string, label: string, description?: string, default: string,
      required?: boolean, maxLength?: number, pattern?: string /* e.g. '^[0-9]+$' */ }

export type ExportOptions = Record<string, string | boolean>

/** The service behind a contribution. Both methods are pure: no ledger, no files, no user. */
export interface ExportFormat {
  /**
   * What writing `data` with `options` would do: problems that stop it (an account type the format can't write, a
   * required value missing), and warnings about what will be cut or changed. Cheap: the dialog calls it as the user
   * changes things. `formatId` says which contribution, for a service backing several.
   */
  check(data: ExportData, options: ExportOptions, formatId: string): ExportCheck
  /** The file's bytes. Called only when `check` found no problems. */
  write(data: ExportData, options: ExportOptions, formatId: string): Promise<ExportOutput>
}

export interface ExportCheck {
  transactions: number         // how many the file will hold (added in X1)
  accountsLeftOut?: string[]   // accounts the file won't hold, by id: one with nothing to write (export-api 1.1)
  problems: string[]
  warnings: string[]
}
export interface ExportOutput { bytes: Uint8Array, warnings: string[] }

/** What a writer is given: resolved and ordered, names rather than ids. Structured-cloneable. */
export interface ExportData {
  ledger: { name: string }
  /** ISO date-time of the export. */
  exportedAt: string
  range: ExportRange
  /** In navigator order. */
  accounts: ExportAccount[]
  /** Every category, as paths from the top ('Food', 'Groceries'), for formats that write a category list. */
  categories: { path: string[], kind: 'income' | 'expense' }[]
}

export interface ExportRange { from: string, to: string }   // inclusive, YYYY-MM-DD

export interface ExportAccount {
  id: string
  name: string
  type: AccountType
  currency: string
  /** The currency's decimals: 2 for CAD, 0 for JPY. */
  digits: number
  institution?: string
  accountNumber?: string
  /** Sub-ledgers from the top: ['Household', 'Joint']; empty for the ledger itself. */
  location: string[]
  /** The balance at the start of `from` (before its first transaction), and the date it is for. */
  opening: { date: string, balance: string }
  /** The balance at the end of `to`. */
  closing: { date: string, balance: string }
  /** `from` was moved later: the account's earlier transactions are in an archive file. */
  startsAtArchive?: boolean
  /** The account's OFX bank number (BANKID), and its bank's Intuit id (INTU.BID), when set on the account (Q2). */
  bankId?: string
  intuitBankId?: string
  transactions: ExportTransaction[]
}

export interface ExportTransaction {
  /** Tessera's id (a ULID): stable, unique. */
  id: string
  date: string
  /** Canonical decimal with the currency's digits, from this account's side: '-84.12'. */
  amount: string
  number?: string
  payee?: string
  /** Category path from the top: ['Food', 'Groceries']. Absent for transfers and uncategorised ones. */
  category?: string[]
  /** The other side of a transfer. */
  transfer?: { account: string, direction: 'to' | 'from' }
  memo?: string
  status: ClearingStatus
  voided: boolean
  /** The bank's id for the line, when it was imported with one (never an import fingerprint). */
  bankId?: string
  /** The running balance after this transaction (unchanged by a voided one). */
  balance: string
}
```

**Helpers for writers** (pure, in `helpers.ts`, each with tests):
- `minorToDecimal(minor, digits)`: exact, for example `-8412, 2` → `'-84.12'`;
- `withSeparator(decimal, ',')`: `'-84.12'` → `'-84,12'`;
- `encodeText(text, 'utf-8' | 'windows-1252', { bom })`, returning `{ bytes, replaced }`. For windows-1252, a
  character it can't hold is first reduced to its base letter (`ő` → `o`, and from a small table for letters
  Unicode doesn't decompose, such as `Ł` → `L`, found in X0); otherwise it becomes `?`, and
  `replaced` counts these for the warning;
- `safeFileName(name)`: a name that is valid on Windows, macOS and Linux;
- `isoToParts(date)`: the date's year, month and day as numbers.

**Names** (`protocol.ts`, as the import plugin's are): `EXPORT_PLUGIN_ID = 'export'`,
`EXPORT_FORMATS_POINT = 'export.formats'`, `EXPORT_MANAGER_SERVICE = 'export.manager'` (reserved, for later);
commands `export.file` and `export.account` (argument `ExportAccountArgs`, `{ id }`); the dialog
`export.dialog.export`; the IPC channel `export:check` (the dialog's input comes with it, so no channel prepares it);
context keys `export.hasFormats` and `export.isRunning`; `EXPORT_API_VERSION`, 1.3.0 as built.

## The export flow

| # | Step | What happens |
|---|---|---|
| 1 | **Start** | *File › Export…* (`export.file`). Enabled when `ledger.isOpen && export.hasFormats && !export.isRunning && !ledger.isBusy`. It doesn't require a writable ledger (E-5) |
| 2 | **Prepare** | The manager reads the chart (accounts, sub-ledgers, balances) and what it remembers. The preselected account is the register's account (`accounts.register.account`), else the navigator's selected account, else none |
| 3 | **Export dialog** | Format, accounts, dates, options. As they change, the dialog asks `export:check`: the manager gathers the data (cached by accounts and range) and calls the format's `check`. The dialog shows counts, problems and warnings. *Export…* is enabled when there are no problems |
| 4 | **Save dialog** | `shell.files.showSaveDialog`: the format's filter; the last export folder (or Documents); a suggested name such as `Maple Chequing 2026-01-01 to 2026-10-31.qif`, or the ledger's name for several accounts. Cancel returns to nothing, and nothing is written |
| 5 | **Gather** | Under the long operation "Exporting transactions": the data, read again now so it is current ([What is exported](#what-is-exported)) |
| 6 | **Write** | `check` once more (a problem now fails with its message), then `write`, with a 30-second time limit as import's `parse` has |
| 7 | **Save** | The bytes go to `<file>.partial`, then are renamed over the chosen name, with retries ([Writing the file safely](#writing-the-file-safely)) |
| 8 | **Tell** | `shell.prompts.message`: "Exported 412 transactions from 3 accounts (1 Jan 2026 to 31 Oct 2026) to Household.qif", plus the warnings, and what was left out (for example "7 voided transactions") |
| 9 | **Remember** | The format, its options and the folder ([What exports remember](#what-exports-remember)). Nothing is saved to the ledger |

## The Export dialog

`export.dialog.export`, size `md`, in the export plugin's renderer. Two tabs, so it fits the window without scrolling
(changed after the first run on Windows: [X1 results](#fixes-after-the-first-run-on-windows)), and the preview below
them, always in view:

```
┌ Export ──────────────────────────────────────────────────────────────────────────────┐
│  What to export │ File options                                                       │
│ ─────────────────┴────────────────────────────────────────────────────────────────── │
│ Format    [ CSV file (spreadsheets)                                             ▾ ]  │
│           For Excel, Numbers, Google Sheets and other spreadsheets: …                │
│ Accounts  [ 3 accounts: Chequing, Savings, Visa                                 ▾ ]  │
│ Dates     [ All dates ▾ ]   From [ 2026-01-01 ]   To [ 2026-11-12 ]                  │
│                                                                                      │
│ Will export 412 transactions from 3 accounts, Jan 1, 2026 to Nov 12, 2026.           │
│ ⚠ Several accounts in one CSV file suit a spreadsheet. …                             │
│ The file will hold these transactions as plain text. …         [Cancel] [Export…]    │
└──────────────────────────────────────────────────────────────────────────────────────┘

  File options tab: each choice a list, two to a row, its description under it
  [ Amounts: One column, money out negative ▾ ]   [ Date format: Year-month-day ▾ ]
  [ Decimal separator: Point (1234.56) ▾ ]          [ Characters: UTF-8 ▾ ]
  [x] Include voided transactions …                 [x] Protect against spreadsheet formulas …
```

- **Tabs**: *What to export* (the format, the accounts, the dates) and *File options* (the format's options;
  disabled for a format without any). Both panels share one cell of a grid, the hidden one keeping its room, so the
  dialog's height doesn't change with the tab. The preview is below them.
- **Format**: the valid contributions by `order`, then label. The last one used is chosen.
- **Accounts**: for a format whose `accounts` is `'one'`, a single account picker, listing the accounts it can't hold
  disabled, with the reason. Otherwise one field whose list opens over the dialog: *All accounts* first (ticking or
  clearing them all), then a checkbox for each account, with its sub-ledger, type and currency. The field says what is
  chosen in one line: the account's name, *All accounts (5)*, or *3 accounts: Chequing, Savings, Visa*. It starts on
  the account the user is looking at, else all of them. Closed accounts are listed and can be chosen. (A tree where
  ticking a sub-ledger ticks what it holds is left for later.)
- **Dates**: *All dates*, *This year*, *Last year*, *This month*, *Last month*, *Custom*. *All dates* starts at the
  earliest `periodStart` of the chosen accounts, and From and To show the dates it works out to. Typing a date makes
  the range *Custom*. The three fields are one row's own children, so they line up.
- **Options**: the format's `options`, each a list (a choice), a checkbox or a text field, two to a row. Then, for each chosen account, the account fields the format writes
  (`accountFields`). For OFX these are *Account number* and *Bank number*; QFX and QBO add *Intuit bank id*. Each is
  filled in from the account and can be changed for this export. A required one that is empty is a problem; a
  recommended one (the Intuit id) is a warning. **What is typed here isn't saved to the account**, because an export
  never changes the ledger (E-5). A line under the fields says "To keep these, add them to the account", with an
  *Edit Account…* link when the ledger is writable (Q10).
- **Preview**: counts and the format's `check` results. Problems are shown in the error colour and block *Export…*.
- **Keyboard**: Enter is *Export…* when enabled; Escape cancels. Fonts and colours come from the theme and font
  roles, as the architecture tests require.

## What is exported

For each chosen account, in navigator order:

| Item | Rule |
|---|---|
| **Range** | Transactions dated `from` to `to`, both included, in register order. If `from` is before the account's `periodStart` (it has been archived), it is moved to `periodStart`, `startsAtArchive` is set, and the preview says "Maple Chequing starts 1 Jan 2025: earlier transactions are in an archive file" |
| **Opening balance** | The account's opening balance, plus every non-voided transaction dated before `from`, from the register's running balances. It is what the register shows at the end of the day before `from` |
| **Closing balance** | The opening balance plus every non-voided transaction in the range |
| **Voided** | Left out, unless the format offers to include them and the user asked (CSV only). A voided transaction never changes a balance |
| **Uncleared** | Included, with its status. OFX offers *Only transactions the bank has cleared* |
| **Transfers** | Each side is a transaction of its own account, with `transfer` naming the other. A multi-account export that holds both accounts has both sides |
| **Payees, categories** | Resolved to names and paths. A category's `kind` goes to the category list |
| **Bank ids** | `externalId` when it doesn't start with `fp:` |
| **Currencies** | Each account in its own currency. A file with several currencies is allowed where the format can say so (CSV adds a *Currency* column), and warned about in QIF, which can't |
| **Closed accounts** | Exported like any other |

**Reading.** Each account's `register()` is read once. Payees and categories are read once. All of it happens under
the long operation. A transfer edited in another window between reading its two accounts could show the two sides
differently in the file. The dialog is modal and the read takes well under a second for typical ledgers, so this is
accepted ([Risks](#risks)).

## Writing the file safely

1. Write the bytes to `<chosen path>.partial` (a leftover from a crash, with that exact name, is replaced).
2. Rename it to the chosen path, retrying for up to 10 s while Windows reports the target as held (`EBUSY`, `EPERM`,
   `EACCES`): antivirus scanning, a sync client, or Excel with the old file open. This follows the backup's
   `renameWithRetry` policy. Unlike the backup, the export may replace an existing file, because the user confirmed
   that in the Save dialog. If the target is still held, the message says "Close the file in any program that has it
   open, then export again".
3. On any failure, remove the `.partial` file and report. The file the user chose is either the complete new file or
   untouched, never half-written.

## What exports remember

In application state (`context.state`, kept as `export.*` in `app.state`), never in the ledger (E-15):

| Key | Value |
|---|---|
| `lastFolder` | The folder of the last export |
| `lastFormat` | The last format id |
| `options:<formatId>` | That format's option values |
| `range` | The last range choice (*This year*, or the custom dates) |

An account's OFX ids aren't remembered here. They are the account's own fields, `bankId` and `intuitBankId` (Q2,
[Account fields for OFX](#account-fields-for-ofx)), so they travel with the ledger and are in its archive files too.
Remembered values are prefilled, never used without being shown.

## Account fields for OFX

Decided in review (Q2): the ids an OFX family file needs are fields of the account, not export settings.

| Field | Account dialog label | Help text | Rule |
|---|---|---|---|
| `accountNumber` (exists) | *Account number* | — | Written as `ACCTID` with spaces and dashes taken out; a masked number can't be used |
| `bankId` (new) | *Bank number* | "The number your bank uses for itself in downloaded statements (OFX files): usually its routing or transit number. Needed to export OFX, QFX or QBO." | Optional; letters and digits, at most 9 characters (OFX `BANKID`; the limit to confirm in X0) |
| `intuitBankId` (new) | *Intuit bank id* | "For Quicken and QuickBooks files: the number after <INTU.BID> in a .qfx or .qbo file downloaded from this bank." | Optional; at most 32 characters, no control characters (the real limit to confirm in X0) |

- **Where**: `Account`, `AccountInput` and `AccountPatch` in `@tessera/accounts-api` (a minor version), validated in
  `rules.ts` like the other text fields. The Account dialog gets a small *Downloads and exports* section, closed by
  default, holding the two new fields. Existing ledgers need no migration, because the fields are optional. Archiving
  and restoring keep them as they keep every account field.
- **In the Account dialog**, a *Downloads and exports* section under the account number, closed unless the account
  has either value: *Bank number* (letters and digits, 9 at most) and *Intuit bank id* (32 at most), each with its
  help. The service checks the same rules (`BANK_ID_MAX_LENGTH`, `INTUIT_BANK_ID_MAX_LENGTH`, accounts-api 1.12).
- **Filled by OFX imports.** `format-ofx` reads `BANKID`, and keeps `INTU.BID` as data (still never for the key, the
  label or the institution, as before). `StatementAccount` gains `bankId` and `intuitBankId`
  (import-api 1.8), so a new account created from a statement starts with both. An Intuit id from a statement whose
  bank ids look made up (a converter's file) isn't used, because converters borrow other banks' ids.
- **An existing account's empty fields are filled too, and a value is never overwritten** (Q9). When the file's value
  differs from the account's, the account keeps its own, and the statement's summary warns: "The file gives Maple
  Chequing's bank number as 003; the account has 004, and keeps it." A field filled in is said in the summary too
  ("Maple Chequing's bank number was filled in from the file").
- **The account number is filled the same way** (added after the first run on Windows: an account number typed in
  the Export dialog for a QFX, then imported back, was left empty). Any file type that names its account (OFX, QFX,
  QBO, a CSV with an account column) fills an existing account's empty number with what a new account would take:
  the whole number, or only the last four of a masked one. Because accounts are found by their number, **only when the
  statement's match is remembered** (the Account dialog's *Remember this account* ticked, or a saved match): a one-off
  import into an account doesn't make the next file go there without asking. A differing number is a warning, shown
  masked (•••• 0117) unless that hides the difference; a masked number and an account's last four that end the same
  are the same number.
- **Used by exports**: `ExportAccount.bankId` and `intuitBankId`. A format says which account fields it writes, for
  which account types (`accountFields`: OFX's bank number is for bank accounts, not cards). The Export dialog shows
  them for the account exported, from the account, and lets them be changed for one export (`ExportRequest.accountValues`).
  **What is typed there is never saved to the account** (Q10): an export has no side effects, and a line under the
  fields says to make a lasting change in *Accounts › Edit Account…*.

## Errors and outcomes

| Situation | What the user sees |
|---|---|
| No ledger open, or another long operation running | The command is disabled; `BUSY` if called anyway |
| A format's plugin didn't start | The format isn't listed; a warning in the log |
| `check` finds a problem | Shown in the dialog; *Export…* disabled |
| Nothing in the range | A problem: "There are no transactions to export in “Maple Chequing” for these dates." An account with nothing, exported with others that have something, is left out of the file and named instead |
| `write` throws or times out | "Tessera couldn't write the file: …"; nothing is written |
| The disk is full, the folder is read-only, the file is held | The message says which, and the chosen file is untouched |
| The ledger closes during an export | Not possible: the long operation keeps Close Ledger disabled |

`ExportErrorCode`: `NO_LEDGER`, `BUSY`, `NO_FORMAT`, `INVALID` (a problem from `check`), `WRITE_FAILED`, `CANCELLED`.

## Privacy and security

- **An exported file is the user's data, in the clear.** The dialog says so in one line under *Export…*: "The file
  will hold these transactions as plain text. Keep it somewhere safe." No export is kept, logged or sent anywhere,
  and the log records counts only, never payees, amounts or paths.
- **Account numbers** are written only where the format needs them: OFX's `ACCTID`. CSV and QIF name accounts, not
  numbers.
- **Spreadsheet formulas** (E-13): a CSV text cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return is
  written with a leading `'`. Amount and date cells are never changed. This is an option (*Protect against
  spreadsheet formulas*, on by default).
- **Markup in OFX**: `&`, `<` and `>` are escaped in every value, so a payee can't break the file's structure. Line
  breaks are removed from QIF and OFX values, which are line-based in QIF and values-until-the-next-tag in OFX 1.x.

---

# Part 2: Definition of each file type

What is written, field by field. Each example below is the output for the same account, *Maple Chequing*, in October
2026.

## The five file types at a glance

| | CSV | QIF | OFX | QFX | QBO |
|---|---|---|---|---|---|
| **Plugin** | `format-csv` | `format-qif` | `format-ofx` | `format-ofx` | `format-ofx` |
| **Export contribution** | `format-csv.csv` | `format-qif.qif` | `format-ofx.ofx` | `format-ofx.qfx` | `format-ofx.qbo` |
| **For** | Spreadsheets | Money, Quicken, GnuCash, Tessera | Money, GnuCash, most finance apps | Quicken | QuickBooks |
| **Accounts per file** | many | many | one | one | one |
| **Account types** | all | all | chequing, savings, line of credit, credit card | same | same |
| **Categories / transfers** | yes / yes (as labels) | yes / yes | no / as a type | same | same |
| **Balances** | Running balance column | Opening balance record | Closing balance (`LEDGERBAL`) | same | same |
| **Line ids** | — | — | `FITID` | same | same |
| **Encoding default** | UTF-8 with BOM | Windows-1252 | Windows-1252 (`CHARSET:1252`) | same | same |
| **Account fields written** | — | — | Account number, bank number (required) | + Intuit bank id (recommended) | + Intuit bank id (recommended) |

## CSV

### Options

| Option | Choices (default first) |
|---|---|
| Amounts | **One column, money out negative** · Money out and Money in columns |
| Dates | **2026-10-05** · 10/05/2026 · 05/10/2026 |
| Decimal separator | **Point (1234.56)** · Comma (1234,56); a comma makes the separator between cells a semicolon. Its description: "For spreadsheets set to use a comma for decimals. Others may need the separator chosen when opening the file" (X0-7) |
| Characters | **UTF-8 (Excel, Numbers, Google Sheets)** · Windows (older programs, which may show accents wrongly elsewhere, X0-7) |
| Include voided transactions | **No** · Yes (status `V`, not counted in the balance) |
| Protect against spreadsheet formulas | **Yes** · No. Its description: "Text that starts with =, +, - or @ is written with a ' in front, so a spreadsheet can't run it. Some spreadsheets show the '." (X0-6) |

### Columns

In this order. *Account* and *Currency* appear only when needed.

| Header | Value | When |
|---|---|---|
| `Account` | The account's name | Several accounts |
| `Date` | The transaction's date | Always |
| `Cheque number` | `number` (cheque numbers and codes such as ATM) | Always |
| `Payee` | The payee's name | Always |
| `Category` | `Food : Groceries`, or `Transfer to: Savings` / `Transfer from: Savings`, as the register writes them | Always |
| `Memo` | The memo | Always |
| `Amount` — or `Money out`, `Money in` | Signed, or the magnitude in one of the two | Always |
| `Currency` | ISO code | Several accounts in more than one currency |
| `Status` | The register's letters: empty (uncleared), `E`, `C`, `R`, or `V` (voided, when included). **Never "Pending"** (E-12) | Always |
| `Balance` | The account's running balance after the row | Always |

- **Rows**: by account, in navigator order, then in register order. No opening-balance row, no totals row.
- **Cells**: RFC 4180. A cell holding the separator, a quote or a line break is quoted, with quotes doubled. Line
  ends are CRLF, with one after the last row.
- **Amounts**: `minorToDecimal`, then the chosen separator, with no grouping and no currency sign.

```
Date,Cheque number,Payee,Category,Memo,Amount,Status,Balance
2026-10-01,,Landlord,Housing : Rent,,-1200.00,R,3800.00
2026-10-03,101,Hydro One,Bills : Electricity,"Sept, 2026",-84.12,C,3715.88
2026-10-05,,Employer Inc,Income : Salary,,2500.00,E,6215.88
2026-10-07,,Savings,Transfer to: Savings,,-500.00,,5715.88
```

## QIF

### Options

**Standard QIF**, as Quicken defined it and every QIF reader takes: not Microsoft Money's looser dialect, which leaves
out `!Account` and writes dates however Windows is set (decided 2026-11-12, with phase X2). Money's own dialog says
what its standard ("strict") QIF keeps: *"Only the first 15 characters of category names and other names will be
exported, and only classification 1 will be exported."* Tessera keeps to the same (Q11): names of 15 characters, and,
as it has no classifications, none.

| Option | Choices (default first) |
|---|---|
| Date format | **Month/day/year** (`10/05/2026`) · Day/month/year (`05/10/2026`). Four-digit years always |
| Characters | **Windows (Quicken, Money)** · UTF-8 (GnuCash, Tessera) |
| Start each account with its opening balance | **Yes** · No. Its description says to leave it out when adding to an account the other program already has |
| Include the category list | **Yes** · No, for one account or several |

### Structure

One account (an excerpt: the Landlord and Employer lines are left out here):
```
!Account
NMaple Chequing
TBank
^
!Type:Bank
D10/01/2026
T5000.00
CX
POpening Balance
L[Maple Chequing]
^
D10/03/2026
T-84.12
C*
N101
PHydro One
MSept, 2026
LBills:Electricity
^
D10/07/2026
T-500.00
PSavings
L[Savings]
^
```

Several accounts add, before the first `!Account` above: the category list (when chosen), and Quicken's account
list between `!Option:AutoSwitch` and `!Clear:AutoSwitch`. Then each account follows as above.
```
!Type:Cat
NBills:Electricity
E
^
NIncome:Salary
I
^
!Option:AutoSwitch
!Account
NMaple Chequing
TBank
^
!Account
NNorthwind Visa
TCCard
^
!Clear:AutoSwitch
```

### Account types

| Tessera | `!Account T` / `!Type:` | Read back by Tessera as |
|---|---|---|
| chequing, savings | `Bank` | chequing (savings when the name says so) |
| cash | `Cash` | cash |
| creditCard | `CCard` | creditCard |
| lineOfCredit, loan, mortgage, otherLiability | `Oth L` | otherLiability |
| investment, retirement, otherAsset | `Oth A` | otherAsset |

Investment and retirement accounts hold cash transactions only in Tessera, so they are written as `Oth A`, never
`Invst`. `Invst` would need investment actions, and Tessera's own import leaves `Invst` out. A type read back only
matters when a *new* account is created from the file.

### Fields

| Code | Written from | Rule |
|---|---|---|
| `D` | `date` | The chosen order, four-digit year |
| `T` | `amount` | `minorToDecimal`, `.` as the separator, no grouping; signed from the account's side (a card's charges negative) |
| `C` | `status` | `C*` for electronic and cleared, `CX` for reconciled, nothing for uncleared |
| `N` | `number` | As it is (`101`, `ATM`, `EFT`) |
| `P` | `payee` | At most **32 characters** (`QIF_LIMITS.payee`), as standard QIF has it: a longer one is cut, then trimmed, and the preview counts them |
| `M` | `memo` | The memo. When the payee was cut, the whole payee comes first (`<payee> · <memo>`), so nothing is lost |
| `L` | `category` or `transfer` | `Food:Groceries` (levels joined by `:`), or `[Savings]` for a transfer. Each level's name, and an account's, at most **15 characters** (`QIF_LIMITS.name`), cut and trimmed: *Credit Card Payments-Transfers* is *Credit Card Pay*, *Housing:Mortgage interest* is *Housing:Mortgage intere* |

- **Opening balance record**: first in the account's section. `D` is the opening date (the account's opening date
  when the range starts there, else `from`), `T` is the balance at the start of that day, `CX`, `POpening Balance`
  and `L[<account name>]`. This is how Quicken and Money begin an account, and exactly what Tessera's QIF import reads
  as the opening balance. It is **on by default** (the plan had it depend on the range, which an option's default
  can't): its description says to leave it out when adding to an account the other program already has, where a
  second opening balance would be wrong.
- **An account with no transactions in the range isn't written.** It would be its opening balance alone, which
  Tessera's QIF import leaves out (*has no transactions, so nothing of it was imported*): writing it would only move
  the question to the import. The preview and the message name the accounts left out, and count only the others.
  Nothing to write at all is a problem.
- **Names of 15 characters**: an account's name, in its `!Account` record, its opening balance (`L[…]`) and every
  transfer to it, and each level of a category's path, in the list and on the lines. One warning gives a few of them,
  as they will read. **Two accounts whose names would be one** once cut (ignoring case, as Tessera, Quicken and Money
  compare them) are a **problem**: a program reading the file would take them for one account, and put one's lines in
  the other. The transfers in the file count too, as they name accounts: *Maple Trust chequing* with a transfer to
  *Maple Trust Chequing - french* can't be exported until one is renamed. Two categories that would be one are a
  warning.
- **Dates told**: when every day in the file is 12 or less, no reader can tell month first from day first, so the
  preview and the message say which order was written. Otherwise nothing is said.
- **Names that clash with QIF's syntax**: QIF uses `:` between category levels, `/` before a class, and `[ ]` around
  a transfer's account. These characters in a category or account name are written as `-`, with one warning listing
  the names.
- **Line breaks** in any value become spaces. Empty fields are left out.
- **Voided transactions** are left out (E-11), and counted in the message.
- **Several currencies** can't be said in QIF: a warning names the accounts and their currencies.
- **Encoding**: Windows-1252 by default, with `encodeText`'s replacements counted in a warning. Line ends are CRLF.

## OFX

### Options

| Option | Choices (default first) |
|---|---|
| Only transactions the bank has cleared | **No** · Yes (electronic, cleared and reconciled only) |
| Put the category in the memo | **No** · Yes (`Food : Groceries · <memo>`) |

Per account (`accountFields`), from the account's own fields ([Account fields for OFX](#account-fields-for-ofx)), and
changeable for one export in the dialog:

| Field | Rule |
|---|---|
| *Bank number* → `BANKID` | Required for bank accounts; up to 9 characters. Not used for credit cards |
| *Account number* → `ACCTID` | Required; up to 22 characters, with spaces and dashes taken out. A masked number (`•••• 5678`) can't be used |

### Structure

OFX 1.0.2 in SGML, the dialect every OFX reader accepts, with the header every bank sends:
```
OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS>
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<DTSERVER>20261112120000<LANGUAGE>ENG
<FI><ORG>Maple Trust</FI>
</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS>
<TRNUID>0<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS>
<CURDEF>CAD
<BANKACCTFROM><BANKID>004<ACCTID>12345678<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20261001<DTEND>20261031
<STMTTRN><TRNTYPE>CHECK<DTPOSTED>20261003<TRNAMT>-84.12<FITID>TESSERA.01JBX8Z6Q3<CHECKNUM>101<NAME>Hydro One<MEMO>Sept, 2026</STMTTRN>
…
</BANKTRANLIST>
<LEDGERBAL><BALAMT>5715.88<DTASOF>20261031</LEDGERBAL>
</STMTRS>
</STMTTRNRS></BANKMSGSRSV1>
</OFX>
```

A credit card uses `CREDITCARDMSGSRSV1 › CCSTMTTRNRS › CCSTMTRS` and `CCACCTFROM` (with `ACCTID` only).

### Mapping

| OFX | From | Rule |
|---|---|---|
| `FI › ORG` | `institution` | Left out when the account has none |
| `CURDEF` | `currency` | |
| `ACCTTYPE` | `type` | chequing `CHECKING`, savings `SAVINGS`, line of credit `CREDITLINE`; a credit card is a card statement |
| `DTSTART`, `DTEND` | `range` | `YYYYMMDD` |
| `LEDGERBAL` | `closing` | `BALAMT` the closing balance, `DTASOF` = `to` |
| `DTPOSTED` | `date` | `YYYYMMDD` |
| `TRNAMT` | `amount` | `.` as the separator, signed from the account holder's side, as OFX is |
| `FITID` | `bankId` or `id` | E-10: `bankId` when present, else `TESSERA.<id>` |
| `TRNTYPE` | several | `XFER` for a transfer; `CHECK` for a numeric `number` on money out; `ATM` and `DEP` for those codes; otherwise `DEBIT` (money out) or `CREDIT` (money in) |
| `CHECKNUM` | `number` | Numeric numbers only, up to 12 characters |
| `NAME` | `payee` | Up to **32 characters** (OFX 1.0.2). A longer payee is cut, **then trimmed** (a cut that ends in a space would otherwise read back differently, found in X0), the whole of it goes at the start of `MEMO`, and the preview counts them |
| `MEMO` | `memo` | Up to 255 characters, cut with a warning |

- Voided transactions are never written (a bank statement has none).
- Values are escaped (`&amp;`, `&lt;`, `&gt;`), and line breaks become spaces.
- The text is Windows-1252, with replacements counted in a warning. Line ends are CRLF.
- **Problems**: an account type OFX can't write; a missing or too long `BANKID` or `ACCTID`; a currency with more
  than 2 decimals (kept as a problem until X0 shows how targets read them).

## QFX and QBO

The same writer and the same file, with three differences:

| | QFX | QBO |
|---|---|---|
| Extension | `.qfx` | `.qbo` |
| Added to `SONRS` | `<INTU.BID>` | `<INTU.BID>` |
| Account field, in addition | *Intuit bank id*: recommended | same |

**The Intuit bank id** (E-8) identifies the user's bank to Quicken and QuickBooks. It is the account's *Intuit bank
id* field. An OFX import fills it in for a new account ([Account fields for OFX](#account-fields-for-ofx)), and the
field's help says where to find it: after `<INTU.BID>` in a `.qfx` or `.qbo` file downloaded from the same bank.
Tessera doesn't check the id against any list and doesn't suggest one.

**Without one** (Q3: write and warn), the tag is left out. The preview and the message say: "Maple Chequing has no
Intuit bank id, so Quicken may refuse this file. Add the id to the account, or export OFX instead." X0 records what
each program actually does with such a file, and the warning's wording follows it.

Whether Quicken and QuickBooks need anything more (`<INTU.USERID>`, an `FID`, a limit on date ranges) is checked in
X0, and added to this table if so.

## What survives a round trip

Tessera → file → Tessera's import, into a new account (the columns are the import readers' behaviour today):

| Field | CSV | QIF | OFX / QFX / QBO |
|---|---|---|---|
| Date, amount | ✓ | ✓ | ✓ |
| Payee | ✓ | Over 32 characters: **cut**, the whole in the memo. It comes back another name (checked: [X2 results](#phase-x2-results)) | Over 32 characters: cut, the whole in the memo |
| Memo | ✓ | ✓ | ✓ |
| Cheque number | ✓ | A number ✓; a code (`EFT`, `ATM`, `DEP`) comes back as the kind of line it says, not a number | ✓ (numeric only) |
| Category | As a hint, when the ledger has it and the user agrees | Same, for names of 15 characters or less at each level. A longer one is cut, names no category the ledger has, and its line comes back **without a category** (checked) | — |
| Transfer | Not a transfer; the label is an unknown category | A line of kind *transfer*, not a transfer pair | A line of kind *transfer* |
| Status | Imported lines are *E* | same | same |
| Voided | Left out (if included, it would import as real) | Left out | Left out |
| Opening balance | — | ✓ (new account prefilled) | Closing balance ✓ |
| Account | Weak key (the layout); a several-account file reads back as one statement ([see below](#round-trip-through-tesseras-readers-checked-2026-11-12)) | Weak key by name, **cut to 15 characters**: a new account gets the cut name. Each account of the file is asked about in turn | Strong key by bank id and number |
| Line identity | Fingerprint | Fingerprint | FITID (stable across exports) |

**Into the same account it came from**, every line is already there. OFX lines keep their bank ids where they had
them and are recognised as imported. Other lines are recognised by *Already imported?* or by matching, as any
overlap is, and are never added twice without the user's say.

### Round trip through Tessera's readers (checked 2026-11-12)

A hand-written sample of each proposed output was read with the import plugins' own code (`readCsv`, `guessLayout`
and `readLines`; `parseQif`, `collect` and `readStatement`; `parseOfx` and `statementsOf`):

| Sample | Result |
|---|---|
| CSV as [above](#columns), plus a payee written `'=HYPERLINK(x)` | Layout **recognised with nothing uncertain**: every column's role right, ISO dates, the balance column used. The formula guard's `'` taken off again. Nothing left out |
| QIF, two accounts, `!Type:Cat`, AutoSwitch list, opening-balance records, `C*`/`CX`, `N101`, `L[Savings]` | Both accounts read with the right types and **opening balances**. Categories, cheque and transfer kinds right. The category list skipped quietly. No warnings |
| OFX 1.0.2 with `TESSERA.` FITIDs, `&amp;`, `INTU.BID`, `LEDGERBAL` | Read with a **strong key**, the period and the balance. The ids aren't taken for made-up ones. `&amp;` decoded. `INTU.BID` ignored |

Two limits found along the way, and designed for above:
- **A CSV of several accounts reads back as one statement.** Tessera's CSV import takes an *Account* column only
  when it holds account *numbers*, and this column holds names. QIF is the format for moving several accounts, so
  the several-account CSV is for spreadsheets, and the dialog says so when a CSV has several accounts chosen.
  **In more than one currency, Tessera's CSV import refuses it** ("rows in more than one currency… export each
  currency separately"), found in X0. That is the right answer for a spreadsheet file.
- **A QIF whose days are all 12 or less** is ambiguous to any reader. Tessera's import then asks (QIF Options). The
  message after an export says which order the dates were written in.

## Other applications

**Expected**, and being checked in X0. So far only LibreOffice Calc has been tried ([Phase X0 results](#phase-x0-results)):
the assumptions are listed there as A1 to A16, with what each is waiting for.

| Application | Expected to read | Notes to check |
|---|---|---|
| Microsoft Money Plus (Sunset) | OFX, QIF | OFX 1.0.2 with `CHARSET:1252` is what banks sent Money. QIF: the date order follows Windows' regional settings |
| Quicken (Windows) | QFX, QIF | Recent versions are reported to restrict QIF import into bank and card accounts, and to accept QFX only from known institutions |
| QuickBooks (Desktop, Online) | QBO, CSV | Expected to check `INTU.BID` against its list of institutions |
| GnuCash | OFX, QIF, CSV | Its QIF import asks for the date format |
| Excel, LibreOffice Calc, Google Sheets, Numbers | CSV | UTF-8 with a BOM in Excel; ISO dates recognised as dates; the `'` formula guard shown or hidden |
| Another Tessera ledger | all | Covered by automated round-trip tests |

---

# Part 3: Implementation plan

## Ground rules

- Follow the import plugins' conventions: names in `protocol.ts` constants, pure code separate from I/O, every
  disposable on `context.subscriptions`, and user-facing text in the house style.
- Writers are pure and get their data from tests directly. The export manager is tested with a fake
  `accounts.service` (the import tests' harness pattern), and end to end with the built plugins in
  `pipeline.test.ts`.
- **Every writer's tests include a round trip through the matching import reader.**
- No personal data in fixtures: exports are made from synthetic ledgers (`scripts/sample-archive/household.ts`), and
  the fixtures' privacy test covers `tests/fixtures/export/` too.

## Dependency graph and order

```
X0 compatibility spike ──► X1 rename to file-type plugins, contract, export manager, CSV ──┬──► X2 QIF ─────────────────────────┐
                                                                                            └──► X3 OFX, QFX, QBO, account fields ┴──► X4 Export Account…
```

X0 comes first because its findings set defaults (E-14), the QFX/QBO requirements and the OFX field limits, and it is
cheap. X1 starts with the rename (Q1), so each writer lands in its file-type plugin from the start. CSV goes in X1
because it is the simplest writer and exercises everything in the manager. X2 and X3 are independent.

## Phase X0: compatibility spike (S)

**Goal:** confirm the assumptions in [Other applications](#other-applications), [E-8](#decisions) and
[E-14](#decisions) before the defaults are fixed.

1. Write each format exactly as Part 2 defines it, from data with every awkward case, with a throwaway script
   (`npm run spike:export`, `scripts/export-spike/`; not shipped, and removed at the end of X3). **Done.**
2. Read every file back through Tessera's own import code. **Done: all 21 read back.**
3. Open the CSVs in a spreadsheet. **Done in LibreOffice Calc**; Excel, Numbers and Google Sheets remain.
4. Import each file into Money, Quicken, QuickBooks and GnuCash on Windows, following the
   [checklist](#what-remains-the-checklist-for-windows). **To do**: it needs those programs.
5. Check the OFX field limits against the OFX 1.0.2 specification. **To do**: the limits here are from memory, and
   the specification couldn't be reached from where the spike ran.
6. Confirm or change each default (E-14) and the assumptions below, and amend Part 2.

**Done when:** the results are recorded, every assumption below is confirmed or changed, and Part 2 has been
amended where the findings differ. Nothing is merged to `plugins/`.

### Phase X0 results

Recorded 2026-11-12. Steps 1 and 2 are done, and step 3 in LibreOffice; the rest is left for later.

**What was run.** `npm run spike:export [folder] [--intu-bid <id>]` writes 21 files into `samples/export-spike/`
(not kept in git). It reads each back with the import plugins' own code, as the import manager would (`decode`,
then the CSV guesser and line reader, the QIF record and statement readers, the OFX tokenizer and statement reader),
and compares every line with the data it came from. The data (`scripts/export-spike/data.ts`) is a made-up household
in October 2026, with four accounts: chequing, savings, a Visa card, and a US-dollar chequing account. It includes a
transfer (both sides), a cheque, ATM and EFT codes, a voided transaction, every status, `Café Dépanneur Chez Émile`,
`Łódź Market`, `東京 Ramen`, a payee `=SUM(A1:A9)`, a 50-character payee, a memo with a comma and quotes, a memo
with a line break, and a category `Home/Office`.

| Files | What they vary |
|---|---|
| `csv/01` to `07` | The defaults; Money out and Money in; comma decimals (semicolons); Windows-1252; month first; day first; four accounts in two currencies |
| `qif/01` to `07` | The defaults; day first; UTF-8; a credit card; the whole ledger; only days 1 to 12; no opening balance |
| `ofx/01` to `03`, `qfx/01` and `02`, `qbo/01` and `02` | Chequing, savings, card; QFX and QBO without an Intuit id (or with the one given) |

**Findings.**

| # | Finding | Consequence |
|---|---|---|
| X0-1 | **All 21 files read back through Tessera's import**, every line's date, amount, payee, number, memo, category and kind as expected. The CSVs open as **recognised** with nothing guessed, the QIF accounts with the right types and opening balances, and the OFX files with strong keys and trusted ids | The definitions in Part 2 work for Tessera. The writers' round-trip tests (X1 to X3) will hold them to it |
| X0-2 | **Bug found: a payee cut to 32 characters can end in a space** (`INTERNATIONAL BUSINESS MACHINES `), which the reader trims, so the name read back differs | The OFX rule is now *cut, then trim* ([Mapping](#mapping)) |
| X0-3 | **`Ł` has no Unicode decomposition**, so reducing to a base letter alone gives `?ódz`. A small table of such letters gives `Lódz`. `東京` becomes `??` in Windows-1252, as expected, with a warning | `encodeText` has the table ([helpers](#the-contract-tesseraexport-api)) |
| X0-4 | **A CSV with two currencies is refused by Tessera's CSV import** ("rows in more than one currency…"). A several-account CSV in one currency reads back as one statement | Recorded in [What survives a round trip](#what-survives-a-round-trip). The several-account CSV is for spreadsheets |
| X0-5 | **A short card statement is often ambiguous**: every day in the Visa file is 12 or less, so Tessera's import asks for the date order (QIF Options). Other readers will too | As designed: the message after an export says which order was written |
| X0-6 | **LibreOffice Calc 24.2** (default import, POSIX locale): UTF-8 with BOM read correctly, accents included. **ISO dates became dates**; amounts and balances became numbers. The formula guard stopped `=SUM(A1:A9)` from running, but **the `'` shows in the cell** | UTF-8 with BOM and ISO dates confirmed as the CSV defaults. The guard stays on (E-13), and its option's description says the `'` may show |
| X0-7 | In the same setup, the **Windows-1252 CSV** read `ó` as `�`. The **semicolon CSV** was split on commas, so the amounts broke. The month-first and day-first dates stayed text, but the POSIX locale was the only one available, so that says nothing about a user's locale | Confirms the UTF-8 default. The Windows-1252 and comma-decimal options are for programs that expect them, and their descriptions say so. Month-first and day-first dates in spreadsheets are to be checked on Windows |
| X0-8 | **Cheque numbers became numbers** in Calc (`101`); one written `00101` would lose its zeros | Minor; accepted. A spreadsheet user can format the column |

**Assumptions and defaults: where they stand.**

| # | Assumption or default | Status |
|---|---|---|
| A1 | Tessera reads every export back (round trip) | **Confirmed** (X0-1) |
| A2 | CSV: UTF-8 with a BOM is read correctly by spreadsheets | **Confirmed in LibreOffice**; Excel to check |
| A3 | CSV: ISO dates are recognised as dates | **Confirmed in LibreOffice**; Excel to check |
| A4 | CSV: the formula guard stops formulas | **Confirmed in LibreOffice** (the `'` shows); Excel to check |
| A5 | CSV: comma decimals with semicolons suit comma-decimal spreadsheets | **Not confirmed**: misread by LibreOffice's default import (X0-7); Excel in a French or German locale to check |
| A6 | QIF: month first with four-digit years (Q4) is read by Money and Quicken | Open: Windows |
| A7 | QIF: Windows-1252 and CRLF suit Money and Quicken | Open: Windows |
| A8 | QIF: Money's and Quicken's handling of both sides of a transfer in a whole-ledger file (Q7: both are written) | Open: Windows |
| A9 | QIF: recent Quicken limits QIF import into bank and card accounts | Open: Windows |
| A10 | OFX 1.0.2 SGML with `CHARSET:1252` is read by Money Plus and GnuCash | Open: Windows / GnuCash |
| A11 | OFX 1.0.2 limits: `NAME` 32, `MEMO` 255, `CHECKNUM` 12, `BANKID` 9, `ACCTID` 22 | Open: the specification |
| A12 | QFX: Quicken wants a known `INTU.BID`; what it does without one (Q3) | Open: Windows |
| A13 | QBO: QuickBooks wants a known `INTU.BID`; what it does without one (Q3) | Open: Windows |
| A14 | QFX/QBO need nothing more (`INTU.USERID`, an `FID`, a date-range limit) | Open: Windows |
| A15 | Stable FITIDs stop a target doubling an overlapping export | Open: Windows (import `ofx/01` twice into Money) |
| A16 | GnuCash reads the CSV, QIF and OFX | Open: GnuCash |

### What remains: the checklist for Windows

**Left for later** (decided 2026-11-12): it waits until the programs are at hand ([Later](#later)).

Make the files with *File › Export…* in Tessera (the spike that made them before X1 was removed at the end of X3):
from a ledger with the samples imported (`samples/statements/`), so the accounts have their numbers, bank numbers
and, for the QFX and QBO samples, Intuit ids. Use a new, empty file in each program, and record in the table above what
happened, with any message word for word.

| Program | Export | Check |
|---|---|---|
| Excel | CSV of one account with the defaults; again in *Windows* characters; with a comma for decimals; month first; day first | Accents right (UTF-8 vs Windows); dates are dates and sort; amounts are numbers; a payee starting with `=` doesn't run, and whether the `'` shows; comma decimals in a comma-decimal Windows locale (A2 to A5) |
| Microsoft Money Plus | OFX of a chequing account and of a card; QIF of one account, of a card, of the whole ledger, and of dates whose days are all 12 or less | OFX: accepted, the account matched or created, payees, the 32-character cut, the balance; the same OFX a second time: nothing doubled (A10, A15). QIF: dates, accents, categories created, names of 15 characters, the opening balance, a transfer once or twice (A6 to A8) |
| Quicken | QFX with and without the account's Intuit id; QIF of one account and of the whole ledger | The messages (A12, A14); QIF into a bank account and as a whole file (A6 to A9) |
| QuickBooks (Online or Desktop) | QBO with and without the account's Intuit id | The messages (A13, A14) |
| GnuCash | CSV, QIF of the whole ledger, OFX | Each imports; the QIF date format asked; the transfer (A16) |
| OFX 1.0.2 specification | — | The element lengths in A11 |

## Phase X1: rename, contract, export manager and CSV (L)

### Files

| File | What |
|---|---|
| `plugins/import-ofx`, `import-csv`, `import-qif` → **`plugins/format-ofx`, `format-csv`, `format-qif`** (**done**) | The rename (Q1): folders, manifest ids and names (*OFX files*, *CSV files*, *QIF files*), contribution ids (`format-csv.csv`), services (`format-csv.import`), dialog ids (`format-csv.dialog.layout`), and their tests, fixtures, samples README, `scripts/anonymise/` imports, README and docs (about 45 files). Development ledgers keep their saved account matches, but lose remembered CSV layouts and QIF options, which are kept under the old format ids (agreed: no migration) |
| `packages/export-api/` (`index.ts`, `contract.ts`, `protocol.ts`, `helpers.ts`, `errors.ts`, `package.json`, `tsconfig.json`) | The contract and helpers |
| `plugins/export/manifest.json` | Requires `accounts.service`, `ledger.session`, `shell.files`, `shell.prompts`, `app.state`. Renderer exposes `./ExportDialog` |
| `plugins/export/src/privileged/index.ts`, `contributions.ts` | *File › Export…* in its own group after Import (`export.file`, order 6); the dialog; the context keys |
| `…/formats.ts` | Validating contributions (as import's `formats.ts` does), ordering, `export.hasFormats` |
| `…/gather.ts` | `ExportData` from `accounts.service`: ranges, archive start, balances, names, bank ids; cached for the dialog's checks |
| `…/run.ts` | The flow: prepare, check, Save dialog, long operation, write with a time limit, message, remember |
| `…/files.ts` | `.partial` + rename with retry; the error messages |
| `…/memory.ts` | What exports remember, in `context.state` |
| `plugins/export/src/renderer/ExportDialog.tsx`, `OptionFields.tsx` | The dialog, drawing `ExportOptionField`s and `accountFields` from `@tessera/ui` |
| `plugins/format-csv/src/privileged/export.ts` (+ `index.ts`) | The CSV writer, from `scripts/export-spike/writers.ts`, and its export contribution and service |
| `tests/architecture/boundaries.test.ts` | `export-api` added to the API packages' allowed dependencies |

### Tasks, in order

1. The rename, alone, as its own change: `npm test` green before anything else is added. **Done**
   ([results](#phase-x1-results)).
2. `@tessera/export-api`, with the helpers and their tests (`minorToDecimal` exact over every currency's digits,
   `encodeText` with the 1252 and base-letter tables, `safeFileName`). **Done.**
3. `formats.ts` and `gather.ts`, tested against a fake `accounts.service`: range clamping at `periodStart`, opening
   and closing balances with voided and archived transactions, transfers named, `fp:` ids not passed as bank ids.
   **Done**, against the real accounts service on a memory engine rather than a fake.
4. `run.ts` and `files.ts`: the flow, the long operation, the write and rename (a held file, a full disk, a crash
   leaving `.partial`), the message. **Done.**
5. The CSV writer (Part 2), with golden files and round trips. **Done**, with the expected output written in the
   tests rather than in fixture files.
6. The dialog: format, accounts, dates, options, live checks, keyboard, themes. **Done**; seeing it in both themes
   is left for the check by hand.
7. README (*What works today*, *Project layout*), `plugin-creation.md` (*Adding an import format* becomes *Adding a
   file type*, reading and writing), `todo.md`. **Done**, with *Adding an export format* as a section of its own
   beside *Adding an import format*: each reads better on its own, and a file-type plugin follows both.
8. Remove `scripts/export-spike/`, `scripts/export-spike.mts` and `npm run spike:export` once X3 no longer needs them
   (at the end of X3). **Done** with X3.

### Tests

- `tests/packages/exportApi.test.ts`: helpers; property test: for random minor amounts and digits 0 to 3,
  `canonicalDecimal(minorToDecimal(m, d))` gives the same value back.
- `tests/plugins/export/`: `formats`, `gather`, `run`, `files`, `renderer/exportDialog`.
- `tests/plugins/format-csv/export.test.ts`: golden files in `tests/fixtures/export/csv/` (signed, money out/in,
  comma decimals, several accounts and currencies, quoting, formula guard, voided, JPY).
- `tests/plugins/format-csv/roundTrip.test.ts`: output read by the same plugin's `guessLayout` and `readLines`: no
  uncertainty, the same lines and balance (as `scripts/export-spike/check.ts` does).
- `tests/plugins/pipeline.smoke.test.ts` and `tests/plugins/import/pipeline.test.ts`'s pattern: the built `export`
  and `format-csv` activate, import still works, and a sample ledger exports to a temporary folder.
- On a read-only ledger and an archive file: the command is enabled and nothing in the ledger changes (its `rev`s and
  file modification time are the same).

**Done when:** the [Definition of done](#definition-of-done) holds, and the CSV opens correctly in Excel and
LibreOffice by hand.

### Phase X1 results

**Step 1, the rename (2026-11-12): done.** Steps 2 to 7 are done too: [below](#steps-2-to-7-the-contract-the-export-plugin-and-csv).

| What | Now |
|---|---|
| Plugin folders (moved with `git mv`, so their history follows) | `plugins/format-ofx`, `format-csv`, `format-qif`; their tests in `tests/plugins/format-*` |
| Manifest ids and names | `format-ofx` *OFX files*, `format-csv` *CSV files*, `format-qif` *QIF files* |
| Import contributions | `format-ofx.ofx`, `format-csv.csv`, `format-qif.qif`: labels, extensions and order unchanged |
| Services | `format-ofx.import`, `format-csv.import`, `format-qif.import`, leaving room for `….export` |
| Dialogs | `format-csv.dialog.layout` (CSV Columns), `format-qif.dialog.options` (QIF Options) |
| Header comments | Say *file-type plugin*, and which export phase adds its writer |
| Also updated | `packages/import-api/contract.ts` (its examples), `scripts/anonymise/` and `scripts/export-spike/` (their imports), 25 test files, README, `plugin-creation.md`, `import-file-types-design.md`, `samples/statements/README.md`, the CSV layouts fixture README. `import-manager-design.md` and `import-formats-design.md` are records, and keep the old names, with a note in their headers |

No behaviour changed: nothing in the import manager names a format.

**Checked.** Against a baseline taken just before the rename:
- **The full suite: 179 files, 2,855 tests, before and after.** All passed before. After, two full runs each had a
  few timeouts in tests `todo.md` already lists as timing out under a full run on a 4-core machine (the Fonts page in
  one run, the account dialog in the other). Each of those files passes alone. **Every one of the 46 suites the rename
  touches passed in both runs**, including `tests/plugins/import/pipeline.test.ts`, which builds the renamed plugins
  and imports through them, and the architecture boundaries.
- **Type-checks:** `plugins` 0 errors and `scripts` 0, before and after. `tests` has the same 28 errors as before,
  none of them about these plugins (the stale imports `todo.md` lists).
- `npm run spike:export`: all 21 files still read back.

**What a development machine notices.**
- **Delete `modules/import-ofx`, `modules/import-csv` and `modules/import-qif`** (build output, not in git). The build
  rebuilds each plugin into `modules/<id>` but doesn't remove folders whose source has gone. Left there, the old
  plugins load beside the new ones, and every statement file is claimed by two formats, so *Choose a Format* appears
  for each.
- **A ledger imported into before the rename** (agreed: no migration) keeps its saved account matches, payee names,
  category and sign choices, which are keyed by source, not by format. But:
  - it **forgets its CSV layouts and QIF options**, which are kept under the old format ids. *Saved Import Choices*
    no longer lists them, and the next file from each source is asked about, then remembered again;
  - the *Already imported?* rule doesn't pair two bank ids from the same format, and it sees `import-ofx.ofx` and
    `format-ofx.ofx` as two formats. So a later OFX line could, rarely, be **proposed** as already imported against
    one imported before the rename: the same amount, within 3 days, payees alike. It is a proposal, and
    *Change…* adds it.
  - If either matters, a one-step migration of the import schema (old format ids to new, in `import.batches`,
    `import.memory` and `import.accountLinks`) would put both right. It isn't planned.

#### Steps 2 to 7: the contract, the export plugin and CSV

Done 2026-11-12. *File › Export…* works end to end for CSV.

| Piece | Where |
|---|---|
| `@tessera/export-api` 1.0.0 | `packages/export-api/`: `contract.ts`, `protocol.ts`, `errors.ts`, `helpers.ts`. Registered in `tsconfig.base.json`, `vitest.config.ts`, the plugin build's `API_PACKAGES` and the architecture test (it may depend on `@tessera/types`, `ledger-api` and `accounts-api`, as `import-api` does) |
| The `export` plugin | `plugins/export/`: `privileged/` (`index.ts`, `contributions.ts`: *File › Export…* in its own group after Import; `formats.ts`; `gather.ts`; `run.ts`; `files.ts`), `shared/ranges.ts`, `renderer/ExportDialog.tsx` |
| CSV writing | `plugins/format-csv/src/privileged/export.ts`, contributed and provided beside the reader (`format-csv.export`) |

**Checked.**
- **The full suite: 189 files, 2,915 tests, all passing** (60 new). Type-checks: `plugins`, `scripts` and the new
  package have no errors; `tests` has the same 28 as before.
- **New tests**:
  - `tests/packages/exportApi.test.ts`: exact amounts (5,000 random ones read back as canonical decimals), the
    encodings (€, curly quotes, base letters, characters outside the basic plane), file names, options, errors;
  - `apiPackages.test.ts`: the naming rules;
  - `tests/plugins/export/`: `formats`, `ranges`, `files` (temporary file, retries, giving up, full disk), `gather`
    (order, names, balances, voided, open ends, bank ids, archives), `run` (preselection, preview over IPC, saving,
    the message, remembering, an archive file read-only, one at a time, failures, a writer that hangs, account
    limits), `renderer/exportDialog`, and `pipeline` (the built plugins, a SQLite ledger, a real file, a restart);
  - `tests/plugins/format-csv/export.test.ts` (exact output, every option, warnings, six variants read back as
    *recognised*) and `exportScale.test.ts`.
- **Scale**, in CPU time: CSV writes 100,000 transactions (7 MB) in 0.27 s in UTF-8 and 0.36 s in Windows-1252.
  Gathering 20,000 transactions through `accounts.service` takes 0.21 s. The dialog's preview reads the ledger once
  per choice of accounts and dates, not again when an option changes. No yielding is needed at this size.

**What the tests found, and was fixed.**
1. **The application state refuses field names with a '.'**, and format ids have one. Options kept as
   `{ 'format-csv.csv': … }` were silently not remembered. Only the pipeline test, on the real SQLite-backed state,
   saw it: the harness's memory state doesn't enforce the rule. Options are now kept as a list
   (`RememberedOptions[]`), and the run test checks there are no dotted field names.
2. **Windows-1252 was slow**: 1 s for 100,000 rows, paid again on every preview. `encodeText` now writes straight into
   a buffer: four times faster.
3. **A writer's bytes were checked with `instanceof Uint8Array`**, which fails for bytes from another realm (as jsdom's
   `TextEncoder` makes). The check is now `ArrayBuffer.isView`.
4. **Sentences built as "a ${label}"** read "a OFX statement". They are rephrased so that no label needs an article.

**Where the build departs from this note**, each small:
- **Contract**:
  - `ExportCheck` has a `transactions` count, which the preview shows;
  - `ExportAccount` has `closed`;
  - `check` and `write` may answer synchronously;
  - `accountFields`, with `bankId` and `intuitBankId`, wait for X3, which needs them.
- **Problems are shown before the Save dialog**, not after it: nobody is asked where to save a file that can't be
  written.
- **The Choose… checklist is flat**, each account showing its sub-ledger, rather than a tree where ticking a
  sub-ledger ticks what it holds. That is left for later.
- **The message after an export doesn't name the format**: the file's extension does.
- Reserved in the contract, but not built until X4: `export.manager` and `export.account`. (X4 built `export.account`;
  `export.manager` is left for later.)

**Still to do for X1, by hand:** in `npm run dev`, in light and dark themes, run *File › Export…* on the sample
ledger and on an archive file, and open the CSVs in Excel. The CSV definition was opened in LibreOffice in X0.

#### Fixes after the first run on Windows

Tried on Windows 11, in the dark theme, on 2026-11-12, round trip and all: *File › Export…* sits after Import in the
File menu. The Save dialog suggested `Northwind Card Services 3456 2026-10-02 to 2026-11-20.csv` in Documents,
filtered to *CSV file (spreadsheets)*. The message said what was saved and where. **Importing the file back into the
account it came from added nothing**: its 13 lines were proposed as *Already imported?*, as
[What survives a round trip](#what-survives-a-round-trip) says they should be.

What the run showed about the dialog, and what changed:

| Seen | Why | Now |
|---|---|---|
| **The dialog scrolled** | Everything was in one column, the options as radio buttons: nine rows of them. The default window (1200 × 800) leaves a dialog about 680 px; that column needed well over that | **Two tabs**, *What to export* and *File options*. Both panels share one grid cell, so the height doesn't change with the tab. **Each choice is a list**, two to a row, with its description under it (radio buttons in two columns would still have been about 690 px). **The preview stays below the tabs**, since an option can change what it says. The privacy line moved beside the buttons. About 590 px in all, by the components' sizes: to check by eye |
| **Choosing accounts opened a checklist inside the dialog**, which grew and scrolled | *Choose…* was an inline list | **One Accounts field**, whose list (*All accounts* first, then a checkbox for each account with its sub-ledger, type and currency) opens over the dialog. The field says what is chosen in a line. The radio buttons are gone |
| **The Dates list sat lower than From and To** (10 px at 125 % scaling) | The theme gives every field a dense margin (8 px above). A `Stack` takes the margins off its own children, but the Dates list was wrapped in a `Box`, so it kept its 8 px | **The three fields are the row's own children**, and a test checks that they share a parent. From and To lost their helper lines: for *All dates* they show the dates the export works out to |
| **"Dates" twice**: the range, and the CSV's date style | Two fields with one name | The CSV option is **Date format** |

Found while making these: with no account chosen, MUI's list showed an empty field, not *None chosen*, because it
only draws the value when there is one (`displayEmpty`). A test caught it.

The tests cover each change: the tabs (both panels kept, the hidden one out of reach, no options tab for a format with
none), the account list (it opens outside the dialog's form; *All accounts*; the one-line summary; none chosen), the
date row's fields sharing a parent, and the dates *All dates* shows. jsdom has no layout, so the tests guard the
causes, and the look is still to be checked by eye.

## Phase X2: QIF (M)

| File | What |
|---|---|
| `plugins/format-qif/src/privileged/export.ts` (+ `index.ts`) | The QIF writer: one and several accounts, the category list, opening balances, types, statuses, escaping, encodings |

**Tests:** golden files (one account, a whole ledger, a card, clashing names, UTF-8 and 1252, day-first dates). A
round trip through the plugin's own reader (`parseQif`, `collect`, `readStatement`): the accounts, types, opening
balances, lines, categories, cheque and transfer kinds. A round trip into a second ledger with the same categories,
where the user agrees to the file's categories: every transaction is back in its category.
**Done when:** the Definition of done holds, and the X0 targets read a whole-ledger export by hand.

### Phase X2 results

Done 2026-11-12. *File › Export…* offers **QIF file (Quicken, Microsoft Money, GnuCash)**: standard QIF, not Money's
looser dialect, with payees cut to 32 characters as standard QIF has them (both decided with the phase).

| Piece | Where |
|---|---|
| The QIF writer | `plugins/format-qif/src/privileged/export.ts`, contributed and provided beside the reader (`format-qif.export`). The payee limit is one constant, `QIF_LIMITS.payee` |
| Tests | `tests/plugins/format-qif/export.test.ts` (exact output; several accounts; the payee cut; names; options; warnings; read back by the plugin's own reader), `exportScale.test.ts`, `tests/plugins/export/qifRoundTrip.test.ts` (through the whole import), the pipeline test (the built QIF plugin) |

**Checked.** The full suite: 192 files, 2,934 tests, all passing (15 new). Type-checks as before: `plugins` and `scripts` clean, `tests` the same 28.

**What the round trips showed.**
- **A cut payee comes back another name, and nothing is added twice.** An account with three payees over 32
  characters (from a bank's CSV) and one typed by the user, exported as QIF and imported back into the account it came
  from, **added nothing**. Its 5 lines were recognised: the 3 imported ones as *Already imported?* (the cut name is
  still alike enough to the bank's text), the short one as a duplicate (the same date, amount and payee), and the
  typed one proposed as a match for the user's own transaction. Names differ, but the safeguards that stop doubling
  work on dates, amounts and how alike payees are, so a cut name is still recognised.
- **Into a new ledger, an account comes over at the same balance**, its cut payees' whole names at the start of their
  memos. Where that ledger has the same categories and the user takes the file's, **every transaction is back in its
  category**. Transfers come back as lines of kind *transfer*, without a category, as import makes no transfers.
- **A code in `N` comes back as a kind, not a number**: `EFT`, `ATM` and `DEP` say what kind of line it is on import,
  as the QIF reader has always read them. Cheque numbers come back.
- **Payees from OFX never need cutting**: OFX limits a bank's `NAME` to 32 characters already. Long payees come from
  CSV exports, QIF files and typing.
- **Scale**: a whole-ledger QIF of 100,000 transactions takes about 0.45 s in Node once warm (0.07 s of it encoding);
  QIF writes nine or so lines per transaction where CSV writes one.

**Where the build departs from this note:**
- **The opening balance is on by default**: an option's default can't depend on the range, as planned. Its
  description says when to turn it off.
- **The category list is offered for one account too**, not only several.
- **The date order is said only when it matters**, when every day is 12 or less, rather than after every export.

**Q11, settled**: Money's own dialog describes its standard ("strict") QIF: *"Only the first 15 characters of category
names and other names will be exported, and only classification 1 will be exported."* Tessera keeps to it: names of 15
characters ([below](#fixes-after-the-first-run-on-windows-1)). Money's strict export doesn't cut payees (its real
export in `tests/fixtures/import/real/qif/` has one of 34 characters); Tessera cuts them to 32, as decided with X2.

#### Fixes after the first run on Windows

Tried on Windows on 2026-11-12: a QIF exported from a ledger archived before 1 November, then imported back, and the
wording of Money's strict QIF read on a machine with Money. What it showed:

| Seen | Why | Now |
|---|---|---|
| **The export held five accounts** though one was meant | Nothing was selected when File › Export… started (no register shown, no account chosen in the navigator), so the dialog started on *All accounts*, as designed. Started from an account, it starts on that account (checked again through the navigator's own channel) | As designed. What made it hard to see is the next row |
| **"Will export 5 transactions from 5 accounts"**, when four had none in the dates | The count was of the accounts asked for, not of those with something to write. The four went into the file as opening balances alone, which the import then left out one by one (*has no transactions, so nothing of it was imported*). So this note's claim that such an account "still moves" was wrong for Tessera's own import | **An account with nothing in the range isn't written.** A format says which accounts it leaves out (`ExportCheck.accountsLeftOut`, export-api 1.1); the preview and the message count only the others, and name the ones left out in one line. A CSV with one account's rows is a one-account CSV, so it reads back as that account |
| **Only one account was asked about on import**, from a file of several | The other four had no transactions, so there was nothing to ask about. A file of several accounts **is** imported account by account: the Account dialog asks about each (*Statement 1 of 2*, *2 of 2*). A test now checks it, bringing two accounts into a new ledger at their balances | Nothing to change in import; the export no longer writes the empty accounts |
| **Five archive notes** pushed the dialog into scrolling again | One note per account | **One note** for them all: *“A”, “B” and “C” start on Nov 1, 2026: their earlier transactions are in an archive file.* In the message too |
| Money's strict QIF keeps **15 characters of names** | Standard QIF's limit (Q11) | Category names (each level) and account names are cut to 15, trimmed, and a warning gives examples. **Two accounts whose names would be one** (ignoring case) stop the export, with a message saying which and what to do: in this ledger, *Maple Trust chequing* and *Maple Trust Chequing - french* would both be *Maple Trust che*. Two categories that would be one are warned about |

What 15-character names cost on the way back into Tessera, checked through the whole import: a category whose name (at
any level) is longer comes back as one the ledger doesn't have, so its line comes back **without a category**.
*Housing : Mortgage interest*, which every new ledger has, is one. A new account gets the cut name.

The full suite after these fixes: 193 files, 2,941 tests, all passing.

**Still to do, by hand:** export QIF in `npm run dev`, and read it in Quicken, Money or GnuCash when one is at hand
(X0's A6 to A9).

## Phase X3: OFX, QFX and QBO, and the account fields (L)

| File | What |
|---|---|
| `packages/accounts-api/` (`model.ts`, `service.ts`, `rules.ts`) | `bankId` and `intuitBankId` on `Account`, `AccountInput` and `AccountPatch`, with validation ([Account fields for OFX](#account-fields-for-ofx)) |
| `plugins/accounts/` (the service, `AccountDialog.tsx`) | Stored and edited; the *Downloads and exports* section |
| `packages/import-api/contract.ts` | `StatementAccount.bankId` and `intuitBankId` (import-api 1.8) |
| `plugins/format-ofx/src/privileged/statements.ts` | Reads `BANKID` and `INTU.BID` into them (the Intuit id not when the statement's ids look made up) |
| `plugins/import/src/privileged/accountResolution.ts`, `run.ts` | A new account created from a statement gets both; an existing account's empty ones are filled, never overwritten, and the summary says what was filled and warns when the file's value differs (Q9) |
| `plugins/format-ofx/src/privileged/export.ts` (+ `index.ts`) | Three export contributions, one writer; `accountFields`: account number and bank number required, Intuit id recommended for QFX and QBO |

**Tests:** the account fields (validation, stored, edited, archived and restored, prefilled by an OFX import, the
Intuit id not taken from a converter's file). Writer golden files (bank, card, line of credit, QFX and QBO with and
without an Intuit id). Limits: a 50-character payee (cut and trimmed), a 13-character cheque number, a masked
account number. Escaping; FITIDs (bank id kept, `fp:` not used, `TESSERA.` otherwise, and stable across two exports);
`TRNTYPE`. A round trip through the plugin's own reader: a strong key, the period, the balance, no made-up id warning,
and re-importing the file into its own account adds nothing.
**Done when:** the Definition of done holds, and Money reads the OFX, Quicken the QFX and QuickBooks the QBO by hand,
or X0's findings say why one can't.

### Phase X3 results

Done 2026-11-12. *File › Export…* offers **OFX statement (Microsoft Money, GnuCash)**, **QFX file (Quicken)** and
**QBO file (QuickBooks)**: one bank or card account per file, written by one writer in `format-ofx`, beside its reader.

| Piece | Where |
|---|---|
| The account fields | accounts-api 1.12: `Account.bankId` and `intuitBankId`, checked by the service, with `BANK_ID_MAX_LENGTH` and `INTUIT_BANK_ID_MAX_LENGTH`; the Account dialog's *Downloads and exports* section |
| Filled by imports | import-api 1.8: `StatementAccount.bankId` and `intuitBankId`, read by `format-ofx` (the Intuit id not from a file whose ids look made up); `accountFromStatement` gives both to a new account; `Importer.fillAccountIds` fills an existing account's empty ones after a statement imports, and says what it filled or found otherwise (Q9); since the first run on Windows, the account number too ([below](#fixes-after-the-first-run-on-windows-2)) |
| The export side | export-api 1.2: `accountFields` (`AccountFieldUse`, with the account types each is for), `ExportAccount.bankId` and `intuitBankId`, `ExportRequest.accountValues`; the export manager puts the values typed in the dialog in place of the account's, for that export only (Q10); the dialog's *Account details for this file* |
| The writer | `plugins/format-ofx/src/privileged/export.ts`: three contributions, one service (`format-ofx.export`) |
| Tests | `tests/plugins/format-ofx/export.test.ts` (exact output, ids, cards, QFX and QBO, problems, warnings, read back), `tests/plugins/export/ofxRoundTrip.test.ts` (through the whole export and import), `tests/plugins/import/bankIds.test.ts`, the accounts service and dialog tests, the Export dialog's account fields, and the pipeline test (the built OFX plugin) |

**Checked.** The full suite: 196 files, 2,967 tests, all passing. Type-checks: `plugins`, `scripts` and the API
packages clean; `tests` the same 28 as before.

**What the round trips showed** (through the whole export and import):
- **Back into the account it came from, nothing is added.** The statement is found by its bank and account number,
  so no question is asked. Lines that came from the bank keep its ids, and are known as duplicates; a transaction the
  user typed (written with Tessera's own id) is proposed as a match for itself. For Maple Trust's October: 18 lines,
  17 duplicates, 1 matched, 0 added.
- **Into a new ledger, the account comes over with its number, bank number and institution, at the same balance**,
  since the file carries them and the import fills them in.
- **What is typed in the dialog is in the file and nowhere else**: a bank number typed for one export is written, and
  the account still has its own.
- **A file's Intuit id is never taken from a converter's file**: a QBO whose ids look made up (and whose `INTU.BID`
  may be any bank's) fills in the bank number, not the Intuit id.

**Where the build departs from this note:**
- **A bank number is for bank accounts**: `accountFields` say which account types each is for, so a card's statement
  asks for its number only.
- **An account OFX can't hold is said to be so, and nothing else**: not also asked for its numbers. When the export
  manager and the format find the same problem, it is said once.
- **The line under the account fields names the menu** (*Accounts › Edit Account…*) rather than being a link: the
  dialog has no way to run a command.
- **The spike was removed** (`scripts/export-spike/`, `npm run spike:export`), as planned. The checks by hand in X0 now
  start from *File › Export…* ([checklist](#what-remains-the-checklist-for-windows)).

**Still to do, by hand:** in `npm run dev`, export OFX, QFX and QBO (the Account dialog's new section, the dialog's
account fields); and read them in Money, Quicken and QuickBooks when at hand (X0's A10 to A15).

#### Fixes after the first run on Windows

Seen 2026-11-12: a QFX exported from a card with no account number (typed in the dialog, as it must be) and imported
back into that card left the card's number empty, though the file has it. The import filled an existing account's
empty bank number and Intuit bank id (Q9), but not its number: only a new account took that.

| Change | Where |
|---|---|
| **An existing account's empty account number is filled from the file**, as its bank ids are: never overwritten, a difference warned about, the summary saying what was filled ("“Card”’s account number was filled in from the file: •••• 3456."). Only when the statement's match is remembered, since accounts are found by their number ([Account fields for OFX](#account-fields-for-ofx)) | `run.ts` `fillAccountIds` (was `fillBankIds`); `Resolution.remembered` |
| **One rule for the number a statement gives an account**: the whole number, or the last four of a masked one, within the account's 50 characters. A new account and a filled one take the same | `accountResolution.ts` `accountNumberOf`, `accountNumbersDiffer` |
| Tests: filled and said; the next file adds nothing and says nothing of it; a differing number kept, with a warning masked or whole; a masked file fills the last four and is then the same number; a one-off import fills no number (but still the bank number) | `tests/plugins/import/bankIds.test.ts` |

So the round trip now completes: the account keeps the number the file brought back, the next export has it filled
in, and another file that names the card by that number finds it without asking.

Also added: the architecture test the [Risks](#risks) promised, that the writers never format amounts for display or
through floating point (`formatAmount`, `toFixed`, `parseFloat`, `Intl.NumberFormat`).

**Checked.** The full suite: 196 files, 2,971 tests; all pass, except two of the account dialog's tests, which timed
out in the full run on a 4-core machine (as `todo.md` already notes) and pass alone. Type-checks: `plugins` and
`scripts` clean; `tests` the same 28 as before.

## Phase X4: Export Account… (S)

- **Accounts › Export Account…** (`export.account`, argument `{ id }`) in the Accounts menu's register group,
  enabled when `accounts.selection.kind == 'account'`. It opens the Export dialog with that account chosen.
- **The `export.manager` service** for other plugins (a report, a scheduled export), with the same data and
  writers. **Left for later** (decided 2026-11-12), as no plugin needs it yet. What it was to be:
  ```ts
  interface ExportManager {
    formats(): ExportFormatInfo[]
    /** Without the dialog: every value given, nothing remembered. Writes `path` safely. */
    exportToFile(request: { formatId: string, accountIds: string[], range: ExportRange,
      options?: ExportOptions, path: string }): Promise<ExportReport>
  }
  ```
  with `plugin-creation.md`'s *Using exports from another plugin*. It would be tested with a non-interactive export
  for an account missing a required field (its bank number, say): refused with the problem, and nothing written.

**Done when:** *Export Account…* is tested: the menu, when it is enabled, the account it starts from, the export.

### Phase X4 results

Done 2026-11-12.

| Piece | Where |
|---|---|
| The command | export-api 1.3: `EXPORT_COMMANDS.account`'s argument, `ExportAccountArgs` (`{ id }`); `plugins/export/src/privileged/index.ts` registers it beside *File › Export…*, with the same enablement and the navigator's selected account |
| The menu item | *Accounts › Export Account…* (`Ex&port Account…`), last in the Accounts menu's register group, after *Reconcile with Statement…* (`contributions.ts`) |
| The flow | `Exporter.exportFile(startId)`: the same dialog, titled *Export Account*, starting from that account; the rest as *File › Export…* (the Save dialog's name is the account's, and the message the same) |
| Tests | `tests/plugins/export/run.test.ts`, *Accounts › Export Account…*: the menu and its place, when it is enabled, the selected account or the one given (a closed one too), the format it starts on, the export and its message, an account that isn't there |

**Where the build departs from this note:**
- **The dialog starts on a format that can hold the account.** The last format used, if it can; otherwise the first
  that can (so a card isn't started on a format for bank accounts only). *File › Export…* now does the same for the
  account the user is looking at, which before could start on a format that didn't list it.
- **The command needs a selected account**, as the Accounts menu's other account commands do, even when another
  plugin gives it an `{ id }`. An `{ id }` not in the ledger is said to be so, and no dialog opens.
- **Not in the navigator's right-click menu**: that menu is the accounts plugin's own and has no extension point for
  other plugins' commands (only reconcile actions). Adding one is left for when another plugin wants a place there.
- **`EXPORT_MANAGER_SERVICE` stays in the contract**, marked as reserved, so the name is kept.

**Also done with X4** (from the review after X3):
- **A short account number is warned about** in OFX, QFX and QBO: an account number of four characters or fewer is
  written, with a warning that it may be only the last digits of the real one (an account made from a masked
  statement, such as the Northwind samples', keeps only its last four), and that the program reading the file finds
  the account by its whole number. Test: `tests/plugins/format-ofx/export.test.ts`, *a short account number*.

**Checked.** The full suite: 196 files, 2,977 tests; all pass, except two of the Fonts page's tests, which timed out
in the full run on a 4-core machine (as `todo.md` already notes) and pass alone. Type-checks: `plugins` and `scripts`
clean; `tests` the same 28 as before.

**Still to do, by hand:** in `npm run dev`, select an account, then *Accounts › Export Account…*: the dialog titled
*Export Account* with that account chosen; a card starts on a format that holds cards; an OFX, QFX or QBO export of
the Northwind card (number `3456`) shows the short-number warning.

## Testing

As built (the plan had golden files in `tests/fixtures/export/` and a `roundTrip.test.ts` per file-type plugin; the
expected output went into the tests instead, and the round trips into each writer's tests and the export plugin's).

| Kind | Where | What it proves |
|---|---|---|
| Helpers and properties | `tests/packages/exportApi.test.ts` | Exact amounts (5,000 random ones read back), encodings, file names, options |
| Exact output | `tests/plugins/format-*/export.test.ts` | The bytes written don't change unnoticed, for every option; problems and warnings |
| **Round trips** | The same files (through each plugin's own reader), `tests/plugins/export/qifRoundTrip.test.ts` and `ofxRoundTrip.test.ts` (through the whole import) | Tessera reads its own exports back as Part 2 says; back into their own account, nothing is added |
| Manager | `tests/plugins/export/` (`formats`, `ranges`, `gather`, `run`, `files`, `notes`) | Gathering, ranges, balances, the flow, safe writing, read-only ledgers and archive files |
| Account fields on import | `tests/plugins/import/bankIds.test.ts` | An import fills an account's empty numbers, never overwrites one, and warns when they differ |
| Dialog | `tests/plugins/export/renderer/` | Options drawn from data, checks, account fields, keyboard |
| Amounts | `tests/architecture/boundaries.test.ts` | No writer formats an amount for display or through floating point |
| End to end | `tests/plugins/export/pipeline.test.ts` | The built plugins, a SQLite ledger, a real file, a restart |
| Scale | `tests/plugins/format-csv/exportScale.test.ts`, `tests/plugins/format-qif/exportScale.test.ts` | 100,000 transactions written within a CPU-time budget (CSV 0.27 s, QIF about 0.45 s when measured) |
| By hand | X0's checklist, then each phase | Other applications read the files |

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Writers in plugins of their own** (`export-csv`, `export-qif`, `export-ofx`), beside the import plugins | What this note first proposed. Turned down in review (Q1): two plugins per file type split what Tessera knows about a dialect, and the rename it avoided doesn't matter while Tessera is in development |
| **Writers built into the `export` plugin, no extension point** | Simplest, but against how Tessera is built: the manager would know file formats, and a new format (Excel, Beancount, ledger-cli) couldn't be a plugin |
| **Export inside the `import` plugin** | Different enablement (exports work read-only), a different lifecycle, and no shared logic. It would also make export depend on import being installed |
| **Each format draws its own options dialog** (as CSV Columns does on import) | Needs a renderer per writer, and would make the options look different for each format. Declarative fields cover every option designed here |
| **Remember options in the ledger** (as import does, F-6) | Export preferences are the user's, not the ledger's. The ledger may be read-only, and it would need a schema and a migration. An account's OFX ids are the exception, and are account fields (Q2) |
| **Keep an account's OFX ids in application state** | What this note first proposed. Turned down in review (Q2): the ids describe the account, belong with it in the ledger and its archives, and an OFX import can fill them |
| **OFX 2.x (XML)** | Fewer programs read it than 1.0.2, and banks still send 1.x. Tessera reads both, so an option can be added later if a target needs it |
| **Mark transactions as exported, and export only what's new** | It changes the ledger, which breaks read-only exports (E-5). A date range covers the need, and stable FITIDs make overlaps harmless |
| **Ship a default `INTU.BID`**, as converter tools do | The file would claim to come from a bank it didn't come from (E-8) |

## Risks

| Risk | Mitigation |
|---|---|
| A target application refuses a file, or reads it wrongly | X0 before the defaults are fixed. Every default is an option. The message after a QFX/QBO export names OFX as the fallback |
| **Dates misread** by a target (a QIF whose days are all 12 or less) | Four-digit years, the order as an option, and the message saying which order was written. CSV defaults to ISO |
| **Transfers doubled** in a target that imports both sides of a whole-ledger QIF | X0 checks each target. If one doubles them, an option writes each transfer once, from the first account |
| **Characters lost** in Windows-1252 | Reduced to the base letter where possible, otherwise `?`; counted in the preview before writing; UTF-8 as an option |
| **Amounts wrong** through floating point | Only `minorToDecimal`; a property test; `formatAmount` never used in writers (a unit test greps the writers for it, as the architecture tests grep for colours) |
| **A formula in a spreadsheet** from a payee's text | The formula guard, on by default (E-13) |
| **The main process stalls** on a very large export | Measured in X1's scale test. If gathering and writing 100,000 transactions takes more than about a second, yield between accounts and show progress, as import's *Yield while matching* plans |
| **A transfer edited while exporting** shows two sides differently | The dialog is modal, the read is short, and it happens under the long operation. Accepted; a `register()` snapshot across accounts could be added to `accounts.service` if it is ever seen |
| **Personal data** in files the user keeps | Their choice. One line in the dialog says it; nothing is logged beyond counts |

## Decisions taken in review

Answered on 2026-11-12, and applied throughout this note.

| # | Question | Decision | Where it lands |
|---|---|---|---|
| Q1 | Writers in their own plugins, or with the readers? | **Readers and writers together, one file-type plugin each.** Breaking changes don't matter while Tessera is in development | [E-1](#decisions), [Architecture](#architecture); X1 starts with the rename. confirmed by Q8 |
| Q2 | Where do an account's OFX ids live? | **Account fields** | [E-15](#decisions), [Account fields for OFX](#account-fields-for-ofx); X3 |
| Q3 | QFX and QBO without an Intuit id | **Write and warn** | [E-8](#decisions), [QFX and QBO](#qfx-and-qbo) |
| Q4 | QIF's default date order | **Month first** | [QIF › Options](#qif); checked in X0 (A6) |
| Q5 | Voided transactions in QIF | **Left out** | [E-11](#decisions) |
| Q6 | Exporting from a read-only archive file | **Allowed** | [E-5](#decisions) |
| Q7 | Both sides of a transfer in a whole-ledger QIF | **Both**, so each account's history is complete | [What is exported](#what-is-exported); what targets make of it is A8 |
| Q8 | "A single file support plugin": per file type, or one for all five? | **One plugin per file type**, handling both import and export | [Architecture](#architecture); the rename in X1 ([results](#phase-x1-results)) |
| Q9 | Should an OFX import fill an existing account's empty *Bank number* and *Intuit bank id*? | **Yes, but never overwrite**; warn when the file's value differs. Extended after the first run on Windows to the account number, when the statement's match is remembered | [Account fields for OFX](#account-fields-for-ofx); X3 |
| Q10 | Is a value typed in the Export dialog saved to the account? | **No: exports have no side effects** | [E-5](#decisions), [The Export dialog](#the-export-dialog) |
| — | OFX, QFX and QBO: one plugin or three? | Left to the author: **one**, `format-ofx` | [E-7](#decisions) |
| Q11 | Standard QIF's limits | **Standard QIF, as Money's strict**: names (each category level, and accounts) of 15 characters; payees of 32, as decided with X2. Money's dialog: *"Only the first 15 characters of category names and other names will be exported"* | [QIF](#qif); [X2 results](#phase-x2-results) |

## Open questions

None. What is still unknown is what other programs accept: assumptions A2 to A16, waiting on X0's checks by hand
([Phase X0 results](#phase-x0-results)). Work goes on with the defaults as designed, and each is an option the user
can change if a program needs it.

## Later

| Item | Notes |
|---|---|
| **Several accounts in one OFX file** | Allowed by the standard, and Tessera reads it; target support to be checked |
| **Excel** (`.xlsx`) | A writer plugin producing one sheet per account, with real dates and numbers |
| **Splits** | When `accounts` has them: QIF `S`/`E`/`$`, CSV one row per part |
| **Investments** | When `accounts` has holdings: QIF `!Type:Invst`, OFX `INVSTMTRS` |
| **Export from the register's selection** | Only the selected rows |
| **Scheduled exports** | A plugin on `export.manager` |
| **The `export.manager` service** | For other plugins (a report, a scheduled export): first planned in X4, left until a plugin needs it ([X4](#phase-x4-export-account-s)). Its name is reserved in the contract |
| **Checks in other programs** | X0's steps 3 to 5: Money, Quicken, QuickBooks, GnuCash and Excel by the [checklist](#what-remains-the-checklist-for-windows), and the OFX 1.0.2 specification's lengths. Assumptions A2 to A16 stay open until then; every default is an option the user can change if a program needs it |
| **Export Account… in the navigator's right-click menu** | Needs an extension point in the accounts plugin for other plugins' account commands |
| **Reports** | Exporting a report's table is the report's feature, through its own CSV |

## Documentation changes

| When | Change |
|---|---|
| X0 | Results and amended defaults here. `todo.md`: the phases |
| X1 | The rename everywhere: README (*What works today*, *Project layout*), `plugin-creation.md` (*Adding an import format* becomes *Adding a file type*, with writing), `import-file-types-design.md` (its plugin names, and exporting no longer a non-goal of the file types), `samples/statements/README.md`, `tests/fixtures/import/real/README.md`. README: *Exporting*, `export` and `export-api`, and this note under *Documentation* |
| X2, X3 | README: the formats; this note's Part 2 amended by what was built; results sections. X3: `account-manager-design.md`, the two account fields |
| X4 | README and `todo.md`: *Export Account…*. `plugin-creation.md`'s *Using exports from another plugin* waits for `export.manager` ([Later](#later)) |

## Definition of done

For every phase:
- [ ] `npm test` green, including the architecture boundaries and the fixtures' privacy test
- [ ] No new errors from `npx tsc --noEmit -p plugins` (and `-p tests` when tests are touched)
- [ ] Every disposable pushed onto `context.subscriptions`
- [ ] Round-trip tests for every format the phase adds
- [ ] Checked by hand in `npm run dev`, in light and dark themes, including from an archive file opened read-only
- [ ] The phase's results recorded here, and `todo.md` ticked

## Phases

| Phase | Delivers | Size |
|---|---|---|
| X0 | Compatibility spike: every file written and read back by Tessera (done), CSVs in LibreOffice (done); Money, Quicken, QuickBooks, GnuCash, Excel and the OFX specification **left for later**; defaults as designed | S |
| X1 | The import plugins renamed into file-type plugins (`format-csv`, `format-qif`, `format-ofx`); `@tessera/export-api`; the `export` plugin (*File › Export…*, the Export dialog, gathering, safe writing, remembered choices); CSV export. **Built**, and checked by hand on Windows; Excel left for later | L |
| X2 | QIF export: one account or a whole ledger, categories, transfers, statuses, opening balances; standard QIF's names of 15 characters and payees of 32. **Built** | M |
| X3 | OFX, QFX and QBO export, one bank or card account per file, stable FITIDs; the account fields *Bank number* and *Intuit bank id*, filled by OFX imports. **Built** | L |
| X4 | *Accounts › Export Account…*, and a warning for short account numbers in OFX, QFX and QBO. **Built**; `export.manager` left for later | S |
