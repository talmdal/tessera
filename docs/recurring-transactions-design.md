# Design note: the recurring transaction manager

| | |
|---|---|
| **Status** | Phases 0–5 are done, and from the later list: business-day adjustment with a per-book holiday list, the Upcoming panel (the forecast made visible), the register's projected balance, and revealing the view when a book opens with something overdue. Phase 6 (automatic entry) is not started |
| **Date** | 2026-11-13 |
| **Scope** | Future payments and deposits that repeat: the series a user keeps, the occurrences they generate, the screen that lists what is coming (and what is late), entering one or many into the right register, and the register's "Make Recurring…" action |
| **Builds on** | [account-manager-design.md](account-manager-design.md) (`accounts.service`, the register, the reconcile extension point), [storage-engine-redesign.md](storage-engine-redesign.md) (collections, indexes, transactions), [layout-controller-design.md](layout-controller-design.md) (slots, views, `shell.layout.reveal`, bar items), [plugin-creation.md](plugin-creation.md) |
| **Delivers** | A new bundled plugin, `recurring`, its contract package `@tessera/recurring-api`, and one small addition to `accounts` (a transaction-row extension point) |

## Summary

- **A *series* is a template plus a schedule**: "Hydro, $142.00, from Chequing,
  Utilities : Electricity, monthly on the 15th". It is what the user creates,
  edits, pauses and deletes. Microsoft Money called these *recurring bills and
  deposits*; Quicken calls them *reminders*.
- **Occurrences are computed, never stored.** A series keeps only the index and
  date of its *next* unentered occurrence. Everything the screen shows is
  derived from the schedule by pure functions, so an edited schedule has no
  stored future rows to rewrite, and a book never accumulates them.
- **The Recurring view lists one row per series — its first unentered
  occurrence — in ascending date order.** Overdue occurrences have dates in the
  past, so they sort to the top of that same list; they are not a separate
  list, just rows the view marks.
- **The user ticks one row or many and presses *Enter in Register*.** Each
  selected occurrence is written into its own account's register through
  `accounts.service`, so every rule the account manager enforces (closed
  accounts, transfers, currency, reconciled balances) applies unchanged. A
  series that is entered advances to its next occurrence.
- **Overdue work is warned about in four places**: a banner at the top of the
  Recurring view, the row's own styling, a `Warning` item on the bottom bar
  driven by the context key `recurring.overdue.count`, and revealing the view
  when a book opens with anything late.
- **A transaction already in a register becomes a series** through *Make
  Recurring…* in its row context menu. The source transaction is left alone and
  recorded as the series' last entry, so nothing is duplicated and the schedule
  starts at the next occurrence after it.
- **It is a plugin of its own**, `recurring`, requiring `accounts.service` and
  `book.session`. It stores `recurring.*` collections in the same book file
  through `book.schema`. It is the second real consumer of `accounts.service`
  (after the register itself), which is the point: every write goes through the
  integrity boundary the account manager established.
- **One addition to `accounts`**: `accounts.transaction.actions`, a general
  extension point for a register row's context menu. Today only reconcilers can
  put an item there, through `accounts.reconcile.actions` with
  `scope: 'transaction'`, which is the wrong name for "make this recurring".

---

## Naming

The account manager's note settled a naming table before writing any code; this
one follows it. The words have to work in a menu, in a column header, and as an
id another plugin depends on.

| Concept | User-facing name | Code name | Notes |
|---|---|---|---|
| The feature and its screen | **Recurring** ("Recurring Transactions" in full) | `recurring` | *View ▸ Recurring*, *New Recurring Transaction…* |
| One template + schedule | **Recurring transaction**, or *series* in prose | `Series` | The thing the user creates and edits |
| One dated instance of a series | **Occurrence** (shown as *Due*) | `Occurrence` | Computed, never stored |
| Writing an occurrence into a register | **Enter** ("Enter in Register") | `enter` | Money's verb. The row is *entered*, and its series advances |
| Passing one occurrence over | **Skip** | `skip` | Advances the series without writing a transaction |
| The repeat rule | **Frequency** / **Schedule** | `Schedule` | "Monthly on the 15th" |
| A record of an entry or a skip | — (shown as *History*) | `Posting` | The audit trail, in `recurring.postings` |

Alternatives considered for the feature's name:

| Name | Verdict |
|---|---|
| **Recurring** | **Chosen.** It is the word the request used, it covers payments and deposits equally, and it reads well as a menu item and a view title. |
| Bills and Deposits | Money's name. Accurate but long, and "bills" is wrong for a scheduled transfer to savings. |
| Scheduled transactions | Fine in prose, but "scheduled" invites confusion with a background scheduler, which this is not: nothing happens unless the user opens the book. |
| Reminders | Quicken's name. It suggests notification rather than bookkeeping, and the feature's main job is entering transactions. |
| Standing orders | British banking term; wrong for a deposit, and unfamiliar in North America. |

