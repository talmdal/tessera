# Design and implementation: the import manager

| | |
|---|---|
| **Status** | In progress: phase 0.1 (`@tessera/import-api`, [results](#01-results)) and 0.2 (`shell.files` additions, [results](#02-results)) 0.3 (`accounts` bank-line methods, [results](#03-results)), 0.4 (register annotations, [results](#04-results)) and 0.5 (New Account with initial values, [results](#05-results)) done: phase 0 is complete. Phase 1 (the import plugin and OFX, [results](#phase-1-results)) and phase 2 (matching and review, [results](#phase-2-results)) done. Phase 3 (CSV) next. Review decisions of 2026-11-06 applied (see [Decisions taken in review](#decisions-taken-in-review)) |
| **Date** | 2026-11-06 |
| **Scope** | Importing bank and card statements from files into the open ledger: the `import.formats` extension point that format plugins contribute to, choosing files, working out which account a statement belongs to (and remembering it), adding the statement's transactions to that account's register, fuzzy matching against transactions already entered, and reviewing those matches in the register |
| **Builds on** | [account-manager-design.md](account-manager-design.md) (`accounts.service`, the register, the `externalId` reserved on transactions, `accounts.reconcile.actions` as the model for a data-only extension point), [plugin-creation.md](plugin-creation.md) (`shell.dialogs`, `shell.files`, `ledger.schema`) |
| **Replaces** | The `accounts.importers` sketch in [vault-design.md](vault-design.md#accountsimporters-extension-point-and-pluginparser-service). The ideas are kept (a format plugin turns bytes into a neutral statement, and the consumer decides what to do with it), and the owner and names change (see [Decisions](#decisions)) |
| **Layout** | [Part 1](#part-1-design) is the design (*what and why*), and [Part 2](#part-2-implementation) is the implementation plan (*how and in what order*), in the style of [account-manager-implementation.md](account-manager-implementation.md) |

---

## Summary

- **An *import manager* plugin, `import`, owns importing.** It contributes *File › Import…*, and it owns the
  **`import.formats`** extension point, the account resolution, the matching and the bookkeeping of what has been
  imported. It knows nothing about any file format.
- **Format plugins add file types.** A format plugin contributes a plain-data descriptor to `import.formats` (label,
  file extensions, a service id). It then provides that service, which turns a file's bytes into neutral
  **`ParsedStatement`s**. One plugin could read Microsoft Money's download format (OFX/QFX), another CSV, another
  QIF. Installing one adds its file types to the import dialog, and nothing else changes.
- **The flow:**
  1. *File › Import…*, the only place an import starts, opens a file dialog that lists **only files matching the
     installed formats' extensions**.
  2. Each file is parsed by its format.
  3. Each statement is **assigned to an account**. This uses a saved match, or the account number, or, when neither
     settles it, a dialog where the user **picks an account or creates a new one**. The choice is **saved in the
     ledger**, so the same statement source goes to the same account next time. A CSV file doesn't identify its
     account, so for CSV files the dialog appears every time, with the remembered account already chosen.
  4. The statement's lines are checked against what is already in the account: lines imported before are
     skipped; the rest are **fuzzy-matched** to existing transactions **by date, amount and payee**. Any of the
     three may differ a little, so a small difference lowers the score without ruling out the match.
  5. Lines with no match are **added to the account's register** as new transactions, marked *electronically
     cleared*. Matches are **proposed**; nothing in a matched transaction changes until the user accepts.
- **Reviewing happens in the register.** A row with a proposed match shows the bank's version under it and **two
  buttons: *Accept* and *Change…***.
  - *Accept* applies the match: the transaction takes the **bank's date and amount**, and keeps the user's payee,
    category and memo.
  - *Change…* opens a dialog to pick another transaction, to **unmatch** (the transaction stays or goes back to what
    it was, and the bank line becomes a transaction of its own), or to leave the line out.
  - Rows added as new have the **same two buttons**, in case the matcher missed one.
  - Nothing is ever accepted automatically.
- **The register stays owned by `accounts`.** `accounts` gains a small generic, data-only extension point,
  **`accounts.register.annotations`**. Through it a plugin marks rows and gives them buttons that run the plugin's
  commands, the way `accounts.reconcile.actions` adds menu options. The import manager is its first user.
- **All writes go through `accounts.service`**, which gains `externalId` on drafts, an all-or-nothing `createMany`,
  and an atomic `match` and `unmatch`. Import bookkeeping (batches, lines, saved account matches, payee aliases) lives in the ledger,
  in the import plugin's own collections.

---

# Part 1: Design

## Naming

| Concept | User-facing name | Code name | Notes |
|---|---|---|---|
| The feature and its plugin | **Import** | plugin `import`; `ImportManager` | *File › Import…* |
| A file type a plugin can read | **Format** | `import.formats`, `ImportFormat` | "OFX / QFX statement", "CSV file" |
| What a format produces: one account's lines for a period | **Statement** | `ParsedStatement` | A file can hold several (an OFX file with two accounts) |
| One transaction in a statement | **Statement line** (in prose); **bank line** (in the UI) | `StatementLine` | |
| A remembered "this source goes to that account" | **Saved account match** | `AccountLink` | Stored in the ledger |
| A proposed pairing of a bank line with a register transaction | **Match** | `match` | *Accept*, *Change…* |
| One run of one statement into one account | **Import** (in history) | `ImportBatch` | Undone as a unit (phase 4) |

"Import manager" is the name of the component in this note and in the code (`ImportManager`, the `import.manager`
service). Users only ever see *Import*.

---

## Context

What exists and this design relies on:

| Facility | Used for |
|---|---|
| `accounts.service` ([packages/accounts-api/](../packages/accounts-api/)): `list({ accountNumber, institution, currency })`, `createAccount`, `transactions(id).create / update / list`, `payees.search`, `onDidChange` | Finding the account, adding and matching transactions. The service is the integrity boundary, and importers write through it (account-manager decision 8) |
| `Transaction.externalId` and the sparse unique index `[accountId, externalId]` on `accounts.transactions` ([schema.ts](../plugins/accounts/src/privileged/schema.ts)) | Recognising a bank line that is already in the account |
| The `electronic` clearing status (`E`) | Set by import: "the bank reported it" |
| `ledger.schema` and `ledger.session.database('import')` | The import plugin's own collections in the ledger |
| `shell.files.showOpenDialog` with filters; `shell.prompts.show` for `shell.dialogs` contributions; `confirm`, `message` | Choosing files; the account and match dialogs |
| The descriptor + service pattern ([vault-design.md](vault-design.md#rules-this-design-follows), rule 4) | `import.formats` |
| `accounts.reconcile.actions`: a data-only extension point whose entries name commands, resolved by `accounts` for the register | The model for `accounts.register.annotations` |
| `shell:commands.execute` from a view, with arguments | The register's *Accept* and *Change…* buttons run the import plugin's commands |

Gaps, and how the design handles each:

| Gap | Handling |
|---|---|
| `TransactionDraft` has no `externalId` (todo.md: "an `externalId` on drafts for import") | **Prerequisite:** add it to drafts and patches, with a `DUPLICATE_EXTERNAL_ID` error |
| No way to add many transactions atomically, or to merge a bank line into an existing transaction (or take it out again) atomically | **Prerequisite:** `TransactionManager.createMany`, `match` and `unmatch` |
| `shell.files.showOpenDialog` returns one path | **Prerequisite:** `showOpenFilesDialog`, which returns several |
| A plugin can't draw inside another plugin's view, so the import plugin can't put buttons in the register | **Prerequisite:** `accounts.register.annotations`: rows marked with data, buttons that run commands. The same answer as reconcile actions, for rows instead of menus |
| The account dialog can't be opened with values filled in | **Prerequisite:** `AccountDialogInput` gains `initial` in create mode, so "Create a new account…" reuses the accounts plugin's own form and rules |
| No declared extension points (todo.md) | The import plugin validates `import.formats` contributions itself and logs `[import]` warnings, as `accounts` does for reconcile actions |
| Menus are built once, and items can't be hidden | *File › Import…* is always present, and disabled while no format is installed (`import.hasFormats`) |
| An import and a backup could overlap (found while designing backups) | An import is the ledger's operation (`LedgerSession.beginOperation('Importing statements')`) for its whole run, dialogs included: no backup, Close or Open runs meanwhile, and *File › Import…* is also disabled while another operation, such as a backup, runs (`ledger.isBusy`). See [backup-restore-design.md](backup-restore-design.md#one-thing-at-a-time) |
| No settings framework ([settings-design.md](settings-design.md) is proposed only) | The matching tolerances are constants in one file for now; a settings page comes later |

---

## Goals and non-goals

**Goals**

- An extension point through which a plugin adds a file format, with no change to the import manager or `accounts`.
- *File › Import…*: choose one or more files, from a dialog that shows only the files the installed formats can read.
- Put each statement in the right account. Recognise it without asking when the file identifies the account, ask
  when it doesn't, let the user create an account from the dialog, and **remember the answer** in the ledger.
- Never import the same bank line twice, however often a file, or an overlapping file, is imported.
- **Fuzzy-match** lines to transactions the user has already entered, tolerating small differences in date, amount
  and payee, and let the user **accept or change** each match in the register.
- Learn from the user. Accepting a match remembers how the bank writes that payee, so the next import uses the
  user's name and category.
- No silent changes to the user's data. A proposed match changes nothing until it is accepted, nothing is accepted
  automatically, every match can be unmatched, and every import can be undone (phase 4).

**Non-goals** (each has a place; see [Phases](#phases))

- Connecting to banks (OFX Direct Connect, open-banking APIs). Such a plugin would hand statements to the
  `import.manager` service, so it needs no file, but it is not part of this design.
- Migrating a whole Microsoft Money `.mny` file: categories, payees, splits, investments, budgets. A format plugin
  can read a `.mny` file's account registers as statements, but a full migration is a separate tool.
- Investment transactions (buys, sells, lots). The neutral model is cash lines only; `accounts` has no holdings yet.
- Split transactions from the file (`accounts` has no splits yet).
- Creating transfers automatically. A line that looks like a transfer is imported or matched as an ordinary line.
- Exporting.

---

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **A separate `import` plugin owns importing**, not `accounts` | Agreed in review. `accounts` is already the largest plugin, and importing is optional: a user who types everything in doesn't need it. `accounts.service` is the integrity boundary, so an importer written against it can't break the rules. The vault note placed importers in `accounts` because it assumed the review UI had to live there. The annotation point (decision 6) removes that need |
| 2 | **`import.formats` is a descriptor + service point.** The contribution is plain data (label, extensions, service id); the parser is a service under the format plugin's own id | The repository's rule for several implementations of one role. Contributions stay validatable without running plugin code, and the one-provider-per-service-id rule is respected |
| 3 | **Formats produce neutral statements; they never touch accounts or the ledger** | A format plugin is then small and easy to test (bytes in, data out), and every format gets the same account resolution, duplicate detection, matching and review |
| 4 | **Amounts cross the format boundary as decimal strings** (`'-84.12'`), and the import manager converts them to minor units once it knows the account's currency | No floating point anywhere (account-manager decision 5). A CSV file doesn't state its currency, so a format can't convert to minor units itself |
| 5 | **A match is a proposal.** The existing transaction is unchanged until *Accept*. Lines with no match are added at once, as `electronic` | Agreed in review. A proposal may be wrong, and accepting it changes the user's date and amount. A line with no match is a real bank transaction, and the balance should include it straight away, as in Money |
| 6 | **`accounts` gets a generic `accounts.register.annotations` point**: rows marked with data, and buttons that run commands | The register can't host another plugin's components. Data plus commands works with today's framework, as reconcile actions do, and other plugins can use it too (a duplicate finder, say) |
| 7 | **Saved account matches and import records live in the ledger** (`import.*` collections) | They refer to the ledger's account ids, and they must travel with the file and disappear with it |
| 8 | **Every added or matched transaction carries an `externalId`**: the bank's id (OFX `FITID`) when the file has one, otherwise a **fingerprint** of the line | The unique `[accountId, externalId]` index then makes double-importing impossible, even for CSV files, which have no ids |
| 9 | **Accepting a match takes the bank's date and amount, and keeps the user's payee, category and memo** | Decided in review. The bank's date and amount are what actually cleared, so the register follows the statement and reconciling against it is straightforward. The user's descriptive fields are better than the bank's (`POS PURCHASE COSTCO WHSE #0123` versus *Costco*, *Food : Groceries*) |
| 10 | **CSV files ask for the account every time, with the remembered account chosen**, unless the user ticks *Don't ask again* | A CSV file's only identity is its column layout, and two banks can share one. One click confirms, and the user can choose to skip the dialog in future |
| 11 | **One import runs at a time**, and a statement's additions are one storage transaction | The dialogs are modal anyway, and it keeps recovery simple (see [Applying an import](#applying-an-import)) |
| 12 | **Format code runs in the privileged half, on bytes the import manager has read** | The renderer has no Node access. Format plugins never open files, so they need no file-system access and are easy to test |
| 13 | **Every row to review has the same two buttons, *Accept* and *Change…***, whether it is a proposed match or was added as new | Decided in review, for consistency: one pattern to learn. The Change Match dialog offers what suits the row. New rows need acknowledging, so a missed match is noticed |
| 14 | **In the UI, importing starts only from *File › Import…*, and the account always comes from the statement** | Decided in review. An *Import into this account…* anywhere else would invite importing a file into an account it doesn't belong to. A saved match, the account number, or the user's answer in the Account dialog, given with the file's details in view, decides. No command or service takes an account up front |
| 15 | **The Change Match dialog always offers *Unmatch*** for a matched row, proposed or accepted | Requested in review. The transaction stays as it is (proposed) or goes back to its own date, amount and status (accepted), and the bank line becomes a transaction of its own. Accepted rows reach the dialog from the row menu's *Change Match…* |
| 16 | **Matches are never accepted automatically** | Decided in review, even for exact matches. Noted as a possible future setting, off by default ([Later](#later-not-scheduled)) |

---

## Components

```
  format plugins (bundled: import-ofx, import-csv; anyone can add more)
  ──────────────
  import-ofx   contributes → import.formats { id: 'import-ofx.ofx', extensions: ['ofx','qfx'],
                                              service: 'import-ofx.format' }
               provides      import-ofx.format   (ImportFormat: sniff, parse → ParsedStatement[])
  import-csv   contributes → import.formats { id: 'import-csv.csv', extensions: ['csv','txt'], … }
               provides      import-csv.format   (asks for the column layout through its own dialog)
        │
        │ discovered and called at import time (services.get)
        ▼
  ┌────────────────────────────────────────┐   requires  ┌──────────────────────────────────────────────┐
  │ import                                 │────────────►│ accounts                                     │
  │  provides import.manager (service)     │             │  provides accounts.service                   │
  │           import.annotator             │             │  owns     accounts.reconcile.actions         │
  │           import.migrator              │ contributes │           accounts.register.annotations      │
  │  owns     import.formats               │────────────►│           (new)                              │
  │  File › Import…, account and match     │             │  register: draws the marks and buttons       │
  │  dialogs, import history               │             └──────────────▲───────────────────────────────┘
  │  ledger.schema: import.* collections   │                            │ requires
  └──────────────┬─────────────────────────┘             ┌──────────────┴───────────────────────────────┐
                 │ requires                              │ ledger (ledger.session, ledger.schema)       │
                 ▼                                       └──────────────────────────────────────────────┘
  shell: shell.files (file dialog), shell.prompts (dialogs, confirmations)
```

| Component | Kind | Provides | Requires | Owns |
|---|---|---|---|---|
| `import` | bundled plugin | `import.manager`, `import.annotator`, `import.migrator` | `accounts.service`, `ledger.session`, `shell.files`, `shell.prompts`, `app.state` | `import.formats` |
| `import-ofx` | bundled format plugin | `import-ofx.format` | | |
| `import-csv` | bundled format plugin | `import-csv.format` | `shell.prompts` | |
| `accounts` | bundled plugin (changed) | `accounts.service` (extended) | (unchanged) | `accounts.register.annotations` (new) |
| `@tessera/import-api` | package (types, constants, pure helpers) | | `@tessera/types`, `@tessera/accounts-api` | |

Format plugins depend only on `@tessera/import-api`. They don't require `import.manager`: the import manager finds
them through the extension point whenever an import runs, so activation order doesn't matter, as for reconcile
actions.

---

## The import flow

```
User: File › Import…
  │
  ├─1─ Choose files ─────── shell.files.showOpenFilesDialog, filters built from import.formats
  │
  │   for each file:
  ├─2─ Choose its format ── by extension, then sniff(); ask if still ambiguous
  ├─3─ Read and parse ───── bytes read by import; ImportFormat.parse(file, context) → ParsedStatement[]
  │
  │   for each statement:
  ├─4─ Find the account ─── saved match → account number → Account dialog (pick, create or skip); save the match
  ├─5─ Convert and check ── decimal strings → minor units in the account's currency; dates; lengths
  ├─6─ Drop duplicates ──── externalId (bank id or fingerprint) already in the account or in import.lines
  ├─7─ Match ────────────── fuzzy score against the account's open transactions; one-to-one assignment
  ├─8─ Apply ────────────── one storage transaction adds the new lines (E, externalId); matches recorded as proposals
  │
  └─9─ Report ───────────── Import summary dialog → "Review in Register" shows the first account with items to review

In the register (any time later):
  row with a proposed match:  [✓ Accept]  [⇄ Change…]      Change… includes Unmatch
  row added as new:           [✓ Accept]  [⇄ Change…]
```

Each file is independent: a file that fails to parse is reported in the summary, and the other files still import.
*Cancel* in any dialog stops the current file and every file after it. A statement already applied stays applied.

---

## Choosing files

`import.file` (*File › Import…*) builds the dialog's filters from the valid `import.formats` contributions:

```
Files of type:  [ All supported statements (*.ofx, *.qfx, *.csv, *.qif)  ▾ ]
                  All supported statements (*.ofx, *.qfx, *.csv, *.qif)
                  OFX / QFX statement (Microsoft Money, Quicken) (*.ofx, *.qfx)
                  CSV file (*.csv, *.txt)
                  QIF file (*.qif)
                  All files (*.*)
```

- The first filter combines every installed format's extensions, and it is the default, so the dialog shows only
  files the user can import. One filter per format follows, in `order` and then label order, and *All files* comes
  last.
- Several files can be chosen at once (`showOpenFilesDialog`, a new `shell.files` method).
- The dialog opens in the folder used last time (`import.lastFolder` in `app.state`, since it isn't ledger data; the plugin reaches it through `context.state` as `lastFolder`),
  or in the user's Downloads folder, where banks' statements usually land. (The shell gains `downloadsPath()`
  beside `documentsPath()`.)
- With no format installed, the command is disabled (`import.hasFormats` is false), so *Import…* is greyed out.
- Files over **25 MB** are refused with a message (`TOO_LARGE`). Bank statements are a few hundred kilobytes.

---

## Choosing a format

1. **By extension.** The formats whose `extensions` include the file's extension, ignoring case.
2. **Sniffing.** If more than one format claims the extension, or none does (the user chose *All files*), each
   candidate's optional `sniff(sample)` is asked, with the file's first 4 KB. Formats without `sniff` count as
   "maybe".
3. **Asking.** If more than one format remains, the small **Choose Format** dialog (`import.dialog.format`) lists
   them, with their descriptions. The choice applies to that file only.
4. **None.** "Tessera can't read *statement.pdf*. It can import: OFX / QFX statement, CSV file." The file is
   reported as skipped.

---

## The `import.formats` extension point

### The contribution (plain data)

```ts
// @tessera/import-api
export const IMPORT_FORMATS_POINT = 'import.formats'

export interface ImportFormatContribution {
  /** '<pluginId>.<name>', e.g. 'import-ofx.ofx'. */
  id: string
  /** The file dialog's filter name: 'OFX / QFX statement (Microsoft Money, Quicken)'. */
  label: string
  /** Without dots, lower case: ['ofx', 'qfx']. At least one. */
  extensions: string[]
  /** The service implementing `ImportFormat`, provided by the same plugin. */
  service: string
  /** One sentence for the Choose Format dialog. */
  description?: string
  /**
   * Whether the bank ids this format reports (`StatementLine.externalId`) stay the same when the same transaction
   * is downloaded again. Default true. Set false for sources known to reissue them; lines are then recognised by
   * fingerprint instead.
   */
  stableIds?: boolean
  /** Lower first in the file dialog's filters. Default 0. */
  order?: number
}
```

Contributions are validated when an import starts, and whenever the point changes (for `import.hasFormats`). The
id must start with the contributor's id. `label` and `service` must not be empty, and `extensions` must be a
non-empty list of lower-case extensions without dots. A duplicate id is also invalid. Invalid contributions are
skipped with one `[import]` warning each. A valid contribution whose service isn't provided when an import runs is
reported in the summary ("The OFX format's plugin didn't start"), not thrown.

### The service (behaviour)

```ts
// @tessera/import-api
export interface ImportFormat {
  /**
   * Optional: a cheap check that the file is in this format (a header, a magic string), given its first 4 KB.
   * Used only when the extension alone doesn't decide.
   */
  sniff?(sample: ImportSample): boolean | Promise<boolean>
  /**
   * Reads the file into statements. May ask the user (its own shell.dialogs contribution, through shell.prompts);
   * resolve undefined if the user cancels, and the file is skipped quietly. Throw ImportError('UNREADABLE', …) for a
   * file it can't read; the message is shown to the user.
   */
  parse(file: ImportFile, context: ParseContext): Promise<ParseResult | undefined>
}

export interface ImportSample {
  name: string                 // 'October.ofx'
  extension: string            // 'ofx'
  head: Uint8Array             // the first 4 KB
}

export interface ImportFile extends ImportSample {
  path: string
  size: number
  bytes: Uint8Array
  /** The bytes as text: a BOM wins, then `encoding` (default 'utf-8'; 'windows-1252' for OFX 1.x CHARSET:1252). */
  text(encoding?: string): string
}

export interface ParseContext {
  /** Aborted if the ledger closes or the user cancels the import. */
  signal: AbortSignal
  /**
   * A small key/value store for this format, kept in the ledger (a CSV column layout, say). Values must be
   * JSON-serialisable.
   */
  memory: {
    get<T>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
  }
  /** The window the import was started from, for the format's own dialogs. */
  windowId?: number
  log: Logger
}

export interface ParseResult {
  statements: ParsedStatement[]
  /** Lines or records the format skipped, shown in the summary. */
  warnings?: { message: string, line?: number }[]
}
```

### The neutral statement

```ts
// @tessera/import-api
export interface ParsedStatement {
  account: StatementAccount
  /** ISO 4217, when the file states it (OFX CURDEF). Otherwise the account's currency is assumed. */
  currency?: string
  /** The period the statement covers, when the file states it. */
  period?: { from?: string, to?: string }
  /** The ledger balance the bank reports (OFX LEDGERBAL), as a decimal string. Shown in the summary. */
  balance?: { amount: string, asOf: string }
  lines: StatementLine[]
}

/** What the file says about its account. Everything is optional: a CSV file says nothing. */
export interface StatementAccount {
  /**
   * The account's identity in this kind of source, stable from one file to the next, such as
   * 'ofx:bank:004:12345678' for an OFX bank account or 'csv:layout:9f2c…' for a CSV column layout.
   * The saved account match is keyed on it.
   */
  key?: string
  /** 'strong': the key names one account (an account number). 'weak': it only suggests one (a CSV layout). Default 'strong'. */
  keyStrength?: 'strong' | 'weak'
  /** How the file names the account, for the dialogs: 'TD Canada Trust •••• 5678'. */
  label?: string
  institution?: string          // OFX <ORG> or bank id; QIF's account name
  /** As the file gives it; may be masked ('XXXX5678'), in which case set `numberIsPartial`. */
  accountNumber?: string
  numberIsPartial?: boolean
  /** A hint for a new account (OFX ACCTTYPE / CREDITCARD). */
  type?: AccountType
  name?: string                 // QIF !Account N…
}

export interface StatementLine {
  /** YYYY-MM-DD: the date the bank posted it. */
  date: string
  /** The date the user made it, when the file gives one (OFX DTUSER). Used by matching only. */
  userDate?: string
  /**
   * A decimal string with '.' as the separator and no grouping, signed from the account's point of view: positive
   * raises its balance. '-84.12' is money out of a chequing account, or a charge on a credit card.
   */
  amount: string
  /** The bank's description: 'POS PURCHASE COSTCO WHSE #0123 OTTAWA ON'. */
  payee?: string
  memo?: string
  /** A cheque number. */
  number?: string
  /** The bank's own id for the line (OFX FITID). Absent for CSV. */
  externalId?: string
  /** What kind of line the bank says it is; used to suggest a category (fee → Bank fees). */
  kind?: 'debit' | 'credit' | 'cheque' | 'deposit' | 'payment' | 'transfer' | 'fee' | 'serviceCharge'
    | 'interest' | 'dividend' | 'atm' | 'pos' | 'directDebit' | 'other'
}
```

**Signs.** A line's amount is signed the Tessera way (positive raises the account's balance), the same for every
account type. OFX already signs amounts this way (a card charge is negative), so the OFX format passes them through.
A CSV export that shows card charges as positive needs the CSV format's *amounts are reversed* option.

**Helpers for format authors** in `@tessera/import-api`, all pure:
- `canonicalDecimal(text, { decimal: ',' | '.' })` turns `'1.234,56'` or `'(12.00)'` into `'1234.56'` and `'-12.00'`.
- `isoDate(text, order: 'YMD' | 'MDY' | 'DMY')` turns `'10/05/2026'` into `'2026-10-05'`.
- `ImportError` and `isImportError`.

---

## Finding the account

A statement goes into exactly one account. The import manager works it out from the statement, in this order, and
stops at the first step that settles it. Nothing chooses the account before the file is read: importing starts only
from *File › Import…*, and neither the command nor the `import.manager` service takes an account (decision 14).

| Step | Settles it when | Then |
|---|---|---|
| 1. A **saved account match** for `account.key` | It exists, it is set to apply without asking (`autoApply`), its account is open, and the currencies agree | Use it silently, and note "(saved match)" in the summary |
| 2. **The account number.** `accounts.list({ accountNumber })`, or `{ endsWith }` with the last 4 characters when `numberIsPartial`, narrowed by currency and, if given, institution, with closed accounts left out | Exactly one account remains | Use it, and save a strong match for the key |
| 3. **The Account dialog** | Always settles it: the user picks an account, creates one, or skips the statement | Save the match as the dialog says |

A **key** is needed to save a match. If the format gives none (a QIF file, say), the import manager makes a weak
one from the format and the file's name without digits, dates and copy suffixes: `import-qif.qif:file:checking` for
`Checking 2026-10 (2).qif`.

### The Account dialog (`import.dialog.account`)

```
┌ Which account is this statement for? ────────────────────────────────────────────────────┐
│ File        October-activity.csv · CSV file · 42 transactions, Oct 1 – Oct 31, 2026      │
│ The file    doesn't name an account (CSV files don't)                                    │
│                                                                                          │
│  (•) Chequing        TD Bank  •••• 5678   Chequing      CAD     2,700.00  Used last time │
│  ( ) Savings         TD Bank  •••• 9012   Savings       CAD    10,000.00                 │
│  ( ) Visa            TD Bank  •••• 3456   Credit card   CAD      -540.00                 │
│  ( ) US Dollar Acct  TD Bank  •••• 7788   Chequing      USD       120.00  Other currency │
│  ( ) Create a new account…                                                               │
│  [ ] Show closed accounts                                                                │
│                                                                                          │
│  [ ] Don't ask again for files with these columns; always use the chosen account         │
│                                                                                          │
│                                        [Skip This File]  [Cancel Import]  [Import]       │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

For an OFX statement, the second line reads *TD Canada Trust · account ending 5678 · chequing · CAD*, and the
checkbox reads *Remember this account for "TD Canada Trust •••• 5678"*, ticked by default.

- **The list** is every open account, ranked by how well it fits:
  1. same currency;
  2. account number ending the same;
  3. same institution;
  4. type as the file suggests;
  5. the account a weak saved match points to ("Used last time");
  6. navigator order.

  The best is chosen. Accounts in another currency are listed but can't be chosen ("Other currency"), when the
  statement states its currency. Amounts are shown Money-style, with negatives in red, through the same display
  rules as the navigator.
- **Create a new account…** closes this dialog with `{ create: true }`. The command then opens the accounts
  plugin's own **New Account** dialog (`accounts.dialog.account`), with `initial` filled in from the statement:
  - the name (the file's account name, or *institution + last 4 digits*);
  - the type;
  - the currency;
  - the institution and account number;
  - the opening date: the day before the first line;
  - the opening balance: the bank's balance less the sum of the lines up to its date, when the file has a balance,
    or zero.

  The user can change anything, and every account rule applies because it is the same form. On *Create*, the import
  carries on with the new account. On *Cancel*, this dialog comes back.
- **The checkbox** decides what is saved (decision 10):

  | Key strength | Checkbox label | Default | Saved as |
  |---|---|---|---|
  | strong (an account number) | *Remember this account for "…"* | ticked | `autoApply: true` when ticked; nothing when not |
  | weak (CSV layout, file name) | *Don't ask again for files with these columns* (or *named like this*) | not ticked | always saved with `autoApply` = the checkbox, so the dialog shows the account as "Used last time" next time |

  So for CSV files **the dialog appears for every file**, with the remembered account already chosen, and *Import*
  (Enter) confirms it. A user who has only one bank's CSV files can tick the box once and not see it again.
- **Skip This File** goes on to the next file; **Cancel Import** stops.
- A statement whose saved match points to a **closed or deleted** account, or one in a different currency, gets the
  dialog with a note ("Last time this went to *Old Chequing*, which is closed").
- A file with several statements (an OFX file with chequing and savings) shows the dialog once for each statement
  that isn't settled, titled *Statement 2 of 3*.

### Saved account matches

Saved in the ledger's `import.accountLinks` collection, one per key:

```ts
export interface AccountLink {
  id: string
  key: string                   // unique
  strength: 'strong' | 'weak'
  accountId: string
  /** Apply without asking. Always true for strong matches that were saved. */
  autoApply: boolean
  /** What the file called it, for the Saved Account Matches dialog: 'TD Canada Trust •••• 5678'. */
  label: string
  formatId: string
  createdAt: string
  lastUsedAt: string
  rev: number
}
```

*File › Saved Account Matches…* (`import.links.manage`, phase 4) lists them. Each match can be pointed at another
account, switched between *ask every time* and *don't ask*, or forgotten. When an account is deleted, its matches go
with it: the import plugin follows `accounts.onDidChange`'s `deleted`.

---

## From statement lines to transactions

### Converting and checking

Once the account is known, each line is converted and checked. A bad line is **left out with a warning**, and the
rest of the statement imports:

| Field | Rule | A line that breaks it |
|---|---|---|
| `amount` | Decimal string to minor units in the account's currency, with `parseAmount(text, currency, 'en-US')`. Trailing zeros past the currency's digits are dropped (`'-12.3400'` is fine). Any other extra digit is an error, never rounded. Zero amounts (card authorisations) are left out | Warning: "Line 14: amount 12.345 has more decimals than CAD allows" |
| `date` | A valid `YYYY-MM-DD` | Warning |
| `payee` | Whitespace collapsed; cut to `PAYEE_NAME_MAX_LENGTH` (100) | Never fails |
| `memo` | Cut to `MEMO_MAX_LENGTH` (500) | Never fails |
| `number` | Kept if at most `TRANSACTION_NUMBER_MAX_LENGTH` (20) characters; otherwise moved to the memo | Never fails |
| statement `currency` | Equal to the account's | The whole statement is refused (the dialog prevents it; this guards saved matches and callers) |

### Recognising lines imported before

Every line gets an **import id**, which becomes the transaction's `externalId`:

- **the bank's id**, `StatementLine.externalId`, when the line has one and the format's `stableIds` isn't false;
- otherwise a **fingerprint**, `fp:` followed by a SHA-256 of `date | amount | normalised payee | memo`, cut to
  16 hex digits, plus `#n` when the same values occur more than once in the file. Two identical coffees on the same
  day become `…#1` and `…#2`, in both of two overlapping exports.

A line is a **duplicate**, counted in the summary and otherwise ignored, when its import id is:
- already a transaction's `externalId` in that account (`TransactionManager.findByExternalIds`); or
- already in `import.lines` for that account. This covers a line the user deleted or chose not to import: deleting
  an imported transaction doesn't make it come back on the next import.

The fingerprint can't tell two genuinely identical same-day transactions apart across files if one file has only
one of them. Exports cover whole days, so this is rare, and the user can add the missing one by hand.

### New transactions

A line that is neither a duplicate nor matched becomes a `TransactionDraft`:

| Draft field | From |
|---|---|
| `date`, `amount`, `number`, `memo` | The line |
| `externalId` | The import id |
| `status` | `'electronic'` |
| `payee` | In order: a **payee alias** for the bank's text (learnt when the user accepted or changed a match, below); else an existing payee whose name scores at least 0.9 against the bank's text ([Payee similarity](#payee-similarity)); else the bank's text, normalised as for [payee similarity](#payee-similarity) and put in title case (`POS PURCHASE COSTCO WHSE #0123 OTTAWA ON` → `Costco Whse Ottawa`), as agreed in review |
| `categoryId` | The chosen payee's most recent category (`payees.search` gives `lastCategoryId`). Otherwise the line's `kind`: `fee` and `serviceCharge` go to *Bank fees*, and `interest` goes to *Interest* (asset) or *Interest paid* (liability), when the ledger has them. Otherwise none. A payee last used for a **transfer** gets no category: a transfer would create the other side, which an import must not do unasked |

The bank's original text is always kept in `import.lines`, and it is shown under the row while the row is being
reviewed.

---

## Matching

Matching looks for a transaction the user **already entered** that is the same real-world transaction as a
statement line. The bank and the user rarely agree exactly:

- **the date**, because the bank posts a day or three after the purchase, and a cheque clears weeks after it is
  written;
- **the amount**, because of a tip added to a restaurant bill, a fuel pre-authorisation, a foreign-exchange rate, or
  a typing slip;
- **the payee**, because `AMZN MKTP CA*2K3L91` is *Amazon* and `POS PURCHASE COSTCO WHSE #0123` is *Costco*.

Each of the three is scored from 0 to 1, and the scores are combined. A difference in one field lowers the score;
it doesn't rule the match out unless it is large.

### Candidates

For each line, the candidates are the account's transactions that:
- are **not voided** and **not reconciled** (a reconciled transaction was on an earlier statement);
- have **no `externalId`**, so they aren't already linked to a bank line;
- are **not the subject of a pending match** from an earlier import;
- have the **same sign** as the line (money in cannot match money out);
- are dated within the **date window**: from 14 days before the line's date to 3 days after. For a cheque (the line
  has a `number` equal to the transaction's number) the window starts 90 days before.

Both sides of a transfer are ordinary transactions in their own accounts, so a transfer matches like anything else.
The candidates are loaded once per statement, with `list({ from, to })` over the statement's whole window. That is a
few hundred rows, even for busy accounts.

### Scores

**Date score** `D`, from `d` = the line's date minus the transaction's date, in days. When the line has a
`userDate`, the better of the two is used.

| `d` | `D` |
|---|---|
| 0 | 1.00 |
| 1 to 3 (the bank posts after the purchase) | 0.90 |
| 4 to 7 | 0.70 |
| 8 to 14 | 0.40 |
| −1 to −3 (the user dated it later than the bank) | 0.70 |
| a cheque whose number matches, 0 to 90 | 0.60, or the row above if higher |
| anything else | not a candidate |

**Amount score** `A`, from `Δ` = |line − transaction| in minor units, and `r` = Δ / |line|:

| Difference | `A` | Typical cause |
|---|---|---|
| Δ = 0 | 1.00 | |
| r ≤ 1%, or Δ ≤ one major unit (100 cents) | 0.85 | Rounding, exchange rates |
| r ≤ 5% | 0.70 | Fuel pre-authorisation, a slip |
| r ≤ 25% | 0.45 | A tip |
| more | not a candidate | |

**Payee score** `P`, from the similarity of the line's `payee` and the transaction's payee name
([below](#payee-similarity)). Undefined when either side has no payee.

**Combined:**

```
score = 0.45·A + 0.30·D + 0.25·P            when P is defined
score = 0.60·A + 0.40·D                      when it isn't
score = min(1, score + 0.15)                 when the line's cheque number equals the transaction's number
```

A pair is **proposed** when `score ≥ 0.65` and either the amount is exact (`A = 1`) or the payees agree
(`P ≥ 0.5`). Without the second condition, two different purchases of similar amounts in the same week would match.

| Score | Shown as |
|---|---|
| ≥ 0.85 | **Matched** (info colour) |
| 0.65 to 0.85 | **Possible match** (warning colour), with the differing fields emphasised |

Worked examples (`P` as [payee similarity](#payee-similarity) computes it; `matching/score.test.ts` checks each row):

| Line (bank) | Transaction (user) | A | D | P | Score | Result |
|---|---|---|---|---|---|---|
| Oct 6, COSTCO WHSE #0123, −84.12 | Oct 5, Costco, −84.12 | 1.00 | 0.90 | 0.91 | 0.95 | Matched |
| Oct 6, COSTCO WHSE #0123, −84.12 | Oct 5, Costco, −84.00 | 0.85 | 0.90 | 0.91 | 0.88 | Matched; amount emphasised |
| Oct 3, THE KEG #12, −57.50 | Oct 3, The Keg, −50.00 | 0.45 | 1.00 | 1.00 | 0.75 | Possible match (a tip) |
| Oct 3, LOBLAWS #1001, −57.50 | Oct 3, The Keg, −50.00 | 0.45 | 1.00 | 0.00 | 0.50 | No match; added as new |
| Oct 9, (no payee), −120.00 | Oct 8, Hydro One, −120.00 | 1.00 | 0.90 | – | 0.96 | Matched |
| Nov 20, CHQ 104, −300.00 | Oct 2, Landlord, #104, −300.00 | 1.00 | 0.60 | 0.00 | 0.78 | Possible match (0.63 plus the cheque-number bonus) |

The numbers above are the **Balanced** preset, the default. Every weight, window and threshold lives in one file
(`matching/tuning.ts`), tuned against a fixture corpus of real-looking statements ([Testing](#testing)), and the user
chooses among consistent sets of them, never a single number: see [Matching tolerances](#matching-tolerances).

### Matching tolerances

How closely a line must match is the user's choice, on the Options dialog's **Import** page (Tools › Options…): one
setting, `matching` in the `import` namespace, with three **presets**. The numbers depend on one another (the date
table must cover the date window, the thresholds assume the weights, the amount tiers must widen as their scores
fall), so a preset is a whole set, and there is no field per number.

| | Strict | **Balanced** (default) | Lenient |
|---|---|---|---|
| Date window: bank after purchase / user later than bank / cheque | 7 / 2 / 60 days | 14 / 3 / 90 days | 21 / 5 / 120 days |
| `D` for 4 to 7 days / 8 to 14 / 15 to 21 | 0.60 / – / – | 0.70 / 0.40 / – | 0.75 / 0.50 / 0.30 |
| `A` tiers (ratio: score): near / far | 3%: 0.60 / 10%: 0.35 | 5%: 0.70 / 25%: 0.45 | 8%: 0.70 / 35%: 0.50 |
| Close amount: ratio, or within | 1%, or 1 major unit | 1%, or 1 major unit | 2%, or 2 major units |
| Proposed from / payees agree from | 0.75 / 0.60 | 0.65 / 0.50 | 0.60 / 0.45 |
| Shown as *Matched* from | 0.90 | 0.85 | 0.85 |
| In short | Fewer, surer proposals: no tips, a week's posting delay; more lines added as new | The tuned set | Late posting, large tips and estimates; more possible matches to check |

The weights, the cheque score and bonus, and the 1.00 / 0.90 for the same day and up to 3 days are the same in all
three.

**Consistent, defined.** `tuningProblems` in `tuning.ts` says what makes a set inconsistent, and a test holds every
preset to it: the date table covers every day of the window exactly once and nothing outside it; the same day scores
1 and no day scores better than a nearer one; the cheque window is at least the ordinary one; the amount tiers widen as
their scores fall; each set of weights sums to 1; a proposal needs less than a match.

**A ladder.** The presets are ordered: for any line and transaction, Strict's score is at most Balanced's, and
Balanced's at most Lenient's; whatever Strict proposes, Balanced does, and whatever Balanced proposes, Lenient does. A
test checks this over a grid of date gaps (a week after to four months before), amount differences (none to half
again), payees (alike, abbreviated, different, missing) and cheques.

**What each promises, on the corpus** (`matching/presets.test.ts`):

| Preset | Precision | Recall | Promise |
|---|---|---|---|
| Strict | 1.000 | 0.900 | Never less precise than Balanced; finds at least 85%. It leaves the three tips and a 4.5% fuel estimate for the user |
| Balanced | 1.000 | 1.000 | The corpus's own bar (95% each) |
| Lenient | 0.952 | 1.000 | Finds everything Balanced does; a wrong proposal is never shown as *Matched*. Its two are near-misses the corpus keeps on purpose, shown as possible matches |

A second fixture set, `tests/fixtures/import/presets/`, shows where they part ways: card purchases posted 2, 10 and 18
days late, bills the tip made 15% and 31% larger (of the bank's amount), a fuel estimate 4% short, a purchase written
down five days after the bank posted it, and cheques cashed 19, 75 and 110 days after they were written. Each line names the strictest preset that should pair it, and each
preset pairs exactly those, each with the right transaction.

**When a change takes effect.** The next import uses the preset chosen then (one preset for a whole statement, even
if the user changes it meanwhile), and so does the Change Match dialog's list. Proposals already waiting for review are
scored again in the register with the preset chosen now, so they show as *Matched* or *Possible match* by it; the
registers with such proposals are told to read their marks again. Nothing already accepted changes.

### Payee similarity

Both names are **normalised** first:
1. lower case, without accents;
2. `&` becomes `and`, and punctuation becomes spaces;
3. bank noise words are removed: `pos`, `purchase`, `debit`, `credit`, `visa`, `mc`, `interac`, `payment`, `pmt`,
   `ach`, `eft`, `online`, `www`, `com`, `inc`, `ltd`, `llc`, `the`;
4. store numbers and references are removed: any token of 3 or more digits, and `#…` tokens;
5. a trailing province or state code is removed.

If normalising leaves nothing, the text before step 3 is used.

Then `P` is the highest of these:
- **1.0** when a **payee alias** maps the bank's normalised text to the transaction's payee;
- **0.9** when every token of the shorter name appears in the longer one, or starts a token there (`costco` in
  `costco whse ottawa`; `amzn` does not start `amazon`, so the next rule takes it);
- the **Jaro–Winkler** similarity of the two normalised strings, and of their first tokens (banks truncate names:
  `amzn` against `amazon` gives 0.91), times 0.9;
- the share of the shorter name's tokens found in the longer (token-set overlap).

### Payee aliases (learning)

When the user **accepts** a match, or **chooses** a transaction in the Change dialog, and the bank's normalised payee
isn't already an exact or alias match for the transaction's payee, the import manager saves an alias in
`import.payeeAliases`: bank text (normalised) → the payee's name. The next statement with the same bank text then:
- scores `P = 1` against that payee when matching; and
- uses that payee, and through it the payee's last category, for new lines.

Aliases are per ledger. Managing them (rename or forget) is phase 4.

### One line, one transaction

Each line matches at most one transaction, and each transaction at most one line. Two identical coffees must pair
with two entries, not both with the first. Every proposed `(line, transaction)` pair is collected, sorted by score
(highest first), then by `|d|`, then by the transaction's entry order, and taken greedily, skipping pairs whose line
or transaction is already used. This is deterministic and easy to explain. The globally optimal assignment
(Hungarian algorithm) would rarely differ for statements of this size. Lines left over are added as new.

---

## Applying an import

`accounts` and `import` keep their data in separate collections of the same ledger, and a storage transaction can't
span two plugins' scoped databases. So an import is applied in steps that are **each atomic and each recoverable**:

| Step | Storage transaction | Writes |
|---|---|---|
| 1 | `import` | The batch (`state: 'applying'`) and one `import.lines` record per line that isn't a duplicate. Each record has its outcome (`added` or `matched`), its import id, the bank's original fields and, for a match, the proposed transaction and score |
| 2 | `accounts` | `transactions(accountId).createMany(drafts)`: every new line, all or nothing, with one `AccountsChange` |
| 3 | `import` | The new transactions' ids on their lines; the batch becomes `applied` |

Pending matches write nothing to `accounts` at this point (decision 5), so step 2 holds only additions.

**Recovery.** When a ledger opens, and before each import, any batch still `applying` is settled:
- if **any** of its `added` lines' import ids exist as `externalId`s in the account, step 2 committed (it is all or
  nothing), so step 3 is completed;
- if **none** do, step 2 never happened, and the batch and its lines are deleted. The next start-up or import says
  "The import of *October.ofx* was interrupted; nothing from it was added. Import the file again."

The same rule settles a review action interrupted between its `accounts` write and its `import.lines` update: a
pending line whose import id is now on its proposed transaction counts as accepted. The annotator applies the rule
when it reads, so the register never shows buttons for a match that was already applied.

**One at a time.** `import.isRunning` is set for the whole run, and *Import…* is disabled meanwhile. If the ledger
starts to close during an import, the run's `AbortSignal` fires, the current step finishes or is skipped, and the
summary reports what was done.

---

## Reviewing in the register

### What the user sees

```
┌ Chequing · TD Bank · •••• 5678                                           Current 2,586.00 · Cleared 2,720.00 ────────────┐
│ [+ New] [Edit] [Mark Cleared] [Void] [Delete]                                                      [Reconcile…]          │
│ ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ⓘ 12 imported transactions to review (2 matches, 10 new), from October.ofx          [Next ▸]  [Accept All…]          │ │
│ └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘ │
│  St Num  Date          Payee          Category            Payment   Deposit     Balance                                  │
│          Oct 1, 2026   Opening balance                                          1,000.00                                 │
│  R  101  Oct 2, 2026   Landlord       Housing : Rent     1,200.00                -200.00                                 │
│ ▌        Oct 3, 2026   The Keg        Food : Dining out     50.00                -250.00   [✓ Accept]  [⇄ Change…]       │
│ ▌   ⚠ Possible match: Oct 3 · THE KEG #12 · 57.50                                                                        │
│ ▌        Oct 5, 2026   Costco         Food : Groceries      84.00                -334.00   [✓ Accept]  [⇄ Change…]       │
│ ▌   ⇄ Matched to bank line: Oct 6 · COSTCO WHSE #0123 OTTAWA ON · 84.12                                                  │
│  E       Oct 7, 2026   Hydro One      Utilities             80.00                -414.00   [✓ Accept]  [⇄ Change…]       │
│     ★ New from the bank: HYDRO ONE NETWORKS                                                                              │
│  C       Oct 9, 2026   Employer       Salary                          3,000.00   2,586.00                                │
│ ┌ entry row ─────────────────────────────────────────────────────────────────────────────────────────────────────────┐   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **A row with a proposed match** keeps showing the user's transaction: its date, payee, category, amount and
  balance. The balance already counts the user's amount, so nothing jumps before acceptance. A **second line** under
  it shows the bank's version, with the fields that differ emphasised (`84.12` above). A bar at the row's left edge
  marks it, in the `info` colour for *Matched* and `warning` for *Possible match*. Theme tokens only, never literal
  colours.
- **The two buttons** sit at the end of the row, in a *Review* column that appears only while the account has rows
  to review:
  - **✓ Accept** applies the match (decision 9):
    - the transaction takes the bank's **date** and **amount**, where they differ;
    - the bank's id becomes its `externalId`;
    - its status becomes `E`, unless it is already `C` (a user's cleared mark is stronger than `E`);
    - the user's payee, category and memo stay.

    The tooltip says what will change: "Use the bank's date, Oct 6, and amount, 84.12, and mark it electronically
    cleared". With a new date the row moves to its place in the register, and the selection follows it. A
    transfer's other side takes the new date and amount too, because `accounts` keeps both sides of a transfer on
    one date and amount.
  - **⇄ Change…** opens the [Change Match dialog](#the-change-match-dialog-importdialogmatch), which includes
    *Unmatch*.
- **A row added as new** shows `E` and a second line, *New from the bank*, with the bank's original text. It has the
  **same two buttons** (decision 13):
  - **✓ Accept** just acknowledges it; nothing in the transaction changes.
  - **⇄ Change…** opens the same dialog. There the user can say "this is one I already entered" by choosing that
    transaction, or leave the line out.
- **Accepted rows** have no marks or buttons, and look like any other row. Their context menu has *Change Match…*,
  which opens the same dialog, so an accepted match can still be unmatched or moved.
- **The review bar** above the table counts the rows to review, says where they came from, and has:
  - **Next ▸** (also `F8`; `Shift+F8` goes back), which selects and scrolls to the next row to review;
  - **Accept All…**, which asks first ("Accept 2 matches and 10 new transactions? 2 matches change a date or an
    amount.") and then accepts every row in the account.
- **Keys**, while a row to review is selected and the table has focus: `Ctrl+Enter` runs the first button (Accept),
  and `Ctrl+Shift+Enter` the second (Change…). Both buttons are in the tab order, and the row's context menu
  lists them too.
- **Editing a row** under review is allowed. The buttons stay, and the next reload scores the match again against
  the edited transaction.
- **Reconcile mode** doesn't show annotations. The list there is about the statement being reconciled. Pending
  matches don't block a reconciliation; accepting one later sets `E` (and may change the date and amount), which a
  reconciliation in progress treats like any other edit.
- **Closed accounts** show the marks but no buttons (the account is read-only); reopening the account brings them
  back.

### The `accounts.register.annotations` extension point (new, in `accounts`)

A data-only seam that lets a plugin mark register rows and give them buttons, like `accounts.reconcile.actions` does
for menus. The register draws everything itself; the plugin supplies data and handles commands.

```ts
// @tessera/accounts-api
export const REGISTER_ANNOTATIONS_POINT = 'accounts.register.annotations'

/** Contributed as plain data. Behaviour lives in the service it names, and in the commands its actions run. */
export interface RegisterAnnotationsContribution {
  id: string                    // '<pluginId>.<name>', e.g. 'import.review'
  service: string               // implements RegisterAnnotator, e.g. 'import.annotator'
  order?: number
}

export interface RegisterAnnotator {
  /** The marks for one account's rows. Called when the register loads; must answer within 2 seconds. */
  annotate(accountId: string): Promise<AccountAnnotations>
  /** Fires when marks change for reasons accounts.onDidChange doesn't cover. */
  readonly onDidChange: Event<{ accounts: string[] }>
}

export interface AccountAnnotations {
  rows: RowAnnotation[]
  /** Shown above the table while any of `rows` has `review: true`. */
  summary?: { message: string, actions: AnnotationAction[] }
}

export interface RowAnnotation {
  transactionId: string
  /** Needs the user: counted in the review bar, visited by Next (F8), and shown with the left-edge bar. */
  review: boolean
  tone: 'info' | 'warning' | 'success'
  /** The second line under the row. Parts with `emphasis` are drawn in the tone's colour. */
  detail: { icon?: string, parts: { text: string, emphasis?: boolean }[] }
  /** At most two with placement 'button' are drawn as buttons; the rest go to the row's context menu. */
  actions: AnnotationAction[]
}

export interface AnnotationAction {
  id: string
  label: string                 // 'Accept', 'Change…'
  icon?: string                 // a shell icon name
  tooltip?: string
  placement: 'button' | 'menu'
  /** Run through shell:commands.execute with `args` as its only argument. */
  command: string
  args: unknown                 // structured-cloneable
}
```

How `accounts` handles it:
- **Validation**, as for reconcile actions: an id with the contributor's prefix, a non-empty service, no duplicates.
  Invalid contributions are skipped with one `[accounts]` warning each.
- **Loading.** The register's `accounts:register.load` reply gains `annotations`. The privileged side asks every
  contributed annotator for the account, in parallel, with a 2-second timeout each. An annotator that throws, times
  out or isn't provided is logged and left out, so **a broken plugin can't break the register**. Rows for
  transactions not in the snapshot are dropped. If two contributors mark the same row, the first (by `order`) gets
  the second line and the buttons, and the others' actions go to the row's context menu.
- **Refreshing.** `accounts` subscribes to each annotator's `onDidChange`, once the service appears: at `onStarted`,
  and again whenever the point changes. It emits `accounts:annotations.changed { accounts }`, and the register
  reloads if its account is listed, as it does for `transactions.changed`.
- **Running.** Buttons run their command with `args` through `shell:commands.execute`. An `AccountsResult`-shaped
  failure, or a thrown error, is shown in the register's notice area.
- `TransactionManager.register()` (used by reports) is unchanged. Annotations exist only in the IPC reply the view
  receives.

### What the import plugin annotates

`import.annotator` answers from `import.lines` (index `[accountId, review]`):

| Line | `review` | Tone | Second line | Buttons (command, args) | Menu |
|---|---|---|---|---|---|
| Proposed match, score ≥ 0.85 | true | info | ⇄ *Matched to bank line:* date · bank payee · amount | Accept (`import.review.accept`, `{ lineIds: [id] }`), Change… (`import.review.change`, `{ lineId }`) | |
| Proposed match, score < 0.85 | true | warning | ⚠ *Possible match:* … | Accept, Change… | |
| Added as new, not yet acknowledged | true | info | ★ *New from the bank:* bank payee | Accept, Change… (`import.review.change`) | |
| Accepted (matched or new) | false | (none; no second line) | (none) | (none) | *Change Match…* (`import.review.change`, `{ lineId }`) |

Its `summary` is the review bar's message, plus *Accept All…* (`import.review.acceptAll`, `{ accountId }`). It fires
`onDidChange` after every change to `import.lines`.

### The Change Match dialog (`import.dialog.match`)

```
┌ Change Match ────────────────────────────────────────────────────────────────────────────┐
│ Bank line   Oct 6, 2026 · COSTCO WHSE #0123 OTTAWA ON · Payment 84.12                    │
│                                                                                          │
│ Match it to:                                         [ Search payee or amount       ]    │
│   Date         Payee          Category            Amount    Differences                  │
│ (•) Oct 5      Costco         Food : Groceries     84.00    1 day earlier · 0.12 less    │ ← current proposal
│ ( ) Oct 6      Costco         Food : Groceries     91.40    7.28 more                    │
│ ( ) Sep 29     Costco Gas     Transportation…      84.12    7 days earlier · payee       │
│   [ ] Show transactions from the whole account                                           │
│                                                                                          │
│ ( ) Unmatch: keep my transaction as it is, and add the bank line as a new one            │
│ ( ) Don't import this bank line                                                          │
│                                                                                          │
│ [x] Remember that "COSTCO WHSE" is Costco                                                │
│                                                                  [Cancel]  [Apply]       │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Candidates** are listed by score. The search widens the list beyond the matching window: to ±60 days by default,
  or the whole account with the checkbox. The search box filters by payee text or amount. The differences column
  says in words what differs. Transactions already linked to another bank line, and reconciled or voided ones, are
  not listed.
- **The options**, by what the row is now. The dialog opens from *Change…* on a row to review, or from *Change
  Match…* in an accepted row's menu:

  | Choice | Proposed match | Accepted match | Row added as new (to review or accepted) |
  |---|---|---|---|
  | Another transaction | Applied at once, with the bank's date and amount: it is the user's explicit choice, so there is no second review. The first proposal is released | The first transaction is put back as it was (`unmatch`), then the chosen one is matched | `match(chosen, { replaces: addedId })`: the added transaction is deleted and the chosen one takes the bank's id, date and amount, in **one** storage transaction |
  | ***Unmatch*** | The transaction stays as it is (nothing had changed), and the bank line is added as a new transaction, already acknowledged | `unmatch(id, { restore, add })`, in **one** storage transaction: the transaction's date, amount and status go back to what they were before *Accept*, it loses the bank's id, and the bank line is added as a new transaction | (nothing is matched: the option is hidden) |
  | *Don't import this bank line* | The line is recorded as `skipped`, so it won't come back on a re-import | The transaction is put back as it was (`unmatch` without `add`), and the line recorded as `skipped` | The added transaction is deleted (after a confirmation), and the line recorded as `skipped` |

  For an accepted match the option reads *Unmatch: put my transaction back as it was (Oct 5, 84.00), and add the bank
  line as a new one*.
- **Putting back only what the match changed.** *Unmatch* restores a field only if it still holds the bank's value.
  If the user has edited the date or amount since accepting, their edit stays. The status goes back only if it is
  still `E`. The values come from the line's `before`.
- **Moving an accepted match** to another transaction takes two `accounts` calls: `unmatch`, then `match`. If the run
  stops between them, the line is left unresolved, and the review bar offers *Resolve…* (see
  [Following `accounts`](#storage-schema-import)).
- **Remember that "…" is …** saves a payee alias. It is ticked when the chosen transaction's payee differs from the
  bank's text.
- A change that reaches a **reconciled** transfer side (the date and amount are mirrored) gets `CONFIRMATION_REQUIRED` from
  `accounts`. The command asks with `shell.prompts.confirm`, then sends the request again with `confirm`, as the
  register does.

---

## Changes to `accounts`

All are additive: `ACCOUNTS_API_VERSION` 1.4.0 becomes **1.5.0**, and the schema version stays 1, because no index
or collection changes (the `uniqueExternalId` index already exists).

```ts
// @tessera/accounts-api: transactions.ts
export interface TransactionDraft {
  // …existing fields…
  /**
   * The import's identity for this bank line: the bank's id (OFX FITID) or a fingerprint ('fp:…'). Unique in the
   * account (DUPLICATE_EXTERNAL_ID); at most 255 characters. Never shown.
   */
  externalId?: string
}
// TransactionPatch follows automatically: { externalId: null } clears it.

export interface BankMatch {
  /** Becomes the transaction's externalId. */
  externalId: string
  /** The bank's date, when it differs. A transfer's other side follows, as for any date change. */
  date?: string
  /** The bank's amount, when it differs. A transfer's other side follows, as for any amount change. */
  amount?: number
  /** Default: 'electronic', unless the transaction is already cleared or reconciled, which it keeps. */
  status?: ClearingStatus
  /** A transaction added earlier for the same bank line, deleted in the same storage transaction. */
  replaces?: string
}

export interface BankUnmatch {
  /**
   * Fields to put back as they were before the match was accepted. The importer passes only those that still hold
   * the bank's values, so a later edit by the user is kept.
   */
  restore?: { date?: string, amount?: number, status?: ClearingStatus }
  /** The bank line as a new transaction, created in the same storage transaction. It takes over the externalId. */
  add?: TransactionDraft
}

export interface TransactionManager {
  // …existing methods…
  /** Creates every draft, or none (one storage transaction, one change event). */
  createMany(drafts: TransactionDraft[]): Promise<Transaction[]>
  /** Transactions in this account whose externalId is one of `ids`. */
  findByExternalIds(ids: string[]): Promise<Transaction[]>
  /** Links a bank line to an existing transaction, atomically. The usual rules apply (closed account, reconciled, rev). */
  match(id: string, match: BankMatch, options?: WriteOptions): Promise<Transaction>
  /** Takes a bank line off a transaction: clears its externalId, puts back `restore`, and creates `add`, atomically. */
  unmatch(id: string, unmatch: BankUnmatch, options?: WriteOptions): Promise<{ transaction: Transaction, added?: Transaction }>
}
```

| Addition | Notes |
|---|---|
| Error code `DUPLICATE_EXTERNAL_ID` (`field: 'externalId'`) | The storage `UNIQUE_VIOLATION` on `uniqueExternalId`, mapped as `DUPLICATE_NAME` is for names |
| `Transaction.externalId`'s comment | "The import's identity for the bank line (bank id or fingerprint)", replacing "Reserved for import" |
| `AccountDialogInput` create mode gains `initial?: Partial<AccountInput>` | Prefills the New Account form. The dialog's result (`{ id }`) is unchanged |
| `REGISTER_ANNOTATIONS_POINT`, `RegisterAnnotator` and friends; `ACCOUNTS_EVENTS.annotations` (`accounts:annotations.changed`); `annotations` in the `register.load` reply | [Above](#the-accountsregisterannotations-extension-point-new-in-accounts) |
| The register: the second line, the left-edge bar, the *Review* column, the review bar, `F8`, `Ctrl+Enter` | `Register.tsx`, a new `AnnotationLine.tsx` |

---

## Storage schema (`import`)

Contributed to `ledger.schema` as `{ id: 'import', version: 1, migrator: 'import.migrator' }`. The migrator has
nothing to seed at 0 → 1.

| Collection | Document | Indexes |
|---|---|---|
| `import.batches` | `{ id, accountId, fileName, filePath, formatId, statementIndex, importedAt, state: 'applying' \| 'applied' \| 'undone', period?, bankBalance?, counts: { lines, added, matched, duplicates, invalid, skipped } }` | `byAccount [accountId, importedAt]`; `byState [state]` |
| `import.lines` | `{ id, batchId, accountId, importId, bank: { date, amount, payee?, memo?, number?, kind? }, outcome: 'added' \| 'matched' \| 'skipped', transactionId?, proposedId?, score?, review: 'pending' \| 'done', before?: { date, amount, status }, intent?: { carrier, next } }` | unique `[accountId, importId]`; `byReview [accountId, review]`; `byTransaction [transactionId]`; `byBatch [batchId]` |
| `import.accountLinks` | `AccountLink` | unique `[key]`; `byAccount [accountId]` |
| `import.payeeAliases` | `{ id, pattern, payeeName, createdAt, uses }` (pattern is the normalised bank text) | unique `[pattern]` |
| `import.memory` | `{ id, formatId, key, value }`, for formats' `context.memory` | unique `[formatId, key]` |

- `before` records the transaction's date, amount and status before a match was accepted, so *Unmatch* (and *Undo
  Import*, phase 4) can put them back, as a reconciliation records the statuses it changes.
- Duplicates are counted in the batch, not stored as lines: the line that made them duplicates is already there.
- **Following `accounts`:** on `accounts.onDidChange`, the plugin:
  - deletes the links, lines and batches of `deleted` accounts;
  - treats as **unresolved** a pending proposal whose transaction is gone, or is now voided or reconciled, and an
    accepted match whose transaction no longer carries the line's import id (an interrupted move, above). This is
    worked out whenever the lines are read, not written, so it holds in a read-only ledger too (see
    [Phase 2 results](#phase-2-results)). The review bar shows "1 bank line lost its match" with a *Resolve…* action
    that opens the Change Match dialog. Nothing is added without the user saying so.
- `intent` is a review change in progress: written on the line before its `accounts` write, and cleared after. If the
  change is interrupted, which transaction carries the line's import id says whether the write happened.

---

## Commands, menus and context keys

| Command | Menu | Argument | Enablement |
|---|---|---|---|
| `import.file` | File › Import… (the only menu entry that imports; decision 14) | none | `ledger.isOpen && !ledger.isReadOnly && import.hasFormats && !import.isRunning` |
| `import.review.accept` | (register buttons) | `{ lineIds: string[] }` | `ledger.isOpen && !ledger.isReadOnly` |
| `import.review.acceptAll` | (review bar) | `{ accountId }` | same |
| `import.review.change` | (register buttons; *Change Match…* in an accepted row's menu) | `{ lineId }` | same |
| `import.history.show` | File › Import History (phase 4) | | `ledger.isOpen` |
| `import.links.manage` | File › Saved Account Matches… (phase 4) | | `ledger.isOpen` |
| `import.batch.undo` | (history view, phase 4) | `{ batchId }` | `ledger.isOpen && !ledger.isReadOnly` |

```
File
├── New Ledger…
├── Open Ledger…             Ctrl+O
├── Close Ledger
├── ─────────────
├── Import…                                  ← group import.file, order 5
├── Import History                           (phase 4)
├── Saved Account Matches…                   (phase 4)
├── ─────────────
├── Delete Ledger…
├── ─────────────
└── Exit
```

There is no accelerator: importing is occasional, and the register already uses `Ctrl+N` and `Ctrl+Shift+V`.

| Context key | Meaning |
|---|---|
| `import.hasFormats` | At least one valid `import.formats` contribution. Updated on `extensions.onDidChange` |
| `import.isRunning` | An import is in progress |

Dialogs (`shell.dialogs`, module in the import plugin's renderer remote):

| Id | Input → result |
|---|---|
| `import.dialog.format` | `FormatDialogInput` (`{ fileName, formats: { id, label, description? }[] }`) → `{ formatId }` |
| `import.dialog.account` | `AccountDialogInput` (the statement's facts, the ranked `AccountChoice`s, the preselection, and the checkbox's label and default by key strength) → `{ kind: 'account', accountId, remember }` \| `{ kind: 'create' }` \| `{ kind: 'skip' }`; no result = Cancel Import. `remember` is the checkbox: for a strong key it saves the match; a weak key's match is saved either way, and `remember` makes it apply without asking |
| `import.dialog.match` | `ChangeArgs` (`{ lineId }`) → `{ kind: 'match', transactionId, rememberPayee } \| { kind: 'unmatch' } \| { kind: 'skip' }` |
| `import.dialog.summary` | `ImportReport` → `{ review?: accountId }` (`SummaryDialogResult`) |
| `import.dialog.links` | (phase 4) |

---

## IPC and events

| Channel | Request → response |
|---|---|
| `import:match.candidates` | `{ lineId, query?, range?: 'window' \| 'wide' \| 'all' }` → `{ line, candidates: { transaction, payeeName, categoryLabel, score, differences: string[] }[] }` (the Change Match dialog) |
| `import:history` | → `ImportBatchSummary[]` (phase 4) |
| `import:links` | → `AccountLink[]` with account names (phase 4) |
| `import:links.update` / `.forget` | `{ id, accountId?, autoApply? }` → `Result<void>` (phase 4) |

| Event | Payload |
|---|---|
| `import:batches.changed` | `{ accounts: string[] }` |
| `import:links.changed` | `{}` |

The register needs no import IPC: it gets annotations through `accounts:register.load`, and its buttons run
commands.

---

## The `import.manager` service

Other plugins, such as a bank-connection plugin or a "watch my Downloads folder" plugin, can start imports without
going through the menu. As with *File › Import…*, neither method takes an account: the statement decides, through a
saved match, the account number or the Account dialog (decision 14).

```ts
// @tessera/import-api
export const IMPORT_MANAGER_SERVICE = 'import.manager'

export interface ImportManager {
  /** The valid formats, in filter order. */
  formats(): { id: string, label: string, extensions: string[] }[]
  /** The whole File › Import… flow for these files; asks for files when `paths` is omitted. */
  importFiles(paths?: string[]): Promise<ImportReport | undefined>
  /**
   * Imports statements a plugin already has (from a bank connection, say): account resolution, duplicates, matching
   * and review exactly as for a file. With `interactive: false`, a statement whose account can't be found without
   * asking is reported as 'needsAccount' instead of opening the dialog.
   */
  importStatements(statements: ParsedStatement[], source: { label: string, formatId?: string },
    options?: { interactive?: boolean }): Promise<ImportReport>
  readonly onDidImport: Event<ImportReport>
}

export interface ImportReport {
  results: {
    source: string                                // file name, or the caller's label
    statementIndex: number
    accountId?: string
    outcome: 'imported' | 'skipped' | 'cancelled' | 'failed' | 'needsAccount'
    counts: { lines: number, added: number, matched: number, possible: number, duplicates: number, invalid: number }
    batchId?: string
    error?: { code: ImportErrorCode, message: string }
    warnings: string[]
  }[]
}
```

Error codes (`ImportError`, tested with `isImportError`, like `AccountsError`): `NO_LEDGER`, `READ_ONLY`,
`NO_FORMAT`, `UNREADABLE`, `TOO_LARGE`, `EMPTY` (no lines), `CURRENCY_MISMATCH`, `ACCOUNT_CLOSED`, `CANCELLED`,
`BUSY` (another import is running), `NOT_FOUND` (a bank line or import a request names is gone). `toImportResult`
turns one into a `Result` for a view.

---

## Writing a format plugin

### Example: Microsoft Money's download format (OFX)

Microsoft Money downloaded statements as **OFX** (Open Financial Exchange, which Microsoft co-created), and Quicken's
QFX is OFX with extra tags. A plugin that reads them, and lets Tessera import them into the matching account, is a
manifest, one contribution and one service:

```json
{
  "id": "import-ofx",
  "name": "OFX statements",
  "version": "0.1.0",
  "privileged": { "entry": "privileged/index.js" },
  "services": { "provides": ["import-ofx.format"] }
}
```

```ts
// plugins/import-ofx/src/privileged/index.ts
import type { PluginContext } from '@tessera/types'
import {
  IMPORT_FORMATS_POINT, ImportError,
  type ImportFormat, type ImportFormatContribution, type ParsedStatement
} from '@tessera/import-api'
import { parseOfx } from './ofx'            // SGML (1.x) and XML (2.x) to a tag tree; pure, tested on its own

const FORMAT: ImportFormatContribution = {
  id: 'import-ofx.ofx',
  label: 'OFX / QFX statement (Microsoft Money, Quicken)',
  extensions: ['ofx', 'qfx'],
  service: 'import-ofx.format',
  description: 'The statement files banks offer for Microsoft Money and Quicken.'
}

const format: ImportFormat = {
  sniff: ({ head }) => /OFXHEADER|<OFX>/i.test(new TextDecoder('latin1').decode(head)),

  async parse(file) {
    const header = file.text('latin1')
    const ofx = parseOfx(file.text(/CHARSET:1252/.test(header) ? 'windows-1252' : 'utf-8'))
    if (!ofx) throw new ImportError('UNREADABLE', `${file.name} isn't an OFX statement.`)
    const statements: ParsedStatement[] = ofx.statements.map(s => ({
      account: {
        key: `ofx:${s.kind}:${s.bankId ?? ''}:${s.accountId}`,       // strong: an account number
        label: `${s.org ?? s.bankId ?? 'Account'} •••• ${s.accountId.slice(-4)}`,
        institution: s.org, accountNumber: s.accountId,
        type: s.kind === 'creditCard' ? 'creditCard' : s.accountType === 'SAVINGS' ? 'savings' : 'chequing'
      },
      currency: s.currency,
      balance: s.ledgerBalance && { amount: s.ledgerBalance.amount, asOf: s.ledgerBalance.date },
      lines: s.transactions.map(t => ({
        date: t.posted, userDate: t.user, amount: t.amount,          // OFX amounts are already signed the Tessera way
        payee: t.name ?? t.payee, memo: t.memo, number: t.checkNum,
        externalId: t.fitId, kind: kindOf(t.type)
      }))
    }))
    return { statements }
  }
}

export function activate(context: PluginContext) {
  context.subscriptions.push(
    context.extensions.contribute('import-ofx', IMPORT_FORMATS_POINT, FORMAT.id, FORMAT),
    context.services.provide('import-ofx', FORMAT.service, format)
  )
}
```

What the plugin *doesn't* do is the point: it never picks an account, never reads a file, never looks for duplicates,
and never talks to `accounts`. Install it, and *.ofx* and *.qfx* appear in the import dialog.

Guidelines for format authors (to go into [plugin-creation.md](plugin-creation.md)):
- **Give a `key`** whenever the file identifies its account, and make it stable and namespaced (`ofx:…`, `qif:…`).
  Say `keyStrength: 'weak'` when it only suggests an account.
- **Give `externalId`** when the format has bank ids, and set `stableIds: false` on the contribution if the source is
  known to reissue them.
- **Amounts are decimal strings, signed the Tessera way.** Use `canonicalDecimal` for locale-formatted numbers.
  Never pass through a JavaScript number.
- **Ask the user only through your own `shell.dialogs` contribution**, and resolve `undefined` if they cancel. Keep
  what you learn (a CSV layout) in `context.memory`.
- **`parse` must be pure apart from that**: no file access, no network. Tests feed it bytes.

### A `.mny` reader

Money's own `.mny` file is a proprietary, encrypted database. A format plugin able to read it could return one
`ParsedStatement` per account register (without a `key`, or with one built from Money's account names). The account
dialog and matching would then bring the transactions into Tessera. Categories, splits, investments and the payee
list are outside the neutral model, so a full migration stays a separate tool ([vault-design.md](vault-design.md#open-questions),
open question 6).

---

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Importers inside `accounts`** (`accounts.importers`, as vault-design.md sketched) | Simplest for the register, but it makes the largest plugin larger, with a feature many users won't use. The annotation point gives the register what it needs with a generic seam |
| **The import plugin draws its own review view** (a main-area "Downloaded transactions" list, Money-style) instead of buttons in the register | Reviewing away from the register hides the context: the surrounding entries, the running balance. The user asked for the buttons in the register. A review list can still be built later on the same data |
| **Apply matches at once; *Accept* only acknowledges** | Faster for confident matches, but a wrong fuzzy match would silently change the user's date, amount and status. Proposals cost one click, and *Accept All* exists. Accepting exact matches automatically was turned down in review (decision 16) |
| ***Import into this account…*** in the register or the navigator | Turned down in review (decision 14): it invites importing a file into an account it doesn't belong to. The account comes from the statement |
| **Format plugins write transactions themselves** | Every format would reimplement duplicates, matching and account resolution, differently |
| **Integer amounts in `StatementLine`** | The format doesn't know the currency's minor digits (CSV), and converting with floats is forbidden |
| **A custom "choose files" dialog listing statements in Downloads** | The native dialog with filters already shows only importable files, and users know it. A Downloads "inbox" is listed as later work |
| **Saved account matches in `app.state`** | They point at one ledger's account ids. In the ledger they travel with it and can't point into another ledger |
| **The Hungarian algorithm for assignment** | Optimal, but harder to explain and test, and for statement-sized inputs the greedy order almost always agrees |
| **Matching by exact amount only** (common in simple tools) | Misses tips, fuel and exchange-rate differences, which the user explicitly wants tolerated |

---

## Risks

| Risk | Mitigation |
|---|---|
| Wrong fuzzy matches | Nothing is applied without *Accept*. *Possible match* is shown in the warning colour with differences emphasised. The thresholds are tuned on a fixture corpus, and *Change…* › *Unmatch* takes a wrong match apart, even after it was accepted |
| Missed matches, which make duplicates | *Change…* on every new row merges it into the user's entry in one step, and aliases learnt from it improve the next import |
| Banks that reissue OFX FITIDs, so duplicates slip in | `stableIds: false` per format. The review step shows each new row, so a duplicate is seen. A "probable duplicate" warning (same date, amount and payee as an imported row) is later work |
| Two plugins' writes (`import` and `accounts`) can't share a storage transaction | Ordered steps, each atomic, with the recovery rule; tests cut the run between every pair of steps |
| A third-party format plugin is slow, hangs or throws | Each file's parse runs under the run's `AbortSignal`, with a 30-second limit. A throw fails that file only. Format code runs with full Node access, like every plugin, which is the framework's open "Plugin trust" item |
| Large registers make candidate loading slow | Candidates are loaded by date range through `byAccountDate`. `scale.test.ts` checks a 2,000-line statement against a 10,000-transaction account |
| CSV layouts that collide between banks | Weak keys never apply silently unless the user asks |
| Accepting moves a row to the bank's date, and a transfer's other side moves with it | The tooltip says so before *Accept*; the selection follows the row; *Unmatch* puts the date back. When the other side's own statement is imported, a difference of a few days still scores well (`D` ≥ 0.9 up to 3 days) |
| The register gets busy | The review column and bar appear only while there is something to review; accepted rows look like any other row |

---

## Decisions taken in review

Decided on 2026-11-06 and applied throughout this note. No open questions remain.

| # | Question | Decision | Where it lands |
|---|---|---|---|
| 1 | Importing as its own plugin, not part of `accounts` | Agreed | [Decision 1](#decisions) |
| 2 | A match is only a proposal until *Accept* | Agreed | Decision 5 |
| 3 | What *Accept* changes | The bank's **date and amount**; the user's payee, category and memo stay (this also answers "should the date become the bank's?") | Decision 9; [What the user sees](#what-the-user-sees); `BankMatch.date` |
| 4 | The buttons on rows added as new | The same *Accept* and *Change…* as on matches, for consistency. So new rows do need acknowledging | Decision 13; [What the import plugin annotates](#what-the-import-plugin-annotates) |
| 5 | Accepting exact matches automatically | No. Noted as a possible future setting, off by default | Decision 16; [Later](#later-not-scheduled) |
| 6 | Cleaning payees for new rows | Yes: the bank's text, normalised and in title case | [New transactions](#new-transactions) |
| 7 | Where *Import…* lives | The File menu only. Anywhere tied to an account invites importing a file into the wrong one | Decision 14; [Finding the account](#finding-the-account); [Commands](#commands-menus-and-context-keys) |
| 8 | Unmatching (requested in review) | *Unmatch* is an option in the Change Match dialog, for proposed and accepted matches | Decision 15; [The Change Match dialog](#the-change-match-dialog-importdialogmatch); `TransactionManager.unmatch` |

Smaller choices made while applying them. Each is easy to change; flag any that are wrong:

- **Unmatching a *proposed* match** leaves the transaction untouched, and adds the bank line as a new transaction
  that is already acknowledged (the user has just looked at it).
- **Unmatch puts back only what the match changed.** A field the user edited after accepting keeps their edit.
- **Accepted rows reach the Change Match dialog from their context menu** (*Change Match…*). This arrives in phase
  2 rather than phase 4, so *Unmatch* is there as soon as matches are. It replaces the separate *Undo Match* command
  planned for phase 4.
- **Accepting moves the row** to the bank's date, and the selection follows it. A transfer's other side moves too,
  because `accounts` keeps both sides on one date.
- **No command or service takes an account up front**, so `import.file` has no arguments, and the `accountId`
  options are gone from `import.manager`.

---

# Part 2: Implementation

## Ground rules

The [account manager's ground rules](account-manager-implementation.md#ground-rules) apply unchanged:
- every phase ends with a working app and a green `npm test`;
- tests mirror the source folders;
- domain logic is tested against the memory engine;
- renderer components are tested with Testing Library and the fake bridge;
- the architecture test keeps passing;
- `tsc --noEmit` adds no new errors;
- each phase ends with a manual smoke test in `npm run dev`.

Sizes: **S** is about a day, **M** a few days, **L** about a week.

Two rules specific to this feature:
- **The matcher is pure.** It takes lines and candidates and returns scored pairs and an assignment, with no
  storage or services, so it can be tested exhaustively and tuned against fixtures.
- **Every ordered write sequence has a test that stops between each pair of steps** and checks that recovery
  reaches a consistent state.

## Dependency graph

```
Phase 0 ─┬─► Phase 1 ──────► Phase 2 ──► Phase 4
(prereqs) │   (import core,     (matching     (history, undo,
          │    OFX)              and review)   saved matches)
          └─────────────────────────► Phase 3 (CSV; needs Phase 1, independent of Phase 2)
```

Phase 0's accounts work (0.3 to 0.5) and the API package (0.1) can run in parallel.

---

## Phase 0: prerequisites (M)

### 0.1 `@tessera/import-api` (S)

| Task | Files |
|---|---|
| Package `@tessera/import-api`: `IMPORT_FORMATS_POINT`, `ImportFormatContribution`, `ImportFormat`, `ImportSample`, `ImportFile`, `ParseContext`, `ParseResult`, `ParsedStatement`, `StatementAccount`, `StatementLine`, `ImportManager`, `ImportReport`, `ImportError`/`isImportError`, the ids (commands, context keys, dialogs, channels, events, services), and the pure helpers `canonicalDecimal` and `isoDate` | `packages/import-api/{index,contract,manager,errors,protocol,helpers}.ts`, `package.json` |
| Aliases like the other API packages | `tsconfig.base.json` (`paths`), `vitest.config.ts`, `scripts/build-plugins.mts` (`API_PACKAGES`, both halves) |
| Architecture test: platform-free, imports only `@tessera/types`, `@tessera/ledger-api` and `@tessera/accounts-api` | `tests/architecture/boundaries.test.ts` |
| Contract test: every id starts with `import`; helpers: `canonicalDecimal` (`'1.234,56'`, `'(12.00)'`, `'-0.5'`, garbage), `isoDate` (all three orders, invalid days, two-digit years refused) | `tests/packages/importApi.test.ts` |

#### 0.1 results

Done on 2026-11-06.

| Piece | Where | What it holds |
|---|---|---|
| The format contract | `packages/import-api/contract.ts` | `ImportFormatContribution`, `ImportFormat` (`sniff`, `parse`), `ImportSample`, `ImportFile`, `ParseContext` with `FormatMemory`, `ParseResult` and `ParseWarning`, `ParsedStatement`, `StatementAccount`, `KeyStrength`, `StatementLine`, and `STATEMENT_LINE_KINDS` |
| The manager service | `manager.ts` | `ImportManager` (`formats`, `importFiles(paths?)`, `importStatements(statements, source, { interactive })`, `onDidImport`), `ImportSource`, `ImportReport`, `StatementReport`, `StatementOutcome`, `ImportCounts`. No method takes an account (decision 14) |
| The shared model | `model.ts` (new; not in the task list) | `BankLine` (a line in minor units, with the bank's text), `AccountLink`, `MatchState` (`proposed`, `accepted`, `new`), `MatchCandidate`. Both halves of the plugin and its dialogs use them, so they belong in the contract |
| Names | `protocol.ts` | `IMPORT_PLUGIN_ID`, the point, the three services, `IMPORT_SCHEMA_VERSION`, `IMPORT_COLLECTIONS`, `IMPORT_STATE_KEYS`, `IMPORT_LIMITS`, `FINGERPRINT_PREFIX`; `IMPORT_COMMANDS` with their argument types (`AcceptArgs`, `AcceptAllArgs`, `ChangeArgs`, `UndoImportArgs`; `import.file` takes none); `IMPORT_CONTEXT_KEYS`, `IMPORT_VIEWS`; `IMPORT_DIALOGS` with every dialog's input and result type; `IMPORT_CHANNELS` and `IMPORT_EVENTS` with their payloads. Phase-4 names are included and marked, so the set is complete from the start |
| Errors | `errors.ts` | `ImportError`, `isImportError` (by shape), `ImportResult`, `toImportResult`. One code beyond the design's list: `NOT_FOUND`, for a request naming a bank line that has gone |
| Helpers | `helpers.ts` | `canonicalDecimal`, `isCanonicalDecimal` (added, so the manager and format tests can check a format's output), `isoDate` |
| Wiring | `tsconfig.base.json`, `vitest.config.ts`, `scripts/build-plugins.mts` | The alias, in both halves of the plugin build |

Decisions made on the way:

- **`canonicalDecimal` refuses irregular grouping** rather than guessing. `'12,50'` read with a decimal point is
  `undefined`, not 1250, so a CSV layout with the wrong decimal separator is caught on the first line.
  - Spaces and apostrophes between digits count as grouping, and follow the same rule.
  - Only upper-case ISO codes and the common signs are taken as currency, so `abc12` isn't an amount.
  - Negative zero becomes `0.00`.
- **`isoDate` reads numbers only**, in a stated order, with four-digit years. A time of day after the date is ignored
  without shifting the date, because banks' dates are calendar dates. Month names (`Oct 5, 2026`) are refused for
  now; the CSV format can add them if real exports need them.
- **The Account dialog's result is a tagged union** (`kind: 'account' | 'create' | 'skip'`), like the Change Match
  dialog's. It has one `remember` flag, whose meaning depends on the key's strength, instead of `remember` and
  `autoApply`. The dialog shows one checkbox, so it returns one answer.

Verification:

- `tests/packages/importApi.test.ts` (18 tests): canonical amounts with both decimal separators, every way of writing
  a negative, currency signs and codes, irregular grouping refused, garbage refused, and a round trip through
  `parseAmount` with no floating point; `isoDate` in every order, with times, leap years, impossible dates and
  two-digit years; errors by shape, and `toImportResult`.
- `tests/packages/apiPackages.test.ts`: the naming rules every API package follows, the exact command and
  context-key sets (no unmatch command, per decision 15), no clash with `accounts`' names, and the limits.
- `tests/architecture/boundaries.test.ts`: the package is platform-free and imports only `@tessera/types`,
  `@tessera/ledger-api` and `@tessera/accounts-api`.
- `tests/main/buildPlugins.test.ts`: a plugin that imports a value and a helper from the package builds, with the
  package bundled in.
- Checked that the tests can fail: disabling the grouping check fails two helper tests, and a `node:fs` import in the
  package fails the architecture test.
- `tsc --noEmit -p packages/import-api` is clean, and the tests project gains no errors.
- The full suite: 96 files. The failures are the ones that fail without this change too: four environmental ones,
  and timeouts in the accounts renderer's dialog tests (`views.test.tsx`, `reconcile.test.tsx`). Those time out
  intermittently at 5 seconds in this environment with or without the change, and a different test in them fails
  each run.

### 0.2 `shell.files` additions (S)

| Task | Files |
|---|---|
| `showOpenFilesDialog(options): Promise<string[]>` (empty when cancelled), Electron `properties: ['openFile', 'multiSelections']`; `downloadsPath()` | `tessera-types/dialogs.ts`, `shell/main/dialogs/electronFiles.ts` |
| Tests with the Electron mock: several paths, cancel → `[]`, filters passed | `tests/main/electronFiles.test.ts` |
| Guide: the new methods | `docs/plugin-creation.md` (*Asking the user*) |

#### 0.2 results

Done on 2026-11-06, as planned.

| Piece | Where | What it does |
|---|---|---|
| Contract | `tessera-types/dialogs.ts` | `ShellFiles.showOpenFilesDialog(options?): Promise<string[]>`, taking the same `FileDialogOptions` as `showOpenDialog`; `ShellFiles.downloadsPath(): string` |
| Electron adapter | `shell/main/dialogs/electronFiles.ts` | The open dialog with `properties: ['openFile', 'multiSelections']`, modal to the focused window (or the `windowId` given). It resolves `[]` whenever the dialog is cancelled, even if the platform reports paths with the cancel. `downloadsPath` is `app.getPath('downloads')` |
| Fakes | `tests/main/registerDialogs.test.ts`, `tests/plugins/ledger/{files.test,pipeline.test,harness}.ts`, `tests/plugins/accounts/pipeline.test.ts` | Every `ShellFiles` fake has the two new methods, so the type checks stay clean |
| Guide | `docs/plugin-creation.md` | The service table, and an example of choosing several statements in the downloads folder |

Verification: `tests/main/electronFiles.test.ts` (9 tests, 4 new) covers several files with the filters and labels
given, one file as a list of one, cancelling (including a cancel that reports paths), no window, the window asked
for, and the downloads folder. The ledger, accounts pipeline, dialog registration and `app.ts` suites pass with the
new fakes. `tsc` adds no errors in `shell`, `plugins` or `tests`.

**Test timeout raised to 15 seconds** (`vitest.config.ts`), in the same change:
- **The problem.** Since phase 0.1 a different test failed at Vitest's default 5 seconds on each full run, which made
  the failures look as if they were growing.
- **The cause.** A full run on this 4-core machine showed about 30 tests over 1 second, and seven over 2. The slowest
  are dialog tests typed into key by key, each keystroke re-rendering a whole MUI form in jsdom, and the pipeline
  tests on real SQLite files. One pipeline test took 8.8 seconds under load.
- **Why not a faster fix.** Typing without user-event's timers (`delay: null`) was measured and saved only about 10%.
- **Another reason to fix it here.** A timed-out test keeps typing into the next test, which was the cause of one of
  the earlier baseline failures.
- **What's left.** The slow dialog tests are recorded in todo.md.

### 0.3 `accounts`: `externalId`, `createMany`, `findByExternalIds`, `match`, `unmatch` (M)

| Task | Files |
|---|---|
| `externalId` on `TransactionDraft` (and so on `TransactionPatch`): a string of 1 to 255 characters; `DUPLICATE_EXTERNAL_ID` from the unique index; kept across edits; `{ externalId: null }` clears it | `packages/accounts-api/{transactions,errors,model}.ts`, `plugins/accounts/src/privileged/transactionsCore.ts` |
| `createMany(drafts)`: validates every draft first (errors name the draft's index in `field`, `'drafts[3].date'`), then inserts in one storage transaction; payees created once per name; one `AccountsChange` | `transactionsCore.ts`, `AccountsServiceImpl.ts` |
| `findByExternalIds(ids)` over the `uniqueExternalId` index | same |
| `match(id, BankMatch, options)`: one storage transaction that deletes `replaces` (if given; same account, not reconciled) and then updates the target's `externalId`, `date`, `amount` and `status`. The same guards as `update` (closed account, reconciled confirmation including the transfer's other side, `expectedRev`); date and amount mirrored to a transfer's other side | same |
| `unmatch(id, BankUnmatch, options)`: one storage transaction that clears `externalId`, puts back the `restore` fields, and creates `add` (which takes over the `externalId`). The same guards; date and amount mirrored to a transfer's other side | same |
| `publicService` exposes the new methods | `plugins/accounts/src/privileged/index.ts` |
| API version 1.5.0 | `packages/accounts-api/index.ts` |

Tests (`tests/plugins/accounts/transactions.test.ts`, new `import.test.ts`):
- `externalId` round-trips; a duplicate in the same account is refused, and in another account is allowed;
- `createMany` of 500 drafts is one change event; an invalid draft at index 3 adds nothing and names `drafts[3]`;
  a duplicate `externalId` inside the batch is refused;
- `match`:
  - sets the `externalId`, date, amount and status;
  - keeps `cleared`;
  - with `replaces`, deletes and updates atomically (inject a failure after the delete: nothing changed);
  - mirrors the date and amount to a transfer's other side;
  - asks for `reconciled` confirmation when that side is reconciled;
  - is refused on a closed account.
- `unmatch`:
  - clears the `externalId` and puts back only the fields given;
  - with `add`, the new transaction takes over the `externalId`, and a failure after the first write leaves nothing
    changed;
  - mirrors to a transfer's other side, with the same confirmations as `match`.

#### 0.3 results

Done on 2026-11-06, as planned, with the additions listed below.

| Piece | Where | What it does |
|---|---|---|
| Contract | `packages/accounts-api/{transactions,errors,model,rules}.ts` | `TransactionDraft.externalId` (and so `TransactionPatch`'s, where `null` clears it); `BankMatch`, `BankUnmatch`; `createMany`, `findByExternalIds`, `match`, `unmatch` on `TransactionManager`; the `DUPLICATE_EXTERNAL_ID` code; `EXTERNAL_ID_MAX_LENGTH` (255). API version 1.5.0 |
| Rules | `plugins/accounts/src/privileged/transactionsCore.ts` | `externalId` is checked exactly as given (not trimmed, not empty, no control characters), unique in the account, kept through edits, and not mirrored to a transfer's other side. The four operations are built on `createTransaction`, `updateTransaction` and `deleteTransactions`, so transfers, payees, the reconciled guard and `expectedRev` behave as for any edit |
| Service | `AccountsServiceImpl.ts` | Each operation is one storage transaction and one change event. `createMany([])` writes and announces nothing, but still checks the account |
| Errors | `store.ts`, `schema.ts` | A storage unique violation on the `uniqueExternalId` index is now `DUPLICATE_EXTERNAL_ID` on `externalId`. It used to be reported as a duplicate *name*. Schema and translation share the index name (`TRANSACTIONS_EXTERNAL_ID_INDEX`) |
| IPC | `ipc.ts` | `transaction.save` and `transaction.patch` drop `externalId`: a view can't set, change or clear a bank line's id, so an ordinary edit in the register keeps it |
| Guide | `docs/plugin-creation.md` | *Using accounts from another plugin*: the importer example uses `findByExternalIds`, `createMany`, `match` and `unmatch` |

Rules added beyond the task list, each small:
- **`replaces` must carry the same `externalId`** as the line being matched. `match` deletes it, so a mistaken id can
  only ever remove the line's own earlier transaction, never an unrelated one.
- **`match` refuses a void transaction**, and one already matched to a *different* line. Matching the same line again
  is allowed and changes nothing.
- **`match` keeps a `cleared` status**, the user's own mark, and otherwise sets `electronic`; `reconciled` can't be
  set by matching, as it can't be set by creating.
- **`unmatch`'s `add` takes over the matched transaction's `externalId`**; giving a different one is refused.
- **Errors name where they are:** `drafts[3].date` for `createMany`, `add.date` and `restore.amount` for `unmatch`,
  `replaces` for `match`.

Verification:
- **`tests/plugins/accounts/import.test.ts`** (27 tests). It covers:
  - `externalId`: it round-trips, is kept through edits, is unique per account, is validated, and stays on its own
    side of a transfer; the error translation is checked too;
  - `createMany`: 500 drafts and one event; a bad draft at index 3 adds nothing; errors only found while writing;
    duplicates in the list and in the account; one payee per name; closed accounts; an empty list;
  - `findByExternalIds`;
  - `match`: its fields and status; `replaces`, and its same-line rule; transfers; the reconciled confirmation;
    refusals;
  - `unmatch`: restoring only what is given; an exact undo with `add`; transfers; refusals.
- **Atomicity** is tested by making the second storage write fail. The tests spy on the storage collection's `replace`
  or `insertMany`, with no hooks in the code. Nothing changes and no event fires.
- **`tests/plugins/accounts/register.test.ts`** (1 new test): saving the whole row keeps the bank id, and a view can't
  set, change or clear it.
- **Checking that the tests can fail:**
  - running `match` and `unmatch` outside a storage transaction fails both atomicity tests;
  - removing the same-line rule fails its test;
  - restoring the old IPC handlers fails the register test.
- **The full suite:** 1,498 passed, and only the 4 known environmental failures, in normal and shuffled order, with no
  act failures. `tsc` adds no errors.

### 0.4 `accounts.register.annotations` (M)

| Task | Files |
|---|---|
| Contract: `REGISTER_ANNOTATIONS_POINT`, `RegisterAnnotationsContribution`, `RegisterAnnotator`, `AccountAnnotations`, `RowAnnotation`, `AnnotationAction`; `ACCOUNTS_EVENTS.annotations`; `RegisterView = RegisterSnapshot & { annotations: RegisterAnnotations }` as the `register.load` reply, already merged (see the results) | `packages/accounts-api/{annotations,protocol}.ts` |
| Reader: validate contributions (one warning each), resolve services lazily, call with a 2-second timeout, drop rows for unknown transactions, merge several contributors' marks (first by order wins the line and buttons) | `plugins/accounts/src/privileged/annotations.ts` (new), `ipc.ts` |
| Refresh: subscribe to each annotator's `onDidChange` once it is provided (at `onStarted` and on `extensions.onDidChange` for the point); emit `annotations.changed` | `annotations.ts`, `index.ts` |
| Register: left-edge bar and second line (`AnnotationLine`), the *Review* column with up to two buttons, extra actions in the row menu, the review bar with the summary's actions, *Next* (`F8`, `Shift+F8`), `Ctrl+Enter`/`Ctrl+Shift+Enter`, no buttons on closed accounts, nothing in reconcile mode; reload on `annotations.changed` | `plugins/accounts/src/renderer/register/{Register,AnnotationLine,ReviewBar}.tsx`, `useRegister.ts` |
| `@tessera/ui` 1.2.0: icons `CompareArrows` (Change/Match), `UploadFile` (Import), `Undo`, `NewReleases` (new row); component `Chip` | `tessera-ui/{index,standardIcons,version}.ts`, `tessera-ui/package.json`, `tessera-types/icons.ts`, `tests/shared/{tesseraUi,standardIcons}.test.ts` |

Tests:
- `tests/plugins/accounts/annotations.test.ts`, with a **fixture annotator plugin** activated beside `accounts`:
  - marks arrive in `register.load`;
  - invalid contributions are warned once and skipped;
  - an annotator that throws or never answers leaves the register loading normally;
  - `onDidChange` emits `annotations.changed` for the listed accounts only;
  - two contributors on one row.
- `tests/plugins/accounts/renderer/annotations.test.tsx`:
  - the second line with emphasis;
  - buttons run `shell:commands.execute` with the action's args;
  - at most two buttons, the rest in the menu;
  - the review bar counts and *Next* visits rows in order;
  - the keys;
  - closed accounts show no buttons;
  - reconcile mode shows no marks.

#### 0.4 results

Done on 2026-11-06.

| Piece | Where | What it does |
|---|---|---|
| Contract | `packages/accounts-api/annotations.ts`, `protocol.ts` | As designed: `REGISTER_ANNOTATIONS_POINT`, `RegisterAnnotationsContribution`, `RegisterAnnotator`, `AccountAnnotations`, `RowAnnotation`, `AnnotationAction`, `ANNOTATE_TIMEOUT_MS`. Also the resolved form the register draws (`ResolvedRowAnnotation`, `RegisterAnnotations`), `RegisterView`, and the `accounts:annotations.changed` event. API version 1.6.0 |
| Reader | `plugins/accounts/src/privileged/annotations.ts` | Validates contributions (one `[accounts]` warning each). Asks every annotator at once with a timeout; one that throws, is slow, isn't provided or isn't an annotator is warned once and left out. Cleans what comes back (rows for transactions not shown, and actions it can't draw or run, are dropped; an unknown tone is `info`). Merges by order |
| Following | `annotations.ts`, `index.ts` | Services announce nothing when they arrive, so subscriptions are synced at start-up, when the point changes, and when a register loads. A provider that goes or is replaced is unsubscribed |
| IPC | `ipc.ts` | `register.load` replies with the snapshot and its annotations. `TransactionManager.register()` is unchanged |
| Register | `renderer/register/{Register,AnnotationLine,ReviewBar,useRegister}` | As designed: the second line (it describes the row, through `aria-describedby`), the left-edge bar, the *Review* column with up to two buttons, the row menu, the review bar with *Next*, `F8`/`Shift+F8`, `Ctrl+Enter`/`Ctrl+Shift+Enter`, and reloads on `annotations.changed`. A closed account shows marks only, and reconcile mode none. Theme palette colours only |
| Icons | `tessera-types/icons.ts`, `tessera-ui/standardIcons.ts` | `CompareArrows`, `NewReleases`, `UploadFile`, `Undo`; `@tessera/ui` 1.2.0 |

Where it differs from the task list, and why:
- **`register.load` carries the merged result**, not each annotator's answer (`AccountAnnotations[]`). The merge
  rules (first by order draws the row, the rest go to the menu) then live in one place, the plugin, instead of in
  every view.
- **No `Chip` export.** Nothing uses it yet, and `@tessera/ui` adds exports when a view needs them.
- **Button tooltips describe their buttons** (`describeChild`). A plain MUI tooltip replaces a button's accessible
  name with its text, so *Accept* would have been announced as "Use the bank's amount…". A test found this.
- **A reply with no `annotations` is a register nobody marks.** Marks decorate the register, and must never stop it
  showing.
- **`activate(context, { annotationTimeoutMs })`**, for tests, as the ledger plugin takes `{ disk }`.

Verification:
- **`tests/plugins/accounts/annotations.test.ts`** (9 tests). The ledger and accounts are activated through the
  plugin runtime, with fixture annotator plugins. It covers:
  - marks in `register.load`, in register order, and this account's only;
  - buttons and menu split, and summaries only while something needs review;
  - cleaning sloppy answers, and two annotators on one row;
  - failing, slow, missing and wrong annotators, each warned once;
  - invalid contributions;
  - following from start-up, including a plugin that contributes before providing its service;
  - a provider going away.
- **`tests/plugins/accounts/renderer/annotations.test.tsx`** (10 tests). It covers:
  - the second line, with emphasis and description;
  - buttons and their commands, with their accessible names;
  - the row menu;
  - the review bar, its count and *Next* going round;
  - the keys;
  - notices for failures;
  - closed accounts, reloads, and reconcile mode.
- **Checking that the tests can fail:**
  - without the timeout, the slow annotator hangs the register;
  - without the start-up sync, the early annotator is never followed;
  - without the `editable` check, a closed account shows buttons;
  - without the `Ctrl+Enter` branch, Ctrl+Enter opens the row for editing;
  - without `describeChild`, the button loses its name.

**Test dependencies, fixed on the way.** Checking the new renderer code with React's types showed that a *clean*
`npm install` failed:
- the `@testing-library/dom` 9.x pinned in the earlier test clean-up clashed with jest-dom 6.10, which wants 10.x;
- MUI's optional peer pulled in React 19's types for a React 18 app.

So React Testing Library is now 16, which takes `@testing-library/dom` as a peer (`^10.4.0`, one copy for all
three), and `@types/react` and `@types/react-dom` 18.x are devDependencies. A clean plain install succeeds, with one
copy of each. `tsc -p plugins` is clean with real React types. The whole suite passes unchanged on the new versions.

### 0.5 New Account dialog with initial values (S)

| Task | Files |
|---|---|
| `AccountDialogInput` create mode accepts `initial?: Partial<AccountInput>`; the form starts from it (a liability's opening balance shown as owed) | `packages/accounts-api/protocol.ts`, `plugins/accounts/src/renderer/AccountDialog.tsx` |
| Test: every field prefilled; a liability's negative opening balance shows as an amount owed; saving still validates | `tests/plugins/accounts/renderer/accountDialog.test.tsx` |

#### 0.5 results

Done on 2026-11-06, as planned.
- **The form.** `AccountDialogInput`'s create mode takes `initial?: Partial<AccountInput>`. The form starts from it,
  over the usual blanks, through the same code that fills it for editing, so a liability's negative opening balance
  shows as the amount owed. `initial.subLedgerId`, when given, wins over the sub-ledger the dialog was opened in.
- **Checking.** Nothing is trusted: a prefilled form is checked on *Create* exactly as a typed one.
- **Bad currencies.** An amount in a currency code the runtime doesn't know is shown as given rather than crashing the
  dialog, and the currency field says what's wrong.
- **The guide.** `plugin-creation.md` shows the dialog opened with `initial`.

Verification: `accountDialog.test.tsx` has 4 new tests:
- every field prefilled;
- a card shown as owed and saved back negative;
- blanks and the sub-ledger kept;
- a bad name and currency caught, with nothing sent.

Ignoring `initial`, or removing the currency guard, fails them.

**Exit criteria:** all tests green. A throwaway fixture annotator in `npm run dev` shows a marked row with two working
buttons in a real register, in light and dark themes.

---

## Phase 1: the import plugin's core, and OFX (L)

At the end of this phase, *File › Import…* imports OFX files into the right account. It remembers the account, and
it never imports a line twice. Every line is added as new: matching comes in phase 2.

### Files

```
plugins/import/
├── manifest.json                 id "import"; requires accounts.service, ledger.session, shell.files, shell.prompts,
│                                 app.state; provides import.manager, import.annotator, import.migrator;
│                                 renderer.expose { "./FormatDialog", "./AccountDialog", "./SummaryDialog" }
└── src/
    ├── privileged/
    │   ├── index.ts              activate: wiring only
    │   ├── schema.ts             ledger.schema contribution (version 1) and the migrator
    │   ├── formats.ts            reads and validates import.formats; filters; choose by extension and sniff;
    │   │                         import.hasFormats
    │   ├── files.ts              read a file (size limit), ImportFile with text(encoding)
    │   ├── run.ts                the run: files → formats → statements → account → convert → dedupe → apply;
    │   │                         one at a time (import.isRunning); AbortSignal; the report
    │   ├── accountResolution.ts  saved match → account number → dialog; ranking; key fallback from the file name
    │   ├── links.ts              import.accountLinks: get, save, touch, delete with the account
    │   ├── convert.ts            decimal strings → minor units; line checks and warnings; fingerprints
    │   ├── apply.ts              the three steps, and recovery of 'applying' batches
    │   ├── drafts.ts             line → TransactionDraft (payee, category, kind)
    │   ├── memory.ts             context.memory over import.memory
    │   ├── commands.ts, contributions.ts, ipc.ts
    │   └── service.ts            ImportManager (importFiles, importStatements, formats, onDidImport)
    └── renderer/
        ├── FormatDialog.tsx
        ├── AccountDialog.tsx     the ranked list, Create…, Skip, the remember checkbox by key strength
        ├── SummaryDialog.tsx     per file and statement: counts, warnings, errors; "Review in Register"
        └── bridge.ts
plugins/import-ofx/
├── manifest.json                 id "import-ofx"; provides import-ofx.format
└── src/privileged/
    ├── index.ts                  the contribution and the service
    ├── sgml.ts                   OFX 1.x (SGML, unclosed tags) and 2.x (XML) into one tag tree
    └── statements.ts             BANKMSGSRSV1 / CREDITCARDMSGSRSV1 → ParsedStatement[]: key, label, type, CURDEF,
                                  LEDGERBAL, STMTTRN (DTPOSTED, DTUSER, TRNAMT, NAME/PAYEE, MEMO, CHECKNUM, FITID,
                                  TRNTYPE → kind)
```

### Tasks, in order

1. **Schema and migrator** (`import.*` collections, version 1).
2. **Formats**: validation with warnings, filters (combined, per format, *All files*), extension and sniff choice,
   `import.hasFormats` following `extensions.onDidChange`.
3. **The OFX format plugin**, test-first from fixture files: SGML with unclosed tags, XML, `CHARSET:1252`, a
   credit-card statement, two accounts in one file, missing FITIDs, and dates with time zones
   (`20261005120000[-5:EST]` → `2026-10-05`).
4. **Reading and parsing**: the size limit, `text()` decoding (BOM, UTF-8, windows-1252), the 30-second limit, and
   errors per file.
5. **Account resolution**: the three steps (no account given up front); ranking; the Account dialog; *Create a new account…* through
   `accounts.dialog.account` with `initial`; links saved by key strength; the file-name key fallback.
6. **Converting, checking and fingerprints.**
7. **Duplicates** via `findByExternalIds` and `import.lines`.
8. **Drafts**: payee (existing payee by similarity ≥ 0.9; otherwise the cleaned bank text), category from the payee's
   last use or the line's `kind`, status `electronic`. Aliases arrive in phase 2.
9. **Applying** in three steps, and **recovery** at ledger open and before each run.
10. **The summary dialog**, and *Review in Register* (`accounts.register.show { id }`).
11. **`import.manager`**: `importFiles` and `importStatements` (with `interactive: false`).
12. **Follow `accounts`**: deleting an account deletes its links, lines and batches.
13. **Menus**: *File › Import…* in group `import.file`, order 5.

### Tests (`tests/plugins/import/`, and `tests/plugins/import-ofx/`)

| File | Covers |
|---|---|
| `import-ofx/ofx.test.ts` | Each fixture file gives the expected statements: keys, signs (card charges negative), dates, kinds, FITIDs, balance; garbage throws `UNREADABLE` |
| `formats.test.ts` | Validation warnings; filter building and order; choosing by extension, by sniff, and asking when ambiguous; `hasFormats` follows the point |
| `convert.test.ts` | Minor units for CAD, JPY and BHD; trailing zeros; too many decimals warned, never rounded; zero amounts dropped; lengths; fingerprints stable across runs, with `#n` for repeats |
| `accountResolution.test.ts` | Each step in order; `endsWith` for masked numbers; currency and institution narrowing; closed accounts left out; strong and weak links; a link to a deleted or closed account falls back to the dialog with a note |
| `run.test.ts` | Against `accounts` on the memory engine, with a **fixture format plugin**: a statement adds its lines as `E` with `externalId`s; importing it again adds nothing and reports duplicates; an overlapping file adds only the new lines; a line deleted by the user isn't re-added; skip and cancel; one bad file doesn't stop the others; `BUSY` while running |
| `apply.test.ts` | Recovery, stopping after step 1 and after step 2: batch completed, or rolled back with the message |
| `drafts.test.ts` | Payee choice, category from the payee's last use, no transfer category, `kind` categories for assets and liabilities |
| `activation.test.ts` | Real `activate` beside `ledger` and `accounts`: contributions, services, menus, enablement on `ledger.isOpen`, `isReadOnly`, `hasFormats`, `isRunning` |
| `renderer/accountDialog.test.tsx` | Ranking shown; the other-currency rows disabled; Create, Skip and Cancel results; the checkbox label and default by key strength |
| `renderer/summaryDialog.test.tsx` | Counts, warnings and errors per file; *Review in Register* |

**Exit criteria (manual):** import an OFX file from a real bank. The first time, the dialog appears (unless the
account number matches), and *Create a new account…* makes one with the prefilled values. Import the same file
again: nothing is added, and the summary says why. Import next month's file: no dialog, and only the new lines.
Delete an imported transaction, import again, and it doesn't come back.

### Phase 1 results

Done on 2026-11-06. *File › Import…* imports OFX and QFX statements, 1.x and 2.x:
- it finds or asks for each statement's account, and remembers it;
- a bank line is never added twice;
- an interrupted import is put right.

Every exit criterion above is also an automated test, on the sample statements.

| Piece | Where | What it does |
|---|---|---|
| OFX format plugin | `plugins/import-ofx/` | One contribution for `.ofx` and `.qfx`: QFX is OFX plus Intuit tags, which are ignored, so it needs no plugin of its own. `sgml.ts` reads OFX 1.x (SGML, value tags never closed) and 2.x (XML) into one tree. `statements.ts` reads bank and card statements: keys, labels, types, currency, period, balance, and lines with their kinds; amounts and dates as written; a line it can't read is left out with a warning; a bank's error response is reported. The header's `CHARSET` or XML encoding decides the decoding |
| Storage | `plugins/import/src/privileged/{schema,store}.ts` | The five collections, version 1 |
| Formats | `formats.ts` | Validation (one `[import]` warning each), the dialog's filters, choosing by extension then sniff, `import.hasFormats` |
| Reading | `files.ts` | The size limit before reading; text decoding, with a byte-order mark winning, and windows-1252 decoded by the plugin itself (see *Fixes after the first Windows run*) |
| Converting | `convert.ts` | Minor units (extra digits refused unless zeros), zero amounts and bad lines left out with warnings, lengths, import ids (bank id or numbered fingerprint), a bank id repeated within a file counted once |
| Payees | `matching/payees.ts` | Normalising, tidying (accents kept), Jaro–Winkler and similarity; phase 2 reuses it |
| Accounts | `accountResolution.ts`, `links.ts` | A saved match, then the account number, then the dialog (ranking, notes, *Create…* through the accounts form with `initial`, *Skip*, *Cancel*). Matches are saved by key strength, with a key from the file name when the format gives none |
| Drafts | `drafts.ts` | An existing payee at similarity ≥ 0.9 (new ones count for the rest of the import), else the tidied text; the payee's category (none after a transfer), else one from the line's kind; `electronic`, with the import id |
| Applying | `apply.ts` | The three steps, a failed step 2 undoing step 1, and recovery at ledger open and before each import |
| The run | `run.ts`, `service.ts`, `index.ts` | One import at a time; each file on its own; *Cancel* stops; the ledger closing aborts; the parse time limit; the summary and *Review in Register*; `import.manager`; deleted accounts forgotten |
| Dialogs | `renderer/{FormatDialog,AccountDialog,SummaryDialog,display}` | As designed. Amounts are drawn as the register draws them, with theme colours only |
| Samples | `samples/statements/` | Four statements and a walkthrough (`README.md`) for trying the import by hand and for screenshots. The tests import every one. All plain ASCII |

Where it differs from the task list, and why:
- **A new accounts command, `accounts.register.open { id }`** (accounts-api 1.7.0). *Review in Register* needs to show
  an account's register by id. The existing `accounts.register.show` is enabled only while the navigator has an
  account selected, which is right for its menu item. The new command is enabled while a ledger is open, and it
  selects the account too.
- **Additions to `@tessera/import-api`:**
  - `StatementReport.accountName`, so the summary names the account;
  - `ImportReport.notices`, for the "interrupted import" message;
  - `remember` on the Account dialog's `create` result, so unticking the box is respected when creating too.
- **The payee module was built now**, in `matching/payees.ts`, because drafts and fingerprints need it. Two refinements
  on the design's rules, each found by a test:
  - token overlap is capped at 0.9 as containment is, so *Costco Whse* against *Costco* scores 0.9, as the worked
    examples say, not 1;
  - a trailing region code isn't removed after `&`, so *Johnny & Co* keeps its *Co* (`CO` is also Colorado).
- **No IPC channels or renderer bridge yet.** The dialogs get everything in their input.
- **The manifest doesn't declare `import.annotator`.** It arrives with review in phase 2, and declaring an unprovided
  service warns.
- **New lines are recorded with `review: 'pending'`**, so phase 2's register review will show them to acknowledge, as
  decision 13 wants.
- **A statement with nothing new records no batch.** There is nothing to undo.
- **Payee names follow real files.** Banks usually put the city in the memo, so `POS PURCHASE COSTCO WHSE #0123` (memo
  `OTTAWA ON`) becomes *Costco Whse*.

Verification:
- **`tests/plugins/import-ofx/ofx.test.ts`** (15 tests): every sample, including accents and QFX, and that every
  sample is plain ASCII; the edge cases (unclosed tags, bad lines, no bank ids, PAYEE aggregates, decimal commas,
  entities, windows-1252 bytes built in the test, UTF-8 and byte-order marks, a bank's error).
- **`tests/plugins/import/units.test.ts`** (20 tests): decoding, payees, converting, choosing formats, drafts, ranking
  and the new-account prefill.
- **`run.test.ts`** (20 tests). The phase's exit criteria on the samples, with the ledger, accounts, import and OFX
  plugins activated together. Also:
  - a card found by its masked number, and two statements in one file;
  - bad, missing and oversized files;
  - no format, *Cancel*, a slow format and the format question, `BUSY`;
  - the file dialog's folder and filters;
  - `importStatements`, and file-name keys.
- **`apply.test.ts`** (8 tests): the three steps; recovery after step 1 and after step 2, and at ledger open; the
  plugin's contributions; *Import…*'s enablement; the whole flow from the menu to the register.
- **`pipeline.test.ts`**: the **built** plugins on a real SQLite ledger, across two runs of the app.
- **`renderer/dialogs.test.tsx`** (10 tests): the three dialogs.
- **Checking that the tests can fail:**
  - without `import.lines` in the duplicate check, a deleted transaction comes back;
  - without recovery before a run, the interrupted import blocks the next;
  - without undoing step 1, a failed import leaves records behind.

#### Fixes after the first Windows run

Four tests failed on the first run on Windows, and a fifth once `npm install` had updated the federation plugin.
Each has a different cause:

| Failure | Cause | Fix |
|---|---|---|
| The accented payee read as `CAF DPT #204` (OFX test) and `Caf Dpt` (run test) | The windows-1252 sample's accented bytes were lost when the files were copied over. A byte that isn't valid UTF-8 doesn't survive every tool. A decoding fault would give wrong characters or `�`, not missing ones | The samples are **plain ASCII**: the accented payee is written with character references (`CAF&#201; D&#201;P&#212;T`), which the OFX parser reads. A test keeps every sample ASCII. Windows-1252 decoding is tested on bytes the test builds itself |
| The Account dialog's period: expected `Oct 1 – 31, 2026`, got `Oct 1–31, 2026` | `Intl.DateTimeFormat.formatRange` spaces the dash differently in different ICU versions | The test accepts either spacing. The dialog keeps the platform's own format |
| The import plugin didn't build (pipeline test): *Rollup failed to resolve import …/plugins/import/node_modules/\_\_mf\_\_virtual/…hostAutoInit….js* | `@module-federation/vite` before **1.16.0** keeps its virtual modules in files under each plugin's `node_modules`. It loses track of them from the **third** federated build in one process on. The import plugin is the third, after `accounts` and `ledger`, so `npm run build:plugins` and `npm run dev` fail too. The range `^1.14.2` allowed an old version, and with no lockfile an older install stays until `npm install` replaces it. Bisected over the published versions: 1.15.5 fails, 1.16.0 and later (to 1.23.0) build all three | `package.json` asks for `^1.23.0`, the version tested. `scripts/build-plugins.mts` checks the installed version before a renderer build. An older one fails with *"@module-federation/vite 1.15.5 is installed; 1.16.0 or later is needed … Run "npm install""*, not Rollup's error. Tested in `tests/main/buildPlugins.test.ts` |
| — | Found while fixing the first: **Node's `TextDecoder` reads `windows-1252` as ISO-8859-1** (Node 22.21, so Electron's main process too). Bytes 0x80–0x9F become control characters rather than `€ ‘ ’ “ ” – — …`. Banks' files use these, for example an apostrophe in *Tim Horton’s* | `files.ts` decodes windows-1252, and every label the Encoding Standard gives it (`latin1`, `iso-8859-1`, `ascii` and the rest), with its own table for 0x80–0x9F. The tests' `importFile` helper uses the same decoder, so format tests see what the import manager gives |

| `buildUiPlugins.test.ts`: *The "path" argument must be of type string* (after `npm install`) | The test looked for the federation plugin's `localSharedImportMap-…` chunk by its name's start. Newer versions name it `_virtual_mf-localSharedImportMap…-…`. It had failed here all along, with 1.23.0 installed, and was wrongly put down to this machine. Only the name changed: the chunk holds the same ranges | The test finds the chunk by `localSharedImportMap` anywhere in its name, and says which files there are when there is none |

Two timing races in the tests were found on the way, under a loaded machine. *Runs one import at a time* and
*Import…'s enablement* waited 10 ms for the first import to reach its dialog. Now they wait for the dialog itself.
*Put right as soon as its ledger opens* now polls for the recovered batch.

---

## Phase 2: matching and review (L)

### Files

```
plugins/import/src/
├── privileged/
│   ├── matching/
│   │   ├── tuning.ts        weights, windows, thresholds, noise words: the only place numbers live
│   │   ├── payees.ts        normalise, Jaro–Winkler, token containment and overlap, aliases
│   │   ├── score.ts         D, A, P, the combined score, the proposal rule, the "differences" in words
│   │   └── assign.ts        candidates from one list(); greedy one-to-one assignment; deterministic ties
│   ├── aliases.ts           import.payeeAliases: learn, look up, count uses
│   ├── annotator.ts         import.annotator: marks, second lines, buttons, summary; the self-healing rule
│   ├── review.ts            accept, accept all, change (to a transaction, to new, skip), with confirmation retry
│   └── following.ts         release proposals whose transaction was deleted, voided or reconciled (unresolved lines)
└── renderer/
    └── MatchDialog.tsx      the Change Match dialog
```

### Tasks, in order

1. **The matcher, pure and test-first**: each score table row by row, then the combined score and the proposal rule,
   then assignment (identical coffees, a line wanted by two transactions, a transaction wanted by two lines).
2. **The fixture corpus** (below), and a test that scores it and fails if precision or recall falls below the
   agreed figures.
3. **Matching in the run**: candidates loaded once per statement; `import.lines` records proposals (`outcome:
   'matched'`, `proposedId`, `score`, `review: 'pending'`); new lines `review: 'pending'` too.
4. **The annotator**, contributed to `accounts.register.annotations`. Rows to review get *Accept* and *Change…*;
   accepted imported rows get a menu-only *Change Match…*.
5. **Review commands**:
   - `accept`: `match()` with the bank's date and amount, then the line becomes `done`, recording `before` (date,
     amount, status), and an alias is learnt;
   - `acceptAll`, with its question;
   - `change`, with the dialog's outcomes for proposed, accepted and new rows:
     - another transaction: `replaces` for new rows; `unmatch` then `match` for accepted ones;
     - **Unmatch**: `createMany` for a proposal; `unmatch` with `restore` (only the fields still holding the bank's
       values) and `add` for an accepted match;
     - *Don't import*;
   - `CONFIRMATION_REQUIRED` answered through `shell.prompts.confirm`, then retried.
6. **Payee aliases**, used in matching (`P = 1`) and for new lines' payees and categories.
7. **Following `accounts`**: unresolved lines and the review bar's *Resolve…*.
8. **`import:match.candidates`** for the dialog: window, wide and all ranges, search.

### Tests

| File | Covers |
|---|---|
| `matching/score.test.ts` | Every row of the D and A tables; `userDate`; the cheque bonus and window; the payee rules; the proposal rule (exact amount, or payees agree); the worked examples from the design, exactly |
| `matching/payees.test.ts` | Normalisation (noise words, store numbers, provinces, accents, `&`); containment; Jaro–Winkler values; the empty-after-normalising fallback |
| `matching/assign.test.ts` | One-to-one; identical lines pair with identical entries in date order; ties broken the same way every run; voided, reconciled, linked and already-proposed transactions excluded |
| `matching/corpus.test.ts` | The fixture corpus, with a precision and recall report; a regression fails the suite |
| `review.test.ts` | Accept (bank date and amount, `E`, `C` kept, `externalId`, `before` recorded, alias learnt); Accept All; change to another transaction, Unmatch and skip, each for a proposed match, an accepted match and a new row; Unmatch after the user edited the accepted transaction (their edit kept); moving an accepted match interrupted between `unmatch` and `match` (the line becomes unresolved); a new row matched with `replaces`; reconciled confirmation retried; interrupted between the `accounts` write and the line update (the annotator shows no buttons, and recovery marks it done) |
| `annotator.test.ts` | Marks by line state and score; the same two buttons on matches and new rows; the menu-only *Change Match…* on accepted rows; the summary text; `onDidChange` after each review; unresolved lines |
| `renderer/matchDialog.test.tsx` | Candidates and differences; search; ranges; the options for proposed, accepted and new rows (*Unmatch* hidden for new rows, and worded for accepted ones); the alias checkbox default |
| `scale.test.ts` | 2,000 lines against 10,000 transactions: matching under 500 ms on the memory engine (recorded; skipped in CI if flaky) |

**The fixture corpus** (`tests/fixtures/import/corpus/`): a dozen pairs of "register as the user typed it" and
"statement as the bank sent it", each with the expected pairing. Together they cover:
- posting delays and cheques weeks late;
- tips, fuel pre-authorisations and exchange-rate differences;
- truncated and noisy payees (`AMZN MKTP`, `SQ *COFFEE`);
- identical same-day transactions;
- transfers, refunds (opposite sign) and missing payees;
- deliberate near-misses that must not match.

The lines are written as JSON so that they read like a table in review.

**Exit criteria (manual):** enter a week of transactions by hand, with a tip, a typo in an amount and a cheque.
Import the bank's file. The register shows *Matched* and *Possible match* rows with the bank's versions, and new rows
for what wasn't entered. Accept one, and see it move to the bank's date with the bank's amount. Change one to another
transaction, and unmatch another. Use *Change…* on a new row to match it to an entry (the duplicate disappears), and
*Accept All* the rest. Then unmatch an accepted match from its row menu: the transaction goes back to its own date and
amount, and the bank line appears as a new row. Import next month's file: the payee learnt from *Change* is used, with its
category.

### Phase 2 results

Done on 2026-11-06. An import now proposes matches for the transactions the user already entered, and adds only the
rest. The register shows what to review, with *Accept* and *Change…* on every row. The Change Match dialog moves a bank
line to another transaction, unmatches it or leaves it out, for proposed matches, accepted ones and rows added as new.
Payee aliases are learnt and used.

| Piece | Where | What it does |
|---|---|---|
| Tuning | `matching/tuning.ts` | The window, the D and A tables, the weights, the cheque bonus and the thresholds: every number the matcher uses |
| Scores | `matching/score.ts` | D (the better of the posting date and the user's date), A, P (with aliases), the combined score, the proposal rule, and the differences in words. Pure |
| Assignment | `matching/assign.ts` | The candidates rule, the statement's window, and the greedy one-to-one assignment with its tie-breaks. Pure |
| Matching in the run | `run.ts`, `apply.ts` | Candidates read once per statement (`list` over the window). Proposals recorded as `matched` lines (`proposedId`, `score`, `pending`) in step 1, with nothing written to `accounts`. `counts.matched` and `counts.possible` filled in |
| Payee aliases | `aliases.ts`, `drafts.ts` | Learnt on *Accept* and when a transaction is chosen with the box ticked; used for P = 1 and for new lines' payees and categories; uses counted |
| Where a line stands | `lineState.ts` | `settle` (an interrupted change, by its carrier) and `viewOf` (new, proposed, accepted, unresolved, skipped, gone). Pure, so the annotator can use it on a read-only ledger |
| The annotator | `annotator.ts` | `import.annotator`: second lines with the differing fields emphasised, scored again against the transaction as it is now; *Accept* and *Change…* with tooltips saying what they do; a menu-only *Change Match…* on accepted rows; the review bar's message, *Accept All…* and *Resolve…* |
| Review | `review.ts` | `import.review.accept`, `acceptAll` and `change`, one at a time; every outcome in the design's table; reconciled changes confirmed and sent again; `import:match.candidates` |
| The dialog | `renderer/MatchDialog.tsx` | As designed: the bank line, where it stands, the candidates with their differences, search (±60 days) and the whole account, *Unmatch* worded by state, *Don't import*, and *Remember that "COSTCO WHSE" is Costco* |
| The summary | `renderer/SummaryDialog.tsx` | Counts matches ("6 matched to ones already there (2 possible)"); *Review in Register* also when only matches came in |
| The register | `accounts` | The review bar also shows while an annotator has something `outstanding` that isn't a row, without *Next* |
| The corpus | `tests/fixtures/import/corpus/` | 12 cases, 40 lines, with a README on adding more |

Where it differs from the task list, and why:
- **Unresolved lines are worked out, not written.** The plan had a `following.ts` that rewrote lines when `accounts`
  changed. Instead, `lineState.ts` works out where a line stands whenever the lines are read. This is the same rule
  the design already used to heal an interrupted *Accept*. It needs no listener, can't miss a change, and works in a
  read-only ledger, where nothing can be written.
- **Every review change records its intent first.** The design had a healing rule for an interrupted *Accept* only.
  *Unmatch*, moving a match and *Don't import* can be interrupted too. So each change writes its intent on the line:
  which transaction will carry the line's import id, and what the line becomes. Then it makes its `accounts` writes,
  then settles the line by the actual carrier. Whatever stops it (a crash, a refusal, a declined confirmation), the
  carrier decides:
  - done;
  - not done;
  - half done, for a move between its `unmatch` and its `match`: then the line is unresolved.

  Lines still holding an intent are settled when a ledger opens, before each import and before each review command.
- **`accounts.register.annotations` gained `summary.outstanding`** (accounts-api **1.8.0**). A bank line that lost its
  transaction has no row to mark, and the review bar showed only while rows needed review. With `outstanding` above
  zero the bar shows, with its actions (*Resolve…*) and without *Next*.
- **Additions to `@tessera/import-api`** (**1.1.0**):
  - `MatchState` `'unresolved'`;
  - `MatchCandidate.payeeKnown`, which decides whether the *Remember that…* box shows;
  - the response's `bankName` and `restores`, for the dialog's wording;
  - the error code `REFUSED`, for a transaction that can't take the line and for `accounts` refusals.
- **A cheque's date score starts at 4 days, not 15.** With the table as written, a cheque clearing 10 days late
  scored 0.40 and one clearing 20 days late 0.60. A cheque whose number matches now scores at least 0.60 from 4 to 90
  days.
- **The worked examples' P values were estimates.** Computed, *The Keg* against *THE KEG #12* is 1.00 (score 0.75), and
  *Loblaws* against *The Keg* 0.00 (0.50). The table now has the computed values. Every result is unchanged.
- **No alias is learnt from a cheque's line.** "CHEQUE 101" names the cheque, not the payee. Learning it would point
  every later cheque at one payee.
- **A transaction proposed for another line can't be chosen.** The dialog doesn't list it, and the command refuses it:
  "Review that one first". One line, one transaction holds in the dialog too.
- **A read-only ledger shows the marks without buttons or actions.** The commands are disabled there anyway.
- **The dialog's current proposal, chosen again, is *Accept*.** It learns the payee only if the box is ticked.
- **Payee tests stayed in `units.test.ts`**, rather than a separate `matching/payees.test.ts`.
- **Matching was made fast, found by the scale test.** The first run took **37 seconds** for 2,000 lines against
  10,000 transactions. `minorDigits` builds an `Intl.NumberFormat` on every call, and amount scoring called it for every
  pair. Fixes:
  - one major unit is kept per currency;
  - payee similarity is remembered per pair of names;
  - dates are turned into day numbers once.

  Matching now takes about 400 ms in Node, and 550 ms under the test runner alone. The test measures CPU time, with a
  bound of 2 seconds, so other test files running at the same time can't fail it.

  Phase 1's drafts had the same problem: each bank text was normalised against every payee. They now normalise each
  payee once, and remember the result per bank text.

Verification:
- **`matching/score.test.ts`** (15 tests): every row of the D and A tables; `userDate`; the cheque window and bonus;
  aliases; the proposal rule; the worked examples, exactly; the differences in words.
- **`matching/assign.test.ts`** (10): the candidates rule; the window; one-to-one; a transaction wanted by two lines;
  identical coffees in order; ties the same every run; the closer date first; the cheque window; aliases.
- **`matching/corpus.test.ts`** (14): the corpus scores precision 1.000 and recall 1.000 (40 lines). The suite fails
  below 0.95 for either. Each file is also checked for well-formedness.
- **`matching/scale.test.ts`** (1): the scale figures above.
- **`review.test.ts`** (35). On the October sample, with six transactions typed first:
  - 11 added, 4 matched, 2 possible;
  - *Accept* and its `before`; `C` kept; aliases (none from cheques);
  - *Accept All* and its question;
  - every choice of the Change Match dialog for proposed, accepted and new rows;
  - *Unmatch* keeping the user's later edit;
  - the reconciled confirmation, declined and accepted;
  - an alias naming a later line's payee, with its category, and making a match;
  - unresolved lines, and resolving them;
  - a move stopped halfway;
  - changes interrupted before and after their `accounts` write, settled by a command, by the register and by the
    next import.
- **`annotator.test.ts`** (13):
  - second lines with emphasis, tones, buttons and tooltips;
  - scoring again after an edit;
  - the review bar's message as rows are reviewed, and with several imports;
  - skipped and deleted lines; read-only;
  - through `accounts:register.load`;
  - `onDidChange` and the register event.
- **`renderer/matchDialog.test.tsx`** (14): every state's options and wording; candidates and differences; search and
  the whole account; a choice kept while a search hides it; the *Remember* box's default; errors.
- **`pipeline.test.ts`**: the **built** plugins. In the second run a typed Costco is proposed, marked through the built
  accounts plugin's register, and accepted with its button. The built renderer exposes `./MatchDialog`.
- **`walkthrough.test.ts`** (1): the samples README's matching walkthrough, step by step, down to the final balance
  of 4,677.80.
- **`accounts`**: the review bar for `outstanding` (`annotations.test.ts`, renderer `annotations.test.tsx`).
- **Checking that the tests can fail:**
  - with Unmatch restoring nothing, 6 review tests fail;
  - with `settle` never applying an intent, 16 review and annotator tests fail;
  - with a transaction allowed to take two lines, 8 fail, and the corpus drops to precision 0.927.

**Not yet done: the manual exit criteria.** There is no display in the environment this was built in. The walkthrough
in [samples/statements/README.md](../samples/statements/README.md#matching-and-review) covers them on the samples,
and `walkthrough.test.ts` checks that what it says is true. The look of the rows and the dialog, in light and dark
themes, still needs a person.

---

## Phase 3: CSV (M)

CSV is the format with no account identity and no line ids, which is why this note gives it so much care. It depends
on phase 1 only.

### Files

```
plugins/import-csv/
├── manifest.json                 id "import-csv"; requires shell.prompts; provides import-csv.format;
│                                 renderer.expose { "./LayoutDialog" }
└── src/
    ├── privileged/
    │   ├── index.ts              the contribution ({ extensions: ['csv', 'txt'] }) and the service
    │   ├── csv.ts                RFC 4180 rows: quotes, embedded newlines, ',' ';' and tab delimiters (detected)
    │   ├── layout.ts             Layout: header row?, columns for date, amount | debit + credit, payee, memo,
    │   │                         number; date order; decimal separator; "amounts are reversed"
    │   │                         guessLayout(rows) from header names (Date, Description, Withdrawals, Deposits…)
    │   └── parse.ts              rows + layout → one ParsedStatement; key 'csv:layout:<hash of the header row>',
    │                             keyStrength 'weak'; no externalIds (fingerprints are used)
    └── renderer/
        └── LayoutDialog.tsx      a preview of the first rows, a column-role picker per column, the options, and a
                                  live preview of the resulting lines
```

### Tasks

1. **`csv.ts`** against hostile input: quotes, BOMs, `\r\n`, a trailing empty line, ragged rows.
2. **`guessLayout`** from common bank headers, in English and French at first.
3. **The layout dialog**, shown when no layout is remembered for this header signature (`context.memory`), or when
   the remembered one fails on this file. The user confirms or corrects it, and it is remembered.
4. **`parse`**: one statement, a weak key from the header row, `label` "CSV file with columns Date, Description,
   Amount", and warnings for rows that don't fit the layout.

### Tests

| File | Covers |
|---|---|
| `import-csv/csv.test.ts` | The parser's edge cases; delimiter detection |
| `import-csv/layout.test.ts` | Guessing for a set of real bank header rows; debit/credit columns; reversed signs; day-month-year dates; comma decimals |
| `import-csv/parse.test.ts` | Rows to lines; the weak key is stable for the same header and differs for a different one; warnings |
| `import-csv/renderer/layoutDialog.test.tsx` | Picking roles; the preview follows; invalid layouts can't be saved |
| `import/run.test.ts` (extended) | A CSV import always shows the Account dialog, with the last account chosen; *Don't ask again* makes the next one silent; overlapping CSV exports add nothing twice (fingerprints) |

**Exit criteria (manual):** import two monthly CSV exports from a real bank, with one overlapping week. The layout is
asked for once. The Account dialog appears each time with the account chosen. The overlapping week isn't doubled.

---

## Phase 4: history, undo and saved matches (M)

| Piece | What it does |
|---|---|
| **Import History** view (`import.history`, `shell.main`, `when: ledger.isOpen`; *File › Import History*) | Every batch: date, file, format, account, and counts (added, matched, to review, skipped, duplicates, invalid). Selecting one lists its lines and their outcomes. *Show in Register* and *Undo Import…* |
| **Undo Import** (`import.batch.undo`) | One confirmation ("Remove 30 added transactions and undo 9 matches in Chequing?"), then: added transactions deleted (one `delete` call); accepted matches put back from `before` (`unmatch` without `add`); the lines deleted and the batch marked `undone`. Refused, with a list, if any of them has since been reconciled |
| **Saved Account Matches** dialog (`import.links.manage`) | The links: change the account, switch *ask every time*, forget. Payee aliases on a second tab: rename the payee, forget |
| **Navigator badges** | An optional `RegisterAnnotator.counts()` giving review counts per account; the navigator shows a small count beside each account with rows to review (a new `Badge` export in `@tessera/ui`) |

Tests: undo in every combination (added, matched, accepted, pending, reconciled since); link edits applied
on the next import; badges follow reviews.

---

## Later (not scheduled)

| Item | Notes |
|---|---|
| QIF format plugin | `!Type:Bank`, `!Type:CCard`, `!Account` blocks, date formats; no ids, so fingerprints |
| Reconcile with the imported statement | A `accounts.reconcile.actions` contribution (*Reconcile with Downloaded Statement…*) that begins a reconciliation with the batch's period and bank balance, and marks the lines it matched or added |
| Auto-accept exact matches | Turned down for now in review (decision 16). A possible future setting, off by default |
| Transfer detection | A new line in one account that mirrors one in another becomes a transfer pair, with the user's approval |
| A Downloads "inbox" | Watch the Downloads folder for files the formats can read, and offer to import them |
| Drag and drop | Drop files on the window to import them (needs a shell facility for file drops) |
| Settings page, more | The matching presets are done ([Matching tolerances](#matching-tolerances)); the default folder, and auto-accept if it is ever wanted, could join them |
| Probable-duplicate warning | For sources that reissue ids: same date, amount and payee as an imported row |
| `.mny` reader | See [A `.mny` reader](#a-mny-reader) |
| Bank connections | A plugin calling `import.manager.importStatements` |

---

## Testing

Besides the tables above:
- **Fixture plugins**: `tests/fixtures/plugins/import-fixture-format` (a format that returns whatever a test gives it)
  and `tests/fixtures/plugins/annotator-fixture` (for phase 0.4). They are activated through `createPluginRuntime`,
  as the accounts tests do.
- **Fixture files**: `tests/fixtures/import/{ofx,csv,corpus}/`, anonymised real statements plus hand-made edge cases.
  No real account numbers.
- **The pipeline smoke test** (`tests/plugins/pipeline.smoke.test.ts`) gains a case: the built `import` and
  `import-ofx` bundles activate with the rest and contribute what they should.
- **Manual checks in `npm run dev`**, in light and dark themes. Use a fresh `--user-data-dir` so `import.lastFolder`
  starts empty.

---

## Documentation changes, alongside the phases

| When | Change |
|---|---|
| Phase 0 | `plugin-creation.md`: `showOpenFilesDialog` and `downloadsPath`; `externalId`, `createMany`, `match` and `unmatch` in *Using accounts from another plugin* (replacing "An `externalId` on drafts … is still planned"); a new section *Marking register rows* for `accounts.register.annotations`. `account-manager-design.md`: the `accounts.service` additions and the annotation point in *IPC and events* and *Register UI* |
| Phase 1 | `plugin-creation.md`: a new section *Adding an import format*, from [Writing a format plugin](#writing-a-format-plugin). `README.md`: *Import* under *What works today*, and `import`/`import-ofx` in *Project layout*. `vault-design.md`: its importer section points here |
| Each phase | Tick it in `todo.md`; record the results and any departures from this note in a *Phase N results* section here, as the other notes do |

## Definition of done (every phase)

- [ ] `npm test` green, including the architecture boundaries
- [ ] No new errors from `npx tsc --noEmit -p plugins` (and `-p shell`, `-p tests` when touched)
- [ ] Every disposable pushed onto `context.subscriptions`
- [ ] The phase's manual checklist done in `npm run dev`, in light and dark themes
- [ ] Docs updated as listed above

## Phases

| Phase | Delivers | Size |
|---|---|---|
| 0 | `@tessera/import-api`; `shell.files` multi-select and Downloads; `accounts`: `externalId`, `createMany`, `findByExternalIds`, `match`, `unmatch`, `accounts.register.annotations` and its register UI, New Account with initial values; `@tessera/ui` 1.2 | M |
| 1 | The `import` plugin: *File › Import…*, formats, reading, account resolution with saved matches and the Account dialog, duplicates, adding lines, recovery, summary, `import.manager`; the `import-ofx` format plugin | L |
| 2 | Fuzzy matching, proposals, *Accept* / *Change…* on every row to review, *Accept All*, the Change Match dialog with *Unmatch* (also for accepted rows, from the row menu), payee aliases | L |
| 3 | The `import-csv` format plugin: layout guessing and dialog, weak keys, fingerprints | M |
| 4 | Import history, undo import, the Saved Account Matches dialog, navigator badges | M |
