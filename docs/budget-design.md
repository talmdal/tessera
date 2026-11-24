# Design and implementation: budgets

| | |
|---|---|
| **Status** | **Proposed and reviewed 2026-11-15.** Q1 to Q14 are answered, and the answers are applied throughout ([Decisions taken in review](#decisions-taken-in-review)). Review brought in **transfers that cross a budget's scope** (a business paying its owner), **due dates** on a line's plan, **Remaining** as the column's name, and a **home view widget**. **Phase B0 (spike) done** 2026-11-15 ([results](#phase-b0-results)): the totals are fast enough, the date arithmetic is right on every day, a 150-line grid needs no windowing, and sharing the archive's totals fits, **packed by account and month**. The design is amended where the spike found it wrong ([what changed](#what-changes-in-this-note)). **Phase B1 done** ([results](#phase-b1-results)): `accounts.service.transactionTotals`, the archive's `removedTotals`, and a `formatAmount` 28 times faster; no visible change. **Phase B2 done** ([results](#phase-b2-results)): the budget domain and `budget.service`, with both participants, proved with no UI; every month's actual survives an archive. **Phase B3 done** ([results](#phase-b3-results)): the Budget menu, the budget view (a month or the year to date), the Budgets tab and the New Budget, Budget Line and Transactions dialogs; read-only on an archive file. Still to do by hand in `npm run dev`, which couldn't run here. **Phase B4 done** ([results](#phase-b4-results)): the Year, with months of their own typed in its cells, Fill from History, and Duplicate Budget…. **Phase B5 done** ([results](#phase-b5-results)): the Budget page, a warning in the status bar while lines are over budget this month, and `budget.service` documented for other plugins, warning at the user's *Warn at*. **Reviewed after B5** ([what changed](#review-after-b5)): six bugs fixed (a half-saved line, a Year that stopped answering, shares one point low…), each with a test shown to fail without its fix. Next: B6, the home view widget, once the home view takes widgets. [Open questions](#open-questions): none |
| **Date** | 2026-11-15 |
| **Scope** | Planning income and spending, by category and by transfers in and out of the accounts a budget covers, month by month, and comparing the plan with what the ledger's transactions show. A new **`budget`** plugin with its contract **`@tessera/budget-api`**: a *Budget* menu, a budget view in the main area, a *Budgets* tab in the left bar, the New Budget, Budget Line and Fill from History dialogs, a *Budget* page in the Options dialog, a **`budget.service`** for other plugins, and a widget for the accounts home view once it exists |
| **Builds on** | [account-manager-design.md](account-manager-design.md) (categories, signed amounts, transfers, voids, sub-ledgers and their participants, `accounts.service`), [ledger-compaction-design.md](ledger-compaction-design.md) (the archive participant contract), [settings-design.md](settings-design.md) (a page in the Options dialog), [layout-controller-design.md](layout-controller-design.md) (main views and bar tabs), [plugin-creation.md](plugin-creation.md) |
| **Changes to other notes** | [account-manager-design.md](account-manager-design.md): `accounts.service` gains **`transactionTotals`**, transaction totals by account, month, and category or transfer ([The accounts addition](#the-accounts-addition-transactiontotals)). [ledger-compaction-design.md](ledger-compaction-design.md): the accounts participant shares the totals of what it removed (**`AccountsArchived.removedTotals`**), and `budget` becomes a participant after `accounts` ([Archives](#archives-past-actuals-stay-true)). Both are additions; nothing existing changes meaning. The accounts home view, when it is designed, takes widgets from other plugins ([On the home view](#on-the-home-view)) |
| **Layout** | [Part 1](#part-1-design) is the design (*what and why*). [Part 2](#part-2-implementation-plan) is the phased plan (*how and in what order*). Phases are numbered **B0 to B6** (B for *budget*), so they aren't confused with the import's 0 to 4 and F0 to F6, or the export's X0 to X4 |

- [Summary](#summary)
- [Naming](#naming)
- [Context](#context)
- [Why people budget](#why-people-budget)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- **Part 1: Design**
  - [Architecture](#architecture)
  - [Budgets](#budgets)
  - [Lines and plans](#lines-and-plans)
  - [How much a month is planned, and when it is due](#how-much-a-month-is-planned-and-when-it-is-due)
  - [Changing a plan](#changing-a-plan)
  - [Actuals](#actuals)
  - [Transfers across the budget's scope](#transfers-across-the-budgets-scope)
  - [Which line a transaction counts toward](#which-line-a-transaction-counts-toward)
  - [Budget, actual and remaining](#budget-actual-and-remaining)
  - [The accounts addition: `transactionTotals`](#the-accounts-addition-transactiontotals)
  - [Archives: past actuals stay true](#archives-past-actuals-stay-true)
  - [Sub-ledgers: when a budget's sub-ledger is deleted](#sub-ledgers-when-a-budgets-sub-ledger-is-deleted)
  - [The budget view](#the-budget-view)
  - [The Budgets tab](#the-budgets-tab)
  - [On the home view](#on-the-home-view)
  - [Dialogs](#dialogs)
  - [Filling a budget from history](#filling-a-budget-from-history)
  - [The Budget menu, commands and context keys](#the-budget-menu-commands-and-context-keys)
  - [The contract: `@tessera/budget-api`](#the-contract-tesserabudget-api)
  - [Storage schema (`budget`)](#storage-schema-budget)
  - [IPC and events](#ipc-and-events)
  - [Keeping the view current](#keeping-the-view-current)
  - [The Budget page](#the-budget-page)
  - [Read-only ledgers and archive files](#read-only-ledgers-and-archive-files)
  - [Security, privacy and robustness](#security-privacy-and-robustness)
  - [Alternatives considered](#alternatives-considered)
  - [Risks](#risks)
  - [Decisions taken in review](#decisions-taken-in-review)
  - [Open questions](#open-questions)
- **Part 2: Implementation plan**
  - [Ground rules](#ground-rules)
  - [Dependency graph and order](#dependency-graph-and-order)
  - [Phase B0: spike (S)](#phase-b0-spike-s)
  - [Phase B1: transaction totals in `accounts.service` (M)](#phase-b1-transaction-totals-in-accountsservice-m)
  - [Phase B2: the budget domain, with no UI (L)](#phase-b2-the-budget-domain-with-no-ui-l)
  - [Phase B3: the budget view, the Budget menu and the dialogs (L)](#phase-b3-the-budget-view-the-budget-menu-and-the-dialogs-l)
  - [Phase B4: the year, single months, history and copies (M)](#phase-b4-the-year-single-months-history-and-copies-m)
  - [Phase B5: the Budget page, warnings and `budget.service` for others (S)](#phase-b5-the-budget-page-warnings-and-budgetservice-for-others-s)
  - [Phase B6: the home view widget (S)](#phase-b6-the-home-view-widget-s)
  - [Later](#later)
  - [Testing](#testing)
  - [Documentation changes](#documentation-changes)
  - [Definition of done](#definition-of-done)
  - [Phases](#phases)

---

## Summary

**A budget is a plan: how much the user expects to earn and spend, month by month. Tessera sets it beside what the
ledger's transactions actually show, so the user can see at a glance where a month stands: what remains to spend on
groceries, which line is over, and whether the month will end ahead or behind.**

- **A new `budget` plugin**, with its contract in **`@tessera/budget-api`**. The ledger and accounts plugins stay
  unaware of budgets. The accounts plugin gains one generic addition that reports will use too: **transaction totals
  by account, month, and category or transfer** (`accounts.service.transactionTotals`). Other plugins can't read the
  accounts collections, and shouldn't: the service is the integrity boundary.
- **Budgets live in the ledger**, through `ledger.schema`, so backups, restores and archive files carry them. A ledger
  can hold **several budgets**. Each has a name, a **scope** (the whole ledger, or a sub-ledger and everything beneath
  it: *Personal*, *Business*), **one currency**, and the **month its year starts** (a fiscal year, if the user keeps
  one).
- **A budget has one line per category it plans, and one per account it expects transfers from or to.** A line says
  **how much, how often, and when it is due**: *650.00 every month*, *2,100.00 every two weeks from Friday 8 January*,
  *1,200.00 every year, due 15 March*. A month's amount is the amount times the number of times it falls due in that
  month: **whole-number arithmetic only**, with nothing averaged and nothing rounded. A fortnightly pay is planned
  three times in the months that have three paydays, as it is paid.
- **Transfers count when they cross the budget's scope** (decided in review). A business that pays its owner makes a
  withdrawal from the *Business* budget's accounts and a deposit into the *Personal* budget's: money out of one
  budget, money in to the other. A transfer between two accounts inside one budget (chequing to savings, both in
  *Personal*) is neither.
- **A change applies from a month onwards.** Raising groceries to 700.00 from July leaves January to June at 650.00,
  so last spring's comparison still shows what was planned then. A single month can also be given an amount of its
  own (*December only: 900.00*), as Money's advanced budget did.
- **Actuals are worked out when they are shown, never copied.** They come from the transactions in the budget's
  accounts: by date, any clearing status, future-dated ones included, **voided transactions and transfers inside the
  scope left out**. A transaction counts toward its category's line, or failing that the line of its nearest parent
  category. Anything else appears under **Other income**, **Other expenses**, **Other transfers** or
  **Uncategorised**, so the totals always agree with the registers.
- **The budget view** shows a month, the year to date, or the whole budget year. Each line has its **Due** dates,
  **Budget**, **Actual** and **Remaining**, and a bar showing how much of it is spent. An expense line over budget has
  a **negative Remaining, in red**; it turns **amber at 90 %** of its budget, a share the user can change. Totals for
  income and expenses follow, then the **net**. Selecting an actual lists the transactions behind it, each a click
  from its register. Each month starts afresh: nothing rolls over.
- **Archiving doesn't change past actuals.** When *File › Archive Ledger…* removes settled transactions, the accounts
  plugin now shares what they added up to. The budget plugin keeps those totals, so a month's actual is the same
  before and after an archive.
- **Filling from history** gives a quick start: the average of the last twelve whole months (or however many the user
  chooses) for each category and transfer, rounded to a step the user chooses, shown for ticking before anything is
  saved.
- **On the home view**, once it exists, a widget shows how the current month of the budget stands.
- **Read-only ledgers and archive files show budgets, and offer nothing that changes them.**
- **The plan: B0 to B6.** B0, the spike (S), is done: the totals take under 50 ms for a year at 100,000
  transactions, the date arithmetic is right on every day from 1970 to 2100, a 150-line grid needs no windowing, and
  the archive's totals fit when packed by account and month. B1 adds the totals to `accounts.service` and to the archive's shared result (M), with no visible
  change. B2 is the budget domain and `budget.service` with no UI, tested against the real accounts service (L). B3 is
  the budget view, the Budget menu, the Budgets tab and the dialogs (L). B4 adds the year grid, single-month amounts,
  filling from history and duplicating budgets (M). B5 adds the Budget page, warnings in the status bar, and the
  service's events for other plugins (S). B6 is the home view widget (S), as soon as the home view takes widgets.
  [Later](#later) lists the rest: envelope budgets, excluded accounts, several currencies, importing budgets, and a
  *Planning* menu.

---

## Naming

| Concept | User-facing name | Code name | Notes |
|---|---|---|---|
| A named plan | **Budget** | `Budget`, the `budget` plugin | *New Budget…*, *Delete Budget…*. Several can live in one ledger |
| What a budget covers | *Covers* ("Covers: Personal and its sub-ledgers") | `Budget.subLedgerId` (`null`: the whole ledger) | The budget's **scope** in this note |
| A category's or a transfer's place in a budget | **Line** (*budget line*) | `BudgetLine`, with a `LineTarget` | One per category, and one per other account, per budget |
| A line for transfers | **Transfers from *account***, **Transfers to *account*** | `LineTarget` `{ kind: 'transfer', accountId, direction }` | Only for accounts outside the budget's scope |
| How much, how often, and when | *Amount*, *How often*, *Due* | `LinePlan` (`amount`, `frequency`, `due`, `secondDay`) | A line has one plan for each change made to it, each from a month onwards |
| When a plan starts | *From* (month) | `LinePlan.from`, `'YYYY-MM'` | |
| When it falls due | **Due** (a date, or *No particular day*) | `LinePlan.due`, `'YYYY-MM-DD'` or `'YYYY-MM'` | Decided in review (Q3) |
| An amount for one month only | *(Month) only* | `BudgetLine.overrides` | Money's *advanced* budget |
| What the transactions show | **Actual** | actuals, `TransactionTotal` | Worked out when shown |
| What is left of the budget | **Remaining** | `remaining` | Decided in review (Q12): budget less actual; negative when over budget ([Budget, actual and remaining](#budget-actual-and-remaining)) |
| A part of the view | **Income**, **Expenses** | `LineGroup`: `'income' \| 'expense'` | A category's kind, or a transfer's direction |
| Spending or income in categories with no line | **Other expenses**, **Other income** | `other` rows | "Other expenses" confirmed in review |
| Transfers across the scope with no line | **Other transfers in**, **Other transfers out** | `otherTransfers` rows | |
| Transactions with neither a category nor a transfer | **Uncategorised** | `uncategorised` rows | Reconciliation's balance adjustments are among them |
| What the view covers | **Month**, **Year to date**, **Year** | `BudgetPeriod` | Always whole calendar months |
| A budget's year | *Budget year*, *Year starts in* | `Budget.yearStartMonth` | January unless the user keeps another year |
| Totals kept through an archive | (not shown) | archived actuals, one document per account and month in `budget.archivedMonths` | [Archives](#archives-past-actuals-stay-true) |
| The budget on the home view | *Budget* widget | `budget.home` | [On the home view](#on-the-home-view) |

*Budget* is the word Money, Quicken and most finance apps use. *Plan* was considered for the whole thing and kept for
a line's amount, frequency and due date, where it reads naturally ("the plan from July"). *Line* was chosen over
*item* because the view draws each as a line.

The plugin id is **`budget`**, singular, as in every example of [plugin-creation.md](plugin-creation.md): commands
`budget.*`, collections `budget.*`, the service `budget.service`. Labels can change at any time; ids can't.

---

## Context

What exists, and what budgets use from it:

| Facility | Used for |
|---|---|
| `accounts.service`: `list` (with `subLedgerId`, `includeDescendants`), `categories.list()`, `onDidChange` | The accounts a budget covers, the category tree, and knowing when to refresh |
| `Category` `{ id, parentId, name, kind: 'income' \| 'expense' }`, `categoryLabel`, `CATEGORY_SEPARATOR` | Lines, groups and labels exactly as the register shows them |
| Transfers: two transactions sharing a `transferId`, each with `transferAccountId`, in the same currency | Telling a transfer inside the scope from one that crosses it |
| Amounts in **integer minor units, positive raises the balance**, for every account type | Spending is `−amount` whatever the account: a chequing payment and a card charge are both negative |
| `parseAmount`, `formatAmount`, `amountToInput`, `isAmount`, `todayIso` (`@tessera/accounts-api`) | Typing and showing amounts, and knowing the current month |
| `ledger.schema` and `Migrator` | The budget's collections in every ledger, created as it opens |
| `ledger.session.participate` (sub-ledgers) and `participateInArchive` (archives) | Keeping budgets whole when a sub-ledger is deleted, and past actuals when a ledger is archived |
| `shell.views` (main area and bars), `shell.dialogs`, `shell.prompts`, `shell.menus`, `shell.bar.items`, `shell.icons` | The view, the tab, the dialogs, the menu, a status item and the tab's icon |
| `context.settings` and `shell.settings.pages` | The Budget page: preferences only |
| `context.state` | Which budget the view showed last, per ledger |
| The `accounts.register.open` command (`{ id }`) | Opening an account's register from a transaction behind an actual |
| `scripts/sample-archive/household.ts` | Nearly four years of a made-up household: the data to fill a budget from, and to archive |

What is missing, and how this design handles each:

| Gap | Handling |
|---|---|
| **No way for another plugin to total transactions by category or transfer.** `TransactionManager.list(range)` is per account; the `accounts.*` collections are closed to other plugins (`ledger.session.database(contributor)` admits only `<contributor>.*`) | **B1:** `accounts.service.transactionTotals({ from, to, accountIds, includeTransfers })`, totals by account, month, and category or other account. Reports need the same thing |
| **The storage kit's `aggregate` is slow with a `$cond` per document** (0.35 s at 100,000 transactions, against 19 ms for the same sums in a plain loop: [ledger-compaction-design.md](ledger-compaction-design.md#2-planarchive-and-the-balance-check)), and **the kit uses only unique indexes to find documents**; anything else is a scan ([collection.ts](../packages/storage-kit/collection.ts)) | `transactionTotals` reads with `find` on the dates and sums in a plain loop: 42 to 49 ms for a year at 100,000, measured in B0. An index on `date` would cost every write and help no query, so none is added |
| **Archiving removes settled transactions**, and the archive participants after `accounts` learn only their ids (`AccountsArchived.transactionIds`). A budget's participant can't read the accounts collections to find their amounts | **B1:** the accounts participant also shares `removedTotals`, what it removed, totalled the same way. **B2:** the budget keeps them ([Archives](#archives-past-actuals-stay-true)) |
| **No category manager:** categories can be created, not renamed, moved, merged or deleted ([account-manager-design.md](account-manager-design.md#goals-and-non-goals)) | Lines hold category ids, so a rename needs nothing. A line whose category has gone is shown as such and can be deleted. Deleting and merging come with the category manager ([Later](#later)) |
| **No splits yet** (the transaction document reserves `splits`) | `transactionTotals` hides this: when splits arrive it counts each part by its own category, and budgets change nothing |
| **No per-ledger settings** ([todo.md](todo.md#state-and-settings): scopes are proposed, not built) | What belongs to a budget (its scope, currency, year start) is kept **in the budget**, in the ledger. The Budget page holds the user's preferences only |
| **The main area shows one view at a time**, chosen by commands ([layout-controller-design.md](layout-controller-design.md#the-main-area)) | The budget view is a main view, revealed by *Show Budget* and by the Budgets tab, as the register is by the navigator |
| **No accounts home view yet.** It is envisioned as a page that plugins contribute widgets to (review, Q7) | The budget's widget is designed here ([On the home view](#on-the-home-view)) and built in B6, once the home view takes widgets |
| **`@tessera/ui` has no progress bar** | B3 adds `LinearProgress` (`@tessera/ui` 1.5) |
| **No currency conversion** (each account has one currency; totals are per currency) | A budget has one currency, and counts only accounts in it. Accounts it leaves out are named. Several currencies wait for exchange rates ([Later](#later)) |
| **No scheduled transactions or bills** | A line's due date says when it is expected; nothing is entered for it. Reminders and scheduled transactions could use the dates later |

---

## Why people budget

| Who | What they want | What this design gives them |
|---|---|---|
| A household watching the month | "How much remains for groceries and eating out?" | The month view, with Remaining and the bar, amber as a line nears its budget |
| Someone paid every two weeks | Two months a year with three paydays, planned as such | *Every two weeks* counts paydays in each month |
| Anyone with bills that come once or four times a year | Insurance due 15 March, property tax quarterly, not smeared over the year | *Every year* and *Every three months*, each due on its date, in its own month |
| A sole proprietor with a *Business* sub-ledger | Separate budgets for the business and the household, with the owner's pay in both | A budget per sub-ledger; the pay is *Transfers to Personal Chequing* in one and *Transfers from Business Chequing* in the other |
| Someone moving from Microsoft Money | Their Budget Planner, with income, expenses and how the month is going | The same shape: income, expenses, what remains per category, month and year |
| Someone starting out | Not to type a hundred amounts | *Fill from History…* from last year's spending |
| Someone reviewing last year | "What did we plan, and what did we spend?", after archiving | Effective-dated plans and archived actuals keep both true |

---

## Goals and non-goals

**Goals**

- **Plan by category and by transfers across the scope**, for income and expenses, with amounts that recur at the
  frequencies bills really have, on the dates they fall due, and an amount for any single month.
- **Compare with actuals** for a month, the year to date, or the budget year: for each line, each parent category,
  income, expenses and the net.
- **Actuals agree with the registers.** The same transactions, the same amounts, voids excluded, every transaction
  accounted for: a category or transfer with no line still appears, under *Other*, and so do uncategorised
  transactions.
- **History stays true.** Changing a plan from a month never rewrites earlier months, and archiving never changes a
  past month's actual.
- **Exact arithmetic.** Integer minor units throughout. Only *Fill from History* divides, and what it suggests is
  shown before it is saved.
- **Several budgets per ledger**, each over a sub-ledger or the whole ledger.
- **Quick to start:** a budget filled from history in a minute.
- **Keyboard first**, as the register is: arrows, Enter to edit, Insert for a new line, Delete to remove one.
- **The ledger and accounts plugins stay unaware of budgets.** Their additions are generic: totals reports will use,
  and a richer shared archive result.
- **Works read-only:** budgets in an archive file can be looked at.

**Non-goals**

- **Rollover.** Each month starts afresh: what remained, or was overspent, doesn't carry into the next month (decided
  in review, Q2).
- **Spreading** an irregular bill as monthly savings (Money's *occasional expenses*). A bill is planned on its due
  date, in its own month (decided in review, Q3).
- **Envelope (zero-based) budgeting**, where the money in the accounts is shared out among categories each month until
  none is left ([Later](#later)).
- **Excluding accounts** from a scope, **several currencies** in one budget, and **importing budgets** from Money or
  Quicken ([Later](#later)).
- **Forecasting** balances or cash flow, **scheduled transactions** and **bill reminders**. Due dates make them
  possible later; nothing is entered for a line.
- **Charts and reports** beyond the view. A reports plugin can build them on `budget.service`. (Since reports' R5,
  the budget contributes *Budget vs Actual* to the reports itself.)
- **Budgets by payee**, and weekly periods in the view.
- **Exporting** budgets.
- **Notifications** outside the window.
- **Undo.** Deleting a line or a budget asks first; backups are the safety net, as for accounts.

---

## Decisions

Reviewed on 2026-11-15; the decisions changed or added in review are marked ✓
([Decisions taken in review](#decisions-taken-in-review)). Each is explained where it lands.

| # | Decision | Where |
|---|---|---|
| B-1 | **A plugin of its own, `budget`, with its contract `@tessera/budget-api`.** `ledger` and `accounts` learn nothing about budgets; `accounts` gains generic totals | [Architecture](#architecture) |
| B-2 | **Budgets are kept in the ledger** (`ledger.schema`), so backups, restores and archive files carry them | [Storage schema](#storage-schema-budget) |
| B-3 ✓ | **Several budgets per ledger.** Each has a unique name, a **scope** (a sub-ledger and beneath it, or the whole ledger), **one currency**, and the **month its year starts** | [Budgets](#budgets) |
| B-4 ✓ | **A line is for a category, or for transfers with one account outside the scope.** At most one per category and one per account in a budget. Amounts are typed and stored **positive**; a line's group comes from its category's kind, or its transfer's direction | [Lines and plans](#lines-and-plans) |
| B-5 ✓ | **A month's amount is the plan's amount times the times it falls due in that month.** Frequencies from *once* to *every year*. **A plan can be due on a date**, which places it in its month; weekly ones always are. No averaging, no rounding | [How much a month is planned](#how-much-a-month-is-planned-and-when-it-is-due) |
| B-6 | **A change applies from a chosen month onwards** (a new plan on the line); earlier months keep theirs. **One month can have an amount of its own** | [Changing a plan](#changing-a-plan) |
| B-7 ✓ | **Periods are whole calendar months, and each starts afresh:** no rollover. The view shows a month, the year to date, or the budget year | [The budget view](#the-budget-view) |
| B-8 | **Actuals are worked out when shown**, from `accounts.service.transactionTotals` plus the budget's archived actuals. Nothing about a transaction is copied into the budget | [Actuals](#actuals) |
| B-9 ✓ | **What counts:** non-voided transactions in the budget's accounts and currency, by date, whatever their clearing status, **future-dated ones included**. **Transfers count only when the other account is outside the scope.** Opening balances never count | [Actuals](#actuals), [Transfers](#transfers-across-the-budgets-scope) |
| B-10 ✓ | **A transaction counts toward its category's line, else the line of its nearest parent category**, else *Other income* or *Other expenses*. A transfer across the scope counts toward its account's transfer line, else *Other transfers in* or *out*. Uncategorised transactions are shown apart, money in and money out separately | [Which line](#which-line-a-transaction-counts-toward) |
| B-11 ✓ | **Remaining is budget less actual:** for an expense line, negative when over budget, and red (`error.main`). An expense line turns **amber at 90 %** of its budget, **a setting**. For income, Remaining is what is still to come | [Budget, actual and remaining](#budget-actual-and-remaining) |
| B-12 ✓ | **`accounts.service.transactionTotals`**: non-voided transactions totalled by account, month, and category or (when asked) transfer account, money in and money out apart, summed in a plain loop | [The accounts addition](#the-accounts-addition-transactiontotals) |
| B-13 | **Budgets take part in archives.** The accounts participant shares what it removed as totals (`removedTotals`, worked out in `applyArchive`); the budget keeps them as archived actuals, **packed one document per account and month** (after B0), so no past month changes | [Archives](#archives-past-actuals-stay-true) |
| B-14 | **Budgets take part in deleting a sub-ledger:** a budget over the deleted sub-ledger then covers its parent, and the confirmation says so | [Sub-ledgers](#sub-ledgers-when-a-budgets-sub-ledger-is-deleted) |
| B-15 | **Fill from History** averages whole months, rounds expenses up and income down to a step, suggests *every year* for a category seen in one month only, and saves nothing until the user confirms | [Filling from history](#filling-a-budget-from-history) |
| B-16 | **Settings are the user's preferences, application-wide.** What belongs to a budget is in the ledger with it | [The Budget page](#the-budget-page) |
| B-17 ✓ | **A Budget menu, a main view (`budget.view`), a Budgets tab in the left bar**, and four dialogs. The menu moves under a *Planning* menu later | [The budget view](#the-budget-view), [Dialogs](#dialogs) |
| B-18 | **`budget.service`** for other plugins: budgets, lines, and the status of a period, with change events | [The contract](#the-contract-tesserabudget-api) |
| B-19 | **The planning arithmetic lives in `@tessera/budget-api`**, so the service and the dialogs' previews can't disagree | [The contract](#the-contract-tesserabudget-api) |
| B-20 ✓ | **A widget on the accounts home view**, once the home view takes widgets from plugins | [On the home view](#on-the-home-view) |

---

# Part 1: Design

## Architecture

```
  ┌────────────────────────────────┐
  │ ledger                         │  ledger.session: the file, sub-ledgers, ledger.schema,
  │                                │  participants (sub-ledger deletes, archives)
  └─────────────▲──────────────────┘
                │ requires
  ┌─────────────┴──────────────────┐
  │ accounts                       │  accounts.service  (+ transactionTotals, + removedTotals: B1)
  │                                │  the home view (later), which takes widgets
  └─────────────▲──────────────────┘
                │ requires accounts.service, ledger.session; contributes to ledger.schema
  ┌─────────────┴──────────────────┐
  │ budget  (new)                  │  provides budget.service, budget.migrator
  │  Budget menu, budget view,     │  participates in sub-ledger deletes and archives
  │  Budgets tab, dialogs, page,   │  contributes a home view widget (B6)
  │  home widget                   │
  └─────────────▲──────────────────┘
                │ requires budget.service (later)
  ┌─────────────┴──────────────────┐
  │ future: reports                │
  └────────────────────────────────┘
```

| Component | Kind | Provides | Requires | Owns |
|---|---|---|---|---|
| `budget` | bundled plugin | `budget.service`, `budget.migrator` | `accounts.service`, `ledger.session`, `shell.prompts`, `app.state` | the `budget.*` collections, commands, views, dialogs and widget |
| `@tessera/budget-api` | package (types, constants, the planning arithmetic) | | `@tessera/types`, `@tessera/ledger-api`, `@tessera/accounts-api` | |
| `accounts` (changed) | bundled plugin | `accounts.service` with `transactionTotals` | | |

Inside the plugin, as in `accounts` and `export`, **pure code is kept apart from input and output**:

| Module | Pure? | What |
|---|---|---|
| `@tessera/budget-api` `plan.ts` | yes | `occurrences(plan, month)`, `dueDates(plan, month)`, `plannedAmount(line, month)`, month arithmetic. Used by the service and by the Budget Line dialog's preview |
| `privileged/status.ts` | yes | `budgetStatus(input, months)`: lines, categories, accounts, totals and archived actuals in; rows and totals out |
| `privileged/suggest.ts` | yes | `suggestLines(totals, categories, accounts, options)` for Fill from History |
| `privileged/BudgetServiceImpl.ts` | no | The service: storage, rules, events |
| `privileged/participants.ts` | no | The sub-ledger and archive participants |
| `privileged/index.ts`, `contributions.ts`, `commands.ts`, `ipc.ts`, `viewState.ts`, `refresh.ts`, `settings.ts` | no | Activation, the menu, views and dialogs, commands, IPC, what the view shows, keeping it current, the Budget page |
| `renderer/BudgetView.tsx`, `StatusGrid.tsx`, `BudgetList.tsx`, `BudgetDialog.tsx`, `LineDialog.tsx`, `HistoryDialog.tsx`, `TransactionsDialog.tsx`, `HomeWidget.tsx` | | The UI (`gridModel.ts` and `lineForm.ts` are their pure parts) |

`budget` requires `accounts.service`, so it activates after `accounts`. It therefore joins the archive participants
after `accounts` (and beside `import`, which requires the same), and finds `accounts`' result in `earlier`.

---

## Budgets

```ts
// @tessera/budget-api
export interface Budget {
  id: string
  /** Unique in the ledger, ignoring case. */
  name: string
  /** The accounts it covers: those in this sub-ledger and every sub-ledger beneath it. null: every account in the ledger. */
  subLedgerId: string | null
  /** ISO 4217. Only accounts in this currency count; the view names the others in scope. */
  currency: string
  /** The month its year starts, 1 to 12: what "Year" and "Year to date" mean. 1 (January) for a calendar year. */
  yearStartMonth: number
  notes?: string
  createdAt: string
  updatedAt: string
  rev: number
}
```

- **Scope by sub-ledger, or the whole ledger** (confirmed in review, Q9). Sub-ledgers are how Tessera organises a
  ledger (*Personal*, *Business*, *Rentals*), and a budget over one follows it: a new account there counts at once. A
  ledger with no sub-ledgers has one possible scope, the ledger itself. The accounts are worked out each time, with
  `accounts.list({ subLedgerId, includeDescendants: true })`, or `accounts.list()` for the whole ledger (in an
  `AccountFilter`, `subLedgerId: null` means *directly* in the ledger), then split by currency. Closed accounts count:
  their past spending is still spending. Leaving some accounts out is [later](#later).
- **Moving an account** into or out of a budget's sub-ledger moves its whole history in or out of the budget, past
  months included, just as it moves the account's balance between sub-ledger totals. Accepted in review (Q10): it
  isn't expected often.
- **One currency** (confirmed in review, Q6). A budget counts only accounts in its currency. The view says which
  accounts in scope it leaves out ("Not counted: US Visa, in USD"). The New Budget dialog suggests the currency most
  accounts in scope use. Several currencies need exchange rates ([Later](#later)).
- **The year start is the budget's, not a setting.** A year start belongs to a ledger, and Tessera has no per-ledger
  settings yet: the Archiving page keeps its year start in application settings until it has
  ([settings.ts](../plugins/ledger/src/privileged/archive/settings.ts)). A budget is already in the ledger, so it keeps
  its own. It suggests the Archiving page's month when the budget is created. **Since reports' R1** the ledger keeps
  its year start itself (*File › Ledger Properties…*, [reporting-design.md](reporting-design.md#the-ledgers-year-start)),
  and New Budget suggests **the ledger's year start month** instead; a budget still keeps its own, so two can differ.
- **Names** follow the ledger's rules (`validateLedgerName`, trimmed, at most 100 characters, unique ignoring case).
- **Deleting a budget** deletes its lines, after a confirmation naming how many. Nothing else refers to a budget, and a
  backup covers a mistake. Archived actuals belong to the ledger, not to a budget, and stay.

---

## Lines and plans

```ts
// @tessera/budget-api
export const FREQUENCIES = [
  'once', 'weekly', 'everyTwoWeeks', 'twiceAMonth', 'monthly',
  'everyTwoMonths', 'quarterly', 'twiceAYear', 'yearly'
] as const
export type Frequency = typeof FREQUENCIES[number]

/** What a line plans: a category, or transfers with one account outside the budget's scope. */
export type LineTarget =
  | { kind: 'category', categoryId: string }
  /** 'in': transfers from the account into the scope (income). 'out': from the scope to the account (expenses). */
  | { kind: 'transfer', accountId: string, direction: 'in' | 'out' }

/** How much, how often and when, from a month until the line's next plan (or for good). */
export interface LinePlan {
  /** 'YYYY-MM': the first month this plan applies to. */
  from: string
  /** Minor units, zero or more: each time it falls due. 0 stops the line from `from` without deleting it. */
  amount: number
  frequency: Frequency
  /**
   * When it first falls due. 'YYYY-MM-DD': on that day, and for the month-based frequencies on the same day of each
   * month it falls in (the month's last day, when the month is shorter). 'YYYY-MM': no particular day, for the
   * month-based frequencies only. Weekly and fortnightly plans always have a day. It may be before `from`, to keep a
   * cycle going across a change.
   */
  due: string
  /**
   * Twice a month: the second day, 1 to 31 (the month's last day when shorter). Default: the other half of the month,
   * 15 days after the first when that is the 15th or before, else 15 days before (the 20th gives the 5th). (After B0:
   * "15 days after" put both on one day in 5 % of months.)
   */
  secondDay?: number
}

export interface BudgetLine {
  id: string
  budgetId: string
  target: LineTarget
  /** At least one, in order of `from`, no two with the same month. Each runs until the next. */
  plans: LinePlan[]
  /** 'YYYY-MM' → minor units: that month's amount, instead of what the plans give. */
  overrides?: Record<string, number>
  notes?: string
  rev: number
}
```

- **A line's group** is its category's kind (income or expense), or for a transfer line its direction: transfers
  *in* are planned with the income, transfers *out* with the expenses. Amounts are always typed and stored positive.
  The user types *650.00* for groceries, not *−650.00*.
- **At most one line per category, and one per other account,** in a budget. A line may be on a parent category
  (*Food*) or a child (*Food : Groceries*), or both; see
  [Which line a transaction counts toward](#which-line-a-transaction-counts-toward).
- **Transfer lines are only for accounts outside the scope,** in the budget's currency. A budget over the whole ledger
  has none: every transfer stays inside it. See [Transfers across the budget's scope](#transfers-across-the-budgets-scope).
- **A line covers nothing before its first plan's month.** Months before it have no budget for that line, and its
  actuals there count under *Other*.
- **Amounts are bounded so every total stays exact.** The accounts plugin's `MAX_AMOUNT` is 10¹⁵ minor units, and 53
  weekly occurrences of that would pass `Number.MAX_SAFE_INTEGER` (about 9 × 10¹⁵). So a plan's amount is at most
  **`BUDGET_AMOUNT_MAX` = 10¹¹** minor units (a billion at two digits, far beyond a household's needs), a budget has
  at most **500 lines**, and `status` covers at most **24 months**. The largest possible total is then 500 × 106 ×
  10¹¹ = 5.3 × 10¹⁵, still safe. Actuals are sums of stored amounts and are checked the same way: a total that
  wouldn't be a safe integer fails with `INVALID` rather than being wrong.

---

## How much a month is planned, and when it is due

**A month's amount is the amount times the number of times the plan falls due in that month.** The plan that applies
is the one with the latest `from` on or before the month. An override for the month, if there is one, is used
instead.

| Frequency | User-facing | Falls due… |
|---|---|---|
| `once` | Once | in the due date's month only |
| `weekly` | Every week | on the due date and every 7 days after it |
| `everyTwoWeeks` | Every two weeks | on the due date and every 14 days after it |
| `twiceAMonth` | Twice a month | on two days of every month from the due date's month: the due date's day and `secondDay` (by default the other half of the month: the 20th and the 5th) |
| `monthly` | Every month | once in every month from the due date's month |
| `everyTwoMonths` | Every two months | in the due date's month and every second month after it |
| `quarterly` | Every three months | in the due date's month and every third month after it |
| `twiceAYear` | Twice a year | in the due date's month and six months after, every year |
| `yearly` | Every year | in the due date's month every year |

- **The due date places a plan** (decided in review, Q3). A bill due on 15 March is in March's budget. For the
  month-based frequencies the day repeats in each month it falls in: *every month, due on the 31st* is due on 28
  February (or 29) and 30 April, so it never moves to another month. Groceries have *no particular day*: a
  month-based plan can be due in a month without a day.
- **The view shows the dates** in a *Due* column (days of the month shown), the Line dialog's preview shows them, and
  `dueDates(plan, month)` gives them to other plugins. They say when money is expected; they don't enter anything.
- **Actuals still count by the transaction's date**, not the due date. A premium due 31 March and paid on 1 April is
  April's actual; March shows it still to come, and April shows it over. The *Due* column makes the reason plain.
  Matching payments to due dates is [later](#later).
- **Only dates on or after the first due date count**, and only in months the plan covers (from its `from` to the
  month before the line's next plan). So *twice a month* first due on the 20th falls once in its first month.
- **Checked on every day from 1970 to 2100**, in six time zones, against a walk of the calendar
  ([B0](#2-the-date-arithmetic)): no failures. A version with local `Date`s went wrong in three of them.
- **Dates are worked on as day numbers**, days since 1970-01-01 computed from the `YYYY-MM-DD` text, never as
  JavaScript `Date`s in a time zone. A daylight-saving change can't move a payday into another month.
- **Nothing is averaged.** A weekly amount is not `× 52 ÷ 12`; the year's total is the same either way, and each month
  is what will really be paid. Integer times integer needs no rounding, so the months always add up to the year.

A worked example, a budget for 2027 (amounts in dollars):

| Line | Plan | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct | Nov | Dec | Year |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Salary | 2,100.00 every two weeks, first due Friday 8 Jan 2027 | 4,200 | 4,200 | 4,200 | **6,300** | 4,200 | 4,200 | 4,200 | 4,200 | 4,200 | **6,300** | 4,200 | 4,200 | 54,600 |
| Transfers from Business Chequing | 3,000.00 every month, due on the 25th | 3,000 | 3,000 | 3,000 | 3,000 | 3,000 | 3,000 | 3,000 | 3,000 | 3,000 | 3,000 | 3,000 | 3,000 | 36,000 |
| Public transit | 35.00 every week, first due Monday 4 Jan 2027 | 140 | 140 | **175** | 140 | **175** | 140 | 140 | **175** | 140 | 140 | **175** | 140 | 1,820 |
| Property tax | 900.00 every three months, first due 1 Feb 2027 | — | 900 | — | — | 900 | — | — | 900 | — | — | 900 | — | 3,600 |
| Home insurance | 1,200.00 every year, due 15 March | — | — | 1,200 | — | — | — | — | — | — | — | — | — | 1,200 |
| Groceries | 650.00 every month, no particular day; **700.00 from July**; **December only: 900.00** | 650 | 650 | 650 | 650 | 650 | 650 | 700 | 700 | 700 | 700 | 700 | **900** | 8,300 |

April and October have three paydays (2, 16 and 30 April; 1, 15 and 29 October); March, May, August and November
have five Mondays.

---

## Changing a plan

Editing a line's amount, frequency or due date asks **from which month** the change applies, defaulting to the month
the view shows:

- **From a month onwards** adds a plan with that `from`. Plans from later months are kept, unless the user chooses to
  replace them ("Also replace the changes from September"). Months before it are untouched. This is what keeps last
  year's comparison honest: the plan then is still the plan then.
- **That month only** sets an override. It stays even if the plans around it change later, and is marked in the year
  grid, with *Use the plan* to remove it.
- **Stopping a line from a month** is a plan of amount 0 from that month. **Deleting a line** removes it for every
  month, after a confirmation: "Delete the Groceries line? Its amounts go from every month. The transactions stay,
  and count under Other expenses."
- **A change keeps the cycle.** A weekly or fortnightly plan changed from July keeps its first due date, so paydays
  stay on the same Fridays; a new due date can be typed if the cycle itself changed.
- Two plans for the same month can't exist: a change from a month that already has a plan replaces it.

| Alternative | Why not |
|---|---|
| **Edit in place** (one plan per line) | Simplest, but a raise in July would rewrite January's budget, and every past comparison with it |
| **One budget per year** (Quicken's way), copied forward each January | Every year starts with a chore, a fiscal year straddles two budgets, and a rule like *every two weeks* has to be re-anchored in each copy. *Duplicate Budget…* still exists for trying out an alternative |

---

## Actuals

**A budget's actual for a line and a period is what the transactions in its accounts show for that line in those
months.** It is worked out each time the view needs it: from `accounts.service.transactionTotals` for the
transactions in the ledger, plus the budget's archived actuals for those an archive removed
([Archives](#archives-past-actuals-stay-true)).

| A transaction… | Counts? |
|---|---|
| in an account the budget covers, in the budget's currency, dated in the period | **Yes**, by its date |
| uncleared, electronically cleared, cleared or reconciled | **Yes**: the status says whether the bank has it, not whether it was spent |
| dated after today, in the period | **Yes** (confirmed in review, Q5): the user entered it, a cheque written ahead, say |
| voided | **No**: it adds nothing to any balance either |
| a transfer whose other account is **inside** the scope | **No**: money moving between the budget's own accounts is neither income nor spending |
| a transfer whose other account is **outside** the scope | **Yes** (decided in review, Q4), toward that account's transfer line: see [Transfers](#transfers-across-the-budgets-scope) |
| with no category, and not a transfer | **Yes, under *Uncategorised*:** money out with the expenses, money in with the income. Reconciliation's balance adjustments land here |
| in an account in another currency | **No**: named under the view |
| in a closed account | **Yes**: it was spent |
| the opening balance | **No**: it is not a transaction |
| a split (later) | Each part by its own category: `transactionTotals` does it |

**Signs.** Amounts are signed from the account's point of view, positive raising its balance, for every account
type. A payment from chequing and a charge on a card are both negative. So:

```
spending (expense line, transfers out) = outflow − inflow      a refund lowers spending
income   (income line, transfers in)   = inflow − outflow      a reversed deposit lowers income
```

with `inflow` the sum of positive amounts and `outflow` the sum of negative ones, made positive. They are kept apart
so that uncategorised money in and money out aren't netted against each other, and a report can show refunds.

**Worked cases**, for March 2027 of the budget *Household*, which covers the *Personal* sub-ledger in CAD (Personal
Chequing, Savings, a Visa and a US-dollar Visa). It has lines on *Food*, *Food : Groceries* and *Transfers from
Business Chequing*, but none on *Food : Dining out*, *Entertainment* or *Gifts received*:

| Transaction | Where it counts |
|---|---|
| Nine transactions in *Food : Groceries*, on Personal Chequing and the Visa, −598.30 in all | *Groceries*: spent 598.30 |
| −45.00 in *Food : Dining out* | *Food (other)*, the nearest line |
| +20.00 refund in *Food : Dining out* | *Food (other)*: spending 20.00 lower |
| +3,000.00 *Transfer from: Business Chequing*, into Personal Chequing | *Transfers from Business Chequing*: 3,000.00 received |
| −500.00 *Transfer to: Savings* (Savings is in *Personal*) | Nowhere: a transfer inside the scope |
| −120.00 *Transfer to: Rental Chequing* (in *Rentals*, outside the scope, no line) | *Other transfers out* |
| −80.00 in *Utilities : Phone*, voided | Nowhere: void |
| −41.00, no category (a reconciliation's *Balance adjustment*) | *Uncategorised*, with the expenses |
| +150.00 in *Gifts received* | *Other income* |
| −86.20 in *Entertainment* | *Other expenses* |
| −300.00 in *Travel* on the US-dollar Visa | Not counted: "Not counted: US Visa, in USD" |
| Cheque 104, −1,500.00, entered in March, dated 1 April | April |

---

## Transfers across the budget's scope

Review asked for transfers to be planned (Q4), with this case in mind: **a business account pays its owner.** In
Tessera that is one transfer, two transactions: a withdrawal from *Business Chequing*, in the *Business* sub-ledger,
and a deposit into *Personal Chequing*, in *Personal*.

- **For a budget over *Business***, the withdrawal is money leaving the budget's accounts: an expense, *Transfers to
  Personal Chequing*.
- **For a budget over *Personal***, the deposit is money arriving: income, *Transfers from Business Chequing*.
- **For a budget over the whole ledger**, both sides are inside: the money never left, and the transfer counts
  nowhere.

**The rule:** a transfer counts for a budget exactly when one of its two accounts is in the budget's scope and the
other isn't. It counts from the side inside the scope, with that side's amount: money in is income, money out is an
expense. It counts toward the budget's transfer line for the other account, in the matching direction, or else under
**Other transfers in** or **Other transfers out**.

- **A transfer line nets both ways.** A *Transfers from Business Chequing* line counts transfers in from that account
  less transfers back out to it (a repayment to the business lowers what was received), as a category line nets
  refunds.
- **Savings goals and debt repayment come the same way, when the account is outside the scope:** a *Savings*
  sub-ledger holding the savings accounts lets a *Personal* budget plan *Transfers to Savings*. A savings account
  inside the scope is the budget's own money, so moving money into it isn't spending.
- **The other account is judged where it is now,** like every account in a scope. A transfer line whose account moves
  into the scope shows nothing from then on, for every month; one whose account is deleted is shown as
  *(deleted account)*. Deleting an account turns the other side of each of its transfers into an uncategorised
  transaction ([account-manager-design.md](account-manager-design.md#accountsservice-and-the-transaction-manager)),
  which counts under *Uncategorised*.
- **Both sides are always in one currency** (the accounts plugin refuses a transfer between currencies), so a transfer
  line's account is in the budget's currency.

---

## Which line a transaction counts toward

**A transaction counts toward the line of its category. If its category has no line, it counts toward the line of
its nearest parent category that has one. If none has, it counts under *Other income* or *Other expenses*,** by its
category's kind. A transfer across the scope counts toward the transfer line for its other account, else *Other
transfers in* or *Other transfers out*.

This lets a user budget coarsely (one *Food* line) or finely (*Groceries* and *Dining out*), or both: a *Food* line
for what the finer lines don't cover. The view draws the category tree:

| The category has… | Its row shows |
|---|---|
| a line, and no child category has one | The line: editable |
| no line, but child categories have | A subtotal of its children's lines and actuals: not editable, collapsible |
| a line, and child categories have lines too | A subtotal, with its own line drawn as a child row **"*Food* (other)"**: the part of *Food* the finer lines don't cover |

Transfer lines follow the category lines in their group, by account name.

Categories with no line of their own and none on a parent category (*Food : Dining out*, when only *Food :
Groceries* has a line) are summed into *Other income* or *Other expenses*, which expand to list each category with
its actual and an **Add Line** button. *Other transfers in* and *out* do the same for accounts. Nothing is hidden:
every counted transaction is in exactly one row, so the totals are the totals of the registers.

A line whose category no longer exists (possible once a category manager can delete categories) is shown under its
group as *(deleted category)*, with its budget and no actual, to be deleted or moved to another category.

---

## Budget, actual and remaining

For each row and period:

| Figure | Expenses (and transfers out) | Income (and transfers in) |
|---|---|---|
| **Budget** | Σ of each month's planned amount | the same |
| **Actual** | spending: `outflow − inflow` | income: `inflow − outflow` |
| **Remaining** | **budget − actual**: what is left to spend; **negative when over budget, in red** | **budget − actual**: what is still to come; negative when more came in than planned, never red |
| **Bar** | actual as a share of the budget, `⌊actual × 100 ÷ budget⌋` % | the same |

- **Remaining, negative when over budget** (decided in review, Q12). An expense line over budget has a negative
  Remaining in red, as a negative balance is red in the register and the navigator (`error.main`, never a literal
  colour).
- **For income, Remaining is what is still to come,** with the same sum, budget less actual. A negative there means
  more came in than planned, which is no worry, so it is never red; its tooltip says "150.00 more than planned".
- **Amber at 90 %.** An expense line turns amber (`warning.main`) once its spending reaches 90 % of its budget, and
  its bar red once past 100 %. The share is a setting, *Warn at* ([The Budget page](#the-budget-page)), as review
  asked. Income lines don't warn.
- **Percentages round down**, so *100 %* means the budget has been reached, never *nearly*.
- **The current month compares its whole budget with what has been spent so far** (confirmed in review, Q14). Nothing
  is prorated. Marking where spending would be by today is [later](#later).
- **Net** is income less expenses, for the budget and the actual. **Its Remaining is how far the month is ahead of the
  plan**: actual net less budget net, which is the expenses' remaining less the income's. Negative means behind the
  plan, in red.
- **A budget of zero** (a line stopped, or a single month set to 0) shows no bar and no percentage.
- A row with no budget (*Other*, *Uncategorised*) shows **—** for Budget, and its Remaining is minus its actual.

---

## The accounts addition: `transactionTotals`

A budget, and every report after it, needs one thing the accounts service doesn't yet answer: *how much went through
each category, and to and from each other account, in which accounts, month by month?*

```ts
// @tessera/accounts-api 1.13

/** `AccountsService.transactionTotals`: which transactions to total. */
export interface TotalsQuery {
  /** 'YYYY-MM-DD', inclusive. */
  from: string
  /** 'YYYY-MM-DD', inclusive. */
  to: string
  /** Only these accounts. Default: every account, closed ones included. */
  accountIds?: string[]
  /** Include transfers, totalled by their other account. Default false. */
  includeTransfers?: boolean
}

/** Non-voided transactions, totalled by account, month, and category or transfer account. */
export interface TransactionTotal {
  accountId: string
  /** 'YYYY-MM'. */
  month: string
  /** null for transfers, and for transactions with no category. */
  categoryId: string | null
  /** Transfers: the other account. null otherwise. */
  transferAccountId: string | null
  /** The sum of the positive amounts, in minor units. */
  inflow: number
  /** The sum of the negative amounts, made positive. */
  outflow: number
  count: number
}

export interface AccountsService {
  // …
  /**
   * Totals of the transactions dated from `from` to `to`: voided ones left out, every clearing status counted, and
   * transfers only when asked. One row per account, month, and category or transfer account that has any. (Split
   * parts, when there are splits, count by their own category.) Fails with INVALID for a bad date or `from` after `to`.
   */
  transactionTotals(query: TotalsQuery): Promise<TransactionTotal[]>
}
```

- **Why in `accounts`:** the budget can't read `accounts.transactions` (the session limits a plugin to its own
  collections), and shouldn't: what counts as a transaction, a transfer, a void or a split part is the accounts
  plugin's to say. When splits arrive, `transactionTotals` changes and no caller does.
- **Transfers by their other account:** with both accounts in `accountIds`, both sides are returned; the caller
  decides (a budget drops transfers whose other account is in its scope). A report of money between sub-ledgers uses
  the same rows.
- **How (measured in B0):** `find` with a filter on the dates, then one plain loop, as the archive's balance check
  sums. The kit doesn't use non-unique indexes to find documents, so the filter is tested on every document either
  way. **At 100,000 transactions: 19 to 29 ms for a month, 42 to 49 ms for a year, 60 to 86 ms for 24 months**; 3 to
  6 ms at 10,000. The kit's `aggregate` was 2.5 to 3 times slower, and `scan` no faster and no more yielding
  ([B0](#1-transaction-totals)). Targets were 50 ms at 10,000 and 250 ms at 100,000 for a year.
- **Why by account:** a budget's scope is a set of accounts, and an account can change sub-ledger. Grouping by account
  lets the budget choose, and lets reports group by sub-ledger as they like.
- **Why money in and money out apart:** see [Actuals](#actuals). A report of refunds needs it too.

---

## Archives: past actuals stay true

*File › Archive Ledger…* removes reconciled and void transactions before a date, and carries their total into each
account's opening balance, so no balance changes ([ledger-compaction-design.md](ledger-compaction-design.md)). Without
help, budgets *would* change: last year's groceries, archived, would vanish from last year's actual.

**The fix has two halves:**

1. **The accounts participant shares what it removed, as totals** (B1). `AccountsArchived`, which it already passes
   to the participants after it, gains:

   ```ts
   // @tessera/accounts-api 1.13
   export interface AccountsArchived {
     transactionIds: string[]
     accounts: { id: string, lastArchiveDate: string }[]
     removedAccountIds: string[]
     /**
      * The removed transactions that weren't voided, transfers included, totalled as `transactionTotals` totals them,
      * with where each account was at the time, since an account may be removed with them. (Since 1.13.)
      */
     removedTotals?: ArchivedTotal[]
   }

   export interface ArchivedTotal extends TransactionTotal {
     currency: string
     subLedgerId: string | null
     /** Transfers: the other account's sub-ledger at the time. */
     transferSubLedgerId?: string | null
   }
   ```

   **They are worked out in `applyArchive`**, after its check, from its plan and the documents it has already read,
   yielding every 10,000 transactions: about 0.3 s at 100,000 ([B1](#phase-b1-results)). Not in `planArchive`: the
   Archive dialog runs that for every date the user tries, and never needs the totals. A transfer is archived only when
   both sides are, so both sides' totals arrive together.

2. **The budget participant keeps them** (B2), in the same storage transaction, **packed: one document per account
   and month** in `budget.archivedMonths`, holding that month's totals by category and by transfer account as
   entries. It reads the months already kept once, adds to them (a second archive of the same months adds what the
   first left), and writes, yielding every 2,000 writes. It keeps them whether or not any budget exists yet: a budget
   made next year can still show last year's actuals.

   Packed because B0 measured the alternative, one document per account, month and category: 0.64 to 0.72 documents
   per archived transaction, so an archive twice as slow and an archived ledger 3 to 4 times larger. Packed, the budget
   adds 0.5 to 0.7 s to a 2 s archive at 100,000 transactions, no longer stall, and archived actuals take about 8 % of the
   space of the transactions they replace ([B0](#4-removedtotals-and-the-budgets-writes-in-the-archive)).

```ts
context.subscriptions.push(session.participateInArchive('budget', {
  describe: async () => undefined,          // removes nothing the user chooses; the dialog needn't mention budgets
  archive: async (tx, { earlier }) => {
    const totals = readRemovedTotals(earlier.get(ACCOUNTS_PLUGIN_ID))   // read defensively, as import does
    await addArchivedMonths(tx.collection('budget.archivedMonths'), totals)    // merged by account and month, yielding
    return { count: 0, summary: 'Nothing removed from budgets' }   // it adds; it removes nothing
  },
  committed: () => refreshViews()
}))
```

**Actuals are then the live totals plus the archived ones.** They never overlap: a transaction is either still in the
ledger or in an archived total, never both. For an account that no longer exists (a closed account the archive
removed with nothing left), the archived month's own `subLedgerId` and `currency` decide whether a budget covers it,
and each transfer entry's sub-ledger whether a transfer crossed the scope. Reading a year of archived months back
takes 10 to 40 ms at 100,000.

| Case | What happens |
|---|---|
| An archive before 1 January 2026, with a budget covering 2025 | 2025's actuals are the same before and after, and the test says so ([B2](#phase-b2-the-budget-domain-with-no-ui-l)) |
| Unreconciled 2025 transactions stay in the ledger | They are still live; the archived totals hold only what went |
| The archive rolls back | The budget's writes were in the same transaction, so they roll back too |
| The archive file, opened read-only | It holds the ledger as it was before the archive: its transactions are all there, and its archived actuals are those of earlier archives |
| An older `accounts` that doesn't share `removedTotals` | Not possible within one build, but read defensively: nothing is kept, and a warning is logged |
| A ledger archived **before the `budget` plugin existed**, or with it disabled | The totals of that archive were never kept. Past months show less. The archive file still has every transaction ([Risks](#risks)) |

**The budget says nothing in the Archive dialog or the message after it.** `describe` returns nothing, and `archive`
returns a count of 0: the ledger adds every participant's count into what was *removed*, and lists a summary only when
its count is above 0 ("Removed, all dated before 1 Jan 2026: 1,204 transactions from 6 accounts; 830 imported bank
lines."). The budget removes nothing, so it rightly isn't listed there; what it kept shows in the budget view, whose
Transactions dialog says how much of an actual is archived.

---

## Sub-ledgers: when a budget's sub-ledger is deleted

Deleting a sub-ledger moves everything in it to its parent, and each participant takes part in the same transaction
([account-manager-design.md](account-manager-design.md#the-ledger-tree-sub-ledgers)). A budget over the deleted
sub-ledger would otherwise cover nothing. It **moves with the contents**: it covers the parent from then on.

- `describe(id)` returns "1 budget" (or "2 budgets"), so the confirmation reads: *Its 2 sub-ledgers, 4 accounts and 1
  budget will move to “Home Finances”. Nothing in it is deleted.*
- `reparent(tx, from, to)` sets `subLedgerId: to` on those budgets, and on archived months kept with that sub-ledger
  (as their own, or as a transfer entry's other side).
- The budget now covers more accounts: the parent's own and those of its other sub-ledgers. Some of its transfer lines
  may now be inside its scope, and show nothing. Its heading says what it covers, so the change is visible.
- Moving a sub-ledger elsewhere needs nothing: the budget refers to it by id.

---

## The budget view

A main view, **`budget.view`**, shows one budget. *Show Budget* reveals it, as does clicking a budget in the Budgets
tab. Here, March 2027 of *Household*, the budget of the worked cases:

```
┌ File  View  Accounts  Budget  Tools  Help ───────────────────────────────────────────────────────────────────────────────────────────┐
│ [Accounts] [Budgets]     │ Household · Personal · CAD            [◀]  March 2027  [▶]   [Month ▾]                                    │
│ ● Household              │ [+ Line] [Edit Line…] [Delete Line] [Fill from History…]                                                  │
│ ○ Business               │                                                                                                           │
│                          │   Category                           Due                 Budget     Actual  Remaining                     │
│ [+ Budget]               │   INCOME                                                                                                  │
│                          │     Salary                           5, 19             4,200.00   4,200.00       0.00   ██████████  100%  │
│                          │     Interest                                              15.00      12.40       2.60   ████████░░   82%  │
│                          │     Transfers from Business Chequing 25                3,000.00   3,000.00       0.00   ██████████  100%  │
│                          │     Other income                                              —     150.00    -150.00                     │
│                          │   Total income                                         7,215.00   7,362.40    -147.40                     │
│                          │   EXPENSES                                                                                                │
│                          │   ▾ Food                                                 800.00     862.15     -62.15   ██████████  107%  │
│                          │       Groceries                                          650.00     598.30      51.70   █████████░   92%  │
│                          │       Food (other)                                       150.00     263.85    -113.85   ██████████  175%  │
│                          │   ▾ Housing                                            2,700.00   2,687.00      13.00   █████████░   99%  │
│                          │       Rent                           1                 1,500.00   1,500.00       0.00   ██████████  100%  │
│                          │       Home insurance                 15                1,200.00   1,187.00      13.00   █████████░   98%  │
│                          │   ▾ Transportation                                       175.00     140.00      35.00   ████████░░   80%  │
│                          │       Public transit                 1, 8, 15, 22, 29    175.00     140.00      35.00   ████████░░   80%  │
│                          │   ▸ Other expenses                                            —      86.20     -86.20                     │
│                          │     Uncategorised                                             —      41.00     -41.00                     │
│                          │   Total expenses                                       3,675.00   3,816.35    -141.35                     │
│                          │   Net                                                  3,540.00   3,546.05       6.05                     │
│                          │   Not counted: US Visa, in USD                                                                            │
├──────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Ledger: Home Finances                                                                                                                │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Red: the negative Remaining of the expenses and their totals (−62.15, −113.85, −86.20, −41.00, −141.35). *Groceries*,
*Rent*, *Home insurance* and *Housing* are amber (90 % or more); *Food* and *Food (other)* are red (over 100 %). The
income's −150.00 and −147.40 (more than planned) are not red, and the net's 6.05 means the month is ahead of the plan.

**The heading** names the budget, what it covers and its currency, and holds the period chooser: **◀ ▶** step a
month (or a year), the month is a picker, and **Month ▾** chooses *Month*, *Year to date* or *Year*. *Year to date*
runs from the start of the budget year to the month shown, and is labelled with both ("Year to date, January to March
2027"; "April 2026 to March 2027" for a year starting in April). The view opens on the current month.

**The grid** has a row per line, parent subtotal, *Other* and *Uncategorised* row, then the totals and the net, as
[Which line](#which-line-a-transaction-counts-toward) describes. **Due** lists the days of the month shown that the
line falls due on (empty for *no particular day*); in *Year to date* and *Year* it is left out. Amounts use the
`numeric` font role, right-aligned, as the register's do. Parents expand and collapse (remembered per budget). Rows
with neither budget nor actual in the period are hidden unless *Show lines with nothing this period* is on (a
setting).

**The Year** shows twelve month columns and a total, one figure per cell. A toggle chooses *Budget*, *Actual* or
*Remaining*. In *Budget*, a cell typed in sets that month only (an override, marked with a dot), as Money's advanced
budget did (B4). It is drawn only when chosen: the view opens on the month.

**Drawing and editing** (after B0, [The grid](#3-the-grid)):

- **No windowing.** 150 lines scroll as a static table does: the page does nothing while scrolling.
- **An editor keeps what is typed in its own state,** and commits it on Enter or leaving the cell. Rows are
  memoised, with stable callbacks, so a change redraws only the rows it touches. Holding the typed value in the grid's
  state redrew every row on every key: 0.36 s a key, 2.3 s on a slow CPU.
- **Amounts through `formatAmount`,** which keeps its formatters from B1 on. It built one per call, a third of the year
  grid's first render.
- **The first render is the slow part on a slow machine** (the year grid: 0.55 to 0.7 s here, 2 to 4 s with the CPU
  slowed 4×). If B3's check by hand finds it slow, the rows below the fold are drawn after the first paint.

**Keys**, as in the register:

| Key | Does |
|---|---|
| `↑` `↓` | Move between rows; `←` `→` collapse and expand a parent |
| `Enter`, `F2` | Edit the line (the Budget Line dialog); on *Other* or a category with no line, add one |
| `Insert` | New line |
| `Delete` | Delete the line, after the confirmation |
| `Ctrl+Enter` | Show the transactions behind the row's actual |
| `Page Up`, `Page Down` | The previous and next month (or year) |
| `Shift+F10` | The row's context menu: the same actions |

**In the Year** (B4), a cell is selected rather than a row:

| Key | Does |
|---|---|
| `↑` `↓` `←` `→` | Move between cells; on a row's name, `←` `→` close and open a parent; `Home`, `End` the row's name and its total; `Ctrl+Home`, `Ctrl+End` the first and last rows |
| A digit, `.`, `-` | On a line's month, in *Budget*: type that month's own amount, replacing it |
| `Enter`, `F2` | On a line's month: edit its amount, from what it is; elsewhere, as in the month (the Budget Line dialog) |
| `Enter`, `Tab`, `Shift+Tab`, `Escape` | While typing: keep the amount, keep it and move right or left, or leave the month as it was. An emptied cell uses the plan again |
| `Delete` | On a month with its own amount: *Use the plan*. On a row's name: delete the line, after the confirmation |
| `Ctrl+Enter` | The transactions behind the cell: its month's, or the year's on the name or the total |
| `Page Up`, `Page Down` | The previous and next year |

**The transactions behind an actual.** *Show Transactions* (`Ctrl+Enter`, or double-clicking the Actual cell) opens a
dialog listing them: date, account, payee, category or transfer, amount, in date order, with *Open Register* on each,
which runs `accounts.register.open { id }` and closes the dialog. It reads them with
`accounts.service.transactions(id).list({ from, to })` for each account in scope, filtered by the row's rule: a list
of at most a period's transactions, so no new accounts method is needed. Archived transactions can't be listed; the
dialog says how much of the actual is archived ("412.00 of it is in the archive before 1 Jan 2026").

**Empty states.** With no budget: "Plan what you expect to earn and spend, and see how each month is going." and
*New Budget…*. With a budget and no lines: *Add Line…* and *Fill from History…*.

---

## The Budgets tab

A left-bar view, **`budget.list`**, beside the Accounts navigator, with the plugin's own pie-chart icon (`budget.pie`,
through `shell.icons`). It lists the ledger's budgets with what each covers. Clicking one shows it in the budget view;
*[+ Budget]* runs *New Budget…*; the context menu has *Properties…*, *Duplicate…* and *Delete…*. The last budget
shown is remembered per ledger (in `context.state`, under the ledger's id) and selected when the ledger opens.

It doesn't register as a navigator (`registerNavigator`): it doesn't show the ledger tree, so the Ledger panel's rule
isn't its business.

---

## On the home view

Review decided that budgets show on the **accounts home view** (Q7). The home view isn't designed yet; it is
envisioned as **a page that plugins contribute widgets to**. This section says what the budget brings, so the home
view's design can provide for it.

```
┌ Budget · Household · March 2027 ───────────────────┐
│ Income     7,362.40 of 7,215.00                    │
│ Expenses   3,816.35 of 3,675.00   ██████████ 103%  │
│ Remaining   -141.35                                │
│ Over: Food (other) -113.85                         │
│                                      [Open Budget] │
└────────────────────────────────────────────────────┘
```

- **What it shows:** the current month of the budget the view showed last (or one chosen in the widget's own options,
  if the home view gives widgets options): income and expenses against their budgets, what remains to spend, and up
  to three expense lines over budget, the worst first. *Open Budget* runs `budget.show`.
- **How it is built:** a renderer module, `./HomeWidget`, exposed by the `budget` plugin and contributed to the home
  view's extension point, whatever the home view's design names it. It loads through the budget's own IPC (`status`
  for one month), and follows `status.changed`, as the view does.
- **What the home view needs to provide:** widgets contributed as plain data (an id, a title, a renderer module, an
  order and a `when`), drawn in the home page and each isolated by its own error boundary, as views are. Nothing
  budget-specific. This is recorded in [todo.md](todo.md) against the home view.
- **When:** B6, as soon as the home view takes widgets. The widget needs nothing from B5.

---

## Dialogs

Every dialog is a `shell.dialogs` contribution. It saves through the plugin's IPC, shows problems inline (a name
taken, an amount that doesn't parse), and closes only on success, as the account dialogs do.

**New Budget** (`budget.dialog.budget`, also *Budget Properties…* for an existing one):

```
┌ New Budget ───────────────────────────────────────────────────┐
│ Name          [ Household                                 ]   │
│ Covers        [ Personal and its sub-ledgers            ▾ ]   │
│ Currency      [ CAD ▾ ]   Not counted: US Visa, in USD        │
│ Year starts   [ January ▾ ]                                   │
│ Start with    (•) No lines                                    │
│               ( ) Amounts from my last 12 months              │
│                                         [Create]  [Cancel]    │
└───────────────────────────────────────────────────────────────┘
```

*Covers* lists the ledger and its sub-ledgers as a tree, as the New Ledger dialog's *Parent ledger* does. The currency
suggests the one most accounts in scope use, and the note under it updates as the scope or currency changes. *Amounts
from my last 12 months* creates the budget, then opens Fill from History. Changing the scope or currency of an existing
budget changes its actuals, not its lines; the dialog says so.

**Budget Line** (`budget.dialog.line`), here changing the home insurance:

```
┌ Budget Line ───────────────────────────────────────────────────────────┐
│ For          [ Home insurance                                     ▾ ]  │
│ Amount       [    1,200.00 ]   How often  [ Every year              ▾ ]│
│ Due          [ 2027-03-15 ]    ( ) No particular day                   │
│ Apply        (•) From [ March 2027 ▾ ] on                              │
│              ( ) March 2027 only                                       │
│ ┌ 2027 ──────────────────────────────────────────────────────────────┐ │
│ │ Jan —    Feb —    Mar 1,200 (due 15 Mar)   Apr —    May —   Jun —  │ │
│ │ Jul —    Aug —    Sep —    Oct —    Nov —    Dec —                 │ │
│ │ Year 1,200.00                                                      │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│ Notes        [ Policy renews each March                             ]  │
│                                                    [Save]  [Cancel]    │
└────────────────────────────────────────────────────────────────────────┘
```

- **For** (new lines only): categories as `Parent : Child`, then *Transfers from: …* and *Transfers to: …* for every
  account outside the scope in the budget's currency, as the register's category field lists *Transfer to: …*. Those
  that already have a line in this budget are left out. *Create category “…”* makes a new one (through
  `accounts.service.categories.create`, income or expense asked).
- **Due**: a date, or *No particular day* for the month-based frequencies. Weekly and fortnightly plans need a date.
  *Twice a month* adds a second day. The date defaults to the first of the month the change applies from.
- **The preview** shows the budget year the change lands in, with its due dates, computed with `plannedAmount` and
  `dueDates` from `@tessera/budget-api`, the same functions the service uses ([B-19](#decisions)).
- **Apply** appears when editing, and only for a change to the amount, frequency or due date; notes change for good.

**Fill from History** (`budget.dialog.history`): see [Filling a budget from history](#filling-a-budget-from-history).

**Transactions** (`budget.dialog.transactions`): see [The budget view](#the-budget-view).

Destructive confirmations use the native `shell.prompts.confirm`, as elsewhere: *Delete Budget…* ("Delete the budget
“Household” and its 38 lines? Your transactions aren't affected.") and *Delete Line*.

---

## Filling a budget from history

```
┌ Fill from History ─────────────────────────────────────────────────────────────┐
│ Based on the last [ 12 ] whole months: March 2026 to February 2027             │
│ Round to  [ 10.00 ▾ ]        Lines start  [ March 2027 ▾ ]                     │
│                                                                                │
│      For                      Average a month    Suggested   How often         │
│ [✓]  Salary                          4,561.54     4,560.00   Every month       │
│ [✓]  Transfers from Busine…          3,000.00     3,000.00   Every month       │
│ [✓]  Food : Groceries                  611.27       620.00   Every month       │
│ [✓]  Home insurance                    (once)     1,190.00   Every year, March │
│ [ ]  Utilities : Internet               79.99        80.00   Has a line: 75.00 │
│ …                                                                              │
│                                              [Fill 31 Lines]  [Cancel]         │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **The average** of a category, or of transfers with an account outside the scope, is its actual over the chosen
  number of **whole months** before the month the lines start, divided by that number, with the same rules as the
  view's actuals (its nearest line doesn't matter here: each category is suggested on its own).
- **Rounding** goes **up for expenses and down for income**, to the step chosen (1.00, 5.00, 10.00, 50.00, 100.00), so
  the plan errs on the careful side. This is the only division in the feature, and it is integer division on minor
  units: `⌈total ÷ (months × step)⌉ × step` for expenses, `⌊total ÷ (months × step)⌋ × step` for income.
- **A category seen in only one of the months** is suggested as *every year* in that month, at that month's amount
  (rounded), since it looks like an annual bill. History is totalled by month, so the suggestion has no particular
  day; the user can give it its due date in the list, as they can change any suggestion's frequency.
- Categories whose average is zero or less are left out. Categories that already have a line are unticked and show
  the line's amount; ticking one adds a plan from the chosen month.
- Nothing is saved until **Fill**. Then every ticked line is created, or given a plan, in one storage transaction.

---

## The Budget menu, commands and context keys

| Command | Menu (Budget) | Argument | Enablement |
|---|---|---|---|
| `budget.new` | New Budget… | | `ledger.isOpen && !ledger.isReadOnly` |
| `budget.show` | Show Budget | `{ id? }`; else the last shown | `ledger.isOpen` (with no budget, the view offers *New Budget…*) |
| `budget.properties` | Budget Properties… | `{ id? }`; else the shown one | `budget.shown && !ledger.isReadOnly` |
| `budget.duplicate` | Duplicate Budget… | `{ id? }` | `budget.shown && !ledger.isReadOnly` |
| `budget.delete` | Delete Budget… | `{ id? }` | `budget.shown && !ledger.isReadOnly` |
| `budget.line.new` | New Line… | `{ target? }` | `budget.shown && !ledger.isReadOnly` |
| `budget.line.edit` | Edit Line… | `{ id? }`; else the selected line | `budget.line.selected && !ledger.isReadOnly` |
| `budget.line.delete` | Delete Line | `{ id? }` | `budget.line.selected && !ledger.isReadOnly` |
| `budget.fillFromHistory` | Fill from History… | `{ id? }` | `budget.shown && !ledger.isReadOnly` |
| `budget.transactions` | (view and context menu) | `{ row, period }` | `budget.shown` |

```
Budget
├── New Budget…
├── Show Budget
├── ───────────
├── Budget Properties…
├── Duplicate Budget…
├── Delete Budget…
├── ───────────
├── New Line…
├── Edit Line…
├── Delete Line
├── ───────────
└── Fill from History…
```

**The menu is *Budget*, with the other plugin menus after *Accounts*** (confirmed in review, Q13). When reports
arrive, budgets and reports may share a *Planning* menu; that move is recorded in [todo.md](todo.md) and
[Later](#later). The ids stay the same, so only the menu contributions change. There is no accelerator at first; bare
keys such as `Delete` are handled in the view, as the register does, so that typing in a field never deletes a line.

| Context key | Meaning |
|---|---|
| `budget.hasBudgets` | The open ledger has at least one budget |
| `budget.shown` | The id of the budget the view shows, or unset |
| `budget.line.selected` | A line is selected in the view (not a subtotal or *Other* row) |
| `budget.statusText` | "Budget: 2 lines over" (or "1 line over") while the shown budget has expense lines over this month, for the status bar; unset otherwise (B5) |
| `budget.statusDetail` | Which lines, and by how much: "Household, March 2027: Food (other) $113.85 over; …", for the status item's tooltip (B5) |

---

## The contract: `@tessera/budget-api`

The package holds what other plugins and the plugin's own views share: the model, the service interface, ids and
channels, errors, and **the planning arithmetic** (`plan.ts`), which is pure and has no storage or Electron in it.

```ts
// @tessera/budget-api
export const BUDGET_PLUGIN_ID = 'budget'
export const BUDGET_SERVICE = 'budget.service'
export const BUDGET_MIGRATOR_SERVICE = 'budget.migrator'
export const BUDGET_SCHEMA_VERSION = 1

/** The largest amount a plan may have, in minor units, so every total stays a safe integer (see Lines and plans). */
export const BUDGET_AMOUNT_MAX = 10 ** 11
export const BUDGET_LINES_MAX = 500
export const STATUS_MONTHS_MAX = 24

export type LineGroup = 'income' | 'expense'

/** What the view shows: one month, the budget year up to a month, or the whole budget year. */
export type BudgetPeriod = 'month' | 'yearToDate' | 'year'

/** Whole months, 'YYYY-MM', inclusive. */
export interface MonthRange { from: string, to: string }

export interface BudgetInput {
  name: string
  subLedgerId: string | null
  currency: string
  yearStartMonth: number
  notes?: string
}

export interface LineInput {
  target: LineTarget
  plan: LinePlan
  notes?: string
}

/** A change to a line's amount, frequency or due date. */
export type PlanChange =
  | { apply: 'from', plan: LinePlan, replaceLater?: boolean }    // a plan from `plan.from`
  | { apply: 'only', month: string, amount: number | null }      // an override; null removes it

export interface Figures {
  budget: number
  actual: number
  /**
   * budget − actual. Expenses: negative when over budget. Income: what is still to come. The net: actual net less
   * budget net, negative when behind the plan.
   */
  remaining: number
}

export type StatusRowKind =
  | 'line' | 'subtotal' | 'parentLine' | 'transferLine'
  | 'other' | 'otherTransfers' | 'uncategorised' | 'deletedCategory' | 'deletedAccount'

export interface StatusRow {
  kind: StatusRowKind
  group: LineGroup
  /** Indentation, from the category tree. */
  depth: number
  label: string
  categoryId?: string
  /** Transfer lines and the accounts under Other transfers. */
  accountId?: string
  lineId?: string
  figures: Figures
  /** For a single month: the days it falls due. */
  due?: number[]
  /** Each month's figures, in `BudgetStatus.months` order: for the year grid. */
  months?: Figures[]
  /** For expense lines and subtotals: spending has reached the warning share, or passed the budget. */
  warning?: 'near' | 'over'
  /** For Other and Other transfers rows: each category, or account, they gather (B2: how they "expand"). */
  breakdown?: { id: string, label: string, actual: number }[]
  /** For a line: the months of the status that have their own amount, which the year grid marks (B4). */
  ownMonths?: string[]
}

export interface BudgetStatus {
  budget: Budget
  months: string[]
  rows: StatusRow[]
  totals: { income: Figures, expenses: Figures, net: Figures }
  /** Accounts in scope left out for their currency. */
  notCounted: { accountId: string, name: string, currency: string }[]
  /** How much of each row's actual comes from archived totals, by row index; omitted when none. */
  archived?: Record<number, number>
  /** Each month's totals, with `byMonth`: the year grid's total rows (B4). */
  monthlyTotals?: { income: Figures, expenses: Figures, net: Figures }[]
}

/** One suggestion in Fill from History. */
export interface LineSuggestion {
  target: LineTarget
  group: LineGroup
  /** 'Food : Groceries', or the account's name (B2). */
  label: string
  /** What it added up to over the months looked at (spending for expenses, income for income). */
  total: number
  /** `total` over the months, to the nearest minor unit: shown, never saved. */
  average: number
  /** What the line would plan: rounded up for expenses, down for income, from `total` with integers only. */
  amount: number
  frequency: Frequency
  /** 'YYYY-MM': history has no particular day. */
  due: string
  /** The line this already has in the budget, if any: unticked at first. */
  existingLineId?: string
  /** That line's plan for the month the lines would start, shown beside the suggestion (B4). */
  existingPlan?: LinePlan
}

export interface BudgetChange {
  budgets: string[]          // created, changed or deleted
  deleted: string[]
  lines: string[]            // budgets whose lines changed
  actuals: boolean           // transactions, categories, accounts or an archive changed what actuals show
}

export interface BudgetService {
  list(): Promise<Budget[]>
  get(id: string): Promise<Budget | undefined>
  create(input: BudgetInput): Promise<Budget>
  update(id: string, patch: Partial<BudgetInput>, options?: { expectedRev?: number }): Promise<Budget>
  /** A copy, with every line and override, under a new name. */
  duplicate(id: string, name: string): Promise<Budget>
  delete(id: string): Promise<void>

  lines(budgetId: string): Promise<BudgetLine[]>
  addLine(budgetId: string, input: LineInput): Promise<BudgetLine>
  changeLine(lineId: string, change: PlanChange, options?: { expectedRev?: number }): Promise<BudgetLine>
  setLineNotes(lineId: string, notes: string | null): Promise<BudgetLine>
  deleteLine(lineId: string): Promise<void>
  /** Several lines at once, all or none: Fill from History. */
  fill(budgetId: string, lines: LineInput[]): Promise<BudgetLine[]>

  /** Budget, actual and remaining for every row, and the totals, over `months`. `warnAtPercent` (B2): the Budget page's *Warn at*. */
  status(budgetId: string, months: MonthRange, options?: { byMonth?: boolean, warnAtPercent?: number }): Promise<BudgetStatus>
  /** Suggestions for Fill from History. Reads only. */
  suggest(budgetId: string, options: { months: number, start: string, step: number }): Promise<LineSuggestion[]>

  readonly onDidChange: Event<BudgetChange>
}

// plan.ts: pure, shared by the service and the dialogs
export function occurrences(plan: LinePlan, month: string): number
export function dueDates(plan: LinePlan, month: string): string[]      // 'YYYY-MM-DD'; [] for no particular day
export function plannedAmount(line: Pick<BudgetLine, 'plans' | 'overrides'>, month: string): number
export function monthsOf(range: MonthRange): string[]
export function budgetYear(month: string, yearStartMonth: number): MonthRange
export function yearToDate(month: string, yearStartMonth: number): MonthRange
```

**Errors** are `BudgetError`s with a code, as in `accounts`: `NO_LEDGER`, `READ_ONLY`, `NOT_FOUND`,
`DUPLICATE_NAME`, `DUPLICATE_LINE` (the category or account already has a line), `INVALID` (with the `field`),
`CONFLICT`. Each plugin bundles its own copy of the package, so `isBudgetError(err)` checks the shape, not
`instanceof`, and `toBudgetResult(work)` turns one into a `BudgetResult<T>` (`{ ok: true, value }` or
`{ ok: false, error }`, the shape `AccountsResult` has) for a view. Expected outcomes cross IPC as results, not
exceptions.

**Rules the service enforces:** a ledger is open and writable; the sub-ledger, category and account exist; a transfer
line's account is outside the scope and in the budget's currency; the currency is an ISO 4217 code;
`yearStartMonth` is 1 to 12; amounts are whole, not negative, and at most `BUDGET_AMOUNT_MAX`; months are valid
`YYYY-MM`; due dates valid, with a day for weekly and fortnightly plans; `secondDay` only for twice a month; a line's
plans in order with no month twice; at most one line per category or account and 500 per budget; a status of at most
24 months; `expectedRev` matches.

---

## Storage schema (`budget`)

| Collection | Indexes |
|---|---|
| `budget.budgets` | unique `[nameKey]`; `bySubLedger [subLedgerId]` |
| `budget.lines` | unique `[budgetId, target.categoryId]`; unique `[budgetId, target.accountId]` |
| `budget.archivedMonths` | unique `[accountId, month]` |

- **The two unique indexes on lines are sparse:** a category line has no `target.accountId`, a transfer line no
  `target.categoryId`, so each index holds only its own kind, and each kind is unique per budget.
- **An archived month** is one account's archived actuals for one month (after B0):

  ```ts
  interface ArchivedMonth {
    accountId: string
    month: string                                   // 'YYYY-MM'
    currency: string                                // the account's, when it was archived
    subLedgerId: string | null                      // likewise; null for an account directly in the ledger
    /** By category id ('' for uncategorised): [inflow, outflow, count]. */
    categories: Record<string, [number, number, number]>
    /** By the other account's id: [inflow, outflow, count, that account's sub-ledger when it was archived]. */
    transfers: Record<string, [number, number, number, string | null]>
  }
  ```

  The account's own `currency` and `subLedgerId` are used while it exists; those kept here only once it doesn't.
- `plans` and `overrides` are kept inside their line: a line is small (a handful of plans, a few overrides), is always
  read whole, and is changed in one `replace` with `expectedRev`.
- **Version 1.** The migrator's `0 → 1` seeds nothing: a ledger has no budget until the user makes one. Declaring a
  collection or an index later needs no migration, as for `accounts`.
- **Size** (measured in B0). Archived months are at most accounts × months: about 1,400 documents for 15 accounts and
  nine years. Their entries are the real size: **0.64 to 0.72 per archived transaction** (a household pays most bills
  once a month per category), about 8 % of the transactions' JSON. At 100,000 transactions, archiving before 2026
  leaves a 9.2 MB ledger instead of 4.7 MB. Interning the ids would halve that ([Later](#later)).

---

## IPC and events

As built in B3 ([what changed](#phase-b3-results)) and B4 ([results](#phase-b4-results)).

| Channel (`budget:…`) | Request → reply |
|---|---|
| `budgets` | → `BudgetsView`: the budgets with what each covers, the one shown, the month and period, `readOnly`, `archive`; null while no ledger is open |
| `status` | `{ budgetId, months: MonthRange, byMonth? }` → `BudgetResult<BudgetStatus>`; `byMonth` for the year grid |
| `budget.save` | `{ id?, input, expectedRev? }` → `BudgetResult<Budget>` (the whole form) |
| `line.add` | `{ budgetId, input: LineInput }` → `BudgetResult<BudgetLine>` |
| `line.change` | `{ lineId, change?, notes?, expectedRev? }` → `BudgetResult<BudgetLine>`: a plan, one month's amount, the notes, or both, in one write, checked against the revision the dialog started from |
| `line` | `{ lineId }` → `BudgetResult<BudgetLine>`: the line as it is now, for the Budget Line dialog after a conflict |
| `category.create` | `{ path, kind }` → `BudgetResult<Category>`: *Create category “…”* in *For* |
| `select` | `{ budgetId, month, period, lineId? }` → void: the view reports what it shows and has selected, for the commands and the context keys |
| `suggest` | `{ budgetId, months, start, step }` → `BudgetResult<LineSuggestion[]>`: Fill from History's list (B4) |
| `fill` | `{ budgetId, lines: LineInput[] }` → `BudgetResult<BudgetLine[]>`: every line ticked, or none (B4) |
| `budget.duplicate` | `{ id, name }` → `BudgetResult<Budget>`: the copy (B4) |

Deleting a budget or a line, and the transactions behind a row, are commands: each asks first or gathers what its
dialog shows on the privileged side, and passes it to the dialog as its input. So the targets a new line can be for
travel in `LineDialogInput.choices`, and a row's transactions in `TransactionsDialogInput`.

| Event (`budget:…`) | Payload |
|---|---|
| `budgets.changed` | `BudgetsView`, or null: after any create, rename, delete or scope change, a sub-ledger renamed or moved, a budget shown, a ledger opened or closed. Sent only when it differs from the last one sent |
| `status.changed` | `{ budgetId }`: reload this budget's status, at once after its own changes; `{ budgetId: null }`: every budget's, debounced (see below) |
| `line.selected` | `{ budgetId, lineId }`: a command added or changed this line; the view selects it |

---

## Keeping the view current

The budget view must follow every change that alters what it shows, without recomputing on every keystroke in the
register.

| Source | Event | The budget plugin |
|---|---|---|
| A transaction added, edited, voided, deleted, imported or reconciled | `accounts.onDidChange` with `transactions` | marks actuals stale |
| A category added | `accounts.onDidChange` with `categories` | marks actuals and the tree stale |
| An account created, moved, closed, reopened or deleted | `accounts.onDidChange` with `created`, `updated` or `deleted` | marks actuals stale (its scope may have changed) |
| A sub-ledger created, moved or deleted | `ledger.onDidChangeTree` | marks actuals stale; refreshes the Covers labels |
| An archive | the participant's `committed` | marks actuals stale |
| A budget or line changed | its own service | sends `budgets.changed` or `status.changed` at once |
| The ledger opened or closed | `ledger.onDidChange` | reloads everything, or clears it |

**Stale actuals are recomputed only while the view (or the home widget) is shown**, at most once every 250 ms, and
the view is told with `status.changed`. (The shell keeps a main view mounted once shown, hidden behind another; the
view watches whether it is on screen, and a change while it is hidden is read once it is shown again: [Review after
B5](#review-after-b5).) An import of 300 bank lines is one `accounts` event, so it costs one refresh.
The status for a month is one `transactionTotals` call over that month, plus the archived actuals, plus the pure
`budgetStatus`.

---

## The Budget page

Tools › Options… › **Budget**, namespace `budget`, a page of fields the shell draws:

| Setting | Kind | Default | What it does |
|---|---|---|---|
| `warnAtPercent` | number, 50 to 100 | 90 | *Warn at*: an expense line turns amber once its spending reaches this share of its budget (review, Q12) |
| `showBars` | boolean | on | Show the bars beside each line |
| `showEmptyLines` | boolean | off | Show lines with neither budget nor actual in the period |
| `historyMonths` | number, 3 to 24 | 12 | The months Fill from History suggests |
| `roundTo` | choice: 1, 5, 10, 50, 100 | 10 | The step Fill from History suggests (in whole units of the budget's currency) |
| `statusBar` | boolean | on | Show "Budget: 2 lines over" in the status bar while a budget has lines over this month |

These are the user's preferences, not the ledger's, so they are application settings. A budget's scope, currency and
year start are facts about the budget, and live with it in the ledger ([B-16](#decisions)). The view's *More* menu changes *Show bars* and
*Show lines with nothing this period* as the page would, and opens the page (*Budget Options…*) (B5). `budget.service`
warns at *Warn at* too, so another plugin warns as the view does unless it asks for another share.

---

## Read-only ledgers and archive files

A ledger open read-only (an archive file, opened from *File › Open Ledger…*) shows its budgets as they were, with the
actuals its transactions give. The view, the tab, the widget and the dialogs offer nothing that changes it: the
budgets list carries `readOnly`, as the accounts chart and register view do, and every writing command has
`!ledger.isReadOnly`. The plugin writes nothing when a ledger opens. An archive made before the `budget` plugin
existed has no budget collections: the session reads them as empty, and the view says "No budgets in this archive".

---

## Security, privacy and robustness

- **Nothing leaves the machine.** Budgets are in the ledger file, with the transactions they summarise; they are
  backed up, restored and archived with it.
- **Logs hold counts, never amounts, category or account names**, as the import and export plugins do.
- **All or nothing:** *Fill*, *Duplicate Budget…* and *Delete Budget…* are each one storage transaction, and so are
  the participants' parts of a sub-ledger delete and an archive.
- **Conflicts:** every write takes `expectedRev`. A line changed elsewhere since the dialog opened shows "This line
  was changed elsewhere" and reloads, keeping what was typed.
- **No floating point in amounts.** Planned amounts are integer products; Fill from History uses integer division.
  Amounts are parsed with `parseAmount` and shown with `formatAmount`, never through `Number` arithmetic on text.
- **A misbehaving plugin can't break budgets:** the budget reads accounts only through `accounts.service`, and shares
  archived totals only through the archive contract, which it reads defensively.

---

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Envelope (zero-based) budgeting** as the model (YNAB, Goodbudget): the money actually in the accounts is shared out among categories each month until none is left, and what a category doesn't spend stays in it, like cash in an envelope | A different habit, and not Money's. It needs *available to assign* from account balances, carry-over by design, and rules for credit cards. Left for later ([Later](#later)); the model here could carry it as a second kind of budget |
| **Rollover**, carrying what remained (or was overspent) into the next month | Turned down in review (Q2): each month starts afresh, which is simpler to read and to explain |
| **Spreading an irregular bill** (Money's *occasional expenses*: 100.00 a month put aside for a 1,200.00 premium) | Turned down in review (Q3): a bill is planned on its due date instead. Without rollover, spreading would make the month it is paid look 1,100.00 over |
| **Transfers never count** (this note's first draft) | Changed in review (Q4): a business paying its owner is real income for the household and a real cost for the business. Transfers inside a scope still don't count |
| **Every transfer counts**, inside the scope too | Moving money from chequing to savings would look like spending, and a whole-ledger budget would count each transfer twice, once each way |
| **One budget per year** (Quicken), copied forward | A chore each January, awkward for fiscal years, and weekly cycles must be re-anchored. Effective-dated plans give the same history with one budget ([Changing a plan](#changing-a-plan)) |
| **Plans edited in place** | Rewrites every past month's budget when a plan changes |
| **Weekly amounts averaged** (`× 52 ÷ 12`) | Needs rounding, and the remainder spread over months; each month is then wrong by a bit. Counting occurrences is exact and matches the bank |
| **A copy of each transaction's amount in the budget**, kept up to date on every write (the *budget actuals* the plugin guide sketches) | A second copy of the truth, to keep in step with every edit, void, transfer, import, match and reconciliation, and to repair when it drifts. Worked out on demand, actuals can't disagree with the registers |
| **Reading the accounts collections directly** | Not allowed (the session scopes each plugin's database), and rightly: the rules of what counts belong to `accounts` |
| **Totals computed by the budget from `TransactionManager.list` per account** | Works with today's API, but every budget and report would repeat the rules (voids, transfers, later splits), and it reads every transaction through IPC-shaped objects. One service method is the right place |
| **In the archive, the budget works out what was removed itself**, reading the ledger outside the archive transaction | Depends on reads outside a transaction seeing the state before it commits, which the storage contract doesn't promise. Sharing totals is what the contract's `earlier` is for |
| **Archived actuals as one document per account, month and category** (this note's first draft) | Measured in B0: 0.64 to 0.72 documents per archived transaction, so the budget's part doubled a 2 s archive at 100,000 transactions, added half a second to the commit's stall, and made the archived ledger 3 to 4 times larger. Packed by account and month instead |
| **The removed totals in `planArchive`**, so the dialog's preview and the archive agree (this note's first draft) | Measured in B0: 0.21 to 0.39 s at 100,000, 2.5 to 4 times `planArchive` itself, which the Archive dialog runs for every date tried, and the preview never shows them. Worked out in `applyArchive` instead |
| **`aggregate` or `scan`** for `transactionTotals` | Measured in B0: `aggregate` 2.5 to 3 times slower than `find` on the dates; `scan` no faster, and no more yielding |
| **Windowing the grid** (drawing only the rows in view) | Measured in B0: 150 rows scroll with no work in the page, so windowing would add complexity (keyboard focus, row heights, find-in-page) for nothing. Kept in reserve for the first render on slow machines |
| **An index on `date`** for `transactionTotals` | The kit only uses unique indexes to find documents; a non-unique index would cost every write and speed up nothing |
| **Budgets inside the `accounts` plugin** | Against the rule the vault and account-manager notes set: domain areas are plugins of their own, and `accounts` stays the accounts |
| **A *monthly budget* field on each category** (as some apps have) | Only one budget, no history, no frequencies, and budget fields in the accounts model |
| **Budgets in a file of their own** | The transactions are in the ledger; two files would drift apart, and backups, restores and archives would have to handle both |
| **Scope as a list of accounts** (Quicken) | More control, but a new account has to be added by hand, and Tessera already groups accounts by sub-ledger. Excluding accounts is [later](#later) |
| **Signed amounts in lines** (expenses negative, as in the accounts) | Users think of a grocery budget as 650, not −650. The sign comes from the category's kind or the transfer's direction |
| **A *Difference* column, signed so negative is always bad** (this note's first draft) | Changed in review (Q12) to *Remaining*, which reads naturally for spending |
| **A budget column in the register, or category hints while typing** | Useful, but needs an extension point in the register's category field ([Later](#later)) |

---

## Risks

| Risk | Mitigation |
|---|---|
| **`transactionTotals` too slow at 100,000 transactions** for a year view | **Measured in B0: 42 to 49 ms for a year, 60 to 86 ms for 24 months.** The year view asks once, not twelve times. If a larger ledger ever makes it slow, the accounts plugin keeps per-month totals in memory, rebuilt lazily after writes, behind the same method |
| **Archiving with the `budget` plugin absent** (disabled with `disabledPlugins` in `tessera-bootstrap.json`) loses that archive's totals for budgets | The archive file keeps every transaction. The plugin guide's section on archive participants says what a disabled participant misses. Rebuilding archived actuals from archive files is possible [later](#later) |
| **A category manager** (later) deletes or merges categories with lines | Lines are shown as *(deleted category)* and can be moved; the category manager's design settles what `accounts` reports |
| **Splits** (later) change what a category's actual is | Handled inside `transactionTotals`; budgets need no change. The B1 tests gain split cases when splits exist |
| **Scope surprises:** moving an account or deleting a sub-ledger changes past actuals, and can turn a transfer line's transfers into internal ones | The heading always says what the budget covers; the sub-ledger confirmation says budgets move. Accepted in review (Q10) |
| **A bill paid a day after its due date** lands in the next month's actual | The *Due* column shows why; matching payments to due dates is [later](#later) |
| **The grid is slow** with 150 categories in the year view (about 2,000 cells) | **Narrowed in B0:** scrolling does no work in the page, and keys and clicks paint in two frames. What remains is the **first render on a slow machine** (2 to 4 s with the CPU slowed 4×): the view opens on the month, the year grid draws only when chosen, `formatAmount` keeps its formatters (B1), and rows below the fold can be drawn after the first paint if B3's check by hand asks for it |
| **Archived actuals make an archived ledger larger** (found in B0: 0.64 to 0.72 entries per archived transaction) | Packed by account and month, about 8 % of the transactions they replace: an archive before 2026 at 100,000 leaves 9.2 MB instead of 4.7 MB. Interning the ids would halve it ([Later](#later)) |
| **Typing in the grid redraws it all** (found in B0: 0.36 s a key, 2.3 s on a slow CPU) | Editors keep what is typed in their own state; a test counts renders ([B3](#phase-b3-the-budget-view-the-budget-menu-and-the-dialogs-l)) |
| **The view refreshes too often** during an import or a reconciliation | One refresh per `accounts` event, at most every 250 ms, only while shown |
| **Time zones** put a transaction or payday in the wrong month | Dates are `YYYY-MM-DD` text and day numbers; nothing converts through `Date` in a time zone. **Checked in B0** on every day from 1970 to 2100, in six zones; the test stays, run in a zone with half-hour daylight saving |
| **The home view's widget contract** doesn't suit the budget's widget | Its needs are written down here ([On the home view](#on-the-home-view)) and in `todo.md`, for the home view's design |

---

## Decisions taken in review

Answered on 2026-11-15, and applied throughout this note.

| # | Question | Decision | Where it lands |
|---|---|---|---|
| Q1 | Envelope (zero-based) budgeting: now, later or never? | **Later** | [Non-goals](#goals-and-non-goals), [Later](#later) |
| Q2 | Rollover of what remained into the next month? | **No: each month starts afresh** | [B-7](#decisions), [Non-goals](#goals-and-non-goals) |
| Q3 | Spreading irregular bills over the year? | **No. A plan can be due on a particular date, which puts it in that month's budget** | [B-5](#decisions), [How much a month is planned, and when it is due](#how-much-a-month-is-planned-and-when-it-is-due), the Line dialog |
| Q4 | Should transfers count? | **Yes, planned for.** A business account paying its owner is a withdrawal in the business and income in the personal sub-ledger | [B-4, B-9, B-10](#decisions), [Transfers across the budget's scope](#transfers-across-the-budgets-scope), `transactionTotals` with transfers |
| Q5 | Future-dated transactions in the current month? | **Count them** | [Actuals](#actuals) |
| Q6 | One currency per budget? | **Yes**; several currencies, with exchange rates, maybe later | [Budgets](#budgets), [Later](#later) |
| Q7 | Budgets beyond the view? | **On the home view**, envisioned as a page plugins contribute widgets to | [B-20](#decisions), [On the home view](#on-the-home-view), [B6](#phase-b6-the-home-view-widget-s) |
| Q8 | Category deletes and merges | **Later**, with the category manager | [Later](#later) |
| Q9 | Scope | **A sub-ledger, or the ledger.** Excluding accounts is a future addition | [Budgets](#budgets), [Later](#later) |
| Q10 | Moving an account moves its history | **Accepted**: not expected often | [Budgets](#budgets) |
| Q11 | Importing budgets from Money or Quicken | **Later** | [Later](#later) |
| Q12 | Wording and signs | **Remaining**; negative when over budget; *Other expenses*; amber at 90 %, **as a setting** | [B-11](#decisions), [Budget, actual and remaining](#budget-actual-and-remaining), [The Budget page](#the-budget-page) |
| Q13 | Where the menu lives | **Under *Budget*, as planned**, with a to-do to move it under a *Planning* menu | [The Budget menu](#the-budget-menu-commands-and-context-keys), [todo.md](todo.md), [Later](#later) |
| Q14 | The current month: whole budget against spending so far? | **Yes, as designed.** Marking where spending would be by today is a future consideration | [Budget, actual and remaining](#budget-actual-and-remaining), [Later](#later) |

Smaller choices made while applying them. Each is easy to change; flag any that are wrong:

- **For income, Remaining is what is still to come** (budget less actual, as for expenses), so a negative means more
  came in than planned and is never red. The **net's** Remaining is how far the month is ahead of the plan (actual net
  less budget net), red when behind.
- **A transfer counts only when it crosses the scope,** from the side inside it: money in is income, money out an
  expense. A budget over the whole ledger therefore never counts a transfer.
- **Transfer lines are keyed by the other account**, not its sub-ledger, and net both directions. Transfers across the
  scope with no line show under *Other transfers in* and *Other transfers out*.
- **A due date is optional** for the month-based frequencies (*no particular day*, right for groceries) and required
  for weekly and fortnightly ones. A day past a month's end falls on its last day. **Actuals still count by the
  transaction's date**, not the due date.
- **The home widget** waits for the home view (B6) and asks it only for generic widget contributions.
- **Rollover and spreading are dropped,** not deferred: they no longer appear under [Later](#later).

---

## Open questions

None. B0 changed how some things are built (archived actuals packed by account and month, the totals worked out in
`applyArchive`, editors keeping what is typed), and one rule (*twice a month*'s default second day), not what the
feature does ([What changes in this note](#what-changes-in-this-note)).

---

# Part 2: Implementation plan

## Ground rules

- **The conventions of the Finance plugins:** names in `protocol.ts` constants, pure code apart from storage and
  Electron, every disposable on `context.subscriptions`, results (not exceptions) across IPC, user-facing text in the
  house style, and amounts only through the money helpers.
- **Tested against the real accounts service on a memory engine**, as the export plugin's `gather` is, not a fake:
  what counts as an actual is the accounts plugin's rule, and a fake would let the two drift.
- **The invariant tests are the spine:** every counted transaction is in exactly one row; the rows add up to the
  totals; a year's budget is the sum of its months; an archive changes no month's actual; a transfer counts for a
  budget exactly when it crosses the scope.
- **No floating point in amounts.** The one division the feature needs is a single integer helper in `suggest.ts`
  (`divideRounding(total, divisor, 'up' | 'down')`), with a property test against `BigInt` arithmetic. An
  architecture test greps `plan.ts`, `status.ts` and `suggest.ts` for `toFixed`, `parseFloat` and `Math.round`, as the
  export's writers are checked for `formatAmount`.
- **No personal data in fixtures:** budgets in tests are made from the synthetic household
  (`scripts/sample-archive/household.ts`) or written in the test.
- **Each phase ends usable,** with its results recorded in this note and `todo.md` ticked.

## Dependency graph and order

```
B0 spike ──► B1 transactionTotals, removedTotals ──► B2 budget domain, no UI ──► B3 view, menu, tab, dialogs ──┬──► B4 year grid, single months, history, copies
                                                                                                               ├──► B5 Budget page, warnings, service events
                                                                                                               └──► B6 home view widget  ◄── the home view (accounts)
```

B0 comes first because its measurements decide how `transactionTotals` reads. B1 is a change to `accounts` alone,
merged on its own with no visible change. B2 builds and proves the whole domain before any UI depends on it, as phase
2 of the account manager did. B4 and B5 are independent of each other after B3. B6 also waits on the accounts home
view, which isn't designed yet; it can come before B4 or B5 if the home view is ready first.

---

## Phase B0: spike (S)

**Goal:** answer the questions the design can't, before anything is merged into `plugins/`.

| # | Question | How |
|---|---|---|
| 1 | How fast can the accounts plugin total a year of transactions by account, month, and category or transfer? | A throwaway script over ledgers of 1,000, 10,000 and 100,000 transactions, on the kit with SQLite: `find({ date range })` then a loop; `scan()` in batches; `aggregate` with `$match` then `$group`. Medians of five, for a month and a year |
| 2 | Is the date arithmetic right on every day? | `occurrences` and `dueDates` written against a brute-force walk of the calendar, 1970 to 2100, for every frequency and first weekday, due days of 29, 30 and 31 in short months, and 29 February (a yearly plan due on 29 February falls on 28 February in other years) |
| 3 | Does a year grid of 150 rows render and scroll smoothly? | MUI's `Table` with 150 rows × 14 columns in a browser, scrolling and typing in a cell; and the time to mount in jsdom, for the tests' sake |
| 4 | Does sharing `removedTotals` fit the archive's budget of time? | Time the extra totalling at 100,000 transactions (the archive's phase 0 measured `planArchive` at 67 to 80 ms), and the budget participant's writes, in the real archive |
| ~~5~~ | ~~Does Money Plus's Budget Planner do anything this design has missed?~~ | **Dropped** (2026-11-15): the design is enough for a first pass |

**Done when:** the results are recorded under [Phase B0 results](#phase-b0-results), the implementation of
`transactionTotals` is chosen, and the design is amended where the findings differ. **Done 2026-11-15.**

### Phase B0 results

Recorded 2026-11-15. **All four questions are answered, and the design holds, with four changes** ([What changes in
this note](#what-changes-in-this-note)): archived actuals are **packed, one document per account and month**, because
one per category made the archive twice as slow and the file several times larger; the totals of an archive are worked
out in `applyArchive`, not `planArchive`; *twice a month*'s default second day is **the other half of the month**, not
"15 days after", which put both on one day in 5 % of months; and **an editor keeps what is typed in its own state**,
because holding it in the grid's costs 0.36 s a key. Also found: `formatAmount` builds an `Intl.NumberFormat` on every
call, 97 µs against 3 µs to format, a third of the year grid's first render.

**How it was run.** The spike's code was throwaway, as the earlier spikes' was. It lived outside the repository
(`/tmp/budget-spike`), bundled the repository's **real** storage kit, SQLite driver, accounts schema, `planArchive`,
`applyArchive`, `verifyArchive`, `createShellTheme`, `@tessera/ui` and `formatAmount` with esbuild, aliased as
`tsconfig.base.json` aliases them, and prototyped the rest as this note describes it: `transactionTotals`, `plan.ts`,
the budget's side of a status, the removed totals and the budget participant's writes.

- **The machine.** A Linux VM, 4 cores (Intel Xeon, 2.6 GHz), 15 GB, no GPU. Warm runs only.
- **The Node.** **Node 24.21.0 (SQLite 3.53.4)**, from the `node-linux-x64` npm package: Electron 45's line, as the
  compaction spike used (it had 24.11.1, SQLite 3.50.4).
- **The browser.** **Electron couldn't be installed**: only the npm registry was reachable, and Electron, Playwright and
  Puppeteer download their browsers from elsewhere. The grid ran instead in **Chromium 153's headless shell** from the
  `@sparticuz/chromium` npm package, driven by `puppeteer-core`, drawing in software (SwiftShader). Electron 45 is
  Chromium 142. Timings were taken at the VM's speed and with the CPU slowed 4× (Chrome's `setCPUThrottlingRate`), to
  stand for a slower laptop.
- **The ledgers** were built through the real kit and driver with the real schema, shaped like the compaction spike's
  and with what budgets need on top: transactions from 2017 to November 2026 in 15 accounts (three sub-ledgers,
  *Personal*, *Business* and *Rentals*, and two accounts directly in the ledger; one in US dollars; four closed), about
  a tenth of them transfers (both sides counted; a quarter of those the owner's pay, *Business Chequing* to *Personal
  Chequing*); 97.5 % of history to September 2026 reconciled; 1 % void; 3 % refunds and 2 % uncategorised; 300 payees
  and 120 categories; a finished reconciliation per account and month listing what it reconciled. They came to **0.8,
  5.5 and 48.6 MB** at 1,000, 10,000 and 100,000 transactions, close to the backup spike's 0.7, 5.8 and 56 MB.
- **The longest stall** is the longest the main thread went without turning its event loop, measured with a
  `setImmediate` chain, as the backup and compaction spikes measured it.

| Question | Answer |
|---|---|
| 1. How fast are the totals? | **Fast enough, with `find` on the dates and a plain loop: 19 to 29 ms for a month and 42 to 49 ms for a year at 100,000 transactions** (three runs), inside the 50 and 250 ms targets; 60 to 86 ms for the 24 months a status can cover. The kit's `aggregate` is 2.5 to 3 times slower; reading every document (`find()`) 5 to 7 times. `scan` is no faster than `find`, and **doesn't yield either**: its stall equals its time. The budget's own share of a status (scope, currency, nearest lines, transfers across the scope) is 0.2 to 7 ms. **Chosen: `find({ date })` then the loop** |
| 2. Is the date arithmetic right? | **Yes, on every day from 1970 to 2100, in every time zone tried.** 1,118 plans, 1.85 million plan-months, against an oracle walking the calendar with `Date.UTC`; 2,000 random lines with up to four plans and overrides (384,000 line-months); `budgetYear` and `yearToDate` for every month and start month; the worked example of 2027 as this note has it. **A naive version with local `Date`s is wrong** in London, Apia and Lord Howe. **"15 days after" as *twice a month*'s default second day is wrong**: both days fall on one day in 75 of 1,488 months |
| 3. Does a grid of 150 rows render and scroll smoothly? | **It scrolls as a static table does: while scrolling, React commits nothing, and the browser recalculates no style and lays out nothing.** How smooth that is depends on the machine's compositor, which a software-drawn headless browser can't judge (static HTML tables, with no script at all, scrolled as badly there): **seen by hand in B3**. The month view (900 cells) mounts in 0.5 to 0.7 s here and the year grid (2,100 cells) in 0.55 to 0.7 s, 2 to 4 s with the CPU slowed 4×. Arrow keys and clicks paint in 29 to 37 ms (two frames). **Typing in a cell: 28 ms a key with the value in the cell's own state; 356 ms with it in the grid's, and 2.3 s with the CPU slowed 4×.** In jsdom, with development React, a mount takes 1.25 s (month) and 2.0 s (year) |
| 4. Does sharing `removedTotals` fit the archive's budget of time? | **Yes, packed, one document per account and month: it adds 0.5 to 0.7 s to a 1.9 to 2.0 s archive at 100,000 transactions, no longer stall while it works, and 0.1 to 0.17 s to the commit.** **One document per account, month and category, as designed, doesn't fit**: it doubles the archive (+1.7 to 2.2 s), adds half a second to the commit's stall, and makes the archived ledger 3 to 4 times larger. Totalling what was removed takes 0.21 to 0.39 s, too long for `planArchive`, which the Archive dialog runs for every date tried. **The invariant holds** in every run: totals before = totals after + removed |

#### 1. Transaction totals

Medians of five, in ms, warm, with the ledger open in the kit. At 100,000 the figures are the range over three runs; at
1,000 and 10,000, the first run's (the others agree within 3 ms, but the aggregate's, which varied up to 21 ms). Every
way gave the same totals, row for row, on every range. *Loop* is the loop alone, over documents already read.

| Transactions | Range (transactions in it) | A: `find` with dates | B: `scan` with dates | C: `aggregate` | D: `find()` all | Loop | Budget's share |
|---|---|---|---|---|---|---|---|
| 1,000 | a month (8) / a year (82) | 0.6 / 0.5 | 0.4 / 0.4 | 1.2 / 2.1 | 2.1 / 1.4 | 0.0 / 0.1 | 0.2 / 0.1 |
| 10,000 | a month (81) / a year (846) | 3.2 / 3.8 | 2.3 / 3.6 | 8.6 / 14.8 | 13.6 / 11.5 | 0.0 / 0.6 | 0.1 / 0.4 |
| 100,000 | a month (904) / a year (8,214) | 19.2 to 29.1 / 42.5 to 49.3 | 19.9 to 24.4 / 33.8 to 55.0 | 51.0 to 62.0 / 115.6 to 151.5 | 130.5 to 158.5 / 147.2 to 333.2 | 0.8 / 10.5 | 0.2 / 3.4 |
| 100,000 | 24 months (17,729) | 60.3 to 86.2 | 76.3 to 89.7 | 253.1 to 325.1 | 281.3 to 308.7 | 42.7 | 6.7 |

- **Where the time goes:** the kit tests the date filter on every document (there is no index it can use), then clones
  the matches. The clone is most of the rest; the loop is small.
- **It all happens in one stretch of the main thread.** At 100,000 a year's status holds the main process for about
  50 ms, and the view asks at most every 250 ms while it is shown. Acceptable; if a ledger ever makes it longer, the
  accounts plugin can keep per-month totals in memory behind the same method ([Risks](#risks)).
- A year's status then reads the archived actuals too: 10 to 40 ms at 100,000 after archiving before 2026
  ([4](#4-removedtotals-and-the-budgets-writes-in-the-archive)). So the year view's refresh is about 60 to 90 ms there.

#### 2. The date arithmetic

`plan.ts` was written as [How much a month is planned](#how-much-a-month-is-planned-and-when-it-is-due) describes it,
on day numbers (Hinnant's `days_from_civil`), and checked against an oracle that walks every day from 1 January 1970 to
31 December 2100 (47,847 days) with `Date.UTC` and applies each frequency's definition day by day.

| Check | Cases | Failures |
|---|---|---|
| Day numbers both ways, every day | 47,847 days | 0 |
| Weekly and fortnightly, first due on every day of four weeks across a year end, and on 1 Jan 1970, 29 Feb 1972 and 2000, 31 Dec 2099, 28 Feb 2100 | 66 plans × every month | 0 |
| Once, monthly, every two months, quarterly, twice a year and yearly, due on every day of a 31-, 30- and 28-day month and of February 2024, or no particular day | 780 plans × every month | 0 |
| Twice a month, every due day, each rule for the second day, and second days of 1, 10, 15, 28, 29, 30 and 31 given | 272 plans × every month | 0 |
| Random lines: 1 to 4 plans, first due dates up to 200 days either side of their month, overrides, every month 2020 to 2035 | 2,000 lines, 384,000 line-months | 0 |
| `budgetYear` and `yearToDate` | every month × 12 start months | 0 |
| The worked example of 2027 in this note | 6 lines × 12 months | 0: paydays on 2, 16, 30 April and 1, 15, 29 October |

**Time zones.** The whole check was run again with `TZ` set to America/Toronto, America/Sao_Paulo, Australia/Lord_Howe,
Pacific/Apia, Asia/Kolkata and Europe/London: no failures. **A naive weekly plan, stepping 7 × 86,400,000 ms from a
local midnight, was wrong in 158 plan-months in London** (British Standard Time, 1968 to 1971), **860 in Apia** (the
day Samoa skipped in 2011) **and 3,732 on Lord Howe** (half-hour daylight saving). So the rule in this note, day numbers
and never a `Date` in a time zone, is needed, not only tidy.

**Twice a month's second day.** The rule first written, "15 days after the first" and then the month's last day when
that day doesn't exist, puts **both payments on the same day in 75 of 1,488 months** (due on the 16th or later: the
30th and 31st in a 30-day month, or 28 February twice) and under 10 days apart in 432 more. **"The other half of the
month"**, the day 15 after when the first is on the 15th or before, else 15 before (the 20th gives the 5th), never
clashes, and needed the month's last day in only 96 months.

**Clarified:** only dates on or after the first due date count, so *twice a month* due first on the 20th falls once in
its first month (the 5th of that month is before it).

`plannedAmount` for 500 lines over 24 months took 21 ms, cold.

#### 3. The grid

The year grid and the month view were built as B3 would build them: `@tessera/ui`'s `Table` under the shell's own
`createShellTheme(DEFAULT_THEME, 'light')`, amounts through `formatAmount`, colours from theme tokens, `sx` on cells as
the register does, rows in `React.memo` with stable callbacks, `LinearProgress` from MUI (B3 adds it to `@tessera/ui`),
150 rows. Medians of five loads (the spread is wide on this VM: 470 to 1,052 ms for the month view).

| React | CPU | View (cells) | Mount (first load) | Arrow key | Click | Typing: value in the cell | Typing: value in the grid |
|---|---|---|---|---|---|---|---|
| production | VM | month (900) | 677 ms (628) | 33 ms | 29 ms | | |
| production | VM | year (2,100) | 704 ms (1,063) | 37 ms | 34 ms | 28 ms | 356 ms |
| production | VM | year, cached formatter | 549 ms (1,267) | 31 ms | 35 ms | 36 ms | 175 ms |
| production | 4× slower | month | 2,112 ms (2,099) | 94 ms | 96 ms | | |
| production | 4× slower | year | 3,938 ms (3,065) | 135 ms | 132 ms | 118 ms | 2,279 ms |
| production | 4× slower | year, cached formatter | 2,134 ms (1,963) | 103 ms | 126 ms | 124 ms | 697 ms |
| development | VM | month | 914 ms (1,173) | 37 ms | 33 ms | | |
| development | VM | year | 1,161 ms (1,546) | 46 ms | 44 ms | 41 ms | 628 ms |
| development | 4× slower | year | 3,574 ms (4,703) | 134 ms | 140 ms | 98 ms | 3,594 ms |

- **Scrolling does no work in the page.** Chrome's counters while scrolling both views top to bottom and back: no
  React commit, no style recalculation, no layout, as for static HTML tables of the same size. Scrolling 150 rows is
  the compositor's job alone, so **no windowing or virtualisation is needed**. The frame times themselves mean nothing
  here: static tables with no script scrolled at 30 frames a second, with frames of several seconds, in a browser
  drawing in software on a VM. **Seen by hand in B3**, on Windows, as the other phases' smoke tests are.
- **Typing must stay in the cell.** With the typed value in the grid's state every key re-renders all 150 rows: 0.36 s
  a key, 2.3 s with the CPU slowed 4×. In the editor's own state, only the editor re-renders: 28 to 41 ms. So **an
  editor keeps what is typed in its own state, and rows are memoised with stable callbacks**
  ([The budget view](#the-budget-view)), as the register's editor already does.
- **`formatAmount` is the biggest single cost of a first render.** It builds an `Intl.NumberFormat` each call: 97 µs,
  against 3 µs to format with one kept. The year grid formats about 2,250 amounts, some 200 ms of its 700 ms. Keeping
  the formatters (by locale, currency and options) takes the year grid from 3.9 to 2.1 s with the CPU slowed 4×. **The
  register pays the same for every row**, so the fix belongs in `@tessera/accounts-api` (B1), not in the budget view.
- **Styling is not the cost.** Moving the cells' `sx` into one rule on the table changed nothing measurable; plain
  `<td>`s instead of MUI's `TableCell` saved about a fifth.
- **The first render is slow on a slow machine:** 2 to 4 s with the CPU slowed 4×. The view opens on the month (900
  cells); the year grid draws only when chosen, and *Show lines with nothing this period* is off, so fewer rows are
  drawn. If B3's check by hand finds it slow, draw the rows below the fold after the first paint.
- **Tests:** a 150-row grid takes 1.25 to 2.0 s to mount in jsdom. Renderer tests use small budgets (up to 20 lines);
  one test mounts 150 ([todo.md](todo.md#testing-and-tooling): slow dialog tests).

#### 4. removedTotals and the budget's writes in the archive

The real `applyArchive` on copies of the 100,000 ledger, with a prototype of B1's change (the same steps, plus the
removed totals from the documents it already read, yielding every 20,000) and the budget participant's writes in the
same storage transaction, three ways: **rows**, one document per account, month and category or transfer account
(this note as first written), each looked up then written; **bulk**, the same documents with those already there read
once and new ones inserted 2,000 at a time; **packed**, one document per account and month, its categories and
transfers as entries. Medians of three, with nothing else running. *During the work* is the longest stall before the
commit; the commit is synchronous on the main thread until [ledger-compaction-design.md](ledger-compaction-design.md)'s
Phase 5 moves large commits into the driver's worker.

| Archive before | Way | Whole archive | Longest stall (during the work) | Commit | Budget's writes | Documents | File after compaction |
|---|---|---|---|---|---|---|---|
| 2022 (53 % removed) | accounts alone | 1,877 ms | 859 ms (319) | 518 ms | | | 21.1 MB |
| | rows | 3,585 ms | 1,208 ms (237) | 1,151 ms | 1,244 ms | 33,978 | +10.3 MB |
| | bulk | 2,978 ms | 869 ms (275) | 868 ms | 913 ms | 33,978 | +10.3 MB |
| | **packed** | **2,609 ms** | **880 ms (374)** | **685 ms** | **194 ms** | **834** | **+2.8 MB** |
| 2026 (89 % removed) | accounts alone | 1,980 ms | 770 ms (448) | 643 ms | | | 4.7 MB |
| | rows | 4,167 ms | 1,154 ms (157) | 1,139 ms | 1,858 ms | 56,769 | +17.3 MB |
| | bulk | 6,290 ms | 1,228 ms (380) | 1,218 ms | 1,493 ms | 56,769 | +17.3 MB |
| | **packed** | **2,485 ms** | **1,141 ms (227)** | **750 ms** | **352 ms** | **1,362** | **+4.5 MB** |

- **The removed totals: 212 to 389 ms** at 100,000, 10 to 16 ms at 10,000. Building the key by joining three ids was
  most of it; grouping by account, then month, then category or transfer account is a little faster. It is 2.5 to 4
  times `planArchive` itself (80 to 91 ms), and the Archive dialog runs `planArchive` for every date the user tries. So
  **the totals are worked out in `applyArchive` only**, from the plan and the documents it has read, yielding every
  20,000; the dialog never needs them.
- **One row per key compresses almost nothing.** The spike's ledgers gave 0.64 rows per archived transaction, and the
  real shape is worse: **the sample household (`npm run sample:archive`) gives 0.72**, since a household pays most bills
  once a month per category. The estimate first written here ("a few thousand in practice") was wrong by an order of
  magnitude. It made the archived ledger 3 to 4 times the size of the ledger without it, against the point of
  archiving.
- **Packed, the archived actuals are about 8 % of the JSON of the transactions they replace** (2.3 MB for 27.9 MB
  before 2026). The file still grows 4.5 MB (4.7 to 9.2 MB): an archive before 2026 then shrinks it 81 % rather than
  90 %. Two ways to go further were measured as JSON size only, and are left for later ([Later](#later)): **interning the
  ids** (a small dictionary document) halves it again; **packing by sub-ledger and currency** instead of account takes a
  third off, but loses the account, which moving an account needs.
- **The stall during the work doesn't grow** with packed writes (227 to 374 ms, against 319 to 448 ms for the accounts
  alone; the difference is noise), because the totals and the writes yield. **The commit grows by 0.1 s or so**, for
  the 2.8 to 4.5 MB more it writes, until large commits move into the driver's worker.
- **Reading a year back** from packed documents: 10 to 40 ms at 100,000, one `find` on the month.
- **The invariant holds in every run, every way:** `transactionTotals` before the archive equals `transactionTotals`
  after plus what was archived, for every account, month, category and transfer account, transfers included.

#### What changes in this note

| Section | Change |
|---|---|
| [Archives](#archives-past-actuals-stay-true), [Storage schema](#storage-schema-budget) | Archived actuals are **packed: one document per account and month** in `budget.archivedMonths`, unique on `[accountId, month]`, holding that month's category and transfer totals as entries. The size estimate is corrected |
| [Archives](#archives-past-actuals-stay-true), [B1](#phase-b1-transaction-totals-in-accountsservice-m) | `removedTotals` is worked out in **`applyArchive`**, not `planArchive`, yielding every 20,000 transactions. The budget participant reads the months already kept once, merges, and writes, yielding every 2,000 writes |
| [How much a month is planned](#how-much-a-month-is-planned-and-when-it-is-due), [Lines and plans](#lines-and-plans) | *Twice a month*'s default second day is **the other half of the month**. Only dates on or after the first due date count |
| [The accounts addition](#the-accounts-addition-transactiontotals) | **`find` on the dates, then a plain loop**, measured |
| [The budget view](#the-budget-view) | **An editor keeps what is typed in its own state**; rows are memoised. No windowing. The year grid draws only when chosen |
| [B1](#phase-b1-transaction-totals-in-accountsservice-m) | **`formatAmount` keeps its `Intl.NumberFormat`s** (by locale, currency and options): for the register as well as budgets |
| [B2](#phase-b2-the-budget-domain-with-no-ui-l), [B3](#phase-b3-the-budget-view-the-budget-menu-and-the-dialogs-l) | The spike's oracle becomes `budgetApi.test.ts`; renderer tests use small budgets |
| [Risks](#risks) | The grid's risk is narrowed to the first render on slow machines; the archived actuals' size is a new one |

#### Not verified

- **Electron itself**, and a real GPU. The grid ran in a headless Chromium 153 drawing in software. How smoothly 150
  rows scroll is for B3's check by hand on Windows; the page does no work while scrolling, so it can't be the grid's
  fault.
- **Windows and macOS**; a cold disk (only warm runs, as before); the LokiJS engine (the kit is the same, and Loki
  reads a whole file as SQLite does).
- **A real ledger's shape** beyond the sample household. Real ledgers may compress archived actuals a little better
  than 0.72 rows per transaction, or worse.

---

## Phase B1: transaction totals in `accounts.service` (M)

**Goal:** the two generic additions to `accounts`, and `formatAmount` keeping its formatters, with no visible change
(but a register that draws faster).

### Files

| File | What |
|---|---|
| `packages/accounts-api/model.ts` | `TotalsQuery`, `TransactionTotal`, `ArchivedTotal`; `AccountsArchived.removedTotals` |
| `packages/accounts-api/service.ts` | `AccountsService.transactionTotals` |
| `packages/accounts-api/index.ts` | `ACCOUNTS_API_VERSION` 1.13.0 |
| `packages/accounts-api/money.ts` | `formatAmount` keeps one `Intl.NumberFormat` per locale, currency and options, instead of building one per call (97 µs against 3 µs: [B0](#3-the-grid)) |
| `plugins/accounts/src/privileged/transactionsCore.ts` | `transactionTotals(docs, query)`, pure, over the documents `find({ date })` returns, as B0 chose |
| `plugins/accounts/src/privileged/AccountsServiceImpl.ts` | The method, with its checks (`INVALID` for bad dates or `from` after `to`; `NO_LEDGER`) |
| `plugins/accounts/src/privileged/archiveCore.ts` | `applyArchive` totals what the plan removes, transfers included, from the documents it has read, yielding every 10,000 transactions (20,000 as first planned; [results](#phase-b1-results)), and shares `removedTotals`. `planArchive` is unchanged, so the Archive dialog's preview stays as fast |
| `docs/account-manager-design.md`, `docs/ledger-compaction-design.md`, `docs/plugin-creation.md` | The method in *`accounts.service`*; `removedTotals` in *The participant contract*; *Using accounts from another plugin* shows `transactionTotals` |

### Tasks, in order

1. The types and the method's contract, with its doc comments.
2. `transactionTotals` as a pure function over transaction documents, then wired into the service.
3. `removedTotals` in `applyArchive`.
4. `formatAmount`'s kept formatters, with a test that what it writes hasn't changed, for several locales and
   currencies (JPY, BHD).
5. The scale tests, with B0's numbers.
6. The documentation changes above.

### Tests

- `tests/plugins/accounts/transactionTotals.test.ts`: voids left out; transfers left out unless asked, then by their
  other account, both sides when both accounts are asked for; uncategorised as `categoryId: null`; inflow and outflow
  apart (a refund); month boundaries (31 January, 1 February; 29 February 2028); `accountIds`; closed accounts
  included; a deleted account's transactions gone, and its transfers' other sides uncategorised; every clearing status
  counted; `INVALID` dates; `NO_LEDGER`.
- **The archive invariant** (`tests/plugins/accounts/archive.test.ts`, added to): for random ledgers and archive
  dates, `transactionTotals` (with transfers) before the archive equals `transactionTotals` after plus
  `removedTotals`, for every account, month, category and transfer account.
- `tests/plugins/accounts/totalsScale.test.ts`: a year's totals over 100,000 transactions within 250 ms of CPU time
  (B0 measured 42 to 49 ms); an archive's `removedTotals` at 100,000 with no stall over 100 ms of its own (as built,
  short stretches between turns, none of them most of the work: [results](#phase-b1-results)).
- `tests/packages/money.test.ts` (added to): `formatAmount` gives what it gave, and 10,000 calls take under 100 ms.
- `tests/packages/apiPackages.test.ts`: the new exports and the version.

**Done when:** the [Definition of done](#definition-of-done) holds, and the import and export suites are untouched.
**Done 2026-11-15.**

### Phase B1 results

Built 2026-11-15, as planned, with one change to how the archive's totals are worked out, found by its scale test.
**No visible change.** `npm test`: 198 files and 2,999 tests pass (196 and 2,977 before). `npx tsc --noEmit -p plugins`
reports nothing, and `-p tests` the same 28 errors as before (the stale imports in [todo.md](todo.md)). The import and
export plugins and their tests are untouched.

| Step | As built | Where |
|---|---|---|
| 1. The contract | `TotalsQuery`, `TransactionTotal`, `ArchivedTotal`, `AccountsArchived.removedTotals` (optional, so readers check it), `AccountsService.transactionTotals`; accounts-api **1.13.0** | [model.ts](../packages/accounts-api/model.ts), [service.ts](../packages/accounts-api/service.ts) |
| 2. `transactionTotals` | Checks the query (`INVALID` naming `from`, `to`, `accountIds` or `includeTransfers`), reads the dates with one `find`, and totals in one pass. **Only accounts that exist are counted**, as the register never shows a transaction whose account is gone (decided while building: the note didn't say). Rows come **in order**: month, account, then category (none first) or transfer account | [transactionsCore.ts](../plugins/accounts/src/privileged/transactionsCore.ts) (`TotalsBuilder`, `transactionTotals`, `readTotals`), [AccountsServiceImpl.ts](../plugins/accounts/src/privileged/AccountsServiceImpl.ts), the plugin's `publicService` |
| 3. `removedTotals` | In `applyArchive`, after `verifyArchive`, so an archive the check stops never pays for it; shared with the other participants. `planArchive` and the dialog's preview are unchanged | [archiveCore.ts](../plugins/accounts/src/privileged/archiveCore.ts) |
| 4. `formatAmount` | Keeps its formatters, and `minorDigits` and the locale's separators (for `parseAmount` and `amountToInput`) too. It had built **two** `Intl.NumberFormat`s a call, not one. A failure is never kept, so an unknown currency or locale still throws every time | [money.ts](../packages/accounts-api/money.ts) |
| 5. Tests | Below | |
| 6. Documentation | [account-manager-design.md](account-manager-design.md#accountsservice-and-the-transaction-manager) (the method), [ledger-compaction-design.md](ledger-compaction-design.md#the-participant-contract) (`removedTotals`), [plugin-creation.md](plugin-creation.md#using-accounts-from-another-plugin) (`transactionTotals`; the archive example now keeps the removed totals, where it sketched a copy of each transaction, which this design turned down) | |

**Measured** (Node 24.21, the same VM as B0; CPU time, as the scale tests measure):

| What | Result |
|---|---|
| A year's totals over 100,000 transactions, through the service on the memory engine | **69 to 120 ms of CPU time**, 5,285 rows (budget 250 ms). By the clock B0 measured 42 to 49 ms; CPU time also counts the garbage collector's threads |
| `formatAmount`, 10,000 amounts | **35 ms of CPU time, against 971 ms** as it was: 28 times faster. The register gains as much |
| An archive's `removedTotals` at 100,000 (89,066 removed) | **0.31 to 0.33 s of CPU time** in all, 71,962 rows, in ten stretches between turns of 12 to 45 ms by the clock, but for one or two of **57 to 91 ms** (87 to 137 ms of CPU) |

**What changed from the plan: the archive's totals.** The first version, yielding every 20,000 transactions, had
stretches of 125 to 189 ms. Two causes, both found with `--trace-gc`:

- **Building a set of the 89,000 removed ids** took 40 ms in one piece, growing as the set rehashed. It isn't needed:
  `planArchive` lists what it removes in the order it reads the transactions, so `removedTotals` walks the two
  together. Should the orders ever differ, the ids it missed are found with a set, so the totals are right either way
  (a test lists them backwards).
- **Each row was built twice** (an empty total, spread into the archived one) and each transaction built a key string.
  Rows are now built once, and categories and transfers are kept in separate maps, keyed by their ids.

What remains is a **young-generation garbage collection** of 50 to 90 ms, which promotes the rows built (73 ms in one
trace). Yielding more often doesn't split it (every 5,000 gave the same peak), so the step is **10,000 transactions**,
and the scale test allows **200 ms of CPU time** between turns, against the 100 ms first written here: CPU time counts
the collector's parallel threads, and reached 137 ms under a full test run. A loop that didn't yield would take about
300 ms. (In B4, on a busy machine, the process's CPU time for that stretch reached 201 ms in a full run and 973 ms on
its own, the collector's helper threads spinning. The test now measures the main thread's CPU time where Node can
tell it (23.9 and later: 44 to 90 ms for that stretch), and asks that a typical stretch take under 50 ms and the
longest less than half of the whole, which a loop that didn't yield fails.) For scale, the archive's own steps already stall 0.3 to 0.45 s at 100,000 until its commit moves into the
driver's worker ([B0](#4-removedtotals-and-the-budgets-writes-in-the-archive)), so the totals don't lengthen its longest
stall. The spike's ledgers make almost a row per removed transaction (120 categories spread evenly); a household's make
fewer, so fewer to collect.

**Tests added:**

| File | What it proves |
|---|---|
| `tests/plugins/accounts/transactionTotals.test.ts` (new, 12 tests) | By category, money in and out apart (a refund); every status counted, voids left out, uncategorised as null; transfers only when asked, by their other account, both sides or one; month boundaries through 29 February, both dates inclusive; the order; closed accounts counted, only the accounts asked for; a deleted account's transactions gone and its transfers' other sides uncategorised; `INVALID` for each field; `NO_LEDGER`; an account that no longer exists; a zero amount |
| `tests/plugins/accounts/archive.test.ts` (4 added) | **The invariant on 40 random ledgers:** totals after + `removedTotals` = totals before, for every account, month, category and transfer account, with each total's currency and sub-ledgers those of its accounts, removed accounts included; voids left out; the turns; any order of removals |
| `tests/plugins/accounts/totalsScale.test.ts` (new, 2 tests) | The two CPU-time budgets above, and that the totals add up to what they total |
| `tests/packages/money.test.ts` (3 added) | `formatAmount` writes exactly what it wrote, for 8 locales, 6 currencies (JPY, BHD among them), every option and 11 amounts, twice in different orders; unknown currencies and locales still throw; 10,000 amounts in under 100 ms |
| `tests/packages/apiPackages.test.ts`, `tests/plugins/accounts/activation.test.ts` | The version, the new shapes (through the type checker), and `transactionTotals` in the service other plugins get |

---

## Phase B2: the budget domain, with no UI (L)

**Goal:** budgets, lines (category and transfer), plans with due dates, actuals, status and both participants,
complete and proved through `budget.service`.

### Files

| File | What |
|---|---|
| `packages/budget-api/` (`index.ts`, `model.ts`, `plan.ts`, `service.ts`, `protocol.ts`, `errors.ts`, `package.json`, `tsconfig.json`) | The contract and the planning arithmetic |
| `tsconfig.base.json`, `vitest.config.ts`, `scripts/build-plugins.mts` (`API_PACKAGES`) | `@tessera/budget-api` aliased like the other API packages |
| `tests/architecture/boundaries.test.ts` | `budget-api` may depend on `@tessera/types`, `@tessera/ledger-api` and `@tessera/accounts-api` only |
| `plugins/budget/manifest.json` | Requires `accounts.service`, `ledger.session`, `shell.prompts`, `app.state`; provides `budget.service`, `budget.migrator` |
| `plugins/budget/src/privileged/schema.ts` | The `ledger.schema` contribution and the migrator |
| `…/store.ts` | The collections, stored shapes, name keys |
| `…/BudgetServiceImpl.ts` | The service and its rules |
| `…/status.ts` | `budgetStatus`, pure: rows by the category tree, nearest lines, transfer lines and the scope rule, *Other*, *Other transfers*, *Uncategorised*, due days, totals, warnings |
| `…/suggest.ts` | `suggestLines`, pure |
| `…/participants.ts` | The sub-ledger participant and the archive participant |
| `…/index.ts` | Activation: schema, service, participants, events; no UI yet |

### Tasks, in order

1. `@tessera/budget-api` with `plan.ts` and its property tests (B0's brute-force walk becomes the test).
2. Schema, migrator, store, and the service's budgets and lines, with every rule and error.
3. `status.ts`, then `status()` on the service, against the real accounts service on a memory engine.
4. The participants: sub-ledger (`describe`, `reparent`) and archive (`removedTotals` packed into
   `budget.archivedMonths`).
5. `suggest.ts` and `suggest()`, `fill()`, `duplicate()`.
6. Events: `onDidChange` from the service's own writes, and `actuals` from `accounts`, the ledger tree and archives.

### Tests

- `tests/packages/budgetApi.test.ts`: B0's check, kept: `plan.ts` against a walk of the calendar with `Date.UTC`,
  every frequency and first weekday, due days 29 to 31 in short months, 29 February, no particular day, twice a month
  with each second day, random lines with several plans and overrides, `budgetYear` and `yearToDate` for every start
  month, and the worked example of 2027. B0 walked 1970 to 2100 in about 18 s; the suite walks 2000 to 2040, and the
  whole range runs on demand. The vitest project runs it with `TZ` set to a zone with half-hour daylight saving
  (Australia/Lord_Howe), where a `Date` slip shows at once.
- `tests/plugins/budget/service.test.ts`: create, rename, duplicate, delete; names unique ignoring case; lines unique
  per category and per account; a transfer line refused for an account inside the scope or in another currency;
  plans in order; the limits (`BUDGET_AMOUNT_MAX`, 500 lines, 24 months); `expectedRev` conflicts; `READ_ONLY` and
  `NO_LEDGER`.
- `tests/plugins/budget/archiveLayout.test.ts`: archived months merge a second archive into the first; the totals
  read back equal `removedTotals`; a removed account's months keep its sub-ledger and currency.
- `tests/plugins/budget/status.test.ts`: the worked cases in [Actuals](#actuals), as written; nearest-parent lines;
  *(other)* rows; deleted categories and accounts; scope by sub-ledger with descendants; currencies left out and
  named; future-dated transactions counted; **every counted transaction in exactly one row**; totals, Remaining and
  the net's Remaining.
- `tests/plugins/budget/transfers.test.ts`: the owner's pay, seen from a *Business* budget (an expense), a *Personal*
  budget (income) and a whole-ledger budget (nothing); a transfer inside the scope counts nowhere; a repayment nets
  against the line; *Other transfers in* and *out*; an account moved into the scope.
- `tests/plugins/budget/archive.test.ts`: with the real ledger session, accounts and budget on a memory engine:
  **every month's actual is the same before and after an archive**, transfers included, for random ledgers; a removed
  closed account's history still counted by its kept sub-ledger and currency; a second archive adds to the first; a
  rollback leaves nothing.
- `tests/plugins/budget/subLedgers.test.ts`: deleting a budget's sub-ledger moves the budget to the parent; the
  confirmation text; archived months follow.
- `tests/plugins/budget/suggest.test.ts`: averages over whole months, categories and transfers; rounding up for
  expenses and down for income; a one-month category as yearly; nothing saved until `fill`; `fill` all or none.
- `tests/plugins/budget/activation.test.ts`: the built plugin activates after `accounts`, joins the archive after it,
  and an archive file opens with budgets read-only.

**Done when:** the [Definition of done](#definition-of-done) holds (nothing to see yet, so no check by hand beyond an
archive of the sample ledger in a test).
**Done 2026-11-15.**

### Phase B2 results

Built 2026-11-15: the budget domain complete and proved through `budget.service`, with no UI. **Nothing to see yet**:
the plugin is bundled and activates after `accounts`, keeps budgets in the ledger, and takes part in deleting
sub-ledgers and in archives. `npm test` passes: 208 files and 3,075 tests, 76 of them new (10 new files, and additions to
`apiPackages` and `boundaries`). `npx tsc --noEmit -p plugins` reports nothing, and `-p tests` the same 28 errors as before.

| Step | As built | Where |
|---|---|---|
| 1. The contract | The model, `BudgetService`, errors (`BudgetError`, `isBudgetError`, `toBudgetResult`), ids and limits, and `plan.ts`: day numbers, `occurrences`, `dueDates`, `plannedAmount`, `planFor`, `lineCovers`, `budgetYear`, `yearToDate`, and **`planProblem`**, the plan's rules, so a dialog checks what the service checks. Aliased like the other API packages; the boundary test allows it `@tessera/types`, `ledger-api` and `accounts-api` | [packages/budget-api](../packages/budget-api/) |
| 2. Budgets and lines | Every rule of [the contract](#the-contract-tesserabudget-api), in one storage transaction each, with `expectedRev`; only what a plan is, is kept | [BudgetServiceImpl.ts](../plugins/budget/src/privileged/BudgetServiceImpl.ts), [store.ts](../plugins/budget/src/privileged/store.ts), [schema.ts](../plugins/budget/src/privileged/schema.ts) |
| 3. Status | Pure: `scopeOf` (the accounts covered), `countedTotals` (what counts, live and archived, with the scope rule for transfers), `budgetStatus` (rows, figures, warnings, totals, what came from archives). The service only gathers | [status.ts](../plugins/budget/src/privileged/status.ts) |
| 4. Participants | Sub-ledgers: `describe` ("2 budgets"), `reparent` (budgets and archived months). Archives: `removedTotals` read defensively and packed one document per account and month, merged with an earlier archive's, yielding every 2,000 writes; a count of 0 and no description | [participants.ts](../plugins/budget/src/privileged/participants.ts) |
| 5. History | `suggestLines` (pure) and `divideRounding`, the one division; `suggest`, `fill` (all or none), `duplicate` | [suggest.ts](../plugins/budget/src/privileged/suggest.ts) |
| 6. Events | Its own writes; `actuals` when transactions, categories or accounts change, the tree changes (with the budgets a delete moved), a ledger opens or closes, or an archive is committed | [BudgetServiceImpl.ts](../plugins/budget/src/privileged/BudgetServiceImpl.ts) |

**What the tests prove** (`tests/plugins/budget/` and `tests/packages/budgetApi.test.ts`):

| Claim | Proved by |
|---|---|
| **The worked cases of [Actuals](#actuals), as written**: each of the twelve transactions where the design puts it, the rows in order, and the totals (income 3,150.00 against 3,000.00, expenses 870.50 against 800.00, the net 79.50 ahead) | `status.test.ts` |
| **Every counted transaction is in exactly one row** that isn't a subtotal, so the rows' net is the net of the registers, and subtotals are their children's sums: 12 random ledgers × three budgets (the ledger, Personal, Business) | `status.test.ts` |
| **No month's actual changes through an archive**, transfers included: 12 random ledgers, three budgets each, every month of 2022 to 2026 compared before and after; a closed account the archive removes, still counted by its kept sub-ledger; a second archive; a rollback leaving nothing | `archive.test.ts` |
| **Transfers count exactly when they cross the scope**: the owner's pay as an expense for Business, income for Personal, nothing for the ledger; inside the scope, nowhere and refused as a line; a repayment netted; Other transfers in and out; an account moved into the scope; one deleted | `transfers.test.ts` |
| The date arithmetic, on every day 2000 to 2040 (1970 to 2100 on demand, 15 s), **in the Lord Howe time zone**, which the test checks is in effect | `budgetApi.test.ts`, in the new `timezone` vitest project |
| The service's rules, limits, conflicts, read-only archive files and no ledger; sub-ledger deletes; Fill from History; the packed layout; activation, and **the built plugin on SQLite across a restart** | `service`, `subLedgers`, `suggest`, `archiveLayout`, `activation.test.ts` |
| `divideRounding` exact against `BigInt` for 5,000 random safe amounts; no `Math.round`, `toFixed` or `parseFloat` in the budget's arithmetic, no `Date` in `plan.ts` | `suggest.test.ts`, `boundaries.test.ts` |

**Measured:** a year's status month by month (the year grid) over 100,000 transactions, with 47 lines: **54 to 120 ms
of CPU time** (`statusScale.test.ts`, budget 500 ms), as the design estimated (60 to 90 ms for the year view's refresh).

**Decided while building** (the design left room; each easy to change):

- **A line that doesn't plan a month yet hands its transactions on**, to the next line up that does, or to *Other*:
  "a line covers nothing before its first plan's month" applied to the matching as well as the budget. So nearest lines
  are found month by month.
- **Other and Other transfers carry a `breakdown`** (each category, or account, and its actual, largest first) rather
  than extra rows, so nothing is counted twice; it is what the view will expand. *Uncategorised* has none.
- **Rows shown:** every line, always (a line planned only for later months shows zeros); *Other*, *Other transfers* and
  *Uncategorised* only when they hold a transaction; a subtotal when a category beneath has a line. Under a subtotal
  come its children, then the parent's own line, "*Food* (other)", as in the view's sketch.
- **A transaction whose category is gone counts as uncategorised**, by its direction, and **a line whose category is
  gone** goes with the expenses (its kind is gone with it). Neither can happen until a category manager exists.
- **`LineSuggestion.label`** ("Housing : Home insurance", or the account's name) and **`status(…, { warnAtPercent })`**
  (the Budget page's *Warn at*, B5) were added to the contract. `FREQUENCY_LABELS` and `planProblem`
  give the dialogs the same words and rules as the service.
- **A transfer line whose account an archive removes** reads *(deleted account)* afterwards, as the design says for a
  deleted account; its figures don't change.
- **Writes to a read-only ledger** are refused with `READ_ONLY` before anything is tried.


---

## Phase B3: the budget view, the Budget menu and the dialogs (L)

**Goal:** a user can make a budget, add and change lines, and follow a month and the year to date.

### Files

| File | What |
|---|---|
| `plugins/budget/src/privileged/contributions.ts` | The Budget menu, `budget.view` (`shell.main`, `when: ledger.isOpen`, after the register in `order`), `budget.list` (`shell.left`), the dialogs, the `budget.pie` icon |
| `…/commands.ts`, `…/ipc.ts` | The commands of the [menu](#the-budget-menu-commands-and-context-keys), IPC, context keys, the debounced refresh |
| `plugins/budget/src/renderer/BudgetView.tsx`, `StatusGrid.tsx`, `PeriodChooser.tsx` | The view: heading, period, grid with *Due*, keys, bars, empty states, read-only |
| `…/BudgetList.tsx` | The Budgets tab |
| `…/BudgetDialog.tsx` (New Budget and Properties), `LineDialog.tsx`, `TransactionsDialog.tsx` | The dialogs |
| `plugins/budget/public/icons/pie.svg` | The tab's icon |
| `tessera-ui/index.ts`, `tessera-ui/version.ts`, `tessera-ui/package.json` | `LinearProgress`; `@tessera/ui` 1.5 |
| `scripts/sample-archive/household.ts` | The sample ledger gets a *Business* sub-ledger paying the household, and a *Household* budget before it is archived, so transfer lines and archived actuals can be seen by hand |

### Tasks, in order

1. Contributions, commands and context keys, with `budget.show` revealing the view.
2. The view's month and year-to-date modes: grid, *Due*, subtotals, transfer lines, *Other*, *Other transfers* and
   *Uncategorised*, totals, colours, bars.
3. The New Budget and Budget Line dialogs: *For* with categories and transfer accounts, *Due*, the preview from
   `plan.ts`, and *From … on / … only*.
4. The Budgets tab; the last budget remembered per ledger.
5. The Transactions dialog and *Open Register*.
6. Read-only: the view, the tab and the commands on an archive file.
7. README (*What works today*, *Project layout*), `plugin-creation.md` (*Using budgets from another plugin*), `todo.md`.

### Tests

- `tests/plugins/budget/renderer/budgetView.test.tsx`: rows, Remaining's colours by theme token (never literal
  colours; red for expenses over budget, never for income), bars, *Due*, empty states, keys, read-only (no editing
  offered), the period chooser and labels for a fiscal year.
- `tests/plugins/budget/renderer/lineDialog.test.tsx`: parsing amounts, frequencies, due dates and *no particular
  day*, transfer targets, the preview, *From … on* and *… only*, a conflict.
- `tests/plugins/budget/renderer/newBudgetDialog.test.tsx`: scope tree, suggested currency, the *Not counted* note, a
  duplicate name.
- `tests/plugins/budget/pipeline.test.ts`: the built plugins on SQLite: make a budget, add lines, enter transactions
  and a transfer from another sub-ledger through `accounts.service`, the status changes; close and reopen the ledger;
  an archive file shows it read-only.
- `tests/plugins/budget/renderer/editing.test.tsx`: typing in a cell re-renders only the editor, not the rows (a render
  count), so the grid's state never holds what is being typed.
- **Small budgets in renderer tests** (up to 20 lines): a 150-line grid takes 1.25 to 2.0 s to mount in jsdom (B0).
  One test mounts 150, and checks only that it draws. Typing by paste rather than key by key where per-key behaviour
  isn't what is tested ([todo.md](todo.md#testing-and-tooling): slow dialog tests).

**Done when:** the [Definition of done](#definition-of-done) holds, and the sample ledger's budget has been seen in
`npm run dev`: a month, the year to date, a line changed from a month, a bill due on a date, the owner's pay in the
*Household* budget, a transaction entered in the register showing in the view, and the archive file read-only. **Also
by hand, on Windows (B0 couldn't):** scrolling a budget of about 150 lines, and how long the view and the year grid take
to open, in light and dark themes.

### Phase B3 results

Built 2026-11-15: **a budget can be made, planned and followed in the app**. The Budget menu, the budget view (a month,
or the year to date), the Budgets tab, and the New Budget, Budget Line and Transactions dialogs, over the domain B2
built; read-only on an archive file. `npm test` passes: 215 files and 3,135 tests, 60 of them new (7 new files, and
additions to `archive`, `apiPackages`, `tesseraUi` and `sampleArchive`). `npx tsc --noEmit -p plugins` reports
nothing, and `-p tests` the same 28 errors as before. **Not yet seen in `npm run dev`**: Electron can't be installed
here, as in B0. The view and the dialogs were drawn in a headless Chromium instead, in the shell's own theme, light and
dark, from the design's March; the check by hand stays on the list ([todo.md](todo.md)).

| Step | As built | Where |
|---|---|---|
| 1. Contributions, commands, context keys | The *Budget* menu after *Accounts* (`order: 10`); `budget.view` in the main area after the register, `budget.list` in the left bar after the Accounts navigator, both with the `budget.pie` icon; the three dialogs. Eight commands, enabled by `ledger.isOpen`, `!ledger.isReadOnly`, `budget.shown` and `budget.line.selected`; deletes ask first, with the native confirmation | [contributions.ts](../plugins/budget/src/privileged/contributions.ts), [commands.ts](../plugins/budget/src/privileged/commands.ts) |
| 2. What the view shows | `ViewState`: the budget shown, remembered per ledger in `context.state` (never for an archive file, which shares its ledger's id), the month and period the view reports, the line selected; published as context keys and as `budgets.changed`, sent only when it changed | [viewState.ts](../plugins/budget/src/privileged/viewState.ts) |
| 3. Keeping it current | `Refresher`: a budget's or line's change at once, for that budget; actuals changed elsewhere gathered for 250 ms, then one `status.changed { budgetId: null }`. 31 transactions entered at once are one refresh | [refresh.ts](../plugins/budget/src/privileged/refresh.ts) |
| 4. The view | Heading, period chooser (◀ ▶, the month, *Month* or *Year to date*, named for the budget's year), toolbar, grid with *Due*, subtotals that close, *Other* rows that open on what they gather, totals and the net, *Not counted*, empty states, read-only | [BudgetView.tsx](../plugins/budget/src/renderer/BudgetView.tsx), [StatusGrid.tsx](../plugins/budget/src/renderer/StatusGrid.tsx), [PeriodChooser.tsx](../plugins/budget/src/renderer/PeriodChooser.tsx), [gridModel.ts](../plugins/budget/src/renderer/gridModel.ts) |
| 5. The dialogs | New Budget and Budget Properties (one form), Budget Line (new and edit, with the preview), Transactions (with *Open Register*) | [BudgetDialog.tsx](../plugins/budget/src/renderer/BudgetDialog.tsx), [LineDialog.tsx](../plugins/budget/src/renderer/LineDialog.tsx) and [lineForm.ts](../plugins/budget/src/renderer/lineForm.ts), [TransactionsDialog.tsx](../plugins/budget/src/renderer/TransactionsDialog.tsx) |
| 6. The Budgets tab | The budgets with what each covers; a click or the arrows show one; `F2`, `Delete`, `Insert` and the context menu run the commands on it | [BudgetList.tsx](../plugins/budget/src/renderer/BudgetList.tsx) |
| 7. The transactions behind a row | `rowTransactions`, beside the service (not on its contract): each counted account's transactions in the months, kept when the **same classifier the status uses** puts them in the row; payees and labels read from the registers of only the accounts with any; what archived months add, with the last archive date | [BudgetServiceImpl.ts](../plugins/budget/src/privileged/BudgetServiceImpl.ts), [status.ts](../plugins/budget/src/privileged/status.ts) (`classifier`, `rowKeys`) |
| 8. The contract | `@tessera/budget-api` **1.1.0**: commands, context keys, views, dialogs, channels, events, `BUDGET_ICON`, `STATUS_DEBOUNCE_MS`, and the payloads (`BudgetsView`, `RowRef`, `LineDialogInput`, `TransactionsDialogInput`…). `@tessera/ui` **1.5.0**: `LinearProgress`, for the bars | [protocol.ts](../packages/budget-api/protocol.ts), [tessera-ui/index.ts](../tessera-ui/index.ts) |
| 9. The sample ledger | *Personal* and *Business* sub-ledgers; *Business Chequing*, paid by a client and paying its owner each month; home insurance every March; a *Household* budget of 10 lines over *Personal*, with groceries raised from January 2026, made before the archive. 755 transactions archived, from 6 accounts | [household.ts](../scripts/sample-archive/household.ts) |

**What the tests prove** (`tests/plugins/budget/` and its `renderer/` folder):

| Claim | Proved by |
|---|---|
| **The design's March, drawn**: every row in order, *Due* ("5, 19" for the pay, "15" for the insurance, nothing for groceries), a dash for Other's budget, the subtotals, the net ahead, *Not counted*; the status worked out by the plugin's own `budgetStatus` | `budgetView.test.tsx` |
| **Remaining is red exactly for bad news**, in the theme's `error.main`, light and dark: expense rows and their total over budget, the net behind the plan; never income, where it means more came in than planned. Amber from 90 %, red over, with the bar and its share | `budgetView.test.tsx` |
| **The keys**: the arrows move the selection and focus, `←` `→` close a subtotal or open Other, `Enter` edits or adds a line for the row, `Delete`, `Insert`, `Ctrl+Enter`, `Page Up`, `Page Down`, `Shift+F10`; every command runs after the view's report has arrived, so it acts on what the user sees | `budgetView.test.tsx` |
| **The period**: a month, and the year to date of a year starting in April ("Year to date, April 2026 to March 2027"), with no *Due* column | `budgetView.test.tsx` |
| **Moving the selection redraws two rows**, not the grid; **150 lines draw** with no windowing | `editing.test.tsx` |
| **The Budget Line dialog**: amounts parsed in the budget's currency; a fortnightly pay three times in April; a yearly bill due on the 15th; *No particular day*; transfer targets; a new category, income or spending; *From … on*, *… only*, a later change kept or replaced; notes alone; a conflict reloaded, keeping what was typed | `lineDialog.test.tsx` |
| **The New Budget dialog**: *Covers* from the tree, the currency its accounts use (and kept once chosen), *Not counted*, a name taken; Properties says a new scope changes the actuals | `newBudgetDialog.test.tsx` |
| **The transactions behind every row add up to its actual**, less what the archive holds, before and after an archive, for three budgets and two years of a random ledger | `archive.test.ts` |
| The menu, views, icon and dialogs valid; every command's enablement; the budget shown remembered per ledger and not for an archive file; deletes confirmed; the channels' results; one refresh for a burst; the Covers label following a rename; the Budgets tab and the Transactions dialog | `views.test.ts`, `budgetList.test.tsx` |
| **The built plugins on SQLite**: a budget and its lines made through the channels, the owner's pay and groceries entered through `accounts.service`, one `status.changed`, the same figures after a restart, and an archive file read-only and unchanged | `pipeline.test.ts` |
| **The sample archive with the budget plugin active**: 2025's budget the same in the archive file and in the archived ledger, now mostly from the archived months, and nothing logged | `tests/plugins/ledger/sampleArchive.test.ts` |

**Decided while building** (the design left room; each easy to change):

- **Channels follow the commands.** A delete is a command (it asks first), so there is no `line.delete` channel. The
  transactions behind a row, and what a new line can be for, are worked out by the command and passed to the dialog as
  its input, so there are no `transactions` or `targets` channels. `line.change` takes the plan and the notes together
  (each write checked against the revision the last left), and `line` reloads a line after a conflict. There is no
  `show` event: `budgets.changed` carries the budget shown. [IPC and events](#ipc-and-events) is updated.
- **A new line starts with *No particular day*** (the date field then asks for the month it is first due). Most lines
  are groceries and fuel; a bill's day is one click away, and weekly and fortnightly plans turn it off themselves.
- **The preview names the days only** ("Mar 1,200.00 (due 15)"), as the *Due* column does, the month being its own.
- ***… only* is offered for an amount only**: a single month can't have its own frequency or due date, so the choice is
  disabled when those change. A later plan stays unless *Replace the later change, from June 2027* is ticked.
- ***Create category “…”* is two choices**, *Create expense category* and *Create income category*, rather than a
  question after it.
- **New Budget covers** the sub-ledger selected in the Accounts navigator, if one is, else the whole ledger; its year
  start is the Archiving page's (since reports' R1, the ledger's year start month).
- ***Show lines with nothing this period*** is in the view's *More* menu, for the session, until B5 makes it a setting.
  A subtotal hides only when everything under it is empty.
- **Subtotals closed and *Other* rows opened are remembered per budget while the app runs**, not across runs.
- **The month is the view's**, reported with each change; a ledger opened starts on the current month, *Month*.
- **Page Up and Page Down** step the month from anywhere in the view but a field or a menu.
- **`Enter` on a subtotal adds its category's own line** ("Food (other)"), and on an entry under *Other* a line for
  that category or account; on *Other* itself, *New Line…*.


---

## Phase B4: the year, single months, history and copies (M)

**Goal:** Money's advanced budget and a quick start.

### Files

| File | What |
|---|---|
| `plugins/budget/src/renderer/YearGrid.tsx` | The *Year* mode: twelve months and a total, *Budget* / *Actual* / *Remaining*, single-month amounts typed in cells, *Use the plan* |
| `…/HistoryDialog.tsx` | Fill from History |
| `…/privileged/commands.ts` | `budget.fillFromHistory`, `budget.duplicate` |

### Tasks, in order

1. The year grid, reading `status(…, { byMonth: true })` once for the year.
2. Overrides from the grid, marked, and removed with *Use the plan*.
3. Fill from History, from New Budget's *Amounts from my last 12 months* and from the menu.
4. Duplicate Budget….

### Tests

- `tests/plugins/budget/renderer/yearGrid.test.tsx`: typing a month sets an override and only that month changes;
  *Use the plan*; totals; keys.
- `tests/plugins/budget/renderer/historyDialog.test.tsx`: the list, ticking, changing a frequency or due date, *Fill*.
- The year grid's mount time with 150 rows within B0's finding.

**Done when:** the [Definition of done](#definition-of-done) holds, and the sample household's budget has been filled
from its history by hand.

### Phase B4 results

Built 2026-11-15: **the Year, months of their own, Fill from History and Duplicate Budget…**, over the view and dialogs
B3 built. `npm test`: 217 files and 3,161 tests, 26 of them new (2 new files, and additions to `views`, `editing`,
`status`, `suggest`, `budgetList`, `pipeline`, `apiPackages` and `sampleArchive`). This machine was busy with other
work, and each of five full runs had a few time-outs in dialog tests, or the SQLite snapshot test, known in
[todo.md](todo.md#testing-and-tooling), a different few each time, each passing alone. Two were the budget's (a Year
test, and one in Fill from History typing a date key by key), since made lighter: split in two, and pasted. B1's scale test of the archive's totals, which the same load failed, now measures the main thread's
CPU time ([B1 results](#phase-b1-results)). `npx tsc --noEmit -p plugins` reports nothing, and `-p tests` the same 28
errors as before. **Not yet done by hand** in `npm run dev`, nor the sample household's budget filled from its history there:
Electron can't be installed here. The Year and the dialogs were drawn in a headless Chromium instead, in the shell's
theme, light and dark, and the sample archive's test fills its budget from history over the archive date
([todo.md](todo.md)).

| Step | As built | Where |
|---|---|---|
| 1. The year grid | *Year* in the period chooser: the budget year, read with one `status(…, { byMonth: true })`; twelve months and a total, one figure a cell, *Budget*, *Actual* or *Remaining* (red for bad news, as in the month); ◀ ▶, `Page Up` and `Page Down` step a year; the rows' names stay in view as the months scroll sideways | [YearGrid.tsx](../plugins/budget/src/renderer/YearGrid.tsx), [BudgetView.tsx](../plugins/budget/src/renderer/BudgetView.tsx), [PeriodChooser.tsx](../plugins/budget/src/renderer/PeriodChooser.tsx) |
| 2. Months of their own | Typed in a line's month in *Budget*: the editor keeps what is typed in its own state, and Enter, Tab or leaving the cell saves it through `line.change` as `{ apply: 'only' }`; marked with a dot (`StatusRow.ownMonths`). *Use the plan*: `Delete` on the month, an emptied cell, the toolbar's *Use the Plan*, or the cell's menu | [YearGrid.tsx](../plugins/budget/src/renderer/YearGrid.tsx) |
| 3. Each month's totals | `BudgetStatus.monthlyTotals`, worked out by the plugin from the same rows as the totals, so the grid adds nothing up itself | [status.ts](../plugins/budget/src/privileged/status.ts) |
| 4. Fill from History | *Budget › Fill from History…*, the view's toolbar and its no-lines notice, and New Budget's *Amounts from my last 12 months*: the suggestions for the months before the month shown, over 12 months rounded to 10.00 (until B5's settings); months, step and start can be changed; each row's amount, frequency and due date; a line the budget has is unticked, beside its plan (`LineSuggestion.existingPlan`); *Fill* all or none, a problem shown on the row it names | [HistoryDialog.tsx](../plugins/budget/src/renderer/HistoryDialog.tsx), [commands.ts](../plugins/budget/src/privileged/commands.ts), [BudgetDialog.tsx](../plugins/budget/src/renderer/BudgetDialog.tsx) |
| 5. Duplicate Budget… | The menu and the view's *More* menu: a dialog for the copy's name, suggesting one not taken ("Household (2)"); the copy is shown | [DuplicateDialog.tsx](../plugins/budget/src/renderer/DuplicateDialog.tsx), [commands.ts](../plugins/budget/src/privileged/commands.ts) |
| 6. The contract | `@tessera/budget-api` **1.2.0**: `budget.duplicate` and `budget.fillFromHistory`, their dialogs, the `suggest`, `fill` and `budget.duplicate` channels, `StatusRequest.byMonth`, `StatusRow.ownMonths`, `BudgetStatus.monthlyTotals`, `LineSuggestion.existingPlan`, `DEFAULT_HISTORY_MONTHS`, `DEFAULT_ROUND_TO`, `ROUND_TO_CHOICES` | [protocol.ts](../packages/budget-api/protocol.ts), [model.ts](../packages/budget-api/model.ts) |

**What the tests prove**:

| Claim | Proved by |
|---|---|
| **Typing a month sets an override, and only that month changes**: the request, then every other month and the total as before, March's new amount marked | `yearGrid.test.tsx` |
| ***Use the plan*** from `Delete`, an emptied cell, the toolbar and the cell's menu; `Delete` on a month of the plan deletes nothing | `yearGrid.test.tsx` |
| **The figures and totals**: twelve months and a total of each line; each month's total income, expenses and net; *Actual* and *Remaining*, red in the theme's error colour for bad news only; a month's own amount marked in *Budget* only | `yearGrid.test.tsx` |
| **The keys**: arrows by cell, `Home` and `End`, `Enter` and `F2` into a month or the line's dialog, `Tab` and `Escape` while typing, `Ctrl+Enter` for a month's or the year's transactions, `←` `→` on a parent's name, `Page Up` and `Page Down` by year; nothing typed in on a ledger open read-only; a problem with what was typed shown, and nothing saved | `yearGrid.test.tsx` |
| **Typing redraws the editor, not the rows**: five keys, five editor renders, no row | `yearGrid.test.tsx` |
| **Each month's totals add up to the period's**, for three budgets on 12 random ledgers; the months with their own amount are named | `status.test.ts` |
| **Fill from History**: the list, ticked unless there is a line (and the line's plan beside it), its range, other months and steps; a changed amount, a fortnightly pay given its date, a line it has planned from the month chosen; a problem on its row; nothing to suggest. Through the channels, a budget filled and a duplicate line refused, all or none | `historyDialog.test.tsx`, `views.test.ts` |
| **From New Budget straight into Fill from History**, for the budget just made | `views.test.ts`, `historyDialog.test.tsx` |
| **Duplicate Budget…**: a name not taken suggested, one taken shown on the field, the copy with every plan and month's own amount, shown | `views.test.ts`, `historyDialog.test.tsx` |
| **The built plugins on SQLite**: the year month by month with a month of its own, history suggested and filled as plans from April, and a copy whose rows are the original's | `pipeline.test.ts` |
| **The sample household's budget filled from its history** across the archive date: the pay 4,900.00 a month, the owner's pay 1,200.00, the insurance yearly in March; the archived half counts as the kept half does | `tests/plugins/ledger/sampleArchive.test.ts` |
| A budget of 150 lines draws in the Year, 2,352 cells | `editing.test.tsx` |

**Measured:** the Year of 150 lines in a headless Chromium, React's production build, from nothing to the grid in the
page: **0.77 to 0.95 s** (median 0.84, of which 26 to 64 ms is working out the status, here in the page), painted by
0.85 to 1.44 s; with the CPU slowed 4×, 1.3 to 2.9 s. B0 measured 0.70 s for its year grid alone (0.55 s once
`formatAmount` kept its formatters); these include the whole view and the Budgets tab, and are within this VM's spread
(B0 saw 470 to 1,052 ms for the month view). So **the Year draws in about B0's time**, with nothing windowed. Whether
that is quick enough on a slow machine is for the check by hand on Windows; if not, the rows below the fold are drawn
after the first paint, as B0 proposed.

**Decided while building** (each easy to change):

- **`Delete` in the Year works on the cell**, as in a spreadsheet: on a month with its own amount it uses the plan
  again; on a month of the plan it does nothing; on the row's name it deletes the line, after the confirmation. In the
  Month, `Delete` still deletes the line.
- **Typing the plan's own amount into a month with none of its own saves nothing**, so a stray Enter adds no override.
  An emptied cell is *Use the plan*.
- **A month's own amount is saved without `expectedRev`**: the last one typed wins. A cell is one number, and the
  Budget Line dialog, which changes plans, still checks the line's revision.
- **Selecting a cell makes its month the month shown**: a new line starts from it, and the Month opens on it.
- ***Other* rows don't open in the Year**: what they gather is a total for the period, not month by month.
- **Each month's totals come from the plugin** (`monthlyTotals`), rather than being added up in the view, so the view
  and a report can't disagree, as [B-19](#decisions) wants of the plans.
- **Fill from History's rows can be changed before filling**: the amount, how often, and a due date (empty for no
  particular day; a yearly suggestion then stays in the month it was seen). A tick-all box heads the list. The step
  is chosen in whole units of the currency (1.00 to 100.00), and up to 24 months are looked at.
- **Duplicate Budget… is a dialog of its own**, not the native prompt: a name taken is shown on its field, as every
  other dialog does, and the dialog stays.
- **New Budget's *Start with*** shows the new budget, then opens Fill from History for it; cancelling leaves the
  budget with no lines.


---

## Phase B5: the Budget page, warnings and `budget.service` for others (S)

**Goal:** preferences, a gentle warning, and a service other plugins can build on.

### Files

| File | What |
|---|---|
| `plugins/budget/src/privileged/settings.ts` | The `budget` namespace and the [Budget page](#the-budget-page), with *Warn at* |
| `…/contributions.ts` | A `shell.bar.items` text item, `{budget.statusText}`, `when: budget.statusText`, which runs `budget.show` |
| `…/BudgetServiceImpl.ts` | `onDidChange` with `actuals`, documented for other plugins |
| `docs/plugin-creation.md` | *Using budgets from another plugin*: `status()` for a month, `dueDates`, and following `onDidChange` |

### Tasks, in order

1. The settings and the page; the view follows them as they change, *Warn at* included.
2. `budget.statusText` for the current month of the shown budget, and the status item.
3. The service's events, and the guide's section.

### Tests

- `tests/plugins/budget/settings.test.ts`: validation (the ranges), defaults, changes followed.
- `tests/plugins/budget/status.test.ts` (added to): warnings at the *Warn at* share, at another share, and over.
- `tests/plugins/budget/contributions.test.ts`: the status item appears and disappears with `budget.statusText`, worded
  for one line and for several.

**Done when:** the [Definition of done](#definition-of-done) holds.

### Phase B5 results

Built 2026-11-15: **the Budget page, a warning in the status bar, and `budget.service` for other plugins**. `npm
test` passes: 220 files and 3,176 tests, 15 of them new (3 new files, and additions to `budgetView`, `views` and
`apiPackages`), in one clean run. `npx tsc --noEmit -p plugins` reports nothing, and `-p tests` the same 28 errors as
before. **Not yet seen in `npm run dev`** (the Options dialog, the status bar), for the reason the earlier phases give
([todo.md](todo.md)).

| Step | As built | Where |
|---|---|---|
| 1. The Budget page | Tools › Options… › **Budget**, a page the shell draws, in the `budget` namespace: *Warn at* (50 to 100 %), *Show a bar beside each line*, *Show lines with nothing in the period*, *Show lines over budget in the status bar*, *Fill from History looks at* (3 to 24 months), *Fill from History rounds to* (1, 5, 10, 50 or 100); checked again when saved, with a message for each value out of range | [settings.ts](../plugins/budget/src/privileged/settings.ts) |
| 2. Followed as they change | *Warn at*: every view's status reloads at once, and `budget.service` warns at it (`BudgetServiceDeps.warnAtPercent`). Bars and empty lines: sent with the budgets (`BudgetsView.options`), and changed from the view's *More* menu through `view.options`, as the page would; *Budget Options…* opens the page. Fill from History opens on the page's months and step | [index.ts](../plugins/budget/src/privileged/index.ts), [refresh.ts](../plugins/budget/src/privileged/refresh.ts), [BudgetView.tsx](../plugins/budget/src/renderer/BudgetView.tsx), [StatusGrid.tsx](../plugins/budget/src/renderer/StatusGrid.tsx), [commands.ts](../plugins/budget/src/privileged/commands.ts) |
| 3. The status bar's warning | `budget.statusText` ("Budget: 1 line over", "Budget: 2 lines over") and `budget.statusDetail` (which, and by how much, the worst first), for the current month of the budget shown, worked out after every refresh, whenever another budget is shown, and when the page changes; a `shell.bar.items` text item showing them, which runs `budget.show` | [statusBar.ts](../plugins/budget/src/privileged/statusBar.ts), [contributions.ts](../plugins/budget/src/privileged/contributions.ts) |
| 4. `budget.service` for others | Its events documented: one a write, and `actuals` when the ledger changed; a month's status, `dueDates`, the settings to read, `budget.show`; the guide's example follows changes after `STATUS_DEBOUNCE_MS` | [plugin-creation.md](plugin-creation.md#using-budgets-from-another-plugin), [service.ts](../packages/budget-api/service.ts) |
| 5. The contract | `@tessera/budget-api` **1.3.0**: `BUDGET_SETTINGS_ID`, `BUDGET_SETTINGS_PAGE`, `BudgetSettings` and `BUDGET_SETTINGS_DEFAULTS` (the B3 and B4 constants as their defaults), `WARN_AT_PERCENT_MIN`, `HISTORY_MONTHS_MIN`, the two context keys, `ViewOptions` and the `view.options` channel | [protocol.ts](../packages/budget-api/protocol.ts) |

**What the tests prove**:

| Claim | Proved by |
|---|---|
| **The page**: every setting the design lists, of the kind it says, at its default; values out of range refused with the page's words (and the shell's, for a checkbox) | `settings.test.ts` |
| **Changes followed**: a new *Warn at* warns at once in the view's status, and in `budget.service`'s unless the caller gives a share, the views told; bars and empty lines sent to the view, and changed from it; Fill from History on the page's months and step | `settings.test.ts` |
| **The view draws by them**: no bars, empty lines shown; the *More* menu's ticks change the page's settings, and *Budget Options…* opens it | `budgetView.test.tsx` |
| **Warnings at *Warn at*, at another share, and over** | `status.test.ts` (B2's, unchanged), `settings.test.ts` |
| **The status item** is one the shell accepts, present exactly while `budget.statusText` is set, and shows the budget; worded for one line and for several, the worst first; expense lines only (more income is good news), this month only, a line near its budget not counted; gone once nothing is over, when the page turns it off, when another budget or no ledger is shown | `contributions.test.ts` |
| **Another plugin** requiring `budget.service` reads a month's status and due days, agrees with `plannedAmount` and `dueDates`, hears each write and `actuals`, stops hearing once it disposes, reads (and can't change) the Budget page, and shows a budget | `forOthers.test.ts` |

**Decided while building** (each easy to change):

- **`budget.service` warns at the user's *Warn at* by default**, rather than at a fixed 90 %: a widget or a report then
  agrees with the view without reading the setting. A caller can still pass `warnAtPercent`.
- **The view's *More* menu changes the page's settings** rather than the view's own: *Show lines with nothing this
  period* and *Show bars* are remembered, as the page shows them. *Budget Options…* opens the page.
- **A second context key, `budget.statusDetail`**, for the status item's tooltip: which lines are over, and by how much.
- **The warning is worked out for the budget shown, even while the view is hidden**: one month's status, after the
  same debounced refresh as the view's. It is what the status bar is for.
- **The status item sits at the end of the status bar** (`align: 'end'`), away from the ledger's items, with the
  standard *Warning* icon.


### Review after B5

A review of B1 to B5 on 2026-11-15: the code read again, and every suspected bug reproduced with a throwaway test
before it was called one. Each fix has a regression test, and **each of those tests was checked to fail with its bug put
back** (15 in all, by script). `npm test` passes: 220 files and 3,195 tests, 19 of them new. `npx tsc --noEmit -p
plugins` reports nothing, and `-p tests` the same 28 errors as before. `useShown` was also checked in a headless
Chromium, the view in a section hidden as the shell hides it: one read for a change while shown, none for three while
hidden, one when shown again.

**Bugs found and fixed:**

| Bug | Fix | Proved by |
|---|---|---|
| **The Budget Line dialog's save could half-happen.** `line.change` wrote the plan, then the notes, in two writes: notes refused (a control character pasted in) left the plan changed with the dialog saying nothing was saved, and saving again was a `CONFLICT` | `BudgetServiceImpl.editLine` checks both, then writes both in one storage transaction, against one revision, with one event; `changeLine` and `setLineNotes` are it, one part at a time | `service.test.ts`, `views.test.ts` |
| **The Year stopped answering** when the month being typed in went (its line deleted elsewhere, its parent closed): it went on waiting for an editor no longer drawn, so clicks selected nothing and keys did nothing | Editing ends whenever its cell can no longer be typed in | `yearGrid.test.tsx` |
| **Shares one point low**: the bar's percentage was worked out in floating point, so 29 of 100 showed 28 %, disagreeing with the exact warnings | Integer division (BigInt past the safe integers); checked against BigInt for 20,000 shares | `budgetView.test.tsx` |
| **`Delete` in the Year said nothing when *Use the plan* failed** | One *Use the plan* in the view, for `Delete`, the toolbar and the menu, each showing a failure | `yearGrid.test.tsx` |
| **A sub-ledger delete that rolled back** left the budgets it would have moved to be announced at the next, unrelated, tree change | Moved budgets are kept by the sub-ledger deleted, and announced only once it is gone from the tree: the ledger says nothing of a rollback, but the tree shows whether the delete was committed | `subLedgers.test.ts` |
| **A hidden budget view went on reading its status** after every change: the shell keeps a main view mounted once shown, so the design's "only while shown" wasn't so | The view watches whether it is on screen (`useShown`, an `IntersectionObserver`); hidden, a change marks the status stale, read once when shown again | `budgetView.test.tsx` |

**What a change to a budget could do unseen:**

- **A currency with other decimals changed every plan's value**: amounts are kept in minor units, so 650.00 CAD would
  have become ¥65,000, and converting them would need rounding, which budgets never do. The service now refuses that
  change while the budget has lines, saying why; Budget Properties says so on the currency before *Save*
  (`BudgetDialogInput.lineCount`). The same decimals (CAD to USD) stay allowed.
- **A new scope or currency could leave transfer lines counting nothing** (an account now inside the budget, or in
  another currency). Budget Properties names them before *Save* (`BudgetDialogInput.transferLines`); they aren't
  refused, as the scope may be what the user wants.
- **A line planned at 0 and spent on** was red but never *over*, so the status bar didn't count it. Spending past a
  budget is now over it, a budget of 0 included (`StatusRow.warning`).

**Other fixes:** the view's list of budgets is no longer a failure when the ledger closes as it is read (the ledger's
`NO_LEDGER` is recognised, not only the budget's); the status bar's warning moves on to a new month with the app left
open over the end of one (checked each minute); Fill from History keeps what the user changed when it asks again for
other months, a step or a start; the Budgets tab's *Properties…*, *Duplicate…* and *Delete…* no longer show the budget
first, so cancelling leaves the view as it was; the budget shown last is remembered for the 50 ledgers used last, not
for ever.

**Code smells dealt with:**

| Smell | Now |
|---|---|
| The service held what only the plugin's views need (`describeLine`, `targets`, `rowTransactions`) | In [viewSupport.ts](../plugins/budget/src/privileged/viewSupport.ts), over the service and `accounts.service`; the service keeps the rules. `gather` and `scope` are the service's, for it |
| **The same change made three ways**: the service's `changeLine`, its `fill`, and the Budget Line dialog's preview | One: `applyPlanChange` in `@tessera/budget-api`'s `plan.ts`, as [B-19](#decisions) wants of the planning arithmetic |
| The currency most accounts use, written **four times** (accounts, import, budget's command and dialog) | `mostUsedCurrency` in `@tessera/accounts-api` **1.14** |
| Render counters for tests in the shipped views | Counted only outside production builds; the plugin's build leaves them out (checked in the built bundle) |
| Tests waiting a guessed 40 to 60 ms for refreshes, which load had broken | They wait for the plugin to be idle (`ActivateOptions.onActivated`, `Refresher.idle`, which waits out the debounce too) |
| A leftover file-wide `vi.setConfig` in `views.test.ts` | Gone |
| Refs written while rendering (`useEvent`, the grids' stable callbacks) | `useLatest`: updated after each commit, as React asks |
| Rows with `aria-level` and `aria-expanded` in a plain table | Both grids are `treegrid`s, where those, and a selected cell, mean what they say |
| Declared after their first use (`LABELS` in settings, `budgetYearOf` in the view); a bare `100` for names; `update` copying any key a patch had | Declared first; `LEDGER_NAME_MAX_LENGTH`; only a budget's own fields |

**Left as they are, on purpose:**

- **The Transactions dialog reads each matching account's register** for payees and labels. Only accounts with
  transactions in the row are read, it is one dialog the user opens, and a payee lookup by id would add to the accounts
  contract for this alone. Worth doing if a report needs payee names too.
- **A month's own amount typed in the Year is saved without `expectedRev`** (B4's decision): a cell is one number.
- **The pipeline test's pauses stay**: it loads the built plugin through the plugin manager, so it can't use
  `onActivated`; its 350 ms waits are well past the 250 ms debounce.
- **The view's own month doesn't follow the calendar** when a month ends: it is the month the user is looking at, as
  in Money. Only the status bar's *this month* moves on.

**Contracts:** `@tessera/budget-api` **1.4.0** (`applyPlanChange`; `BudgetDialogInput.lineCount` and
`transferLines`; `warning` for a budget of 0); `@tessera/accounts-api` **1.14.0** (`mostUsedCurrency`). Both are
additions.


---

## Phase B6: the home view widget (S)

**Goal:** the budget on the home view (review, Q7). **Starts once the accounts home view takes widgets from other
plugins**; the home view's design is its own note.

### Files

| File | What |
|---|---|
| `plugins/budget/src/renderer/HomeWidget.tsx` | [The widget](#on-the-home-view): the current month's income, expenses and remaining, lines over, *Open Budget* |
| `plugins/budget/manifest.json` | Exposes `./HomeWidget` |
| `…/privileged/contributions.ts` | The widget's contribution to the home view's extension point, `when: budget.hasBudgets` |

### Tasks, in order

1. Check the home view's widget contract against [On the home view](#on-the-home-view), and amend this note where they
   differ.
2. The widget, loading through `status` for one month and following `status.changed`.
3. README and `todo.md`.

### Tests

- `tests/plugins/budget/renderer/homeWidget.test.tsx`: figures, the lines over (worst first, at most three),
  *Open Budget*, an empty budget, read-only.
- The home view's own pipeline test, with the budget's widget contributed.

**Done when:** the [Definition of done](#definition-of-done) holds, and the widget has been seen on the home view in
light and dark themes.

---

## Later

Each scheduled on its own, when wanted.

| Item | Notes |
|---|---|
| ~~**A *Planning* menu** (Q13)~~ | Answered by reports' review (Q1): reports have a top-level *Reports* menu, and *Budget* stays as it is |
| **Where spending would be by today** (Q14) | A mark on each bar for the share of the month gone, or, using due dates, what should have been paid by now. A future consideration beside the whole-month comparison, which stays |
| **Excluding accounts** from a scope (Q9) | `excludeAccountIds` on a budget |
| **Several currencies** in one budget (Q6) | Needs exchange rates, a feature of its own |
| **Envelope budgets** (Q1) | A note of its own |
| **Category deletes and merges** (Q8) | With the category manager: what `accounts` reports, and what happens to lines |
| **Importing budgets** from Money and Quicken (Q11) | A `format-qif` addition (`!Type:Budget`), through `budget.service` |
| **Matching payments to due dates** | So a bill paid a day late still counts in the month it was due |
| **Bill reminders and scheduled transactions** | From the due dates |
| **Hints in the register** | What remains in a category, as it is chosen; needs an extension point in the register's category field |
| **Exporting a budget** to CSV | The year grid as a spreadsheet |
| **Rebuilding archived actuals** from archive files | For a ledger archived while `budget` was disabled |
| **Smaller archived months** | Interning the category and account ids in a small dictionary document halves them; packing by sub-ledger and currency instead of account takes a third off, but loses the account ([B0](#4-removedtotals-and-the-budgets-writes-in-the-archive)) |
| ~~**Reports**~~ | **Done** (reports' R5): *Budget vs Actual*, contributed by this plugin to the reports, on a source of its own over `status` (`budget.status`), with the budget view's figures row for row, by month too; *Show as Report* in the view's *⋯* menu ([reporting-design.md](reporting-design.md#7-budget-vs-actual)) |

---

## Testing

| Kind | Where | What it proves |
|---|---|---|
| Planning arithmetic | `tests/packages/budgetApi.test.ts` | Every frequency and due date on every day against a walk of the calendar (2000–2040 in the suite, 1970–2100 on demand, as B0 ran it), in a time zone with half-hour daylight saving; months add up to the year |
| Totals | `tests/plugins/accounts/transactionTotals.test.ts` | What counts as an actual, defined once, in `accounts` |
| **Archive invariant** | `tests/plugins/accounts/archive.test.ts`, `tests/plugins/budget/archive.test.ts` | Live totals before = live after + removed; no month's actual changes through an archive (held in every B0 run) |
| Speed | `tests/plugins/accounts/totalsScale.test.ts`, `tests/packages/money.test.ts` | A year's totals at 100,000 within 250 ms; `formatAmount` with kept formatters |
| Editing | `tests/plugins/budget/renderer/editing.test.tsx` | Moving the selection redraws two rows, not the grid (B3); typing in a year grid's cell redraws the editor, not the rows (B4) |
| **Every transaction once** | `tests/plugins/budget/status.test.ts` | Each counted transaction is in exactly one row, and rows add up to the totals |
| **Transfers across the scope** | `tests/plugins/budget/transfers.test.ts` | A transfer counts exactly when it crosses the scope, with the right sign on each side |
| Service rules | `tests/plugins/budget/service.test.ts` | Names, lines, plans, conflicts, read-only |
| Participants | `tests/plugins/budget/subLedgers.test.ts`, `archive.test.ts` | Sub-ledger deletes and archives keep budgets whole, all or nothing |
| Views, dialogs and the widget | `tests/plugins/budget/renderer/` | Rows, colours by token, keys, read-only, previews |
| End to end | `tests/plugins/budget/pipeline.test.ts` | The built plugins on SQLite, a real file, a reopen, an archive file |
| Amounts | `tests/architecture/boundaries.test.ts` | No floating point on amounts in the budget's arithmetic |
| By hand | each phase | The sample household's budget in `npm run dev`, light and dark themes, and its archive file |

## Documentation changes

| When | Change |
|---|---|
| Review (done) | This note; `todo.md`: the phases, the *Planning* menu to-do, and the home view's widgets |
| B0 (done) | Results here, and the design amended ([What changes in this note](#what-changes-in-this-note)); `todo.md` |
| B1 (done) | [account-manager-design.md](account-manager-design.md): `transactionTotals` in *`accounts.service` and the transaction manager*. [ledger-compaction-design.md](ledger-compaction-design.md): `removedTotals` in *The participant contract*. [plugin-creation.md](plugin-creation.md): `transactionTotals` in *Using accounts from another plugin*, and the archive example updated from *budget actuals by transaction id* to totals |
| B2 (done) | README: `budget-api` and the `budget` plugin in *Project layout* |
| B3 (done) | README: *Budgets* in *What works today*, the `budget` plugin in *Project layout*, and the status of this note under *Documentation*; `plugin-creation.md`: *Using budgets from another plugin* |
| B4 (done) | README (*Budgets* in *What works today*), `todo.md`, `plugin-creation.md` (`byMonth` and `monthlyTotals`); results here |
| B5 (done) | README (*Budgets* in *What works today*), `todo.md`, `plugin-creation.md` (*Using budgets from another plugin*: a month's status, due dates, following changes, the settings); results here |
| B6 | README and `todo.md`; results here |

## Definition of done

For every phase:
- [ ] `npm test` green, including the architecture boundaries
- [ ] No new errors from `npx tsc --noEmit -p plugins` (and `-p tests` when tests are touched)
- [ ] Every disposable pushed onto `context.subscriptions`
- [ ] The invariants hold: every counted transaction in one row; no month's actual changed by an archive; transfers
      counted exactly when they cross the scope
- [ ] Checked by hand in `npm run dev`, in light and dark themes, including from an archive file opened read-only
      (from B3)
- [ ] The phase's results recorded here, and `todo.md` ticked

## Phases

| Phase | Delivers | Size |
|---|---|---|
| B0 | Spike: the cost of totals at 100,000 transactions, the date arithmetic, the grid's speed, the archive's totals. **Done** ([results](#phase-b0-results)) | S |
| B1 | `accounts.service.transactionTotals` (with transfers) and `AccountsArchived.removedTotals` (`@tessera/accounts-api` 1.13); `formatAmount` keeps its formatters; no visible change. **Done** ([results](#phase-b1-results)) | M |
| B2 | `@tessera/budget-api`, the `budget` plugin's domain (category and transfer lines, due dates), `budget.service`, the sub-ledger and archive participants; no UI. **Done** ([results](#phase-b2-results)) | L |
| B3 | The budget view (month, year to date), the Budget menu, the Budgets tab, New Budget, Budget Line and Transactions dialogs; read-only; `@tessera/ui` 1.5. **Done** ([results](#phase-b3-results)); the check by hand in `npm run dev` is still to do | L |
| B4 | The year grid with single-month amounts, Fill from History, Duplicate Budget…. **Done** ([results](#phase-b4-results)); the checks by hand in `npm run dev` are still to do | M |
| B5 | The Budget page (*Warn at*), warnings in the status bar, `budget.service` events for other plugins. **Done** ([results](#phase-b5-results)); the check by hand in `npm run dev` is still to do | S |
| B6 | The home view widget, once the home view takes widgets | S |
| Later | A *Planning* menu, where spending would be by today, excluded accounts, several currencies, envelope budgets, category merges, importing budgets, and more ([Later](#later)) | — |