For the verb, *Record* (Money's dialog) and *Post* (accounting) were considered.
**Enter** was chosen for the UI because it is Money's and Quicken's word and the
one a user of either will look for. The code name is `enter` to match; "post"
survives only in `recurring.postings`, the history collection, where it means
"an occurrence that has been dealt with".

---

## Context: what the framework gives us, and what it lacks

What exists and this design relies on:

| Facility | Used for |
|---|---|
| `accounts.service` ([packages/accounts-api/service.ts](../packages/accounts-api/service.ts)) | Reading accounts, and `transactions(accountId).create(draft)` to enter an occurrence. Every rule stays enforced in one place |
| `TransactionDraft` ([accounts-api/transactions.ts](../packages/accounts-api/transactions.ts)) | A series' template is very nearly a draft already: date, number, amount, payee, memo, category **or** transfer account |
| `transactions(id).nextNumber()` | Cheque numbering for a series that uses cheques |
| `accounts.service.onDidChange` with `deleted` and `updated` | Cleaning up series whose account was deleted, pausing those whose account was closed |
| `book.schema` + a `Migrator` ([book-api/service.ts](../packages/book-api/service.ts)) | `recurring.series` and `recurring.postings`, in the book's own file, so a book is still one file |
| `book.session.database('recurring')` | A database scoped to `recurring.*`; no other plugin's data is reachable |
| `shell.views` with `when` | The Recurring view in `shell.main`, present only while a book is open |
| `shell.bar.items`, `BorderTextItem` with `{key}` interpolation ([tessera-types/layout.ts](../tessera-types/layout.ts)) | The overdue warning on the bottom bar, with no new framework work |
| `shell.dialogs` + `shell.prompts.show` | The series dialog and the enter dialog |
| Commands with `enablement` over context keys | Greying out *Enter All Due* when nothing is due |
| `shell.layout.reveal` | Showing the Recurring view when a book opens with overdue work |
| Published IPC channel names (`ACCOUNTS_CHANNELS`) | The series dialog fetches the chart, the categories and payee suggestions from the accounts plugin's own channels, rather than proxying them |

Gaps that affect this feature, and how the design handles each:

| Gap | Handling |
|---|---|
| A register row's context menu can only be extended by a reconciler (`accounts.reconcile.actions`, `scope: 'transaction'`) | **Prerequisite:** `accounts.transaction.actions`, a general row-action point in `accounts`. The reconcile point keeps working, resolved into the same menu |
| The Accounts navigator's rows are the book tree and nothing else, so another plugin cannot put a *Recurring* row in it | **Prerequisite:** `accounts.navigator.items`, an extension point for rows above or below the tree, each running a command and able to carry a badge from a context key |
| `accounts` hardcodes its menu ids in [contributions.ts](../plugins/accounts/src/privileged/contributions.ts); another plugin cannot add an item to the Accounts menu without copying the string | **Prerequisite:** publish `ACCOUNTS_MENU` (menu id and group ids) from `@tessera/accounts-api` |
| The `when` grammar has no `>`; only truthiness and `==` / `!=` ([shared/context/when.ts](../shared/context/when.ts)) | A count context key is used bare: `recurring.overdue.count` is falsy at 0. A second key, `recurring.overdue.summary`, holds the already-pluralised phrase for the bar item's text |
| The main area shows one view with no tabs | Recurring and the register share `shell.main` and are swapped with `shell.layout.reveal`, as the register and start view already are. After entering, the view offers *Open Register* for the account entered. Tabs are already on the [todo](todo.md#views-and-the-renderer) |
| No settings framework ([settings-design.md](settings-design.md) is unbuilt) | Per-series options only. Book-wide defaults (the reminder window, auto-enter) wait for `context.settings`; the constants are exported so there is one place to change them |
| There is no cross-plugin transaction: `accounts` deletes an account in its own storage transaction, and `recurring` learns afterwards | Series are cleaned up reactively on `onDidChange`, and the service skips a series whose account has vanished. See [Risks](#risks) |
| Icons: the standard set ([tessera-ui/standardIcons.ts](../tessera-ui/standardIcons.ts)) has `CalendarToday`, `Warning` and `Error`, but no repeat, pause or skip glyph | **Prerequisite:** add `Repeat`, `Pause`, `PlayArrow` and `SkipNext` to the standard set, and `Chip` to `@tessera/ui` for the "3 due" badge |

---

## Goals and non-goals

**Goals**

- Keep repeating payments, deposits and transfers: a template, a schedule, and
  where the money moves.
- Show every series' next unentered occurrence in one list, in ascending date
  order, across every account in the book.
- Warn clearly and repeatedly when something is overdue, without a modal
  interruption.
- Enter one occurrence, or many at once, into the right registers, with a
  truthful report when some succeed and some do not.
- Skip an occurrence, pause a series, and end one on a date or after a count.
- Turn a transaction already in a register into a series, from its context
  menu, without duplicating it.
- Cover every frequency Microsoft Money offered, with a schedule a person can
  read back in one sentence.
- Offer `recurring.service` so a later cash-flow or budget feature can ask what
  is coming in a date range.

**Non-goals for this feature** (each has a place in the model; see [Phases](#phases))

- Showing future-dated transactions in the register with a projected balance.
  Money does this; the register has no future section and no projected total
  yet. The Recurring view is the only place occurrences appear.
- Notifications outside the app (`shell.notifications` does not exist).
- Detecting a repeating pattern in existing transactions and offering to make a
  series of it.
- Loan amortisation: a mortgage series has one amount, not a split that shifts
  from interest to principal each month. It needs splits first.
- Splits in a template. `Transaction.splits` is still reserved, so a series
  cannot have them either — and with them would come a series that enters into
  several accounts at once (a paycheque split between chequing and savings),
  which review decision E settles as a transfer across those accounts. Both
  wait for splits.
- Full RFC 5545 recurrence (`RRULE` with `BYSETPOS`, `EXDATE`, and the rest).
  See [Alternatives considered](#alternatives-considered).
- Per-occurrence overrides ("this month only, $200"). Entering with a different
  amount is allowed; it does not change the series.
- Currency conversion. A series is in its account's currency; totals are per
  currency, as the chart's are.
- Undo.

---

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **A separate `recurring` plugin, not a part of `accounts`** | `accounts` is already the largest plugin, and this is a different job: it is a *client* of the account manager, not part of it. Every write goes through `accounts.service`, which is exactly the boundary the account manager's decision 8 established. It also proves the service is usable from outside |
| 2 | **Occurrences are computed from the schedule, never stored** | The alternative is materialising future rows, which is unbounded, has to be rewritten whenever a schedule is edited, and makes "what is due" a question about stored data rather than about a rule. A series stores one index and one date |
| 3 | **A series stores `nextIndex`, the position in its own sequence, as well as `nextDate`** | The date alone cannot answer "how many occurrences have there been", which an *end after N* rule needs, and it cannot distinguish two occurrences on the same day. The index is the truth; the date is stored beside it so the database can sort and range-query the list |
| 4 | **Five frequencies with an interval cover Money's ten choices** | Daily, weekly, semi-monthly, monthly, yearly, each with "every *n*". Quarterly is monthly every 3, twice a year is monthly every 6, every four weeks is weekly every 4. Fewer cases to test, and every one reads back in a sentence |
| 5 | **A monthly day beyond the month's length clamps to the last day, and the anchor is not changed** | The 31st in February is the 28th or 29th; March is the 31st again. Advancing from the clamped date instead would walk the series backwards, which is the classic bug in this feature |
| 6 | **A transaction carries the date it is *for*, never the date it was entered on** | A bill due on the 1st and entered on the 14th belongs on the 1st: that is when it was owed, and that is where it must sit for reconciliation. Confirmed in review (A). The enter dialog shows the date and lets the user change it, like any other field; there is no separate "use today" mode |
| 6a | **Every entry goes through the enter dialog, with the amount editable** — one occurrence or many | Decided in review (C). The amount of a real bill is rarely exactly the scheduled one, and the dialog doubles as the confirmation step for a bulk entry, so nothing is written to a register without the user seeing it first |
| 7 | **Entering several is sequential and partial failures are reported, not rolled back** | Each account's write is its own storage transaction inside `accounts.service`, and there is no cross-plugin transaction. Rolling back by deleting what was written would be worse: it would delete real transactions. The result says what was entered and what was not, and why |
| 7a | **`enter` reports per occurrence; `skip` is all or nothing** | Decided while building phase 2. Entering spans two plugins' storage, so one occurrence's problem must not sink the others — it lands in `failed`. Skipping touches only this plugin's collections, so one storage transaction covers it and a rejection is both possible and clearer |
| 8 | **The link between a series and the transaction it produced lives in `recurring.postings`**, not as a field on `Transaction` | `Transaction` is `accounts`' document. A plugin does not get to add a field to another plugin's schema, and the history collection answers more questions than a single id would (what was skipped, what was entered and later deleted) |
| 9 | **Overdue is a derived state, computed against the local date each time the list is built** | Nothing is stored that can go stale. The one input is "today", recomputed when the book opens, when the window regains focus, and when the date rolls over |
| 10 | **A warning is never a modal dialog** | Opening a book must not block on a message box. The view's banner, the row styling, the bottom-bar item and revealing the view are all dismissible or passive |
| 11 | **Nothing is entered automatically in the first release**; `autoEnter` arrives in phase 6, off by default | Writing to a register without the user watching needs the reporting and the history to be in place first |
| 12 | **The source transaction of *Make Recurring…* is recorded as the series' last entry** | Otherwise the new series' first occurrence would fall on a date the user has already paid, and the first thing they would see is a false overdue warning |
| 13 | **A closed account's series are paused, not deleted; a deleted account's series are deleted** | Mirrors the account manager's decision 12: closing is reversible and keeps history, deleting is not. A paused series is shown, greyed, with the reason |
| 14 | **Amounts are signed from the account's point of view**, as everywhere else in the finance domain | Decision 5 of the account manager. A payment is negative, a deposit positive, whatever the account type. The view's one Amount column is signed, and negatives are red, as balances are |

---

## Components

```
  ┌──────────────────────────────────┐
  │ book                             │
  │  provides book.session           │
  │  owns     book.schema            │
  └───────▲──────────────────▲───────┘
          │ requires         │ requires, contributes recurring.* collections
  ┌───────┴──────────────────┼───────┐
  │ accounts                 │       │
  │  provides accounts.service       │
  │  owns     accounts.reconcile.actions
  │  owns     accounts.transaction.actions   ← new in phase 0
  │  navigator, register, Accounts menu
  └───────▲──────────────────┼───────┘
          │ requires         │
  ┌───────┴──────────────────┴───────┐
  │ recurring                        │
  │  provides recurring.service      │
  │  Recurring view, series dialog,  │
  │  Accounts ▸ Recurring group,     │
  │  "Make Recurring…" row action    │
  └──────────────────────────────────┘
```

| Component | Kind | Provides | Requires | Owns |
|---|---|---|---|---|
| `recurring` | bundled plugin | `recurring.service`, `recurring.migrator` | `book.session`, `accounts.service`, `shell.prompts` | — |
| `@tessera/recurring-api` | package (types, constants, pure schedule maths) | | `@tessera/types`, `@tessera/accounts-api` | |
| `accounts` | existing plugin | (unchanged) | | gains `accounts.transaction.actions` |

`@tessera/recurring-api` holds the published contract — the service interface,
the documents, IPC channel and command names, and the schedule engine — and no
behaviour that touches storage or Electron. The schedule engine lives there,
not in the plugin, because the renderer needs it too: the series dialog previews
the next few dates as the user types, without a round trip to the main process.

`scripts/build-plugins.mts` must list it in `API_PACKAGES` alongside `book-api`
and `accounts-api`, so both halves of a plugin can import it.

---

## The schedule

### Types

```ts
export const FREQUENCIES = ['daily', 'weekly', 'semiMonthly', 'monthly', 'yearly'] as const
export type Frequency = typeof FREQUENCIES[number]

/** A day of the month: 1–31, or the last day whatever the month's length. */
export type MonthDay = number | 'last'

/** How monthly and yearly schedules pick the day. */
export type MonthlyRule =
  | { kind: 'dayOfMonth', day: MonthDay }
  /** 'the second Tuesday', or with week -1, 'the last Friday'. weekday: 0 = Sunday. */
  | { kind: 'nthWeekday', week: 1 | 2 | 3 | 4 | -1, weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 }

/** What to do when an occurrence lands on a Saturday or Sunday. */
export type WeekendRule = 'none' | 'before' | 'after'

export type ScheduleEnd =
  | { kind: 'never' }
  | { kind: 'onDate', date: string }
  /** Stops after this many occurrences counted from the start date, entered or skipped. */
  | { kind: 'afterCount', count: number }

export interface Schedule {
  frequency: Frequency
  /** Every `interval` units of the frequency; at least 1. Ignored by `semiMonthly`. */
  interval: number
  /** YYYY-MM-DD: the first occurrence, and the anchor every later one is measured from. */
  startDate: string
  /** `monthly` and `yearly`. Default: the start date's day of the month. */
  monthlyRule?: MonthlyRule
  /** `semiMonthly` only: the two days of each month, ascending. Default `[1, 'last']`. */
  semiMonthlyDays?: [MonthDay, MonthDay]
  /** `yearly` only, 1–12. Default: the start date's month. */
  month?: number
  /** Default `'none'`. */
  weekendRule?: WeekendRule
  /** Default `{ kind: 'never' }`. */
  end?: ScheduleEnd
}
```

### Everything Money offered, in five frequencies

| Money's choice | `frequency` | `interval` |
|---|---|---|
| Daily | `daily` | 1 |
| Weekly | `weekly` | 1 |
| Every two weeks | `weekly` | 2 |
| Every four weeks | `weekly` | 4 |
| Twice a month | `semiMonthly` | — |
| Monthly | `monthly` | 1 |
| Every two months | `monthly` | 2 |
| Quarterly | `monthly` | 3 |
| Twice a year | `monthly` | 6 |
| Yearly | `yearly` | 1 |

Every other interval is available too (`daily` every 10, `yearly` every 2), which
Money did not offer and which costs nothing.

### Generating occurrences

```ts
export interface Occurrence {
  /** 0-based position in the schedule's sequence. Occurrence 0 is on the start date. */
  index: number
  /** YYYY-MM-DD, after the weekend rule has been applied. This is the date a transaction gets. */
  date: string
  /** The unadjusted date, present only when the weekend rule moved it. */
  scheduledDate?: string
}

/** The occurrence at `index`, or undefined when the end rule has passed. Pure, total, no clock. */
export function occurrenceAt(schedule: Schedule, index: number): Occurrence | undefined

/** Occurrences in ascending order, from `fromIndex` (default 0), stopping at `until`, `limit` or the end rule. */
export function occurrencesFrom(
  schedule: Schedule,
  options?: { fromIndex?: number, until?: string, limit?: number }
): Occurrence[]

/** The index of the first occurrence on or after `date`, or undefined when the series ends before it. */
export function firstIndexOnOrAfter(schedule: Schedule, date: string): number | undefined

/** How many occurrences fall on or before `date`, from `fromIndex`. The overdue count; capped at MAX_OCCURRENCES. */
export function countThrough(schedule: Schedule, fromIndex: number, date: string): number

/** "Monthly on the 15th", "Every two weeks on Friday", "Yearly on 1 July". For the list and the dialog. */
export function describeSchedule(schedule: Schedule): string

/** Why a schedule can't be used, or undefined. Shown inline by the dialog, enforced by the service. */
export function validateSchedule(schedule: Schedule): string | undefined

// Published with them, because the service and the views need the same date arithmetic and the same words:
export function addIsoDays(iso: string, n: number): string
/** 0 for Sunday, 6 for Saturday. */
export function weekdayOf(iso: string): number
export function applyWeekendRule(iso: string, rule: WeekendRule | undefined): string
/** '1st', '2nd', '11th', '21st'. */
export function ordinal(n: number): string
```

Two details the signatures don't show, both settled while building it:

- **`until` is compared with the date a transaction would get**, weekend rule
  and all, since that is what a caller is asking about. The search can stop at
  the first occurrence past it because a weekend rule never makes a later
  occurrence land earlier than an earlier one.
- **An end date is compared with the anchor**, not with a date a weekend rule
  moved, because the end date belongs to the rule in the same way the start
  date does. So a 1 January anchor that a `'before'` rule moves to 31 December
  is still outside an end of 31 December.

The rules the engine follows, each of which is a test:

- **The index is the anchor, not the last date.** Occurrence *n* is computed
  from `startDate` and *n*, so no error accumulates and no clamping compounds.
- **Occurrence 0 is the start date**, unless an explicit day, month or pair of
  days puts the rule's first date earlier than it ("monthly on the 15th,
  starting the 20th"), when occurrence 0 is the first the rule produces on or
  after the start date. Nothing before the start date is ever an occurrence.
- **Monthly and yearly clamp, and remember.** `dayOfMonth: 31` gives
  31 Jan, 28 Feb (29 in a leap year), 31 Mar. `day: 'last'` gives the last day
  of each month. `nthWeekday` with `week: 5` is not offered; `-1` means "last".
- **Semi-monthly** produces two occurrences per month, on
  `semiMonthlyDays[0]` and `[1]`, each clamped. Its index runs 0, 1, 2 …
  through both days, so "end after 6" means three months.
- **The business-day rule moves the date, never the sequence.** `'before'`
  moves to the nearest business day before the anchor, `'after'` to the
  nearest one after it. A business day is one that is not a Saturday, not a
  Sunday, and not in the book's holiday list (`BusinessCalendar`, below). The
  next occurrence is still measured from the unadjusted anchor, so a rule can
  never drift a series, and a run of non-business days (Christmas on a Friday,
  the weekend, Boxing Day observed on the Monday) is stepped over as one.
  Without a calendar only weekends count, which is what the renderer's preview
  gets unless the dialog is handed the holidays.
- **`end: { kind: 'afterCount', count }`** stops the sequence after `count`
  occurrences from index 0, whether they were entered or skipped. This is why
  the index is stored (decision 3).
- **Dates are plain `YYYY-MM-DD` strings throughout**, validated with
  `isIsoDate` from `@tessera/accounts-api`. No `Date` object crosses a
  function boundary, and no time zone enters the arithmetic.

---

### Holidays: the book's business calendar

Added after review asked for business-day adjustment. Public holidays differ by
country and province and the app has no settings framework yet, so the list is
**per book**, kept in `recurring.holidays` (`{ date, name }`, one per date) and
edited from *Holidays…* on the Recurring view's toolbar and the Accounts menu.
The schedule engine takes it as a `BusinessCalendar`:

```ts
export interface BusinessCalendar { holidays?: Iterable<string> }
occurrenceAt(schedule, index, calendar?)
occurrencesFrom(schedule, { …, calendar? })
firstIndexOnOrAfter(schedule, date, calendar?)
countThrough(schedule, fromIndex, date, calendar?)
```

The service reads the list once per operation and hands it to every engine
call, so the snapshot, the forecast, entering and skipping all agree. Because a
series stores `nextDate` for sorting, **adding or removing a holiday places
every series' next date again** from its index, in the same storage
transaction as the holiday itself; only the ones that moved are announced. The
index is the truth and the date is derived, which is exactly why this is safe.

---

## The domain

### The series document

```ts
/** What a series does with money, derived from its template; never stored. */
export type SeriesKind = 'payment' | 'deposit' | 'transfer'

export function seriesKind(template: Pick<SeriesTemplate, 'amount' | 'transferAccountId'>): SeriesKind {
  if (template.transferAccountId !== undefined) return 'transfer'
  return template.amount < 0 ? 'payment' : 'deposit'
}

/** The transaction a series writes. Nearly a `TransactionDraft`: it has no date, which the occurrence supplies. */
export interface SeriesTemplate {
  /** Minor units, signed from the account's point of view: a payment is negative. */
  amount: number
  /** A payee name, as the register takes it: created if new. */
  payee?: string
  /** A category, or… */
  categoryId?: string
  /** …the other account of a transfer (not both), as in `TransactionDraft`. */
  transferAccountId?: string
  memo?: string
  /** A fixed number or code, e.g. 'EFT'. Ignored when `autoNumber` is set. */
  number?: string
  /** Take the next cheque number from the account when entering (`transactions(id).nextNumber()`). */
  autoNumber: boolean
  /** The amount varies (a hydro bill). Entering asks for it first; the stored amount is the estimate. */
  estimated: boolean
}

export interface Series {
  id: string
  /** The account the transaction is written into. */
  accountId: string
  /** What the list shows. Defaults to the payee's name, or the transfer's other account. */
  name: string
  template: SeriesTemplate
  schedule: Schedule
  /** How many days before its date an occurrence counts as due soon. Default `DEFAULT_REMIND_DAYS` (3). */
  remindDays: number
  /** Enter it without asking when a book opens and it is due. Phase 6; false until then. */
  autoEnter: boolean
  /** Set by the user, or by the plugin when the account was closed (`pausedReason`). */
  paused: boolean
  pausedReason?: 'user' | 'accountClosed' | 'transferAccountGone'
  /** Index of the next occurrence that has been neither entered nor skipped. */
  nextIndex: number
  /** Its date, `occurrenceAt(schedule, nextIndex).date`; null once the series has ended. Stored so the list sorts in the database. */
  nextDate: string | null
  lastEnteredDate?: string
  enteredCount: number
  skippedCount: number
  /** The day the end rule was reached. A finished series is kept, greyed, until deleted. */
  endedOn?: string
  notes?: string
  createdAt: string
  updatedAt: string
  rev: number
}
```

`nextDate` is derived from `schedule` and `nextIndex`, and is stored only so the
database can index and range-query it. It is recomputed, never trusted, whenever
the schedule changes, and a consistency check on load repairs a mismatch (and
logs `[recurring]`).

### What has already happened: `recurring.postings`

```ts
export interface Posting {
  id: string
  seriesId: string
  accountId: string
  /** The occurrence's index and date, so history survives an edited schedule. */
  index: number
  dueDate: string
  outcome: 'entered' | 'skipped'
  /** For 'entered': the transaction `accounts.service` created. It may since have been deleted. */
  transactionId?: string
  /** The date the transaction was given: `dueDate`, or today when the user chose that. */
  date?: string
  /** Minor units, as entered: it can differ from the template for an estimated series. */
  amount?: number
  /** When the user did it, ISO 8601. */
  at: string
}
```

Postings are the audit trail and the answer to "did I already enter the
November one". They are never rewritten. A posting whose transaction has since
been deleted is left as it is: the history records what the user did, not what
survives.

### Due states

```ts
export type DueState =
  /** Its date is before today: it should have been entered already. */
  | 'overdue'
  | 'dueToday'
  /** Within `remindDays` of today. */
  | 'dueSoon'
  | 'upcoming'
  | 'paused'
  /** The end rule has been reached; nothing more is due. */
  | 'ended'

export function dueStateOf(series: Series, today: string): DueState
```

`paused` and `ended` win over the date states: a paused series is never
overdue, which is the point of pausing one.

### What the view is given

The privileged half resolves everything the renderer needs — account names,
payee names, category labels, the schedule's sentence — exactly as
`RegisterRow` does for the register, because the renderer has no access to the
accounts data except over IPC.

```ts
export interface RecurringRow {
  series: Series
  kind: SeriesKind
  /** The first occurrence not yet entered or skipped. Absent for an ended series. */
  occurrence?: Occurrence
  state: DueState
  /** Occurrences due on or before today: 1 when it is due today, 3 when two were also missed. */
  dueCount: number
  account: { id: string, name: string, type: AccountType, currency: string, closed: boolean }
  payeeName?: string
  /** `Parent : Child`, or `Transfer to: Savings`, as the register shows it. */
  categoryLabel?: string
  /** `describeSchedule(series.schedule)`. */
  scheduleLabel: string
  /** Why this row cannot be entered: a closed account, a missing transfer account. */
  blockedReason?: string
}

export interface RecurringSnapshot {
  /** One row per series: live ones ascending by `occurrence.date`, then paused ones, then finished ones. */
  rows: RecurringRow[]
  summary: {
    overdueCount: number
    /** Per currency, like `Chart.totals`: a book can hold accounts in several. */
    overdueTotals: CurrencyTotals
    dueSoonCount: number
    dueSoonTotals: CurrencyTotals
    /** Rows with a `blockedReason`. */
    blockedCount: number
  }
  /** The local date the states were computed against. */
  today: string
}
```

Sorting: live series first, ascending by `occurrence.date` and then by
`series.name`; then paused ones, by the same key; then finished ones. Overdue
rows need no special sort — their dates are in the past, so ascending order
already puts them first, which is what the request asks for.

**Which series are listed at all**, settled while building the service: a
series the *user* paused is left out unless *Show paused* is ticked, but one
the **plugin** paused — because its account was closed — is always listed, with
its `blockedReason`. The user never asked for that one to stop, so hiding it
would hide the problem.

**The overdue figures count every missed occurrence**, not just the next one:
three months of a $142 bill is $426 outstanding, and that is the number worth
showing.

---

## `recurring.service`

```ts
export interface SeriesFilter {
  accountId?: string
  kinds?: SeriesKind[]
  /** Default false: paused series are left out of forecasts. */
  includePaused?: boolean
  /** Default false. */
  includeEnded?: boolean
}

/** What the dialog sends. The service derives `nextIndex`, `nextDate` and the counts. */
export interface SeriesInput {
  accountId: string
  name?: string
  template: SeriesTemplate
  schedule: Schedule
  remindDays?: number
  autoEnter?: boolean
  notes?: string
}

export type SeriesPatch = { /* every field of SeriesInput, optional; null clears an optional one */ }

/**
 * One occurrence to enter, as the enter dialog sends it. Every field but `seriesId` is an override of what the
 * series would otherwise produce; the dialog fills them in from the occurrence, so they are normally all present.
 */
export interface EnterRequest {
  seriesId: string
  /** Signed, minor units. Defaults to the template's amount. */
  amount?: number
  /** YYYY-MM-DD. Defaults to the occurrence's date — the date the transaction is *for* (decision 6). */
  date?: string
  /** Defaults to the template's number, or the account's next cheque number when `autoNumber` is set. */
  number?: string
  memo?: string
}

export interface EnterResult {
  entered: { seriesId: string, transactionId: string, accountId: string, date: string, amount: number }[]
  failed: { seriesId: string, code: RecurringErrorCode, message: string }[]
}

/** One occurrence of one series in a window, for a forecast. */
export interface ForecastEntry {
  seriesId: string
  accountId: string
  name: string
  kind: SeriesKind
  date: string
  amount: number
  currency: string
  estimated: boolean
}

/** The `recurring.service` service. Every method fails with NO_BOOK while no book is open. */
export interface RecurringService {
  get(id: string): Promise<Series | undefined>
  list(filter?: SeriesFilter): Promise<Series[]>

  /** Everything the Recurring view shows, resolved and sorted. */
  snapshot(options?: { includePaused?: boolean, includeEnded?: boolean }): Promise<RecurringSnapshot>

  /**
   * Every occurrence of every matching series in `range`, ascending — not just the first. For a later cash-flow
   * or budget feature. Bounded: at most `MAX_FORECAST_ENTRIES`, and `range` must be at most ten years.
   */
  forecast(range: { from: string, to: string }, filter?: SeriesFilter): Promise<ForecastEntry[]>

  create(input: SeriesInput): Promise<Series>
  /**
   * From a transaction already in a register: the template is taken from it, and the transaction is recorded as the
   * series' last entry (a `Posting`), so the schedule starts at the next occurrence after it and nothing repeats.
   */
  createFromTransaction(accountId: string, transactionId: string, schedule: Schedule): Promise<Series>
  update(id: string, patch: SeriesPatch, options?: WriteOptions): Promise<Series>
  /** The transactions a series has already produced stay in their registers. */
  delete(ids: string[], options?: WriteOptions): Promise<void>
  setPaused(ids: string[], paused: boolean): Promise<void>

  /**
   * Writes each request's occurrence into its account's register and advances its series. Sequential, in ascending
   * date order; a failure stops neither the rest nor what was already written (decision 7).
   */
  enter(requests: EnterRequest[], options?: WriteOptions): Promise<EnterResult>

  /** Advances past the next occurrence (or `count` of them) without writing anything, recording a skipped posting. */
  skip(ids: string[], options?: { count?: number }): Promise<void>

  history(seriesId: string, limit?: number): Promise<Posting[]>

  readonly onDidChange: Event<RecurringChange>
}

export interface RecurringChange {
  created: string[]
  updated: string[]
  deleted: string[]
  /** Accounts whose registers now have a new transaction, so they reload. */
  accounts: string[]
  /** Anything the Recurring view shows changed. */
  snapshot: boolean
}
```

### Rules the service enforces

As with `accounts.service`, these live in the service, not in the dialog, so a
future importer or a script cannot get round them:

- The account must exist and not be closed, both to create a series and to
  enter one. A closed account's series are paused, with `pausedReason`.
- A template has a `categoryId` **or** a `transferAccountId`, never both —
  the same rule `TransactionDraft` follows.
- A transfer's other account must exist, be open, and be in the same currency
  (`CURRENCY_MISMATCH` comes back from `accounts.service`, and is passed on).
- The amount is a valid minor-unit amount (`isAmount`). Zero is allowed only
  when `estimated` is set — an estimated series with no estimate yet.
- `validateSchedule` must pass: `interval >= 1`, `dayOfMonth` in 1–31 or
  `'last'`, a `month` in 1–12, `semiMonthlyDays` distinct and ascending, an
  `onDate` end not before `startDate`, an `afterCount` of at least 1.
- `name` follows the account-name rules (trimmed, at most 100 characters, no
  control characters). It need not be unique.
- `remindDays` is 0–90.
- Entering a paused or ended series fails (`SERIES_PAUSED`, `SERIES_ENDED`)
  rather than quietly doing nothing.
- Editing is write-through: there is no save step, as there is none anywhere
  else in the app (account manager decision 4).

### Errors

`@tessera/recurring-api/errors.ts` mirrors
[accounts-api/errors.ts](../packages/accounts-api/errors.ts) exactly — the same
shape-based `isRecurringError`, the same `RecurringResult` and
`toRecurringResult` for IPC replies — because each plugin bundles its own copy
of the package and `instanceof` cannot work across them.

```ts
export type RecurringErrorCode =
  | 'NO_BOOK' | 'READ_ONLY' | 'NOT_FOUND' | 'INVALID' | 'CONFLICT'
  /** The series' account is closed. */
  | 'ACCOUNT_CLOSED'
  /** The series is paused, or has reached its end rule. */
  | 'SERIES_PAUSED' | 'SERIES_ENDED'
  /** The transfer's other account is gone or in another currency; the message is the accounts service's. */
  | 'TRANSFER_UNAVAILABLE'
  | 'CONFIRMATION_REQUIRED'

export type RecurringConfirmation =
  /** Entering an occurrence dated more than a year in the past, or more than a year ahead. */
  | 'unusualDate'
  /** A transaction with the same account, date and amount already exists: possibly a double entry. */
  | 'possibleDuplicate'
```

An `AccountsError` thrown by `accounts.service` during `enter` is caught,
mapped to the closest `RecurringErrorCode`, and its message passed through
unchanged — the account manager already words these for the user.

---

## Storage schema (`recurring`)

Contributed through `book.schema` as `accounts` does, with contributor id
`recurring` and schema version 1. The collections live in the book's own file,
so a book is still one file and a transfer is still atomic.

```ts
export const RECURRING_COLLECTIONS = {
  series: 'recurring.series',
  postings: 'recurring.postings'
} as const

export const RECURRING_SCHEMA: SchemaContribution = {
  id: RECURRING_PLUGIN_ID,
  version: RECURRING_SCHEMA_VERSION,       // 1
  migrator: RECURRING_MIGRATOR_SERVICE,
  collections: [
    {
      name: RECURRING_COLLECTIONS.series,
      indexes: [
        // The Recurring view's query: everything due, in order
        { name: 'byNextDate', fields: ['nextDate'] },
        // Cleaning up when an account is closed or deleted, and a register's "what is scheduled here"
        { name: 'byAccount', fields: ['accountId', 'nextDate'] }
      ]
    },
    {
      name: RECURRING_COLLECTIONS.postings,
      indexes: [
        { name: 'bySeries', fields: ['seriesId', 'dueDate'] },
        // Sparse: only an entered posting has one. Finds the series behind a transaction
        { name: 'uniqueTransaction', fields: ['transactionId'], unique: true }
      ]
    }
  ]
}
```

The migrator has nothing to seed: version 0 → 1 declares the collections and
returns. It exists because `SchemaContribution` requires one, and because
version 2 will need it. Declaring a new collection needs no migration, which is
the same reason `accounts` could add `reconciliations` without a version bump.

---

## Entering an occurrence

This is the heart of the feature. One occurrence:

1. Load the series. Refuse with `SERIES_PAUSED` / `SERIES_ENDED` / `NOT_FOUND`
   if it has changed since the view read it.
2. Load the account through `accounts.service.get`. Refuse with
   `ACCOUNT_CLOSED` if it is closed.
3. Build a `TransactionDraft`:
   - `date`: `request.date ?? occurrence.date` — the date the transaction is
     *for*, never the date it was entered on (decision 6);
   - `amount`: `request.amount ?? template.amount`;
   - `number`: `request.number ?? (template.autoNumber ? await
     transactions(accountId).nextNumber() : template.number)`;
   - `payee`, `memo`, and `categoryId` **or** `transferAccountId`, from the
     template;
   - `status`: left unset, so it is `uncleared`. A scheduled transaction has
     not cleared the bank.
4. Ask for confirmation if needed: a date more than a year from today
   (`unusualDate`), or a transaction already in the account with the same date
   and amount (`possibleDuplicate`). The caller re-sends with `confirm`, the
   pattern the register already uses for reconciled transactions.
5. `accounts.service.transactions(accountId).create(draft)` — which creates the
   payee if new, writes both sides of a transfer, and enforces every rule.
6. In **one** `recurring` storage transaction: insert the `Posting`, and
   advance the series — `nextIndex + 1`, recompute `nextDate`, set
   `lastEnteredDate`, `enteredCount + 1`, and `endedOn` when the end rule is
   reached (`nextDate` becomes null).
7. Emit `onDidChange` with the account in `accounts`, so the register reloads.

Several occurrences are the same loop, in ascending date order, collecting
`entered` and `failed`. The view reports "3 of 4 entered" and lists the reasons.

Steps 5 and 6 are two transactions in two different plugins' collections, which
is unavoidable (decision 7 and the gap table). The window between them is a
single `await`; if the app dies inside it, the transaction exists and the series
has not advanced, so the user would see the same occurrence still due. The
`possibleDuplicate` check in step 4 is what catches that on the next attempt.

### The enter dialog

*Enter in Register* always opens it, for one occurrence or for twenty
(decision 6a). It is one table, a row per selected occurrence:

| Column | Editable | Notes |
|---|---|---|
| Name | no | The series' name, and its account beneath |
| Date | yes | The occurrence's date. Changing it changes only this transaction |
| Payee | no | Shown so the row is recognisable |
| Category / Transfer | no | Edit the series, or the transaction afterwards, to change it |
| Number | yes | Pre-filled with the account's next cheque number when `autoNumber` is set |
| Amount | yes | Signed by the account's convention, with the register's two labelled fields for a single row and one signed field in a multi-row table |
| Memo | yes | |
| — | — | A *Use as the new estimate* tick box on an `estimated` row |

An estimated row is marked and focused first, since its amount is the one that
certainly needs attention. Rows that cannot be entered (a closed account) are
not offered: the view disables their tick boxes before the dialog opens.

Confirming sends one `EnterRequest` per row. Entering a different amount does
not change the series unless *Use as the new estimate* is ticked, which applies
a `SeriesPatch` after the entry succeeds.

Because the dialog lists everything that is about to be written, it is also the
confirmation step: *Enter All Overdue* needs no second "are you sure".

### Skipping

*Skip* advances exactly as entering does, minus steps 3–5, and writes a posting
with `outcome: 'skipped'`. It is the only way to clear an overdue occurrence a
user does not intend to pay — without it, the warning would be permanent, and a
permanent warning is ignored.

*Skip to today* on an overdue row advances past every occurrence on or before
today in one step (`skip(ids, { count: row.dueCount })`), for a book that has
been left alone for months.

---

## The Recurring view

A main-area view, `recurring.list`, present while a book is open. Icon
`CalendarToday`. It shares `shell.main` with the register and the start view;
`recurring.open` reveals it.

### Layout

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Recurring Transactions                        Overdue  −$284.12   Next 7 days │
│                                                3 items             −$142.00   │
├───────────────────────────────────────────────────────────────────────────────┤
│ [+ New] [Enter in Register] [Skip] [Edit] [Delete] [Pause]   ☐ Show paused     │
├───────────────────────────────────────────────────────────────────────────────┤
│ ⚠ 3 transactions are overdue, the oldest due 1 October.  [Enter All Overdue]   │
├───┬──────────┬───────────────────┬────────────┬──────────────┬────────────────┤
│ ☐ │ Due      │ Name              │ Account    │ Category     │        Amount  │
├───┼──────────┼───────────────────┼────────────┼──────────────┼────────────────┤
│ ☑ │ 1 Oct ⚠  │ Hydro        ③    │ Chequing   │ Electricity  │      −142.00   │
│ ☐ │ 15 Oct ⚠ │ Mortgage          │ Chequing   │ Transfer to… │    −1,450.00   │
│ ☐ │ 1 Nov ⚠  │ Hydro             │ …          │ …            │                │
│ ☐ │ 13 Nov   │ Salary            │ Chequing   │ Salary       │    +2,840.00   │
│ ☐ │ 15 Nov   │ Car insurance est.│ Visa       │ Car insurance│      −118.00   │
│ ☐ │ 1 Dec    │ Savings transfer  │ Chequing   │ Transfer to: │      −500.00   │
└───┴──────────┴───────────────────┴────────────┴──────────────┴────────────────┘
  Monthly on the 1st · last entered 1 September · 4 of 12 entered
```

- **One row per series** — its first unentered occurrence — in ascending date
  order, as the request asks. Overdue dates are in the past, so they lead.
- **The ③ chip** on a row says three occurrences of that series are due on or
  before today (`dueCount`), without breaking the one-row-per-series rule. Its
  tooltip lists the dates.
- **Amount** is one signed column, not the register's two, because the rows
  come from accounts of different types whose column labels differ. Negatives
  are red, as balances are. An estimated amount is marked `est.`
- **The footer** describes the selected row: its schedule in words, when it was
  last entered, and its progress against an end rule.
- **Figures at the top** are per currency, like the chart's totals; a book with
  one currency shows one figure.
- **Columns** beyond those shown, for a wide window: *Frequency*, *Last
  entered*, *Payee*. Narrow windows drop *Category* first.

### Selection and entering

- A tick box per row, plus click to select, `Shift`+click for a range and
  `Ctrl`+click to add — the conventions the register already follows.
- A tick box in the header selects every row that can be entered.
- **Enter in Register** acts on the ticked rows, or on the selected row when
  none is ticked. It is disabled while the selection contains only blocked rows.
- **Enter All Overdue** in the banner ticks and enters every overdue row in one
  action, which is the common case when a book has been left for a while.
- After entering, a dismissible `Alert` reports the result: "3 entered." or
  "2 of 3 entered. Hydro: “Chequing” is closed. Reopen it to change its
  transactions." with **Open Register** for a single account's entry.
- Blocked rows (closed account, missing transfer account) are shown greyed,
  with the reason in the row and the tick box disabled. They are never silently
  hidden: a series that cannot run is exactly what the user needs to see.

### Keyboard

Following the register's model, so the two feel the same:

| Key | Does |
|---|---|
| `↑` `↓` `Home` `End` | Move the selection |
| `Space` | Tick or untick the row |
| `Enter` | Enter the ticked rows (or the selected row) |
| `Ctrl`+`Enter` | Enter the ticked rows, skipping the enter dialog's focus step |
| `Insert` | New recurring transaction |
| `Delete` | Delete the selected series, after confirming |
| `F2` | Edit the selected series |
| `Ctrl`+`A` | Tick every enterable row |

### Warnings

Five, in order of how hard they are to miss, none of them modal (decision 10):

1. **The banner.** An `Alert severity="warning"` above the list whenever
   `overdueCount > 0`, naming the count and the oldest date, with **Enter All
   Overdue**. A second `severity="info"` banner when nothing is overdue but
   something is due within `remindDays`.
2. **The rows.** An overdue row shows a `Warning` icon beside its date, in
   `error.main`, and the date itself in the same colour. Due-today rows use
   `warning.main`. This is the only colour-carrying information in the list,
   and it is never the *only* signal — the icon and the sort position carry it
   too, for a user who cannot distinguish the colours.
3. **The bottom bar.** A `BorderTextItem`, present only while something is
   overdue, whose command opens the view:
   ```ts
   {
     kind: 'text', id: 'recurring.status.overdue', slot: 'shell.bottom', align: 'end',
     icon: 'Warning', text: '{recurring.overdue.summary}',
     command: RECURRING_COMMANDS.open,
     when: 'recurring.overdue.count'        // a count of 0 is falsy; the grammar has no '>'
   }
   ```
   `recurring.overdue.summary` holds the finished phrase ("3 transactions
   overdue"), because the text item interpolates but cannot pluralise.
4. **The navigator.** The contributed *Recurring* row carries a badge with
   the overdue count, in `error` tone, so the warning is visible while the
   register is in front (review decision D). See
   [The navigator's Recurring row](#the-navigators-recurring-row).
5. **On opening a book.** When a book opens with anything overdue, the
   Recurring view is revealed, as the accounts navigator is revealed when a
   book is created. It is a reveal, not a dialog: the user can ignore it.

"Today" is recomputed when the book opens, when the window regains focus, and
on a timer that fires at the next local midnight. Each recomputation re-emits
the snapshot only when the date has actually changed.

---

## The Upcoming panel and the projected balance

Two of the "later" items, built once the forecast existed.

**Upcoming** (`recurring.upcoming`, in `shell.right`) is the forecast made
visible: every occurrence over the next 7, 30 or 90 days, across every account,
grouped by day, with the net per currency at the top. Transfers are shown but
left out of the net, since across the book they are a wash. It re-asks whenever
the snapshot moves, so a skip or an entry in the main area changes it at once.
Anything overdue is a one-line warning above the list, and clicking anywhere
opens the Recurring view — the panel reads; the view acts.

**The register's projected balance** is contributed, because the register is
`accounts`' and `recurring` must not reach into it. `accounts` gains a fourth
small extension point, `accounts.register.figures`: a figure above the register
is plain data naming a command, which the register runs with `{ accountId }`
and which resolves a `{ minor, currency, detail? }` — or nothing, in which case
no figure is shown. A contribution may name a `refreshOn` event; the register
asks again when it fires. `recurring` contributes *Projected (30 days)*: the
current balance plus everything due in the window, **transfers into the account
included** (the forecast says where a transfer lands, so Savings sees the money
Chequing is sending it). An account with nothing scheduled shows no figure,
rather than one that merely repeats Current.

This is the fourth bespoke point in `accounts`. It is not a context menu, so it
does not trigger the `shell.contextMenus` consolidation the previous section
describes — but it is the same shape as the other three (plain data naming a
command, resolved by `points.ts`), and a general "contributed figure" point
would absorb it the same way.

**Revealing the view on open.** When a book opens — not when one is created,
which has nothing in it — and the snapshot has anything overdue, the Recurring
view is revealed. It is a reveal, not a dialog: the user can look away.

---

## The series dialog

A `shell.dialogs` contribution, `recurring.dialog.series`, size `md`, shown by
`shell.prompts.show`, in the pattern `AccountDialog` established.

**Why a dialog, and not an inline row editor** (asked in review): a transaction
has six fields and the register edits one in place; a series has those six
*plus* the whole repeat rule — frequency, the day in the month, the weekend
rule, when it ends, the reminder window. That does not fit a row, and Money and
Quicken both use a dialog for the same reason. The list earns its keep instead
by answering the common question without opening anything: the strip under it
names the selected series' schedule, when it was last entered, how many have
gone in and when it ends.

| Field | Notes |
|---|---|
| **Name** | Defaults to the payee as it is typed; the user may override |
| **Account** | Open accounts only, grouped by sub-book, from `ACCOUNTS_CHANNELS.chart` |
| **Payee** | The register's autocomplete, over `ACCOUNTS_CHANNELS.searchPayees` |
| **Payment / Deposit** | Two amount fields labelled by the account's type, from `AMOUNT_COLUMNS` — the same convention as the register, so "Charge / Payment" appears for a credit card |
| **Amount varies** | Sets `estimated`; the amount entered becomes the estimate |
| **Category or Transfer to** | One control, as the register's is, over `ACCOUNTS_CHANNELS.categories` |
| **Number** | A fixed number or code, or *Use the next cheque number* (`autoNumber`) |
| **Memo** | |
| **Frequency** | The ten Money choices in one select, mapped to `frequency` + `interval`; *Custom…* reveals the raw pair |
| **Starting** | `startDate`. For monthly and yearly, a *on the …* control offering the day of the month, *the last day*, or *the second Tuesday* |
| **If it falls on a weekend** | `weekendRule` |
| **Ends** | Never / On a date / After *n* times |
| **Remind me** | `remindDays`, 0–90 |
| **Notes** | |

Below the fields, a live preview — **"Monthly on the 15th. Next: 15 Nov, 15
Dec, 15 Jan"** — recomputed from `describeSchedule` and `occurrencesFrom` in the
renderer, with no round trip, which is why the engine is in the package and not
in the plugin.

Validation is `validateSchedule` and the field rules, run as the user types and
again in the service. A duplicate name is allowed and not warned about: two
"Hydro" series in two accounts are legitimate.

---

## Making a series from a transaction

The request asks for a context-menu action on a register row. The register
already builds a row menu and already appends contributed items to it — but
only from `accounts.reconcile.actions`, whose name and `scope: 'transaction'`
exist for a reconciler marking rows. Rather than smuggle a recurring action
through a reconciliation point, `accounts` gains a general one.

### `accounts.transaction.actions` (new extension point in `accounts`)

```ts
export const TRANSACTION_ACTIONS_POINT = 'accounts.transaction.actions'

/**
 * An item in a register row's context menu. Plain data: behaviour lives in the command it names, exactly as
 * `ReconcileActionContribution` does. Contributed with
 * `context.extensions.contribute(pluginId, TRANSACTION_ACTIONS_POINT, id, contribution)`.
 */
export interface TransactionActionContribution {
  /** `<pluginId>.<name>`. */
  id: string
  label: string
  /** Run with one argument, `TransactionActionArgs`. Its enablement decides whether the item is enabled. */
  command: string
  /** Shown only for these account types. Default: all. */
  accountTypes?: AccountType[]
  /** Shown only when exactly one row is selected. Default false. */
  singleOnly?: boolean
  /** Hidden while the account is closed. Default true. */
  needsEditable?: boolean
  icon?: string
  description?: string
  order?: number
}

export interface TransactionActionArgs {
  accountId: string
  transactionIds: string[]
}
```

The register resolves these over a new channel, `accounts:transaction.actions`,
exactly as it resolves reconcile actions today, and renders them in the row menu
after its own items, separated by a `Divider`. Transaction-scope reconcile
contributions are resolved into the same list, so nothing that exists today
breaks; `scope: 'transaction'` is documented as deprecated in favour of the new
point.

### Why the Recurring view's own menu is not an extension point

Asked in review: should there be a context-menu extension point, so the
recurring plugin can add *Edit…* to a series' menu?

**No — not for its own items.** An extension point exists so *another* plugin
can contribute. The recurring plugin owns the view, the row and the series, so
routing its own menu through its own point would be indirection with nothing on
the other end. The register already works this way: its Edit, Void and Delete
are plain code, and only contributed items come through a point. The Recurring
view's menu is the same — plain items, each running a command, so the menu, the
toolbar and the keyboard share one set of rules and confirmations.

**The generic point is still the right eventual answer.** Three bespoke points
now exist (`accounts.reconcile.actions`, `accounts.transaction.actions`,
`accounts.navigator.items`), and the [todo](todo.md#menus-commands-and-context-keys)
already carries "context menus and toolbars as extension points bound to the
same commands". A *fourth* should trigger replacing them with one shell-level
`shell.contextMenus`: contributions name the menu they target
(`accounts.register.row`, `recurring.series`), carry a `when`, and are resolved
by the shell the way `shell.menus` already is. That is framework work with its
own note, and nothing wants to contribute to a recurring row today, so it is
not being done inside this feature.

### The action

```ts
{
  id: 'recurring.fromTransaction',
  label: 'Make Recurring…',
  command: RECURRING_COMMANDS.fromTransaction,
  icon: 'Repeat',
  singleOnly: true,
  description: 'Schedule this transaction to repeat'
}
```

`recurring.fromTransaction` reads the transaction through `accounts.service`,
fills a `SeriesTemplate` from it (amount, payee, memo, category or transfer
account; the number is dropped, since a cheque number does not repeat), guesses
a schedule — monthly on the transaction's day of the month — and opens the
series dialog with all of it. The dialog is the same one *New…* opens, with its
title changed.

On confirming, `createFromTransaction` records the source transaction as a
`Posting` with `outcome: 'entered'`, sets `lastEnteredDate` to its date, and
sets `nextIndex` to the first occurrence after it (decision 12). So a bill paid
on 1 November becomes a series next due on 1 December, with no false overdue
warning and no duplicate in the register.

---

## The navigator's Recurring row

Decided in review (D). The Accounts navigator is the left bar a user of this
app looks at most, so it is where a *Recurring* row belongs — showing the
overdue count without the Recurring view being open. The navigator is
`accounts`', so it gains a second extension point.

### `accounts.navigator.items` (new extension point in `accounts`)

```ts
export const NAVIGATOR_ITEMS_POINT = 'accounts.navigator.items'

/** A row another plugin adds to the Accounts navigator, above or below the book tree. */
export interface NavigatorItemContribution {
  /** `<pluginId>.<name>`. */
  id: string
  label: string
  /** Run with no argument when the row is clicked, or Enter is pressed on it. */
  command: string
  icon?: string
  /** Above the book row, or below the whole tree. Default 'bottom'. */
  placement?: 'top' | 'bottom'
  /**
   * A context key whose value is shown as a badge at the right of the row while it is truthy. The navigator
   * re-reads it whenever it changes, so a count stays live without the contributing plugin pushing anything.
   */
  badgeKey?: string
  /** Styles the badge: 'warning' and 'error' colour it, 'default' does not. Default 'default'. */
  badgeTone?: 'default' | 'warning' | 'error'
  /** Tooltip. */
  description?: string
  order?: number
}

/** A contribution as the navigator receives it, with its command's state and its badge resolved. */
export interface ResolvedNavigatorItem {
  id: string
  label: string
  command: string
  icon?: string
  placement: 'top' | 'bottom'
  badgeTone: 'default' | 'warning' | 'error'
  description?: string
  enabled: boolean
  /** The badge's text now, when `badgeKey` is set and its value is truthy. */
  badge?: string
}
```

The navigator fetches these over `accounts:navigator.items` and re-fetches on
`accounts:navigator.items.changed`, which the plugin emits when the
contributions change **or** when any contributed `badgeKey` changes value —
the accounts plugin subscribes to `contextKeys.onDidChange` for exactly the
keys its contributors named. A contributed row sits **outside** the `role="tree"`
element, as a button: it is no part of the book's structure, it never becomes
the navigator's `Selection` (so the Accounts menu's enablement is unaffected),
and inside the tree it could not be reached by keyboard, since the arrow keys
walk the chart's own rows. It is its own tab stop, and `Enter` or `Space` runs
its command.

`recurring` contributes:

```ts
{
  id: 'recurring.navigator.list',
  label: 'Recurring',
  command: RECURRING_COMMANDS.open,
  icon: 'Repeat',
  placement: 'bottom',
  badgeKey: RECURRING_CONTEXT_KEYS.overdueCount,
  badgeTone: 'error',
  description: 'Payments and deposits that repeat'
}
```

---

## Commands, menu and context keys

```ts
export const RECURRING_COMMANDS = {
  /** Reveals the Recurring view. */
  open: 'recurring.open',
  /** Argument (optional): `{ accountId }` to preselect. Opens the series dialog. */
  new: 'recurring.series.new',
  /** Argument: `{ id }`. */
  edit: 'recurring.series.edit',
  /** Argument: `{ ids }`. */
  delete: 'recurring.series.delete',
  /** Argument: `EnterRequest[]`, or `{ ids }` for the plain case. */
  enter: 'recurring.enter',
  /** Every overdue and due-today occurrence, after confirming. */
  enterDue: 'recurring.enterDue',
  /** Argument: `{ ids, count? }`. */
  skip: 'recurring.skip',
  /** Argument: `{ ids }`. */
  pause: 'recurring.pause',
  resume: 'recurring.resume',
  /** Argument: `TransactionActionArgs`. The register's row menu. */
  fromTransaction: 'recurring.fromTransaction'
} as const
```

Menu items go into the **Accounts** menu, in a group of their own, so the
finance commands stay in one place rather than adding a third top-level menu
for one feature:

```ts
item('recurring.menu.new',    'New &Recurring Transaction…', C.new,      ACCOUNTS_MENU.groups.recurring),
item('recurring.menu.manage', 'Recurring &Transactions',     C.open,     ACCOUNTS_MENU.groups.recurring),
item('recurring.menu.enter',  'Enter &Due Transactions…',    C.enterDue, ACCOUNTS_MENU.groups.recurring),
{ kind: 'item', id: 'recurring.view.list', label: '&Recurring', parent: 'shell.view', command: C.open }
```

This needs `accounts` to publish its menu and group ids (the phase 0
prerequisite); until then the strings would have to be copied, which the
repository's naming rule forbids. A group id `accounts.menu.recurring` with
`order: 40` is added to `accounts`' own `MENUS` list, so the separator is drawn
whether or not `recurring` is installed.

Context keys, set by the privileged half whenever the snapshot changes:

| Key | Value |
|---|---|
| `recurring.overdue.count` | Number of overdue series. Falsy at 0, which is how `when` tests it |
| `recurring.overdue.summary` | "3 transactions overdue" — the bar item's text |
| `recurring.due.count` | Overdue plus due-today |
| `recurring.hasSeries` | The book has at least one series |

Enablement: `recurring.new` and `recurring.open` need
`book.isOpen && !book.isReadOnly` (and `book.isOpen` alone for `open`);
`recurring.enterDue` needs `book.isOpen && !book.isReadOnly &&
recurring.due.count`.

The view's own toolbar buttons are enabled from the renderer's selection state,
not from context keys — a selection in a view cannot reach the main process
without a round trip per click, and nothing outside the view needs to know it.

---

## IPC and events

Named with `channelFor('recurring', …)`, as every plugin's are. Replies that can
fail because of the user are `RecurringResult`s.

```ts
export const RECURRING_CHANNELS = {
  /** `{ includePaused?, includeEnded? }` → `RecurringSnapshot`, or null when no book is open. */
  snapshot: channel('snapshot'),
  /** `SaveSeriesRequest` → `RecurringResult<Series>`. Creates, or with `id`, edits. */
  saveSeries: channel('series.save'),
  /** `{ ids }` → `RecurringResult<void>`. */
  deleteSeries: channel('series.delete'),
  /** `{ ids, paused }` → `RecurringResult<void>`. */
  setPaused: channel('series.setPaused'),
  /** `{ requests, confirm? }` → `RecurringResult<EnterResult>`. */
  enter: channel('enter'),
  /** `{ ids, count? }` → `RecurringResult<void>`. */
  skip: channel('skip'),
  /** `{ seriesId, limit? }` → `Posting[]`. */
  history: channel('history'),
  /** `{ accountId, transactionId }` → `SeriesDialogInput`, for "Make Recurring…". */
  fromTransaction: channel('fromTransaction')
} as const

export const RECURRING_EVENTS = {
  /** The whole `RecurringSnapshot`, or null when the book closed. */
  snapshot: channel('snapshot.changed')
} as const

export const RECURRING_VIEWS = { list: 'recurring.list' } as const

export const RECURRING_DIALOGS = {
  /** Input `SeriesDialogInput`, result `{ id }`. */
  series: 'recurring.dialog.series',
  /** Input `EnterDialogInput`, result `EnterRequest[]`. Shown before every entry. */
  enter: 'recurring.dialog.enter'
} as const
```

The view fetches the snapshot once and then listens for
`RECURRING_EVENTS.snapshot`, which carries the whole new value — the pattern
every view in the repository uses, so a repeated event is harmless.

The series dialog talks to the **accounts** plugin's channels directly
(`ACCOUNTS_CHANNELS.chart`, `.categories`, `.searchPayees`) rather than through
proxies in `recurring`. The names are published in `@tessera/accounts-api` for
exactly this, and proxying would add three channels that only forward.

### Reacting to the accounts plugin

`recurring` subscribes to `accounts.service.onDidChange` and acts on it:

| Change | Action |
|---|---|
| `deleted` contains a series' account | Delete those series and their postings. The transactions already entered are the account manager's business, and it has already dealt with them |
| An account became closed | Pause its series with `pausedReason: 'accountClosed'`; the view shows them greyed with the reason |
| An account was reopened | Resume the series paused for that reason only — never one the user paused |
| `deleted` contains a template's `transferAccountId` | Clear it and pause with `pausedReason: 'transferAccountGone'`. The series is not guessed at or deleted: the user decides what it should do now |
| `transactions` | No action. Deleting a transaction a series produced does not un-enter the occurrence; the posting records what happened |

It also subscribes to `book.session.onDidChange` to clear its state when a book
closes, and recompute the snapshot and the context keys when one opens.

---

## Changes to `accounts`

Deliberately small; everything else is new code in a new plugin.

| Change | Where |
|---|---|
| `TRANSACTION_ACTIONS_POINT`, `TransactionActionContribution`, `TransactionActionArgs` | `packages/accounts-api/protocol.ts` |
| `NAVIGATOR_ITEMS_POINT`, `NavigatorItemContribution`, `ResolvedNavigatorItem` | `packages/accounts-api/protocol.ts` |
| `ACCOUNTS_CHANNELS.transactionActions`, `.navigatorItems`, and `ACCOUNTS_EVENTS.navigatorItems` | `packages/accounts-api/protocol.ts` |
| `ACCOUNTS_MENU` — the menu id and its group ids, published | `packages/accounts-api/protocol.ts`, used by `plugins/accounts/src/privileged/contributions.ts` instead of its local constants |
| A `accounts.menu.recurring` group, `order: 40` | `plugins/accounts/src/privileged/contributions.ts` |
| Resolving the new point (a small generalisation of `ReconcileActions`) | `plugins/accounts/src/privileged/reconcileActions.ts` → `rowActions.ts` |
| Rendering the resolved actions in the row menu, after a `Divider` | `plugins/accounts/src/renderer/register/Register.tsx` |
| Resolving `accounts.navigator.items`, and re-publishing them when a badge's context key changes | `plugins/accounts/src/privileged/navigatorItems.ts` (new) |
| Rendering contributed rows above and below the tree | `plugins/accounts/src/renderer/Navigator.tsx` |

No document, no storage and no service method of `accounts` changes, so no
schema version bump and no migration.

---

## Alternatives considered

| Alternative | Verdict |
|---|---|
| **Build it inside the `accounts` plugin** | Rejected. `accounts` is already the biggest plugin in the repository, and recurring transactions are a consumer of the account manager rather than a part of it. The cost of separating them is honest and small: one new extension point, and orphan cleanup that is reactive rather than transactional. The benefit is that `accounts.service` gets its first outside consumer, which is the only way to find out whether the boundary is real |
| **Store every future occurrence as a row** (a "scheduled transactions" collection) | Rejected. Unbounded for a series that never ends, has to be regenerated whenever a schedule is edited, and makes a simple question ("what is due?") depend on whether a generation job has run. Computing from the rule is cheaper and cannot drift |
| **Put future-dated transactions in the register itself**, as Money does, with a projected balance | Rejected for this release, not on the merits. It needs a future section in the register, a projected total, and a rule for what "cleared balance" means past today — a register change big enough for its own note. The Recurring view does not block it: a future phase can show the same occurrences in the register without changing anything here |
| **Full RFC 5545 `RRULE`** | Rejected. It would be more capable than Money and than any user needs here, and `BYSETPOS`, `EXDATE`, `WKST` and the interaction between `BYDAY` and `BYMONTHDAY` are a large surface to get right and nearly impossible to describe in a sentence in the dialog. Five frequencies with an interval cover every choice Money offered. If an import format ever needs `RRULE`, it can be translated into a `Schedule` at the edge |
| **A `seriesId` field on `Transaction`** | Rejected. It is another plugin's document. `recurring.postings` holds the link, answers more questions, and keeps `accounts` free of a dependency on a plugin that may not be installed |
| **A left-bar panel rather than a main-area view** | Rejected. The list needs date, name, account, category and amount at once; a 260px bar cannot hold them. The bar gets the warning, not the list |
| **A separate top-level "Recurring" menu** | Rejected for now. One feature does not earn a top-level menu; it joins the Accounts menu in a group of its own. Revisit when the finance menus are reviewed as a whole |
| **Warn with a modal dialog on opening a book** | Rejected. Blocking the first interaction with the app on an "OK" is the behaviour users disable first, and there is no setting framework yet to disable it with |

---

## Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **A double entry** if the app stops between writing the transaction and advancing the series | The gap is a single `await`. On the next attempt the `possibleDuplicate` confirmation catches a transaction with the same account, date and amount, and the user decides. The posting history shows what really happened |
| 2 | **A long-dormant book** opens with hundreds of overdue occurrences across many series | The list is one row per series, so it stays short however many occurrences are missed; the count is a chip. *Skip to today* clears a series in one action, and the banner's figures are capped with "…" rather than computing an enormous total |
| 3 | **The local date is ambiguous** across a time-zone change or a machine with a wrong clock | Dates are plain `YYYY-MM-DD` and never converted. "Today" is `todayIso()`, recomputed on open, on focus and at midnight. A clock a day out shows one day of wrong states and corrects itself |
| 4 | **An edited schedule silently moves what is due** | Editing recomputes `nextIndex` as the first occurrence after `lastEnteredDate` (or after the start date when nothing has been entered). The dialog's preview shows the result before the user confirms, and the footer shows it after |
| 5 | **Automatic entry writes to a register unattended** (phase 6) | Off by default, never into a closed account, never more than `MAX_AUTO_ENTER` occurrences per series per open, and always reported in a banner that names every transaction written, with Open Register |
| 6 | **Opening Recurring hides the register**, because the main area has no tabs | The result banner offers *Open Register* for the account entered, and `Esc` returns to the previous main view. Properly solved by main-area tabs, already on the [todo](todo.md#views-and-the-renderer) |
| 7 | **A series outlives its account** through a path we did not anticipate | The service treats a missing account as a blocked row rather than throwing, the view shows it with a reason, and a check on book open removes series whose account is gone |
| 8 | **`accounts.transaction.actions` overlaps `accounts.reconcile.actions`** and plugin authors pick the wrong one | The reconcile point's `scope: 'transaction'` is documented as deprecated, both resolve into the same menu, and the plugin guide gets one paragraph saying which to use |

---

## Decisions taken in review

The five questions this note opened with were answered on 2026-11-13. Each
answer is folded into the sections above; they are collected here because they
changed the shape of the feature.

| # | Question | Answer | What it changed |
|---|---|---|---|
| A | Should an entered transaction carry its due date or the date it was entered on? | **The transaction's own date** — the date it is for, not the day the user got round to it | Confirms decision 6 and makes it the *only* behaviour: `EnterRequest.dateMode` is gone. The date is the occurrence's, and the user can change it in the enter dialog like any other field. A transaction entered for a future date therefore sits at that date in the register and counts towards the current balance, as any future-dated transaction entered by hand does today. A projected-balance treatment of the register stays out of scope |
| B | Is 7 days the right reminder window? | **3 days**, and it should become a setting once there are settings | `DEFAULT_REMIND_DAYS` is 3. A todo item is filed against [settings-design.md](settings-design.md) for a book-wide default; `remindDays` stays per-series until then |
| C | Should *Enter All Overdue* confirm before writing many transactions? | **Every entry is confirmed, and the amount is always adjustable** — for one occurrence and for each of several | The amounts dialog becomes the **enter dialog**, and it is no longer only for estimated series: *Enter in Register* always opens it, with one editable row per selected occurrence. It is both the confirmation step and the place to adjust an amount, so no separate "are you sure" dialog is needed |
| D | Should the navigator show a Recurring row? | **Yes** | A new phase 0 prerequisite: `accounts.navigator.items`, an extension point for rows other plugins add to the Accounts navigator, with a badge driven by a context key. `recurring` contributes a *Recurring* row badged with `recurring.overdue.count` |
| E | Should a series be able to write into several accounts? | **Yes, once splits exist**, treated as a transfer across several accounts | Stays a non-goal for this release. Recorded in [Later](#phases) so the template's shape does not preclude it: a split template's lines each name a category *or* an account, and entering writes one transaction per account involved, as a multi-account transfer |

Still open, and not blocking:

- Whether the View menu item should read *Recurring* or *Recurring
  Transactions*. The shorter one is used throughout this note.

---

## Phases

Effort is a rough size for one developer, on the scale this repository's other
notes have used:

- **S** — a day or two. One or two files, pure logic or a small contribution;
  no new contracts.
- **M** — about a week. A view or a dialog with its IPC and tests, or a slice
  of a service.
- **L** — two weeks or more. A plugin's whole privileged half, or several
  contracts at once.

| Phase | Delivers | Effort | Depends on |
|---|---|---|---|
| 0 | **Prerequisites.** `@tessera/recurring-api` scaffolding and its entry in `API_PACKAGES`; `accounts.transaction.actions` in `accounts` (the point, the channel, resolving it, rendering it in the row menu); `accounts.navigator.items` (the point, the channel, the badge from a context key, rendering it in the navigator); `ACCOUNTS_MENU` published and the `accounts.menu.recurring` group added; `Repeat`, `Pause`, `PlayArrow`, `SkipNext` in the standard icons and `Chip` in `@tessera/ui`; the `recurring` plugin skeleton wired to all of it | **M** | — |
| 1 | **The schedule engine.** `Schedule`, `Occurrence`, `occurrenceAt`, `occurrencesFrom`, `firstIndexOnOrAfter`, `countThrough`, `describeSchedule`, `validateSchedule`, and the date helpers they share. Pure, no storage, no clock | **S** | 0 |
| 2 | **The domain and `recurring.service`.** The plugin, its schema and migrator, the `Series` and `Posting` documents, CRUD, `snapshot`, `forecast`, `enter`, `skip`, `setPaused`, `createFromTransaction`, the rules, the errors, reacting to `accounts.service.onDidChange`, the IPC, events, context keys and the date rollover. No UI; tested against the memory engine, with a real accounts service underneath | **L** | 1 |
| 3 | **The Recurring view.** The list in ascending date order, tick-box selection, the toolbar, *Enter in Register*, *Skip*, *Skip All n Due*, the row context menu, the result banner, the overdue, due-soon and blocked banners, row styling, per-currency figures, the detail strip, the empty state, the keyboard map | **M** | 2 |
| 4 | **The series dialog and the enter dialog.** Every field of the series dialog, the frequency control with *Custom…*, the monthly day control, the live preview, inline validation; and the enter dialog, one editable row per occurrence, through which every entry passes | **M** | 2 |
| 5 | **Entry points and warnings.** *Make Recurring…* in the register's row menu and `createFromTransaction` end to end; the Accounts menu group and View ▸ Recurring; the bottom-bar warning item; revealing the view on a book opening with overdue work; the midnight and focus recomputation | **M** | 3, 4 |
| 6 | **Automatic entry and bulk work.** `autoEnter` with its reporting banner and its caps; *Enter All Overdue* with confirmation; *Use this as the new estimate*; `history` in the UI; the `forecast` API documented for a later cash-flow feature | **M** | 5 |
| 5a | **From the later list, done early:** business-day adjustment with a per-book holiday list and its dialog; the Upcoming panel in the right bar; the register's projected balance through `accounts.register.figures`; revealing the view when a book opens with something overdue | **M** | 5 |
| 7+ | **Later.** Splits in a template (needs `Transaction.splits`), and with them a series that enters into **several accounts at once** — a paycheque split between chequing and savings — treated as a transfer across those accounts (review decision E); loan amortisation series; future occurrences *in the register itself*; detecting a repeating pattern and offering a series; `shell.notifications`; a book-wide default reminder window, and a shared holiday calendar, once `context.settings` exists (review decision B) | — | — |

### Tests, by phase

| Phase | What is tested |
|---|---|
| 0 | A contributed row action appears in the register's row menu, is disabled when its command is, is hidden for the wrong account type and while the account is closed; a transaction-scope reconcile contribution still appears; a contributed navigator item appears above or below the tree, runs its command, and shows its badge from the context key it names, updating when that key changes; an invalid contribution to either point is skipped with one warning |
| 1 | Every frequency and interval; 31st clamping across February in a leap and a non-leap year; `'last'`; `nthWeekday` including `-1`; semi-monthly indices; both weekend rules, including that they do not compound; `onDate` and `afterCount` ends; `firstIndexOnOrAfter` on and around a boundary; `describeSchedule` for each case; `validateSchedule` rejecting each invalid field |
| 2 | Creating, editing and deleting a series; entering one advances it exactly once and writes one transaction with the right date, amount, number, payee and category; entering a transfer writes both sides; entering several reports partial failure without rolling back what succeeded; entering a paused, ended or closed-account series fails with the right code; `skip` advances and writes a skipped posting; `afterCount` ends the series at the right occurrence; `createFromTransaction` does not duplicate and does not start overdue; deleting an account removes its series; closing one pauses them and reopening resumes only those; the snapshot sorts ascending and computes `dueCount` and the per-currency totals |
| 3 | The list renders in ascending order with overdue first; the tick boxes and the keyboard select what is expected; entering calls the channel with the ticked ids; the result banner reports both halves of a partial failure; blocked rows cannot be ticked; the banner appears exactly when something is overdue |
| 4 | Each frequency choice maps to the right `frequency`/`interval`; the preview matches the engine; invalid input is reported inline and the dialog cannot be confirmed; the enter dialog returns one request per selected occurrence, carries the occurrence's date through unchanged, and applies an edited amount to that entry only (and to the series when *Use as the new estimate* is ticked) |
| 5 | *Make Recurring…* opens the dialog prefilled from the row; the bar item appears only while something is overdue and its text matches the count; the view is revealed when a book opens with overdue work and not otherwise; a date rollover recomputes the states |
| 6 | `autoEnter` enters only what is due, never into a closed account, never more than the cap, and reports everything it wrote; nothing is entered when it is off |

Phase 5's tests also cover the navigator: the *Recurring* row appears, runs
`recurring.open`, and its badge tracks `recurring.overdue.count`.
