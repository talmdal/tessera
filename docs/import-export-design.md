# Design note: import and export

| | |
|---|---|
| **Status** | **Phases 1, 2, 3 and S done; phase 3 redesigned 2026-11-18** — the contracts, the `exchange.formats` point, the four-tier matcher, account resolution, batches and undo, the IPC, and the `accounts` prerequisites. Phase S: the seeded **Household** book and its statement fixtures ([The seeded book](#the-seeded-book)). Phase 2: `exchange-ofx` reads OFX, QFX and QBO, in both syntaxes ([Phase 2 results](#phase-2-results)). Phase 3 as first built — a standalone review screen with an in-memory plan — **was replaced by the Money-style flow**: importing *files* each statement against an account as a persisted *statement to read*, and the review happens **in the account's register itself**, row by row, with Accept and Change… on the focused row. See [Phase 3 revision: review in the register](#phase-3-revision-review-in-the-register), which supersedes [The import review view](#the-import-review-view) and [Phase 3 results](#phase-3-results). **Phase A, the anonymiser, built 2026-11-18** for the OFX family and CSV, and the first seven real-bank fixtures anonymised with it ([Phase A results](#phase-a-results)); the seed also writes QIF in both dialects now. **Phase 4, QIF, built 2026-11-18**: `exchange-qif` reads both dialects and both forms and writes both flavours; a multi-account file can become a new book ([Phase 4 results](#phase-4-results)). No CSV reader yet, and no export UI: phase 5. Review decisions applied 2026-11-16; see [Decisions taken in review](#decisions-taken-in-review) |
| **Date** | 2026-11-16 |
| **Scope** | Reading a statement or a whole data file into a book (OFX, QFX, QBO, QIF in two dialects, and CSV), matching it against what the book already holds, reviewing it and applying it; writing an account, a sub-book or a book back out again; and the script that turns a real bank file into a fixture safe to commit |
| **Builds on** | [account-manager-design.md](account-manager-design.md) (`accounts.service`, the register, `externalId`, the `uniqueExternalId` index), [storage-engine-redesign.md](storage-engine-redesign.md) (collections, indexes, transactions), [options-framework-design.md](options-framework-design.md) (`context.options`), [layout-controller-design.md](layout-controller-design.md), [plugin-creation.md](plugin-creation.md) |
| **Delivers** | Four bundled plugins — `exchange` and `exchange-ofx` (built), `exchange-qif`, `exchange-csv` — their shared contract package `@tessera/exchange-api` (built), three small additions to `accounts` (two built), and `scripts/anonymize-statement.mts` |

- [Summary](#summary)
- [Naming](#naming)
- [A note on QBX](#a-note-on-qbx)
- [Context](#context)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- [Components](#components)
- [The neutral model](#the-neutral-model)
- [The format seam](#the-format-seam)
- [OFX, QFX and QBO](#ofx-qfx-and-qbo)
- [QIF, and its two dialects](#qif-and-its-two-dialects)
- [CSV](#csv)
- [Resolving the account](#resolving-the-account)
- [Currencies](#currencies)
- [Matching: duplicates, merges and new rows](#matching-duplicates-merges-and-new-rows)
- [Payee rules](#payee-rules)
- [Applying, and undoing](#applying-and-undoing)
- [Export](#export)
- [`exchange.service`](#exchangeservice)
- [Storage schema (`exchange`)](#storage-schema-exchange)
- [The import review view](#the-import-review-view)
- [The export dialog](#the-export-dialog)
- [Options](#options)
- [Commands, menus and context keys](#commands-menus-and-context-keys)
- [IPC and events](#ipc-and-events)
- [Changes to `accounts`](#changes-to-accounts)
- [Importing into a book with an archived period](#importing-into-a-book-with-an-archived-period)
- [The anonymiser: `scripts/anonymize-statement.mts`](#the-anonymiser-scriptsanonymize-statementmts)
- [Keeping personal data out of the repository](#keeping-personal-data-out-of-the-repository)
- [The seeded book](#the-seeded-book)
- [Alternatives considered](#alternatives-considered)
- [Risks](#risks)
- [Decisions taken in review](#decisions-taken-in-review)
- [Phases](#phases)
- [Phase 1 results](#phase-1-results)
- [Phase 2 results](#phase-2-results)
- [Phase 3 results](#phase-3-results)
- [Phase A results](#phase-a-results)
- [Phase 4 results](#phase-4-results)

## Summary

- **One pipeline, five formats.** Every import is the same five steps —
  *read, resolve, match, review, apply* — and a format plugin only takes part
  in the first. It turns bytes into an `ExchangeDocument` and knows nothing
  about books, accounts, duplicates or the register.
- **The `exchange` plugin owns the pipeline**, the review view, the import
  history and the export side. It is a new bundled plugin with its own
  service, schema and contract package, in the shape `recurring` already
  established. Formats arrive as further plugins — `exchange-ofx`,
  `exchange-qif`, `exchange-csv` — each contributing descriptors to
  **`exchange.formats`** and providing its reader and writer as a service.
- **OFX, QFX and QBO are one format with three faces.** All three are OFX:
  QFX and QBO are OFX files carrying Intuit's extension tags. One plugin
  reads all three, one parser handles both the SGML (1.x) and XML (2.x)
  syntaxes, and the dialect only changes sniffing, a few tag quirks and the
  file filter the dialog shows.
- **QIF is read in two dialects, and the reader detects which.** *Standard*
  QIF truncates payee, category and memo text to fifteen characters;
  the *Microsoft* dialect does not. The reader scans the file first: any
  `P`, `L` or `M` field longer than fifteen characters settles it as
  Microsoft; otherwise the file is ambiguous and the user is asked, with the
  answer defaulting from an option. The dialect also decides the date
  reading and how a split category is split from its class.
- **Nothing is written until the user has accepted it, row by row.** The
  review view shows one row per incoming transaction with a *disposition* —
  **New**, **Duplicate**, or **Matches** an existing row — and two buttons.
  **Accept** confirms the matcher's decision, whether it found a match or
  not, and the resulting transaction is marked `E` (electronic: the bank has
  reported it). **Change…** opens a dialog listing every transaction in the
  account, so the user can match a row by hand, or detach a match the
  matcher made; choosing a match does not accept it. Only accepted rows are
  written, and the whole batch goes in **one storage transaction**.
- **The statement is the source of truth.** It is what happened at the bank,
  so an accepted match takes the statement's date, amount and payee (the
  payee after the payee rules and any edit in the review); the user's
  category and splits are kept. A recurring schedule whose last entered
  transaction is renamed this way is offered the new name, quietly, on its
  row in the Recurring view — an info mark on the row and a one-button
  suggestion under the list when it is selected; nothing changes unless the
  user takes it.
- **A statement for an account the book does not have** asks, before the
  review opens, whether to create it. *Create Account…* opens the New
  Account dialog filled in from the statement — its number, the bank,
  currency, and the opening balance that leaves the account at the bank's
  balance once imported — and the import goes into the new account.
  *Choose Existing* leaves it to the review's account picker, which also
  offers *New Account…*.
- **Duplicates are caught three ways, and overridden by a fourth:** the
  bank's own id (`FITID` → `Transaction.externalId`, which already has a
  unique index per account); a near match on date and amount for formats
  that carry no id; a *merge* against an uncleared transaction the user
  typed by hand, which adopts the bank's id rather than entering it twice;
  and the user's own choice through **Change…**, which always wins.
- **Import does not start a reconciliation.** They are separate decisions
  taken at separate times, and matching a statement to the register is work
  the review view does in its own right.
- **An import can be undone.** Each one writes an `ImportBatch` recording
  exactly which transactions it created and which it merged into, so *Undo
  Import* can take it back out, refusing — or asking — where a row has since
  been reconciled.
- **Export writes OFX 2.x, QIF and CSV; it does not write QFX or QBO.**
  Those two are defined by an identifier Intuit issues to a financial
  institution, and Tessera is not one. Reading them is unambiguous and
  useful; writing them would mean forging a provenance the file claims to
  have.
- **OFX is written as 2.x only, and the version is not an option.** 1.x is
  SGML with unclosed tags and a code-page header — a second write path whose
  only customer is software old enough to refuse 2.x. That software is also
  exactly the software that wants QIF, which Tessera already writes, so the
  case 1.x would serve is already served. Reading, by contrast, accepts both:
  a reader's job is to be forgiving and a writer's is to be unambiguous.
- **A real statement never reaches the repository.** `npm run anonymize`
  parses a live file, rewrites every field under a *default-deny* policy —
  anything the tool does not recognise is dropped, never passed through —
  re-derives the balances so the result is still internally consistent, then
  **re-reads its own output and fails the run** if any value from the input
  survives in it. Only then is the file fit to be a test fixture.

## Naming

The plugin is **`exchange`**, not `import` or `importers`. Three reasons:

- `import` is a reserved word in JavaScript, which makes it a poor plugin id
  to live alongside identifiers in generated code and awkward in every
  `import { … } from '@tessera/import-api'` line;
- the feature is symmetric, and a name that says only half of it will be
  wrong as soon as export lands;
- *exchange* is the word the formats themselves use — OFX is the Open
  Financial Exchange, and its successor is the Financial Data Exchange.

Elsewhere this note uses the user's words, not the format's: a file is a
**statement** when it came from a bank, the thing being read is a
**document**, a run of the pipeline is an **import**, and what it records is
a **batch**.

## A note on QBX

The scope names *QBX (Quicken)*. `.QBX` is a QuickBooks **Accountant's Copy
Transfer File** — a proprietary, compressed snapshot of a whole company file,
not a statement, and not a Quicken format at all. The Quicken format meant
here is almost certainly **`.QFX`** (Quicken Web Connect), which sits
alongside `.QBO` (QuickBooks Web Connect) as the other Intuit-branded OFX
file.

This note therefore supports **`.qfx`**, and treats `.qbx` as out of scope.
If a genuine `.qbx` is wanted later it is a separate piece of work with
nothing in common with the rest of this design: a different plugin, a
different parser, and an open question about whether the container can be
read at all. Should it turn out that `.qbx` really was meant, the format seam
below is exactly where it would attach, and nothing else in this note
changes.

## Context

Microsoft Money users arrive with two expectations, and both have to be met
before Tessera can replace it:

1. **Download and import.** Their bank offers a file — `.ofx`, `.qfx`,
   `.qbo`, `.qif` or `.csv` — and they expect to feed it to Tessera
   repeatedly, month after month, without accumulating a single duplicate.
2. **Get their data back out.** A user will not commit years of records to a
   program that cannot export them. Export is not a feature for later; it is
   the condition on which the rest is trusted.

What the framework already provides:

- `accounts.service` with `AccountFilter.accountNumber: { endsWith }` —
  written for exactly the moment a statement shows only the last four digits
  of the account;
- `Transaction.externalId`, already documented as "the bank's id for this
  transaction (OFX FITID)", with a unique `(accountId, externalId)` index in
  the accounts schema. Duplicate suppression is therefore enforced by
  storage, not only by the importer's good behaviour;
- multi-document storage transactions, so a batch is all-or-nothing;
- `shell.files` for the open and save dialogs, `shell.dialogs` for the
  mapping dialogs, and `shell.views` plus the layout controller for the
  review view;
- `context.options`, for the preferences this feature accumulates.

What is missing, and has to be built first, is small and listed under
[Changes to `accounts`](#changes-to-accounts): `externalId` on a draft, a
bulk create, and the status a bank-reported row should carry.

## Goals and non-goals

**Goals**

- Import bank transactions from OFX, QFX, QBO, QIF (both dialects) and CSV.
- Import a **whole-book QIF** — the `!Account` form, with several accounts,
  the category list and transfers between accounts — not only a single
  statement. **This is the migration path off Microsoft Money**: Money's
  `.mny` is a private format, so a Money user exports Microsoft-dialect QIF
  and imports it here. The Microsoft QIF reader is therefore not a
  convenience, it is how users arrive.
- Never create a duplicate when the same file is imported twice, and never
  create a second copy of a transaction the user already typed by hand.
- Let the user **match by hand** whatever the matcher did not get right,
  without leaving the review and without writing anything first.
- Show everything before writing anything, and make the result reversible.
- Export an account, a sub-book or the whole book to OFX 2.x, QIF or CSV,
  over a date range.
- Keep the format seam real: adding a sixth format means adding a plugin,
  with no edit to `exchange` or `accounts`.
- Give the repository a trustworthy way to turn a real statement into a test
  fixture.

**Non-goals, for now**

- **Investment transactions.** OFX `INVSTMTRS` and QIF `!Type:Invst` carry
  buys, sells, dividends and share quantities. Tessera has no security model
  yet, so these records are *counted and reported as unsupported*, never
  silently dropped and never approximated as cash. Investment import waits
  for an investment domain.
- **Direct Connect.** Talking to a bank over OFX, fetching statements on a
  schedule, and the credential storage that implies. This note is about
  files the user already has.
- **Writing QFX or QBO** — see the summary.
- **Reading `.mny` directly.** Not "later" — **not planned**. Money's file is
  a private, encrypted database, and the supported migration is the one
  above: export Microsoft QIF from Money, import it here. This closes the
  question [vault-design.md](vault-design.md) left open, and it means the
  whole-book QIF path carries weight that a convenience feature would not.
- **Multi-currency.** A statement whose currency is not the account's is
  refused rather than converted, and a transaction in a currency of its own
  is counted as unsupported. The neutral model carries the currency fields so
  that nothing has to be re-parsed when this arrives, but nothing converts.
  See [Currencies](#currencies).
- **A native round-trip export format.** Getting a whole book out intact is
  **backup, restore and archive** — planned separately — not export. Export
  exists to hand data to another program, and the three formats it writes
  are the ones other programs read. Round-tripping is used here as a *test*
  technique, not offered as a feature; see [Round-tripping in the
  tests](#round-tripping-in-the-tests).
- **Automatic import on a schedule, or a watched folder.**
- **Budgets, payees' addresses, attachments and memorised transactions** in
  QIF (`!Type:Budget`, the `A` address lines, `!Type:Memorized`). Parsed and
  counted, not applied.

## Decisions

1. **The format plugin is pure.** A reader takes bytes and gives back an
   `ExchangeDocument`. It has no access to the book, performs no matching, and
   resolves no accounts. This makes every format testable as a pure function
   over a fixture, which is the only way a parser this fiddly stays correct.
2. **Dispositions are computed once, in `exchange`, and shown before they are
   applied.** The matcher is one function of (document, book state, options),
   not logic scattered through the view. It is the piece most worth testing
   and most likely to be tuned.
3. **The bank's id wins over the heuristics; the user wins over both.** Where
   a format supplies a transaction id, it is the only duplicate test used for
   that row, and heuristics apply only to formats that supply none (QIF, most
   CSV). But every row's match is the matcher's *proposal*, and **Change…**
   replaces it with the user's. The matcher is never the last word.
4. **The import is the matching step.** It is not a lightweight prelude to
   reconciliation — the user matches the statement against the register here,
   row by row, and `E` is what accepting a row means. Reconciliation is a
   separate action against a separate document (a statement's closing
   balance) at a separate time, and import never starts one.
5. **Import is a batch, and a batch is a document.** Recording what was
   written is what makes *Undo Import*, an import history and an honest
   result banner possible, and it costs one small collection.
6. **As few storage transactions as the service boundary allows, and a
   record of what landed when that is not one.** A half-applied statement is
   worse than a refused one — but writing through `accounts.service` rather
   than against its collections means the import cannot enlist the accounts
   plugin's transaction, and keeping the account manager's rules is worth
   more than the atomicity. So each account's new rows go through a single
   `createMany` (one transaction, and the bulk of any import), each merge is
   its own small write, and a batch is recorded even when a later write is
   refused, so whatever landed can be taken straight back out. See
   [Applying](#applying-and-undoing).
7. **A format's quirks are configuration, not code branches.** Sign flips,
   date orders, delimiters, dialects and column maps are fields on a
   descriptor or a saved profile, so a bank whose file is subtly wrong is a
   settings change, not a patch.
8. **The user maps once.** The account a file belongs to, a CSV's columns,
   and a payee's preferred name are all remembered in the book, keyed by what
   the file carries, so next month's import is two clicks.
9. **Export is driven by the same descriptors**, so a format that can only be
   read (QFX, QBO) simply declares no writer, and the export dialog does not
   offer it.
10. **Everything the user teaches the importer lives in the book**, not in
    the options file: payee rules, account links and format profiles. A
    business book and a personal book rename different payees and draw on
    different accounts, and a rule that followed the application would be
    wrong in one of them.

## Components

```
  format plugins                           the pipeline
  ──────────────                           ────────────
  exchange-ofx                     ┌──────────────────────────────┐
    contributes → exchange.formats │ exchange                     │
      ofx, qfx, qbo                │  provides exchange.service   │
    provides      exchange-ofx.format        exchange.migrator    │
  exchange-qif                     │  owns     exchange.formats   │
    contributes → exchange.formats │                              │
      qif  (two dialects)          │  read → resolve → match      │
    provides      exchange-qif.format     → review → apply        │
  exchange-csv                     │                              │
    contributes → exchange.formats │  the review view             │
      csv  (profiles)              │  the export dialog           │
    provides      exchange-csv.format      import history + undo  │
                                   └───────┬──────────────────────┘
          ▲                                │ requires
          │ discovered at import           ▼
          │ and export time    ┌──────────────────────────────────┐
          └────────────────────│ accounts  (accounts.service)     │
                               │ book      (book.session)         │
                               │ shell     (files, prompts,       │
                               │            dialogs)              │
                               └──────────────────────────────────┘
```

| Component | Kind | Responsibility | Provides | Requires |
|---|---|---|---|---|
| **`@tessera/exchange-api`** | package | The contract: the neutral model, the descriptor and reader/writer interfaces, errors, ids, channels and events | — | — |
| **`exchange`** | plugin | The pipeline, matching, batches and undo, the review view, the export dialog, the options, the menus | `exchange.service`, `exchange.migrator` | `book.session`, `accounts.service`, `shell.prompts` |
| **`exchange-ofx`** | plugin | OFX 1.x (SGML) and 2.x (XML), and their QFX and QBO faces | `exchange-ofx.format` | — |
| **`exchange-qif`** | plugin | QIF, both dialects, statement and whole-book forms; QIF writing | `exchange-qif.format` | — |
| **`exchange-csv`** | plugin | Delimited text with a saved column profile; CSV writing | `exchange-csv.format` | — |

A format plugin requires nothing. It never activates against a book, so its
activation order does not matter, and a broken one costs only its own
formats.

## The neutral model

Every reader produces this. It is deliberately flat, deliberately *lossy in a
named way* — anything a format carries that Tessera has no home for arrives
as an `unsupported` entry rather than disappearing — and it carries enough
provenance that a diagnostic can point at a line of the original file.

```ts
/** What one file turned into. One document may describe several accounts (a whole-book QIF). */
export interface ExchangeDocument {
  /** The descriptor that read it, e.g. 'exchange-ofx.qbo'. */
  formatId: string
  /** What the reader concluded about the file, shown in the review header: 'QIF (Microsoft dialect)'. */
  dialect?: string
  /** The institution, where the file names one. */
  institution?: { name?: string, id?: string, bankId?: string }
  /** When the file was produced, if it says. */
  generatedAt?: string
  statements: ExchangeStatement[]
  /** Category definitions the file carried (QIF `!Type:Cat`). Created on apply if the user allows it. */
  categories?: { path: string, kind: 'income' | 'expense' }[]
  /** Records recognised but not representable: investments, budgets, memorised transactions. Never silent. */
  unsupported: { kind: string, count: number, detail?: string }[]
  /** Problems that did not stop the read: a malformed row, an unparsable date. */
  warnings: ExchangeWarning[]
}

/** One account's worth of a file. */
export interface ExchangeStatement {
  /** What the file says about the account it came from; every field is optional, because formats vary. */
  account: {
    /** OFX ACCTID, QIF `!Account` N line, a CSV column. As printed, not normalised. */
    number?: string
    /** OFX BANKID / routing number. */
    bankId?: string
    name?: string
    /** Mapped onto an `AccountType` where the file is clear enough; else undefined. */
    type?: AccountType
    /** ISO 4217, from OFX CURDEF or a CSV column. Undefined means "ask". */
    currency?: string
    /** OFX BANKACCTFROM/ACCTTYPE, QIF account type line, verbatim, for diagnostics. */
    rawType?: string
  }
  /** The period the file covers, where it says. */
  period?: { from?: string, to?: string }
  /** OFX LEDGERBAL / AVAILBAL, QIF opening-balance record. Minor units, signed like a Tessera balance. */
  balances?: { ledger?: { amount: number, asOf: string }, available?: { amount: number, asOf: string } }
  transactions: ExchangeTransaction[]
}

export interface ExchangeTransaction {
  /** YYYY-MM-DD, already normalised by the reader. */
  date: string
  /** The date the bank says the money moved, where the format distinguishes it. Shown, never used for matching. */
  postedDate?: string
  /** Minor units, signed from the account's point of view: positive raises the balance. */
  amount: number
  /** ISO 4217, when the row carries its own (rare; OFX ORIGCURRENCY). */
  currency?: string
  /** The bank's id for the row: OFX FITID. Absent for QIF and most CSV. */
  externalId?: string
  /** OFX CORRECTFITID + CORRECTACTION: this row replaces or deletes an earlier one. */
  corrects?: { externalId: string, action: 'replace' | 'delete' }
  /** As the file wrote it, before any renaming rule. Both are kept: the rule is applied in `exchange`, not here. */
  payee?: string
  memo?: string
  /** A cheque number or the bank's reference. */
  number?: string
  /** A category path the file named, `Parent : Child`. */
  category?: string
  /** A transfer the file named, by the account's name in the file (QIF `L[Savings]`). */
  transferAccount?: string
  /** Split lines, summing to `amount`. Parked until `Transaction.splits` is real; see Changes to accounts. */
  splits?: { amount: number, category?: string, memo?: string, transferAccount?: string }[]
  /** What the file said the clearing state was: QIF `C`, OFX has none. */
  cleared?: 'cleared' | 'reconciled'
  /** The format's own type word (OFX TRNTYPE, a CSV column). Shown in the review, used for nothing else. */
  kind?: string
  /** Where in the file this came from, for a warning the user can act on. */
  source?: { line?: number, record?: number }
}

export interface ExchangeWarning {
  /** 'date.unparsable', 'amount.unparsable', 'record.malformed', 'encoding.replaced'. */
  code: string
  message: string
  source?: { line?: number, record?: number }
}
```

Two things to notice. **Amounts are minor units and signed Tessera's way**
before they leave the reader, so no sign convention escapes into the
pipeline; the reader is where a format's convention is dealt with. And
**payee and memo are untouched** — renaming is the pipeline's job, and the
review view shows the user both the original and the renamed value.

## The format seam

A format plugin contributes plain data to **`exchange.formats`** and provides
the behaviour as a service, exactly as `vault-design.md` set out and as
`accounts.reconcile.actions` does today.

```ts
export const FORMATS_POINT = 'exchange.formats'

export interface ExchangeFormatContribution {
  /** `<pluginId>.<name>`: 'exchange-ofx.qbo'. */
  id: string
  /** 'QuickBooks Web Connect (*.qbo)' — the file dialog's filter name and the dialog's list entry. */
  label: string
  /** Without dots: ['qbo']. */
  extensions: string[]
  /** The service implementing `ExchangeFormat`. */
  service: string
  /** What this format can do. A read-only format simply omits `write`. */
  capabilities: {
    read?: boolean
    write?: boolean
    /** The file can describe more than one account (whole-book QIF). Changes the review view's header. */
    multiAccount?: boolean
    /** Rows carry a stable id, so duplicates are exact. Turns the heuristic matcher off for this format. */
    transactionIds?: boolean
  }
  /** Tried in this order when sniffing an unknown file; lower first. */
  order?: number
}

export interface ExchangeFormat {
  /**
   * Cheap check that these bytes are this format: a header line, a magic token, a first record. Given the first
   * 64 KiB only. Must not throw. Returning a number lets a confident format outrank a permissive one
   * (CSV says 0.2 for anything with commas; OFX says 1 for an `OFXHEADER` line).
   */
  sniff(head: Uint8Array, fileName: string): number
  /** Bytes → the neutral model. Throws `ExchangeError` only when the file cannot be read at all. */
  read?(data: Uint8Array, context: ReadContext): Promise<ExchangeDocument>
  /** The neutral model → bytes. */
  write?(document: ExchangeDocument, context: WriteContext): Promise<Uint8Array>
}

export interface ReadContext {
  fileName: string
  /**
   * Answers the reader needs and cannot infer: a QIF dialect, a CSV profile, a currency, a date order. The reader
   * asks through `request`; `exchange` resolves each from the options, a saved profile, or the user.
   */
  request<T>(question: ExchangeQuestion<T>): Promise<T>
  /** Progress for a large file, so a 200 MB QIF does not look hung. */
  progress?(done: number, total: number): void
  log: Pick<Logger, 'warn'>
}
```

`request` is the one piece of indirection worth paying for. Without it a
reader would either have to know about dialogs (breaking decision 1) or
return half-read results that the pipeline fixes up. With it, the QIF reader
says "I need to know the dialect, here are the choices and here is what I
guessed", and `exchange` decides whether to answer from an option, from a
saved profile, or by opening a dialog — and the reader stays a pure function
of (bytes, answers), which is exactly what a test wants to drive.

```ts
export type ExchangeQuestion<T> =
  | { kind: 'choice', id: string, title: string, detail?: string, options: { value: T, label: string, detail?: string }[], suggested?: T }
  | { kind: 'csvProfile', id: string, title: string, sample: string[][], suggested?: CsvProfile }
  | { kind: 'currency', id: string, title: string, suggested?: string }
```

### Choosing a format

1. If the user picked a format in the dialog, use it.
2. Otherwise match the file extension against every descriptor. One match
   wins.
3. Otherwise (or when several match) read the first 64 KiB and ask every
   descriptor's `sniff`; the highest score above 0 wins.
4. A tie, or nothing above 0, is an error naming the formats tried.

Extension first and content second, because `.qfx` and `.qbo` are
byte-identical in structure and only the extension and the Intuit tags tell
them apart — while a `.txt` full of OFX is still OFX.

## OFX, QFX and QBO

### What they have in common

All three are OFX. The plugin reads both syntaxes:

- **OFX 1.x** is SGML: a block of `KEY:VALUE` header lines, a blank line,
  then a tree in which leaf tags are *not closed*.

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
  <SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS>
  ...
  ```

  A conventional XML parser cannot read this. The reader therefore uses its
  own tokeniser: scan for `<TAG>`; if the next non-space character is `<`, the
  tag is an element, else it is a leaf whose value runs to the next `<`.
  `</TAG>` closes, and closing a tag also closes any leaf still open — which
  is what makes unclosed leaves work. Values are entity-decoded (`&amp;`,
  `&lt;`, `&gt;`, `&apos;`, `&quot;`, and numeric references), and trailing
  whitespace trimmed.

- **OFX 2.x** is XML, with the header as a processing instruction:

  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
  <OFX>…</OFX>
  ```

  The same tokeniser handles it: well-formed XML is the case where every leaf
  happens to be closed. Writing one parser rather than two removes the whole
  class of "works in 1.x, subtly different in 2.x" bugs, at the cost of not
  rejecting malformed XML — which is a trade worth making for a reader whose
  job is to be forgiving.

**Encoding.** OFX 1.x declares `ENCODING` (`USASCII` or `UTF-8`) and
`CHARSET` (a Windows code page, usually `1252`). `USASCII` + `1252` means
Windows-1252, which is not ASCII and not UTF-8; decoding it as UTF-8 mangles
every accented payee. The reader decodes by the declared pair, falls back to
Windows-1252 for 1.x and UTF-8 for 2.x, and records an
`encoding.replaced` warning if any byte could not be decoded. For 2.x the XML
declaration wins, and a UTF-8 BOM is honoured and stripped.

### What is read

```
OFX
├── SIGNONMSGSRSV1/SONRS
│     ├── FI/ORG, FI/FID        → document.institution
│     ├── INTU.BID              → institution.id      (QFX and QBO)
│     └── INTU.USERID           → ignored, never stored
├── BANKMSGSRSV1/STMTTRNRS/STMTRS          → one ExchangeStatement
│     ├── CURDEF                            → account.currency
│     ├── BANKACCTFROM
│     │     ├── BANKID                      → account.bankId
│     │     ├── ACCTID                      → account.number
│     │     └── ACCTTYPE                    → account.type (mapped), account.rawType
│     ├── BANKTRANLIST
│     │     ├── DTSTART, DTEND              → statement.period
│     │     └── STMTTRN…                    → ExchangeTransaction
│     ├── LEDGERBAL/BALAMT, DTASOF          → balances.ledger
│     └── AVAILBAL/BALAMT, DTASOF           → balances.available
├── CREDITCARDMSGSRSV1/CCSTMTTRNRS/CCSTMTRS → as above, with CCACCTFROM, type 'creditCard'
└── INVSTMTMSGSRSV1/…                       → counted in document.unsupported
```

One `STMTTRN`:

| Tag | Goes to | Notes |
|---|---|---|
| `DTPOSTED` | `date` | |
| `DTUSER`, `DTAVAIL` | `postedDate` | Shown only |
| `TRNAMT` | `amount` | Decimal text → minor units |
| `FITID` | `externalId` | The duplicate key |
| `CORRECTFITID`, `CORRECTACTION` | `corrects` | |
| `CHECKNUM`, else `REFNUM` | `number` | |
| `NAME`, or `PAYEE/NAME` | `payee` | `PAYEE` is the structured form; its address lines are dropped |
| `MEMO` | `memo` | |
| `TRNTYPE` | `kind` | And see below |
| `CURRENCY/CURSYM`, `ORIGCURRENCY` | `currency` | |

**Amounts and signs.** `TRNAMT` is decimal text with an optional sign, and
may use a comma as the decimal separator (the specification allows it). It is
read as text into minor units — never through `parseFloat`, which cannot
represent `0.07` and will eventually cost a cent. The number of minor digits
comes from the statement's currency.

OFX's sign is already from the account holder's point of view, which is
Tessera's convention too, so the default is to take it as given. Two
exceptions earn an option:

- some issuers write credit-card charges as *positive* in `CCSTMTRS`,
  inverting the whole file;
- a few write `TRNTYPE` correctly but sign everything positive, leaving the
  type word as the only indication.

So the descriptor carries a `signs` option — `asGiven` (default),
`invert`, or `fromType` (use `TRNTYPE`: `DEBIT`, `FEE`, `SRVCHG`, `ATM`,
`POS`, `CHECK`, `PAYMENT`, `DIRECTDEBIT` are negative, the rest positive) —
and the review view detects the common case for the user: if every row in the
file has the same sign, it says so and offers to flip them, because a
statement where nothing ever came *in* is nearly always a convention
mismatch rather than a very bad month.

**Dates.** OFX dates are `YYYYMMDD` optionally followed by `HHMMSS`, a
fractional part, and a bracketed zone: `20261103120000.000[-5:EST]`. The date
part is taken as-is and the time discarded. This is deliberate: converting
`20261103000000[-5:EST]` to UTC moves it to the 3rd at 05:00, and converting
`20261103000000[+13:NZDT]` moves it to the **2nd** — a transaction that
silently lands on the wrong day, and worse, on the wrong side of a statement
boundary. A statement date is a calendar date in the bank's local terms, so
the local date is what is kept.

### QFX and QBO

Three descriptors, one reader:

| Descriptor | Extension | Sniff | Notes |
|---|---|---|---|
| `exchange-ofx.ofx` | `.ofx` | `OFXHEADER` header line or `<?OFX` PI → 1.0 | The plain format |
| `exchange-ofx.qfx` | `.qfx` | As OFX, plus `INTU.BID` → 1.0; OFX without it → 0.6 | Quicken Web Connect |
| `exchange-ofx.qbo` | `.qbo` | As QFX | QuickBooks Web Connect |

The only parsing difference is that `INTU.BID` is read as the institution id
and `INTU.USERID` is explicitly discarded — it is the user's login at their
bank, and nothing in Tessera has any use for it. All three declare
`transactionIds: true`, `read: true` and no `write`.

## QIF, and its two dialects

QIF is a line format. Each line is one field: a single-letter code and the
rest of the line as its value. `^` on its own ends a record. A line starting
`!` is a control line.

```
!Type:Bank
D11/03'26
T-142.00
N1042
PHydro Ottawa
MNovember
LUtilities:Electricity
CX
^
```

### The two dialects

| | Standard | Microsoft |
|---|---|---|
| Payee (`P`), category (`L`), memo (`M`) | Truncated to **15 characters** | Written in full |
| Dates | `M/D/YY`, `M/D'YY` for 2000+ | `M/D/YYYY`, and locale orders occur |
| Class separator | `Category/Class` | Same, but a category may itself contain `/` |
| Amounts | `1,234.56` | Same, but `1.234,56` occurs in European exports |

**Detection.** The reader makes one pass over the file before parsing:

1. If any `P`, `L` or `M` value is longer than 15 characters → **Microsoft**,
   with certainty. (A standard writer cannot produce one.)
2. Otherwise, if any date matches `\d{1,2}/\d{1,2}/\d{4}` → **Microsoft**,
   with confidence.
3. Otherwise, if any date uses the apostrophe form (`11/03'26`) → **standard**,
   with confidence.
4. Otherwise the file is **ambiguous**: short names, two-digit years, nothing
   decisive. The reader raises a `choice` question — "Standard QIF (names
   truncated to 15 characters)" against "Microsoft QIF (full names)" —
   suggesting the option's default.

This matters for more than cosmetics. On a standard file the reader marks
every name it read at exactly 15 characters as **possibly truncated**, and
the matcher then compares those payees by prefix rather than by equality, so
`Canadian Tire S` from the file matches `Canadian Tire Store` in the book
instead of creating a second payee next to it. Getting the dialect wrong in
the other direction is harmless; getting it wrong this way doubles the
user's payee list.

The dialect is remembered per institution, in the saved profile, so a user
who imports from the same place every month answers once.

**Dates.** Beyond the dialect, QIF dates are genuinely ambiguous: `03/11/26`
is the 3rd of November in Ottawa and the 11th of March in Chicago. The reader
resolves the order by, in order:

1. the saved profile's answer for this institution, if any;
2. the `exchange.qif.dateOrder` option, if it is not `auto`;
3. **inference over the whole file** — if any value has a first component
   above 12 the order is settled (`13/05/26` can only be D/M); if any has a
   second above 12 it is settled the other way;
4. a `choice` question showing two example dates from the real file, so the
   user is choosing between "5 March 2026" and "3 May 2026" rather than
   between two abstract patterns.

Two-digit years follow Quicken's rule: `'` before the year means 2000+, and
otherwise 00–49 is 2000+ and 50–99 is 1900+.

### Control lines and records

| Control line | Meaning | Handling |
|---|---|---|
| `!Type:Bank`, `Cash`, `CCard`, `Oth A`, `Oth L` | Transactions follow, for the current account | Read; the word maps to an `AccountType` |
| `!Type:Invst` | Investment transactions | Counted in `unsupported`, skipped to the next `!` |
| `!Account` | Account definitions follow | Read: each record defines or switches the current account |
| `!Type:Cat` | The category list | Read into `document.categories` |
| `!Type:Class`, `!Type:Memorized`, `!Type:Prices`, `!Type:Budget` | Classes, memorised transactions, security prices, budgets | Counted in `unsupported` |
| `!Option:AutoSwitch`, `!Clear:AutoSwitch` | Brackets an `!Account` list that defines rather than switches | Honoured: between them, `!Account` records define accounts without making one current |
| Anything else starting `!` | Unknown | One warning, skipped to the next `!` |

A transaction record's fields:

| Code | Meaning | Goes to |
|---|---|---|
| `D` | Date | `date` |
| `T` | Amount | `amount` |
| `U` | Amount (Quicken writes both) | Ignored when `T` is present; used when it is not |
| `N` | Number, or a code (`DEP`, `ATM`, `EFT`) | `number` |
| `P` | Payee | `payee` |
| `M` | Memo | `memo` |
| `C` | Cleared: `*` or `c` cleared, `X` or `R` reconciled | `cleared` |
| `L` | Category, `Category/Class`, or `[Account]` for a transfer | `category` / `transferAccount` |
| `S` `E` `$` | Split category, memo, amount — repeating, in that order | `splits[]` |
| `A` | Address, up to five lines | Dropped; counted once in `unsupported` |
| `F` | Reimbursable flag | Dropped |

A `!Account` record uses `N` for the name, `T` for the type, `D` for a
description, `L` for a credit limit and `/` plus `$` for a statement balance
and date.

**The whole-book form.** A QIF exported from Quicken or Money for a whole
file is a sequence of `!Account` + `!Type:…` blocks. The reader emits one
`ExchangeStatement` per account, in file order, and leaves `transferAccount`
as the account's *name in the file*; resolving those names to Tessera
accounts, and pairing the two sides of each transfer, is the pipeline's job
and is described under [Applying](#applying-and-undoing).

**Opening balances.** The convention is a first transaction whose payee is
`Opening Balance` and whose category is a transfer to the account itself
(`L[Chequing]` in the Chequing block). The reader recognises it, and does
*not* emit it as a transaction: it becomes `statement.balances.ledger` with
the record's date. Importing it as a transaction instead would double every
balance in the book, because the account Tessera creates already has an
opening balance of its own.

### Writing QIF

The QIF writer takes a `flavour` — `standard` or `microsoft` — defaulting to
Microsoft. Standard truncates `P`, `L` and `M` to 15 characters and writes
`M/D'YY`; Microsoft writes them whole and uses `M/D/YYYY`. Both write `U`
beside `T`, because some readers want it. Transfers are written as
`L[Account Name]` on both sides, and a Tessera transfer pair becomes the two
records the format expects.

## CSV

CSV is not a format so much as a family, so the design is a *profile*: the
reader needs to be told what the columns mean, and then remembers.

```ts
export interface CsvProfile {
  /** `<institution> chequing`, shown in the profile list. */
  name: string
  /** ',' ';' '\t' '|'. Inferred from the header line; overridable. */
  delimiter: string
  /** '"' by default; doubled inside a quoted field, RFC 4180. */
  quote: string
  /** Rows to skip before the header; banks like a title line. Default 0. */
  skip: number
  /** The first non-skipped row names the columns. Default true. */
  header: boolean
  encoding: 'utf-8' | 'windows-1252' | 'utf-16le'
  /** Column index, or header name, per field. */
  columns: {
    date: string | number
    /** Either one signed amount column… */
    amount?: string | number
    /** …or two unsigned ones, as most bank exports have. */
    debit?: string | number
    credit?: string | number
    payee?: string | number
    memo?: string | number
    number?: string | number
    category?: string | number
    balance?: string | number
    externalId?: string | number
  }
  /** 'DMY' | 'MDY' | 'YMD' | 'ISO', or a pattern like 'dd-MMM-yyyy'. */
  dateFormat: string
  /** The decimal separator, and what to strip. Default '.', stripping ',' and spaces. */
  decimal: '.' | ','
  /** With a single amount column: is a debit negative (default) or positive? */
  debitsArePositive?: boolean
  /** Rows whose first cell matches are skipped: a trailing 'Total' line. */
  skipRows?: string
}
```

**The mapping dialog** opens when no profile matches. It shows the first ten
rows in a grid, a drop-down over each column choosing what it is, and a live
preview of the first three transactions as Tessera would read them — date,
payee and amount, formatted in the account's currency. That preview is the
whole point: a user cannot reason about `dateFormat: 'MDY'`, but they can see
immediately that the preview says *5 March* when the statement says *3 May*.

**Matching a profile to a file** is by the header row: a profile records a
hash of its normalised header names, and a file whose header matches is read
without asking. Files with no header fall back to the column count and the
chosen format.

The reader computes that fingerprint, but the `exchange` plugin owns the
profile store, so the fingerprint travels in the question's id —
`exchange-csv.profile:<fingerprint>`. That lets `answer()` look a saved
profile up, and save a new one, without having to parse the file itself, and
leaves the reader a pure function of (bytes, answers).

> **Storage forbids a dot in a field name**, and every question id has one.
> `FormatProfile.answers` is therefore a list of `{ questionId, value }`
> rather than a map keyed by question id — as a map it could not be written
> at all, and the write failing silently would mean asking the user the same
> question every month forever.

**Duplicates.** Most CSV exports carry no transaction id, so CSV relies on
the heuristic matcher. Where a bank does supply one, mapping it to
`externalId` promotes the whole file to exact matching, and the mapping
dialog says so beside that column.

**Writing CSV** uses a fixed column set — `Date, Number, Payee, Category,
Memo, Amount, Balance, Status, Account` — with RFC 4180 quoting, CRLF line
endings, and a UTF-8 BOM by default, because Excel reads a BOM-less UTF-8
file as the local code page and mangles every non-ASCII payee. The
BOM is an option for anyone piping the file somewhere less forgiving.

## Resolving the account

A statement has to land in exactly one Tessera account, and the file
identifies that account in a way Tessera did not choose. The pipeline tries,
in order:

1. **A saved link.** `exchange.links` records
   `(formatId, bankId, accountNumber) → accountId` from the last time the
   user answered. This is the common case: one click, every month after the
   first.
2. **The account number.** `accounts.service.list({ accountNumber: { endsWith } })`
   — which exists for this — using the last four or more characters, ignoring
   spaces, dashes and case. Exactly one hit resolves it; several raise the
   question with those accounts listed first.
3. **The account name**, where the file carries one, ignoring case.
4. **Ask.** A dialog listing the book's accounts, with *Create a new
   account…* alongside, and a tick box — *Remember this* — that writes the
   link.

If the file says the account is in a currency the chosen account does not
use, the import stops with `CURRENCY_MISMATCH` rather than converting, in
line with how `accounts.service` treats transfers.

**The link is also where this source's quirks are remembered**, which is what
makes the second import of a given statement a different experience from the
first:

```ts
export interface AccountLink {
  id: string
  formatId: string
  bankId?: string
  /** The account number, normalised: no spaces, dashes or case. */
  numberKey: string
  accountId: string
  /** Shown in the review header: 'RBC chequing (QFX)'. */
  label: string
  /** Answers this source needed once and should not be asked again. */
  answers?: Record<string, Json>
  /** This source's sign convention, settled the first time. */
  signs?: 'asGiven' | 'invert' | 'fromType'
  /** How many days this bank takes to post. Overrides the option; see Tuning the matching. */
  dateWindow?: number
  lastImportedAt?: string
  rev: number
}
```

**The two identifiers a statement names an account by** are the account
number (`ACCTID`) and the routing or transit number (`BANKID`). Both are kept
on the account — `accountNumber` and `routingNumber` — rather than only on
the `AccountLink`, because an exported OFX has to write them back, and a
`BANKID` Tessera invented would be worse than none: it is what a receiving
program keys the account on. An account the user typed in has no routing
number and its exported file simply leaves the element out.

**Creating an account from a statement** prefills the account dialog from
`statement.account` — name, type, number, routing number, institution,
currency — and sets
the opening balance to the statement's ledger balance less the sum of its
transactions, so that after the import the account's balance equals the
statement's. That last subtraction is what makes a first import reconcile
instead of being out by a month.

## Currencies

Multi-currency is a later feature, so this note's job is to refuse the cases
it cannot handle without refusing the ones it can. OFX distinguishes two
things that look alike and are not, and getting them the wrong way round
would break ordinary credit-card statements:

| Tag | What it means | Handling |
|---|---|---|
| `<ORIGCURRENCY>` | `TRNAMT` **is** in the account's currency; this records what the purchase was originally made in — a card used abroad | **Imported normally.** The amount needs no conversion because the bank already did it. The original is noted in the memo (`EUR 42.00`) so the user can see why the figure is odd |
| `<CURRENCY>` | `TRNAMT` is **in that currency**, not the account's | **Counted as unsupported**, with the currency named in the banner. Importing it would silently add a foreign figure to a balance |
| `<CURDEF>` ≠ the account's currency | The whole statement is in another currency | The import stops with `CURRENCY_MISMATCH` before anything is planned |

The distinction matters because a Canadian card statement containing a
hotel in Lisbon is a completely normal file, and a design that refused
`ORIGCURRENCY` would reject it. QIF and CSV carry no per-row currency, so
only the third row applies to them.

`ExchangeTransaction.currency` stays in the model, unused, so that when
multi-currency does arrive the readers do not change.

## Matching: duplicates, merges and new rows

The matcher is a pure function:

```ts
export function matchStatement(
  incoming: ExchangeTransaction[],
  existing: Transaction[],
  options: MatchOptions
): ProposedRow[]
```

and every row comes back with one of four dispositions:

| Disposition | Meaning | Shown as |
|---|---|---|
| `new` | Nothing in the book looks like this | **New** |
| `duplicate` | The same `externalId` is already in this account | **Already here** |
| `merge` | An existing uncleared row is almost certainly this one | **Matches 8 Nov** |
| `conflict` | Same `externalId`, different amount or date — the bank restated it | **Changed** |

A disposition is a *proposal*. It carries no accepted state of its own: the
user accepts rows in the review view, and until a row is accepted nothing
about it will be written. `duplicate` is the one that cannot be accepted into
a write — storage would refuse it — so accepting one means only
"acknowledged", and the row is struck through.

**Tier 1 — the bank's id.** When the format declares `transactionIds`, the
`externalId` is the only test. The index `uniqueExternalId` on
`(accountId, externalId)` means storage enforces this even if the matcher is
wrong, so the worst case is a refused write rather than a duplicated one.
Within a single file, a repeated `externalId` is reported as a warning and
only the first is kept. `CORRECTFITID` resolves to the row it names:
`REPLACE` updates it, `DELETE` voids it (never deletes — a reconciled row
must not vanish beneath the user).

**Tier 2 — near matches, for formats with no id.** A candidate matches when:

- the amounts are **exactly** equal (never approximate: two coffees at $4.50
  on the same day are two transactions, and "nearly equal amounts" merges
  them);
- the dates are within `dateWindow` days (default 3, an option) — banks post
  a card purchase days after it happened;
- and the payees are *compatible*: equal ignoring case and punctuation, or
  one is a prefix of the other of at least 8 characters (this is the
  truncated-QIF case), or either side is empty.

Candidates are scored — exact date beats a near one, exact payee beats a
prefix — and each incoming row takes the best unclaimed candidate, by a
stable greedy pass in date order so the result does not depend on hash order.
Several equally good candidates mean the row is `new` and a warning says why:
guessing between two identical rows is worse than entering one the user can
see.

**Tier 3 — the merge.** This is the one that decides whether the feature
feels right. The user wrote a cheque on the 2nd and typed it into the
register; the bank reports it on the 7th. Tier 2 finds the pair, and the
disposition is `merge`, not `new`: applying it **updates the existing
transaction** rather than adding one. It adopts the `externalId` (so next
month's file sees it as a duplicate), sets the status to `electronic` —
*the bank has reported it* — and, where the user has asked, takes the bank's
memo and number. It never changes the amount, the date, or the category the
user chose; the bank's date goes in `postedDate` for display only. A reconciled
row is never merged into silently: it becomes a `conflict` the user must
look at.

**Tier 4 — the user.** Every proposal above can be replaced from the review
view's **Change…** button, which is described with the view it belongs to
([Matching by hand](#matching-by-hand)). A manual match is recorded on the
row as `matchedBy: 'user'` and is never recomputed: re-planning after the
user changes the account, an answer or an option preserves manual matches by
key, because asking someone to redo that work is the fastest way to make them
stop trusting the screen.

A manual match is the **only** way a merge may change the amount, and only
with the explicit tick the dialog offers. The matcher will not propose a
match between unequal amounts, but a person looking at `56.02` in the
register and `56.20` on the statement knows exactly what happened, and this
is the one place that typo can be fixed in the same motion as the import.

**Transfers.** A statement from one account contains one side of a transfer;
the other account's statement contains the other. Importing both would
produce two one-sided transactions where the user wants one pair. So after
matching, the pipeline looks across the *whole import* — and across the book
— for a row in another account with the opposite amount, a date within the
window, and either `transferAccount` naming it or a payee that resolves to
it. Those are offered as a single row in the review view marked **Transfer**,
and applied through `TransactionDraft.transferAccountId`, which makes
`accounts.service` write both sides and keep them consistent. Anything not
confidently paired is imported as an ordinary transaction, because a wrong
transfer is much harder for a user to unpick than a missing one.

## Payee rules

`SQ *THE DAILY GRIND 4471 OTTAWA ON` is not a payee anyone wants in their
register. A rule turns it into one, and optionally picks the category too.

```ts
export interface PayeeRule {
  id: string
  /** Lower first; the first match wins. */
  order: number
  match: {
    /** Tested against the file's payee, then its memo. */
    kind: 'contains' | 'startsWith' | 'equals' | 'regex'
    value: string
    /** Default true. */
    ignoreCase?: boolean
  }
  /** The payee to use. With a regex, `$1` and friends are substituted. */
  payee: string
  /** Also set this category, when the transaction has none. */
  categoryId?: string
  /** Only in this account; absent means every account. */
  accountId?: string
  /** False while the user has switched it off, without deleting it. */
  enabled: boolean
  /** Written by "remember this"; shown differently in the list. */
  learned?: boolean
  rev: number
}
```

Rules are applied in the pipeline **before matching** — so a renamed payee
participates in matching, which is the point: last month's `THE DAILY GRIND`
and this month's `SQ *THE DAILY GRIND 4471` both become *The Daily Grind* and
land on the same payee.

That ordering is load-bearing rather than an optimisation. If the matcher
sees the bank's raw text it sees two different merchants, calls the row new,
and the user accepts a duplicate of a transaction sitting directly above it
in the register. `resolveRename` settles the name **once** per row, before
`effectiveRows` matches anything, and the result is carried on the row: the
name the matcher compared on is the name the register draws and the name the
draft is written with, so they cannot drift apart.

Three things can decide a row's payee, in order: **the user's own rename of
that row**, then **the book's rules**, then **what the file said**.

**Learning.** Phase 3 moved the review into the register, where a statement
row is a read-only `OverlayRow` with actions rather than an editable grid
line — so there is no "edit a payee in the review view" to learn from any
more. Instead a pending row offers **Rename…** beside Accept and Change…,
which opens a small dialog: the bank's text as written, the name to use, and
a tick box *Always rename this payee*. The choice persists as
`PendingRow.userPayee`, beside `userMatch`, so it survives a re-plan exactly
as a hand-made match does; ticking the box writes a `learned` rule whose
match is the longest leading run of the original that is not digits — almost
always the merchant's name with the store number stripped.

**The dialog shows what the row would become, live.** Because renaming
happens before matching, a new name can turn a row from *New* into
*Matches 3 Nov*. That is the feature working — it is precisely why rules
exist — but it must not happen behind the user's back, so the dialog asks
`previewRename` as they type and shows the resulting disposition, and the
transaction it would merge with, before they agree to it. The old review grid
could not do this: it matched once, up front.

The rule list is editable from *File ▸ Payee Rules…*, where order is the
semantics — the first rule that fires wins — so rules are numbered, moved
with the arrows, and renumbered from their position on save. Every learned
rule is marked as such.

Rules live in the book, so they travel with the data and differ per user —
and per book, which [decision 10](#decisions) explains: a business book
renames a different set of payees from a personal one, and a rule that
followed the application would be wrong in one of them. A second book
therefore starts with none.

**There is no *Import rules from another book…*.** An earlier draft of this
note had one. It is dropped: copying rules across would mean opening a second
book's database alongside the open one, and `book.session` holds exactly one
book — deliberately, because a book is the unit of isolation. Books being
independent is the point of [decision 10](#decisions), and a door between
them is not worth cutting for a convenience that saves typing a handful of
rules once.

## Applying, and undoing

**Only accepted rows are applied.** Everything else in the plan is skipped
and counted. Applying runs through `accounts.service` — never against the
collections — so every rule the account manager enforces still holds:

1. Create any categories the user allowed from `document.categories`
   (`categories.create` is idempotent for an existing path).
2. For a whole-book import, create or resolve each account, in file order,
   **before** any transaction, so transfers have both ends available.
3. Resolve each row's payee and category to ids, applying its `edit`.
4. Write the accepted `new` rows with
   `transactions(accountId).createMany(drafts)` — see [Changes to
   `accounts`](#changes-to-accounts) — with `externalId` set and
   `status: 'electronic'`.
5. Apply the accepted `merge` and `conflict` rows with `update`, including
   any the user matched by hand. The matched transaction takes the
   statement's date, amount and payee, its reference and `E`; every field
   changed is recorded in the batch so undo can restore it.
6. Record an `ImportBatch`.

**What `E` means after an import.** Accepting a row asserts that the bank has
reported this transaction, which is exactly what `electronic` means in
[the account manager](account-manager-design.md#clearing-status-and-void) —
it counts towards the cleared balance and leaves `reconciled` untouched for
the reconciliation that will come later, against a statement's closing
balance. Import therefore moves rows from uncleared to `E`, and never to `R`.
A row already `R` is never changed: a reconciled transaction is settled, and
an import arriving afterwards has nothing to add to it.

**What is atomic, and what is recorded instead.** Step 4 is a single storage
transaction per account, so a statement whose rows are all new — the common
case, and the whole of a migration import — is all-or-nothing: one bad row
and none of that account's rows are written. Steps 1, 2 and 5 are separate
writes, because each goes through a method of `accounts.service` that owns
its own transaction and a plugin cannot enlist another's. Where an import is
therefore part-done, it is **recorded anyway**: the batch holds exactly what
landed, the error says how many rows were written and tells the user to undo
the import, and `undo` takes them back out. A row that fails its own
validation (an amount beyond `MAX_AMOUNT`, a date before the account's
opening date) is never skipped quietly.

**The batch:**

```ts
export interface ImportBatch {
  id: string
  /** YYYY-MM-DDTHH:mm:ss.sssZ. */
  importedAt: string
  formatId: string
  dialect?: string
  /** The file's base name only — never its path, which can carry a user name. */
  fileName: string
  /** A SHA-256 of the file's bytes: re-importing the identical file is spotted before it is read. */
  fileHash: string
  accountIds: string[]
  /** Transactions this import created. */
  created: string[]
  /** Transactions it merged into: the id, and the fields it changed, so undo can restore them. */
  merged: { id: string, before: Partial<Transaction> }[]
  /** Accounts and categories it created, for the undo summary (they are not removed). */
  createdAccounts: string[]
  createdCategories: string[]
  /**
   * `read` is every row in the file. `imported` and `merged` are what was written. `duplicates` were already
   * here. `skipped` is what the user did not accept, which is a decision worth recording: a statement imported
   * with twelve rows left behind is a different event from one imported whole.
   */
  counts: {
    read: number, imported: number, merged: number,
    duplicates: number, skipped: number, unsupported: number
  }
  /** How many rows the user matched by hand, overriding the matcher. Tells us whether the matcher is good enough. */
  manualMatches: number
  rev: number
}
```

**Undo takes the whole import back out, or none of it.** This is what lets
*Accept All* be a safe button ([decision H](#decisions-taken-in-review)): if
undo could only partly reverse an import, a user who accepted forty rows
without reading them would be left holding the ones it could not touch, and
would have to find them by hand. So `exchange.undo` deletes every transaction
the batch created and restores every one it merged into, from `before`.

**As built, undo is journalled rather than one storage transaction.** Every
step goes through `accounts.service`, which this plugin cannot enlist in a
transaction of its own, so an undo can fail part-way. It therefore writes
`ImportBatch.undoing` — an `UndoJournal` — *before* each step: for a merged
transaction, how the import left it; for a created one, a snapshot that
writes it back. Merged rows are restored first and created rows deleted last,
since a written-back row gets a new id. If any step fails, the journalled
steps are backed out in reverse and the error is reported, so the book ends
as the import left it, never half-reversed; the batch is pointed at any
re-created rows, and their times are moved up so a retry does not mistake the
back-out for an edit. Journalling ahead means a step that takes effect and
*then* reports failure is still put back. A journal left behind — the app
closed mid-undo, or the back-out itself failed — is backed out by the next
undo of that batch before it begins.

Where that is not simply possible, it asks rather than skipping:

- **A row reconciled since the import** needs `confirm: ['reconciled']`, the
  same confirmation the register demands. `undo` called without it fails with
  `CONFIRMATION_REQUIRED` and `reasons`, listing the rows, so the caller
  gathers the confirmation **before** anything is written — the pattern
  `accounts.service` and `recurring.service` already use. With the
  confirmation, they go too.
- **A row edited since the import** is listed in the same way, with what
  changed, and is reversed with the rest once confirmed. Undo restores the
  row to its pre-import state, not to the user's later edit; the result says
  so plainly.
- **Accounts and categories the import created are kept**, and the result
  names them. Deleting an account that has since been used is a much larger
  action than undoing an import, and it is one the user can take deliberately
  from the navigator.

Straight after an import — from the result banner, which is where undo is
actually used — none of those cases can have arisen yet, so it is always a
clean, unconditional reversal of exactly what was just written.

The batch is kept, marked undone, so the history stays honest. The one thing
that genuinely cannot be undone is a batch trimmed by `history.keep`, which
is why trimming deletes batches rather than emptying them: a batch you cannot
undo should not sit in the history looking as though you could.

**Re-importing the same file** is noticed by `fileHash` against two things:
the statements still waiting (a flat refusal — it is already in front of you)
and the **history** (a question). The second is `ALREADY_IMPORTED`, carrying
when it was imported and how many transactions it added, and the import
command offers *Import Anyway*, since a bank that re-issues an identical file
after a correction is a real thing. A batch that has been **undone** does not
count: taking an import back out is exactly how a user says they want to do
it again.

**Putting rows aside.** A statement row the user does not want is skipped
from the register's own **Skip** action, and a whole statement with
`exchange.skip` and `all` — which asks first, because it is several rows at
once. Skipped rows are *counted, not forgotten*: `counts.skipped` on the
statement's batch is what makes a statement imported with twelve rows left
behind a different event in the history from one imported whole. A file the
user read and took nothing from still opens a batch, because it is still
something that happened to the book — and because that is what lets the
re-import check above recognise it later.

**What an import created** — accounts and categories — is recorded on the
pending statement at filing time and taken by the batch when it opens, since
they are made before any row is accepted and so before the batch exists. The
account each statement brought into being is credited to that statement; the
document's categories go to the first statement filed, rather than being
counted again for every one of them.

## Export

Export is the same pipeline backwards, and much shorter: there is no
matching, no resolution and nothing to undo.

```ts
export interface ExportRequest {
  /** What to write. */
  scope:
    | { kind: 'account', accountId: string }
    | { kind: 'subBook', subBookId: string, includeDescendants: boolean }
    | { kind: 'book' }
  /** Inclusive; absent means from the beginning / to the end. */
  range?: { from?: string, to?: string }
  formatId: string
  path: string
  /** Default false: voided transactions are excluded, as they are from every balance. */
  includeVoided?: boolean
  /** Default false. */
  clearedOnly?: boolean
  /** Default true for QIF (the receiving program needs them), false for CSV. */
  includeCategories?: boolean
  /** Format-specific: the QIF flavour, the CSV profile, the OFX version. */
  formatOptions?: Json
}
```

| Format | Writes | Notes |
|---|---|---|
| **OFX 2.x** | One `STMTRS` or `CCSTMTRS` per account, a `BANKTRANLIST`, a `LEDGERBAL` | `FITID` is the transaction's ULID — stable, unique, and already what another program needs. `<ORG>` is `Tessera`; no `INTU.*` tags are written. `BANKID` is the account's own `routingNumber` and is **omitted** when it has none |
| **QIF** | `!Type:Cat` (when asked), then `!Account` + `!Type:…` per account | Both dialects; transfers as `L[Account]` on both sides; splits as `S`/`E`/`$` once splits exist |
| **CSV** | The fixed column set above | **One account per file.** Its reader cannot tell several accounts' rows apart again, so the descriptor does not claim `multiAccount` and exporting several is refused up front — QIF is the format for that. The `Account` column names the one account, for a reader in a spreadsheet |

Exporting more than one account to a format that can only hold one
(a single-account CSV profile) is refused with a message, not silently
flattened.

Writing goes through `shell.files.showSaveDialog` and then a temporary file
renamed over the target, so an interrupted export does not leave a truncated
file where the user's data used to be. (`shell.files` has no atomic write
yet; it is on [todo.md](todo.md) and is listed as a prerequisite below.)

### What export is not

Export is **not** how a user keeps a copy of their book. Every one of these
formats loses something — QIF has no reconciliation history and a coarse
clearing status, OFX has no categories, CSV has no transfers — and a user
who treats a QIF as a backup will find out which of those mattered at the
worst possible moment. Keeping a book whole is **backup, restore and
archive**, which is separate planned work, and the export dialog should not
grow a *Back up…* button that quietly competes with it.

### Round-tripping in the tests

Round-tripping is still the sharpest tool available for proving a writer and
a reader agree, so it is used heavily — in the test suite, where its
limitation is a feature rather than a trap. Each format has a property test:
build a book in the memory engine, export it, import it into an empty book,
and assert that **what the format claims to carry** survives — dates,
amounts, payees, numbers, memos, transfers paired on both sides, categories
where the format has them, and splits once they exist. What the format
cannot carry is asserted *absent*, so a writer that invents a reconciliation
status fails the test rather than passing it.

The two halves check each other: a reader that silently normalises something
and a writer that silently drops it would cancel out in a round trip, so each
format's tests also run against the committed fixtures from real files, where
there is no writer involved to hide the error.

## `exchange.service`

Other plugins — a report that exports its own rows, a future archive
format — use this rather than reaching for the formats themselves.

```ts
export interface ExchangeService {
  /** Every usable format descriptor, in dialog order. */
  formats(): ExchangeFormatDescriptor[]

  /** Reads a file into the neutral model. No book is touched. */
  read(path: string, options?: { formatId?: string }): Promise<ExchangeDocument>

  /**
   * Resolves accounts, applies payee rules, and matches against the book: everything the review view needs, and
   * nothing written. The expensive half of an import, and the half worth testing.
   */
  plan(document: ExchangeDocument, options?: PlanOptions): Promise<ImportPlan>

  /** Writes a plan, as edited by the user, in one storage transaction. */
  apply(plan: ImportPlan, decisions: ImportDecisions): Promise<ImportBatch>

  /** Takes a batch back out. `confirm: ['reconciled']` is needed if it touched a reconciled row. */
  undo(batchId: string, options?: { confirm?: Confirmation[] }): Promise<UndoResult>

  /** Past imports, most recent first. */
  history(filter?: { accountId?: string, limit?: number }): Promise<ImportBatch[]>

  /**
   * Candidates for the Change… dialog: the account's transactions that no row of this plan has claimed, best
   * first. `key` names the row being matched, so its own current match is included and marked.
   */
  candidates(plan: ImportPlan, key: string, filter?: CandidateFilter): Promise<MatchCandidate[]>

  export(request: ExportRequest): Promise<ExportResult>

  readonly payeeRules: PayeeRuleDirectory
  readonly onDidChange: Event<ExchangeChange>
}

export interface ImportPlan {
  document: ExchangeDocument
  /** One per statement in the document, in file order. */
  statements: PlannedStatement[]
  /** What `plan` could not settle: an unresolved account, an unanswered question. */
  questions: ExchangeQuestion<unknown>[]
  warnings: ExchangeWarning[]
}

export interface PlannedStatement {
  /** The statement this came from, by index. */
  index: number
  /** The account it will land in, or what has to happen first. */
  target:
    | { kind: 'existing', accountId: string, matchedBy: 'link' | 'number' | 'name' | 'user' }
    | { kind: 'create', input: AccountInput }
    | { kind: 'unresolved' }
  rows: ProposedRow[]
  /** The statement's ledger balance against what the account will hold after the import. */
  reconciles?: { statement: number, projected: number, difference: number }
}

export interface ProposedRow {
  /** Stable within the plan, so the view can key on it, and stable across a re-plan. */
  key: string
  incoming: ExchangeTransaction
  disposition: 'new' | 'duplicate' | 'merge' | 'conflict'
  /** For 'merge', 'conflict' and 'duplicate': the transaction in the book. */
  existingId?: string
  /** How this row reached its disposition. 'user' rows survive a re-plan untouched. */
  matchedBy: 'externalId' | 'heuristic' | 'none' | 'user'
  /** Why, in the user's words: 'Same bank reference', 'Same amount, 3 days apart', 'Matched by you'. */
  reason: string
  /** After the payee rules: what will actually be written. */
  draft: TransactionDraft & { externalId?: string }
  /** The rule that renamed the payee, if one did. */
  appliedRule?: { id: string, from: string }
  /** The other half of a detected transfer, by key. */
  transferWith?: string
}

/** A row's state in the review. The plan proposes; this is what the user decided. */
export interface RowDecision {
  /** Accepted: write it, and mark the resulting transaction 'electronic'. Unaccepted rows are skipped. */
  accepted: boolean
  /**
   * The user's match, overriding the matcher. `null` detaches a match the matcher made, so the row becomes
   * 'new'; a transaction id merges into that row instead. Set by the Change… dialog.
   */
  matchTo?: string | null
  /** A corrected payee, a chosen category, an edited memo. */
  edit?: Partial<TransactionDraft>
}

/** What the user did in the review view. Everything else comes from the plan. */
export interface ImportDecisions {
  /** By row key. A row with no entry is unaccepted and will not be written. */
  rows: Record<string, RowDecision>
  /** Answers to the plan's questions. */
  answers: Record<string, Json>
  /** Rules to write from "always rename this". */
  newRules: Omit<PayeeRule, 'id' | 'rev'>[]
  /** Create the categories the document carried. Default false. */
  createCategories?: boolean
  /** Remember the account link. Default true. */
  rememberLinks?: boolean
}

export interface MatchCandidate {
  transaction: Transaction
  /** 0–1, for ordering. The dialog shows the reason, not the number. */
  score: number
  /** 'Same amount, 2 days earlier', 'Same cheque number', 'Same amount'. */
  reason: string
  /** This is the row's current match. */
  current?: boolean
  /** Accepting this one needs confirmation: it is reconciled, or its amount differs. */
  caution?: 'reconciled' | 'amountDiffers'
}

export interface CandidateFilter {
  /** Free text over payee, memo and number. */
  search?: string
  /** Default: the row's date ± 30 days, widened by the dialog's "show all" toggle. */
  range?: { from?: string, to?: string }
  /** Default true: hide transactions another row of this plan has claimed. */
  unmatchedOnly?: boolean
  limit?: number
}
```

`read` → `plan` → `apply` as three calls, rather than one `import(path)`, is
what lets the review view exist, lets a test drive each stage with a
hand-built input, and lets a future import-without-review option accept every
row of the plan and call `apply` directly.

### Errors

`ExchangeError`, in the shape `AccountsError` already uses — a `code`, an
optional `field`, tested with `isExchangeError` because every plugin bundles
its own copy of the package:

| Code | When |
|---|---|
| `NO_BOOK` | No book is open |
| `READ_ONLY` | The book was opened read-only |
| `UNKNOWN_FORMAT` | No descriptor claimed the file |
| `UNREADABLE` | The file is that format but is malformed beyond recovery; the message names the line |
| `EMPTY` | The file parsed but held no transactions |
| `ACCOUNT_UNRESOLVED` | `apply` was called with an unresolved target |
| `CURRENCY_MISMATCH` | The statement's currency is not the account's |
| `ANSWER_REQUIRED` | `apply` was called with a question unanswered |
| `BATCH_NOT_FOUND` | `undo` named a batch that is not there |
| `ALREADY_UNDONE` | That batch has been undone |
| `CONFIRMATION_REQUIRED` | `undo` would touch a reconciled transaction; `reasons` says so |
| `NOT_WRITABLE` | The chosen format has no writer |
| `TOO_LARGE` | Beyond the row limit (an option, default 100,000) |

## Storage schema (`exchange`)

Schema version 1, four collections, all prefixed `exchange.` as
`book.session.database(contributor)` requires:

```ts
export const EXCHANGE_SCHEMA: SchemaContribution = {
  id: EXCHANGE_PLUGIN_ID,
  version: EXCHANGE_SCHEMA_VERSION,
  migrator: EXCHANGE_MIGRATOR_SERVICE,
  collections: [
    {
      name: EXCHANGE_COLLECTIONS.batches,       // 'exchange.batches'
      indexes: [
        { name: 'byDate', fields: ['importedAt'] },
        { name: 'byFile', fields: ['fileHash'] }
      ]
    },
    {
      name: EXCHANGE_COLLECTIONS.links,         // 'exchange.links'
      // One link per (format, bank, account number) — re-answering replaces it
      indexes: [{ name: 'uniqueSource', fields: ['formatId', 'bankId', 'numberKey'], unique: true }]
    },
    {
      name: EXCHANGE_COLLECTIONS.rules,         // 'exchange.rules'
      indexes: [{ name: 'byOrder', fields: ['order'] }]
    },
    {
      name: EXCHANGE_COLLECTIONS.profiles,      // 'exchange.profiles'
      // A CSV profile, or a QIF dialect answer, keyed by the file's shape
      indexes: [{ name: 'byFingerprint', fields: ['formatId', 'fingerprint'], unique: true }]
    }
  ]
}
```

The migrator at `from === 0` seeds nothing: a book with no imports has no
rules, no links and no history, and an empty list is the correct starting
state.

**`exchange.batches` grows.** One document per import, each holding an array
of ids. A user importing weekly for ten years has about 500 of them; the
`created` arrays are the bulk, and a 200-row import is a 200-element array of
ULIDs — roughly 6 KB. That is acceptable, but the option
`exchange.history.keep` (default 100) trims batches beyond the limit on
apply, oldest first, which also bounds how far back *Undo* can reach. Trimmed
batches are deleted, not emptied: a batch you cannot undo is not worth
keeping.

## The import review view

A main-area view (`exchange.review`), revealed by the import command, with
the layout controller's `shell.main` slot. It is the screen the whole feature
is judged on, so it is specified fairly tightly.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Import — statement.qfx  ·  QFX  ·  RBC                             [ ✕ Cancel ]│
│ Chequing ····6789  →  [ Chequing            ▾ ]  ☑ Remember this account       │
│ 1 Nov – 30 Nov 2026 · 42 read · 38 new · 3 already here · 1 matches a row      │
│ matching within 3 days                                                         │
├───────────────────────────────────────────────────────────────────────────────┤
│ ⚠ 3 investment transactions were skipped: Tessera has no investment            │
│   accounts yet.                                                        [ Why? ]│
├───────────────────────────────────────────────────────────────────────────────┤
│    Date       Number  Payee               Category       Amount  What          │
│ ✓  03/11/2026 1042    Hydro Ottawa    ▾   Utilities: … ▾ -142.00  New          │
│    05/11/2026         The Daily Grind ▾   Food: Dining ▾   -4.50  New          │
│                                                         [ Accept ] [ Change… ] │
│ ⊘  07/11/2026 1038    ̶R̶o̶g̶e̶r̶s̶             Utilities: … ▾  -89.99  Already here  │
│    08/11/2026 1041    Canadian Tire   ▾   (keep Hardware) -56.20  Matches 8 Nov│
│                                                         [ Accept ] [ Change… ] │
│    12/11/2026         Payroll         ▾   Salary       ▾ 2140.00  New          │
├───────────────────────────────────────────────────────────────────────────────┤
│ Statement balance 4 182.11 · after import 4 182.11 · difference 0.00  ✓        │
│ [ Accept All ] [ Accept New ]      1 of 42 accepted        [ Import 1 ]        │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Accepting a row

Each row carries **Accept** and **Change…**, shown on the focused or hovered
row and always present on the selected one.

**Accept** confirms the matcher's proposal *whatever it is* — "yes, this is a
new transaction" and "yes, this is the cheque I typed on the 2nd" are the
same gesture, because from the user's point of view both are the same
decision: *I have looked at this line of my statement and I agree with what
Tessera is going to do with it.* An accepted row shows a tick in the gutter,
and what accepting means per disposition:

| Disposition | Accepting it does | Status afterwards |
|---|---|---|
| `new` | Creates the transaction | `E` |
| `merge` | Updates the matched transaction, adopting the `externalId` | `E` |
| `conflict` | Applies the bank's restatement to the matched transaction | `E` |
| `duplicate` | Nothing is written — the transaction is already there | Unchanged |

Rows are not accepted by default. A statement where every line is `new` would
be forty clicks, so **Accept All** and **Accept New** in the footer do it in
one, and the common monthly case is: press *Accept New*, look at the two rows
that matched something, accept or change each, press *Import*. Nothing is
pre-accepted, because a default-accepted screen is a screen people press
through without reading, and this one is worth reading.

Accepting is reversible until *Import*: clicking **Accept** again releases
the row, and `Escape` cancels the whole review having written nothing.

### Matching by hand

**Change…** opens `exchange.dialog.match`, a modal over the review:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Match a Statement Line                                              │
│                                                                     │
│ From the statement:  8 Nov 2026 · 1041 · CANADIAN TIRE #241 · -56.20│
│                                                                     │
│ Transactions in this account                       [ Find…       ]  │
│  ☐ 15 Jan 2026         Long ago               -12.00   Reconciled   │
│  ⋮                                                                  │
│  ☐ 02 Nov 2026         Hardware store         -56.20   Uncleared    │
│  ☑ 06 Nov 2026  1041   Canadian Tire          -56.02   Uncleared    │
│                        current match                                │
│  ☐ 08 Nov 2026         Hydro Ottawa  (greyed: matched to another    │
│                        line on this statement)                      │
│                                                                     │
│ Once accepted, the statement is taken as correct: this changes its  │
│ date from 6 Nov to 8 Nov and its amount from -56.02 to -56.20.      │
│                                                                     │
│                                  [ Cancel ]  [ Match ]              │
└─────────────────────────────────────────────────────────────────────┘
```

- **The statement line is pinned at the top**, as the file wrote it — the
  original payee, not the renamed one — because the user is deciding whether
  two things are the same thing, and the renamed version hides the evidence.
- **The whole account register is listed**, in date order, opening at the
  current match or the transaction nearest the statement line's date, with
  a *Find* box over payee, memo, number, date and amount. The plan already
  carries the register (`PlannedStatement.register`), so the dialog asks
  the main process for nothing.
- **Each transaction has a tick box.** The current match starts ticked; an
  unmatched line starts with nothing ticked. Ticking one unticks any other,
  and unticking leaves the line unmatched. The button says which:
  **Match** or **Leave Unmatched**.
- **A transaction another line of this import is matched to is labelled,
  not greyed**, and can be chosen: the match moves to this line, and the
  other line is left unmatched (and unaccepted), since two statement lines
  cannot be one transaction. The dialog says so before confirming. Only
  transactions an **earlier** import already matched to a bank transaction
  are greyed, with why.
- **What matching will change is spelled out** before the user confirms:
  the statement is the source of truth, so the transaction takes the
  statement's date, amount and payee when the import is applied.
- **Choosing is not accepting.** The dialog closes, the review shows the
  new match beside the line, and the line is *unaccepted* — released, if it
  had been accepted, since what was accepted has changed. The user accepts
  it with the line's own **Accept**, like any other proposal. Confirming the
  match a line already had changes nothing.

### The rest of the screen

- **The header** names the file, the format and the dialect — a user who
  imported a QIF as the wrong dialect needs to be able to see that without
  starting again — and holds the account drop-down. Changing the account
  re-plans; manual matches for rows whose account did not change are kept, and
  the user is told if any had to be dropped. It also states the matching
  window in force — *matching within 3 days* — as a link to that setting, so
  the one knob worth turning is found where it is wanted rather than hunted
  for ([Tuning the matching](#tuning-the-matching)).
- **The difference line** is the quietly most valuable thing on the screen.
  It compares the statement's ledger balance with what the account will hold
  once the accepted rows are written. Zero means the statement and the
  register now agree. Non-zero, shown in the warning colour, means something
  is missing or doubled, *before* a single row has been written — and while
  rows are still unaccepted it is the signal that there is work left. Formats
  with no balance (QIF, most CSV) omit the line rather than showing a
  meaningless zero.
- **A row** is editable in place: payee (with the register's own autocomplete,
  so an import cannot invent a near-duplicate payee the user already has),
  category, and memo. The *What* column carries the disposition and its reason
  as a tooltip; `merge` and `conflict` rows name the transaction they matched
  and offer *Show in register*. `duplicate` rows are struck through and have
  no **Change…**: the transaction is already in the book under this exact bank
  id, and there is nothing to decide.
- **Edits are local** until *Import*. Cancel discards them, having written
  nothing, with a confirmation if anything was accepted or edited.
- **Keyboard:** `↑`/`↓` move, `Space` or `Enter` accepts the focused row,
  `Ctrl+Enter` opens **Change…**, `Ctrl+A` accepts all, `Escape` cancels. The
  grid follows the register's keyboard map so it is one set of habits, not
  two.
- **The statement over the register.** The grid is the statement laid
  over the register it lands in, in date order. A row with a match carries
  the register's transaction on a second line directly beneath it — date,
  number, payee, category, amount, status — with whatever differs from the
  statement picked out (*2 days earlier*, a different payee, a different
  amount), because the decision is made on the differences. The rest of the
  account's register — all of it, not just the statement's dates — is shown
  greyed among the rows as *Register only*, so the review is the register
  with the statement laid over it, and a transaction the matcher missed is
  in plain sight. The plan carries both (`ProposedRow.existing`,
  `PlannedStatement.register`). The line being worked on is kept scrolled
  into view.
- Apply honours a Change… choice directly: `matchTo` wins over the
  matcher's disposition, with no re-plan in between.
- **Afterwards** the account's register is opened, so the import ends where
  its transactions landed; the Import view keeps the result banner — *42 read, 38
  imported, 1 updated, 3 already here, 0 skipped* — with **Undo** and **Open
  register**. (Selecting the written rows in the register needs a way to
  select by id that the register does not have yet.) The banner does **not**
  offer to start a reconciliation; see [decision 4](#decisions).

### Progress and size

**The routine case is small and getting smaller.** A month's statement is
tens of rows; a year is hundreds to low thousands; and once **archiving**
lands, an open book holds roughly a year rather than a lifetime, so the
working set an import is matched against stays small too. The per-row cost of
the review — a button pair, an editable payee — is affordable at that scale,
and the Accept/Change design assumes it.

**One case is large, and it is the important one**: the migration import, a
whole-book Microsoft QIF out of Money carrying twenty years at once. It
happens once per user, on their first day, and it is the moment they decide
whether to keep going. So reading, planning and applying run in the
privileged half with `progress` pushed to the view — a determinate bar and a
*Cancel* that aborts between records (reading) or rolls back (applying) — the
grid is windowed, and `maxRows` (100,000) is the backstop. The register's own
windowing work on [todo.md](todo.md) should land first and be shared.

For that import specifically, **Accept All** is the expected gesture: there
is nothing in an empty book to match against, so every row is `new`, every
disposition is uninteresting, and the per-row flow would be absurd. The view
notices this — an empty target account and no `merge` rows — and says so,
putting *Accept All* first.

## The export dialog

A `shell.dialogs` contribution (`exchange.dialog.export`), because it is one
modal question and not a workspace:

- **What:** the selected account, its sub-book, or the whole book — defaulted
  from the navigator's selection.
- **When:** All dates, This year, Last year, or a from/to pair.
- **Format:** the writable descriptors only, with the format's own options
  appearing beneath it (the QIF flavour; the CSV delimiter and BOM).
- **Include:** categories, voided transactions, cleared only.
- **Where:** a path from `shell.files.showSaveDialog`, defaulting to the
  documents folder and a name like `Chequing 2026.qif`.

It closes with an `ExportDialogResult` — an `ExportRequest` bar its path,
since only the privileged side can open a save dialog — and the result is a
message naming the file with *Show in folder*. The save dialog comes **after**
the format question, so cancelling at the format step never asks the user to
name a file, and cancelling the save never writes one.

### `exchange.exportOptions`: a format's own questions

The `exchange` plugin owns the dialog, because *what to export, over what
period, and what to leave out* are the same questions whatever the format, and
a dialog per format would be four dialogs to keep consistent. What differs is
the handful of choices only one format has, and those are contributed:

```ts
export const EXPORT_OPTIONS_POINT = 'exchange.exportOptions'

export type ExportOptionField =
  | { kind: 'choice', key, label, detail?, options: { value, label, detail? }[], default }
  | { kind: 'boolean', key, label, detail?, default }
  | { kind: 'text', key, label, detail?, default, maxLength? }

export interface ExportOptionsContribution {
  /** The descriptor these belong to: 'exchange-qif.qif'. */
  formatId: string
  fields: ExportOptionField[]
}
```

The dialog renders the chosen format's fields beneath the format drop-down and
returns their values as `ExportRequest.formatOptions`, which is what reaches
`ExchangeFormat.write` as `WriteContext.options`.

Three things this settles:

- **Data, not a renderer module.** A format plugin is privileged-only —
  `exchange-ofx`, `exchange-qif` and `exchange-csv` ship no renderer bundle at
  all — and requiring one just to offer a checkbox would be a large cost for a
  small thing. Data can also be validated before any plugin code runs, which
  is why `ExchangeFormatContribution` is data too.
- **A closed set of three shapes.** Everything a writer has actually needed is
  a choice, a switch or a short piece of text. A richer vocabulary is a licence
  to put a form in front of a user who only wants a file.
- **The point is optional, and asking nothing is a position.** OFX contributes
  no fields, so no section appears for it. The values are also resolved
  server-side against what the format declared — unknown keys dropped, a value
  of the wrong shape replaced by the default — so a writer can trust
  `context.options` without re-validating, and a caller of `exchange.export`
  that passes no options still gets that format's own defaults rather than
  nothing.

## Options

Namespace `exchange`, through `context.options`
([options-framework-design.md](options-framework-design.md)), with a page at
**Tools ▸ Options ▸ Import and export** — contributed to
`shell.options.pages` as `./OptionsPage`, the first options page any plugin
has.

**Every option here is about reading a file.** What a file is *written* as —
the QIF flavour, the CSV separator and BOM — belongs to the export dialog,
where the choice is per-export and the user is looking at the thing they are
exporting; see [`exchange.exportOptions`](#exchangeexportoptions-a-formats-own-questions).

```ts
interface ExchangeOptions {
  import: {
    /**
     * Days either side for a near match; 0 means same-day only. The default for every source, overridden per
     * account by `AccountLink.dateWindow` where a bank is slower or faster. See Tuning the matching.
     */
    dateWindow: number
    /** Merge a bank row into an uncleared one the user typed. */
    mergeManualEntries: boolean
    /** When merging, take the bank's memo and number. */
    adoptBankDetail: boolean
    /** Apply payee rules. */
    applyRules: boolean
    /** Offer "always rename this" after a payee edit. */
    learnRules: boolean
    /** Create categories a file defines. */
    createCategories: boolean
    /** Refuse a file with more rows than this. */
    maxRows: number
    /** The folder the open dialog starts in; empty means Documents. */
    defaultFolder: string
  }
  history: {
    /** Batches kept per book; older ones are trimmed and can no longer be undone. */
    keep: number
  }
  qif: {
    /** The dialect to assume when the file is ambiguous. */
    dialect: 'standard' | 'microsoft'
    /** 'auto' infers from the file and asks when it cannot. */
    dateOrder: 'auto' | 'DMY' | 'MDY' | 'YMD'
  }
  ofx: {
    /** 'asGiven' | 'invert' | 'fromType'; the default for a new link. Saved per link once answered. */
    signs: 'asGiven' | 'invert' | 'fromType'
  }
}
```

The defaults are the values above read conservatively: `dateWindow: 3`,
every boolean in `import` true except `adoptBankDetail`, `keep: 100`,
`dialect: 'microsoft'`, `dateOrder: 'auto'`, `signs: 'asGiven'`,
`maxRows: 100000`.

**Every option here is about reading.** The write-side settings this section
once listed — the QIF flavour, the CSV delimiter and BOM, the OFX version —
are not options, for three different reasons. The first two are contributed
fields on the export dialog now, and having them in both places would be two
sources of truth for one value. The OFX version is gone entirely: Tessera
writes 2.x only. And a per-export choice genuinely belongs to the export, not
to the application — the user exporting a semicolon CSV for a colleague this
morning is not saying anything about next month.

(Remembering the last choice *per format*, so the dialog reopens where it was
left, would be a reasonable later nicety. It would be export-dialog state, not
an option page.)

Two things are deliberately **not** options:

- **Whether an accepted row becomes `E`.** It is what accepting means, and a
  switch that made Accept sometimes mean "write it but leave it uncleared"
  would make the button's label a lie.
- **Whether rows start accepted.** They do not, and offering to change that
  is offering to turn the review into a formality.

And three things are not options because they belong to the **book**, not the
application: payee rules, account links and format profiles
([decision 10](#decisions)).

### Tuning the matching

**Yes to a page, no to a tuning panel.** The options page above is where
matching is adjusted, and the four settings that touch it —
`dateWindow`, `mergeManualEntries`, `adoptBankDetail` and `applyRules` — are
the whole of it. It should not grow into a panel of weights and thresholds,
for one reason above all:

> **The user has no feedback loop.** Changing a scoring weight and finding
> out whether it helped means importing a statement again, and the statement
> you want to test against is the one you already imported. A knob whose
> effect cannot be observed is not a setting, it is a wish.

So the three ways matching gets better are, in order of how much they
matter:

1. **Change… , per row.** The user's real lever. It is immediate, visible,
   scoped to the one row that is wrong, and it needs no understanding of how
   the matcher works. Every "the matcher got this wrong" is answered here.
2. **`dateWindow`, per source.** The one knob a user can genuinely reason
   about, because they know their own bank: one posts overnight, another
   takes four days. That is why it is on `AccountLink` as well as in the
   options — a global number is the wrong shape for a quantity that varies by
   bank, and a user with a fast bank and a slow one cannot express that with
   a single value.

   **As built:** the override is set in **File ▸ Statement Sources…**, one
   line per linked source with its account, format and last import, a
   *Days either side* box whose placeholder is the option's value (blank
   means "use the option"), and *Forget* — which is also the first UI the
   link has ever had for being removed. `dateWindowFor` reads it in
   matching, through the same `linkForSource` predicate account resolution
   uses, and only when the link points at the account the statement was
   filed in. The range is the option's own (`isDateWindow`, 0 to
   `MAX_DATE_WINDOW`), and `rememberLink` refreshing a link keeps it.

   *Not built:* this note once had the review view show the window in force
   as a link to the setting, so the knob was found at the moment it was
   wanted. Phase 3 replaced the review view with the register, and the
   register's overlay row has no such label yet.

   *Change… is deliberately left on the option's window.* It lists every
   transaction regardless, the row's current match is always pinned first,
   and the loose and exact scores are not on one scale — so widening its
   window by a source's override changes nothing a user could see, and can
   even rank a match a little lower.
3. **The matcher's own code, informed by `ImportBatch.manualMatches`.**
   Scoring weights, the payee-compatibility rules and the prefix length
   belong here, not in the UI. The batch records how often the user had to
   override the matcher, which is the measurement that should drive changing
   them — and it is a far better signal than any individual's guess at a
   threshold.

What a tuning panel would really be is a way of making the user responsible
for the matcher's quality. If `manualMatches` is routinely high, that is work
for us, not a slider for them.

## Commands, menus and context keys

| Command | Enablement | Menu |
|---|---|---|
| `exchange.import` | `book.isOpen && !book.isReadOnly` | File ▸ Import ▸ **Statement or Data File…** |
| `exchange.importInto` | `accounts.selection.kind == 'account' && !accounts.selection.isClosed` | Accounts navigator context menu, *Import Into This Account…* |
| `exchange.export` | `book.isOpen` | File ▸ Export ▸ **Transactions…** |
| `exchange.exportAccount` | `accounts.selection.kind == 'account'` | Navigator context menu, *Export This Account…* |
| `exchange.history` | `book.isOpen` | File ▸ Import ▸ **Import History…** |
| `exchange.undo` | `exchange.canUndo` | Import History, and the result banner |
| `exchange.rules` | `book.isOpen && !book.isReadOnly` | File ▸ Import ▸ **Payee Rules…** |
| `exchange.cancel` | `exchange.importing` | The review view's Cancel |

Both menus are groups in **File**: `exchange.import` and `exchange.export`,
below the book's group and above Exit, declared by `exchange` so the
separators exist whether or not a format plugin is installed. The two
navigator items come through `accounts.navigator.items` —
except that point places *rows*, not context-menu items, so
`exchange.importInto` and `exchange.exportAccount` use
`accounts.reconcile.actions`' sibling for account-scope context items. This
is the fifth bespoke point of the same shape, and
[todo.md](todo.md) already says a fifth should trigger replacing them with
one `shell.contextMenus`. **This design takes that as its trigger**: see the
prerequisites in [Phases](#phases).

| Context key | Set by | Meaning |
|---|---|---|
| `exchange.importing` | `exchange` | A review is open and unapplied |
| `exchange.canUndo` | `exchange` | The most recent batch in this book can still be undone |
| `exchange.formats.count` | `exchange` | How many usable formats are installed; 0 greys the import item with a tooltip saying why |

## IPC and events

Channels are `exchange:<event>`, by the convention `channelFor` encodes.

```ts
export const EXCHANGE_CHANNELS = {
  /** `{ formatId? }` → `ExchangeResult<{ path, document }>`. Opens the file dialog when no path is given. */
  read: channel('read'),
  /** `{ document, options? }` → `ExchangeResult<ImportPlan>`. */
  plan: channel('plan'),
  /** `{ plan, decisions }` → `ExchangeResult<ImportBatch>`. */
  apply: channel('apply'),
  /** `{ batchId, confirm? }` → `ExchangeResult<UndoResult>`. */
  undo: channel('undo'),
  /** `{ accountId?, limit? }` → `ImportBatch[]`. */
  history: channel('history'),
  /** `ExportRequest` → `ExchangeResult<ExportResult>`; prompts for the path when it has none. */
  export: channel('export'),
  /** → `ExchangeFormatDescriptor[]`. */
  formats: channel('formats'),
  /** `{ key, filter? }` → `MatchCandidate[]`, for the Change… dialog. Against the plan the main process holds. */
  candidates: channel('candidates'),
  /** `{ id, answer }` → void: the view answering a plan's question. */
  answer: channel('answer'),
  /** → `PayeeRule[]`, and `{ rules }` → `ExchangeResult<void>` to replace the list. */
  rules: channel('rules.list'),
  saveRules: channel('rules.save')
} as const

export const EXCHANGE_DIALOGS = {
  /** Input `ExportDialogInput`, result `ExportRequest`. */
  export: 'exchange.dialog.export',
  /** Input `MatchDialogInput`, result `MatchDialogResult` — the Change… dialog. */
  match: 'exchange.dialog.match',
  /** Input `CsvProfileInput`, result `CsvProfile`. */
  csvProfile: 'exchange.dialog.csvProfile',
  /** Input `{ rules }`, result `{ rules }`. */
  rules: 'exchange.dialog.rules',
  /** Input `{ batches }`, result `{ undo?: string }`. */
  history: 'exchange.dialog.history'
} as const

/** What Change… is given, and what it closes with. `matchTo: null` means "leave it unmatched". */
export interface MatchDialogInput {
  planId: string
  row: ProposedRow
  accountId: string
  currency: string
  register: RegisterLine[]          // the whole account
  currentId?: string                // starts ticked
  taken: Record<string, string>     // greyed, with why
}

export interface MatchDialogResult {
  matchTo: string | null
  match?: RegisterLine
}

export const EXCHANGE_EVENTS = {
  /** `{ phase: 'reading'|'planning'|'applying', done, total }`. */
  progress: channel('progress'),
  /** `ImportPlan`: a re-plan after the user changed the account or an answer. */
  plan: channel('plan.changed'),
  /** `ImportBatch`: an import was applied; the register reloads through `accounts`' own event. */
  imported: channel('imported'),
  /** `{ batchId }`. */
  undone: channel('undone')
} as const
```

Everything the user can cause fails as an `ExchangeResult`, never a rejected
promise, so the view renders a message rather than an error boundary —
the same contract `AccountsResult` already establishes.

The review view does **not** push every acceptance or edit over IPC. The plan
goes to the renderer once, decisions accumulate there as an
`ImportDecisions`, and `apply` sends them in one message. A 40,000-row plan
is large for a structured clone, so `plan` returns rows in pages of 5,000
with the view requesting more as it scrolls.

`candidates` is the exception that has to be a round trip: it queries the
register, which the renderer does not hold, and it is asked only when the
user opens **Change…** — once per row they are unsure about, not once per
row. The main process keeps the current plan so the channel can take a row
key rather than the whole plan, and so it knows which transactions other rows
have already claimed.

## Changes to `accounts`

Four, all small, all independently useful, and three already on
[todo.md](todo.md):

1. **`externalId` on `TransactionDraft`** (todo.md, "Register, later"). The
   field exists on `Transaction` and has its unique index; the draft cannot
   set it. Without this, import cannot write a bank id, and duplicate
   suppression does not work at all.
2. **`TransactionManager.createMany(drafts, options?)`.** Creating 20,000
   transactions one call at a time means 20,000 payee lookups and 20,000
   storage round trips. `createMany` resolves the payees once, writes in one
   storage transaction, and returns the created rows in order. Transfers
   within the batch are paired in the same transaction. This is the
   difference between an import that takes a second and one that takes
   several minutes.
3. **`Transaction.splits`** (reserved in the model today). QIF and OFX both
   carry splits and both are common. Until it is real, a split transaction
   imports as a single row whose memo names the split lines, and the review
   view marks it — visible and honest, rather than silently flattened to the
   first category. Full split import is phase 6.
4. **An account-scope context-menu point.** Covered by the
   `shell.contextMenus` prerequisite above; until that lands, `exchange`
   contributes to `accounts.reconcile.actions` with `scope: 'account'`, which
   works and is ugly.

Nothing else in `accounts` changes. In particular the matcher reads through
`transactions(accountId).list({ from, to })` and writes through the service,
so every rule about closed accounts, transfers, currencies and reconciled
rows applies to an import exactly as it does to a user typing.

## Importing into a book with an archived period

Archiving closes the old period for each account by advancing its
`openingDate`. An imported statement wholly before that date is stopped before
review. If it straddles the date, rows in the archived period are excluded by
default and identified in the review; the user can include them only after a
confirmation that explains the archive boundary and the resulting change.
Accepting earlier rows moves the account's opening date back to the earliest
accepted transaction without changing its opening balance.

The boundary is enforced by `accounts.service`, not just by the importer, so
creating or editing a transaction through the register, an import or a
recurring entry follows the same rule. This prevents a second copy of an
archived transaction from silently appearing in the working book. See
[The archived period is closed](archive-design.md#the-archived-period-is-closed)
for the archive contract and edge cases.

## The anonymiser: `scripts/anonymize-statement.mts`

Parsers are only as good as their fixtures, and the best fixtures are real
files — real banks produce quirks nobody invents. The problem is that a real
file is a dossier: name, address, account number, card number, employer,
landlord, pharmacy, where you had coffee on a Tuesday. This script is what
makes the first possible without the second.

```bash
npm run anonymize -- private/rbc-nov.qfx tests/fixtures/exchange/ofx/rbc-chequing.qfx
npm run anonymize -- --seed-file .anon-seed --report report.json private/td.qif out.qif
npm run anonymize -- --check tests/fixtures/exchange/              # re-verify what is committed
```

### The principle: default deny

A scrubber that walks a file replacing the fields it knows about will leak,
because real files contain fields nobody anticipated — an `<EMAIL>` tag in a
bank's OFX extension, a seventh CSV column, a QIF `A` address line. One
unanticipated field is one leak, and the leak is silent.

So the script inverts it. It **parses** the file into a token stream, and
every token is routed by an explicit policy:

| Policy | Meaning | Applied to |
|---|---|---|
| `structural` | Emitted unchanged | Tag names, control lines, delimiters, `^`, the header block's keys |
| `enum` | Checked against a fixed allowed set; anything else becomes the set's default and is reported | `TRNTYPE`, `ACCTTYPE`, `SEVERITY`, `CURDEF`, a QIF `C` flag |
| `synthetic` | Replaced by a generated value of the same shape | Account numbers, FITIDs, payees, memos, names, cheque numbers |
| `shifted` | Transformed by a consistent rule | Dates, amounts |
| `drop` | Removed entirely, the record left valid | Addresses, phone numbers, emails, `INTU.USERID` |

and **anything with no policy is dropped and counted**. The report lists
every unrecognised token by tag, with a count and never a value, so a
reviewer can see what the tool met and decide whether it needs a rule. A
file that is 90% unrecognised produces a nearly empty output and a loud
report — which is the correct failure, and the opposite of what a
replace-what-I-know scrubber does.

### Determinism without reversibility

Every synthetic value comes from `HMAC-SHA256(seed, fieldKind + ':' + value)`,
truncated and mapped into the right shape. This buys three things at once:

- **Stable within and across runs.** The same payee becomes the same fake
  payee everywhere in the file, and in next month's file too, so a fixture
  pair can test incremental import and duplicate detection.
- **Not reversible.** Without the seed there is no way back, and the seed is
  never written into the output, the report or the repository. It is read
  from `--seed-file` (gitignored) or generated per run and discarded.
- **No mapping table on disk.** `--mapping <path>` exists for debugging a
  parser and refuses to write anywhere inside the repository.

### What each field becomes

| Field | Becomes |
|---|---|
| Account number (`ACCTID`, QIF `!Account` N, a CSV column) | Digits of the same length, same leading-zero shape. If the original passes Luhn, so does the replacement — some parsers check |
| Routing / `BANKID` | A valid-looking 9-digit routing number from a reserved test range |
| `FITID` | Same length and character class. Many banks derive it from the account number, so it is never passed through, even though it looks opaque |
| `INTU.BID`, `FID`, `ORG` | A fixed fictional institution — `Example Bank` / `9999` — because the bank identifies the user's region and often their employer's payroll provider |
| `INTU.USERID`, `USERID`, any `<EMAIL>`, `<PHONE>`, address lines, QIF `A` | Dropped |
| Payee | A stable fake from a built-in corpus of ~400 plausible merchant names, chosen by HMAC. **The shape is preserved**: a `SQ *` prefix stays a `SQ *` prefix, a trailing store number stays a (different) trailing store number, an ALL-CAPS payee stays ALL-CAPS, and the length class is matched — because those are exactly the quirks the payee rules and the matcher need to be tested against |
| Memo | A fake drawn from a small corpus, or dropped when it does not look structural |
| Cheque number | A different number of the same width, preserving order within the file so a `nextNumber` test stays meaningful |
| Category | Mapped to a category from the repo's own `STARTER_CATEGORIES`, stably, keeping the `Parent : Child` shape and any class suffix |
| Date | **Shifted by one constant offset, a multiple of 7**, so every interval is preserved exactly and every date keeps its weekday — which matters, because a statement's business-day behaviour is a thing tests care about |
| Amount | See below |
| Balance | **Recomputed**, never replaced |

### Amounts

Amounts are the hardest call, and the most tempting to get wrong.

Passing them through is not safe: a recurring $2,140.00 on the 15th is a
salary, and together with a city and an employer-shaped payee it is
identifying. Replacing each with a random number destroys the file's
usefulness — balances stop adding up, and a fixture whose ledger balance does
not match its transactions cannot test the difference line that is the review
view's best feature.

So: each amount is replaced by a **stable synthetic amount in the same
magnitude bucket** (under $10, under $100, under $1,000, and so on), with the
sign preserved and the cents drawn from the same HMAC — so the distribution
still looks like a bank statement and a $4.50 coffee does not become $4,500.
The same source amount maps to the same synthetic amount throughout, so a
repeated charge is still repeated, and the duplicate matcher is still
exercised. Then **every balance in the file is recomputed** from the
synthetic transactions — ledger, available, and the QIF opening-balance
record — so the result is internally consistent and a round-trip test is
meaningful.

`--keep-amounts` exists, for debugging a parser's number handling, and prints
a warning naming the leak and refuses to write into `tests/`.

### The verification pass

This is the part that makes the tool trustworthy, and it runs always, not
only with a flag.

After writing, the script re-reads its own output and fails the run — exit
code 1, no file left behind — if any of these hold:

1. **Any distinct value from the input, of 4 characters or more, appears as a
   substring of the output.** Every input token is collected during parsing
   for exactly this; it catches a field that was accidentally passed through,
   a value that leaked into a different tag, and a policy that was never
   applied.
2. **Any of a set of patterns matches**, whether or not it was in the input —
   a Luhn-valid 13–19 digit run, an email address, an international phone
   number, a Canadian postal code or a US ZIP+4, an IBAN, a SIN or SSN
   pattern, a street-address shape, an `http(s)` URL with a query string.
3. **The output does not parse** as the format it claims to be. A fixture
   that cannot be read is not a fixture.
4. **The structure changed:** a different number of records, statements or
   accounts, or a different set of tags. The output must exercise the same
   code paths as the input or there was no point taking the risk.

`--check <path>` runs tests 2, 3 and 4 over files already committed, without
an input to compare against, and is wired into the test suite as
`tests/fixtures/exchange/fixtures.test.ts` so that a fixture someone added by
hand — or a pattern added to the list later — is caught on every `npm test`.

### The report

`--report <path>` writes JSON with counts and **no values**:

```json
{
  "input": { "format": "exchange-ofx.qfx", "bytes": 48211, "records": 42 },
  "policies": {
    "structural": 318, "enum": 42, "synthetic": 214, "shifted": 84, "drop": 7
  },
  "unrecognised": [ { "tag": "SIC", "count": 42 }, { "tag": "EXTDNAME", "count": 3 } ],
  "verification": { "substringMatches": 0, "patternMatches": 0, "parsed": true, "structureMatched": true },
  "dateShiftDays": "(not recorded)",
  "seed": "(not recorded)"
}
```

The two `(not recorded)` lines are deliberate and should stay: the date shift
plus one known transaction date reverses every date in the file, and the seed
reverses everything.

### Implementation

- `scripts/anonymize-statement.mts`, run by `npm run anonymize`, written the
  way `build-plugins.mts` is: a `.mts` under `ts-node-esm --transpile-only`,
  no new dependency.
- It **reuses the format plugins' readers** through the package's own
  interfaces — `packages/exchange-api` plus the parsers from
  `plugins/exchange.*/src/` — imported directly, so there is one OFX
  tokeniser and one QIF record splitter in the repository, not two. A parser
  bug that would mangle a fixture shows up in the anonymiser too.
- Tokenising for *output* is separate from parsing for *meaning*: the
  anonymiser needs the file's original bytes and layout, not the neutral
  model, so each format plugin additionally exposes a `tokenize(data)` →
  `Token[]` and `detokenize(tokens)` → bytes pair, with
  `detokenize(tokenize(x)) === x` as a property test over every committed
  fixture. That round-trip property is what guarantees the output's structure
  really is the input's.
- The whole thing is tested in `tests/scripts/anonymize.test.ts` over
  synthetic "real" files built in the test, asserting: nothing from the input
  survives; the same input and seed give the same output; a different seed
  gives a different one; the output parses to the same record count; balances
  add up; the date shift preserves weekdays and intervals; an unrecognised
  tag is dropped and reported; and the verification pass fails the run when a
  field is deliberately wired to pass through.

### How it is meant to be used

```
1. Download a statement. Put it in `private/` — gitignored, see below.
2. npm run anonymize -- private/statement.qfx tests/fixtures/exchange/ofx/<bank>-<type>.qfx
3. Read the report. If anything under `unrecognised` looks like it carries
   meaning, add a policy for it and run again.
4. Read the output. The script is a tool, not an authority; a human looks at
   the file before it is committed.
5. Commit the fixture and a test that uses it.
```

Step 4 is not optional and should be in the contributor documentation. No
automated check can tell that a fictional payee happens to be the name of the
contributor's actual employer.

## Keeping personal data out of the repository

The script is one of four layers, and on its own it is not enough.

1. **A gitignored quarantine.** `private/` is added to `.gitignore`, along
   with `*.ofx`, `*.qfx`, `*.qbo`, `*.qif` and `*.csv` **everywhere except
   `tests/fixtures/exchange/`**, so the default for a statement anywhere in a
   working tree is "not committable", and a fixture has to be put in the one
   place that is checked.

   ```gitignore
   # Real financial files never belong in the repository. See docs/import-export-design.md.
   private/
   *.ofx
   *.qfx
   *.qbo
   *.qif
   *.mny
   # Anonymised fixtures are the one exception, and are verified on every test run.
   !tests/fixtures/exchange/**/*.ofx
   !tests/fixtures/exchange/**/*.qfx
   !tests/fixtures/exchange/**/*.qbo
   !tests/fixtures/exchange/**/*.qif
   !tests/fixtures/exchange/**/*.csv
   ```

   (CSV is not ignored outright — the repository may legitimately hold
   unrelated `.csv` files — but `private/**` catches them and the fixture
   check covers the rest.)

2. **The verification pass**, run on every anonymisation and again over every
   committed fixture on every `npm test`, through `--check`.

3. **A pre-commit hook**, offered in `scripts/` and documented rather than
   installed silently, that runs `--check` over the staged files and blocks a
   commit adding a statement-shaped file outside the fixtures folder.

4. **A human read of the diff.** Named in the contributing notes next to the
   step above.

A note worth making explicitly in the contributor documentation: **if a real
file is ever committed, deleting it in a later commit is not enough.** It
stays in the history and in every clone, and the response is to rotate what
was exposed — treat the account number as disclosed — and rewrite the
history. Saying so once, in the place someone will read before they add a
fixture, is cheaper than the alternative.

## The seeded book

Built. `npm run seed:book` writes a book called **Household** and the bank
files that go with it. It exists because the pipeline of phase 1 and the
parsers of phases 2 to 5 both need something to work against, and inventing
a handful of rows per test would not find the problems a book with four
years of history in it does.

```
private/Household.tessera          the book, gitignored and rebuilt in seconds
tests/fixtures/exchange/           the statements, committed
  ofx/personal-chequing-2026-10.ofx    OFX 1.0.2, SGML, Windows-1252
  ofx/personal-chequing-2026-09.ofx    OFX 2.1.1, XML — a month already reconciled
  qfx/personal-visa-2026-10.qfx        QFX, a credit card, with INTU.BID
  qbo/business-chequing-2026-10.qbo    QBO
  csv/personal-savings-2026-10.csv     CSV: debit and credit columns, D/M/Y, a total line
  csv/business-tax-2026-10.csv         CSV: one signed column, ISO dates, a BOM
  qif/personal-chequing-2026-10.qif    QIF, Microsoft dialect: full names, M/D/YYYY, an !Account block, C* marks, Windows-1252
  qif/personal-visa-2026-10.qif        QIF, standard dialect: a credit card, fifteen-character names, M/D'YY
  anonymized/…                         real downloads, anonymised (their own manifest; see Phase A results)
  manifest.json                        what a reader should find in each
```

### What is in it

A household and the small business that supports it, from **January 2023 to
October 2026**, reconciled monthly through **30 September 2026**:

| Sub-book | Account | What happens in it |
|---|---|---|
| Personal | Chequing | Rent, daycare, insurance, utilities, groceries; the owner's draw arrives on the 28th; the surplus is swept to Savings at month end |
| Personal | Savings | The monthly sweep and its interest; a holiday in 2024 and a car repair in 2025 come back out |
| Personal | Visa | Groceries, fuel, dining, a bakery, subscriptions — paid off in full on the 20th, so the card never runs away |
| Business | Business Chequing | Three client invoices a month, software, phone, a quarterly accountant; sets tax aside, then draws what is left above its float |
| Business | Tax Set-Aside | 32% of revenue in each month, and a remittance out to the taxman each quarter |

**The figures hang together.** Every balance is generated with a running
total, so the Visa payment really clears the last statement, the interest
really follows the balance, and the 225 monthly reconciliations all balance
to the cent with no adjustment. The seeder checks the book it wrote against
the generator's own arithmetic before it finishes, and refuses to produce a
book that disagrees with itself. This matters more than it sounds: an
importer tested against a book whose numbers are already wrong makes every
mismatch look like the importer's fault.

**Sweeps, not fixed sums.** The business draws everything above a float and
the household saves everything above its own. The first draft of the
generator moved fixed amounts, and after four years the business had
accumulated two hundred thousand dollars it never spent — arithmetically
fine, and nothing anybody would recognise.

### What makes it worth importing against

October 2026 is the **open month**: the household has entered what it enters
as a matter of routine — the rent, the bills, the transfers — and not the
day-to-day spending. So the statements and the book deliberately disagree,
in all the ways the matcher has to cope with:

- **Rows in the book and on the statement**, which should merge rather than
  double up. On the Visa and the business account most of the month is
  missing, so most rows are new; on the chequing account most are already
  there.
- **Rows posted late.** Every second entry the household recorded in the
  open month is dated one to three days before the bank posted it, which is
  exactly what the matcher's date window exists for. It is every second one
  rather than a random selection on purpose: a seed that happened to stagger
  none of them would quietly stop testing the thing it exists to test.
- **A month that is wholly accounted for.** The September file is the
  already-reconciled month, so importing it should find every row and write
  nothing — and every match is against a reconciled transaction, which is
  the `conflict` path.
- **Transfers with two sides.** The owner's draw and the tax set-aside each
  appear on both accounts' statements, so a user importing both files should
  end with one pair, not four one-sided rows.
- **The business looks wrong until you import.** Its October draw and tax
  set-aside are in the book but its client invoices are not, so the account
  reads $862 instead of its $10,000 float. Importing the QBO puts it right,
  which is a fair demonstration of what the feature is for.

### Format quirks on purpose

The files are written the way banks write them, not the way a tidy exporter
would:

- **OFX 1.0.2 is SGML**: a `KEY:VALUE` header block, a blank line, then a
  tree whose leaf tags are never closed. No XML parser can read it.
- **`ENCODING:USASCII` with `CHARSET:1252` means Windows-1252**, which is
  neither. The files carry `é`, `ô` and a curly apostrophe, so a reader that
  assumes UTF-8 fails on them — and the seeder needed its own cp1252
  encoder to write them, because Node's `latin1` turns that apostrophe into
  a control character and corrupts the file silently.
- **The card is a `CCSTMTRS` with a `CCACCTFROM`**, not a bank statement.
- **QFX and QBO carry `INTU.BID`** and a user id the reader must discard.
- **The two CSVs disagree**: separate debit and credit columns against one
  signed column, `31/10/2026` against `2026-10-31`, a title line and a total
  row against a bare header and a BOM.

### Rebuilding it

```bash
npm run seed:book                      # the book and every statement
npm run seed:book -- --statements-only # just the fixtures
npm run seed:book -- --seed 4321       # a different, still repeatable, household
npm run seed:book -- --book path.tessera
```

It is deterministic: the same seed gives byte-identical files, which is why
the committed fixtures can be checked against the generator on every test
run (`tests/scripts/seed.test.ts`). A fixture someone edited by hand, or a
generator change that did not get the files rewritten, fails there.

The book is written through the real `storage-sqlite` engine, `book.session`
and `accounts.service`, so it is a book the app opens like any other — not a
fixture shaped like one. `node:sqlite` is built into Node, so this needs no
native build and no Electron.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Importers belong to `accounts`**, as `vault-design.md` proposed | That note's reasoning — an imported statement is account data — is right about the *domain* and wrong about the *plugin*. Import needs a view, a dialog, three collections, a history, an undo and its own options; putting that in `accounts` doubles the size of the plugin that everything else depends on. `exchange` requires `accounts.service` and writes only through it, so the domain boundary holds, and `accounts` stays the thing it is |
| **One plugin containing every format** | Fewer manifests and no bundled copies of the contract package. But it makes the format seam notional — the first third-party format would discover it does not work — and it means an OFX bug can break QIF import. The seam is cheap here: a format plugin is a manifest and a parser |
| **One `exchange.format` service rather than descriptors** | A service id has one provider, so only one format could be installed. The descriptor-plus-service pattern is what the framework's one-provider rule requires |
| **Parse straight into `TransactionDraft`** | The neutral model carries what a draft cannot — the bank's id, the original payee beside the renamed one, the file's category *path*, the unsupported records, the source line. Those are precisely what the review view shows |
| **Apply as you parse, streaming** | Needed only for files too large to hold in memory, which a statement never is, and it makes the review view — the feature's main value — impossible. The whole-book case is bounded by `maxRows` instead |
| **Fuzzy amount matching** (within a cent or a percent) | Two transactions with nearly the same amount on the same day are usually two transactions. Being wrong here merges a row the user cannot easily find again, and the failure is silent |
| **Import without a review step**, as some programs offer | Attractive for a monthly OFX where every row is exact. It stays available as an option later, but it cannot be the default while the matcher is new: the review step is how the matcher earns trust, and how the user learns what it does |
| **Tick boxes instead of Accept and Change…** | A tick is ambiguous in exactly the place this screen must not be: it says "include this row" but not "I agree with the match you found", and there is nowhere to put "that match is wrong, here is the right one". Accept names the decision, and Change… gives the disagreement somewhere to go. The bulk buttons recover the tick box's one real advantage |
| **A review that tries harder so manual matching is not needed** | The matcher should be good, and tiers 1–3 are. But a matcher that is nearly always right is still wrong sometimes, and the cost of being wrong with no manual override is a duplicate the user discovers months later. Change… bounds that cost at one dialog |
| **Setting imported rows to `R` (reconciled)** | The bank reporting a transaction is not the user agreeing the statement balances. `E` is the status that means "the bank reported it", `R` belongs to reconciliation, and collapsing them would make the reconcile screen's figures meaningless |
| **Convert OFX times to the local zone** | Moves transactions across day boundaries and therefore across statement boundaries. A statement date is a calendar date |
| **Scrubbing the statement with a regex pass** | The leak is what the regexes do not know about. Parse-and-rebuild under a default-deny policy is the only approach whose failure mode is an empty file rather than a quiet disclosure |
| **A fixed anonymisation mapping checked into the repo**, so fixtures are reproducible by anyone | The mapping is the reversal. Reproducibility is served instead by committing the *output*, which is what the tests use |
| **Faker or a similar library for the synthetic values** | A new dependency in a repository that builds its scripts on nothing but `ts-node`, for a corpus of merchant names a 60-line file provides, and one whose output would not preserve the shapes (`SQ *`, store numbers, ALL CAPS) that the fixtures exist to exercise |

## Risks

| Risk | Mitigation |
|---|---|
| **The matcher is wrong in a way the user does not notice** — a merge that should have been a new row quietly rewrites a transaction | Nothing is written until the row is accepted, one row at a time; an automatic merge never changes the amount, the date or the user's category (only a manual match may change an amount, and only with an explicit tick); every merge names the row it matched and links to it; **Change…** detaches a wrong one; every import is undoable; a reconciled row is never merged into without confirmation |
| **Per-row accepting is tedious** on a forty-row statement, so the user stops reading and presses the bulk button anyway | That is the expected flow and it is fine: *Accept New* is one press, and it leaves exactly the rows that matched something — the ones worth looking at — still needing a decision. The tedium only appears where the attention is wanted |
| **Two statement lines get matched to one register row**, silently dropping one | Claimed transactions are hidden from the Change… dialog by default, and a plan validates before applying that no transaction is the target of two rows |
| **Real files break the parsers** in ways no specification predicts | The anonymiser is the mitigation: it exists so that every bug found against a real file becomes a committed fixture. The parsers are forgiving by design — a malformed record is a warning and a skipped row, not a failed file |
| **A sign convention is backwards** and a user imports a month of inverted transactions | The review view detects an all-one-sign statement and offers the flip before anything is written; the difference line shows a doubled error unmissably; undo exists |
| **The QIF dialect is misdetected** and payees are truncated | Detection for Microsoft is certain, not heuristic (a 16-character name cannot be standard). The other direction's cost is contained: a name read at exactly 15 characters is matched by prefix, so the worst case is a payee shown short, not a split payee list |
| **A whole-book QIF is enormous** and the import appears to hang | Progress events from reading through applying, a determinate bar, cancel, `maxRows`, `createMany`, and a windowed grid |
| **`exchange.batches` grows without bound** | `history.keep`, trimmed on apply |
| **A real statement is committed** | Four layers, above, and the one of them that works without anybody remembering anything is the gitignore |
| **The anonymiser is trusted more than it deserves** | The verification pass fails closed; the report names what it did not recognise; the documented procedure requires a human to read the output; `--check` re-verifies the committed fixtures on every test run |
| **Investment transactions are silently lost** by a user who does not read the banner | They are never silently anything: the count is in the document, the review header, the result banner and the batch. A user whose statement is mostly investments sees that the import is mostly skipped |

## Decisions taken in review

The first draft's six open questions and the second round's three, all
answered 2026-11-16, and what each one changed. Nothing in this note is
open.

**A. Import does not start a reconciliation.** They happen at different
times, and matching a statement against the register is work the import does
in its own right. Instead, **every review row carries Accept and Change…**:
Accept confirms the proposal — match or no match — and marks the resulting
transaction `E`; Change… opens a dialog for picking a different unmatched
transaction to match against. *Changed:* [decision 4](#decisions), the whole
of [The import review view](#the-import-review-view) including the new
[Change… dialog](#matching-by-hand), tier 4 of the matcher, `RowDecision`
and `ImportDecisions`, `candidates` on the service and its channel,
`EXCHANGE_DIALOGS.match`, the removal of the `markElectronic` option, and
three new rows each in Alternatives and Risks.

**B. `.mny` is not read directly — the migration path is Microsoft QIF.**
Money's format is private, so a Money user exports Microsoft-dialect QIF and
imports that. This promotes the whole-book QIF reader from a convenience to
the way users arrive, and closes the question
[vault-design.md](vault-design.md) left open. *Changed:* it moves from a
non-goal "for now" to **not planned**, the whole-book QIF goal says why it
carries the weight it does, [Progress and size](#progress-and-size) treats
the migration import as the one large case, and `.mny` leaves the *Later*
row of the phase table.

**C. Payee rules are per book.** A business book's payees are not a personal
book's. They stay in the book's own collection, alongside account links and
format profiles. *Changed:* [decision 10](#decisions) states the principle
for all three, and the options section says why none of them is an option.

**D. No native round-trip export format.** Keeping a book whole is backup,
restore and archive — separate planned work — not export, and an export
dialog offering both would quietly compete with it. Round-tripping stays as a
*test* technique, used per format. *Changed:* a non-goal, [What export is
not](#what-export-is-not), [Round-tripping in the
tests](#round-tripping-in-the-tests), and the JSON export leaves the *Later*
row.

**E. Multi-currency is a later feature.** Refuse what cannot be handled,
without refusing what can: OFX's `ORIGCURRENCY` (the bank already converted;
the row is ordinary) is imported, while `CURRENCY` (the amount is in another
currency) is counted as unsupported and a whole statement in the wrong
currency is refused. *Changed:* a non-goal, and the new
[Currencies](#currencies) section, which exists because conflating those two
tags would have rejected every credit-card statement containing a foreign
purchase.

**F. Archiving will keep the working set small.** A year's data is the
expected size of an open book, so the per-row cost of the review is
affordable and the matcher's search space stays small. `maxRows` stays at
100,000 for the one-time migration import, which is now the only large case.
*Changed:* [Progress and size](#progress-and-size), which also notes that the
migration import is where *Accept All* is the right gesture.

**G. A declined row is not remembered — deferred.** A row the user accepts
nothing for is skipped, and re-importing the file offers it again, because a
skip is usually "not now". A user who deliberately rejects the same row every
month would want otherwise, but that user is hypothetical, and the machinery
to remember a decline (a fourth collection, keyed on what? the file, the
amount, the date?) is not worth building before one exists. *Changed:*
nothing. Revisit when someone reports it.

**H. `Accept All` carries no confirmation, on the condition that undo
reverses the entire import.** A confirmation nobody reads is not a safeguard;
a reliable undo is. But that makes undo's completeness load-bearing rather
than a nicety, so the design now says so: **undo takes the whole batch back
out or none of it**, and the cases that used to be quietly skipped —
a row reconciled or edited since the import — are now gathered as
confirmations *before* anything is written, in the pattern
`accounts.service` and `recurring.service` already use, after which they are
reversed with the rest. *Changed:* [Applying, and
undoing](#applying-and-undoing) substantially; the note that an undo from the
result banner is always unconditional because nothing can have changed yet;
and the reason `history.keep` deletes trimmed batches rather than emptying
them.

**I. Matching is tuned from the existing options page, which stays small.**
There is already a *Tools ▸ Options ▸ Import and export* page, and the four
settings that affect matching live on it. It should not become a panel of
weights and thresholds, because the user has no way to observe whether a
change helped — the statement they would test against is the one they already
imported. The real levers are **Change…** per row, `dateWindow` **per
source**, and the matcher's own code driven by how often users had to
override it. *Changed:* the new [Tuning the
matching](#tuning-the-matching) section; `dateWindow` added to `AccountLink`
so it can vary by bank, with the review view showing the window in force as a
link to the setting; and `ImportBatch.manualMatches`, which was already
recorded, named as the measurement that should drive changing the matcher.

## Phases

Effort on the scale this repository's other notes use: **S** a day or two,
**M** about a week, **L** two weeks or more.

| Phase | Delivers | Effort | Depends on |
|---|---|---|---|
| **0** | *(mostly done)* **Prerequisites.** `@tessera/exchange-api` and its entry in `API_PACKAGES`; `externalId` on `TransactionDraft`; `TransactionManager.createMany`; `shell.files.writeFileAtomic`; `shell.contextMenus` replacing the four (now five) bespoke action points, with `accounts` migrated onto it; the `exchange` plugin skeleton — manifest, schema, migrator, options namespace, the File menu groups, the two commands registered but refusing with "no formats installed" | **M** | — |
| **1** | *(done)* **The pipeline, headless.** `ExchangeDocument` and every contract; the `exchange.formats` point with validation and sniffing; `read`/`plan`/`apply`/`undo`/`history`/`candidates` in `exchange.service`; account resolution and `exchange.links`; the matcher with all four tiers (including a manual match overriding a proposal and surviving a re-plan) and transfer pairing; `RowDecision` and the rule that only accepted rows are written; the currency rules; `ImportBatch` and undo; the IPC. No UI and no formats — driven in tests by a fake format plugin returning hand-built documents | **L** | 0 |
| **2** | *(done)* **OFX, QFX and QBO.** `exchange-ofx`: the dual-syntax tokeniser, the encoding rules, the statement and credit-card branches, `STMTTRN` in full, `CORRECTFITID`, balances, the three descriptors and their sniffing, the sign options, investments counted as unsupported. Read only | **M** | 1 |
| **3** | *(done)* **The review view, with Accept and Change…** The grid with its dispositions; per-row **Accept** and the `E` it implies; **Accept All** and **Accept New**; the **Change…** dialog (`exchange.dialog.match`) with scored candidates, search, the widening toggles, "import as a new transaction", the reconciled caution and the *use the statement's amount* tick; in-place payee and category editing with the register's autocomplete; the difference line; the unsupported banner; the account drop-down with re-planning that preserves manual matches; progress and cancel; the result banner with Undo and Open Register; and the keyboard map. **The first phase a user can use**: File ▸ Import of an OFX file, end to end | **L** | 2 |
| **4** | **QIF.** `exchange-qif`: the record splitter, both dialects with detection and the prefix matching that follows from it, date-order inference and the question, every control line, the `!Account` whole-book form, opening-balance records, splits parked with a marked memo, and the QIF writer in both flavours | **L** | 3 |
| **5** | **CSV, and export.** `exchange-csv`: the delimited reader, profile matching by header fingerprint, the mapping dialog with its live preview, `exchange.profiles`, and the CSV writer. Then the export side whole: the export dialog, `ExportRequest`, the OFX 2.x and CSV writers, scope and range, and the atomic write | **L** | 4 |
| **6** | **Payee rules, history and polish.** The rules collection and its editor dialog; applying rules in the pipeline; learning a rule from a review edit; *Import rules from another book…*; the import-history dialog with undo; `history.keep` trimming; the options page, including the four matching settings and the per-source `dateWindow` override on the link; splits once `Transaction.splits` is real, in both readers and both writers | **M** | 5 |
| **S** | *(done)* **The seeded book and its statements.** `npm run seed:book`: the “Household” book — four years, five accounts in a Personal and a Business sub-book, reconciled through the month before last — written through the real plugins, plus the bank files that go with it in all four formats. See [The seeded book](#the-seeded-book) | **M** | 1 |
| **A** | **The anonymiser.** `scripts/anonymize-statement.mts`, the `tokenize`/`detokenize` pair in each format plugin, the policy table, the HMAC derivation, the amount buckets and balance recomputation, the verification pass, `--check` wired into the test suite, the pre-commit hook and the contributor documentation. **Deferred**: phase S covers what phases 2–5 actually need, and the anonymiser earns its keep only once a real file defeats the parsers | **M** | 2 (it needs one real parser; grows with each format) |
| **7+** | **Later.** Investment transactions once there is an investment domain; multi-currency (decision E); import without review as an option; a watched folder; scheduled import; Direct Connect. **Not planned:** reading `.mny` (decision B) and a native round-trip export format (decision D) |

**Phase S replaced phase A as the thing to build before the parsers.** The
first draft argued that the anonymiser had to come early, because the
remaining parsers would otherwise be written against invented fixtures. That
reasoning was half right: what the parsers need is *files*, and what the
pipeline needs is a *book with four years of history in it* to match them
against — and a generator supplies both, immediately, with no real statement
to handle and no leak to guard against.

The anonymiser answers a different question: *this real file from this real
bank breaks the parser, how do I commit it?* That question cannot be asked
until a parser exists and a real file has defeated it. So it is deferred to
phase A, unscheduled, and the gitignore rules it would have brought are in
place already ([Keeping personal data out of the
repository](#keeping-personal-data-out-of-the-repository)).

### Tests, by phase

| Phase | What is tested |
|---|---|
| 0 | `createMany` writes n transactions in one storage transaction, pairs transfers within the batch, and rolls the lot back on one failure; a draft's `externalId` reaches the document and a second write of the same pair is refused by the index; `writeFileAtomic` leaves the original intact when the write throws; the migrated context-menu point still renders every contribution `accounts` had |
| 1 | The matcher: an exact id match is a duplicate; a near match within the window is a merge and outside it is new; identical candidates produce `new` plus a warning; a reconciled candidate becomes a conflict; a truncated payee matches by prefix only on a standard-QIF document; transfer pairing finds both sides across accounts and declines an ambiguous pair. Manual matching: `matchTo` overrides the proposal and sets `matchedBy: 'user'`; `matchTo: null` turns a merge back into a `new` row; a manual match survives a re-plan while an automatic one is recomputed; an accepted match takes the statement's date, amount and payee, and undo puts them back; two rows targeting one transaction are refused before anything is written. `candidates` excludes claimed transactions, includes the row's current match marked `current`, and flags reconciled and amount-differing ones. Account resolution by link, by number suffix, by name, and unresolved. **Acceptance:** `apply` writes exactly the accepted rows and skips the rest; an accepted `new` row lands as `E`, an accepted `merge` updates and becomes `E`, an accepted `duplicate` writes nothing, and an existing `R` row is never downgraded; nothing is written on a failure. **Undo is all-or-nothing** (decision H): it removes every created row and restores every merged one; a batch containing a since-reconciled or since-edited row fails with `CONFIRMATION_REQUIRED` and writes *nothing*, and with the confirmation reverses the whole batch including those rows; a merged row is restored to its pre-import state rather than a later edit; created accounts and categories are kept and named in the result; a trimmed batch cannot be undone. A re-imported file is recognised by hash; `maxRows` refuses. `dateWindow` is taken from the link where it has one and the option otherwise. Currencies: `ORIGCURRENCY` imports and notes the original, `CURRENCY` is counted unsupported, and a mismatched `CURDEF` fails with `CURRENCY_MISMATCH` |
| 2 | Both syntaxes parse to the same document from equivalent fixtures; an unclosed SGML leaf closes correctly at its parent; Windows-1252 payees survive and a bad byte raises one warning; `DTPOSTED` with a zone offset keeps its calendar date in both directions; amounts with a comma decimal and with no decimal; `CCSTMTRS` maps to a credit-card account and its signs; `CORRECTFITID`/`REPLACE` updates and `/DELETE` voids; an `INVSTMTRS` is counted, not dropped silently; `INTU.USERID` never appears in the document; the three descriptors sniff their own files and decline the others |
| 3 | The grid renders one row per proposal with the right disposition and reason; no row starts accepted and *Import* is disabled until one is; **Accept** marks exactly its own row and pressing it again releases it; **Accept New** accepts the `new` rows and leaves `merge` and `conflict` rows for the user; a `duplicate` row offers no **Change…** and accepting it writes nothing; `Space` accepts and `Ctrl+Enter` opens Change…. The **Change…** dialog shows the *original* payee from the file, lists the whole account register with a tick box per transaction, ticks the current match (nothing for an unmatched line), ticks one at a time, greys out what is matched elsewhere with why, says what matching will change, and closes with **Match** or **Leave Unmatched** — leaving the line unaccepted for the user to accept in the review. Editing a payee changes only that row's draft; the difference line is zero for a fully accepted consistent statement and moves as rows are accepted; changing the account re-plans and keeps manual matches; cancel writes nothing and confirms when anything was accepted or edited; the header states the matching window in force and links to the setting; the result banner's counts match the batch and it offers no reconciliation; **Accept All** needs no confirmation at any size, and undo from the banner restores the register to exactly its pre-import state |
| 4 | Dialect detection: a 16-character name forces Microsoft; a four-digit year forces Microsoft; an apostrophe year forces standard; an ambiguous file raises the question. Date order: inference from a day above 12 in either position, and the question otherwise; the apostrophe and the 00–49 rule. Every control line, including `!Option:AutoSwitch`. A whole-book file yields one statement per account in order, with transfers resolved to account ids and each pair written once. An opening-balance record becomes a balance, not a transaction. **Round trip** (decision D): export a book, import it into an empty one, and dates, amounts, payees, numbers, memos, categories and both sides of every transfer survive — while reconciliation history and the `R` status are asserted *absent*, so a writer that invents them fails. Standard flavour truncates to 15 and Microsoft does not; a Microsoft-dialect whole-book file exported from Money-shaped input imports with its accounts, categories and transfers intact (the migration path, decision B) |
| 5 | Delimiter and encoding inference; quoted fields with embedded delimiters, quotes and newlines; debit/credit columns versus a single signed column, both sign conventions; each `dateFormat`; a profile matched by header fingerprint skips the dialog and a changed header does not; a trailing total row is skipped. Export: scope and range select the right transactions; voided and cleared-only filters; a multi-account export to a single-account format is refused; the CSV BOM is present when asked; an interrupted write leaves the previous file. **Round trips**: OFX 2.x out and back preserves dates, amounts, payees, numbers and `FITID`s and is asserted to carry no categories; CSV out and back preserves the column set and is asserted to carry no transfers. Each format's reader is also run against the committed real-file fixtures, where no writer is involved to mask a normalisation |
| 6 | Rules apply in order and the first match wins; a regex rule substitutes groups; a rule scoped to an account does not fire elsewhere; a renamed payee participates in matching; "always rename this" writes a rule matching the non-numeric prefix; rules, links and profiles live in the book and a second book opens with none of them (decision C), and *Import rules from another book…* copies them without duplicating an existing match; history lists batches newest first and trims beyond `keep` and a trimmed batch can no longer be undone; a per-link `dateWindow` overrides the option and only for that source; splits import and export round trip |
| S | The generator is the same book from the same seed and a different one from another; no account ever goes overdrawn; the card is paid off monthly and the tax set aside and remitted; the closing balances match the month-by-month figures; only the open month is held back from the book; staggered rows never cross the month end. The fixtures are exactly what the generator writes today (so a stale one fails rather than drifting); every format is covered in both OFX syntaxes; the SGML files hold Windows-1252 bytes a UTF-8 reader would choke on; the XML file is well-formed and every tag closes; the Intuit files carry `INTU.BID`; the two CSVs disagree about their columns as two banks' exports do; each statement's closing figure is its rows added to what came before |
| A | Nothing from the input survives in the output (the substring test, run over a generated "real" file containing every field kind); the same seed reproduces the output and a different seed does not; the output parses to the same record, statement and tag counts; balances equal the sum of the synthetic transactions; the date shift preserves every interval and every weekday; the same payee maps to the same fake across two files; a payee's shape (prefix, caps, trailing digits) is preserved; an unrecognised tag is dropped and appears in the report; the report contains no values, no seed and no shift; a deliberately wired pass-through fails the verification and leaves no output file; `--check` passes over every committed fixture and fails over a planted one; `detokenize(tokenize(f)) === f` for every committed fixture |

### Documentation, alongside the phases

- **Phase 1:** `plugin-creation.md` gains *Adding a file format*, in the shape
  of its existing *Adding a way to reconcile*.
- **Phase 3:** `README.md`'s "What works today" gains import; the
  Documentation list gains this note.
- **Phase A:** a contributing section — *Adding a fixture from a real file* —
  with the five-step procedure, the warning about history, and the pre-commit
  hook.
- **Every phase:** [todo.md](todo.md)'s *Later: statement import* item is
  replaced by a section for this note, ticked off phase by phase.

## Phase 1 results

Done. The pipeline runs headless: a document goes in, a plan comes out, the
accepted rows are written through `accounts.service`, and a whole import can
be taken back out. There are no formats and no UI, so the only way in is a
test's fake format — which is what the phase asked for.

**What was built**

| | |
|---|---|
| `packages/exchange-api/` | `model.ts` (the neutral document, the proposal and decision types, the four stored shapes), `format.ts` (the `exchange.formats` contribution, `ExchangeFormat`, `validateFormat`), `service.ts`, `errors.ts`, `options.ts` (the defaults, so a test needs no options service), `protocol.ts` |
| `plugins/exchange/` | `formats.ts` (the point: validation, sniffing, choosing), `matcher.ts` (the tiers, scoring, candidate ranking, transfer pairing — all pure), `rules.ts` (payee rules and what *always rename this* learns), `planning.ts` (account resolution, drafts, the plan), `applying.ts` (writing, the obstacles check, reversal), `ExchangeServiceImpl.ts`, `ipc.ts`, `store.ts`, `schema.ts`, `disk.ts`, `index.ts` |
| `plugins/accounts/` | `externalId` on `TransactionDraft` and so on `TransactionPatch`; `TransactionManager.createMany`; lookup caches shared across a batch; `UNIQUE_VIOLATION` on `uniqueExternalId` translated into a message about importing rather than about names |

**98 tests**, in `tests/plugins/exchange/` (matcher 27, pipeline 39, formats
20, rules 17 — plus 9 activation) and `tests/plugins/accounts/bulkCreate.test.ts`
(13). The pipeline tests run against a real book session and a real accounts
service on the memory engine: an imported row really is written to a register,
and undo really takes it back out.

**Decided while building**

- **Generic banking words pass.** A payee or memo made only of words like `WITHDRAWAL`, `BILL PAYMENT` or
  `INTERAC E-TRANSFER` describes the transaction, not the person, and real banks write exactly these; they
  are kept and not counted as sensitive. The first real file showed why: its memos coincided with the memo
  corpus and the substring check flagged them.
- **A leak is named by field and shape, never by value.** The verifier reports `a <MEMO> value of 12
  characters, shaped “AAAA AAAAAAA”`, which is enough to aim a policy at and reveals nothing. It was what
  made the real files' failures diagnosable without looking at them.
- **The real fixtures live apart.** `tests/fixtures/exchange/anonymized/` holds them with a manifest of their
  own (source, rows, quirks); the seed's "nothing here I did not write" check skips that folder, and the
  anonymiser's tests read the manifest instead.

- **An import is not one storage transaction**, and the note now says so
  ([decision 6](#decisions)). Writing through `accounts.service` means the
  import cannot enlist that plugin's transaction, and the account manager's
  rules are worth more than the atomicity. Each account's new rows still go
  through a single `createMany`, so the common case *is* atomic; where it is
  not, the batch is recorded anyway and the error tells the user to undo.
  Both paths are tested.
- **`ImportBatch.created` and `.merged` are grouped by account.** The account
  manager scopes every write to one account, so undo cannot reach a
  transaction by id alone.
- **A merge never touches the payee**, so `MergedBefore` does not carry one.
  It changes the status, adopts the reference, and — only with
  `adoptBankDetail` — takes the memo and number. The amount moves only
  through the Change… dialog's explicit tick.
- **`read` returns the file's name and hash beside the document.** Only the
  reader's caller has seen the bytes, and `plan` needs both to record the
  batch and spot a repeat import.
- **`candidates` for a plan the main process no longer holds returns an empty
  list**, not an error: the view's state is stale, which its next action will
  report properly, and an error dialog from a browse is worse than no
  candidates.
- **The plugin owns its file reading**, behind an `ExchangeDisk` port as the
  book plugin does, because `shell.files` offers dialogs and the trash but no
  bytes. `activate` takes the port, so activation is testable without a disk.

**Not built, and why**

- `shell.files.writeFileAtomic` and `shell.contextMenus` — both listed under
  phase 0, both needed only by the export dialog (phase 5) and the menus
  (phase 3). The atomic write lives in the plugin's own disk port for now.
- `Transaction.splits` — phase 6. A split row imports as a single
  transaction; the model carries the lines so nothing has to be re-parsed.
- The commands, menus and views of the review — phase 3. The context keys
  they will hang on (`exchange.formats.count`, `exchange.canUndo`,
  `exchange.importing`) are published already, which is why File ▸ Import
  will grey itself out before any format exists.

## Phase 2 results

Done. `exchange-ofx` reads OFX in both its syntaxes, and the two Intuit-branded
files that are also OFX. Three descriptors, one reader, no writer.

**What was built**

| | |
|---|---|
| `tokenizer.ts` | One tokeniser for both syntaxes. `<TAG>` followed by `<` opens an element, anything else opens a leaf running to the next `<`; opening a tag closes a leaf still open, and `</TAG>` closes until it has closed a TAG. Well-formed XML is simply the case where every leaf happens to be closed. Entity decoding, attribute and self-closing tolerance, and line numbers for warnings |
| `encoding.ts` | The `KEY:VALUE` header read from raw bytes before the encoding is known; `ENCODING`/`CHARSET` mapped to a codec; the XML declaration honoured for 2.x; BOM stripped; a byte that could not be read reported once rather than lost |
| `values.ts` | Amounts as text to minor units, never through a float; dates reduced to the calendar date; `ACCTTYPE` mapped; the three sign conventions |
| `reader.ts` | The tree as an `ExchangeDocument`: bank and credit-card statements, `STMTTRN` in full, balances, periods, corrections, currencies, and a count of everything it could not keep |
| `index.ts` | The three descriptors, the shared format service, sniffing, and the sign convention read from a settled answer |

**95 tests**, in three files: the reader against the **seeded fixtures**
(whole statements, both syntaxes, Windows-1252, an Intuit block), the reader
against hand-built files for what the fixtures cannot show, and the whole
pipeline importing a fixture into a book — which is the first test in which a
real bank file becomes transactions in a register.

**Decided while building**

- **Generic banking words pass.** A payee or memo made only of words like `WITHDRAWAL`, `BILL PAYMENT` or
  `INTERAC E-TRANSFER` describes the transaction, not the person, and real banks write exactly these; they
  are kept and not counted as sensitive. The first real file showed why: its memos coincided with the memo
  corpus and the substring check flagged them.
- **A leak is named by field and shape, never by value.** The verifier reports `a <MEMO> value of 12
  characters, shaped “AAAA AAAAAAA”`, which is enough to aim a policy at and reveals nothing. It was what
  made the real files' failures diagnosable without looking at them.
- **The real fixtures live apart.** `tests/fixtures/exchange/anonymized/` holds them with a manifest of their
  own (source, rows, quirks); the seed's "nothing here I did not write" check skips that folder, and the
  anonymiser's tests read the manifest instead.

- **`sniff` is told which descriptor is asking.** One service stands behind
  three formats, and the registry asks each in turn; without the id all three
  scored the same and a file whose name said nothing was a permanent tie.
  `ExchangeFormat.sniff(head, fileName, formatId)`, and `ReadContext` gained
  `formatId` for the same reason.
- **`ReadContext` gained `answers`.** A reader must be able to consult what a
  previous import settled — a sign convention, later a QIF dialect — *without*
  asking. The note now says plainly that `request` is for what a read cannot
  proceed without, and that anything the user would merely like to adjust
  belongs in `warnings` where the review can offer it without blocking.
- **A lone separator in an amount is always the decimal point.** The first
  attempt treated three digits after a separator as grouping, which read
  `142.000` as a hundred and forty-two thousand. OFX permits a period or a
  comma as the decimal separator and no grouping at all, so grouping only
  appears from broken exporters — and it gives itself away by using both
  characters (`1,234.56`) or by repeating one (`1.234.567`).
- **Quicken and QuickBooks are not told apart by content.** `INTU.BID`
  identifies the bank, not the program. A file with an Intuit block and a name
  that says nothing could be either, so the pipeline asks instead of guessing;
  guessing would put the wrong label on the saved account link.
- **A bank's own error is passed on as the bank's.** A response carrying a
  non-zero `STATUS/CODE` and no statement reports that code and message, rather
  than calling the file malformed, which it is not.
- **Times are discarded, deliberately.** `20261103000000[-5:EST]` converted to
  UTC is the 3rd at 05:00 and `[+13:NZDT]` is the **2nd** — a transaction on
  the wrong side of a statement boundary. A statement date is a calendar date
  in the bank's own terms.

**Not built**

- **Writing.** No descriptor declares `write`: a QFX or a QBO is defined by an
  identifier Intuit issues to a financial institution.
- **Investments.** `INVSTMTRS` and `INVTRANLIST` are counted into
  `unsupported` with the reason, and the review view will show the count.
- **The sign-flip offer.** The reader raises a `signs.uniform` warning when
  every row in a file goes the same way; turning that into an offer is the
  review view's job, in phase 3.

## Phase 3 results

Done, and with it the first phase a user can use: **File ▸ Import
Transactions…**, pick a statement, review it, press Import.

**What was built**

| | |
|---|---|
| `commands.ts` | `exchange.import` and `exchange.importInto` — read, plan, publish, reveal — and `exchange.cancel`. A failure the user caused is a message box; anything else is logged as the bug it is |
| `contributions.ts` | The File menu's Import group, the review view in `shell.main`, and the Change… dialog. All behind `book.isOpen && !book.isReadOnly && exchange.formats.count` |
| `decisions.ts` | What the user has decided, as pure functions: accepting and releasing, editing with `null` to clear, manual matches, the counts, and the difference line that follows |
| `ReviewView.tsx` | The screen: header with the account drop-down, the unsupported and warning banners, the grid, the difference line, the footer, and the result banner |
| `ReviewRow.tsx` | One line: the disposition, in-place payee and category editors, and the two buttons |
| `MatchDialog.tsx` | Change…: scored candidates with their reasons, search, the two widening toggles, "import it as a new transaction", the reconciled caution and the amount correction |

**64 renderer tests** and 15 activation tests. The decisions module is tested
without rendering anything, which is where the rules live.

**Decided while building**

- **Generic banking words pass.** A payee or memo made only of words like `WITHDRAWAL`, `BILL PAYMENT` or
  `INTERAC E-TRANSFER` describes the transaction, not the person, and real banks write exactly these; they
  are kept and not counted as sensitive. The first real file showed why: its memos coincided with the memo
  corpus and the substring check flagged them.
- **A leak is named by field and shape, never by value.** The verifier reports `a <MEMO> value of 12
  characters, shaped “AAAA AAAAAAA”`, which is enough to aim a policy at and reveals nothing. It was what
  made the real files' failures diagnosable without looking at them.
- **The real fixtures live apart.** `tests/fixtures/exchange/anonymized/` holds them with a manifest of their
  own (source, rows, quirks); the seed's "nothing here I did not write" check skips that folder, and the
  anonymiser's tests read the manifest instead.

- **The view asks for the plan as well as listening for it.** The command
  publishes the plan and *then* reveals the view, so a view that only
  listened would miss its own import. `exchange:plan.current` exists for
  that, and the view uses the subscribe-then-fetch pattern the other plugins
  use.
- **The difference line starts at the whole statement.** Nothing is accepted
  when the review opens, so every writable row is backed out of the plan's
  baseline and the difference is the whole file. It converges on zero as rows
  are accepted — which makes it a progress signal rather than a figure that
  sits at zero until the end and tells the user nothing.
- **`RowDecision.edit` is a patch, not a draft.** Clearing a category has to
  be expressible, and `undefined` cannot say it. `null` means "the user
  cleared this", and both the renderer's `draftOf` and the applier honour it.
- **An unaccepted row is simply absent.** `toDecisions` drops a row the user
  accepted and then released, because absent and unaccepted mean the same
  thing to `apply` and a row with `accepted: false` is just noise on the wire.
- **Two accessibility defects, found by the tests.** A MUI `select` takes its
  accessible name from `slotProps.select`, and a `TextField` from
  `slotProps.htmlInput`; an `aria-label` on either component lands on a
  wrapper and leaves the control unnamed. Both are fixed, and both were
  caught only because the tests query by role and name rather than by test id.

**Not built**

- **Progress and cancel during a long read.** The `progress` event exists in
  the contract and nothing emits it yet; it matters for the migration import,
  which is phase 4's whole-book QIF.
- **Windowed rendering.** The grid draws every row. The register's own
  windowing is still on [todo.md](todo.md) and should be shared when it lands.
- **Learning a payee rule from an edit.** The review collects edits but does
  not yet offer *always rename this*; the rules themselves are phase 6.
- **Import Into This Account…** is registered as a command but has no menu
  item, because the account-scope context-menu point is still waiting on
  `shell.contextMenus`.

## Phase 3 revision: review in the register

*2026-11-18.* The first phase 3 — a dedicated review screen over an in-memory plan, applied in one Import
click — was heading the wrong way, and was replaced by the flow Microsoft Money users already know. This
section supersedes [The import review view](#the-import-review-view), [Matching by hand](#matching-by-hand)
and [Phase 3 results](#phase-3-results); the matcher, the batches, undo and the format seam all carry over
unchanged.

### What was wrong

- **The plan lived in memory.** A restart, a book switch, or four imports in a row lost it. A statement the
  user has downloaded is state worth keeping.
- **Review was a separate screen.** The user matched a statement against a register they could not see, in a
  grid that duplicated the register's layout badly.
- **Apply was one big decision.** Money's users read a statement row by row, in the register, and each
  acceptance takes effect at once.

### The flow now

1. **File ▸ Import Transactions… reads and files.** For each statement in the file, the account is settled —
   a saved link, the account number, the name, or the user — and the statement is stored in the book as a
   `PendingStatement` (`exchange.pending`, schema version 3; version 2 introduced the collection, and the
   2 → 3 migration converts the per-row layout an earlier build of this feature wrote into one document per
   statement, emptying its `exchange.statements`). Rows whose bank reference the account (or an
   already-pending statement) holds are dropped at the door, counted as duplicates; the identical file is
   refused whole by its hash while it is still pending. Nothing touches the register.
2. **An unresolved statement opens the Choose Account dialog** (`exchange.dialog.account`): the book's
   accounts (another currency disabled, with why), *Create a new account…* (the New Account dialog, prefilled
   from the statement so the opening balance lands the account at the bank's figure), and *Remember this
   choice* — which writes the `exchange.links` row at filing time, not after an apply. Resolution by number
   or name also writes the link, so the next month's file asks nothing.
3. **Statements to Read** (`exchange.statements`, `shell.main`) lists one line per account with waiting rows
   — and every linked source with none, as Money listed its online accounts: *Account name (items), Last
   Downloaded, Bank Balance, Local Balance*. Clicking an account with items opens its register. The navigator
   also carries a *Statements to read* row whose badge is `exchange.pending.count`.
4. **The register shows the waiting rows in place.** A new extension point in `accounts`,
   **`accounts.register.overlays`**, lets a plugin lay provisional rows over any register: the contribution
   names an IPC channel (`exchange:pending.rows`) and a refresh event (`exchange:pending.changed`); the
   register merges the rows in by date, draws them bold with `?` in the status gutter, adds an unmatched
   row's amount to the shown running balance (a matched row adds nothing — its transaction is already in it),
   and shows each row's actions — **Accept** and **Change…** — only while the row is focused, exactly as the
   screenshots have it. **A matched row and its register transaction are drawn as one line**, where the
   statement puts it: the bank's date and amount, the user's number, payee and category, every cell bold until
   the match is accepted; the transaction's own line is not drawn. The point is generic: the register knows
   nothing about exchange.
5. **Matching is recomputed against the live register** every time the rows are asked for — the register
   moves between imports — but the user's own decision (`PendingRow.userMatch`) persists in the book and wins.
6. **Accept acts on one row at once.** A matched row merges into its register transaction (statement's date,
   amount and payee win; the user's category stays; the reference is adopted; status becomes `E`). An
   unmatched row is written as a new `E` transaction. A row whose reference turned up since filing is simply
   let go. The row leaves the statement; an empty statement is deleted; what was written is appended to the
   statement's `ImportBatch` (created lazily with the first acceptance, its `importedAt` refreshed with each),
   so *Undo Import* still takes a whole statement back out.
7. **Change… opens Change Transaction Matching** (`exchange.dialog.matching`), Money's dialog: the bank entry
   pinned at the top, then *Keep this transaction unmatched* against *Match this transaction to an item in my
   register* with a single-select candidate list. An unmatched row opens on the first; a matched row on the
   second, its current match ticked. Ticking an item selects the match choice; Done stores `userMatch`
   (`null` for keep-unmatched, which also unmatches a matched row). Candidates exclude transactions an
   earlier import bank-matched and ones another pending row has claimed.

### What changed in code

- `accounts`: `accounts.register.overlays` (`RegisterOverlayContribution`, `OverlayRow`, `OverlayActionArgs`),
  the resolver, the `accounts:register.overlays` channel, and the register's merged rendering and focused-row
  actions.
- `exchange-api`: `PendingStatement`, `PendingRow`, `PendingSummary`, `MatchingCandidate`, the two dialog
  contracts, the `pending` collection, `exchange.pending.count`, the `pending.summary` / `pending.rows`
  channels and the `pending.changed` event. `ImportPlan`, `ImportDecisions`, `ProposedRow`, the plan/apply
  channels and `exchange.importing` are gone; the service contract is now
  `read → file → pendingFor/pendingSummary → accept/setMatch/matchingCandidates`, plus the unchanged
  `undo`, `history`, `export`, `links` and `payeeRules`.
- `exchange` renderer: `StatementsView`, `ChooseAccountDialog` and `MatchingDialog` replace `ReviewView`,
  `ReviewRow`, `MatchDialog` and `decisions.ts`.

### Known gaps

- **Cross-statement transfer pairing is not wired into the per-row flow yet** (`pairTransfers` stands ready);
  each side imports as an ordinary row for now.
- The already-imported-file notice by batch hash (for files whose rows were all accepted and that carry no
  row ids — QIF, most CSV) returns with phase 4, where it matters.
- Learning a payee rule from an edit still waits for its UI (phase 6).

## Phase A results

*2026-11-18.* Built once real statements were on hand, as the phases table said it would be: the OFX family,
and CSV and QIF the same day, since the real downloads included two CSV exports and two Money QIF exports
whose shapes no generator would have guessed.

**What was built**

| | |
|---|---|
| `plugins/exchange.ofx/src/privileged/layout.ts` | The `tokenize`/`detokenize` pair: the file as a flat token stream — header lines, tags, values with their tag and path, whitespace — that reassembles to exactly its source. The round trip is a test over every committed fixture |
| `scripts/anonymize/policy.ts` | The policy table: every OFX leaf tag the tool knows, and what happens to it; the known elements; the header keys. Anything else is dropped and counted |
| `scripts/anonymize/derive.ts` | HMAC-SHA256 derivation; same-shape ids and account numbers (a 13–19 digit run is made to *fail* Luhn, so no fake can be a valid card number); fictional routing numbers; payees with their shape kept (processor prefix, store number, capitals, length class) from a ~400-name corpus; memos; order-preserving cheque numbers; whole-week date shifts; amounts by magnitude bucket |
| `scripts/anonymize/ofx.ts` | The rewrite: tokens routed by policy, unknown leaves and elements dropped whole with the line they were on, an empty known leaf kept, balances recomputed from the synthetic rows over a derived opening figure, the result encoded in the input's own code page (Windows-1252 included) |
| `scripts/anonymize/qif.ts` | QIF: the file kept line for line; each record routed by its block (`!Type:Bank` and kin, `!Account`, `!Type:Cat`, `!Type:Class`; `!Type:Memorized`, `Invst`, `Prices`, `Budget` dropped whole); categories mapped onto the starter chart keeping depth and `/Class`; transfers onto distinct fake account names, consistently; a split's `T` rebuilt from its synthetic `$` parts; `N` codes like `EFT` kept with their reference digits changed, cheque numbers renumbered in order; `A` lines dropped; dates in the ISO, `M/D'YY` and `M/D/YYYY` forms. **The dialect is learnt per field**: a code whose values never pass fifteen characters is written capped at fifteen |
| `scripts/anonymize/csv.ts` | CSV: RFC 4180 rows with their quoting remembered; columns roled from the header's words or, with no header, inferred from the cells (dates, money, text); each amount column's direction read from the running balance itself, so debit/credit pairs and signed columns both rebuild correctly; dates shifted in the shape they came in (ISO, D/M/Y, M/D/Y, `03-Oct-2026`, `Oct 3, 2026`); amounts written back in the cell's own style (parentheses, trailing minus, grouping, currency sign); BOM, delimiter and line endings kept; an unknown column kept but replaced wholesale and reported |
| `scripts/anonymize/verify.ts` | The verification pass: no input value of 4+ characters survives (from every synthetic, dropped or unrecognised field), no identifying pattern is present (Luhn runs, email, phone, postal codes, IBAN with country and mod-97, SIN/SSN, street addresses, URLs with queries), the output parses, and its statements, rows and tag counts match the input's. `--check` runs the input-free part over committed files |
| `scripts/anonymize/main.ts` | The command line: `npm run anonymize -- <in> <out>`, `--seed-file`, `--report`, `--keep-amounts` (refused under `tests/`), `--check`, `--quiet`. A failed verification leaves no output behind |
| `scripts/git-hooks/pre-commit` | Blocks a statement-shaped file staged outside the fixtures folder and checks the fixtures that are. Installed by hand, documented in the hook |

**Decided while building**

- **Generic banking words pass.** A payee or memo made only of words like `WITHDRAWAL`, `BILL PAYMENT` or
  `INTERAC E-TRANSFER` describes the transaction, not the person, and real banks write exactly these; they
  are kept and not counted as sensitive. The first real file showed why: its memos coincided with the memo
  corpus and the substring check flagged them.
- **A leak is named by field and shape, never by value.** The verifier reports `a <MEMO> value of 12
  characters, shaped “AAAA AAAAAAA”`, which is enough to aim a policy at and reveals nothing. It was what
  made the real files' failures diagnosable without looking at them.
- **The real fixtures live apart.** `tests/fixtures/exchange/anonymized/` holds them with a manifest of their
  own (source, rows, quirks); the seed's "nothing here I did not write" check skips that folder, and the
  anonymiser's tests read the manifest instead.

- **Card numbers fail Luhn on purpose.** The design had the replacement keep Luhn validity *and* the
  verification flag Luhn-valid runs; the two cannot both hold. No parser here checks Luhn, so the fake fails
  it, and the pattern check stays meaningful.
- **Timestamps and hex references are not card numbers or IBANs.** A 14-digit OFX timestamp passes Luhn one
  time in ten, and a hex FITID starting with two letters and two digits looks like an IBAN; both tripped the
  committed fixtures. Timestamps are recognised by shape and skipped; an IBAN must have a registered country
  code and pass mod-97.
- **Reserved example domains are not emails.** The seeded fixtures carry `householder@example.invalid` as the
  `INTU.USERID`, deliberately, to prove the reader discards it; RFC 2606 domains identify nobody.
- **Amounts and dates are not in the substring check.** A synthetic amount or a shifted date can coincide
  with a real one from elsewhere in the file; the check covers the fields where a match would be a leak.
- **No `--mapping` yet.** The debugging aid in the design is not built; the report's tag counts have been
  enough to tune the policy table.

**What a real Money export taught phase 4.** The two exports of one chequing account — Money's "loose" and
"strict" QIF — differ *only* in their category segments: the strict file caps each `Parent:Child` segment at
fifteen characters and leaves every payee and memo at full length. The design's dialect test ("any `P`, `L`
or `M` over fifteen means Microsoft") would call both files Microsoft, so the QIF reader should judge
truncation **per field**, treating a category segment of exactly fifteen as possibly truncated whatever the
payees say. Both files also write ISO dates, which a Canadian locale produces and the dialect table did not
list; the reader's date inference needs `YYYY-MM-DD` first.

**The first real fixtures**: two banks' chequing statements and two Money exports, nine files — OFX under Money's `.aso`
extension, QFX and QBO from each, and a CSV from each — anonymised, read, and committed under `anonymized/`.
Between them they carry an empty `<ACCTTYPE>`, a `<USERKEY>` credential, LF endings, a blank line inside every
record, `DTSTART` after `DTEND`, payees with trailing store and reference numbers, a headerless all-quoted CSV
with debit and credit columns, and a BOM-and-CRLF CSV with a leading filter column. None of that was in the
seeded fixtures, which is the argument for the tool.

**Not built**: `--mapping`.

## Phase 4 results

*2026-11-18.* The `exchange-qif` plugin, and the import flow's answer to a file that holds a whole book.

**What was built**

| | |
|---|---|
| `plugins/exchange.qif/src/privileged/values.ts` | Amounts with either separator (a final group of three digits is grouping, never a fraction), every date shape (`M/D'YY`, Quicken's space-padded day, `M/D/YYYY`, `D/M/YYYY`, ISO, `3-Oct-26`) with the two-digit-year rules, date-order inference from the file, the `!Type:` words as account types, the cleared flags |
| `lines.ts` | UTF-8 or Windows-1252 by what the bytes are; blocks, records and fields, a record that forgot its `^` kept with a warning |
| `reader.ts` | One statement per account for the whole-book form (`!Option:AutoSwitch` lists honoured), one for a bare statement, one for a file with no `!Type:` line at all; the category list; splits; `[Account]` transfers with the class dropped; the opening-balance record turned into the closing balance; memorised, investment, class and budget records counted, never silent; the date order settled from the file, else asked with two real dates shown both ways |
| `writer.ts` | Both flavours: Microsoft (names whole, `M/D/YYYY`) and standard (fifteen characters, `M/D'YY`); the whole-book form with an `!Account` block per account and the category list first; `T` and `U`; Windows-1252 |
| `index.ts` | One descriptor, `exchange-qif.qif`: reads, writes, several accounts, no row ids. Sniffs a control line or a bare record |
| `exchange`: the import command | A file with several accounts is asked about **once**: *add them to this book* or *create a new book from this file*. In a new book every account is created from the file, asking only the currency (which QIF never carries); in the open book each statement is matched by link, number or name and the Choose Account dialog takes the rest. The file's own account names are mapped to the accounts chosen, and that map rides on each pending statement so a transfer the file wrote as `[Savings]` reaches the right account whatever the book calls it. The file's categories are created before anything is filed |
| `exchange`: matching | A standard QIF's `truncatedAt` rides on the pending statement, so its payees are compared by prefix against the register's whole names — per statement, not per book |
| `QuestionDialog.tsx` | The dialog the design named but never built: a reader's `choice`, a `currency`; it also carries the destination question |

**Decided while building**

- **Dialect is read per field, and only payees matter to matching.** As the Money exports showed, "strict"
  cuts category segments and leaves payees whole. The reader reports what it sees (`dialect`) and sets
  `truncatedAt` only when the *payees* look cut: every one within fifteen characters and at least one exactly
  fifteen. A reader that trusted the file-wide rule would have compared whole payees by prefix for no reason.
- **Transfers between two statements of one file are not paired in advance.** Accepting one side writes a
  transfer through `accounts.service`, which creates the other side in the other account; the matcher then
  finds that new transaction as the match for the other statement's row, and accepting it merges. `pairTransfers`
  stays in the matcher for a later pass that wants to show the pair as one line.
- **The opening-balance record's self-transfer is matched by name, or taken on trust for a nameless file.**
  The anonymised exports have no `!Account` block, so their first record — payee `Opening Balance`, a transfer
  to some account — is read as the opening figure. A named account requires the transfer to name itself.
- **A new book asks the currency once.** `book.new` is the book plugin's own command, so the file dialog and
  the name are its; the import then creates every account with `accountFromStatement` (opening balance such
  that the account ends at the file's closing figure) under one currency. Nothing else is asked.

**Not built**: the export dialog (phase 5 — the writer is ready behind `exchange.service.export`), the
`exchange.qif.dateOrder` option's page (the option exists and is honoured), and a `--mapping` for the
anonymiser.
