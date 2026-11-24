# Design and implementation: reports

| | |
|---|---|
| **Status** | **Proposed 2026-11-16, and reviewed the same day.** Q1 to Q10 are answered, and the answers are applied throughout ([Decisions taken in review](#decisions-taken-in-review)). Review changed two things: **the year start belongs to the ledger** (Q9), so the ledger keeps it and *File › Ledger Properties…* sets it, for reports, archiving and new budgets alike; and **Cash Flow's everyday accounts leave cash out** (Q6). Review also asked for **reporting by sub-ledger**, for a household and a small business in one ledger ([Reporting by sub-ledger](#reporting-by-sub-ledger)), and whether keeping MUI behind `@tessera/ui` limits plugins ([Reports and `@tessera/ui`](#reports-and-tesseraui)). **Phase R0 (spike) done** 2026-11-16 ([results](#phase-r0-results)); its question 4, whether MUI X Charts fits, was left to be determined, and **R3 answered it: it fits**. R0 found: totals by payee, balance history and the engine are fast enough; archived months are packed **flat against a dictionary of ids**, which makes payees nearly free; an archive must **keep a record of the accounts it removes**; `transactionTotals` gets **a faster sort**; printing needs the **print stylesheet**; the table is **drawn in chunks**, with a limit on cells; and the chart palette is Tessera's, per mode. The design is amended where the spike found it wrong ([what changed](#what-changes-in-this-note)). **Phase R1 (the ledger and accounts additions) built** 2026-11-16 ([results](#phase-r1-results)): `@tessera/accounts-api` 1.15 and `@tessera/ledger-api` 1.5, with *File › Ledger Properties…*; its renderer and pipeline tests pass (run in R3, the first phase with the dependencies installed); a look in `npm run dev` is still to take. **Phase R2 (the report domain, with no UI) built** 2026-11-16 ([results](#phase-r2-results)): `@tessera/reports-api` 1.0, the `reports` plugin with its two sources, seven definitions, sub-ledgers side by side and saved reports; every example figure in this note is produced by a test, and no report changes through an archive; its pipeline test passes (run in R3). The spike's code was deleted at R2's start. **Phase R3 (the report view, the Reports tab and menu, and charts) built** 2026-11-17 ([results](#phase-r3-results)): `@tessera/ui` 1.6 with **`@tessera/ui/charts`**, drawn by MUI X Charts and loaded on first use; the chart palette in themes; `@tessera/reports-api` 1.1; the Reports tab, the report view and its parameters, *Show Transactions* (every listed figure adds up to its figure), the Reports menu mirrored from the definitions; kept current. Tested in jsdom and, **new, in headless Chromium** (skipped where there is none); not yet seen in `npm run dev`, whose Electron wasn't downloaded. **Phase R4 (customising and saving reports) built** 2026-11-17 ([results](#phase-r4-results)): *Customise Report…*, saved reports (Save, Save As, Rename, Duplicate, Delete, refused over a change made elsewhere), the Reports page, and each report's last choices remembered per ledger; `@tessera/reports-api` 1.2. **Phase R5 (Budget vs Actual, from the budget plugin) built** 2026-11-17 ([results](#phase-r5-results)): the first report another plugin adds, with the budget view's figures row for row; `@tessera/reports-api` 1.3, `@tessera/budget-api` 1.5. **Phase R6 (printing, PDF and CSV) built** 2026-11-17 ([results](#phase-r6-results)): `shell.print` and `shell.files.writeFile`; `@tessera/ui` 1.7 with **`PrintArea`** and the shell's print stylesheet; *Print Report…*, *Save Report as PDF…* and *Export Report…*; `@tessera/reports-api` 1.4. A report prints in light colours from a dark window, every row, portrait or landscape as its width needs, pages numbered; printed to PDF in headless Chromium in its tests, not yet through Electron's print dialog. **Every phase is built;** what is left is each phase's look in `npm run dev`, and printing on Windows ([todo.md](todo.md)). [Open questions](#open-questions): none; nothing [to be determined](#to-be-determined) |
| **Date** | 2026-11-16 |
| **Scope** | An **extensible reporting framework**: a `reports` plugin (the *report manager*) with its contract **`@tessera/reports-api`**, two extension points through which any plugin adds **data sources** and **report definitions**, a Reports tab, a report view, a Reports menu, saved reports, printing and CSV. In scope for the first release, eight reports: **Income vs Expenses**, **Spending by Category**, **Spending by Payee**, **Net Worth**, **Account Balances**, **Cash Flow**, **Budget vs Actual** and **Category Trends**. Designed so that a **report designer** (users building reports of their own) can be added later without changing the contract |
| **Builds on** | [account-manager-design.md](account-manager-design.md) (accounts, categories, transfers, voids, sub-ledgers, `accounts.service`), [budget-design.md](budget-design.md) (`transactionTotals`, what counts as an actual, transfers across a scope, `budget.service`), [ledger-compaction-design.md](ledger-compaction-design.md) (archives and `removedTotals`), [export-design.md](export-design.md) (a manager that knows no format, options declared as data), [layout-controller-design.md](layout-controller-design.md), [settings-design.md](settings-design.md), [theming-design.md](theming-design.md), [plugin-creation.md](plugin-creation.md) |
| **Changes to other notes** | [account-manager-design.md](account-manager-design.md): `accounts.service` gains **totals by payee**, **payees by id**, **balances at past dates**, and **keeps the totals of what archives removed** itself ([The accounts additions](#the-accounts-additions)); the ledger keeps **its year start**, set in *File › Ledger Properties…* ([The ledger's year start](#the-ledgers-year-start)). [budget-design.md](budget-design.md): the budget plugin contributes the *Budget vs Actual* report ([Budget vs Actual](#7-budget-vs-actual)); its *Planning* menu to-do is answered by [Q1](#open-questions). [ledger-compaction-design.md](ledger-compaction-design.md): its "reports across archives" non-goal stays one; archived months are reported from kept totals; the Archiving page's year start moves into the ledger, and its *The year start per ledger* item under Later is done by this note. [budget-design.md](budget-design.md): New Budget suggests the ledger's year start. [theming-design.md](theming-design.md): `@tessera/ui` gains charts and a chart palette. All are additions; nothing existing changes meaning |
| **Layout** | [Part 1](#part-1-design) is the design (*what and why*). [Part 2](#part-2-implementation-plan) is the phased plan (*how and in what order*). Phases are numbered **R0 to R6** (R for *reports*), so they aren't confused with the budget's B0 to B6 or the export's X0 to X4. The report designer is a later note of its own, outlined under [Designing for the report designer](#designing-for-the-report-designer) |

- [Summary](#summary)
- [Naming](#naming)
- [Context](#context)
- [Why people run reports](#why-people-run-reports)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- **Part 1: Design**
  - [Architecture](#architecture)
  - [The model: sources, definitions, results](#the-model-sources-definitions-results)
  - [What counts: the flows source](#what-counts-the-flows-source)
  - [How things stood: the balances source](#how-things-stood-the-balances-source)
  - [Scope and currency](#scope-and-currency)
  - [Reporting by sub-ledger](#reporting-by-sub-ledger)
  - [Periods](#periods)
  - [The ledger's year start](#the-ledgers-year-start)
  - [Report definitions](#report-definitions)
  - [The engine](#the-engine)
  - [The eight reports](#the-eight-reports)
  - [Archived months](#archived-months)
  - [The accounts additions](#the-accounts-additions)
  - [Adding a report from another plugin](#adding-a-report-from-another-plugin)
  - [The Reports tab and the report view](#the-reports-tab-and-the-report-view)
  - [The transactions behind a figure](#the-transactions-behind-a-figure)
  - [Customising and saving reports](#customising-and-saving-reports)
  - [The Reports menu, commands and context keys](#the-reports-menu-commands-and-context-keys)
  - [The contract: `@tessera/reports-api`](#the-contract-tesserareports-api)
  - [Storage schema (`reports`)](#storage-schema-reports)
  - [IPC and events](#ipc-and-events)
  - [Keeping reports current](#keeping-reports-current)
  - [Charts](#charts)
  - [Reports and `@tessera/ui`](#reports-and-tesseraui)
  - [Printing and exporting](#printing-and-exporting)
  - [The Reports page](#the-reports-page)
  - [Read-only ledgers and archive files](#read-only-ledgers-and-archive-files)
  - [Designing for the report designer](#designing-for-the-report-designer)
  - [Security, privacy and robustness](#security-privacy-and-robustness)
  - [Alternatives considered](#alternatives-considered)
  - [Risks](#risks)
  - [Decisions taken in review](#decisions-taken-in-review)
  - [Open questions](#open-questions)
- **Part 2: Implementation plan**
  - [Ground rules](#ground-rules)
  - [Dependency graph and order](#dependency-graph-and-order)
  - [Phase R0: spike (S)](#phase-r0-spike-s)
  - [Phase R1: the ledger and accounts additions (M)](#phase-r1-the-ledger-and-accounts-additions-m)
  - [Phase R2: the report domain, with no UI (L)](#phase-r2-the-report-domain-with-no-ui-l)
  - [Phase R3: the report view, the Reports tab and menu, and charts (L)](#phase-r3-the-report-view-the-reports-tab-and-menu-and-charts-l)
  - [Phase R4: customising and saving reports (M)](#phase-r4-customising-and-saving-reports-m)
  - [Phase R5: Budget vs Actual, from the budget plugin (S)](#phase-r5-budget-vs-actual-from-the-budget-plugin-s)
  - [Phase R6: printing, PDF and CSV (M)](#phase-r6-printing-pdf-and-csv-m)
  - [Later](#later)
  - [Testing](#testing)
  - [Documentation changes](#documentation-changes)
  - [Definition of done](#definition-of-done)
  - [Phases](#phases)

---

## Summary

**A report answers one question about the ledger (where did the money go this year? are we better off than last
spring?) with a table and a chart, for a period, over some accounts. Tessera ships eight, and any plugin can add
more. Later, users will be able to build their own.**

- **A new `reports` plugin, the report manager, knows no particular report.** As the export manager knows no file
  format, it runs whatever is contributed to it. Its contract is **`@tessera/reports-api`**. The ledger, accounts and
  budget plugins stay unaware of the manager; `accounts` gains generic additions that any plugin can use.
- **Three layers, each a contract:**
  - **Data sources** (extension point **`reports.sources`**) read the ledger and apply its rules. A source says what
    it can report on as **fields**: *dimensions* to group by (month, category, payee, account…) and *measures* to add
    up (spending, income, balance…). It answers a query with flat rows. The manager provides two: **flows** (what
    went in and out, from `accounts.service.transactionTotals`) and **balances** (how accounts stood at dates).
  - **Report definitions** (extension point **`reports.definitions`**) are **plain data**: which source, which
    dimensions on the rows and columns, which measures, what filters, what chart, and the **options** the user may
    change. A definition contains no code.
  - **Results** are what a run produces: columns, rows (a tree, with subtotals, *Other* and totals), a chart's series
    and notes, all in integer minor units. The report view draws them; printing, CSV and (later) the home view use
    the same result.
- **A pure engine in `@tessera/reports-api`** turns a source's rows into a result: rolling up trees, pivoting, keeping
  the top rows and gathering the rest as *Other*, totals, net rows, shares, averages and comparisons with an earlier
  period. Integer arithmetic throughout, as in budgets.
- **The eight reports are definitions like any other.** Seven are contributed by the `reports` plugin on its own two
  sources, through the public extension point, with no private path. **Budget vs Actual is contributed by the
  `budget` plugin**, with a source of its own over `budget.service`: the first report from another plugin, proving the
  point works.
- **What counts is what the budget already counts:** voided transactions left out, every clearing status counted,
  transfers counted only when they cross the report's scope, uncategorised money in and out kept apart, one currency
  at a time. Balances are the navigator's, at a date: liabilities negative, net worth a plain sum.
- **Reporting by sub-ledger, for a household and a small business in one ledger.** Every report runs over the whole
  ledger or one sub-ledger (a *Business* profit and loss), and flow reports can put sub-ledgers **side by side**.
  **Money moved between sub-ledgers (an owner's pay, a loan to the business) is shown apart from income and
  expenses**, after *Net income*, so a business's profit isn't lowered by what it paid its owner.
- **The year start is the ledger's** (a fiscal or tax year: 6 April, say), set in *File › Ledger Properties…*, and
  used for *This year*, quarters and years by every report, by archiving and by new budgets.
- **Archived months keep reporting true.** The accounts plugin already shares the totals of what an archive removes;
  it now **keeps them itself** and answers for them, so every report, not only budgets, is the same before and after
  *File › Archive Ledger…*.
- **Reports are computed when shown, never stored.** A **Reports tab** in the left bar lists them by group, with the
  user's saved reports under *My Reports*; the **report view** in the main area shows one, with its period, accounts
  and currency in the heading, a chart above a table, and *Show Transactions* behind every figure.
- **Customise, then save.** The heading changes the period, the accounts, the currency and what to compare with;
  *Customise Report…* changes what the definition allows (categories in detail, the top 25 payees, a chart or not).
  *Save Report As…* keeps it **in the ledger**, with a relative period (*Last 12 months* stays the last twelve).
- **Charts come from `@tessera/ui`**, so every plugin's report looks alike and follows the theme; every chart has its
  table. **Printing, Save as PDF and CSV** come last, with a small `shell.print` service.
- **Designed for a report designer.** Because definitions are data, validated against fields the sources describe,
  versioned from the first day, and saved in the same shape as a user's own, a designer later only adds a UI that
  edits a definition: the sources, engine, view and storage are already there.
- **The plan: R0 to R6.** R0, the spike (S), is done, with whether MUI X Charts fits left to be determined: totals by payee, balance history and the
  engine are within their targets at 100,000 transactions, archived months with payees fit when packed flat, and
  printing works with a print stylesheet. R1 adds the accounts additions and the ledger's year start (M), whose only
  visible change is *Ledger Properties…*. R2 builds the contract, the engine, both sources, the seven definitions and saved reports with no UI (L). R3 brings
  the Reports tab, the report view, the menu and charts (L). R4 adds customising and saving (M). R5 is the budget's
  Budget vs Actual (S). R6 is printing, PDF and CSV (M). The designer, custom renderers and home view widgets are
  [later](#later).

---

## Naming

| Concept | User-facing name | Code name | Notes |
|---|---|---|---|
| The plugin that runs reports | (not shown) | `reports` plugin, the **report manager** | Owns the Reports menu, tab and view, and both extension points |
| Something the user can run | **Report** (*Spending by Category*) | `ReportDefinitionContribution` | Data: a spec, options, a group |
| A heading in the Reports tab | *Income and Spending*, *Net Worth and Balances*, *Budgets* | `ReportGroupContribution` | Plugins may add groups |
| Where a report's figures come from | (not shown; *Data* in the designer) | `ReportSourceContribution` + `ReportSource` service | `reports.flows`, `reports.balances`, `budget.status` |
| What can be grouped by | (designer: *Fields*) | dimension (`DimensionField`) | Month, Category, Payee, Account… |
| What is added up | (column headings: *Spending*, *Balance*) | measure (`MeasureField`) | Integers: minor units, counts, or basis points |
| What a report is | (not shown) | `ReportSpec` | Source, query, presentation, parameter defaults |
| The dates a report covers | **Period** (*This year*, *Last 12 months*, *1 Mar to 15 Apr 2026*) | `PeriodValue` | Relative presets stay relative when saved |
| The date a balance report is for | **As of** (*Today*, *End of last month*) | `AsOfValue` | |
| Which accounts it covers | **Accounts** (*Whole ledger*, *Personal and its sub-ledgers*, *Everyday accounts*, *3 accounts*) | `ScopeValue`, the report's **scope** | As a budget's scope, plus chosen accounts and account types |
| Comparison | **Compare with** (*Previous period*, *Same period last year*, *Sub-ledgers*) | `compare` | *Sub-ledgers*: side by side, each over its own accounts |
| Money moved between the report's accounts and others | **Transfers in**, **Transfers out** | groups `transferIn`, `transferOut` | Between sub-ledgers: an owner's pay, a loan |
| Income less expenses, before transfers | **Net income** | a net row | A business's profit for the period |
| When the ledger's year begins | **Year starts on** (*1 January*, *6 April*), in *Ledger Properties…* | `LedgerInfo.yearStart` | The ledger's, not the application's (Q9) |
| What *Customise Report…* changes | **Options** | `ReportOption` | Named changes to the spec |
| A report the user kept | **Saved report**, under **My Reports** | `SavedReport` | In the ledger |
| What a run produces | (the report) | `ReportResult` | Table, chart, notes |
| The transactions behind a figure | **Show Transactions** | drill-down, `DrillRequest` | |
| A later tool for building reports | **Report Designer** | (later) | [Designing for the report designer](#designing-for-the-report-designer) |

The plugin id is **`reports`**, plural, because it is the Reports menu, tab and view, and because
[plugin-creation.md](plugin-creation.md#using-a-service) already uses a `reports` plugin as its example. Its contract
is `@tessera/reports-api`, after its plugin as every contract is. Commands are `reports.*`, collections `reports.*`.

*Spending* is the word for money out net of refunds, as the budget uses it; *Income* for money in net of reversals.
*Customise* follows the notes' spelling; the menu item reads *Customise Report…*.

---

## Context

What exists, and what reports use from it:

| Facility | Used for |
|---|---|
| `accounts.service.transactionTotals({ from, to, accountIds, includeTransfers })` (accounts-api 1.13): non-voided transactions by account, month, and category or transfer account, money in and out apart | Every flow: Income vs Expenses, Spending by Category, Cash Flow, Category Trends. Measured in B0: 42 to 49 ms for a year at 100,000 transactions |
| `accounts.service`: `list` (with `subLedgerId`, `includeDescendants`, `types`), `chart()`, `categories.list()`, `onDidChange` | Scopes, account names and types, the category tree, knowing when to refresh |
| `Account.openingBalance`, `openingDate`, `lastArchiveDate`, `archived.originalOpeningBalance` | Balances at past dates, before and after archives |
| `categoryLabel`, `mostUsedCurrency`, `formatAmount`, `todayIso` (`@tessera/accounts-api`) | Labels as the register shows them; the currency to suggest; showing amounts |
| `AccountsArchived.removedTotals` (accounts-api 1.13), which the budget keeps in `budget.archivedMonths` | What an archive removed. **Only the budget keeps it, in collections no other plugin can read** |
| `budget.service.status(budgetId, months, { byMonth })` (budget-api 1.3): rows, figures, totals, at most 24 months | Budget vs Actual, figure for figure the budget view's |
| `ledger.session`: `ledger.schema`, `participate` (sub-ledger deletes), `current.readOnly`, `current.archive` | Saved reports in the ledger; read-only ledgers and archive files |
| `shell.views`, `shell.dialogs`, `shell.menus`, `shell.settings.pages`, `shell.icons`, `context.state`, `shell.prompts`, `shell.files` | The tab, the view, the dialogs, the menu, the Reports page, what is remembered, saving CSVs |
| `ExtensionRegistry.onDidChange`, fired as each contribution is made | Following sources and definitions, in whatever order plugins activate |
| `@tessera/export-api` helpers: `minorToDecimal`, `encodeText`, `safeFileName` | Exact amounts and safe text in CSV |
| `@tessera/ui` 1.5: `Table` and its parts, `useThemeState`, `useFontRoles`, `ShowChart` among the standard icons | The table, and what a chart needs from the theme |
| `npm run sample:archive` (`scripts/sample-archive/household.ts`): nearly four years of a household, a business paying its owner, a budget, an archive | Checking every report by hand, before and after an archive |

What is missing, and where it is filled:

| Gap | Why it matters | Filled by |
|---|---|---|
| **No payee in `transactionTotals`** | Spending by Payee can't be totalled without reading every transaction through registers | R1: `byPayee` |
| **No payee names by id.** `payees.search('')` returns at most 20, and looks up each one's last transaction | A report of 300 payees needs their names in one call (the budget's review already asked for this) | R1: `payees.get(ids)` |
| **No balance at a past date.** `balances(id)` is now; `register()` gives running balances, one account at a time, reading every row | Net Worth and Account Balances at month ends, over years | R1: `balanceHistory` |
| **Archived totals are the budget's alone** | Without them every report for a month before an archive would shrink after it | R1: `accounts` keeps them, and answers for them |
| **No charts in `@tessera/ui`.** Plugins may not import `@mui/*` | Every report but Account Balances is best seen as a chart | R0 chooses, R3 adds (`@tessera/ui` 1.6) |
| **No printing in the shell** | Reports are what people print | R6: `shell.print`, the print stylesheet and `PrintArea` (`@tessera/ui` 1.7) |
| **The year start is an application setting** (the Archiving page's), though a fiscal year belongs to a ledger | A household's calendar year and a business's fiscal year can't both be right in one setting | R1: the ledger keeps it ([The ledger's year start](#the-ledgers-year-start)) |
| **Menus are built once, after every plugin activates, and an item names a command with no arguments** | Each report in the Reports menu needs a command of its own | R3: the manager mirrors each definition into a command and an item as it is contributed, during activation |
| **A plugin's view can't draw another plugin's module** | A report contributed by the budget plugin must be drawn by the reports plugin | Presentation declared as data ([R-5](#decisions)); contributed renderers [later](#later), with the home view's widgets, which need the same thing |

---

## Why people run reports

| Who | Wants to know | Report |
|---|---|---|
| A household at the end of a month or year | Did we earn more than we spent? | **Income vs Expenses** |
| Someone trying to spend less | Where does the money go, and what is the biggest slice? | **Spending by Category** |
| The same person, a level down | Which shops and companies get the most? | **Spending by Payee** |
| Someone watching a habit | Is dining out creeping up? Did groceries rise this spring? | **Category Trends** |
| Someone paying down a mortgage or saving | Are we better off than a year ago? | **Net Worth** |
| Someone preparing for taxes, a loan application or an accountant | What was in every account on 31 December? | **Account Balances** |
| Someone living month to month | How much came into and went out of the everyday accounts, and what is left? | **Cash Flow** |
| A household with a budget | How did the year go against the plan, line by line and month by month? | **Budget vs Actual** |
| A sole proprietor with a *Business* sub-ledger | The business's profit and loss, apart from the household's, with the owner's pay shown as a transfer, not an expense; its cash flow; its share of net worth | Every report over *Business*, with *Net income* before transfers ([Reporting by sub-ledger](#reporting-by-sub-ledger)) |
| The same person, at year end | The household and the business side by side, and together | Income vs Expenses, Spending by Category or Cash Flow, *Compare with: Sub-ledgers* |
| Someone who archived old years | Last year's reports, unchanged by the archive | Every report, through archived totals |
| Someone moving from Microsoft Money | The reports and charts they used there | The same eight, with customising and saving |

---

## Goals and non-goals

**Goals**

- **Any plugin can add reports**, and the ones Tessera ships use the same extension points, with nothing private.
- **Definitions are data**, so they can be validated, versioned, customised, saved, and later built and edited by
  users in a designer.
- **Figures agree with the rest of Tessera:** flows with the registers and the budget's actuals, balances with the
  navigator, Budget vs Actual with the budget view. One rule, kept in one place, for each.
- **History stays true:** archiving changes no report for any period.
- **Exact arithmetic:** integer minor units throughout; the only divisions (shares, averages, changes in per cent) are
  integer divisions in one module, and they are for showing only.
- **Fast enough not to notice:** a year's report in under a quarter of a second at 100,000 transactions; nothing
  recomputed while the view is hidden.
- **Accessible:** every chart has its table; the table is keyboard-navigable and drawn in the font roles.
- **Works read-only:** archive files can be reported on, which is much of their point.
- **Report by sub-ledger:** any report over one sub-ledger, flows side by side by sub-ledger, and money between
  sub-ledgers kept apart from income and expenses, for a household and a small business sharing one ledger.
- **The ledger, accounts and budget plugins stay unaware of the manager.** Their additions are generic, and the budget
  takes part only by contributing data through the public contract.

**Non-goals (for the first release)**

- **The report designer** itself: [later](#later), in a note of its own. This note makes room for it.
- **Several currencies in one figure.** Reports run in one currency and name the accounts they leave out. Exchange
  rates are a feature of their own.
- **Investment reports** (holdings, performance, gains): Tessera has no investment transactions yet.
- **Tax reports**, **loan amortisation**, **forecasts** of balances or cash flow, and **scheduled transactions**.
- **Days and weeks as columns.** Flows are totalled by month (`transactionTotals`); a report can cover any dates, but
  its columns are months, quarters or years ([Later](#later)).
- **Lists of transactions as a report** (every tax-deductible purchase): the designer's. *Show Transactions* covers
  reading the detail behind a figure.
- **Sending or scheduling reports**, and **sharing** report definitions as files ([Later](#later)).
- **Caching or storing figures.** Reports are worked out each time; a cache is kept in reserve if R0 asks for it.
- **Reading archive files** for detail before an archive ([Later](#later)). Archived months are reported from kept
  totals.
- **Contributed React renderers** for a report's body ([Later](#later)).

---

## Decisions

Reviewed on 2026-11-16; the decisions changed or added in review are marked ✓
([Decisions taken in review](#decisions-taken-in-review)). Each is explained where it lands.

| # | Decision | Where |
|---|---|---|
| R-1 | **A plugin of its own, `reports` (the report manager), with its contract `@tessera/reports-api`.** It knows no particular report. `ledger`, `accounts` and `budget` learn nothing about it; `accounts` gains generic additions | [Architecture](#architecture) |
| R-2 | **Three layers: sources, definitions, results.** Sources are contributed to `reports.sources` and backed by a service; definitions to `reports.definitions`, as data; results are what a run returns | [The model](#the-model-sources-definitions-results) |
| R-3 ✓ | **Definitions are declarative, versioned and validated** (`ReportSpec`). The eight shipped reports are definitions like any other, contributed through the public points, the seven of the `reports` plugin with no special treatment (Q7). **A definition never names anything in a ledger** (no account or category ids): only saved reports do | [Report definitions](#report-definitions) |
| R-4 | **Sources read and apply the ledger's rules; the engine only shapes.** The engine (pure, in `@tessera/reports-api`) rolls up, pivots, keeps the top rows, totals, nets, and compares. Integer arithmetic only | [The engine](#the-engine) |
| R-5 | **Presentation is declared and drawn by the report manager**: a table and a chart from the result. A contributing plugin needs no renderer, as an export format needs none (export's E-4) | [The Reports tab and the report view](#the-reports-tab-and-the-report-view) |
| R-6 ✓ | **What counts is the budget's rule:** non-voided, every clearing status, by date, future-dated ones entered in the ledger and in the period included, while *Year to date* and *As of today* stop at today (Q5); transfers only when they cross the scope; uncategorised money in and out apart. The scope rule is added to `@tessera/accounts-api`, for reports now and the budget later, so the two can't disagree | [What counts](#what-counts-the-flows-source) |
| R-7 ✓ | **Scope: the whole ledger, a sub-ledger and beneath it, chosen account types (in the ledger or a sub-ledger; Cash Flow's *everyday accounts* are chequing, savings, credit cards and lines of credit, Q6), or chosen accounts. One currency per run**, the one most accounts in scope use unless chosen; the others are named | [Scope and currency](#scope-and-currency) |
| R-8 | **Balances at a date come from `accounts.service.balanceHistory`**, by the navigator's rule: opening balance plus non-voided transactions dated on or before it. Liabilities are negative, and net worth is a plain sum | [The balances source](#how-things-stood-the-balances-source) |
| R-9 ✓ | **The accounts plugin keeps the totals of what archives remove, and answers for them** (`archivedTotals`), **payees included** (Q3): one place for archived totals (Q2). The report manager keeps no copy, and takes no part in archives | [Archived months](#archived-months) |
| R-10 | **Payees: totals by payee on request, and names by id**, both in `accounts.service` | [The accounts additions](#the-accounts-additions) |
| R-11 | **Reports are worked out when shown, never stored.** A shown report refreshes after changes, at most every 250 ms; a hidden one waits until it is shown | [Keeping reports current](#keeping-reports-current) |
| R-12 ✓ | **Periods are dates; columns are months, quarters or years.** Presets (*This year*, *Last 12 months*…) are relative and stay relative when saved. Years and quarters follow **the ledger's year start** (Q9) | [Periods](#periods) |
| R-13 | **Compare with the previous period or the same period last year**, by running the source twice | [The engine](#the-engine) |
| R-14 | **Options are named changes to the spec** (merge patches), declared by the definition and drawn by *Customise Report…*. Every option's result is validated when the definition is contributed | [Customising and saving](#customising-and-saving-reports) |
| R-15 ✓ | **Saved reports live in the ledger** (`reports.saved`), as a definition with options and parameters, or (for the designer) a spec of their own. Preferences are settings; the last parameters used are application state (Q8) | [Customising and saving](#customising-and-saving-reports) |
| R-16 ✓ | **Charts are part of `@tessera/ui`**, a shared singleton, themed by tokens and font roles: **MUI X Charts if it is compatible, else our own** (Q4); whether it is, is to be determined before R3. **Every chart has its table** | [Charts](#charts) |
| R-17 ✓ | **A Reports tab, one report view, and a top-level Reports menu** in which each definition is mirrored as it is contributed. The Budget menu stays where it is (Q1) | [The Reports tab](#the-reports-tab-and-the-report-view), [The Reports menu](#the-reports-menu-commands-and-context-keys) |
| R-18 | **Show Transactions behind any figure** of a source that can list them, each a click from its register | [The transactions behind a figure](#the-transactions-behind-a-figure) |
| R-19 | **Print, Save as PDF and CSV**, through a new `shell.print` service and atomic writes in `shell.files` | [Printing and exporting](#printing-and-exporting) |
| R-20 | **Budget vs Actual is contributed by the `budget` plugin**, with a source over `budget.service` | [Budget vs Actual](#7-budget-vs-actual) |
| R-21 | **Read-only ledgers and archive files can be reported on;** saving reports is disabled there | [Read-only ledgers](#read-only-ledgers-and-archive-files) |
| R-22 | **Limits, not hangs:** at most 5,000 rows and 25,000 cells, 12 series, 8 slices, 120 columns of months and 240 dates; a source has 10 seconds. Past a limit the report says so | [The contract](#the-contract-tesserareports-api) |
| R-23 ✓ | **Reporting by sub-ledger:** every report over a sub-ledger; *Compare with: Sub-ledgers*, each column worked out over its own sub-ledger; **transfers shown apart, after *Net income***, so an owner's pay is never an expense of the business; the *Accounts* choice carried from report to report | [Reporting by sub-ledger](#reporting-by-sub-ledger) |
| R-24 ✓ | **The ledger keeps its year start** (month and day), in its meta, set in *File › Ledger Properties…*; reports, *Archive Ledger…* and *New Budget…* all use it (Q9) | [The ledger's year start](#the-ledgers-year-start) |
| R-25 ✓ | **Plugins keep reaching MUI only through `@tessera/ui`.** Charts come in as a separate entry, loaded when first drawn; additions follow a stated policy | [Reports and `@tessera/ui`](#reports-and-tesseraui) |

---

# Part 1: Design

## Architecture

```
  ┌────────────────────────────────┐
  │ ledger                         │  ledger.session: the file, sub-ledgers, ledger.schema, participants,
  │                                │  the ledger's year start (R1)
  └────────────────▲───────────────┘
                   │ requires
  ┌────────────────┴───────────────┐
  │ accounts                       │  accounts.service: transactionTotals (+ byPayee), payees.get,
  │                                │  balanceHistory, archivedTotals (R1)
  └──────▲─────────────────▲───────┘
         │ requires        │ requires
  ┌──────┴─────────────┐  ┌┴───────────────────────────────┐
  │ budget             │  │ reports (new: report manager)  │  provides reports.service, reports.migrator,
  │  budget.service    │  │                                │  and its sources' services
  │                    │  │  extension points:             │
  │  source            │  │                                │
  │   budget.status ───┼──┼─► reports.sources              │  ◄── its own: reports.flows, reports.balances
  │  definition        │  │                                │
  │   budget.vsActual ─┼──┼─► reports.definitions          │  ◄── its own: the seven definitions
  │                    │  │                                │
  │                    │  │  registry, run, engine, view,  │
  │                    │  │  saved reports                 │
  └────────────────────┘  └────────────────────────────────┘
        both bundle @tessera/reports-api: types, validation, periods, the engine
```

The budget plugin does **not** require the reports plugin, and the reports plugin does not require `budget.service`.
Contributions are data: without the reports plugin, the budget's are unused; without the budget plugin, Budget vs
Actual isn't offered. This is how the file-type plugins stand to the import and export managers.

| Component | Kind | Provides | Requires | Owns |
|---|---|---|---|---|
| `reports` | bundled plugin | `reports.service`, `reports.migrator`, `reports.flows`, `reports.balances` | `accounts.service`, `ledger.session`, `shell.prompts`, `shell.files` and `shell.print` (both from R6), `app.state` | the `reports.*` collections, both extension points, commands, views, dialogs, the Reports page |
| `@tessera/reports-api` | package (types, constants, validation, periods, the engine) | | `@tessera/types`, `@tessera/ledger-api`, `@tessera/accounts-api` | |
| `ledger` (changed, R1) | bundled plugin | `ledger.session` with `current.yearStart` and `setYearStart` | | the year start in the ledger's meta; *File › Ledger Properties…* |
| `accounts` (changed, R1) | bundled plugin | `accounts.service` with the additions | | `accounts.archivedMonths` (new collection) |
| `budget` (changed, R5) | bundled plugin | `budget.reportSource` (new service) | | its source and definition contributions |
| `@tessera/ui` (changed, R3) | shell package | charts, a chart palette | | |
| shell (changed, R6) | | `shell.print`; atomic writes in `shell.files` (`writeFile`); the print stylesheet; `PrintArea` in `@tessera/ui` 1.7 | | |

Inside the plugin, as in `budget` and `export`, **pure code is kept apart from input and output**:

| Module | Pure? | What |
|---|---|---|
| `@tessera/reports-api` `spec.ts` | yes | `ReportSpec` and its parts; `specProblems(spec, source)`, naming each problem's path (`query.rows.dimension`); `applyOptions(spec, options, values)`; `migrateSpec` |
| `@tessera/reports-api` `periods.ts` | yes | Presets to dates from *today* and the year start; month, quarter and year columns; the compared period. Day numbers, never a `Date` in a time zone (the budget's `plan.ts` rule) |
| `@tessera/reports-api` `engine.ts` | yes | `shape(spec, source, result, compared?) → ReportResult`: a source's rows and members, and those of the compared period, shaped |
| `privileged/flows.ts`, `balances.ts` | yes | Classifying totals by the scope rule; building balance rows; each over plain data |
| `privileged/FlowsSource.ts`, `BalancesSource.ts` | no | The two `ReportSource` services, over `accounts.service` |
| `privileged/registry.ts` | no | Sources, groups and definitions contributed: validated, ordered, followed as plugins add them |
| `privileged/run.ts` | no | A run: resolve parameters, ask the source (twice to compare), shape, time limits |
| `privileged/ReportsServiceImpl.ts`, `store.ts`, `schema.ts`, `participants.ts` | no | `reports.service`, saved reports, the schema and migrator, the sub-ledger participant |
| `privileged/definitions/*.ts` | data | The seven definitions, one file each |
| `privileged/index.ts`, `contributions.ts`, `commands.ts`, `ipc.ts`, `menu.ts`, `refresh.ts`, `settings.ts` | no | Activation, contributions, commands, IPC, mirroring definitions into the menu, keeping shown reports current, the Reports page |
| `renderer/ReportView.tsx`, `ReportList.tsx`, `ResultTable.tsx`, `ResultChart.tsx`, `ParameterBar.tsx`, `CustomiseDialog.tsx`, `SaveDialog.tsx`, `TransactionsDialog.tsx` | | The UI (`tableModel.ts`, `chartModel.ts` are their pure parts) |

`reports` requires `accounts.service`, so it activates after `accounts`. It reads the contributions to its points
whenever they change, so a plugin contributing a report can activate before or after it.

---

## The model: sources, definitions, results

```
   definition (data)            parameters                          reports.flows / reports.balances / budget.status
   ┌──────────────────┐   ┌─────────────────────┐                   ┌──────────────────────────────────────┐
   │ source           │   │ period: This year   │   SourceQuery     │ ReportSource.query()                 │
   │ query: rows,     │──►│ accounts: Personal  │──────────────────►│   reads accounts.service (or budget) │
   │   columns,       │   │ currency: CAD       │   dimensions,     │   applies the rules: voids, scope,   │
   │   measures,      │   │ compare: last year  │   measures,       │   transfers, archived months         │
   │   filters        │   │ options: detail=all │   filters, dates  │ → flat rows + members (labels, tree) │
   │ presentation     │   └─────────────────────┘                   └───────────────────┬──────────────────┘
   │ options          │                                                                 │ SourceResult
   └──────────────────┘                                                                 ▼
                                                          engine (pure, @tessera/reports-api): roll up, pivot,
                                                          top N + Other, totals, net, shares, comparisons
                                                                                        │ ReportResult
                                         report view (table + chart) · print · CSV ◄────┘ (later: home view, designer preview)
```

- **A source knows the ledger; the engine knows nothing about money.** Whether a refund lowers spending, whether a
  transfer counts, what a balance was before an archive: the source's rules, tested against the real services. How
  rows become a table: the engine's, tested on plain rows. A definition only chooses.
- **A source answers at the grain it is asked for.** Asked for `category` by `month`, the flows source returns one row
  per category and month that has anything; the engine rolls categories up their tree and pivots the months into
  columns. Sources never return more rows than the dimensions asked for imply.
- **Members carry the labels.** A row's keys are ids (`categoryId`, `'2026-03'`); the source also returns each
  dimension's members that appear (`{ id, label, parentId, sign, order }`), so the engine can build the tree, order
  rows as the register does, and label them without asking again.
- **Results cross IPC whole**, structured-cloneable, ready to draw: the view formats amounts and draws; it never adds.

---

## What counts: the flows source

`reports.flows` (*Transactions*) answers *what went in and out*, from `accounts.service.transactionTotals` for the
transactions in the ledger and `accounts.service.archivedTotals` for those archives removed
([Archived months](#archived-months)). Its rule is the budget's ([budget-design.md](budget-design.md#actuals)),
generalised from a budget's scope to a report's:

| A transaction… | Counts? |
|---|---|
| in an account in scope, in the report's currency, dated in the period | **Yes**, by its date |
| uncleared, electronically cleared, cleared or reconciled | **Yes** |
| dated after today, within the period | **Yes**, as in budgets, since it is entered in the ledger (Q5): *This year* includes a cheque written for December. *Year to date* and *As of today* stop at today |
| voided | **No**: it adds nothing to any balance either |
| a transfer whose other account is **inside** the scope | **No**: money moving between the report's own accounts |
| a transfer whose other account is **outside** the scope | **Yes**, as *Transfers in* or *Transfers out*, by the other account |
| with no category, and not a transfer | **Yes, as *Uncategorised***: money in with the income, money out with the expenses, never netted together |
| in an account in another currency | **No**: named in the report's notes |
| in a closed account | **Yes** |
| the opening balance | **No**: it is not a transaction (Cash Flow shows it apart) |
| a split (later) | Each part by its own category, inside `transactionTotals` |

**Groups.** Each counted total falls in one **group**, which carries a sign for net figures:

| Group | What | Its *amount* | Sign |
|---|---|---|---|
| `income` | Income categories; uncategorised money in | money in − money out: a reversed deposit lowers income | +1 |
| `expense` | Expense categories; uncategorised money out | money out − money in: a refund lowers spending | −1 |
| `transferIn` | Money in from an account outside the scope | money in | +1 |
| `transferOut` | Money out to an account outside the scope | money out | −1 |

A transfer total holds both directions for one account pair and month; its money in goes to `transferIn` and its money
out to `transferOut`, so Cash Flow shows both. **The net of all groups is the change in the scope's balances** from
transactions (the [invariant](#testing) the tests rely on).

**Fields.** Dimensions:

| Key | Label | Type | Notes |
|---|---|---|---|
| `month` | Month | time | The total's month. Quarters and years are the axis's `grain`, which the engine buckets by the [year start](#periods), so no source needs the year start (R2: one time dimension, not three) |
| `group` | Income or expense | enum, signed | The four groups above |
| `flow` | Income, expenses and transfers | member, tree, signed | The four groups at the top, each signed; beneath them the categories (income and expenses, with *Uncategorised*) or the other accounts (transfers). Depth 1 is the groups, depth 2 top-level categories and accounts. Income vs Expenses and Cash Flow lay out their rows by it |
| `category` | Category | member, tree | The category tree, as the register labels it. No category: *Uncategorised* |
| `payee` | Payee | member | Asks `transactionTotals` for `byPayee`. No payee: *No payee* |
| `account` | Account | member | In navigator order |
| `subLedger` | Sub-ledger | member, tree | Where the account is now (as budgets judge it); the ledger itself is *(the ledger)* |
| `accountType` | Account type | enum | *Chequing*, *Credit card*… |
| `otherAccount` | Other account | member | Transfers only: the account on the other side |
| `otherSubLedger` | Other sub-ledger | member, tree | Transfers only: where the other account is (for one an archive removed, where it was): money between *Business* and *Personal* |

Measures:

| Key | Label | Unit | Combines | Notes |
|---|---|---|---|---|
| `amount` | Amount (shown as *Income*, *Spending*, *Transfers* by the definition) | money | sum | The group's amount, above: positive in the usual case |
| `net` | Net | money | sum | Money in − money out, every group |
| `moneyIn`, `moneyOut` | Money in, Money out | money | sum | Before netting |
| `count` | Transactions | count | sum | |
| `openingBalance`, `closingBalance` | Opening balance, Closing balance | money | none | Only by time, account, sub-ledger or account type: from `balanceHistory` at the period's edges. Cash Flow's |
| `opened` | Accounts opened | money | sum | Opening balances of accounts in scope opened in the period, so that opening + net + opened = closing |

---

## How things stood: the balances source

`reports.balances` (*Balances*) answers *how much was in each account at a date*, from
`accounts.service.balanceHistory` ([The accounts additions](#the-accounts-additions)).

- **The rule is the navigator's,** at a date: the opening balance, plus every non-voided transaction dated on or
  before it, whatever its status. Liabilities are negative, so **net worth is a plain sum**, as `chart().totals` is.
- **An account counts from its opening date.** Before it, it isn't listed, and adds nothing. A closed account counts
  with whatever it held (usually nothing after it closed).
- **Today's figure can differ from the navigator's**, which adds every transaction, future-dated ones too. A report
  *as of today* adds those dated up to today. The note under the report says so when there are any ("2 transactions
  dated after 16 Nov 2026 aren't included").
- **Actual balances, not available ones:** a minimum balance doesn't change net worth (the navigator's totals follow
  the same rule).

| Field | Kind | Notes |
|---|---|---|
| `date` | dimension, time | The dates asked for: one (Account Balances) or the ends of each month, quarter or year of a period (Net Worth) |
| `byType` | dimension, member, tree | *Assets* and *Liabilities*, then account types, then accounts: depth 1 is the classes |
| `byPlace` | dimension, member, tree | The ledger's tree, sub-ledgers and then accounts, as the navigator lays them out |
| `account`, `accountType` | dimensions | As for flows, flat |
| `accountClass` | dimension, enum | *Assets*, *Liabilities*, for filters |
| `currency` | dimension, member | For *All currencies* in Account Balances (R2: a member, since currencies are the ledger's) |
| `state` | dimension, enum | *Open, or holding something*, or *Closed and empty* at the date: Net Worth and Account Balances leave out closed accounts holding nothing (R2) |
| `balance` | measure, money, **last** | Adds across accounts; across dates, the last one, so a year's "total" is its closing balance |

---

## Scope and currency

A report's **Accounts** parameter is its scope:

| Scope | Shown as | Means |
|---|---|---|
| `{ kind: 'ledger' }` | *Whole ledger* | Every account |
| `{ kind: 'subLedger', subLedgerId }` | *Personal and its sub-ledgers* | As a budget's scope: the accounts there now, in it and beneath it |
| `{ kind: 'types', types, subLedgerId? }` | *Everyday accounts* (chequing, savings, credit cards and lines of credit), or the types named; *Everyday accounts in Business* with a sub-ledger | Cash Flow's default (Q6). Without a sub-ledger it needs no ids, so a definition can use it |
| `{ kind: 'accounts', accountIds }` | *3 accounts*, listed in a tooltip | Chosen by the user: only in parameters, never in a definition |

- **Transfers cross a scope exactly when one side is in it and the other isn't**, as for budgets. Over the whole
  ledger, no transfer counts. Over a sub-ledger, money to and from the others does: see
  [Reporting by sub-ledger](#reporting-by-sub-ledger).
- **Cash isn't an everyday account** (Q6): the everyday accounts are where money arrives and bills are paid. A user who
  keeps a *Cash* account (a wallet) sees a withdrawal into it as money out of the everyday accounts, which is where it
  went.
- **The scope rule is added to `@tessera/accounts-api`** (R1): `accountScope(scope, subLedgers, accounts, currency)`
  gives the accounts inside, those counted (inside and in the currency), those left out for their currency, and
  `crossesScope(total, scope, exists)` decides a transfer (using, for an account an archive removed, its sub-ledger at the
  time, as the budget does). The budget's own `scopeOf` and `countedTotals` become thin uses of it later
  ([Later](#later)), so budgets and reports can't disagree about a transfer.
- **One currency per run.** The **Currency** parameter defaults to the currency most accounts in scope use
  (`mostUsedCurrency`). Accounts in scope in another currency are named in a note ("Not counted: US Visa, in USD").
  **Account Balances** also offers *All currencies*: each account in its own, with totals per currency, as the
  navigator shows them. Nothing is converted.
- **Accounts that no longer exist** (chosen in a saved report, then deleted) are dropped when it runs, with a note
  ("1 account chosen for this report no longer exists"). Nothing is written when an account is deleted.

---

## Reporting by sub-ledger

Tessera keeps a household and a small business in one ledger as **sub-ledgers** (*Personal*, *Business*, perhaps
*Rentals*), with transfers between them when the business pays its owner or the owner puts money in. Review asked that
reports serve that case well (R-23). Three things make it work.

**1. Every report runs over one sub-ledger.** The *Accounts* parameter lists the ledger's tree, as New Budget's
*Covers* does: *Whole ledger*, *Business and its sub-ledgers*, *Personal and its sub-ledgers*. Income vs Expenses over
*Business* is the business's profit and loss; Cash Flow over *Everyday accounts in Business* is its cash flow; Net
Worth and Account Balances over it are what it holds and owes.

**2. Money between sub-ledgers is shown apart from income and expenses.** The owner's pay is a transfer: a withdrawal
from *Business Chequing* and a deposit into *Personal Chequing*. It is neither an expense of the business nor income
earned by the household, so flow reports show, in this order:

- **Income** and **Expenses**, then **Net income** (income less expenses: the business's profit for the period);
- **Transfers in** and **Transfers out**, each by the other account, for money crossing the report's scope;
- **Net after transfers**: what the accounts in scope gained or lost in all.

Over the whole ledger there are no transfers across the scope, so *Net after transfers* would repeat *Net income* and
is left out (side by side, below, it is kept, since the sub-ledgers' columns need it). Cash Flow, which is about money whatever it was for, keeps one *Net*, after transfers.

**3. Sub-ledgers side by side.** *Compare with: Sub-ledgers* puts a column for each sub-ledger beside one for the
scope as a whole. Here, a sole proprietor's ledger for March 2026:

```
Income vs Expenses · March 2026 · Whole ledger, by sub-ledger · CAD
                              Personal       Business   Whole ledger
INCOME
  Consulting fees                    —       8,400.00       8,400.00
  Interest                       12.10              —          12.10
Total income                     12.10       8,400.00       8,412.10
EXPENSES
  Housing                     1,500.00              —       1,500.00
  Food                          862.15              —         862.15
  Office and software                —         357.40         357.40
  Transportation                175.00              —         175.00
  Bank charges                       —          18.50          18.50
  Uncategorised                  41.00              —          41.00
Total expenses                2,578.15         375.90       2,954.05
Net income                   -2,566.05       8,024.10       5,458.05
TRANSFERS IN
  Business Chequing           3,000.00              —              —
Total transfers in            3,000.00              —              —
TRANSFERS OUT
  Personal Chequing                  —       3,000.00              —
Total transfers out                  —       3,000.00              —
Net after transfers             433.95       5,024.10       5,458.05
Transfers between these sub-ledgers cancel out over the whole.
```

- **Each column is worked out over its own sub-ledger**, as if the report had been run there, so the owner's pay is
  *Transfers out* in *Business* and *Transfers in* in *Personal*. The last column is the scope chosen, where the same
  transfer is inside and doesn't count. So **income, expenses, net income and net after transfers add across** the
  sub-ledgers to the whole (433.95 + 5,024.10 = 5,458.05), and the transfers between them cancel; the note says so.
- **Personal's net income is negative**, in red, because the household earns little itself: what it lives on arrives
  as the owner's pay. That is the point of keeping transfers apart. Folding them into income would hide that the
  business pays for the household.
- **The columns** are the sub-ledgers directly beneath the scope (each with everything beneath it), and, when the
  scope holds accounts of its own, one for them (*Home Finances itself*); at most 12. *Sub-ledgers* in the heading
  picks which.
- **The period is one column per sub-ledger:** comparing sub-ledgers takes the columns that months would use, and the
  chart draws each sub-ledger's bars side by side.
- **Offered by** Income vs Expenses, Spending by Category, Spending by Payee and Cash Flow. Category Trends keeps
  months across. Net Worth and Account Balances need no comparison: a balance belongs to one account, so they break
  down by sub-ledger directly (*Detail: sub-ledgers*, the `byPlace` tree). Budget vs Actual has its budget's scope.
- **One read of the ledger:** the flows source asks `transactionTotals` once and classifies the totals once per column
  (`SourceQuery.scopes`), which B0 measured at 0.2 to 7 ms a budget's worth. Nothing is read twelve times.

**Also:**

- **The *Accounts* choice carries from report to report.** Choosing *Business* in one report opens the next on
  *Business* too, remembered per ledger, so someone doing the business's books stays in the business. A saved report
  keeps its own.
- **Money between sub-ledgers can be reported on its own:** flows have the **other sub-ledger** as a dimension
  (`otherSubLedger`), so a report of the owner's draws and contributions, month by month, is one definition away
  ([Later](#later)), or a designed report.
- **Categories are the ledger's**, shared by its sub-ledgers. A business's categories appear only in reports where they
  were used (rows with nothing are hidden), so keeping business and household categories apart (a *Business* parent
  category, say) is the user's choice, not something reports need.
- **Budgets per sub-ledger** already exist; Budget vs Actual reports on whichever budget is chosen.
- **Deleting a sub-ledger** moves saved reports over it to its parent, as budgets move (the participant,
  [Storage schema](#storage-schema-reports)), and `accounts` moves what its archived totals say was in it there too
  (R1), so archived months report under the parent, as the live transactions of its accounts do.

---

## Periods

| Preset | From | To | Columns by default |
|---|---|---|---|
| *This month* | the 1st | the month's last day | — |
| *Last month* | | | — |
| *This quarter*, *Last quarter* | by the year start | | months |
| *This year*, *Last year* | by the year start | | months |
| *Year to date* | the year's start | **today** | months |
| *Last 3 months*, *Last 12 months* | the 1st, 2 or 11 months before this month | the end of this month | months |
| *All dates* | the earliest opening date in scope | the latest transaction, or today | years |
| *Custom* | any date | any date | months |

- **Dates are whole days, YYYY-MM-DD, inclusive.** A custom period can start and end mid-month (10 March to 15
  April 2026); its columns are still months, and a partial one is labelled so ("10–31 Mar 2026", "1–15 Apr 2026").
- **Presets stay relative.** A saved *Last 12 months* report shows the last twelve whenever it is opened. A custom
  period is saved as its dates.
- **Years and quarters follow the ledger's year start** ([The ledger's year start](#the-ledgers-year-start)).
  *This year*, *Last year* and *Year to date* start on its very day (6 April for a UK tax year), so their totals are
  exact, with partial first and last months labelled as such. Quarter and year **columns** are whole months, since
  totals are by month: with a year starting on the 6th, they run from the 1st, and the report says so. A year
  starting in April is labelled "2026–27".
- **As of**, for balances: *Today*, *End of last month*, *End of last year*, or a date; and for Net Worth a series,
  the end of every month (or quarter, or year: the `date` axis's grain) in a period. The last point of a series that
  ends in the future is today.
- **Comparison** (*Compare with*): the *previous period* is the same length immediately before (*This year* → last
  year; 10 March to 15 April 2026, 37 days → 1 February to 9 March 2026); *same period last year* is the same dates a year
  earlier (29 February becomes 28 February).
- **All date arithmetic is on day numbers** from the YYYY-MM-DD text, never a JavaScript `Date` in a time zone, as
  the budget's `plan.ts` does; *today* is passed in (`todayIso()`), so the tests fix it.

---

## The ledger's year start

A fiscal or tax year belongs to a ledger: a household on the calendar year and a business whose year starts on 1 July
are different ledgers' facts, not the user's preference. Review decided the year start lives in the ledger (Q9, R-24).

- **In the ledger's meta**, beside `ledger.id`: `LEDGER_META.yearStart`, `{ month, day }`. Meta is copied into
  backups and archive files, so they keep the year they were made with. It is part of the ledger's own format, with
  no contributor's collection and no schema migration.
- **Month and day**, as the Archiving page already allows: 1 January, 1 April, or 6 April for a UK tax year. The day is
  1 to 28 in February and up to the month's length otherwise, so the start exists every year (the Archiving page's
  rule, moved with it).
- **Read by any plugin** as `ledger.session.current.yearStart` (always present while a ledger is open; `yearStartOf`
  reads it, defaulting a `LedgerInfo` made by hand); set with `session.setYearStart({ month, day })`, which fails with
  `READ_ONLY` on a read-only ledger and `INVALID` for a day that isn't there every year; **`onDidChangeInfo`**
  announces it. (Designed as a new `{ type: 'changed' }` on `onDidChange`; R1 made it an event of its own, so no
  listener to `onDidChange`, which every plugin has and which means *opened* or *closed*, meets a kind it doesn't
  expect. [R1 results](#phase-r1-results).)
- **Set in *File › Ledger Properties…*** (`ledger.properties`, a small dialog of the ledger plugin's): the ledger's name
  and file, shown, and **Year starts on** [month] [day], with a line saying what uses it. Read-only on an archive file.
- **An existing ledger starts with the Archiving page's year start**, read as its year start until the ledger is
  opened writable, when it is written, as `ledger.id` is. So upgrading changes nothing anyone sees. A new ledger is
  given the same, so a user who archived at the end of a tax year keeps it in the next ledger they make; the page no
  longer shows it.
- **Who uses it:**
  - **Reports:** *This year*, *Last year*, *Year to date*, quarters and year columns ([Periods](#periods));
  - **Archive Ledger…:** the date it suggests. The Archiving page keeps only *Keep years*, with a line pointing to
    *Ledger Properties…*;
  - **New Budget…:** the month it suggests. A budget keeps its own `yearStartMonth`, as now, so two budgets can still
    differ.
- **Why not a per-ledger setting:** settings' per-ledger scopes are a proposal with open questions
  ([settings-design.md](settings-design.md#proposal-scopes-per-ledger-settings)); the year start is one value with one
  owner. If scopes arrive, it can move behind one and keep `current.yearStart` as its face.
- **Changing it** runs the shown report again; saved reports with a preset period follow it.
- **One year start for the ledger, not one per sub-ledger.** A business whose fiscal year differs from the household's
  would need one on the sub-ledger, defaulting to the ledger's ([Later](#later)).

---

## Report definitions

A definition is contributed as data, and validated against its source's fields when it is contributed (and again
whenever the source changes). Here is **Spending by Category**, complete:

```ts
import { REPORT_DEFINITIONS_POINT, type ReportDefinitionContribution } from '@tessera/reports-api'

export const SPENDING_BY_CATEGORY: ReportDefinitionContribution = {
  id: 'reports.spendingByCategory',             // starts with the contributing plugin's id
  label: 'Spending by Category',
  description: 'Where the money went: each category’s spending, and its share of the whole.',
  group: 'reports.group.spending',              // a reports.groups contribution: "Income and Spending"
  order: 20,
  icon: 'ShowChart',
  version: 1,                                   // raised when a saved report would read differently
  spec: {
    specVersion: 1,
    source: 'reports.flows',
    parameters: {
      period: { preset: 'thisYear' }, scope: { kind: 'ledger' }, currency: 'mostUsed',
      compare: 'none', compareOptions: ['previousPeriod', 'previousYear', 'subLedgers']
    },
    query: {
      filters: [{ dimension: 'group', in: ['expense'] }],
      rows: { dimension: 'category', depth: 1, sort: 'valueDesc', empty: 'hide' },
      measures: [
        { measure: 'amount', label: 'Spending' },
        { measure: 'amount', label: 'Share', show: 'share' },
        { measure: 'amount', show: 'compared' },             // only while Compare with is set: labelled "2025"
        { measure: 'amount', label: 'Change', show: 'change' }
      ]
    },
    presentation: {
      show: 'both',
      table: { totals: { row: true } },
      chart: { kind: 'donut', measure: 0, slices: 8 }
    }
  },
  options: [
    { key: 'detail', label: 'Categories', kind: 'choice', default: 'top', choices: [
      { value: 'top', label: 'Top-level categories', patch: { query: { rows: { depth: 1 } } } },
      { value: 'all', label: 'Every category, as a tree', patch: { query: { rows: { depth: 'all' } } } }
    ] },
    // Arrays replace, so the patch gives the whole list, and the chart's measure moves with it
    { key: 'refunds', label: 'Show spent and refunded apart', kind: 'boolean', default: false, patch: {
      query: { measures: [
        { measure: 'moneyOut', label: 'Spent' }, { measure: 'moneyIn', label: 'Refunded' },
        { measure: 'amount', label: 'Spending' }, { measure: 'amount', label: 'Share', show: 'share' },
        { measure: 'amount', show: 'compared' }, { measure: 'amount', label: 'Change', show: 'change' }
      ] },
      presentation: { chart: { measure: 2 } }
    } }
  ]
}

context.subscriptions.push(
  context.extensions.contribute('reports', REPORT_DEFINITIONS_POINT, SPENDING_BY_CATEGORY.id, SPENDING_BY_CATEGORY))
```

The parts:

| Part | Holds | Rules |
|---|---|---|
| `parameters` | Defaults for what the report's heading offers: `period` (range sources) or `asOf` (balances), `scope`, `currency`, `compare` and what it may be set to (`compareOptions`), and the source's own (`source: { budget: '…' }`; left out, the default the source's `members` marks, such as the budget shown last) | Relative or ledger-free values only: no ids (R-3). The user changes them in the heading; they aren't options |
| `parameters.choose` | Dimensions whose members the user may pick in the heading (Category Trends: *Categories*); nothing picked means all | The picks are ids, so they live in the parameters (`chosen`), never in the definition |
| `query.filters` | `{ dimension, in }` or `{ dimension, notIn }` over enum and member dimensions | A definition filters on enums (`group`, `accountType`, `accountClass`); member ids appear only in parameters and in a designed spec |
| `query.rows`, `query.columns` | An **axis**: a dimension, and for a tree its `depth` (1, 2… or `'all'`), for time its `grain`, `sort` (`natural`, `label`, `valueDesc`, `valueAsc`), `top` (keep that many by value, gather the rest as *Other*), `empty` (`hide` or `show` members with nothing) | At most one dimension each in the first release; `columns` is usually time. With no `rows`, one row of totals |
| `query.measures` | Each a measure of the source, a `label`, and what to `show`: `value`, `share` of its column's total, `compared` (the earlier period's value), `change`, `changePercent`, `average` (over the columns), `cumulative` (running total across columns) | `compared`, `change` and `changePercent` appear only while *Compare with* is set, so a definition lists them once and they come and go; a `compared` column with no label is labelled with its period ("2025") |
| `presentation.table` | `totals: { row, column, label }` (a total row, labelled *Total* or as given: *Net worth*), `nets` for a signed dimension: rows of Σ sign × value over some of its top members, each drawn after one (*Net income* over income and expenses, after expenses; *Net after transfers* over all, at the end; a net row that would repeat the one before it is left out), `balanceRows` (*Opening balance* first and *Closing balance* last, from the source's `openingBalance` and `closingBalance`, with *Accounts opened* when there were any: Cash Flow) | `balanceRows` only on a source that has those measures |
| `presentation.chart` | `kind` (`bar`, `stackedBar`, `groupedBar`, `line`, `area`, `donut`), which measure, `series` (rows or measures), `horizontal`, `slices` or `series` limits, an optional `line` overlay (net worth on its bars) | Optional. A chart of more than 12 series or 8 slices gathers the rest as *Other* |
| `presentation.show` | What the view opens on: `chart`, `table` or `both` | The user's toggle is remembered per report |
| `options` | Choices (`choice`, `boolean`) the user may make in *Customise Report…*, each a **patch** on `query` and `presentation` | Patches are JSON merge patches: objects merge, arrays and values replace. Each option applied to the spec must validate, or the definition is refused |
| `when` (optional) | A context-key expression: offered only while true (`budget.hasBudgets`) | As a view's `when` |
| `version` | Raised when a saved report of this definition would read differently | A saved report keeps the version it was saved with, and its option values by key |

**Validation** (`specProblems`), run on every contribution, every option, and every saved report as it opens: the
source exists; every dimension and measure is one of its fields; a measure is used only with dimensions it allows
(`openingBalance` not by `category`); `depth` only on trees and `grain` only on time; `top` between 1 and 5,000; a
chart's measure exists; limits hold. A definition with a problem isn't offered, and the log says why once:
`[reports] Report "budget.vsActual": query.rows.dimension "lines" is not a field of source "budget.status"`.

---

## The engine

`shape(spec, source, result, compared?)`, in `@tessera/reports-api`, pure and deterministic:

1. **Filter** the rows by the query's filters (sources may filter too; filtering again costs little and keeps the rule
   in one place).
2. **Roll up trees** to the axis's depth: a category's rows add into its ancestor at that depth. With `depth: 'all'`,
   every level is a row and parents are subtotals, collapsible in the view. A category with its own transactions and
   children gets a "*Food* (other)" child, as the budget view draws it.
3. **Pivot** the column axis (months, quarters, years, dates) into columns, with every column in the period present
   even when empty, so months line up.
4. **Sort** and keep the **top** rows by their total; the rest are gathered into one *Other* row named with its count
   ("Other payees (143)"). Members with no id (*Uncategorised*, *No payee*) are never gathered into a table's *Other*,
   and come last.
5. **Totals and net:** a total row and column where asked, by each measure's `combine`: `sum` adds; `last` takes the
   last column (a balance); `none` uses the totals the source gave, or shows "—". A net row is Σ sign × value over
   some of a signed dimension's top members: *Net income* is Income − Expenses.
6. **Derived figures:** shares, averages, changes and running totals, each from integers:
   - a **share** is `⌊value × 10,000 ÷ total⌋` basis points, shown with one decimal (45.2 %). Shares round down, as the
     budget's percentages do, so a column of them may add to a little under 100 %;
   - an **average** over the columns is the total divided by their count, to the nearest minor unit, half up;
   - a **change** is the value less the compared value; **change in per cent** is in basis points of the compared
     value, and "—" when it is zero;
   - past `Number.MAX_SAFE_INTEGER` the engine uses `BigInt`, as the budget's bar does, and a figure that still can't
     be exact fails the run with `TOO_LARGE` rather than being wrong.
7. **The chart's series**, from the same rows: at most 12 series (or 8 slices, *Other* included), the smallest
   gathered as *Other*, whatever they are.
8. **Notes**: what the source said (currencies left out, archived months), and what the engine did ("Showing the top 25
   of 168 payees").

Comparing periods runs the source twice, once for each, and matches rows by their keys; a member only in one period
appears with "—" in the other. Comparing sub-ledgers runs it once, with a scope per column, and lays the scopes out as
the columns ([Reporting by sub-ledger](#reporting-by-sub-ledger)).

---

## The eight reports

Each is a definition: its source, its axes and measures, its chart, and its options. The examples use one household,
in CAD, over the whole ledger unless said; their figures agree with each other where they overlap.

### 1. Income vs Expenses

*Did we earn more than we spent, month by month?* Flows, **`flow`** on the rows to depth 2 (income and expenses, each
opened to its top-level categories), **months** across, `amount`, and a **Net income** row. A parent is drawn as a heading
above its children and a subtotal below them (*Total income*), as the budget view draws its groups. Chart: grouped
bars of income and expenses per month, with the net as a line. Default: *This year*.

```
Income vs Expenses · January to March 2026 · Whole ledger · CAD
                              Jan          Feb          Mar          Total
INCOME
  Salary                 4,200.00     4,200.00     4,200.00      12,600.00
  Interest                  12.40        11.85        12.10          36.35
Total income             4,212.40     4,211.85     4,212.10      12,636.35
EXPENSES
  Housing                1,500.00     1,500.00     1,500.00       4,500.00
  Food                     812.35       745.10       862.15       2,419.60
  Transportation           140.00       140.00       175.00         455.00
  Uncategorised                 —            —        41.00          41.00
Total expenses           2,452.35     2,385.10     2,578.15       7,415.60
Net income               1,760.05     1,826.75     1,633.95       5,220.75
```

- **Over a sub-ledger, transfers across its scope appear after *Net income*,** as *Transfers in* and *Transfers out*,
  each by the other account, followed by *Net after transfers*: the owner's pay from *Business Chequing* is money in
  for *Personal*, but not income it earned. Over the whole ledger there are none. See
  [Reporting by sub-ledger](#reporting-by-sub-ledger), which also shows sub-ledgers side by side.
- **Options:** *Detail* (totals only, top-level categories, every category: `flow` at depth 1, 2 or all); *Columns*
  (months, quarters, years); *Chart* (grouped bars, or none); *Leave out transfers across the accounts chosen* (a
  filter on `group`). *Compare with* offers *Sub-ledgers*.

### 2. Spending by Category

*Where did the money go?* Flows, the **expense** group, **categories** on the rows (top level, or the whole tree),
`amount` as *Spending* and its *Share*. Chart: a donut of eight slices, the smallest gathered as *Other*. Definition:
[above](#report-definitions).

```
Spending by Category · 2026 · Whole ledger · CAD
Category                    Spending     Share
Housing                    18,420.00    45.2 %
Food                        9,875.20    24.2 %
Transportation              4,310.50    10.5 %
Utilities                   3,204.80     7.8 %
Entertainment               1,986.40     4.8 %
Health                      1,104.60     2.7 %
Gifts                         702.15     1.7 %
Clothing                      498.25     1.2 %
Education                     234.00     0.5 %
Uncategorised                 412.00     1.0 %
Total                      40,747.90   100.0 %
```

(*Uncategorised* comes last in the table, whatever its size, as in the budget view. The shares round down, so they add
to a little under 100 %: 99.6 % here. The donut draws eight slices: the seven largest, and *Other* for *Clothing*,
*Uncategorised* and *Education*.)

- **Refunds lower spending**; a category refunded more than it was charged shows a negative figure, not hidden.
- *Compare with* offers *Sub-ledgers*: the household's spending beside the business's.
- **Options:** *Categories* (top level, or every category as a tree); *Show spent and refunded apart*. The *Compare
  with* parameter adds the earlier period's column and the change.

### 3. Spending by Payee

*Who gets the most?* Flows with **payees** (`byPayee`), the **expense** group, *Spending*, *Transactions* and *Share*,
the **top 25** and the rest as *Other payees*. Chart: horizontal bars of the top ten.

```
Spending by Payee · 2026 · Whole ledger · CAD
Payee                       Spending   Transactions     Share
Riverside Properties       18,000.00             12    44.1 %
FreshCo                     4,812.33             52    11.8 %
City Hydro                  1,490.20             12     3.6 %
Esso                        1,322.75             31     3.2 %
Corner Café                   684.50             57     1.6 %
Other payees (143)         14,201.72            412    34.8 %
No payee                      236.40              9     0.5 %
Total                      40,747.90            585   100.0 %
```

- Shown here with *Show: top 5*, for brevity; the default is the top 25.
- **The total is Spending by Category's**, for the same period and accounts: the same transactions, grouped another
  way. The tests hold the two reports to it.
- **A payee's spending is across categories**; *Show Transactions* on a row lists them.
- **Archived months keep their payees** (Q3), so archiving changes no payee's figure. A ledger archived before R1 has
  no totals kept at all (by payee or not), so its archived spending isn't in any report, and the note says so, with
  the archive file to open for it. (Corrected in R2: the first draft supposed totals without payees for those months.)
- **Options:** *Spending or income* (income lists who paid the user: the filter and the labels change together, so
  spending and income are never added up). **How many payees** is the user's (`top: 'user'`): *Show the top* in
  *Customise Report…*, else the Reports page's *Rows before "Other"*, 25 by default (R4; until then an option of its
  own, *Show*: top 5, 10, 25, 50 or every payee, so the definition is at version 2).

### 4. Net Worth

*Are we better off?* Balances at **every month end** of the period (`date` across), **`byType`** on the rows at depth
1 (*Assets* and *Liabilities*), and **Net worth** as the total row: a plain sum, since liabilities are negative.
Chart: assets as bars up, liabilities as bars down, and net worth as a line. Default: *Last 12 months*.

```
Net Worth · month ends, January to June 2026 · Whole ledger · CAD
                      31 Jan          28 Feb          31 Mar          30 Apr          31 May          30 Jun
Assets             48,210.55       49,876.20       51,102.85       53,640.10       54,980.45       56,311.70
Liabilities      -212,430.18     -211,905.62     -211,388.07     -210,842.55     -210,301.90     -209,770.33
Net worth        -164,219.63     -162,029.42     -160,285.22     -157,202.45     -155,321.45     -153,458.63
```

- **Liabilities are negative, in red,** as in the navigator; net worth is their plain sum. A mortgage makes it
  negative, and the report shows it so; the change (+10,761.00 over the five months) is the point.
- **Before an archive date**, balances are exact at month ends (archived totals are kept by month); a date in the
  middle of an archived month is taken at that month's end, with a note.
- **Options:** *Points* (month ends, quarter ends, year ends: the `date` axis's grain); *Detail* (classes, account
  types, accounts: `byType` at depth 1, 2 or 3; or **sub-ledgers**: `byPlace` at depth 1, a row and a line for the
  household's and the business's net worth); *Chart* (bars with a line, line only).

### 5. Account Balances

*What was in every account on a date?* Balances **as of** one date (default *Today*), **`byPlace`** on the rows: the
sub-ledger tree down to each account, with totals per sub-ledger and for the ledger, exactly as the navigator lays them
out. No chart by default (a horizontal bar chart is an option).

- **Currency:** *All currencies* is offered here: each account in its own, and a total per currency at each level.
- **Closed accounts** with a balance of zero are left out unless *Include closed accounts* is ticked.
- **Compare with** a date adds that date's balance and the change: *End of last year* against *Today*, say.
- **Options:** *Group by* (sub-ledgers, account types, none: `byPlace`, `byType` or `account`); *Include closed
  accounts*; *Chart*.

### 6. Cash Flow

*How much came into and went out of the everyday accounts, and what is left?* Flows over the **everyday accounts**
(chequing, savings, credit cards and lines of credit, Q6), **`flow`** on the rows, by **month**, with **balance
rows**: the opening and closing balances, which the flows source takes from `balanceHistory` at the period's edges:

```
Cash Flow · March 2026 · Everyday accounts · CAD
Opening balance                                    12,645.30
Income                                              4,212.10
  Salary                                            4,200.00
  Interest                                             12.10
Expenses                                            2,578.15
  Housing                                           1,500.00
  Food                                                862.15
  Transportation                                      175.00
  Uncategorised                                        41.00
Transfers out                                       1,500.00
  Retirement (RRSP)                                 1,500.00
Net                                                   133.95
Closing balance                                    12,779.25
```

(The same March as Income vs Expenses' above: the transfer to the retirement account counts here, because that account
is outside the everyday accounts, and not there, where the whole ledger is in scope.)

- **Opening + money in − money out + accounts opened = closing**, every month, always: the figures come from two
  sources (flows and balances), and the tests hold them to it. *Accounts opened* appears only when an account in scope
  opened in the period.
- **Transfers between everyday accounts don't count** (paying the Visa from chequing is neither in nor out); a
  transfer to the retirement account, the mortgage or a *Cash* account is money out.
- **Options:** *Detail* (groups, or top-level categories and accounts: `flow` at depth 1 or 2); *Columns*. And the
  *Accounts* parameter takes any scope: *Everyday accounts in Business* is the business's cash flow, and *Compare
  with: Sub-ledgers* sets the household's beside the business's.

### 7. Budget vs Actual

*How did the plan go?* **Contributed by the `budget` plugin** ([Adding a report from another plugin](#adding-a-report-from-another-plugin)),
on its own source, **`budget.status`**, which calls `budget.service.status`. So its figures are the budget view's, row
for row, with no second implementation of the budget's rules.

- **Parameters:** the **budget** (default: the one the budget view showed last), and a period of whole months: *This
  month*, *Year to date*, *This budget year*, or chosen months (at most 24, `STATUS_MONTHS_MAX`). The budget has its
  own scope and currency, so the report's *Accounts* and *Currency* aren't offered.
- **Rows** are the budget view's, in its order: lines, parent subtotals, *Other income* and *expenses*, *Other
  transfers*, *Uncategorised*; **columns** *Budget*, *Actual*, *Remaining* and *% used*; **totals** for income and
  expenses and the **Net**, whose Remaining is how far ahead of the plan the period is. Chart: budget against actual,
  as grouped bars, for the expense lines. (R5: the source gives one row for each status row that isn't a subtotal, in
  the status's own tree, and the engine adds up the subtotals and totals, which come out the status's; *% used* is
  worked out per cell, `percentOf`; the net reads Remaining the other way, `negate`. So nothing is `combine: 'none'`.)
- For March 2027 of the budget's *Household* ([budget-design.md](budget-design.md#the-budget-view)) it shows income
  7,215.00 budgeted against 7,362.40 actual, expenses 3,675.00 against 3,816.35 (Remaining −141.35, red), and the net
  6.05 ahead.
- **Options:** *Layout*: the period as a whole, or month by month (the Year grid's layout: months across and their
  total, the Budget, the Actual or what Remains in the cells); *Expense lines only*. **Offered only while the ledger
  has a budget** (`when: 'budget.hasBudgets'`). The budget view's *⋯* menu has *Show as Report*: the budget shown,
  over the months shown (R5).

### 8. Category Trends

*Is a habit creeping up?* Flows, the **expense** group, **categories** (the top six by total and *Other*), **months**
across, with *Total* and *Average a month* columns. Chart: a line per category (stacked areas as an option). Default:
*Last 12 months*.

```
Category Trends · January to June 2026 · Whole ledger · CAD · Categories: Food, in detail
                   Jan       Feb       Mar       Apr       May       Jun       Total   Average a month
Food            812.35    745.10    862.15    782.75    729.60    887.00    4,818.95            803.16
  Groceries     598.30    611.45    650.10    602.75    633.20    641.90    3,737.70            622.95
  Dining out    214.05    133.65    212.05    180.00     96.40    245.10    1,081.25            180.21
```

- **Categories** in the heading (`choose: ['category']`): the top six, or the ones the user picks, which a saved
  report keeps in its parameters. The example picks *Food*, every category beneath it.
- **Options:** *Detail* (top-level categories, every category); *Show* (spending, or income); *Columns* (months,
  quarters); *Chart* (lines, stacked areas). *Compare with* adds last year's line, dashed.
- Income vs Expenses above shows the same Food figures for January to March: the reports share one source.

---

## Archived months

*File › Archive Ledger…* removes reconciled and void transactions before a date, and carries their total into each
account's opening balance ([ledger-compaction-design.md](ledger-compaction-design.md)). Without help, every report of
a month before that date would lose those transactions: last year's spending would shrink, and last year's net worth
would be wrong.

The budget solved this for itself: the accounts participant shares `removedTotals`, and the budget keeps them in
`budget.archivedMonths`. **Reports can't read the budget's collections, and shouldn't depend on the budget being
installed.** So (R-9, Q2):

- **The accounts plugin keeps the totals of what it archives**, in its own `accounts.archivedMonths`, one document per
  account and month, **with payee entries as well** (Q3). Measured in R0, the entries are **flat arrays of numbers
  against one dictionary of ids** (`accounts.archivedIds`, appended to, never rewritten):

  ```ts
  interface ArchivedMonth {
    accountId: string
    month: string                           // 'YYYY-MM'
    name: string                            // the account's, when archived
    currency: string
    subLedgerId: string | null
    categories: number[]                    // [category, inflow, outflow, count, …]; category −1: uncategorised
    transfers: number[]                     // [other account, inflow, outflow, count, its sub-ledger (−1: the ledger), …]
    payees: number[]                        // [category, payee, inflow, outflow, count, …]; −1: none
  }                                         // every id its place in the dictionary
  ```

  Flat numbers make almost no objects for the kit to clone, serialise and collect: with payees, an archive before 2026
  at 100,000 keeps 1.82 MB of them, less than the budget's nested layout keeps without payees (1.88 MB), where nested
  payees took 5.5 MB and a second more stall ([R0](#3-payee-entries-in-archived-months)). It writes them in
  `applyArchive`, in the archive's storage transaction, from the documents it has already read.
- **An account the archive removes keeps a record** (`accounts.archivedAccounts`: its id, name, type, currency,
  sub-ledger, opening date, original opening balance and closing date), since its opening balance goes with it and
  its past balances couldn't be rebuilt otherwise. R0 found past net worth changed without it.
- **`accounts.service.archivedTotals(query)`** returns them as `ArchivedTotal`s (the shape `removedTotals` already
  has: with each account's currency and sub-ledger at the time, since an account may be gone), for the months asked.
  The flows source adds them to the live totals; they never overlap, as the budget relies on.
- **An account an archive removed keeps its name there** (`ArchivedTotal.accountName`), so a report of archived
  months by account still names it, marked *(closed, archived)*.
- **`balanceHistory` uses them too**: a balance at the end of an archived month is the original opening balance plus
  the archived totals to that month plus the live transactions to that date (unreconciled transactions before the
  archive date stay live). So **balances before an archive are exact at month ends**, and a date in the middle of an
  archived month is answered for the month's end, marked `exact: false`, and noted.
- **Archived totals are by month**, so a period that cuts an archived month in two (a custom period from 10 March,
  before the archive date) can't be split: that month's archived part is left out, and the note says so. It happens
  with custom dates, and with a year that starts mid-month (6 April) over archived years; other presets are whole
  months.
- **Nothing else changes for the budget.** It keeps its own copy until a later change lets it read the accounts'
  ([Later](#later)); the two hold the same totals, and the archive invariant is tested on both.
- **Ledgers archived before R1** have no archived totals in `accounts`. Flows for those months show what is left in
  the ledger, with a note: "Transactions archived before 1 Jan 2026 were archived before reports could keep their
  totals; open the archive file to report on them." **Balances before such an archive are left out rather than
  wrong**: `accounts` knows an account's history is incomplete when `Account.archived.countWithTotals` (how many of
  `archived.count` were archived with their totals kept, voided ones included) is less than `archived.count`, and gives
  no point for a date before its last archive date; after it, the balance starts from the opening balance the archives
  carried everything into. The archive file still has every transaction,
  and reporting on it is possible (it opens read-only).
- **The report manager itself keeps nothing about transactions**, so it takes no part in archives.

---

## The accounts additions

Generic, in `@tessera/accounts-api` **1.15**, with no visible change (R1). Each is for any plugin; none mentions
reports.

```ts
// @tessera/accounts-api 1.15

export interface TotalsQuery {
  from: string
  to: string
  accountIds?: string[]
  includeTransfers?: boolean
  /** Also group by payee: each row then has `payeeId` (null for none). Default false. (Since 1.15.) */
  byPayee?: boolean
}

export interface TransactionTotal {
  // … as in 1.13
  /** With `byPayee`: the payee, or null for none. Absent otherwise. (Since 1.15.) */
  payeeId?: string | null
}

export interface ArchivedTotal extends TransactionTotal {
  // … currency, subLedgerId, transferSubLedgerId, as in 1.13
  /** The account's name when it was archived: an archive may remove a closed account, and its name with it. (Since 1.15.) */
  accountName?: string
}

/** `AccountsService.balanceHistory`: which balances, at which dates. (Since 1.15.) */
export interface BalanceQuery {
  /** YYYY-MM-DD, at most BALANCE_DATES_MAX (240), in any order. */
  dates: string[]
  /** Default: every account, closed ones included. */
  accountIds?: string[]
}

export interface BalancePoint {
  accountId: string
  date: string
  /** Minor units: the opening balance plus every non-voided transaction dated on or before `date`. */
  balance: number
  /** False when `date` falls inside a month an archive removed transactions from: `balance` is that month's end. */
  exact: boolean
  /** The account is one an archive removed: its history comes from the record the archive kept. (R1.) */
  removed?: true
}

export interface AccountArchived {
  // … count, originalOpeningBalance, highestNumber, as before
  /** How many of `count` were archived with their totals kept (every archive since 1.15), voided ones included. (R1.) */
  countWithTotals?: number
}

export interface AccountsService {
  // …
  /**
   * Balances at each date, for accounts open by then: none before an account's opening date, and none before its last
   * archive date when what was archived wasn't all kept as totals (archived before 1.15). (Since 1.15.)
   */
  balanceHistory(query: BalanceQuery): Promise<BalancePoint[]>
  /**
   * What archives removed, totalled as `transactionTotals` totals (by payee too with `byPayee`; transfers, which aren't
   * kept by payee, with a null `payeeId`), for the months of `from` to `to`, with where each account was at the time.
   * Empty for a ledger never archived, or archived before 1.15. (Since 1.15.)
   */
  archivedTotals(query: TotalsQuery): Promise<ArchivedTotal[]>
}

export interface PayeeDirectory {
  search(prefix: string, limit?: number): Promise<PayeeSuggestion[]>
  /** The payees with these ids, in one read; ids that don't exist are left out. (Since 1.15.) */
  get(ids: string[]): Promise<Payee[]>
}

export interface AccountsService {
  // …
  /** The records archives kept of the accounts they removed: name, type, currency, where, opening. (1.15, added in R2.) */
  removedAccounts(): Promise<RemovedAccount[]>
}

// The scope rule, shared by budgets and reports (pure, rules.ts)
export type AccountScopeInput =
  | { kind: 'ledger' } | { kind: 'subLedger', subLedgerId: string }
  | { kind: 'types', types: AccountType[], subLedgerId?: string } | { kind: 'accounts', accountIds: string[] }
export interface AccountScope {
  covers(account: { id: string, subLedgerId: string | null, type?: AccountType }): boolean
  inside: ReadonlySet<string>          // every currency: a transfer with one of these stays inside
  counted: ReadonlySet<string>         // inside and in the currency
  notCounted: { accountId: string, name: string, currency: string }[]
}
export function accountScope(input: AccountScopeInput, subLedgers: readonly TreeNode[], accounts: readonly Account[], currency: string): AccountScope
/** Whether a transfer total crosses the scope: its other account is outside (judged where it was, if it is gone). */
export function crossesScope(total: TransactionTotal | ArchivedTotal, scope: AccountScope, exists: (id: string) => boolean): boolean
```

- **How `balanceHistory` reads** (measured in R0): one `find` of the transactions dated up to the last date asked; each
  non-voided one added into its account's bucket for the first date on or after it (a binary search over the dates);
  then running sums from each account's original opening balance, archived months adding their net at their month's
  end. No sort and no cache: **187 to 291 ms for 120 month ends at 100,000**, 38 to 94 ms after an archive, against 7
  to 11 s through every register. **Accounts an archive removed are included**, from their records, so past net worth
  doesn't change.
- **`transactionTotals` sorts by one precomputed key** (found in R0): `compareTotals` compares up to four ids for each
  comparison, and took half the method's time at 100,000 (94 ms against 25 ms for 9,533 rows, in the same order).
- **`byPayee` costs nothing when not asked,** and about 10 ms for a year at 100,000 when asked (85 to 108 ms in all);
  rows grow 1.76 times ([R0](#1-totals-by-payee)).
- **`payees.get`** is the lookup the budget's Transactions dialog wanted too ([todo.md](todo.md)).

---

## Adding a report from another plugin

A plugin adds a report in one of two ways. Both are plain contributions; neither needs a renderer, and neither needs
the `reports` plugin to be installed.

**1. A definition on an existing source.** A plugin that wants *Spending by Account* needs no data of its own:

```ts
import { REPORT_DEFINITIONS_POINT, type ReportDefinitionContribution } from '@tessera/reports-api'

const BY_ACCOUNT: ReportDefinitionContribution = {
  id: 'card-tools.spendingByAccount', label: 'Spending by Account',
  description: 'Which card or account the spending went through.',
  group: 'reports.group.spending', version: 1,
  spec: {
    specVersion: 1, source: 'reports.flows',
    parameters: { period: { preset: 'thisYear' }, scope: { kind: 'ledger' }, currency: 'mostUsed' },
    query: { filters: [{ dimension: 'group', in: ['expense'] }], rows: { dimension: 'account', sort: 'valueDesc' },
             measures: [{ measure: 'amount', label: 'Spending' }, { measure: 'count', label: 'Transactions' }] },
    presentation: { show: 'both', table: { totals: { row: true } }, chart: { kind: 'bar', measure: 0, horizontal: true } }
  }
}
context.subscriptions.push(context.extensions.contribute('card-tools', REPORT_DEFINITIONS_POINT, BY_ACCOUNT.id, BY_ACCOUNT))
```

**2. A source of its own, with definitions on it.** The budget plugin does this for Budget vs Actual (R5): it
describes what `budget.service.status` can answer, and provides a `ReportSource` over it.

```ts
import {
  REPORT_DEFINITIONS_POINT, REPORT_GROUPS_POINT, REPORT_SOURCES_POINT,
  type ReportSource, type ReportSourceContribution
} from '@tessera/reports-api'

const STATUS_SOURCE: ReportSourceContribution = {
  id: 'budget.status', label: 'Budget', service: 'budget.reportSource',
  time: 'months',                       // whole months only
  maxPeriods: STATUS_MONTHS_MAX,        // 24
  scopes: 'none',                       // the budget has its own scope…
  currency: false,                      // …and currency
  // Its members() lists the budgets for this parameter, the one the budget view showed last marked as the default
  parameters: [{ key: 'budget', label: 'Budget', kind: 'member' }],
  drillDown: true,
  // As built (R5): the lines a signed tree under Income and Expenses, red below zero under Expenses; Remaining adds up
  // like the rest; % used is the spec's (`percentOf`); a plan has nothing behind it to list
  fields: [
    { kind: 'dimension', key: 'line', label: 'Line', type: 'member', tree: true, signed: true,
      values: [{ id: 'income', label: 'Income', sign: 1 }, { id: 'expense', label: 'Expenses', sign: -1, negativeIsBad: true }] },
    { kind: 'dimension', key: 'group', label: 'Income or expense', type: 'enum', signed: true,
      values: [{ id: 'income', label: 'Income', sign: 1 }, { id: 'expense', label: 'Expenses', sign: -1, negativeIsBad: true }] },
    { kind: 'dimension', key: 'month', label: 'Month', type: 'time' },
    { kind: 'measure', key: 'budget', label: 'Budget', unit: 'money', combine: 'sum', drillDown: false },
    { kind: 'measure', key: 'actual', label: 'Actual', unit: 'money', combine: 'sum' },
    { kind: 'measure', key: 'remaining', label: 'Remaining', unit: 'money', combine: 'sum', drillDown: false }
  ]
}

const source: ReportSource = {
  async query(request) { /* budgets.status(id, months, { byMonth }) → a row per line by month, the lines as a tree, subject, currency */ },
  async members(request) { /* the budgets, for the Budget parameter, the one the budget view shows as the default */ },
  async transactions(request) { /* the budget's own rowsTransactions: what its Transactions dialog lists, signed for a net */ },
  onDidChange: listener => budgets.onDidChange(() => listener())
}

context.subscriptions.push(
  context.services.provide('budget', 'budget.reportSource', source),
  context.extensions.contribute('budget', REPORT_SOURCES_POINT, STATUS_SOURCE.id, STATUS_SOURCE),
  context.extensions.contribute('budget', REPORT_GROUPS_POINT, 'budget.group', { id: 'budget.group', label: 'Budgets', order: 30 }),
  context.extensions.contribute('budget', REPORT_DEFINITIONS_POINT, VS_ACTUAL.id, VS_ACTUAL)
)
```

- **The source is a service in the main process**, declared in `services.provides` like any other, and looked up by
  the report manager when a report on it runs. A source whose service isn't there (its plugin failed to start) makes
  its reports unavailable, with a warning logged once, as an export format's does.
- **Answer what is asked, at the grain asked**, and only for the period asked. Return member labels and trees; never
  formatted amounts. Apply your own rules (the budget's lines, its scope) so that no other code repeats them.
- **Time limit: 10 seconds** a query (`SOURCE_TIMEOUT_MS`); a run that passes it is reported as *The report took too
  long*, and the source is not called again until the user refreshes.
- **Follow your data** with `onDidChange`, so shown reports refresh.
- **Ids start with your plugin id**, as for every contribution: sources, groups, definitions. A contribution that
  doesn't is skipped with a `[reports]` warning.
- **Test with the engine:** `@tessera/reports-api` exports `specProblems` and `shape`, so a plugin can validate its
  definitions and shape a result from fixture rows without the report manager.

The plugin guide gains *Adding a report* with these two examples (R5: done, [plugin-creation.md](plugin-creation.md#adding-a-report); a test runs each).

---

## The Reports tab and the report view

**The Reports tab** (`reports.list`, in the left bar beside Accounts and Budgets, with the standard `ShowChart` icon)
lists every report offered, under its group, then the user's saved reports under **My Reports**. Clicking one shows it
in the report view. Each has a tooltip with its description. A saved report's context menu has *Rename…*, *Duplicate…*
and *Delete…*.

**The report view** (`reports.view`, in the main area) shows one report:

```
┌ File  View  Accounts  Budget  Reports  Tools  Help ────────────────────────────────────────────────────────────────────┐
│ [Accounts][Budgets][Reports]  │ Spending by Category                               [Customise…] [Save As…] [⋯]         │
│ INCOME AND SPENDING           │ Period [This year ▾] 1 Jan – 31 Dec 2026  Accounts [Whole ledger ▾]  Currency [CAD ▾]  │
│  Income vs Expenses           │ Compare with [Nothing ▾]                                     [Chart] [Table] [Both]    │
│ ▸Spending by Category         │ ┌─────────────────────┐  Category                    Spending     Share                │
│  Spending by Payee            │ │      ▄▄▄▄▄▄         │  Housing                    18,420.00    45.2 %                │
│  Category Trends              │ │   ▄██ Housing ██▄   │  Food                        9,875.20    24.2 %                │
│  Cash Flow                    │ │  ██ Food    ▀▀███   │  Transportation              4,310.50    10.5 %                │
│ NET WORTH AND BALANCES        │ │   ▀██  ▀▀▀▀ ██▀     │  Utilities                   3,204.80     7.8 %                │
│  Net Worth                    │ │      ▀▀▀▀▀▀         │  …                                                             │
│  Account Balances             │ └─────────────────────┘  Total                      40,747.90   100.0 %                │
│ BUDGETS                       │ Not counted: US Visa, in USD.                                                          │
│  Budget vs Actual             │                                                                                        │
│ MY REPORTS                    │                                                                                        │
│  Groceries this year          │                                                                                        │
├───────────────────────────────┴────────────────────────────────────────────────────────────────────────────────────────┤
│ Ledger: Home Finances                                                                                                  │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **The heading** names the report (a saved report's own name, with its definition under it), and holds its
  **parameters**: *Period* (or *As of*), *Accounts*, *Currency*, *Compare with*, and any the source declares
  (*Budget*). Changing one runs the report again at once. *Page Up* and *Page Down* step the period.
- **The body** is the chart above the table, or either alone (remembered per report). The table uses
  `@tessera/ui`'s `Table`, amounts in the `numeric` font role, right-aligned, negative amounts in `error.main` where
  the report says they are bad (over budget, what is owed), column widths in `em` so larger text widens them, and the
  table scrolls sideways rather than cutting an amount short. Trees expand and collapse (remembered per report).
- **Notes** (currencies left out, archived months, the top rows kept) are under the table, as the budget view's are.
- **Empty and failing states:** with no ledger open, "Open a ledger to see its reports."; with nothing in the period,
  "Nothing was spent from these accounts in this period." (each definition's own words, `emptyText`); a source that
  failed or timed out shows its message with *Try Again*. A failed report never leaves an old result on screen as if
  current: it says what it shows ("Showing the figures from 10:42").
- **Keys:** `↑` `↓` rows, `←` `→` collapse and expand, `Ctrl+Enter` (or double-clicking a figure) *Show Transactions*,
  `F5` *Refresh*, `Ctrl+P` *Print…*; `Shift+F10` the row's context menu.
- **One report at a time**, in one view, as the main area shows one view: showing another replaces it. Tabs and back
  and forward in the main area are the layout's, later.
- **The view follows what is shown**: the plugin keeps which report, with which parameters, per window, and publishes
  `reports.shown` for commands.

---

## The transactions behind a figure

*Show Transactions* on a cell opens a dialog (`reports.dialog.transactions`) listing what makes up that figure: date,
account, payee, category or transfer, amount, in date order, each with *Open Register* (`accounts.register.open`), as
the budget's Transactions dialog does. **What a figure stands for is said by its row and its column** (R3): a row
carries `drill` (the row dimension's keys it gathers: a member and, on a tree, what is beneath it; a parent's own alone;
what *Other* gathers; nothing for a total, which is everything; `signed` for a net), and a column carries `drill` (its
measure, and its months, its member, its sub-ledger side by side, or the period compared with). The engine makes both
when the source says `drillDown`. The report manager puts them together with **the run's own plan** (its period,
scope, currency and filters: `planRun`) into the `DrillRequest` the source's `transactions(request)` answers, so a list
can't disagree with its figure about what it covers. Figures that are no sum of transactions (a balance, an average, a
change, a share's percentage) carry no column drill, and can't be listed.

- **Flows** read `accounts.service.transactions(id).list({ from, to })` for each counted account, make each
  transaction a total of one, keep those the same classifier puts in the figure (its pieces matched by the figure's
  keys, with the report's filters), each with its part of the figure, and a net's with its sign, so the list adds up
  to the figure; payees and categories are named as the register names them.
- **Archived amounts can't be listed**; the dialog says how much of the figure they are ("412.00 of it was archived
  before 1 Jan 2026").
- **At most 1,000 transactions** are listed; past that, the dialog says how many there are and suggests a narrower
  period.
- **Balances** drill into the account's register at that date. **Budget vs Actual** uses the budget's own.
- *Other* and total rows drill into everything they gather.

---

## Customising and saving reports

**Customise Report…** (`reports.dialog.customise`) draws the definition's **options** (a radio group for a choice, a
check box for a boolean, as the Export dialog draws a format's options) and, under them, the general ones every report
has: *Open on* (chart, table, both) and, for a row axis with `top`, *Show the top* (a number, or every row). Applying runs the report
with the options; nothing is saved.

- **Show the top travels with the option values** (R4), under a key no definition's option can have (`TOP_OPTION`,
  `'@top'`: theirs start with a letter), so a saved report, a run and the dialog carry it with nothing more. Left at
  its default it isn't kept.
- **An axis may take its top from the user** (R4): `top: 'user'` is the report's own *Show the top* if customised,
  else the Reports page's *Rows before "Other"* (25 by default). Spending by Payee does, so it has no *Show* option of
  its own; Category Trends keeps its six lines, and *Show the top* still changes them for one report.

**Save Report As…** (`reports.dialog.save`) asks for a name (unique in the ledger, ignoring case, at most 100
characters, as ledger names) and saves, **in the ledger**, what is needed to run it again:

```ts
export interface SavedReport {
  id: string
  name: string
  /** A definition, customised; or (for the designer) a spec of its own. */
  basis:
    | { kind: 'definition', definitionId: string, definitionVersion: number, options: Record<string, string | boolean> }
    | { kind: 'spec', spec: ReportSpec }
  /** As chosen in the heading. A preset period stays a preset. Account and sub-ledger ids are allowed here. */
  parameters: ReportParameters
  /** What the user chose to see: the chart, the table, or both; which rows were collapsed. */
  view?: { show?: 'chart' | 'table' | 'both', collapsed?: string[] }
  notes?: string
  createdAt: string
  updatedAt: string
  rev: number
}
```

- **In the ledger** (Q8), because parameters name accounts and sub-ledgers, which mean nothing in another ledger; so
  backups, restores and archive files carry them, as they carry budgets. A read-only ledger shows its saved reports
  and can run them, and offers no *Save*.
- **A customised report follows its definition**: it keeps the definition's id and the option values, not a copy of
  the spec, so an improvement to Spending by Category reaches the user's saved copy. If the definition's `version` has
  moved on, option values it no longer offers fall back to their defaults, with a note.
- **A saved report whose definition is gone** (its plugin was removed or disabled) stays in *My Reports*, greyed,
  saying which plugin it needs: a definition's id starts with its plugin's id, so that is known without the plugin
  ("Needs the “budget” plugin").
- **`basis.kind: 'spec'`** is for reports with a spec of their own, which only the designer will make. R4 builds it
  into the store, the validation and the run, and tests it, so the designer adds no storage.
- ***Save Report*** saves changes to the saved report shown, over the report as it was when shown: if it was changed
  elsewhere since (another plugin, another window), Save is refused and says so, rather than overwriting it (R4).
  *Rename…*, *Duplicate…* and *Delete…* (with the native confirmation) are in the Reports tab's context menu (with F2
  and Delete) and the *⋯* menu.
- **What isn't saved:** what the user last chose for a definition they didn't save (its period, accounts, options,
  chart or table, rows folded) is remembered as application state, per ledger, and used next time it opens
  (`context.state`, kept for the 50 ledgers used last, as the budget keeps the budget shown). *Accounts* carried from
  the report shown before still wins (R3), and what no longer fits is left out: an option no longer offered, a
  sub-ledger or account gone (R4). An archive file's choices aren't kept: it isn't the ledger.

---

## The Reports menu, commands and context keys

| Command | Menu (Reports) | Argument | Enablement |
|---|---|---|---|
| `reports.showList` | Show Reports | | `ledger.isOpen` |
| `reports.show` | (the items below, and other plugins) | `{ definitionId } \| { savedId }`, optional `parameters` | `ledger.isOpen` |
| `reports.show.<definition id>` | one item per definition, under its group | | `ledger.isOpen` and the definition's `when` |
| `reports.customise` | Customise Report… | | `reports.shown` |
| `reports.save` | Save Report | | `reports.shownSaved && reports.changed && !ledger.isReadOnly` |
| `reports.saveAs` | Save Report As… | | `reports.shown && !ledger.isReadOnly` |
| `reports.refresh` | Refresh (`F5` in the view) | | `reports.shown` |
| `reports.exportCsv` | Export Report… (R6) | | `reports.shown` and the report view in front (`shell.layout.main.activeView == 'reports.view'`) |
| `reports.print` | Print Report… (`Ctrl+P`, R6) | | `reports.shown` and the report view in front (`shell.layout.main.activeView == 'reports.view'`) |
| `reports.savePdf` | Save Report as PDF… (R6) | | `reports.shown` and the report view in front (`shell.layout.main.activeView == 'reports.view'`) |
| `reports.saved.rename`, `.duplicate`, `.delete` | (Reports tab, *⋯* menu) | `{ id? }`: else the saved report shown | `ledger.isOpen && !ledger.isReadOnly` |

```
Reports
├── Show Reports
├── ───────────
├── Income and Spending ▸ ├── Income vs Expenses
│                         ├── Spending by Category
│                         ├── Spending by Payee
│                         ├── Category Trends
│                         └── Cash Flow
├── Net Worth and Balances ▸ ├── Net Worth
│                            └── Account Balances
├── Budgets ▸ └── Budget vs Actual                      (from the budget plugin)
├── ───────────
├── Customise Report…
├── Refresh Report                                       (R3)
├── ───────────
├── Save Report
├── Save Report As…
├── ───────────
├── Export Report…
├── Print Report…
└── Save Report as PDF…
```

- **A top-level *Reports* menu**, among the plugin menus after *Budget* (Q1). The budget's *Planning* menu to-do is
  answered *no*: planning and reporting are different jobs, and Budget vs Actual is reachable from both the Reports
  menu and (through `reports.show`) from the budget view's *⋯* menu.
- **Each definition becomes a menu item as it is contributed.** Menu items name a command with no arguments, and the
  menu is built once, after every plugin has activated. So the report manager, as each definition reaches
  `reports.definitions` (the registry says so at once, and every plugin contributes during activation), registers a
  command `reports.show.<definition id>` and contributes an item under the group's submenu. A definition contributed
  after start-up is in the Reports tab at once, and in the menu after a restart, like any menu contribution; one
  withdrawn has its command unregistered, so its item is disabled until then.
- **Saved reports are not in the menu** (they change while Tessera runs); they are in the Reports tab.

| Context key | Meaning |
|---|---|
| `reports.shown` | The id of the definition or saved report the view shows, or unset |
| `reports.shownSaved` | A saved report is shown |
| `reports.changed` | The shown saved report's parameters, options, chart or table, or rows folded differ from what was saved (R4: also the catalog's `changed`, for the view's *⋯* menu) |
| `reports.hasSaved` | The open ledger has saved reports |

---

## The contract: `@tessera/reports-api`

The package holds what the report manager, the plugins that contribute reports, and the views share: ids and
channels, the source, definition and result types, errors, and the pure code (validation, periods, the engine). It has
no storage or Electron in it.

```ts
// @tessera/reports-api
export const REPORTS_PLUGIN_ID = 'reports'
export const REPORTS_SERVICE = 'reports.service'
export const REPORTS_MIGRATOR_SERVICE = 'reports.migrator'
export const REPORT_SOURCES_POINT = 'reports.sources'
export const REPORT_DEFINITIONS_POINT = 'reports.definitions'
export const REPORT_GROUPS_POINT = 'reports.groups'
export const REPORTS_SCHEMA_VERSION = 1
export const REPORT_SPEC_VERSION = 1

// Limits (R-22)
export const REPORT_ROWS_MAX = 5_000
export const REPORT_SERIES_MAX = 12
export const REPORT_SLICES_MAX = 8
export const REPORT_COLUMNS_MAX = 120          // months (ten years), or quarters, or years
export const REPORT_CELLS_MAX = 25_000         // rows × figures: past it, the top rows that fit, and a note (R0)
export const REPORT_DATES_MAX = 240            // as accounts-api's BALANCE_DATES_MAX (R2: its own name, so a plugin can import both)
export const DRILL_ROWS_MAX = 1_000
export const SOURCE_TIMEOUT_MS = 10_000
export const REFRESH_DEBOUNCE_MS = 250

// ---- Groups: headings in the Reports tab and submenus of the Reports menu
export interface ReportGroupContribution { id: string, label: string, order?: number }

// ---- Sources
export interface ReportSourceContribution {
  id: string                                   // '<pluginId>.<name>'
  label: string
  description?: string
  service: string                              // the ReportSource service
  /** 'range': flows between two dates; 'months': whole months only; 'asOf': how things stood at dates. */
  time: 'range' | 'months' | 'asOf'
  maxPeriods?: number                          // months or dates one query may cover
  /** Which scopes it takes; 'none' when it has its own (a budget). Default: all. */
  scopes?: ScopeKind[] | 'none'
  /** Default true: it reports in one currency, chosen by the user. */
  currency?: boolean
  parameters?: SourceParameter[]
  drillDown?: boolean
  fields: ReportField[]
}

export type ScopeKind = 'ledger' | 'subLedger' | 'types' | 'accounts'

/** A parameter of the source's own: its choices come from the source's `members({ parameter })`. */
export interface SourceParameter { key: string, label: string, kind: 'member' | 'choice', choices?: { value: string, label: string }[] }

export type ReportField = DimensionField | MeasureField

export interface DimensionField {
  kind: 'dimension'
  key: string
  label: string
  type: 'time' | 'member' | 'enum'
  /** Members form a tree: rows roll up to a depth. */
  tree?: boolean
  /** Members carry a sign (+1 or −1) for net rows. */
  signed?: boolean
  /** Enum values, with labels and signs; for a signed tree, its top members (which keep their order). */
  values?: { id: string, label: string, sign?: 1 | -1, negativeIsBad?: boolean }[]   // negativeIsBad: red beneath it (R5)
  /** The label of a row whose key is null: "Uncategorised", "No payee". (R2.) */
  noneLabel?: string
  /** The plural, for *Other*: "Other payees (143)". (R2.) */
  plural?: string
}

export interface MeasureField {
  kind: 'measure'
  key: string
  label: string
  /** 'percent' figures are basis points, from the source (a budget's % used). */
  unit: 'money' | 'count' | 'percent'
  /** 'sum' adds; 'last' adds across members, takes the last across time (a balance); 'none': the source totals. */
  combine: 'sum' | 'last' | 'none'
  /** The dimensions it may be broken down by. Default: all. */
  dimensions?: string[]
  /** A figure of it is bad when negative (what is owed), for colouring. (R2.) */
  negativeIsBad?: boolean
  /** False: its figures have nothing behind them to list (a budget's plan), whatever the source's drillDown. (R5.) */
  drillDown?: boolean
}

/** The service behind a source. Runs in the main process. */
export interface ReportSource {
  query(request: SourceQuery): Promise<SourceResult>
  /** A dimension's members, or a parameter's choices: for pickers, labels and filters. */
  members(request: MembersRequest): Promise<Member[]>
  /** The transactions behind a figure; only when the contribution says `drillDown`. */
  transactions?(request: DrillRequest): Promise<DrillResult>
  /** Anything the source reports on changed: shown reports on it refresh. */
  readonly onDidChange?: Event<void>
}

export interface SourceQuery {
  sourceId: string
  period: { from: string, to: string } | { dates: string[] }
  scope?: ScopeValue
  /** Compare with: Sub-ledgers. One scope per column; each row then says which (`scope`, an index). Read once. */
  scopes?: ScopeValue[]
  currency?: string                            // absent for 'all' (each account's own) and for sources without one
  /** The grain: the dimensions the rows must be keyed by, in this order. */
  dimensions: string[]
  measures: string[]
  filters: Filter[]
  parameters: Record<string, string>
}

export interface SourceResult {
  /** keys in `dimensions` order (null: none, e.g. no payee); values in `measures` order. */
  rows: { keys: (string | null)[], values: number[], currency?: string, scope?: number }[]
  /** The members of each dimension that appear, with labels, trees and signs. */
  members: Record<string, Member[]>
  /** For measures with combine 'none': the source's totals, by the rolled-up keys ('' for the grand total). */
  totals?: Record<string, number[]>
  notes: ReportNote[]
  /** A source with a scope and currency of its own (a budget's) says what and which, for the subtitle (R5). */
  subject?: string
  currency?: string
}

export interface Member {
  id: string, label: string, parentId?: string | null, sign?: 1 | -1, order?: number, isDefault?: boolean
  /** It stands for nothing in particular (Uncategorised under Income): last, and never gathered into Other. (R2.) */
  none?: boolean
}
export interface ReportNote { tone: 'info' | 'warning', text: string }

export interface MembersRequest {
  sourceId: string
  /** A dimension's members, or a source parameter's choices. */
  dimension?: string
  parameter?: string
  scope?: ScopeValue
  parameters: Record<string, string>
}

/**
 * What one figure stands for (1.1, R3): per dimension, the keys a transaction must have one of (a tree's take in what is
 * beneath them, except in `own`); `signed`, the dimension whose signs a net's parts take. A dimension not named is any.
 */
export interface DrillKey { keys: Record<string, (string | null)[]>, own?: string[], signed?: string }
/** The run's query over the figure's period, in its one scope (a sub-ledger column's), for its keys and measure. */
export interface DrillRequest extends Omit<SourceQuery, 'dimensions' | 'measures' | 'scopes'> { key: DrillKey, measure: string, limit: number }
export interface DrillResult {
  transactions: { id: string, accountId: string, accountName: string, date: string, amount: number,
                  payee?: string, label?: string, currency: string }[]
  /** How many there are in all: more than `transactions` when the limit was reached. */
  total: number
  /** The part of the figure that archived transactions make up, which can't be listed. */
  archived?: { amount: number, before: string }
}

// ---- Definitions and specs
export interface ReportDefinitionContribution {
  id: string
  label: string
  description: string
  group: string
  order?: number
  icon?: string
  when?: string
  version: number
  spec: ReportSpec
  options?: ReportOption[]
  /** What the view says when there is nothing to show. */
  emptyText?: string
}

export interface ReportSpec {
  specVersion: number
  source: string
  parameters: ParameterDefaults
  query: ReportQuery
  presentation: Presentation
}

export interface ParameterDefaults {
  period?: PeriodValue
  asOf?: AsOfValue
  scope?: ScopeValue
  currency?: 'mostUsed' | 'all' | string
  compare?: 'none' | 'previousPeriod' | 'previousYear' | 'subLedgers' | { asOf: AsOfValue }
  /** What *Compare with* offers; default none. 'subLedgers' only on a range source with scopes, columns not by time. */
  compareOptions?: ('previousPeriod' | 'previousYear' | 'subLedgers' | 'asOf')[]
  source?: Record<string, string>
  /** Dimensions whose members the user may pick in the heading. */
  choose?: string[]
}

export type PeriodValue =
  | { preset: 'thisMonth' | 'lastMonth' | 'thisQuarter' | 'lastQuarter' | 'thisYear' | 'lastYear' | 'yearToDate'
      | 'last3Months' | 'last12Months' | 'allDates' }
  | { from: string, to: string }

/** One date; or the end of each month, quarter or year (the `date` axis's grain) in a period: Net Worth's points. */
export type AsOfValue =
  | { at: 'today' | 'endOfLastMonth' | 'endOfLastYear' } | { date: string }
  | { ends: PeriodValue }

export type ScopeValue =
  | { kind: 'ledger' } | { kind: 'subLedger', subLedgerId: string }
  | { kind: 'types', types: AccountType[], subLedgerId?: string }     // *Everyday accounts in Business*
  | { kind: 'accounts', accountIds: string[] }

export type Filter = { dimension: string, in: string[] } | { dimension: string, notIn: string[] }

export interface ReportQuery {
  filters?: Filter[]
  rows?: Axis
  columns?: Axis
  measures: MeasureUse[]
}

export interface Axis {
  dimension: string                            // time only across the columns (R2)
  depth?: number | 'all'
  /** Time's grain: the engine buckets the source's months by the ledger's year start (R2). */
  grain?: 'month' | 'quarter' | 'year'
  /** A signed tree's top members keep their order whatever the sort; what is beneath them is sorted (R2). */
  sort?: 'natural' | 'label' | 'valueDesc' | 'valueAsc'
  top?: number | 'user'                       // 'user': the user's (Show the top, or the Reports page's Rows before "Other"): R4
  empty?: 'hide' | 'show'
  /** 'below': each top member a heading, its children, then "Total …", as the budget view draws groups (R2). */
  subtotals?: 'above' | 'below'
}

export interface MeasureUse {
  measure: string
  label?: string
  show?: 'value' | 'share' | 'compared' | 'change' | 'changePercent' | 'average' | 'cumulative' | 'percentOf'
  /** For 'percentOf' (R5): the measure it is a share of, in each cell (a budget's % used: actual of budget). */
  of?: string
}

export interface Presentation {
  show: 'chart' | 'table' | 'both'
  table: {
    totals?: { row?: boolean, column?: boolean, label?: string }
    /** Net rows over a signed dimension's top members: Σ sign × value over `of` (default all), drawn after `after`. */
    /** negate (R5): measures the net reads the other way (a budget's Remaining: how far ahead of the plan). */
    nets?: { label: string, of?: string[], after?: string, negate?: string[] }[]
    balanceRows?: boolean
  }
  chart?: ChartSpec
}

export type ChartSpec =
  | { kind: 'bar' | 'stackedBar' | 'groupedBar' | 'line' | 'area', measure: number, series?: 'rows' | 'measures',
      horizontal?: boolean, line?: { row: 'net' | 'total' },
      /** With series 'measures' (R5): figures side by side; `under`: the rows under a top member are the bars. */
      measures?: number[], under?: string,
      /** The most series drawn (or, with no columns, bars: Spending by Payee's top ten). (R2.) */
      limit?: number }
  | { kind: 'donut', measure: number, slices?: number }

export interface ReportOption {
  key: string
  label: string
  description?: string
  kind: 'choice' | 'boolean'
  default: string | boolean
  choices?: { value: string, label: string, patch: SpecPatch }[]
  /** For a boolean: applied when true. */
  patch?: SpecPatch
}
/** A JSON merge patch (RFC 7396) over `query` and `presentation`. */
export interface SpecPatch { query?: object, presentation?: object }

// ---- Running, and results
export type ReportRef = { definitionId: string } | { savedId: string }

export interface ReportParameters {
  period?: PeriodValue
  asOf?: AsOfValue
  scope?: ScopeValue
  currency?: 'mostUsed' | 'all' | string
  compare?: ParameterDefaults['compare']
  source?: Record<string, string>
  /** The members picked, by dimension (ids: a saved report keeps them). */
  chosen?: Record<string, string[]>
}

export interface ReportResult {
  title: string
  /** 'January to December 2026 · Whole ledger · CAD'. */
  subtitle: string
  /** null with 'all' currencies: each row's own. */
  currency: string | null
  period: { from: string, to: string } | { dates: string[] }
  columns: ResultColumn[]
  rows: ResultRow[]
  chart?: ResultChart
  notes: ReportNote[]
  /** When the figures were worked out (ISO 8601): the view says it when it can't refresh. */
  at: string
}

export interface ResultColumn {
  key: string
  label: string
  /** 'percent' values are basis points. */
  unit: 'money' | 'count' | 'percent'
  total?: boolean
  /** What its figures cover, for Show Transactions; absent when they can't be listed (an average, a change). (R3) */
  drill?: { measure: string, months?: string[], compared?: boolean, scope?: number, member?: string | null }
}

export interface ResultRow {
  id: string
  label: string
  depth: number
  parentId?: string
  kind: 'member' | 'subtotal' | 'own' | 'other' | 'none' | 'heading' | 'total' | 'net' | 'balance'   // 'balance': R2
  /** Integers: minor units, counts, or basis points. null shows as "—". */
  values: (number | null)[]
  currency?: string
  /** For colouring: a figure here is bad when negative (what is owed; over budget). */
  negativeIsBad?: boolean
  /**
   * What its figures gather, in the row dimension's keys, for Show Transactions: absent when there is nothing to list (a
   * heading, a balance); no keys for a total. With the column's, the privileged side makes the `DrillRequest`. (R3: a
   * row and a column say it once, rather than a key per figure.)
   */
  drill?: { keys?: (string | null)[], own?: boolean, signed?: boolean }
}

export interface ResultChart {
  kind: ChartSpec['kind']
  /** The x axis (columns or rows), or the slices. */
  categories: string[]
  series: { key: string, label: string, values: (number | null)[], as?: 'bar' | 'line', stack?: string }[]
  unit: 'money' | 'count'
}

// ---- The service, for other plugins (a home widget, a link from the budget view)
export interface ReportDefinitionInfo {
  id: string, label: string, description: string, icon?: string
  group: { id: string, label: string }
  contributor: string
  /** False while its `when` is false, or its source's plugin isn't running (then `reason` says which). */
  available: boolean
  reason?: string
}

export interface SpecProblem { path: string, message: string }

export interface ReportsService {
  /** Every definition offered now, validated, with its group. */
  definitions(): ReportDefinitionInfo[]
  groups(): ReportGroupInfo[]                                                                      // R2
  saved(): Promise<SavedReport[]>
  /** A definition or saved report, options applied, parameters filled in: for the heading and the dialogs. (R2.) */
  open(ref: ReportRef): Promise<OpenedReport>
  run(ref: ReportRef, parameters?: ReportParameters, options?: Record<string, string | boolean>): Promise<ReportResult>
  /** A spec that isn't contributed or saved: the designer's preview, and tests. */
  runSpec(spec: ReportSpec, parameters?: ReportParameters, title?: string): Promise<ReportResult>
  // Saved reports, with every check, for the dialogs and (later) the designer (R2)
  saveReport(input: SavedReportInput): Promise<SavedReport>
  updateReport(id: string, patch: Partial<SavedReportInput>, options?: { expectedRev?: number }): Promise<SavedReport>
  duplicateReport(id: string, name: string): Promise<SavedReport>
  deleteReport(id: string): Promise<void>
  /** `sources`: whose figures may have changed, when `figures` (R2). */
  readonly onDidChange: Event<{ catalog: boolean, figures: boolean, sources?: string[] }>
}

// ---- The UI (1.1, R3): REPORTS_COMMANDS, showCommandOf(definitionId), REPORTS_CONTEXT_KEYS, REPORTS_VIEWS,
// REPORTS_DIALOGS, REPORTS_MENU, REPORTS_CHANNELS, REPORTS_EVENTS, and what crosses them: ReportsCatalog, OpenedView,
// RunArgs, MembersArgs, ShowArgs, StaleEvent, TransactionsArgs, TransactionsDialogInput (views.ts)

// ---- Pure code
/** `withIds`: a saved or designed spec may name ledger ids; a definition may not. (R2.) */
export function specProblems(spec: ReportSpec, source: ReportSourceContribution, withIds?: boolean): SpecProblem[]
/** A definition's own fields, its spec, its options, and every spec its options reach. (R2.) */
export function definitionProblems(definition: unknown, source: ReportSourceContribution, contributor: string): SpecProblem[]
export function applyOptions(spec: ReportSpec, options: readonly ReportOption[], values: Record<string, string | boolean>): ReportSpec
export function migrateSpec(spec: unknown): ReportSpec                                           // from any earlier specVersion
/** `yearStart` is the ledger's (`LedgerInfo.yearStart`). */
/** `allDates`: the ledger's first and last dates, which *All dates* needs and only the caller knows. (R2.) */
export function resolvePeriod(value: PeriodValue, today: string, yearStart: { month: number, day: number }, allDates?: DateRange): { from: string, to: string }
export function resolveAsOf(value: AsOfValue, grain: 'month' | 'quarter' | 'year', today: string, yearStart: { month: number, day: number }, allDates?: DateRange): string[]
/** The months, quarters or years of a period, each present; partial ones marked. (R2.) */
export function timeColumns(period: DateRange, grain: 'month' | 'quarter' | 'year', yearStart: { month: number, day: number }): TimeColumn[]
export function comparedPeriod(period: { from: string, to: string }, compare: 'previousPeriod' | 'previousYear'): { from: string, to: string }
/**
 * As built (R2): the spec, the source, its rows and what they are keyed by, the time columns (which need the period and
 * the year start), the sub-ledger columns, the compared result and the balance rows' in one input; the run adds the
 * title, subtitle and period to make the `ReportResult`.
 */
export function shape(input: ShapeInput): { columns: ResultColumn[], rows: ResultRow[], chart?: ResultChart, notes: ReportNote[] }
```

**Errors** are `ReportsError`s with a code, as in `accounts` and `budget`: `NO_LEDGER`, `READ_ONLY`, `NOT_FOUND`,
`NO_SOURCE` (the plugin behind a source isn't running), `INVALID` (a spec or a parameter, with the `path` at fault),
`TOO_LARGE` (a limit passed, or a figure that can't be exact), `TIMEOUT`, `SOURCE_FAILED` (the source threw, or its
reply couldn't be used: R2), `DUPLICATE_NAME`, `CONFLICT`.
`isReportsError(err)` checks the shape, and `toReportsResult(work)` turns one into a `{ ok, value | error }` result for a
view, as `toBudgetResult` does.

---

## Storage schema (`reports`)

| Collection | Indexes |
|---|---|
| `reports.saved` | unique `[nameKey]`; `bySubLedger [parameters.scope.subLedgerId]` |

- **Version 1.** The migrator's `0 → 1` seeds nothing. Declaring an index later needs no migration.
- **A saved report is small** (a name, a reference or a spec, parameters), read whole and replaced whole with
  `expectedRev`.
- **Sub-ledger deletes:** the plugin takes part (`session.participate`), so a saved report over a deleted sub-ledger
  covers its parent from then on, as a budget does; the confirmation counts them ("… and 2 saved reports will move to
  “Home Finances”"). Deleting to the ledger itself makes the scope *Whole ledger*.
- **Archives:** no part. Saved reports refer to accounts and sub-ledgers, not transactions; an account an archive
  removes is dropped when the report runs, with a note, as any deleted account is.
- `accounts` gains **`accounts.archivedMonths`** (unique on `[accountId, month]`), **`accounts.archivedIds`** (the
  dictionary, one document) and **`accounts.archivedAccounts`** (unique on `[accountId]`) in R1. Declaring collections
  needs no migration: a ledger opened by the new version simply has them, empty.

---

## IPC and events

| Channel (`reports:…`) | Request → reply |
|---|---|
| `catalog` | → `ReportsCatalog`: the groups, the definitions offered (id, label, description, group, icon, `enabled`), the saved reports, `readOnly`, `archive`, and **`shown`**: what a command last asked the view to show, with its parameters and a count of requests (R3: in place of a `show` event, which a view not yet mounted would miss); null while no ledger is open |
| `open` | `{ ref }` → `ReportsResult<OpenedView>`: the source (its time, scopes, currency, parameters, whether it lists transactions), the options with their values, the parameters to show (the saved report's, or the definition's with *Accounts* carried), what *Compare with* offers, the pickers, and the choices the heading needs (the tree, the accounts, the currencies), today and the year start |
| `run` | `{ ref, parameters, options }` → `ReportsResult<ReportResult>`: the view counts its runs and drops a reply older than its latest, so a slow run never overwrites a newer one (R3: no `seq` crosses) |
| `members` | `{ ref, dimension \| parameter, parameters }` → `ReportsResult<Member[]>`: pickers (categories, budgets), from the report's source |
| `select` | `{ ref, parameters, options }` → void: what the view shows, for the commands and context keys, and the *Accounts* to carry |
| `saved.save` | `{ name, ref, parameters, options, view? }` → `ReportsResult<SavedReport>`: Save Report As… (R4: *Save Report* is a command, saving over the revision the report was shown at) |
| `saved.rename` | `{ id, name, expectedRev? }` → `ReportsResult<SavedReport>` |
| `saved.duplicate` | `{ id, name }` → `ReportsResult<SavedReport>`: the copy |
| `print.ready` | `PrintReady`: `{ request, landscape }` once the view has drawn the report in its print area, or `{ request, problem }` when it can't → `ReportsResult<boolean>` once printed or written (true) or cancelled (false); the plugin prints the window the message came from (R6) |

| Event (`reports:…`) | Payload |
|---|---|
| `catalog.changed` | `ReportsCatalog` or null: a definition, group or saved report added, changed or removed; a ledger opened or closed. Sent only when it differs from the last one sent |
| `stale` | `{ sources: string[] \| null }`: figures from these sources (null: every source) may have changed; a shown report on one runs again (debounced), a hidden one when next shown |
| `print.requested` | `PrintRequest`, `{ request, output: 'print' \| 'pdf' }`: *Print Report…* or *Save Report as PDF…*; the view draws the report in its print layout, once its figures are worked out, and answers on `print.ready` (R6) |

Deleting a saved report, and *Show Transactions* (`reports.transactions`, in place of a `drill` channel), are commands:
each asks first or gathers what its dialog shows on the privileged side, as the budget's do. So is *Export Report…*,
which runs the report shown again on the privileged side and writes its table: the CSV needs nothing of the view's but
what it said it shows (R6).

---

## Keeping reports current

| Source | Follows | Marks stale |
|---|---|---|
| `reports.flows` | `accounts.onDidChange` with `transactions`, `categories`, `created`, `updated`, `deleted`; `ledger.onDidChangeTree`; an archive's `onDidArchive` | `reports.flows` |
| `reports.balances` | `accounts.onDidChange` with `balances`, `created`, `updated`, `deleted`, `chart`; an archive | `reports.balances` |
| `budget.status` | `budget.service.onDidChange` | `budget.status` |
| The ledger's year start | `ledger.onDidChangeInfo` | every source |
| The open ledger | `ledger.onDidChange` | everything: the catalog and the view reload, or clear |

- **A stale report runs again only while its view is on screen**, at most once every 250 ms (`REFRESH_DEBOUNCE_MS`),
  as the budget view's status. The view watches whether it is on screen (the budget's `useShown`): the shell keeps a
  main view mounted once shown, so "mounted" isn't "shown".
- **Typing in the register is many changes; an import is one.** Debouncing makes both one run.
- **Reports are never recomputed in the background** for anything but the view (and, later, a home widget).

---

## Charts

Reports are the first feature that needs charts, and plugins may not import `@mui/*` or bundle their own copy of the
shell's UI. So (R-16):

- **Charts are part of `@tessera/ui`** (version 1.6): a small, curated set (bar, stacked and grouped bar, line, area,
  donut, and bars with a line), shared as a singleton, like the rest of `@tessera/ui`. Every plugin's chart then
  follows the theme, and later plugins (the home view's widgets, the budget) use the same ones.
- **MUI X Charts, since it is compatible** (decided in review, Q4: *MUI X Charts if it is compatible, otherwise our
  own*; R3 measured it, [4. Charts](#4-charts)). It draws SVG from the MUI theme the shell already builds, so light and
  dark, tokens and font roles come free, and it prints crisply. Only its free (MIT) community package is used; nothing
  from the paid plans. Canvas libraries are not considered: they don't print crisply, and they would need colours
  passed in by hand.
- **Behind Tessera's own component.** Plugins draw `Chart` from `@tessera/ui/charts`, never MUI X: its props are
  Tessera's (`kind`, `categories`, `series`, `format`, `formatAxis`, `label`, `horizontal`, `height`), and a series says
  what it means (`tone`: money in, money out, a total drawn over the rest) rather than its colour. What draws the
  charts can change without any plugin changing.
- **A separate shared entry, `@tessera/ui/charts`, loaded when a view first draws one**, since MUI X Charts is large
  (133 KB gzipped): the window's start-up doesn't pay for it. The shell shares it as a singleton of its own; the plugin
  build shares it and never bundles it.
- **Colours come from the theme, never from the library.** A chart needs up to 12 colours that can be told apart in
  both modes; the theme gains a **chart palette** (`palette.chart`, 12 colours per mode, each checked for 3:1 against
  the paper, as theme colours already are), which a contributed theme may set. R0 found a standard categorical palette
  with half its colours below 3:1 on the light paper, and chose candidates that pass in both modes
  ([R0](#4-charts)). Income and money in use
  `success.main`, expenses and money out `error.main`, so the colours mean what they mean in the register.
- **Text in charts follows the font roles:** axis labels and the legend in *Small text*, in the theme's secondary text
  colour.
- **Amounts are formatted, never converted:** the axis and tooltips use `formatAmount` from minor units (display only,
  like every amount on screen); the chart's geometry is the only floating point, and it is pixels.
- **Every chart has its table**, on the same screen or one click away, and the chart itself is labelled for screen
  readers ("Spending by Category, donut chart: Housing 45.2 %, Food 24.2 %…"). Nothing is only in the chart.

---

## Reports and `@tessera/ui`

Review asked whether keeping MUI behind `@tessera/ui` limits what plugins can do. Plugins' renderer code imports
components from `@tessera/ui`, never from `@mui/*` or `@emotion/*` (the plugin build refuses it), and `@tessera/ui`
is a curated facade, shared as one copy with the shell: one MUI, one Emotion, one theme, one style cache
([theming-design.md](theming-design.md#tesseraui-what-plugins-import), decisions 4 and 15).

**It limits *when*, not *what*.** Anything MUI offers can reach plugins, but only once the shell exports it. That has
costs:

| Cost | Who feels it | How much |
|---|---|---|
| A component not yet exported waits for a shell release | Third-party authors most. A bundled plugin adds its export in the same change, as the budget added `LinearProgress` | Real, once third-party plugins exist |
| MUI X (charts, date pickers, data grid) is large and separate; in the one shared module, every window would load it | Everyone's start-up | Real: met by separate entries, loaded on first use (below) |
| Plugins are tied to the MUI major the shell uses | Everyone, at an MUI upgrade | Smaller than without the facade, which can absorb a change; plugins bundling MUI would each break, and at different times |
| `styled` isn't exported yet, though the theming note lists it | Authors wanting reusable styled parts | Small: `sx` covers most needs |
| A plugin can't ship an MUI-based component library of its own | Rare | Accepted |

**Why the rule is still right:** a plugin bundling its own MUI gets a second Emotion, which ignores the shell's theme,
its light and dark modes and the user's font roles; each such plugin loads MUI again; and React-level mismatches fail
at run time. The facade is also what let the shell adopt font roles and themes without any plugin changing. Plugins
remain free to bundle libraries that aren't MUI (a map, a rich text editor) and style them from `useThemeState()` and
`useFontRoles()`, as charts would have to without MUI X.

**Proposed policy** (for [todo.md](todo.md), and followed by reports):

1. **Any MUI core component is exported on request**, in a minor version of `@tessera/ui`, with the pinned list's test
   updated; never `export *`.
2. **MUI X comes in as separate entries, loaded on first use:** `@tessera/ui/charts` (built in R3: the shell shares it
   as a singleton of its own, loaded the first time a view imports it; the plugin build shares it and never bundles
   it), and when a view needs them `@tessera/ui/pickers` (date pickers) and `@tessera/ui/grid` (the data grid). Free
   community packages only, each behind Tessera's own components, never re-exported.
3. **`styled` is exported**, as the theming note intended.
4. **An MUI major upgrade is a major version of `@tessera/ui`**, and a plugin built against a newer `@tessera/ui`
   than the shell's is refused with a message naming both, as part of [todo.md](todo.md)'s compatibility checks.

**What reports need from it:** charts (R3). Dates are typed in native date fields (`TextField type="date"`), as the
Export, Account and Budget Line dialogs already do, so no picker is needed yet. The table is `@tessera/ui`'s `Table`,
which draws every row: 5,000 rows kept the window from responding for 0.7 s (2.8 s on a CPU 4× slower) in R0. So the
view **draws 500 rows at a time, each chunk after a painted frame**: the first rows show in about 0.2 s (0.8 s), and
the window never waits more than 0.19 s (0.5 s). (R3 held it to that in Chromium: 150 to 233 ms, once each row was
memoised and the styles put on the table, not on each cell; [R3 results](#phase-r3-results).) (A chunk scheduled with a bare `setTimeout(0)` lands in the same frame,
R0 found: it must follow `requestAnimationFrame`.) **Reports are limited to 25,000 cells** (`REPORT_CELLS_MAX`): every
payee by month, 100,100 cells, took 5 to 6 s. If that isn't enough, windowing the table, or MUI X's data grid through
`@tessera/ui/grid`, is the next step; the report designer may want the grid anyway.

---

## Printing and exporting

*Print Report…* (`Ctrl+P`), *Save Report as PDF…* and *Export Report…* came in R6 ([results](#phase-r6-results)). Each
acts on the report shown, as it is shown, and is enabled only while the report view is in front, so `Ctrl+P` in the
register doesn't print a report behind it.

- **`shell.print`**, a shell service provided before any plugin activates (Electron's `webContents.print` and
  `printToPDF`, for a window): `print({ windowId, landscape })` opens the system's print dialog and resolves true once
  printed, false if cancelled; `savePdf({ windowId, path, landscape, pageSize })` writes a PDF, on the paper of the
  user's region by default (`paperSize()`: Letter in the United States, Canada, Mexico and a few more; A4 elsewhere).
  Backgrounds are never printed.
- **What prints is the renderer's:** a view draws what it prints in a **print area** (`PrintArea`, `@tessera/ui` 1.7),
  a child of the document's body, drawn off screen at a page's printable width (`PRINT_WIDTHS`: 680 px portrait, 960
  landscape, which fit A4 and Letter alike) so a chart in it measures itself as it will print, and **in the light
  variant of the window's theme**, so a dark window prints on white. While a print area is there, the shell's **print
  stylesheet** prints it and nothing else. It numbers the pages in their margin ("Page 2 of 5"), repeats a table's
  heading on each page, and keeps rows whole. A window with no print area prints its main area's shown view,
  un-scrolled, without the bars or what a view marks `data-print="hide"`, in black ink. **R0 confirmed the stylesheet
  is required** ([results](#5-printing)): without it Chromium printed one page holding the left bar and 22 of 300 rows,
  in a dark theme's black.
- **Printing is two halves.** The command asks the view to draw the report (`reports:print.requested`); the view
  draws its **print layout** and answers when it is drawn, chart included, saying the orientation
  (`reports:print.ready`); the plugin then prints the window the answer came from, or writes the PDF. The view keeps
  what it drew until the plugin has printed it, whatever runs again meanwhile. A view that can't draw the report says
  why, and one that doesn't answer within a minute is given up on, saying so.
- **The print layout:** the title, the subtitle (period, accounts, currency), what it is compared with, the chart at
  the page's width when the view shows one, the whole table as the view shows it (rows folded stay folded; not
  scrolled, and not drawn in chunks), the notes, and the ledger and the date printed. **The page is chosen by the
  table's width:** portrait when it fits across, landscape when not (the print dialog can still change it). A table
  wider than a landscape page is scaled down to fit, to no less than 70 % of its size (`MIN_ZOOM`); wider still, its
  columns print in blocks, one under another, as even as fit, each with the rows' labels and at its own size. No
  figure is ever cut off.
- **Export Report…** writes the table as shown to **CSV**: a header row (the rows' name, then each column's month and
  figure: "Mar 2027 Budget"), one row per table row the view shows, labelled by its path (*Food : Groceries*), a
  *Currency* column when the report is in each account's own; amounts as exact decimals with the currency's digits
  (`minorToDecimal`), shares as decimals of a per cent (`45.20`), counts whole, "—" an empty cell; UTF-8 with a
  byte-order mark; text a spreadsheet would run as a formula written with an apostrophe in front, as the export plugin
  writes its CSVs (its helpers come from `@tessera/export-api`).
- **Files are written safely:** `shell.files.writeFile` writes under a temporary name and renames it over the file,
  retrying for up to 10 s while Windows holds it, an item on [todo.md](todo.md)'s list of shell services, rather than
  a third copy of the backup's and export's pattern. Its errors say why in words for the user.
- The Save dialog suggests `<report name> <period>.csv` (or `.pdf`) in the folder used last (`context.state`), else
  Documents.

---

## The Reports page

Tools › Options… › **Reports** (`reports.settings`), a page of fields the shell draws, over the `reports` namespace. It
comes in R4, with customising, and is small on purpose:

```ts
// @tessera/reports-api
export const REPORTS_SETTINGS_ID = 'reports'
export const REPORTS_SETTINGS_PAGE = 'reports.settings'

export interface ReportsSettings {
  /** What a report opens on when neither its definition's `show` nor the user's last choice for it says otherwise. */
  openOn: 'both' | 'table'
  /** The number of rows kept before *Other*, where a definition's axis takes `top` from the user: 5 to 500. */
  topRows: number
}
export const REPORTS_SETTINGS_DEFAULTS: ReportsSettings = { openOn: 'both', topRows: 25 }
export const TOP_ROWS_MIN = 5
export const TOP_ROWS_MAX = 500
```

| Field | Kind | Label, and help | Checked |
|---|---|---|---|
| `openOn` | choice | *Open reports on*: *Chart and table*, *Table only*. "A report you have opened before opens as you left it." | one of the two |
| `topRows` | number | *Rows before "Other"*: "Reports that list payees or categories by size show this many, then the rest together as Other. Customise a report to change it for that report." | a whole number, 5 to 500: "Show 5 to 500 rows before Other." |

- **Keywords** for the Options dialog's search: *reports, chart, table, other, top, rows, payees, categories*.
- **Followed as they change:** the shown report runs again with a new *Rows before "Other"*; *Open reports on* applies
  from the next report opened. Other plugins read them with `context.settings.read(REPORTS_SETTINGS_ID)`.
- **Which reports take *Rows before "Other"*:** those whose row axis says `top: 'user'` (Spending by Payee), unless the
  report was customised with a *Show the top* of its own (R4).
- **No tuning presets.** The import's *Matching* setting offers presets (Strict, Balanced, Lenient) because its
  tolerances only make sense together and trade accuracy against noise
  ([plugin-creation.md](plugin-creation.md#settings)). Reports have nothing like that: their rules (what counts, signs,
  transfers) are decided, not tolerances, and their limits are guards against hangs, not choices. So none is offered.

What isn't a setting, and where it lives instead:

| Choice | Where | Why not the page |
|---|---|---|
| The year start | The ledger (*Ledger Properties…*) | A ledger's fact, shared by archiving and budgets (Q9) |
| Period, accounts, currency, *Compare with* | Each report's heading; remembered per report and ledger, or saved with the report | They differ from report to report |
| What a report shows (detail, columns, chart) | *Customise Report…*, saved with the report | The definition's options |
| Whether future-dated transactions count | Nowhere: decided (Q5) | A rule everyone's figures must share, as in budgets |
| Limits (rows, cells, series, a source's time) and the refresh's quarter second | Constants in `@tessera/reports-api` | Guards, measured in R0; a setting would only let a report hang |
| Chart colours | The theme (`palette.chart`) | Colours are the theme's, in both modes |
| Landscape or portrait | Chosen by the report's width, for printing and PDFs alike; the print dialog can change it | Per printout |

What belongs to one saved report is in the ledger with it (R-15), and so does the year start, which is the ledger's
([The ledger's year start](#the-ledgers-year-start)); the page holds the user's preferences only.

---

## Read-only ledgers and archive files

- **Every report runs on a read-only ledger**, an archive file included: reporting on archived years is much of what an
  archive file is for. Saved reports in it are listed and run.
- **Nothing that writes is offered:** *Save Report*, *Save Report As…*, *Rename…*, *Duplicate…* and *Delete…* are
  disabled (`!ledger.isReadOnly` in their enablement, and the view's own buttons follow the catalog's `readOnly`).
  *Customise Report…*, printing and CSV work, since they write nothing into the ledger.
- **An archive file's reports** read its own transactions, which are all there before its archive date, and its own
  archived totals from earlier archives.

---

## Designing for the report designer

A **report designer**, in which users build reports of their own ("groceries by store, by quarter, for the last two
years"), is expected later. It gets a design note of its own when it is scheduled. This design is shaped so that the
designer is **a UI that edits a `ReportSpec`**, and nothing else: the sources, engine, view, storage, printing and
menus it needs are already here, and the eight shipped reports are its first examples.

```
┌ Report Designer · Groceries by store ────────────────────────────────────────────────────────────────┐
│ Data  [Transactions ▾]                                                                               │
│ ┌ Fields ─────────────┐  Rows     [ Payee ×        ]  top [10] then Other                            │
│ │ Month, Quarter, Year│  Columns  [ Quarter ×      ]                                                 │
│ │ Income or expense   │  Figures  [ Spending × ] [ Transactions × ]                                  │
│ │ Category            │  Filters  Category is [ Food : Groceries × ]   Income or expense is [ Expense ]│
│ │ Payee               │  Chart    [ Stacked bars ▾ ]                                                 │
│ │ Account, Sub-ledger │ ┌ Preview ──────────────────────────────────────────────────────────────┐    │
│ │ Spending, Income,   │ │ Payee               Q1 2025    Q2 2025   …    Q4 2026        Total    │    │
│ │ Net, Transactions…  │ │ FreshCo            1,182.40   1,240.95   …   1,301.10    9,874.22    │    │
│ └─────────────────────┘ └───────────────────────────────────────────────────────────────────────┘    │
│                                                                  [Save]  [Save As…]  [Cancel]        │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| What a designer needs | Already provided by |
|---|---|
| A list of what can be reported on, described for people | Sources, with **fields** (labels, dimension or measure, time, tree, signed, which dimensions a measure allows) |
| A format to edit, store and reopen, that old reports keep working in | `ReportSpec`: **data only**, `specVersion` from the first release, `migrateSpec` for every later version |
| Errors shown as the user builds, on the part at fault | `specProblems` names each problem's **path** (`query.columns.grain`) |
| A preview that is what the saved report will show | `reports.service.runSpec` and the `run` channel take a spec that isn't saved; the engine is pure and deterministic |
| Pickers for filters (these categories, these accounts) | `ReportSource.members` |
| Somewhere to save, per ledger | `SavedReport` with **`basis.kind: 'spec'`**, stored, validated and run from R4, though nothing in the first release creates one |
| Starting from an existing report | Every shipped report is a spec: *Edit a Copy…* turns a definition and its options into a spec of the user's own (`applyOptions`) |
| A place in the UI | *My Reports* in the Reports tab; the report view draws whatever a spec describes |
| Safety | Specs hold no code, are validated before they run, and are bounded by the limits; a spec is the same whether a plugin or a user wrote it |

**Rules kept now so the designer stays possible:**

- **No private path.** The shipped reports are contributed through `reports.definitions` like anyone's, and use only
  what a spec can say. A report that can't be said as a spec gets a source that does the work, never special code in
  the view. A test checks that the report manager's code never mentions a definition's id.
- **No ledger ids in definitions**, only in saved reports, so one definition works in every ledger and a designed
  report's ids are clearly the user's.
- **Options are patches on the spec**, so *Customise Report…* and the designer change the same thing; the designer
  simply offers every patch.
- **Sources describe everything the engine needs** (trees, signs, how measures combine, which dimensions they allow), so
  a designer can offer only what will work.

**What the designer will add** (in its own note): the designer view and its commands (*New Report…*, *Edit a
Copy…*, *Edit Report…*); **calculated figures** (spending as a share of income, a category less its budget) through a
small expression grammar that is parsed and evaluated by the engine, never with `eval`, as enablement expressions
already are ([shared/context/when.ts](../shared/context/when.ts)); **several dimensions on an axis** (category within
account); **list reports** (one row per transaction, for a tax year's receipts), on a source mode that returns rows
rather than totals, reusing the drill-down's reading; **reports across two sources** (flows beside budget, balances
beside flows), joined by their time keys; **user-defined groupings** (a "Fixed costs" group of categories);
**conditional colours**; and **sharing** a spec as a file (`.tesserareport`), validated on import like any other.

---

## Security, privacy and robustness

- **Reports never leave the computer** unless the user prints or exports one. Nothing is logged but counts and ids:
  never payees, amounts, names or paths.
- **Exported files are the user's data in the clear**; the Save dialog's note says so, as the Export dialog's does.
  CSV cells that a spreadsheet would run as a formula are protected.
- **Contributed definitions and sources are data and a service**, the same trust as any plugin's contribution: a
  plugin already runs in the main process with full access ([todo.md](todo.md): plugin trust). What the report
  manager adds is **validation**: a malformed definition is refused, not half-drawn; a source's reply is checked (rows
  of the right width, integers, members for every key) and a bad one fails that report only.
- **A source can't hang the app** for longer than its time limit, and a failing one fails only its own reports.
- **Specs hold no code**, now or with the designer. Calculated figures will be a grammar the engine interprets.
- **Bounded work:** every run is bounded in rows, series, columns, dates and time; drill-downs in rows. Runs happen on
  the main process (where the services are) in one stretch each; R0 measures the longest.
- **Exact figures:** integers throughout, `BigInt` where a sum could pass the safe integers, and `TOO_LARGE` rather
  than a wrong figure. An architecture test greps the engine, the periods and the sources' pure modules for
  `toFixed`, `parseFloat` and `Math.round`, and `periods.ts` for `new Date`, as the budget's are.

---

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Reports as code:** each definition a service that returns a finished result | Quickest for eight reports, but a designer could neither open nor edit them, customising would be each report's own code, and every report would repeat pivoting, top rows, totals, comparison and their tests. Sources remain code; the shaping is shared and the definitions are data |
| **A query language over the ledger** (SQL, or the storage kit's `aggregate` exposed to reports) | The session confines each plugin to its own collections, rightly: what counts (voids, transfers, splits, archived months) is the accounts plugin's rule. B0 also measured the kit's `aggregate` 2.5 to 3 times slower than `transactionTotals`' loop |
| **The reports plugin keeps its own archived totals**, as the budget does (a second archive participant) | A second copy of the same totals in every archived ledger, lost for archives made while reports were disabled, and still unreadable by the next plugin that needs them. `accounts` already computes them; it should keep them (Q2) |
| **Reading archive files** for months before an archive | Opening other files (which may have moved) on every report, slowly, for figures the totals already give. Kept for drill-down into archived detail, [later](#later) |
| **A cache or a monthly cube** kept by the report manager | Stale figures to guard against, a part in every archive and sub-ledger delete, and nothing to gain at the measured speeds. In reserve if R0 finds balance history too slow, and then inside `accounts`, behind `balanceHistory` |
| **A chart library in the reports plugin's own bundle** | The budget, the home view's widgets and other plugins couldn't share it; two copies of MUI's styling would drift from the theme. Charts belong beside the other components |
| **Contributed React renderers** for a report's body | A plugin's view can't load another plugin's module today; the shell would need "embedded modules", which the home view's widgets also need. Declared presentation covers the eight reports; renderers come with the widgets ([Later](#later)) |
| **The seven shipped definitions in a plugin of their own** (`reports-standard`) | Proves the extension point beyond doubt, at the cost of one more plugin to build, load and keep in step. The budget's Budget vs Actual already proves it, and the no-private-path test holds the rest to it (Q7) |
| **A view per report** in the main area | Eight (and more) views in `shell.main`, one shown at a time anyway. One report view, told what to show, is how the budget view works |
| **Saved reports in application state** | They name accounts and sub-ledgers, which belong to one ledger; in application state they would leak across ledgers and miss backups (Q8) |
| **Budget vs Actual built by the reports plugin** from `budget.service` | Would make `reports` require `budget.service` (and so be skipped without the budget plugin), or depend on an optional service, which the framework can't yet order ([todo.md](todo.md)). The budget contributing it keeps both independent |
| **Percentages and averages in floating point** | The budget's review found shares one point low in floating point. Basis points and integer division, as there |
| **Transfers between sub-ledgers counted as income and expenses** (as a budget over a sub-ledger plans them) | A budget plans money, so the owner's pay is rightly a line in each budget. A report of income and expenses must not call it either: the business's profit would be understated by the owner's pay. Shown apart, after *Net income*, it is still in every total that needs it |
| **Sub-ledgers side by side as a split of the whole** (every column over the whole ledger's scope, so transfers never show) | The columns would add up neatly, but the owner's pay, the one thing a sole proprietor most needs to see between the two, would vanish |
| **The year start as a per-ledger setting** ([settings scopes](settings-design.md#proposal-scopes-per-ledger-settings)) | The right home once scopes exist, but they are a proposal with open questions. A ledger property now, with `current.yearStart` kept as its face if it moves |
| **The year start on the Reports page** (this note's first draft) | Changed in review (Q9): a fiscal year is a ledger's fact, and reports, archiving and budgets should agree on it |
| **Plugins importing MUI directly** | A second copy of MUI and Emotion per plugin, ignoring the theme and font roles; see [Reports and `@tessera/ui`](#reports-and-tesseraui) |

---

## Risks

| Risk | Mitigation |
|---|---|
| **Balance history is slow** at 100,000 transactions over ten years | **Measured in R0: 187 to 291 ms for 120 month ends**, 38 to 94 ms after an archive. A run is on demand and debounced. If a larger ledger ever makes it slow: per-month balance totals kept in memory by `accounts`, behind the same method |
| **An archive removes accounts, and with them their past balances** (found in R0) | `accounts.archivedAccounts` keeps what their history needs; the archive invariant covers net worth at every month end |
| **Payee entries make archived totals large** | **Resolved in R0:** packed as flat numbers against a dictionary of ids, archived months with payees are smaller than the budget's layout without them (1.82 MB against 1.88 at 100,000). The archive's longest stall, 1.3 to 2.3 s, is its commit's, and waits for large commits to move off the main thread |
| **The chart library doesn't fit** (MUI major, bundle size, printing) | **To be determined** (R0's question 4; a harness is ready), before R3. The fallback is measured: our own SVG components, 1.5 KB gzipped, 2,000 bars in 0.1 s, vectors in print |
| **The spec is too narrow** for a plugin's report | The source does the work and returns rows already shaped; the spec only lays them out. Its `combine: 'none'` lets a source total what the engine can't |
| **The spec changes after saved reports exist** | `specVersion` and `migrateSpec` from the first release; customised reports store option values, not specs; tests open every saved shape of every earlier version |
| **Two archived-totals copies (budget's and accounts') drift** | Both are written in one storage transaction from the same `removedTotals`; the archive invariant test checks both. The budget reading the accounts' copy is [later](#later) |
| **Figures disagree with the navigator today** (future-dated transactions) | The balances source says so in a note; the tests pin both rules |
| **Main-thread stalls** from a large run | Limits on rows, columns and dates; sources yield in long loops (every 2,000 documents, as archives do); R0 measures the longest stall |
| **Menus built once** miss a definition contributed late | All bundled plugins contribute during activation; a late one is in the Reports tab at once, and the menu after a restart, as any menu contribution |
| **Scope surprises** (an account moved between sub-ledgers moves its history) | As for budgets: the heading always says what the report covers |
| **Sub-ledger columns that don't add up to the whole** (transfers between them cancel) | Income, expenses and both net rows add across; the transfer rows carry a note saying why they don't; the tests hold every row to its rule |
| **Changing the year start** changes what *This year* means in every saved report | That is what a preset means; the heading always shows the dates. Saved custom periods keep their dates |
| **Large tables draw slowly** (`@tessera/ui`'s `Table` draws every row) | **Measured in R0:** drawn 500 rows at a time after each painted frame, 5,000 rows show in 0.2 s and the window never waits more than 0.19 s; at most 25,000 cells. Windowing or MUI X's data grid if ever needed ([Reports and `@tessera/ui`](#reports-and-tesseraui)) |
| **Slow renderer tests** ([todo.md](todo.md)) | Tables in tests are small; one test mounts the largest (2,000 rows) to check it draws |

---

## Decisions taken in review

Answered on 2026-11-16, and applied throughout this note.

| # | Question | Decision | Where it lands |
|---|---|---|---|
| Q1 | Where do reports live in the menus: a top-level *Reports* menu, or a *Planning* menu shared with *Budget*? | **A top-level *Reports* menu.** *Budget* stays; the budget's *Planning* to-do is answered | [R-17](#decisions), [The Reports menu](#the-reports-menu-commands-and-context-keys) |
| Q2 | Who keeps the totals of what archives remove? | **`accounts`**: one central place for archived totals, read by every plugin | [R-9](#decisions), [Archived months](#archived-months), [R1](#phase-r1-the-ledger-and-accounts-additions-m) |
| Q3 | Keep payees in archived totals? | **Yes** (read as "keep payee"). R0 chose how: every entry as flat numbers against one dictionary of ids, which makes payees nearly free | [R-9](#decisions), [Spending by Payee](#3-spending-by-payee), [R0](#3-payee-entries-in-archived-months) |
| Q4 | Charts: MUI X Charts, or our own? | **MUI X Charts if compatible; otherwise our own.** Whether it is: to be determined | [R-16](#decisions), [Charts](#charts), [R0](#phase-r0-spike-s) |
| Q5 | Future-dated transactions in a period? | **Counted when entered in the ledger and in the period; *Year to date* and *As of today* stop at today** | [R-6](#decisions), [What counts](#what-counts-the-flows-source) |
| Q6 | Cash Flow's default accounts | **Chequing, savings, credit cards and lines of credit.** Not cash | [R-7](#decisions), [Scope and currency](#scope-and-currency), [Cash Flow](#6-cash-flow) |
| Q7 | Where the seven shipped definitions live | **In `reports`, through the public extension point, with no special treatment** | [R-3](#decisions), [Designing for the report designer](#designing-for-the-report-designer) |
| Q8 | Saved reports: ledger or application state? | **In the ledger** | [R-15](#decisions), [Customising and saving](#customising-and-saving-reports) |
| Q9 | Where the year start is kept | **In the ledger** (not the Reports page) | [R-24](#decisions), [The ledger's year start](#the-ledgers-year-start) |
| Q10 | Names | **As written** | [Naming](#naming) |
| — | Does keeping MUI behind `@tessera/ui` limit plugins? | **It limits when, not what;** kept, with a policy for additions and MUI X as separate entries | [R-25](#decisions), [Reports and `@tessera/ui`](#reports-and-tesseraui) |
| — | Reporting by sub-ledger, for personal and small-business finances | **Every report over a sub-ledger; sub-ledgers side by side; transfers apart, after *Net income*** | [R-23](#decisions), [Reporting by sub-ledger](#reporting-by-sub-ledger) |

Smaller choices made while applying them. Each is easy to change; flag any that are wrong:

- **The ledger owns its year start** (its meta, *File › Ledger Properties…*), rather than waiting for per-ledger
  settings, which are still a proposal. **The Archiving page's year start moves there too**, so a ledger has one year
  start, not two; an existing ledger starts with the Archiving page's value, so nothing changes on upgrade.
- **The year start is a month and a day**, as the Archiving page has it (6 April works). Quarter and year columns are
  still whole months, since totals are by month; the presets use the exact day.
- **One year start per ledger**, not per sub-ledger; a business with its own fiscal year is [Later](#later).
- **Flow reports show *Net income* before transfers, and *Net after transfers* after them**; Cash Flow keeps one
  *Net*, after transfers, because it is about money, whatever it was for.
- **With sub-ledgers side by side, each column is worked out over its own sub-ledger**, so transfers between them show
  in the columns and cancel in the whole; the alternative (a split of the whole, with no transfers) would hide the
  owner's pay.
- **The *Accounts* choice carries from one report to the next**, per ledger, so a user working on the business stays
  on it.
- **Everyday accounts can be limited to a sub-ledger** (*Everyday accounts in Business*), so a business's cash flow
  needs no list of accounts.
- **A ledger archived before R1** shows its archived spending by payee in one row, and no balances before its archive
  date, rather than wrong figures.

---

## Open questions

None. R0 may still change how things are built (archived payees' packing, balance history's reading, the chart
library, large tables), as B0 did for budgets, and would bring any change to what the user sees back for review.

### To be determined

Nothing. The one item, **R0's question 4 (does MUI X Charts fit?)**, was settled in R3: it does, and is used behind
`@tessera/ui/charts` ([4. Charts](#4-charts), [Charts](#charts)). How it prints is R6's to check, with the rest of
printing.

---

# Part 2: Implementation plan

## Ground rules

- **The conventions of the Finance plugins:** names in `protocol.ts` constants, pure code apart from storage and
  Electron, every disposable on `context.subscriptions`, results (not exceptions) across IPC, user-facing text in the
  house style, amounts only through the money helpers.
- **Tested against the real accounts service on a memory engine**, as the budget and export are, not a fake: what
  counts is the accounts plugin's rule, and a fake would let the two drift. The engine and periods are tested on plain
  data.
- **The invariant tests are the spine:**
  - every counted transaction is in exactly one row of a flows report, and the rows add up to the totals;
  - a flows report's net, over any scope, equals the change in that scope's balances less the opening balances of
    accounts opened in the period (Cash Flow's identity);
  - Spending by Payee's total equals Spending by Category's for the same period and scope;
  - Net Worth at a date on or after the last transaction equals `chart().totals`; Account Balances at a date equals each
    register's running balance on that date;
  - Budget vs Actual's figures equal `budget.service.status`'s;
  - **an archive changes no report of any period**, flows or balances (at month ends);
  - every shipped definition, and each of its options, validates against its source.
- **No private path:** the report manager's code never names a shipped definition; a test greps for it.
- **No floating point in figures:** an architecture test greps the engine, `periods.ts` and the sources' pure modules
  for `toFixed`, `parseFloat` and `Math.round`, and `periods.ts` for `new Date` and `Date.now`.
- **No personal data in fixtures:** ledgers are built in tests or by `scripts/sample-archive/household.ts`.
- **Each phase ends usable,** with its results recorded in this note and [todo.md](todo.md) ticked.

## Dependency graph and order

```
R0 spike ──► R1 ledger and accounts additions ──► R2 report domain, no UI ──► R3 view, tab, menu, charts ──┬──► R4 customise and save
   │                                                                     ▲                      ├──► R5 Budget vs Actual (budget plugin)
   │                                                                     │                      └──► R6 print, PDF, CSV
   └── chart library chosen ─────────────────────────────────────────────┘                                ▲
                                                                                      shell.print, atomic writes (can start after R0)
```

R0 comes first because its measurements decide how `balanceHistory` reads, how archived payees are packed, whether
MUI X Charts fits, and how large tables draw. R1 changes `accounts` and `ledger` only, merged on its own, as B1 was;
its one visible change is *Ledger Properties…*. R2 builds and proves the whole domain, with all seven shipped definitions, before any UI depends on it. R4,
R5 and R6 are independent of each other after R3; R6's shell half can be built any time after R0.

---

## Phase R0: spike (S)

**Goal:** answer what the design can't, before anything is merged. The code is throwaway, outside the repository, as
the budget's B0 was, running the repository's real storage kit, SQLite driver, accounts schema and archive code.

| # | Question | How |
|---|---|---|
| 1 | How fast is `transactionTotals` **with `byPayee`**, for a year and 24 months? | The B0 ledgers (1,000, 10,000, 100,000 transactions, 300 payees), medians of five; against B0's figures without payees. Target: 250 ms for 24 months at 100,000 |
| 2 | How fast is **balance history** for 120 month ends over every account, at 100,000? | One `find` up to the last date, sorted, then a loop; against reading per account through `register()`; with and without an archive. Target: 500 ms, and the longest stall |
| 3 | How much do **payee entries** add to archived months, and to the archive's time? | The real `applyArchive` on copies of the 100,000 ledger and the sample household, packed as the budget packs, with and without payee entries: documents, JSON size, the file after compaction, time, longest stall |
| 4 | **Charts (Q4):** does MUI X Charts' current release (its free community package) work with Tessera's MUI major and the shell's theme? What does it add to the renderer? | A `@tessera/ui` prototype with a bar, a donut and a line chart under `createShellTheme` in light and dark; bundle size; 12 series × 24 points and 2,000 bars, first paint and hover in a headless Chromium at the VM's speed and slowed 4×; the same three as own SVG components for comparison; a second shared entry (`@tessera/ui/charts`) through the federation build |
| 5 | Does **printing** work as designed? | A hidden-bars print stylesheet and `printToPDF` of a page with a chart and a 300-row table: pages, repeated headers, the chart's sharpness. (Electron may not be installable in the spike's machine, as in B0; then it is checked by hand in R6) |
| 6 | How fast is the **engine** at its limits, and the **table**? | `shape` over 2,000 payees × 24 months, and a category tree of 150 × 120 months, with comparison, and 12 sub-ledger columns. Target: 50 ms. Then the table drawing 2,000 and 5,000 rows, whole and the first 500 first, at the VM's speed and slowed 4× |

**Done when:** the results are recorded under *Phase R0 results* here, Q3 and Q4 are answered, and the design is
amended where the findings differ. **Done 2026-11-16; question 4's MUI X half is to be determined** ([4. Charts](#4-charts),
[To be determined](#to-be-determined)).

### Phase R0 results

Recorded 2026-11-16. **Questions 1, 2, 3, 5 and 6 are answered, and the design holds, with seven changes** ([What
changes in this note](#what-changes-in-this-note)). Totals by payee cost about 10 ms for a year at 100,000 transactions,
and finding out why uncovered a sort that makes **today's `transactionTotals` twice as slow as it needs to be**.
Balance history takes 187 to 291 ms for 120 month ends, and showed that **an archive loses the accounts it removes**
from past balances unless `accounts` keeps a record of them. Payee entries in archived months cost almost nothing once
**every entry is packed as flat numbers against one dictionary of ids**, but three times the space in the budget's
nested layout. Printing works, and **needs the print stylesheet** (without it, 22 of 300 rows printed). The engine is
well inside its target; **drawing the table is the cost**, met by drawing it in chunks after each painted frame.
**Question 4 was answered in part, and marked to be determined:** MUI X Charts couldn't be installed here, so whether
it fits was still to measure, with a harness ready; the chart palette (which no library's default passes) and our own
fallback were measured. **R3 answered it: MUI X Charts fits** ([4. Charts](#4-charts)).

**How it was run.**

- **The code** was throwaway, kept beside the repository in `r0-spike/` (with a README) until review, and **deleted at
  the start of R2**; what question 4's harness did is described under [4. Charts](#4-charts), to be written again. It ran **the repository's real code**: the storage kit, the SQLite
  driver, the accounts schema and service, `planArchive`, `verifyArchive` and `removedTotals`, the ledger session and
  the Archive Ledger service, wired as `scripts/sample-archive/household.ts` wires them. It prototyped what R1 and R2
  would add: totals by payee, the sorted order, archived months in five packings, balance history, and the engine.
- **The machine:** a Linux VM, 4 cores, Intel Xeon at 2.6 GHz (B0's model), 15 GB. Warm runs. It was noisy: one run
  could take twice another, so figures at 100,000 are ranges over three runs, each the median of five, as B0 gave
  them.
- **Node 22.21.0, SQLite 3.50.4** (`node:sqlite`). B0 had Node 24.21 and SQLite 3.53.4; as a calibration, a `find` on a
  year's dates at 100,000 took 43 to 83 ms here against B0's 42.5 to 49.3 ms.
- **The browser:** Chromium 131's headless shell, driven by Playwright 1.56 (Electron 45 is Chromium 142), with React
  19.2 (Tessera has 18). **No MUI could be installed**: tables are plain `<table>`s (B0 found MUI's `TableCell` about a
  fifth slower), and charts are our own SVG.
- **The ledgers** were built through the real kit, driver and schema, shaped like B0's: January 2017 to November 2026;
  15 accounts in *Personal*, *Business*, *Rentals* and the ledger, one in USD, four closed; 8.5 % transfers, a quarter
  of them the owner's pay; 97.5 % reconciled to September 2026, 1 % void, 3 % refunds, 2 % uncategorised; 300 payees,
  each keeping 85 % of its transactions in a category of its own, and 113 categories. They came to **0.8, 5.6 and 46.3
  MB** at 1,000, 10,000 and 100,000 transactions (B0: 0.8, 5.5, 48.6). With categories drawn independently of payees,
  as first written, payee entries came out far too many; real payees keep to their categories.

| Question | Answer |
|---|---|
| 1. How fast is `transactionTotals` by payee, for a year and 24 months? | **About 10 ms more than without payees for a year (85 to 108 ms at 100,000), and within the 250 ms target for 24 months (123 to 239 ms)**, with the sorted order R1 adopts. Rows grow 1.76 times. **Found: today's method spends more than half its time sorting**; one precomputed key gives the same order four times faster |
| 2. How fast is balance history for 120 month ends over every account? | **187 to 291 ms at 100,000** (target 500), and 38 to 94 ms after an archive; today's only way, each account's register, takes 7.2 to 11 s. Every point agrees with the registers and the current balances. **Found: an account an archive removes takes its opening balance with it**, so past net worth changes; a record of it, kept by `accounts`, puts it right |
| 3. How much do payee entries add to archived months? | **Three times the JSON and a second more stall, packed as the budget packs; almost nothing packed flat.** With every entry as flat numbers against one dictionary of ids, archived months with payees take 1.82 MB for an archive before 2026 at 100,000, less than the budget's layout without payees (1.88 MB), and the file 8.4 MB against 9.1. The longest stall is the commit's: 1.3 to 2.3 s, against 0.6 to 1.7 s for an archive keeping nothing |
| 4. How does MUI X Charts fit Tessera's theme, and what does it add? | **It fits (answered in R3): 9.17 works with Tessera's MUI and React, follows the theme in both modes, and adds 133 KB gzipped**, so it is a second entry of `@tessera/ui`, loaded on first use. R0 couldn't install it (no route to the npm registry) and wrote a harness, written again in R3 ([4. Charts](#4-charts)). R0 measured: **a standard palette fails the shell's own contrast rule in light mode** (5 of 10 colours below 3:1), so the palette is Tessera's, per mode; and **our own SVG charts, the fallback, are 1.5 KB gzipped** and draw 2,000 bars in 0.1 s |
| 5. Does printing work? | **Yes, with the print stylesheet, and not without it.** Without: one page, 22 of 300 rows (the main area's visible part), the left bar, and a dark theme printed dark. With: 7 pages, all 300 rows, the header on every page, no bars, light colours, charts as vectors |
| 6. How fast is the engine at its limits? | **13 to 34 ms** (target 50) for 2,000 payees by 24 months compared with the period before, a 152-category tree by 120 months, and 13 sub-ledger columns. **The table is the cost:** 5,000 rows take about a second to draw whole (3.7 s on a CPU 4× slower); drawn 500 rows at a time after each painted frame, the first rows show in 0.2 s (0.8 s), and the window never waits more than 0.19 s (0.5 s). A table of every payee by month (100,100 cells) takes 5 to 6 s, so cells get a limit |

#### 1. Totals by payee

Medians in ms; at 100,000, the range of three runs. *In range*: transactions in a year and in 24 months. *Today* is
`accounts.service.transactionTotals` as it is; *R1* is the same `find` and loop with the rows sorted by one key, without
and with payees.

| Transactions (in range) | Today: a year / 24 months | R1, no payee | R1, by payee | Rows by payee (without) |
|---|---|---|---|---|
| 1,000 (97 / 190) | 10 / 4.9 | 2.8 / 6.2 | 2.0 / 3.9 | 96 (94) / 188 (186) |
| 10,000 (1,025 / 2,030) | 31.9 / 26.7 | 13.2 / 14.2 | 13.6 / 13.4 | 960 (841) / 1,907 (1,690) |
| 100,000 (9,787 / 19,663) | 97 to 105 / 159 to 350 | 70 to 92 / 111 to 228 | 85 to 108 / 123 to 239 | 7,476 (4,249) / 15,020 (8,545) |

- **By payee costs about 10 ms for a year, and stays within the 250 ms target for 24 months** in every run. In every
  run the rows by payee add up, account by account, month by month and category by category, to the rows without.
- **Today's method sorts slowly.** Its rows come in the contract's order (month, account, category, transfer account),
  and `compareTotals` compares up to four ULIDs, which share their first characters, for every comparison: 9,533 rows
  took **94 ms to sort, against 25 ms with one precomputed key**, in the same order. The sort was half the method's
  time at 100,000. R1 sorts by key, which makes the budget's status faster too.
- **The rest is the read.** The kit tests its filter on every document, so a `find` costs 40 to 80 ms at 100,000
  whatever the range, as B0 found.

#### 2. Balance history

120 month ends, December 2016 to November 2026 (the last, in the future, is today), over every account. Medians in ms;
at 100,000, the range of three runs.

| Transactions | R1's `balanceHistory` | Monthly `transactionTotals` for all history, then running sums | Each account's `register()` (today's only way) |
|---|---|---|---|
| 1,000 | 9 (3 to 16) | 16 | 153 |
| 10,000 | 32 (24 to 67) | 109 | 790 |
| 100,000 | **187 to 291** | 436 to 1,003 | 7,226 to 10,965 |
| 100,000, archived before 2026 | **38 to 94** | 69 to 111 | 528 to 956 |

- **The way chosen:** one `find` of the transactions up to the last date; each added into its account's bucket for the
  first date on or after it (a binary search over the dates); then running sums from each account's opening balance.
  No sort, no cache. Archived months add their net at their month's end. It runs in one stretch, so its stall is its
  time: within the 500 ms target.
- **Every point checked:** today's point is `balances().current` for all 15 accounts; 1,785 of 1,785 points equal the
  registers' running balances on their dates; after an archive before 2026, all 1,785 points, and net worth at every
  month end, are unchanged.
- **Found: an archive removes closed accounts left empty, and their opening balances with them.** The spike's
  accounts each kept an unreconciled transaction, so none was removed; with one made removable (10,000, two accounts
  removed), **net worth at past month ends changed**, because the accounts' starting points were gone, though their
  transactions' totals were kept. **So R1 keeps a record of each account an archive removes** (`accounts.archivedAccounts`:
  its name, type, currency, sub-ledger, opening date, original opening balance and closing date). With it, all 1,785
  points and net worth were unchanged again.

#### 3. Payee entries in archived months

The real Archive Ledger service on copies of the 100,000 ledger, with R1's participant prototyped in six packings.
Before 2026: 88,917 transactions removed, three runs; before 2022: 50,637, two runs. *Stall* is the longest the main
thread went without turning its event loop.

| Packing | Whole archive | Longest stall | File after compaction | Archived months' JSON |
|---|---|---|---|---|
| Nothing kept (today) | 3.7 to 5.8 s / 3.3 to 3.4 s | 0.6 to 1.7 s / 0.4 to 0.5 s | 4.8 MB / 21.9 MB | — |
| The budget's layout (nested objects), no payees | 4.5 to 5.1 / 3.9 to 4.0 | 1.0 to 1.4 / 0.6 | 9.1 / 24.4 | 1.88 MB / 1.09 MB |
| The budget's layout, with payees | 6.2 to 7.2 / 4.8 to 5.0 | 2.5 to 2.8 / 1.3 to 1.4 | 12.4 / 26.3 | 5.50 / 3.15 |
| With payees, ids interned as numeric keys (`"12"`) | 10.1 to 12.4 | 5.2 to 8.4 | 9.7 | 2.33 |
| With payees, ids interned as lettered keys (`"kc"`) | 6.1 to 7.9 | 2.4 to 2.7 | 9.8 | 2.37 |
| Payees as flat numbers, ids in a dictionary | 5.3 to 5.6 / 4.4 to 4.8 | 2.0 to 2.3 / 1.1 to 1.2 | 8.8 / 24.3 | 2.02 / 1.17 |
| **Everything as flat numbers, ids in a dictionary (chosen)** | **4.4 to 5.9 / 4.2 to 4.8** | **1.3 to 2.3 / 0.6 to 1.0** | **8.4 / 24.0** | **1.82 / 1.05** |

- **The invariant held in every run checked:** the totals before the archive equal the live totals after it plus
  those kept, for every account, month, category or transfer, and payee: 72,741 keys at 100,000.
- **Entries:** 0.44 category and transfer entries per archived transaction here, and 0.71 payee entries. **The sample
  household gives 0.76 and 0.51** (B0 measured 0.72 for the first): real payees pack tighter than these ledgers.
- **The cost is objects, not bytes.** A profile of the nested layout with payees put the garbage collector at 19 % of
  the run: tens of thousands of small objects, each cloned by the kit, serialised and collected. Interning the ids
  shrank the JSON but not the stall; **numeric keys made it far worse**, since JavaScript treats `"12"` as an array
  index. Flat arrays of numbers make almost no objects.
- **Chosen: every entry flat, against one dictionary of ids** (`accounts.archivedIds`): per account and month,
  `categories: [id, inflow, outflow, count, …]`, `transfers: [id, inflow, outflow, count, sub-ledger id, …]` and
  `payees: [category id, payee id, inflow, outflow, count, …]`, each id its place in the dictionary (−1 for none). **With
  payees, it is smaller than the budget's layout without them.**
- **The longest stall is the commit**, synchronous on the main thread, after the participants: 0.6 to 1.7 s for an
  archive keeping nothing, 1.3 to 2.3 s with R1's months. **Accepted:** an archive is rare and shows its progress, and
  moving large commits off the main thread, already a to-do of
  [ledger-compaction-design.md](ledger-compaction-design.md), is the fix for all of it.

#### 4. Charts

- **MUI X Charts: answered in R3, below.** In R0 the sandbox could reach no package registry, and MUI wasn't installed
  in it. A harness was written for it: a page drawing MUI X's bar, line and pie charts at R0's sizes (12 lines of 24 points,
  2,000 bars, an eight-slice donut) under the shell's own `createShellTheme`, in light and dark, with the palette below;
  bundled with the repository's esbuild beside the same page without the charts, for the size they add (minified and
  gzipped, and by package); and measured **in Electron itself**: first paints at the machine's speed and with the CPU
  slowed 4× (the DevTools protocol's throttling), whether the axis text takes the theme's `text.secondary` and font,
  screenshots in both modes, and `printToPDF` (vectors, every row of a 300-row table, the header on each page). The
  spike's code was deleted at the start of R2, as planned; the harness is about 150 lines, and is written again, to the
  description here, where the registry is reachable. Question 4 is to be determined until it is run; only R3 waits on it.
- **The palette, whatever the library.** Tableau 10, a standard categorical palette, has **5 of its 10 colours below
  the shell's 3:1 for interface parts on the light paper** (the lowest 1.61:1), and all 10 above it on the dark (lowest
  3.67:1). So no library's default will do: the chart palette is Tessera's, one per mode (`palette.chart`). The
  candidates pass in both: light `#1565c0 #c2410c #b91c1c #0f766e #2e7d32 #a16207 #7e22ce #be185d #6d4c41 #475569
  #0369a1 #4d7c0f` (lowest 4.92:1 on `#ffffff`), dark `#90caf9 #fdba74 #fca5a5 #5eead4 #86efac #fde047 #d8b4fe #f9a8d4
  #d7ccc8 #cbd5e1 #7dd3fc #bef264` (lowest 8.78:1 on `#1e1e1e`). Seen in both modes, lines and donut.
- **Our own SVG charts, the fallback:** line, bar (grouped or stacked) and donut, **3.1 KB minified, 1.5 KB gzipped**,
  without tooltips, hover or keyboard focus yet. First paint at the VM's speed / 4× slower: 12 lines of 24 points 37 to
  97 ms / 138 to 175 ms; **2,000 bars 93 to 137 ms** / 339 to 405 ms; a donut 38 to 68 ms / 144 to 328 ms. Their PDFs are
  vectors, with no images. So the fallback is cheap to carry; MUI X must earn its size with what the fallback lacks
  (tooltips, legends, keyboard and screen-reader support).
- **Twelve lines are hard to follow** even in a good palette: Category Trends' top six and the table beside every chart
  stay.
- **Answered in R3: MUI X Charts fits.** The harness, written again to the description above, ran where the registry
  was reachable, with **`@mui/x-charts` 9.17.0** (MIT; its peers are `@mui/material` 7.3 or 9, and React 17 to 19,
  so Tessera's MUI 9.5 and React 18.3 qualify), in Chromium 141's headless shell rather than Electron, whose binary
  wasn't downloaded. **It follows the theme:** no console error; axis text in the theme's `text.primary` and font, in
  light and dark; the palette as given. **It adds 423 KB minified, 133 KB gzipped** to the renderer (`@mui/x-charts`
  229 KB of it, the rest its gestures and d3 parts), against 1.5 KB for our own. **First paint**, at the VM's speed /
  4× slower: 12 lines of 24 points 114 ms / 588 ms; 2,000 bars 666 ms / 3.1 s; a donut 73 ms / 344 ms (ours: 37 to 97,
  93 to 137, 38 to 68 ms). Slower than ours, most at 2,000 bars, which no report draws (at most 12 series, 8 slices,
  the top ten bars). So, as Q4 said (*MUI X Charts if it is compatible*): **MUI X Charts**, for its tooltips, legends,
  axes and accessibility, which ours lacked; **behind Tessera's own `Chart`**, so it can be replaced; and **as a second
  entry, `@tessera/ui/charts`, loaded on first use**, since its size is real. Printing it is R6's to check.

#### 5. Printing

A page shaped like Tessera's window (a left bar, a toolbar, a main area that scrolls, a status bar) holding a report: a
donut, a bar chart and a 300-row table. Printed to A4 by Chromium's `page.pdf`, the engine behind Electron's
`printToPDF`, and read back with `pdfjs-dist`; the pages rendered to images to see them.

| | Pages | Table rows printed | Header on each page | Left bar | A dark theme prints | Charts |
|---|---|---|---|---|---|---|
| Without the print stylesheet | 1 | **22 of 300** | — | printed | dark (page brightness 28 %) | vector |
| With it | 7 | **300 of 300** | **7 of 7** | not printed | **light** (92 %) | vector, no images |

- **The stylesheet is needed, not a nicety:** the main area scrolls, and only its visible part prints otherwise.
- **It forces the light theme's colours**, so a dark theme doesn't print a black page.
- **Charts need a fixed width in the print layout:** on A4 portrait the bar chart wrapped under the donut.
- **Not checked:** Electron's own `printToPDF` and the native print dialog (the harness prints the same page in
  Electron), and printing on Windows.

#### 6. The engine and the table

The engine prototyped as [The engine](#the-engine) describes it, on synthetic source rows; medians of seven, in ms, the
range of three runs.

| Case | Source rows | Result | Time |
|---|---|---|---|
| 2,000 payees × 24 months, the top 25 and *Other*, shares, compared with the period before | 58,338 | 28 rows × 75 figures | 21.4 to 21.6 (16.9 to 30.4) |
| The same, every payee | 29,186 | 2,002 rows × 50 figures | 26.6 to 33.7 (17.6 to 101.2) |
| A 152-category tree × 120 months, every level with subtotals, averages, compared | 28,289 | 152 rows × 363 figures | 15.5 to 18.6 (12.9 to 26.7) |
| The flow tree × 13 sub-ledger columns, *Net income* and *Net after transfers* | 1,032 | 102 rows × 13 | 1.3 to 4.6 (1.2 to 7.0) |

The figures were integers throughout; the grand total, the rows and the columns reconciled with the source exactly;
and shares in basis points agreed with `BigInt` for 20,000 pairs with totals up to 10¹⁵.

Drawing the table, in ms: first paint (the rows drawn at once on screen), everything drawn, and the longest gap between
two frames (how long the window couldn't respond). Medians of three loads.

| Table | VM: first paint / all / longest gap | 4× slower: first paint / all / longest gap |
|---|---|---|
| 2,000 rows × 3 figures, whole | 476 / 499 / 298 | 1,857 / 1,893 / 1,210 |
| 2,000 rows, 500 at a time after each paint | **185** / 654 / **123** | **789** / 2,526 / **541** |
| 5,000 rows × 3 figures, whole | 958 / 976 / 691 | 3,740 / 3,774 / 2,768 |
| 5,000 rows, 500 at a time after each paint | **222** / 1,927 / **187** | **754** / 6,275 / **509** |
| 152 rows × 122 columns (the tree by 120 months), whole | 825 / 848 / 552 | 3,751 / 3,788 / 2,779 |
| 152 × 122, 40 rows at a time after each paint | **427** / 1,214 / **250** | **1,369** / 4,781 / **1,000** |
| 2,002 rows × 50 columns (every payee by month), whole | 5,424 to 6,394 | over 30,000 |

- **The engine is not the cost; drawing is.** A table drawn whole keeps the window from responding for as long as it
  draws: 0.7 s for 5,000 rows, 2.8 s on a slower machine.
- **Drawn in chunks after each painted frame**, the first rows show in about 0.2 s (0.8 s slower), and the window never
  waits more than 0.19 s (0.5 s). The whole takes longer, unseen.
- **"The rest after the first paint" needs care:** drawing the rest from a `setTimeout(0)` gave no earlier paint at
  all, because the timeout runs before the browser paints, and both land in one frame. The next chunk must wait for a
  painted frame (`requestAnimationFrame`, then a timeout).
- **Cells need a limit.** Every payee by month, 100,100 cells, took 5 to 6 s at the VM's speed. `REPORT_CELLS_MAX` is
  25,000 (5,000 rows of four figures, or the 152-row tree by 120 months, fit): past it the report keeps the top rows
  that fit and says so ("Showing the top 480 of 2,000 payees: choose quarters, or fewer payees").

#### What changes in this note

| Section | Change |
|---|---|
| [The accounts additions](#the-accounts-additions), [R1](#phase-r1-the-ledger-and-accounts-additions-m) | `transactionTotals` **sorts by one precomputed key**: the same order, the sort four times faster, the method about a quarter faster at 100,000, for budgets too |
| [Archived months](#archived-months), [Storage schema](#storage-schema-reports), [R1](#phase-r1-the-ledger-and-accounts-additions-m) | Archived months are packed as **flat arrays of numbers against one dictionary of ids** (`accounts.archivedIds`), categories, transfers and payees alike, not in the budget's nested objects |
| [Archived months](#archived-months), [The accounts additions](#the-accounts-additions), [R1](#phase-r1-the-ledger-and-accounts-additions-m) | **An account an archive removes keeps a record** (`accounts.archivedAccounts`), and `balanceHistory`, `archivedTotals` and the reports include it |
| [The accounts additions](#the-accounts-additions) | `balanceHistory` reads **as measured**: one `find`, buckets by binary search, running sums; no cache |
| [Reports and `@tessera/ui`](#reports-and-tesseraui), [The contract](#the-contract-tesserareports-api), [R3](#phase-r3-the-report-view-the-reports-tab-and-menu-and-charts-l) | The table is **drawn 500 rows at a time, each after a painted frame**; **`REPORT_CELLS_MAX` = 25,000** |
| [Printing and exporting](#printing-and-exporting) | **Confirmed:** the print stylesheet is required, prints the light theme's colours, and gives charts a fixed width |
| [Charts](#charts) | **The palette is Tessera's, per mode**, with R0's candidates; whether MUI X Charts fits was to be determined (R3: it does) |

#### Not verified

- **MUI X Charts** (question 4): answered in R3, in Chromium rather than Electron ([4. Charts](#4-charts)).
- **Electron itself**: its `printToPDF` and native print dialog, and its Chromium 142 (these ran in Chromium 131).
- **Windows and macOS**, a real GPU, a cold disk, the LokiJS engine, and a real ledger beyond the sample household.
- **Tables with MUI's `TableCell` and React 18** (plain cells and React 19 here): B0 found MUI's cells about a fifth
  slower, so the thresholds above have some margin to give.

---

## Phase R1: the ledger and accounts additions (M)

**Goal:** the generic additions to `accounts`, and the ledger's year start, which every report, archiving and new
budgets then share.

### Files

| File | What |
|---|---|
| `packages/accounts-api/model.ts` | `TotalsQuery.byPayee`, `TransactionTotal.payeeId`, `BalanceQuery`, `BalancePoint`, `BALANCE_DATES_MAX` |
| `packages/accounts-api/service.ts`, `transactions.ts` | `balanceHistory`, `archivedTotals`, `PayeeDirectory.get` |
| `packages/accounts-api/rules.ts` | `AccountScopeInput`, `AccountScope`, `accountScope`, `crossesScope` (pure) |
| `packages/accounts-api/index.ts` | `ACCOUNTS_API_VERSION` 1.15.0 |
| `plugins/accounts/src/privileged/transactionsCore.ts` | Totals by payee, as nested maps (R0's `PayeeTotalsBuilder`); **rows sorted by one precomputed key** instead of `compareTotals`; balance history, pure over the documents read: buckets by binary search, then running sums (R0) |
| `plugins/accounts/src/privileged/archiveCore.ts`, `archivedMonths.ts` (new, pure) | `applyArchive` keeps what it removed in `accounts.archivedMonths`, **as flat numbers against the dictionary** `accounts.archivedIds` (categories, transfers and payees), merged by account and month, yielding every 250 months written (R1: a month is a large document; 2,000 would be a 0.4 s stall); and **a record of each account it removes** in `accounts.archivedAccounts`. Packing, unpacking and merging are pure, in `archivedMonths.ts` |
| `plugins/accounts/src/privileged/schema.ts`, `packages/accounts-api/protocol.ts` | `accounts.archivedMonths` (unique `[accountId, month]`), `accounts.archivedIds`, `accounts.archivedAccounts` (unique `[accountId]`), in `ACCOUNTS_COLLECTIONS`. Declaring collections needs no migration, as the budget's note records |
| `plugins/accounts/src/privileged/AccountsServiceImpl.ts` | The methods, with their checks (`INVALID` for bad dates, too many dates, `from` after `to`; `NO_LEDGER`) |
| `packages/ledger-api/protocol.ts`, `model.ts`, `service.ts`, `names.ts` | `LEDGER_META.yearStart`; `LedgerInfo.yearStart`; `setYearStart`; `onDidChangeInfo` (R1: not a new `LedgerChange`); the command, dialog and channel for *Ledger Properties…*; `yearStartOf`, `yearStartProblem`, `yearStartLabel` |
| `plugins/ledger/src/privileged/LedgerSessionImpl.ts` | The year start read from the meta (or, until first written, from the Archiving page's settings), written on the first writable open, and set with its checks |
| `plugins/ledger/src/privileged/commands.ts`, `contributions.ts`, `renderer/PropertiesDialog.tsx` | *File › Ledger Properties…*: the name, the file, *Year starts on*; read-only on an archive file |
| `plugins/ledger/src/privileged/archive/settings.ts`, `archive/command.ts` | The Archiving page keeps *Keep years*; the suggested date uses the ledger's year start |
| `plugins/budget/src/privileged/commands.ts` | New Budget suggests the ledger's year start month, not the Archiving page's |
| `docs/account-manager-design.md`, `docs/ledger-compaction-design.md`, `docs/budget-design.md`, `docs/plugin-creation.md` | The methods; `accounts.archivedMonths` in *What the account records*; the year start in the ledger and the Archiving page; New Budget's suggestion; *Using accounts from another plugin* gains `byPayee`, `balanceHistory`, `archivedTotals` and `payees.get`, and *Storing data in the ledger* the year start |

### Tasks, in order

1. The types, the scope helpers (with *types within a sub-ledger*) and their tests.
2. `transactionTotals` sorted by key, then `byPayee` and `payees.get`.
3. Archived months kept by `accounts`, packed flat with the dictionary; removed accounts' records; `archivedTotals`.
4. `balanceHistory`, using them, removed accounts included.
5. The ledger's year start, *Ledger Properties…*, and the Archiving page and New Budget using it.
6. The docs.

### Tests

- `tests/plugins/accounts/transactionTotals.test.ts` (added to): by payee, rows add up to the rows without it; a
  transaction with no payee under `null`; voids left out; transfers by payee.
- `tests/plugins/accounts/balanceHistory.test.ts`: every date against each register's running balance on that date;
  before an account opened; closed accounts; future-dated transactions; limits and errors.
- `tests/plugins/accounts/archive.test.ts` (added to): **the archive invariant**: `transactionTotals` before =
  `transactionTotals` after + `archivedTotals`, for every account, month, category, transfer account and payee; a
  second archive of the same months adds to them; a rollback keeps nothing; a closed account the archive removes keeps
  its name there; **`balanceHistory` at every month end, and net worth, are unchanged by the archive, an account it
  removes included** (R0's finding); the dictionary is appended to, never rewritten; and a ledger archived without
  totals (as before 1.15) gives no balance before its archive date rather than a wrong one.
- `tests/plugins/accounts/archivedMonths.test.ts`: packing and unpacking round-trip every entry, −1 for none; merging a
  second archive's month; ids never written as numeric keys (R0: they made the writes four times slower).
- `tests/packages/accountRules.test.ts` (added to): `accountScope` and `crossesScope` for each scope kind, against the
  budget's worked cases ([budget-design.md](budget-design.md#actuals)).
- `tests/plugins/accounts/totalsScale.test.ts` (added to): a year by payee within 250 ms, and 120 month ends within
  500 ms, at 100,000; the sort by key gives `compareTotals`' order.
- `tests/plugins/ledger/yearStart.test.ts`: an older ledger reads the Archiving page's year start and writes it on its
  first writable open, not on a read-only one; `setYearStart`'s checks (29 February refused) and event; backups and
  archive files keep it. `tests/plugins/ledger/archiveSettings.test.ts` (changed): the suggested date from the ledger.
  `tests/plugins/ledger/renderer/propertiesDialog.test.tsx`: the dialog, read-only on an archive file.

**Done when:** the [Definition of done](#definition-of-done) holds, the budget's own tests still pass (New Budget's
suggestion aside), and *Ledger Properties…* has been seen in `npm run dev`.

### Phase R1 results

Recorded 2026-11-16. **Built as designed, with the changes below, each for a reason the building found.** Every test
that could run here passes: **991 across 73 files**, and the budget's period tests in an awkward time zone (16), against
936 before R1, with none changed in meaning (the changes are the new *Ledger Properties…* item, dialog and methods in
the lists the activation tests keep, the year start in `LedgerInfo`, the Archiving page's fields, and
`suggestedArchiveDate` taking the ledger's year start). The packages and the plugins' privileged code type-check with
no errors. **Two checks of the [Definition of done](#definition-of-done) were still to make**, where the repository's
dependencies are installed: the renderer and pipeline tests (MUI, jsdom, esbuild and Vite weren't here; the dialog
type-checked against stand-ins for React and `@tessera/ui`, and `propertiesDialog.test.tsx` was written but hadn't
run), and *Ledger Properties…* seen in `npm run dev`. **The first is made: at the start of R3, with the dependencies
installed, every test in the repository passed** (3,365 in 235 files), `propertiesDialog.test.tsx` and the pipeline
tests among them; type-checking the plugins with the real MUI found one mistake in the dialog (`alignItems` given as a
prop of `Stack`, which MUI 9 no longer takes; it is in `sx` now). `npm run dev` is still to run
([R3 results](#phase-r3-results)).

**What was built.**

| Area | What | Where |
|---|---|---|
| Totals by payee | `TotalsQuery.byPayee`, `TransactionTotal.payeeId`; rows **sorted by one precomputed key** (`sortTotals`), which gives `compareTotals`' order (tested on random rows) | `transactionsCore.ts` |
| Payees by id | `payees.get(ids)`: one read, missing ids left out, each once | `transactionsCore.ts`, `AccountsServiceImpl.ts` |
| Archived months | Kept by `applyArchive` in the archive's transaction (`keepArchived`, after `removedTotals`): `accounts.archivedMonths` packed flat against `accounts.archivedIds`, merged into a month an earlier archive kept; `accounts.archivedAccounts` for each account removed | `archivedMonths.ts` (new, pure but for its readers and writers), `archiveCore.ts`, `schema.ts`, `store.ts` |
| `archivedTotals` | The kept months as `ArchivedTotal` rows with `accountName`, by payee when asked, in `transactionTotals`' order | `archivedMonths.ts` |
| `balanceHistory` | As R0 measured it: one `find`, buckets by binary search, running sums; archived months from their first day, a date inside one marked `exact: false`; removed accounts from their records, `removed: true`, after the ledger's | `archivedMonths.ts`, `AccountsServiceImpl.ts` |
| The scope rule | `accountScope`, `crossesScope`, with *types within a sub-ledger*; an archived account judged where it was | `packages/accounts-api/rules.ts` |
| The year start | `LedgerInfo.yearStart` from `LEDGER_META.yearStart`; `setYearStart`; `onDidChangeInfo`; the channel `ledger:yearStart.set`; `yearStartOf`, `yearStartProblem`, `yearStartLabel` | `LedgerSessionImpl.ts`, `ipc.ts`, `packages/ledger-api` |
| *File › Ledger Properties…* | The command (`ledger.properties`, enabled while a ledger is open), the menu item after *Close Ledger*, and the dialog: the name and file, *Year starts in* [month] *On day* [day], what follows it, and read-only with a note for an archive file | `commands.ts`, `contributions.ts`, `renderer/PropertiesDialog.tsx` |
| Archiving and budgets | *Archive Ledger…* suggests the start of the ledger's year, back by *Keep years*; the Archiving page shows only *Keep years*, pointing to *Ledger Properties…*; *New Budget…* suggests the ledger's year start month | `archive/settings.ts`, `ArchiveService.ts`, `plugins/budget/src/privileged/commands.ts` |
| Versions | `@tessera/accounts-api` **1.15.0**, `@tessera/ledger-api` **1.5.0**; no schema version changes (new collections need no migration) | `index.ts` of each |

**Measured** (`totalsScale.test.ts`, 100,000 transactions, CPU time, two runs on the spike's VM): a year **by payee** in
61 to 72 ms (7,271 rows; 40 to 60 ms without); **120 month ends** of balances in 156 to 191 ms; **keeping an archive's
totals** (89,066 transactions removed, 1,620 months kept) in 432 to 562 ms, in 16 stretches of at most 45 to 66 ms
between turns.

**How it differs from the design, and why.**

| Designed | Built | Why |
|---|---|---|
| `onDidChange` announces a new year start as `{ type: 'changed', ledger }` | **`onDidChangeInfo`**, an event of its own | Every plugin listens to `onDidChange` and reads it as *opened* or *closed*; a third kind would reach code written for two. An event only for it reaches only those who ask |
| History incomplete "when `archived.count` is more than the counts kept" | **`AccountArchived.countWithTotals`**, kept by each archive since 1.15, voided transactions included | Kept totals leave voided transactions out, so their counts can't be compared with `archived.count`; a count of its own is exact and costs nothing |
| Archived months written "yielding every 2,000 writes" | **Every 250 months** (`KEEP_YIELD_EVERY`) | A month is a large document, packed and merged; 2,000 would be one 0.4 s stretch at 100,000 |
| 120 month ends within 500 ms | **750 ms of CPU time** in the scale test, measured at 156 to 191 ms | CPU time on Node before 23.9 counts the collector's helper threads; 538 ms was seen under a loaded run. The design's 500 ms by the clock is met |
| (Not in the design) | Deleting a sub-ledger **moves archived totals and removed accounts' records to its parent**, as the budget moves its own | Otherwise archived months would report under a sub-ledger that is gone |
| (Not in the design) | Transfers in `archivedTotals` by payee come with **a null `payeeId`** | Archived transfers are kept by other account, not by payee (R0's packing); live transfers by payee are exact |
| (Not in the design) | `accountName` only in `archivedTotals`, not `removedTotals` | `removedTotals` is what an archive is about to remove, for the budget, whose accounts all still exist then |
| An existing ledger is given the Archiving page's year start | **A new ledger is given it too** | Someone who archived at a tax year's end and starts a new ledger keeps their year; the page no longer shows it, and a first ledger gets 1 January |
| (Not in the design) | `setYearStart` **counts as a change** for the next backup and for an archive's check that nothing changed since its copy | Meta isn't a collection, so the database's change event doesn't see it, and the backup on close would miss it |

**Found while building.**

- **Balances after an archive that kept no totals were wrong, not missing.** The first version built every history
  from the original opening balance, so once a ledger archived before 1.15 was archived again, balances after the first
  archive date lacked what that archive had taken. Now an account with an incomplete history has no point before its
  last archive date, and from then on starts from the opening balance the archives carried everything into, adding no
  archived months; a removed account with an incomplete history is known only from its removal, at zero. A test of a
  ledger as an archive before 1.15 left it covers it (`archive.test.ts`).
- **Mutation checks** (a rule broken on purpose, and a test seen failing) were run on the new code of both plugins:
  in `accounts`, the archive, totals and balance code; in `ledger`, the write of an older ledger's year start, its
  absence on a read-only file, the change counted for backups, the event, the state the views follow, the copies
  `current` hands out and the same year start set twice. Each was caught but one, which showed the year start written
  twice on *New Ledger* (opening writes it anyway); the extra write was removed.

**Not verified.**

- **The renderer and pipeline tests**, and so the dialog in a browser, and the built plugins: they needed the
  repository's installed dependencies. (Run in R3: they pass.)
- **`npm run dev`**: *Ledger Properties…* in the File menu, its dialog in light and dark, and an archive file's.
- **Windows and macOS**, and the LokiJS engine for the new collections (the memory engine ran every test).

---

## Phase R2: the report domain, with no UI (L)

**Goal:** the contract, the engine, both sources, the seven shipped definitions, `reports.service` and saved reports,
proved against the real accounts service, with nothing drawn.

### Files

| File | What |
|---|---|
| `packages/reports-api/` | `index.ts`, `protocol.ts` (ids, limits), `errors.ts`, `spec.ts`, `validate.ts` (R2: the checks and options, apart from the types), `periods.ts`, `labels.ts` (R2: how periods and columns read, apart from the date arithmetic), `engine.ts`, `source.ts`, `result.ts`, `service.ts`, `package.json`, `tsconfig.json`; `REPORTS_API_VERSION` 1.0.0. Channels come with the views, in R3 |
| `tsconfig.base.json`, `tests/architecture/boundaries.test.ts` | The alias, and `reports-api` among the platform-free packages (`@tessera/types`, `@tessera/ledger-api`, `@tessera/accounts-api`) |
| `plugins/reports/manifest.json` | Requires `accounts.service`, `ledger.session` (R2; R3 adds `shell.prompts`, `shell.files`, `app.state` with the views); provides `reports.service`, `reports.migrator`, `reports.flows`, `reports.balances` |
| `plugins/reports/src/privileged/flows.ts`, `balances.ts`, `ledgerView.ts` | The sources' pure parts: classifying totals into groups by the scope rule; building balance rows; (R2) the accounts as reports place them, removed ones included, scopes, their labels, and sub-ledger columns |
| `…/FlowsSource.ts`, `BalancesSource.ts` | The two services |
| `…/registry.ts` | Sources, groups and definitions: validated, ordered, followed as contributed; a missing service makes its reports unavailable |
| `…/run.ts` | Resolving parameters, the source (twice to compare), the time limit, `shape` |
| `…/definitions/*.ts` | Income vs Expenses, Spending by Category, Spending by Payee, Net Worth, Account Balances, Cash Flow, Category Trends |
| `…/ReportsServiceImpl.ts`, `store.ts`, `schema.ts`, `participants.ts` | `reports.service`; `reports.saved` and its migrator; the sub-ledger participant |
| `…/index.ts` | Activation: providing, contributing, following the ledger |

### Tasks, in order

1. `@tessera/reports-api`: the types, `specProblems`, `applyOptions`, `periods.ts` (on the ledger's year start),
   then `shape`, with net rows and sub-ledger columns.
2. The registry and the run, with a fixture source.
3. The flows source; then the balances source.
4. The seven definitions, each with its tests.
5. `reports.service`; saved reports (both `basis` kinds), the schema, the migrator and the sub-ledger participant.

### Tests

- `tests/packages/reportsApi.test.ts`: every preset on every day of several years, year starts on the 1st of each
  month and on days such as 6 April and 28 February, leap days, and a time zone with half-hour daylight saving; `specProblems` for each rule, with its path; `applyOptions`' merge rules;
  `shape` on fixture rows: roll-ups at each depth, "(other)" rows, top and *Other*, totals by each `combine`, net rows,
  shares (against `BigInt`), averages, changes, running totals, comparison with members in one period only, limits.
- `tests/plugins/reports/flows.test.ts`: the *What counts* table, case by case, and the budget's worked cases over a
  sub-ledger; **every counted transaction in one row**; archived and live together, and a custom period cutting an
  archived month (its archived part left out, and noted); members chosen in the parameters.
- `tests/plugins/reports/balances.test.ts`: against registers and `chart().totals`; before and after an archive.
- `tests/plugins/reports/subLedgers.test.ts`: over *Personal* and over *Business*, the owner's pay is a transfer in
  and out, never income or an expense; **side by side, each column equals the report run over that sub-ledger alone,
  and income, expenses, net income and net after transfers add up to the whole**, while transfers between them cancel;
  accounts directly in the scope get their own column; *Everyday accounts in Business*; a sub-ledger nested two deep.
- `tests/plugins/reports/definitions.test.ts`: each of the seven against a ledger built in the test, with its figures
  written out, as this note's examples are; **Cash Flow's identity**; **Spending by Payee's total is Spending by
  Category's**; every option validates.
- `tests/plugins/reports/registry.test.ts`: contributions in any activation order; bad ids, unknown sources, invalid
  specs and options refused with one warning each; a source whose service is missing; a contribution withdrawn.
- `tests/plugins/reports/saved.test.ts`: names, both kinds, a definition's version moving on, a definition gone,
  sub-ledger deletes (and one rolled back), read-only, conflicts.
- `tests/plugins/reports/archive.test.ts`: **no report of any period changes through an archive**.
- `tests/plugins/reports/pipeline.test.ts`: the built plugin on SQLite, a real file, a reopen, an archive file.
- `tests/architecture/boundaries.test.ts` (added to): no shipped definition's id in the manager's code; no floating
  point in figures.

**Done when:** the [Definition of done](#definition-of-done) holds, and every example figure in this note is produced by
a test.

### Phase R2 results

Recorded 2026-11-16. **Built, with the report domain proved against the real accounts service and nothing drawn.** Every
example figure in this note is produced by a test ([what the tests hold](#what-the-tests-hold)), and **no report of any
period changes through an archive**. The tests that can run here pass: **1,079 in 83 files** (the architecture tests now
among them), the budget's period tests and `@tessera/reports-api`'s in a time zone with half-hour daylight saving (16
and 35), against 991 and 16 after R1: 109 new, none changed in meaning. The packages and the plugins' privileged code
type-check with no errors. **Still to run**, where the repository's dependencies are installed:
`tests/plugins/reports/pipeline.test.ts` (the built plugin on SQLite, a restart, an archive file opened read-only),
written and checked against the memory engine, but not built. **Run at the start of R3, with the dependencies
installed: it passes.** R2 has no UI, so no renderer test and nothing to see in `npm run dev` beyond the plugin
activating.

**What was built.**

| Part | What | Where |
|---|---|---|
| The contract | `@tessera/reports-api` **1.0.0**: the three points, `reports.service`, sources, specs, options, results, errors, limits, `EVERYDAY_ACCOUNT_TYPES`; platform-free, on `@tessera/types`, `ledger-api` and `accounts-api` only (the architecture test holds it to that) | `packages/reports-api/` |
| Checks | `sourceProblem`, `groupProblem`, `specProblems` (each problem with its path), `definitionProblems` (no ledger ids; every option's every value), `parameterProblems`; options as RFC 7396 merge patches (`applyOptions`, `optionValues`); `migrateSpec` | `validate.ts` |
| Periods | Presets on any year start, to its day; quarters and years; *Compare with*'s periods; time columns; as-of dates; on day numbers, never a `Date` | `periods.ts`; labels in `labels.ts` |
| The engine | `shape`: filter (a tree's member with its descendants), roll up to a depth or show every level with "(other)" rows, pivot time, sub-ledgers or members across, sort, top rows and *Other*, totals by each measure's `combine`, net rows, balance rows, shares, averages, changes and running totals (exact, through `BigInt`), several currencies kept apart, the chart's series, the cell limit | `engine.ts` |
| The sources | `reports.flows` (one `transactionTotals` a run, archived totals, classification by the scope rule, balance measures for Cash Flow) and `reports.balances` (`balanceHistory`, by type or place), both following the ledger and accounts | `flows.ts`, `FlowsSource.ts`, `balances.ts`, `BalancesSource.ts`, `ledgerView.ts` |
| The registry and the run | Contributions in any order, validated once, a warning each; unavailable with the plugin named; parameters resolved against the ledger; the source asked within its time limit and its reply checked; compared periods; balance rows | `registry.ts`, `run.ts` |
| The seven definitions | Income vs Expenses, Spending by Category, Spending by Payee, Category Trends, Cash Flow, Net Worth, Account Balances, with their options, through `reports.definitions`; the two groups | `definitions/` |
| `reports.service` and saved reports | Definitions, groups, open, run, runSpec; saved reports in `reports.saved`, both kinds, with their checks; the sub-ledger participant; the schema and migrator | `ReportsServiceImpl.ts`, `store.ts`, `schema.ts` |
| Accounts, found missing | `accounts.service.removedAccounts()`, the records archives keep of the accounts they remove: a scope of account types, or a report by sub-ledger, can't place a removed account's history without its type and where it was. Added to 1.15, which isn't released | `packages/accounts-api`, `plugins/accounts` |

**Measured** (`tests/plugins/reports/scale.test.ts`, 100,000 transactions, CPU time, two runs): a year of Income vs
Expenses in 67 to 92 ms, Spending by Category 55 to 76, Spending by Payee (every payee) 75 to 88, Category Trends 52 to
102, sub-ledgers side by side 65 to 72, Net Worth over ten years of month ends 130 to 229 ms, all inside the quarter
second the goals ask; **Cash Flow 201 to 303 ms**, over it at times, since its balance rows read every transaction up to
the period's end through `balanceHistory`. Listed in [todo.md](todo.md) for if it is felt.

**How it differs from the design, and why.**

| Designed | Built | Why |
|---|---|---|
| `shape(spec, source, result, compared?) → ReportResult` | `shape(input)`, with the rows' dimensions and measures, the time columns, the sub-ledger columns, the compared result and the balance rows; the run adds title, subtitle and period | Columns need the period and the year start, which the spec doesn't hold; sub-ledgers and balance rows come from their own queries |
| Flows has `month`, `quarter` and `year` dimensions | One time dimension, `month`; quarters and years are the axis's `grain`, bucketed by the engine | A source then never needs the year start, and the spec says what it means once |
| `ReportsService`: definitions, saved, run, runSpec | Also `groups`, `open`, and `saveReport`, `updateReport`, `duplicateReport`, `deleteReport`; `ReportsChange.sources` | The views (R3), and later the designer, need them; the checks live in one place. `sources` says which reports are stale |
| (Not in the design) | `Axis.subtotals` (`'below'`: a heading, the children, "Total income", for the top members only); a signed tree's top members keep their order whatever the sort | The examples show both styles (Income vs Expenses, Cash Flow); Expenses must never sort above Income |
| (Not in the design) | `DimensionField.noneLabel` and `plural`, `Member.none`, `MeasureField.negativeIsBad`, `ChartSpec.limit`, result row kind `balance` | What the examples show ("No payee", "Other payees (143)", Uncategorised last under Income and Expenses, the top ten bars) had to be said somewhere; data, so the designer can offer them |
| (Not in the design) | Balances' `state` dimension; Net Worth and Account Balances filter on it, *Include closed accounts* removes the filter | "Closed accounts with a balance of zero are left out" is a rule about a date: an account open then is shown, one closed and empty isn't |
| `BALANCE_DATES_MAX` in `reports-api` | `REPORT_DATES_MAX` | A plugin importing both packages would meet two exports of one name |
| A definition's `when` offered or not | Carried in `ReportDefinitionInfo.when`, not evaluated yet | Plugins can't evaluate context expressions (that code is the shell's); R3's menus and tab follow it |
| (Not in the design) | A definition whose group isn't contributed is listed under *Other Reports* | Rather than nowhere, silently |
| Error codes | Also `SOURCE_FAILED` | A source that throws, or whose reply can't be used, fails its report alone, saying so |
| *All dates* from the earliest opening date to the latest transaction | To the later of today and the end of the last month with a transaction after today | One cheap read of what is dated after today, rather than of every transaction |
| Time on either axis | Time goes across the columns only | Enough for every report; the designer may want it down the rows |
| Labels "January to March 2026" | `Intl` ranges in the user's locale: "January – March 2026", "10 Mar – 15 Apr 2026" | Locale-correct ranges for free; the examples' words are illustration |
| Quarter and year columns "from the 1st" for a year from 6 April | Whole months, with the first and last columns partial, labelled by their dates ("6 Apr – 30 Jun 2026"), and a note | Totals are by month; a partial column says exactly what it holds |
| Uncategorised money in and out apart | So, and a total with both keeps its count with the money out | A total doesn't say how many transactions went each way; every transaction is still counted once |
| Sub-ledger example's order | By the whole ledger's figure, largest first (Office and software before Transportation) | Income vs Expenses sorts by value; the example is as produced |
| A change when one period has nothing | The change from nothing (+90.00), "—" only when both are empty | A new category this year is a change |
| Manifest requires shell prompts, files and app state | Only `accounts.service` and `ledger.session` | R2 has no UI; R3 adds them with the views |

**Found while building.**

- **`accounts.service` couldn't place an account an archive removed.** Archived totals carry its currency and
  sub-ledger, but not its type, so *Everyday accounts* would have dropped its archived months, and Net Worth by type its
  balances. `removedAccounts()` gives the records the archive already keeps.
- **A closed account looked closed before it was.** The first rule called a removed account "closed and empty" at every
  date, so Net Worth's liabilities differed, before and after an archive, on the day its last payment cleared it. It is
  closed from its closing date, removed or not. The archive test found it.
- **A share could be a basis point high in floating point** for large figures (1,000,000,000,000,031 × 10⁴ ÷
  4,837,929,366,231,403 gives 2,067, not 2,066), so shares are worked out with `BigInt`; a test holds it.
- **Mutation checks** (a rule broken on purpose, a test seen failing) on the classification, the scope and currency,
  the archived totals, balance rows, the net-row rule, *Uncategorised* last, the tree order, "(other)" rows, the source
  reply checks, the sub-ledger participant, the closed-account rule and the engine's exact division. Two survived at
  first (the closed-account rule, and a transfer's other side known only from its archived total); a test was added for
  each.

#### What the tests hold

| Test | What it proves |
|---|---|
| `tests/packages/reportsApi.test.ts` | Every preset on every day of 2023 and 2024 for sixteen year starts (the 1st of each month, 6 April, 28 February, 31 January and 31 December); compared periods; columns; as-of dates; labels; in a zone with half-hour daylight saving; each check with its path; merge patches; the engine on plain rows, rule by rule |
| `tests/plugins/reports/definitions.test.ts` | The examples of Income vs Expenses, Spending by Category, Spending by Payee, Net Worth, Cash Flow and Category Trends, figure for figure; Account Balances' layout; Cash Flow's identity, month by month, over three scopes; Spending by Payee's total is Spending by Category's; every option |
| `tests/plugins/reports/flows.test.ts` | The *What counts* table, case by case; scopes of every kind; every counted transaction in one row, on random ledgers; archived and live together; a month cut in two |
| `tests/plugins/reports/balances.test.ts` | Balances against each register; net worth against `chart().totals`; after an archive, a removed account included; today's note |
| `tests/plugins/reports/subLedgers.test.ts` | The sub-ledger example; each column equals the report over that sub-ledger alone; sums across; the scope's own accounts; nested two deep; everyday accounts in one sub-ledger |
| `tests/plugins/reports/archive.test.ts` | Every flows report over seventeen periods, and balances at month ends, identical before and after an archive that removes over 200 transactions and a closed card; the same side by side |
| `registry.test.ts`, `saved.test.ts`, `activation.test.ts`, `scale.test.ts` | Contributions in any order and refused with a reason; a source's reply and time limit; saved reports, both kinds, sub-ledger deletes, read-only; the plugin as the app activates it; speed |
| `tests/architecture/boundaries.test.ts` (added to) | No shipped definition's id in the manager's code; no floating point in the engine, periods or sources' rules; no `Date` in `periods.ts` |

The household of the examples is built in `tests/plugins/reports/examples.ts`: 2026 of salary, rent, 148 payees (the
five the examples name and 143 others) and nine purchases with none, a transfer to an RRSP; the sole proprietor's March; and a mortgage's
six month ends.

---

## Phase R3: the report view, the Reports tab and menu, and charts (L)

**Goal:** reports on screen: the tab, the view with its parameters, the table and the chart, Show Transactions, the
menu; read-only; kept current.

### Files

| File | What |
|---|---|
| `tessera-ui/` | The charts chosen in R0 (or our own), the chart palette in the shell's theme, `@tessera/ui` **1.6** (and `@tessera/ui/charts` if R0 says) |
| `shared/theme/` | `palette.chart` tokens, checked for contrast; a theme may set them |
| `plugins/reports/src/privileged/contributions.ts`, `menu.ts`, `commands.ts`, `ipc.ts`, `refresh.ts`, `viewState.ts` | The tab, view and dialog contributions; mirroring definitions into the menu; commands and context keys; the channels; keeping shown reports current |
| `plugins/reports/src/renderer/ReportList.tsx`, `ReportView.tsx`, `ParameterBar.tsx`, `ResultTable.tsx`, `ResultChart.tsx`, `TransactionsDialog.tsx`, `tableModel.ts`, `chartModel.ts`, `bridge.ts` | The UI |
| `README.md`, `docs/plugin-creation.md` | *Reports* in *What works today*; the charts in *Styling and theming* |

### Tasks, in order

1. Charts in `@tessera/ui`, with their theme tokens and font roles.
2. The Reports tab and the catalog.
3. The report view: the heading and its parameters (*Accounts* as the ledger's tree, carried from report to report;
   *Compare with*, *Sub-ledgers* included), the table (500 rows at a time, each after a painted frame; at most 25,000
   cells), then the chart, with the palette R0 chose.
4. Show Transactions.
5. The Reports menu, mirrored; the commands and context keys.
6. Keeping shown reports current; read-only.

### Tests

- `tests/renderer/charts.test.tsx`: each kind draws its series in the palette's colours, in light and dark; text in the
  font roles; a label for screen readers.
- `tests/plugins/reports/renderer/reportView.test.tsx`: the heading's parameters run the report; trees collapse; keys;
  negative figures coloured by token; empty, failing and stale states; a slow reply overtaken by a newer one; the
  *Accounts* choice carried to the next report, a saved report keeping its own; sub-ledger columns and their note.
- `tests/plugins/reports/renderer/resultTable.test.tsx`: one test mounts 2,000 rows; the next chunk waits for a
  painted frame; past 25,000 cells, the top rows that fit and the note.
- `tests/plugins/reports/menu.test.ts`: a definition contributed during activation, before or after the manager,
  becomes a command and an item under its group; `when` disables it.
- `tests/plugins/reports/refresh.test.ts`: one run for a burst of changes; none while hidden, one when shown again; a
  new year start in *Ledger Properties…* runs the shown report again.

**Done when:** the [Definition of done](#definition-of-done) holds, and each of the seven reports has been seen in
`npm run dev` on the sample household, in light and dark themes, and from its archive file.

### Phase R3 results

Recorded 2026-11-17. **Built, and seen working in a real browser; not yet seen in `npm run dev`.** This was the first
phase with the repository's dependencies installed (`npm install` reached the registry), so it also **ran what R1 and
R2 couldn't**: every test in the repository, R1's *Ledger Properties…* dialog test and R2's pipeline test among them,
passed before R3 began (**3,365 in 235 files**). After R3: **3,491 tests in 246 files**, 126 of them new, in 11 new
files. R3's own tests passed in every full run after the first, which found two of them checking styles jsdom can't
work out ([found while building](#found-while-building-r3)). The whole suite passed in the run at the machine's usual
speed; in slower runs, a few of other features' slow dialog tests time out under load, as in earlier phases (in the
last run, one: the budget view's *More menu*, 3.3 s alone). `npx tsc --noEmit -p plugins` has no errors; `-p tests`
has the 28 it had before (none in R3's files). Electron's binary wasn't downloaded, so `npm run dev` couldn't run: the
by-hand check is still to make. In its place, **the charts and the report view were tested in headless Chromium**, a
new kind of test ([below](#browser-tests)).

**R0's question 4 is answered: MUI X Charts fits** ([4. Charts](#4-charts), *Answered in R3*), and is used, behind
`@tessera/ui/charts`. Nothing is left [to be determined](#to-be-determined).

**What was built.**

| Part | What | Where |
|---|---|---|
| Charts | `@tessera/ui/charts`, a second entry of `@tessera/ui` **1.6.0**: one component, `Chart` (bar, grouped and stacked bar, line, area, donut, and a series drawn as a line over bars), drawn by **MUI X Charts 9.17** (MIT) composed from its parts, in the theme's palette and font roles, labelled for screen readers. Series carry a `tone` (`positive`, `negative`, `emphasis`) for the theme's success, error and text colours. No MUI X export reaches a plugin | `tessera-ui/charts/` |
| Sharing it | The shell shares the entry as **its own singleton, loaded the first time a view imports it** (`lazySingleton`); the plugin build marks it shared and never bundles it; an alias in the shell's Vite config, Vitest's and `tsconfig.base.json`. The reports plugin loads its chart module lazily too, so nothing of MUI X loads until a chart is drawn | `federationViewLoader.ts`, `build-plugins.mts` |
| The chart palette | `ThemeTokens.chart`: 1 to 12 colours a theme may set, the shell's for the rest; R0's candidates as the shell's, per mode; each checked for 3:1 against the paper; `palette.chart` in MUI's theme | `tessera-types/theme.ts`, `shared/theme/`, `createShellTheme.ts`, `tessera-ui/palette.ts` |
| The contract | `@tessera/reports-api` **1.1.0**: the commands, context keys, views, dialog, menu, channels and events; the catalog, `OpenedView`, `RunArgs`, `TransactionsArgs`; **`ResultRow.drill` and `ResultColumn.drill`**, what a figure stands for, made by the engine when a source can list transactions; `DrillKey` as lists of keys | `views.ts`, `result.ts`, `source.ts`, `engine.ts` |
| Show Transactions | `reports.flows` lists transactions (`drillDown: true`): each made a total of one and classified by the same rules as the figures, matched by the figure's keys (a tree's with what is beneath, a parent's own alone, a net signed), with the report's filters; archived months said apart; at most 1,000 | `drill.ts`, `FlowsSource.ts` |
| The run, split | `planRun` works out what a run asks (period, columns, scope, sub-ledger scopes, currency, filters, the period compared with); the run and Show Transactions both use it, so a list can't disagree with its figure about what it covers | `run.ts` |
| The privileged side | The Reports tab and report view (`ShowChart`), the Reports menu after Budget, the dialog; **the menu mirror** (`reports.show.<id>` and an item under each group's submenu, as definitions come and go); the commands; the catalog, sent only when it changed; context keys; *Accounts* remembered per ledger (50 kept) and carried; stale figures gathered into one event per 250 ms, naming their sources | `contributions.ts`, `menu.ts`, `commands.ts`, `viewState.ts`, `viewSupport.ts`, `refresh.ts`, `ipc.ts` |
| The views | The Reports tab; the report view (a landing with the reports when none is chosen; the heading and its parameters; chart, table or both; notes; empty, failing and stale states; Page Up and Page Down; F5); the table (a tree grid drawn 500 rows a painted frame); the Transactions dialog | `plugins/reports/src/renderer/` |
| The manifest | Requires `shell.prompts` and `app.state` too; a renderer with three modules | `manifest.json` |

**How it differs from the design, and why.**

| Designed | Built | Why |
|---|---|---|
| Charts in `@tessera/ui`'s main module, or a second entry "if they are large" | A second entry, `@tessera/ui/charts`, loaded on first use | They are large: 423 KB minified, 133 KB gzipped. The window's start-up doesn't pay for them |
| (Not in the design) | `Chart` has Tessera's own props (`kind`, `categories`, `series` with `tone`, `format`, `formatAxis`, `label`), not MUI X's | What draws the charts can change without any plugin changing, as the facade intends |
| `show` event: a command asked the view to show a report | **`ReportsCatalog.shown`**, with a count of requests | A view not yet mounted would miss an event; the catalog is followed from the start. The count makes showing the report shown again, with other parameters, a change |
| `drill` channel | **The `reports.transactions` command**, which gathers and shows the dialog on the privileged side | As the budget's Show Transactions; other plugins can run it |
| A `DrillKey` per figure, on each row | **`RowDrill` on the row and `ColumnDrill` on the column**, put together on the privileged side with the run's own plan | 25,000 figures would carry 25,000 keys; a row and a column say it once. `DrillKey` holds lists of keys (1.0's one key couldn't say what *Other* gathers); nothing used 1.0's |
| (Not in the design) | `RowDrill.signed`, `DrillKey.signed`: a net's transactions listed with their sign | The test that every list adds up to its figure failed on *Net income*: listed unsigned, March's came to 6,664.75 against a net of 1,760.05 |
| `run` carries a `seq` | The view counts its own runs and drops a late reply, as the budget view does | Nothing to send across |
| *Accounts*: one list of choices | A list (the whole ledger, the tree, *Chosen accounts…*) and *Everyday accounts only* where the report takes account types | Every combination in one list would be long |
| `tests/renderer/charts.test.tsx`, `resultTable.test.tsx` mounting 2,000 rows | `tests/browser/charts.test.ts` and `reportView.test.ts` in Chromium; `resultTable.test.tsx` mounts 1,200 rows | jsdom lays nothing out, so MUI X draws nothing measurable in it, and it can't paint; it also takes about 8 s to mount 2,000 MUI rows, near the 15 s limit under load |
| The manifest requires `shell.files` too | Not yet | Nothing in R3 writes a file; R6's exports will |

<a id="browser-tests"></a>**Browser tests, new in R3.** Until now, anything needing a real browser was checked by hand
(R0's harnesses ran in a Chromium beside the repository, and were deleted). `tests/browser/` makes it a test: each file
bundles a page from the components under test (React, MUI and the shell's theme, as the app bundles them) with esbuild,
opens it in headless Chromium through `playwright-core`, and asks it what it drew. Chromium is found from
`TESSERA_CHROMIUM`, Playwright's own browser, or the newest in `PLAYWRIGHT_BROWSERS_PATH` (or `~/.cache/ms-playwright`);
**with none, the files skip, saying why**, so a machine without a browser still runs everything else
(`npx playwright install chromium` gives one). With `TESSERA_SCREENSHOTS` set to a folder, they save screenshots to
look at. They run with the rest (`npm test`), about 10 s in all.

| Test | What it proves |
|---|---|
| `tests/browser/charts.test.ts` | Each kind draws its series in the palette's colours, in order, light and dark; tones in the theme's success, error and text colours; a theme's own palette colour by colour; straight lines; only positive slices; axes and legend in *Small text* and the secondary text colour; the label; one series, no legend; no console error |
| `tests/browser/reportView.test.ts` | Income vs Expenses with its chart and table, light and dark: bars in the income and expense colours, the net over them, figures in the figures' role with tabular digits, a negative net in the error colour; **5,000 rows painted in chunks, no frame a large share of the whole**; 25 columns scrolling sideways with no figure cut; hidden as the shell hides a view, it runs again only once shown, with a real `IntersectionObserver` |

**Measured** (the spike's VM; Chromium 141's headless shell; medians where repeated):

- **MUI X Charts** (R0's sizes, its harness written again): 423 KB minified, 133 KB gzipped (`@mui/x-charts` 229 KB,
  the rest its gestures and d3 parts); first paint of 12 lines of 24 points 114 ms (588 ms on a CPU 4× slower), 2,000
  bars 666 ms (3.1 s), a donut 73 ms (344 ms); R0's own SVG charts were 37 to 97, 93 to 137 and 38 to 68 ms. Reports
  draw at most 12 series, 8 slices and the top ten bars, so the 2,000-bar case doesn't arise.
- **The table**, 5,000 rows: the first rows after 0.2 to 0.6 s, all of them after 1.5 to 2.7 s, **the longest frame
  150 to 233 ms** (once 433 ms), over about 24 frames. As first built it was 9.0 s, with a frame of 1.3 s
  ([found](#found-while-building-r3)).

<a id="found-while-building-r3"></a>**Found while building.**

- **Chunks made the table slower, not faster, as first written.** Each chunk drew every row before it again, and every
  cell worked out its own style, so 5,000 rows took 9 s with a frame of 1.3 s, worse than drawing them at once. Rows are
  now memoised (a chunk draws only its own) and the styles are the table's, once, by data attributes. Only the browser
  test could show it; jsdom can't paint.
- **A net's transactions didn't add up to it** (above): the test that every figure's list adds up to the figure, over
  the five flows reports, found it.
- **The view never noticed being hidden.** It watched its root element from the first render, when only a spinner was
  drawn; the root came later, and was never watched, so a hidden report would have run on every change. One root is
  now drawn from the start. The jsdom test with a stubbed `IntersectionObserver` found it, and the browser test holds it.
- **The Accounts list showed nothing for *Whole ledger*,** whose value was `''`, which a select reads as nothing chosen.
- **The report's title was named by its tooltip:** MUI's `Tooltip` labels its child with the title, so screen readers
  heard the description instead of "Income vs Expenses"; it describes it now.
- **A chart of one series still drew a legend:** MUI X's wrapper hides a legend's space, not the legend drawn in it.
- **The full suite's time-outs follow the machine's speed.** This was the first phase to run the whole suite with
  everything installed, and the sandbox's speed varied threefold between runs of it (275 to 807 s; it is a VM, and the
  host takes some of its CPU). The known slow dialog tests of other features ([todo.md](todo.md), *Slow dialog
  tests*: 1 to 4 s alone, 15 s allowed) time out in the slow runs, from none in the run at 275 s to 21 in the run at
  807 s, a different few each time, each passing alone. Two tests of time budgets failed the same way: R2's reports
  scale test (Cash Flow at 721 ms of CPU time against 500; 187 ms alone), which now takes the least of five runs rather
  than the median of three, since a loaded machine only ever adds time; and R1's archive scale tests, whose typical
  stretch between turns was held to 50 ms of CPU time and took 51 to 58 (CPU time itself doubled under load), now held
  to a share of the whole, which says what they are for (many short stretches) at any speed. Two precautions besides:
  **tests that build 100,000-transaction ledgers** (six, from the accounts, budget, export and reports phases) run in
  a project of their own, `heavy`, each in a fresh worker, so their heaps neither slow the jsdom tests that would
  share their workers nor make their own collections slower; and **the browser tests run after every other file**
  (`sequence.groupOrder`), so Chromium doesn't compete with the jsdom tests. R3's jsdom tests were checked to leave
  nothing running after them (no timer or frame in the next 1.5 s).
- **A build test measured the federation plugin, not the view** (found after R3, in another install). The test that
  the charts' entry is shared held the view's chunk to 5,000 bytes; the chunk is one small function plus
  `@module-federation/vite`'s wrapper for a module shared on first use, inlined, 4.3 KB in one install and 5.3 KB in
  another (its packages aren't locked: there is no lockfile). It now holds the chunk to 20 KB and looks for MUI X's
  code by name; a plugin built with MUI X bundled in, tried on purpose, gives a chunk of 1.28 MB and fails both.
- **jsdom can't judge styles set by a parent's selector.** Its computed styles ignore specificity and take rules in the
  order they were added, so MUI's own cell rule, added after the table's, "won" there, and two tests of the table's
  colours and alignment failed in jsdom while the page was right in Chromium. Those checks are the browser test's; the
  jsdom tests check the attributes the styles are keyed on.

**Not verified.**

- **`npm run dev`**: each report in the window, on the sample household, light and dark, and from its archive file;
  the Reports menu in Electron's menu bar; the Reports tab among the others. Electron's binary wasn't downloaded.
- **The built plugin in Electron**: the federation build is tested (the charts' entry shared, not bundled), and the
  plugin builds, but a view loaded from it in the window wasn't seen.
- **Windows and macOS**, and screen readers beyond the labels the tests read.

---

## Phase R4: customising and saving reports (M)

**Goal:** *Customise Report…*, saved reports in *My Reports*, the Reports page, and remembering the last choices.

### Files

| File | What |
|---|---|
| `plugins/reports/src/renderer/CustomiseDialog.tsx`, `SaveDialog.tsx` | The dialogs; the options drawn from the definition |
| `…/privileged/commands.ts`, `ipc.ts` | Save, Save As, Rename, Duplicate, Delete; `saved.*` channels |
| `…/privileged/settings.ts` | The Reports page |
| `…/privileged/viewState.ts` | The last parameters and options per definition, per ledger (50 ledgers) |

### Tests

- `tests/plugins/reports/renderer/customiseDialog.test.tsx`: every option of every shipped definition drawn and
  applied; *Show the top*.
- `tests/plugins/reports/renderer/saveDialog.test.tsx`: names taken, read-only, a conflict.
- `tests/plugins/reports/settings.test.ts`: the page's two fields, their defaults and ranges, with the page's words for
  a value out of range; a change to *Rows before "Other"* re-runs the shown report; *Open reports on* applies to the
  next report opened, and never over the user's last choice for a report. (A new ledger year start re-running the
  report is R3's, in `refresh.test.ts`.)
- `tests/plugins/reports/saved.test.ts` (added to): a saved *Last 12 months* report a month later shows the new twelve;
  a `spec` saved report runs (the designer's path, with no UI).

**Done when:** the [Definition of done](#definition-of-done) holds, and saving, reopening and customising have been
seen in `npm run dev`.

### Phase R4 results

Recorded 2026-11-17. **Built, and tested; not yet seen in `npm run dev`** (Electron's binary still can't be downloaded
here). **3,541 tests in 251 files**, 50 of them new, in 5 new files (and R2's and R3's tests brought to Spending by
Payee's version 2). The whole suite passed in a run at the machine's usual speed (362 s); in a slower one (438 s,
with a type-check running beside it) three of other features' slow dialog tests timed out, with two more failing
after them, the known flake ([todo.md](todo.md), *Slow dialog tests*); none of R4's. `npx tsc --noEmit -p plugins`
has no errors; `-p tests` has the 28 it had before (none in R4's files).

**What was built.**

| Part | What | Where |
|---|---|---|
| The contract | `@tessera/reports-api` **1.2.0**: the Reports page's names, settings and defaults; `TOP_OPTION` and `applyTop`; an axis's `top: 'user'`; the commands (Customise, Save, Save As, Rename, Duplicate, Delete), `reports.changed`, the two dialogs, the `saved.*` channels; `ViewChoices` with each selection; `OpenedView.collapsed`; the catalog's `changed` and its `shown` with options and *Open on* | `settings.ts`, `views.ts`, `spec.ts`, `validate.ts` |
| Customise Report… | The command gathers the report as shown (its definition's options with their values, *Show the top* with its default, *Open on* when it has a chart); the dialog draws them; applying shows the report so, through the catalog's `shown`, as any command shows one | `commands.ts`, `CustomiseDialog.tsx` |
| Saving | Save Report As… (the report as shown: its basis, parameters, chart or table, rows folded, then shown), Save Report (over the revision shown), Rename…, Duplicate… (then shown), Delete… (asked first); in the view's toolbar and *⋯* menu, the Reports menu, and the Reports tab's context menu with F2 and Delete; nothing that writes on a ledger open read-only | `commands.ts`, `saving.ts`, `ipc.ts`, `SaveDialog.tsx`, `ReportView.tsx`, `ReportList.tsx` |
| `reports.changed` | Whether the saved report shown differs from what was saved, each time the view says what it shows: compared as opened (its parameters and options resolved, its chart or table, its rows folded), so one opened and left alone is the same | `viewState.ts`, `viewSupport.ts` |
| The choices made last | Per definition and ledger (50 ledgers): parameters, options, chart or table, rows folded; used when it opens, less what no longer fits; *Accounts* carried from the last report over them; not from an archive file | `viewState.ts`, `viewSupport.ts` |
| The Reports page | *Open reports on* and *Rows before "Other"*, with their words and ranges; a new top runs the report shown again | `settings.ts`, `index.ts` |
| Spending by Payee | Version 2: its top the user's (`top: 'user'`), its *Show* option gone | `definitions/spendingByPayee.ts` |
| The view | Options, *Open on* and rows folded are state from the report opened (saved, or as last left), reported with each selection; *Customise…*, *Save As…* and the *⋯* menu; commands wait for the last selection to arrive, so they act on what is shown | `ReportView.tsx` |

**How it differs from the design, and why.**

| Designed | Built | Why |
|---|---|---|
| *Show the top* beside a report's own options, and Spending by Payee's *Show* (top 5 to every payee), and the page's *Rows before "Other"* "where a definition's axis takes `top` from the user" | One number: an axis's `top: 'user'` takes the report's *Show the top*, else the page's; Spending by Payee's own *Show* option is gone (version 2; a report saved with it falls back, with the note R2 built for that) | Three controls for one number; and nothing said how a definition takes its top from the user |
| General customisations saved somewhere of their own | In the option values, under `'@top'` | Saved reports, runs and the dialog carry them with no new fields; no definition's option can clash |
| A spec of its own customised like a definition | It has no options to keep *Show the top* in, so Save writes it into the spec | The designer's path, with no UI yet |
| `reports.changed` for the menu only | Also the catalog's `changed` | The view's *⋯* menu greys *Save Report* by it, and the catalog is what the view follows |
| `saved.save` with `id` and `expectedRev` (Save Report through the channel too) | Save Report is a command; the channel is Save Report As…'s | Save Report needs no dialog; the command holds the revision the report was shown at |
| *Open on* remembered per report "as the user left it" in the view (R3: in memory while the app ran) | Reported with each selection, remembered in `context.state` with the rest of the last choices, or saved with the report | One place for what a report shows, across restarts |

**Found while building.**

- **Save Report would have overwritten a change made elsewhere.** The first version read the saved report's revision
  at the moment of saving, which is always current. It now keeps the revision the report was at when shown (moved on
  by this window's own saves and renames), and Save is refused, saying so, if another change came between. The test
  first written for it faked the change on the public service, which the command doesn't use, and passed; written
  again, with the change made for real after showing the report, it failed until the fix.
- **Rename… with no argument acted on nothing just after Duplicate…,** which shows the copy before its view has said
  what it shows. Commands with no argument now act on the report shown, not on the view's last word.
- **Remembered *Accounts* could name a sub-ledger since deleted,** which the shape check doesn't see. What is
  remembered is checked against the ledger's tree and accounts when the report opens.
- **Menus and tooltips update after the event that opens them** (MUI's transitions), so two of the Reports tab's tests
  first failed the suite's check for updates outside `act`; they now wait for what the user sees.

**Not verified.**

- **`npm run dev`**: saving, reopening and customising seen in the window, and the Reports page in the Options dialog.
- **Windows and macOS.**


---

## Phase R5: Budget vs Actual, from the budget plugin (S)

**Goal:** the first report contributed by another plugin, and the guide's *Adding a report*.

### Files

| File | What |
|---|---|
| `plugins/budget/src/privileged/reportSource.ts` | The `budget.status` source over `budget.service` (`status` with `byMonth`, `rowTransactions` for drilling) |
| `plugins/budget/src/privileged/report.ts` | The Budgets group and the Budget vs Actual definition |
| `plugins/budget/manifest.json` | Provides `budget.reportSource` |
| `plugins/budget/src/privileged/commands.ts`, `renderer/BudgetView.tsx` | *Show as Report* in the budget view's *⋯* menu, through `reports.show` when the command exists |
| `docs/plugin-creation.md` | **Adding a report**: a definition on an existing source, and a source of one's own, with the budget's as the example |

### Tests

- `tests/plugins/budget/report.test.ts`: **the report's figures equal `status`'s**, row for row and month by month,
  for a month, the year to date and the year; drilling lists the Transactions dialog's transactions; the definition
  is offered only while a budget exists.
- `tests/plugins/reports/pipeline.test.ts` (added to): the budget and reports plugins built together; with either
  disabled, the other works, and Budget vs Actual is simply absent.

**Done when:** the [Definition of done](#definition-of-done) holds, and Budget vs Actual for the sample household's
budget has been seen in `npm run dev`.

### Phase R5 results

Recorded 2026-11-17. **Built: the first report another plugin adds.** The budget plugin contributes a source over its
status, the Budgets group and *Budget vs Actual* through the reports plugin's points, and the report's figures are the
status's, row for row and month by month: the budget view's own example comes out figure for figure. Either plugin
works with the other turned off, built and loaded as the app loads them. Seen in headless Chromium, in light and dark;
not yet in `npm run dev`. **3,563 tests in 252 files**, 22 of them new, in 1 new file
(`tests/plugins/budget/report.test.ts`) and cases added to R2's to R4's and the budget's tests; the browser tests ran,
in headless Chromium. The whole suite passed at the machine's usual speed (344 s); in an earlier run, made while the
contract's version was being raised, two of the account dialog's slow tests timed out, the known flake
([todo.md](todo.md), *Slow dialog tests*), and passed when run again; none of R5's. `npx tsc --noEmit -p plugins` has
no errors; `-p tests` has the 28 it had before (none in R5's files).

**What was built.**

| Part | What | Where |
|---|---|---|
| The source | `budget.status` over `budget.service.status`: one row for each status row that isn't a subtotal (a line, a parent's own line, *Other*, *Other transfers*, *Uncategorised*), placed in the status's own tree, by month when asked; the budgets for the *Budget* parameter, the one the budget view shows as the default; the budget's name, scope and currency for the subtitle; its changes followed | `plugins/budget/src/privileged/reportSource.ts` |
| Show Transactions | The budget's own Transactions dialog's list (`rowsTransactions`, `rowTransactions` generalised to several rows, each with a sign): for a line, a subtotal's branch, a parent's own line, *Other*, a group's total, the net | `reportSource.ts`, `viewSupport.ts` |
| The report | The Budgets group; *Budget vs Actual*: the budget view's rows with Budget, Actual, Remaining and % used, income and expenses totalled, the net ahead or behind; Budget beside Actual for the expense lines; *Layout* (the period, or month by month: the budget, the actual or what remains) and *Expense lines only*; offered while a budget exists | `report.ts` |
| Show as Report | `budget.showReport` in the budget view's *⋯* menu: the budget shown over the months shown, through `reports.show`, when the reports plugin is there (`BudgetsView.reports`) | `commands.ts`, `BudgetView.tsx` |
| The contract | `@tessera/budget-api` **1.5.0**: `BUDGET_REPORTS`, `budget.showReport`, `BudgetsView.reports`. `@tessera/reports-api` **1.3.0**: `show: 'percentOf'` with `of`; a net's `negate`; `EnumValue.negativeIsBad`; `MeasureField.drillDown`; a chart of measures side by side (`measures`, `under`); `SourceResult.subject` and `currency` | `packages/budget-api`, `packages/reports-api` |
| The run | A source of whole months gets the months a period touches, and the report says so; a source's subject and currency in the subtitle; the measures a per cent is of asked for too | `plugins/reports/src/privileged/run.ts` |
| The guide | *Adding a report*: a definition on an existing source (tested as written), and a source of one's own, the budget's; *Using reports from another plugin* | `docs/plugin-creation.md` |

**How it differs from the design, and why.**

| Designed | Built | Why |
|---|---|---|
| *Remaining* and *% used* `combine: 'none'`, the source giving them | *Remaining* adds up (`sum`) like Budget and Actual; *% used* is the spec's (`percentOf`, actual of budget, in each cell); the net reads Remaining the other way (`negate`) | `none` took the source's figure only in total columns, so subtotals and months would have been wrong or missing; a per cent of sums is exact at every level, with nothing for the source to total |
| Red "where the report says" (a measure's `negativeIsBad`) | A signed tree's top member says it (`EnumValue.negativeIsBad`): red under Expenses, not under Income | A budget's Remaining below zero is over budget for an expense and good news for income: the row decides, not the measure |
| Every figure of a source that lists transactions could be listed | A measure with nothing behind it says so (`drillDown: false`): only Actual is listed | A plan has no transactions |
| (Not in the design) | A chart of measures side by side, for the rows under a top member | "Budget against actual, for the expense lines" had no way to be said |
| The subtitle names the accounts and currency | A source with its own says what (`subject`) and which (`currency`): "March 2027 · Household · Personal · CAD" | The report has no scope or currency of its own to name |
| Presets *This month*, *Year to date*, *This budget year* | The reports' presets, on the ledger's year start; a period that cuts a month is widened to whole months, with a note | The same presets as every report; a budget's year start is the ledger's unless changed (R1) |
| `tests/plugins/budget/report.test.ts` alone | Also a case in `tests/plugins/reports/pipeline.test.ts` (built, either plugin off), and the report in `tests/browser/reportView.test.ts` | As the plan's tests list asks, and to see it drawn |

**Found while building.**

- **The budget view's example lists Salary first; the budget view doesn't.** Its status sorts categories by name, so
  Interest comes before Salary, and the report, following the status, does too. The drawing in
  [budget-design.md](budget-design.md#the-budget-view) is illustration; the figures are exact.
- **A layout can show fewer measures than a net reads the other way** (month by month shows one): the check on
  `negate` first refused the definition, with one warning, until it asked only for measures the source has.
- **A budget with nothing in the period had no currency in its subtitle,** taken from its rows, which it had none of;
  the source says its currency itself.

**Not verified.**

- **`npm run dev`**: Budget vs Actual for the sample household's budget, and *Show as Report*, in the window.
- **Windows and macOS.**


---

## Phase R6: printing, PDF and CSV (M)

**Goal:** reports on paper and in spreadsheets.

### Files

| File | What |
|---|---|
| `tessera-types/`, `shell/main/print/` | `shell.print` (`ShellPrint`: `print`, `savePdf`), provided before any plugin activates; the print stylesheet |
| `shell/main/dialogs/electronFiles.ts`, `tessera-types/dialogs.ts` | An atomic `writeFile` in `shell.files` |
| `plugins/reports/src/privileged/csv.ts` | The result to CSV (pure), with `@tessera/export-api`'s helpers |
| `plugins/reports/src/renderer/PrintLayout.tsx` | The report as printed |
| `docs/plugin-creation.md` | `shell.print` and `writeFile` in *Asking the user: dialogs, prompts and files* |

### Tests

- `tests/main/print.test.ts`: the service against a fake `webContents`; a cancelled print; the PDF written atomically.
- `tests/plugins/reports/csv.test.ts`: exact decimals in CAD, JPY and a three-digit currency; shares; paths as labels;
  formula protection; a CSV of every shipped report read back by Tessera's own CSV reader where it applies.
- `tests/plugins/reports/renderer/printLayout.test.tsx`: everything on screen is in the print layout, the table whole.

**Done when:** the [Definition of done](#definition-of-done) holds, and each report has been printed and saved as PDF
on Windows.

### Phase R6 results

Recorded 2026-11-17. **Built: reports on paper, in PDFs and in spreadsheets; printed to PDF in headless Chromium, not
yet through Electron.** *Print Report…* (`Ctrl+P`), *Save Report as PDF…* and *Export Report…* print, save and export
the report shown as it is shown, for every report, Budget vs Actual included, with nothing from the plugin that adds
one. A report printed from a dark window prints in light colours, every row, its table's heading on each page, the
pages numbered. **3,619 tests in 258 files**, 56 of them new, in 6 new files (`tests/main/print.test.ts`,
`writeFile.test.ts`, `tests/plugins/reports/csv.test.ts`, `output.test.ts`, `renderer/printLayout.test.tsx`,
`tests/browser/print.test.ts`) and cases added to R2's to R5's tests, the shell's theme and the contract's; the
browser tests ran, in headless Chromium. Every R6 test passed in every run. None of R6's five full runs was wholly
green: in each, one of the slow dialog and view tests outside R6 passed Vitest's 15 seconds (the Fonts page twice, the
account dialog, the Budget Line dialog, the budget view), taking the next test in its file with it, the known flake
([todo.md](todo.md), *Slow dialog tests*); each passed alone. `npx tsc --noEmit -p plugins` has no errors; `-p tests`
has the 28 it had before (none in R6's files).

**What was built.**

| Part | What | Where |
|---|---|---|
| The shell's printing | `shell.print`: `print` (the system's print dialog, true once printed, false if cancelled), `savePdf` (written whole, on the region's paper), `paperSize`; provided before any plugin activates | `tessera-types/print.ts`, `shell/main/print/electronPrint.ts`, `shell/main/dialogs/registerDialogs.ts`, `shell/main/app.ts` |
| Files written whole | `shell.files.writeFile`: `<file>.partial`, renamed over the file, retried 10 s while held; the `.partial` removed on failure; errors in words for the user | `shell/main/dialogs/writeFile.ts`, `electronFiles.ts`, `tessera-types/dialogs.ts` |
| The print stylesheet | A print area prints alone, in the page's flow; without one, the main area's view, un-scrolled, without the bars, in black ink; pages numbered in their margin; table headings repeated; rows whole | `shell/renderer/print/printStyles.tsx`, `shell/renderer/main.tsx` |
| The print area | `PrintArea` and `PRINT_WIDTHS` in `@tessera/ui` **1.7.0**: off screen at a page's width, in the print theme (the window theme's light variant, which the shell makes the first time something prints), the document's title while there; the icons `Print`, `PictureAsPdf` and `FileDownload` | `tessera-ui/PrintArea.tsx`, `shell/renderer/theme/ShellThemeProvider.tsx`, `tessera-types/icons.ts` |
| The print layout | Title, subtitle, what it is compared with, the chart at the page's width, the whole table as shown (folded rows stay folded), notes, the ledger and when printed; portrait or landscape by the table's width; wider than landscape, scaled to fit down to 70 %, else in blocks of columns (`pageFor`); ready once the chart is drawn | `plugins/reports/src/renderer/PrintLayout.tsx` |
| The view | Draws the print layout when asked, once its figures are worked out, says when it is ready or why it can't be, and keeps what it drew until printed; *Printing the report…* while it waits; the three in its *⋯* menu | `plugins/reports/src/renderer/ReportView.tsx` |
| The commands | Print Report…, Save Report as PDF… and Export Report… in the Reports menu (`Ctrl+P` on Print), enabled while the report view is in front; the request to the view and its answer; a minute's wait; the name suggested, "<report> <period>", in the folder used last | `plugins/reports/src/privileged/output.ts`, `contributions.ts` |
| The CSV | The table as shown: paths as labels, exact decimals, shares as decimals, a *Currency* column where each row has its own, formulas protected, UTF-8 with its mark; the rows shown worked out as the view does (`shared/rows.ts`) | `plugins/reports/src/privileged/csv.ts`, `plugins/reports/src/shared/rows.ts` |
| The contract | `@tessera/reports-api` **1.4.0**: `exportCsv`, `print`, `savePdf`; `reports:print.requested` (`PrintRequest`) and `reports:print.ready` (`PrintReady`). `@tessera/types`: `shell.print` (`ShellPrint`, `PaperSize`, `PrintOptions`, `PdfOptions`), `ShellFiles.writeFile`, `MAIN_ACTIVE_VIEW_KEY` | `packages/reports-api/views.ts`, `tessera-types/` |
| The guide | *Printing and writing files* under *Asking the user*; printing in *Using reports from another plugin* | `docs/plugin-creation.md` |

**How it differs from the design, and why.**

| Designed | Built | Why |
|---|---|---|
| The print stylesheet prints the main area's shown view, un-scrolled | **A view's print area prints alone;** the main area, un-scrolled, is the fallback for a view without one | What a view shows isn't what it should print: the report view draws 500 rows at a time, folds, and has a toolbar and a heading of fields. And un-scrolling the main area depends on every container the layout puts round it; a print area outside the layout prints the same whatever the layout |
| "In the light theme's colours" | The print area draws in the **light variant of the window's theme**, which the shell makes beside the window's; the fallback prints black ink | A stylesheet can't change the colours MUI has worked out; a theme for the area can. The fallback can't re-theme a view it knows nothing of, and a dark theme's grey printed faint on white |
| *Save as PDF* asks landscape or portrait; printing leaves it to the dialog | **The table's width chooses**, for both; a table wider than a landscape page is scaled to fit, down to 70 %, and past that printed in blocks of columns; the print dialog can still change the orientation | The report can measure what a question would ask the user to guess, every time; and nothing is cut off, or printed too small to read |
| `print({ windowId, title })` | The title is the print area's: the document's title while it is there | Electron's print takes no title: the job's name, and the PDF's title, are the document's |
| (Not in the design) | **Pages numbered**, "Page 2 of 5", by the stylesheet (CSS page-margin boxes, Chromium 131 and later) | An eight-page report needs them, on paper and in a PDF alike, with no header templates of Electron's |
| (Not in the design) | `paperSize()`: Letter where the region uses it, else A4 | `printToPDF` writes Letter everywhere unless told |
| The three commands enabled on `reports.shown` | And **the report view in front** (`MAIN_ACTIVE_VIEW_KEY`, made public in `@tessera/types`) | `Ctrl+P` is a menu accelerator, which works in any view: in the register it would print a report behind it |
| The view prints what it shows | **What it drew is kept until printed** | A refresh while the print dialog is open would have taken the print area away mid-print |
| The CSV built from the view's result | The plugin runs the report shown again and writes it | The view said what it shows (parameters, options, rows folded); the CSV needs nothing else of it, and the command needs no round trip to the view |
| `tests/main/print.test.ts`, `csv.test.ts`, `renderer/printLayout.test.tsx` | Also `tests/main/writeFile.test.ts`, `tests/plugins/reports/output.test.ts`, `tests/browser/print.test.ts`, a case in `pipeline.test.ts` (built, through the shell's own services) and Budget vs Actual's CSV in `tests/plugins/budget/report.test.ts` | What prints can only be seen in a browser; the commands' flow and the files, only with the plugin running |

**Measured** (headless Chromium 141, Letter, about 1 cm margins, as Electron's `printToPDF`):

| Report | Printed |
|---|---|
| Income vs Expenses, a quarter, chart and table | 1 page, portrait; the chart 680 px across, the table beneath it at the same width |
| 300 payees | 8 pages, the heading on each, "Page 1 of 8" to "Page 8 of 8" (R0: 7 A4 pages) |
| Income vs Expenses over 24 months and a total (25 figure columns, amounts in the millions) | Landscape, in 5 blocks of 5 columns, each at its own size with the rows' labels: 3 pages (scaled to fit it would have printed at 30 %) |
| Spending by Category, donut and table, from a dark window | 1 page, in the light theme's colours; the donut and its legend across the page's 680 px |

**Found while building.**

- **The layout was measured before it was in the document.** A print area draws what is in it only once it is
  attached, so the layout's measuring ran on nothing, and a 25-column report chose portrait. The browser test found
  it; the measuring moved inside the area. (jsdom, which lays nothing out, couldn't have.)
- **Row labels printed bold**, as a table's `th` is by default: seen in the first PDF, and set to the text's weight.
- **A dark window's view, printed without a print area, came out faint grey**: hence the fallback's black ink.
- **An empty report waited ten seconds** for a chart it never draws, before printing its "Nothing to show".
- **The chart's first `svg` is a legend mark**, 13 px across: readiness waits for the widest drawing.
- **Scaled to fit, a two-year report printed at 30 % of its size**, a 4 px font: no figure cut off, none readable.
  Past 70 %, the columns now print in blocks, as a spreadsheet prints a wide sheet; evened out, since the first try
  left the *Total* column alone in a block of its own.

**Not verified.**

- **Electron itself:** its print dialog, `printToPDF` and Chromium 142 (the tests print with Chromium 141's
  `page.pdf`, the engine behind both); whether Windows' print dialog starts in the orientation asked for; the
  window's title, which Electron takes from the page's, while a report prints.
- **`npm run dev`**, and printing each report on Windows, as the phase's *Done when* asks.
- **A CSV opened in Excel** (read back here by Tessera's own CSV reader, for every shipped report).
- **Two windows.** The request to print goes to every window's report view, and the first to answer is printed, as
  the report shown is one for the app (R3). Tessera opens one window today; a second would want the request addressed
  to the window the command came from.

---

## Later

Each scheduled on its own, when wanted.

| Item | Notes |
|---|---|
| **The report designer** | Its own design note. Phases in outline: a spike on the designer's UI (drag to rows and columns, or pickers); *Edit a Copy…* and the designer view over the existing `spec` saved reports; calculated figures through a parsed grammar; list reports; two sources in one report; sharing `.tesserareport` files. See [Designing for the report designer](#designing-for-the-report-designer) |
| **Reports on the home view** | A saved report (or a shipped one) as a widget, once the home view takes widgets; `reports.service.run` is what a widget needs |
| **Contributed renderers** | A report body drawn by its plugin's own module, through the same "embedded modules" the home view's widgets will need from the shell |
| **The budget reads archived totals from `accounts`** | Then `budget.archivedMonths` can go, with a migration; and `scopeOf` and `countedTotals` become thin uses of `accountScope` and `crossesScope` |
| **Reports across archive files** | Drill-down into archived detail by opening the archive the ledger's record lists ([ledger-compaction-design.md](ledger-compaction-design.md#phase-6-later-each-scheduled-separately)) |
| **Days and weeks** as columns | Needs totals by day from `accounts` (a `byDay` grain) |
| **Several currencies in one figure** | With exchange rates, a feature of its own |
| **Investment reports** | When Tessera has investment transactions |
| **Tax reports** | Categories marked as tax-related, and a list report |
| **Forecasts** | Cash flow and balances ahead, from budgets' due dates and, later, scheduled transactions |
| **Copy as table** | The table to the clipboard, tab-separated, for pasting into a spreadsheet |
| **A year start per sub-ledger** | For a business whose fiscal year isn't the household's: on the sub-ledger, defaulting to the ledger's |
| **Money between sub-ledgers** | A definition on `otherSubLedger`: an owner's draws and contributions, and loans between a household and its business, month by month |
| **More of MUI X** | `@tessera/ui/pickers` and `@tessera/ui/grid`, when a view needs them (the designer, perhaps) |

---

## Testing

| Kind | Where | What it proves |
|---|---|---|
| Periods and the engine | `tests/packages/reportsApi.test.ts` | Dates on every day, every year start, in an awkward time zone; every shaping rule; integers only |
| What counts | `tests/plugins/reports/flows.test.ts`, `balances.test.ts` | The rules, defined once, agree with the registers, the navigator and the budget |
| **Every transaction once** | `flows.test.ts` | Each counted transaction in exactly one row, and rows add to totals |
| **Identities across sources** | `definitions.test.ts` | Cash Flow's opening + net + opened = closing; payee and category totals agree; net worth equals the chart's totals |
| **Sub-ledgers** | `subLedgers.test.ts` | Money between sub-ledgers is never income or an expense; side-by-side columns equal each sub-ledger's own report and add up to the whole |
| Year start | `tests/packages/reportsApi.test.ts`, `tests/plugins/ledger/yearStart.test.ts` | Presets and columns on any year start; one year start, the ledger's, for reports, archiving and budgets |
| **Archive invariant** | `tests/plugins/accounts/archive.test.ts`, `tests/plugins/reports/archive.test.ts` | No figure of any period changes through an archive |
| Extensibility | `registry.test.ts`, `tests/plugins/budget/report.test.ts`, `pipeline.test.ts`, `forOthers.test.ts` | Contributions in any order; bad ones refused alone; another plugin's report works (Budget vs Actual, its figures the budget's row for row), and nothing breaks without it; the guide's examples as written |
| Speed | `tests/plugins/accounts/totalsScale.test.ts`, `tests/plugins/reports/scale.test.ts` | R0's targets at 100,000 transactions |
| **Every figure's transactions** | `tests/plugins/reports/drill.test.ts` | For every figure that can be listed in the five flows reports over the household's year, the transactions listed and what archives hold add up to exactly the figure (R3) |
| The UI's privileged side | `tests/plugins/reports/views.test.ts`, `menu.test.ts`, `refresh.test.ts` | The catalog and when it is sent; commands and context keys; the channels; *Accounts* carried; the menu mirrored from definitions in any order, `when`, withdrawal; one stale event for a burst (R3) |
| Views and dialogs | `tests/plugins/reports/renderer/` (jsdom) | Parameters, tables, chart models, tokens, keys, states, late replies, read-only (R3); every option of every definition in *Customise Report…*, names in the save dialog, the *⋯* menu and the tab's context menu (R4) |
| Customising and saving | `tests/plugins/reports/saving.test.ts`, `settings.test.ts`, `saved.test.ts` | Saving as shown, a conflict refused, `reports.changed`, read-only, the last choices and what no longer fits; the Reports page and *Show the top* (R4) |
| **In a real browser** | `tests/browser/` (headless Chromium; skipped, saying why, without one) | Charts' colours and fonts from the theme; the view's chart and table in both modes; 5,000 rows painted in chunks; sideways scrolling; hidden views not running (R3); printing: only the print area, light colours from a dark window, every row on numbered pages, a wide report landscape and scaled to fit, the fallback without the bars (R6) |
| Printing and exporting | `tests/main/print.test.ts`, `writeFile.test.ts`, `tests/plugins/reports/output.test.ts`, `csv.test.ts`, `renderer/printLayout.test.tsx` | `shell.print` and files written whole; the commands' request and answer, cancelled, failed and unanswered; the CSV exact, as shown, read back for every shipped report (R6) |
| Boundaries | `tests/architecture/boundaries.test.ts` | `reports-api` platform-free; no floating point in figures; no shipped definition named in the manager |
| By hand | each phase from R3 | The sample household in `npm run dev`, light and dark, before and after its archive, and its archive file |

## Documentation changes

| When | Change |
|---|---|
| Review (done) | This note, with the review's answers applied |
| At merge of this note (done, with R1) | [todo.md](todo.md): a *Reports* group with R0 to R6; the budget's *Planning* menu item answered (Q1); *The year start per ledger* taken by R1; the `@tessera/ui` policy ([Reports and `@tessera/ui`](#reports-and-tesseraui)). [README.md](../README.md): this note under *Documentation*. [settings-design.md](settings-design.md): its first candidate for a per-ledger setting, the year start, is now a ledger property |
| R0 (done) | Results here, and the design amended where they differ ([What changes in this note](#what-changes-in-this-note)) |
| R1 (done) | [account-manager-design.md](account-manager-design.md): the additions to `accounts.service`, and the year start in *The ledger*. [ledger-compaction-design.md](ledger-compaction-design.md): `accounts.archivedMonths`; the Archiving page without its year start. [budget-design.md](budget-design.md): New Budget's suggested year start. [plugin-creation.md](plugin-creation.md): *Using accounts from another plugin*; the year start in *Storing data in the ledger*. README: *Ledger Properties…* |
| R2 (done) | README: `reports-api` and the `reports` plugin in *Project layout*. [todo.md](todo.md): R2 ticked; Cash Flow's speed listed. [account-manager-design.md](account-manager-design.md): `removedAccounts` |
| R3 (done) | README: *Reports* in *What works today*, `@tessera/ui` 1.6, the browser tests; [theming-design.md](theming-design.md): the chart palette and `@tessera/ui/charts`; plugin-creation: charts in *Styling and theming*; [todo.md](todo.md): R3 ticked, `npm run dev` still to check |
| R4 (done) | README: saving and customising in *What works today*, the Reports page; plugin-creation: the Reports page's settings, to read; [todo.md](todo.md): R4 ticked, `npm run dev` still to check |
| R5 (done) | plugin-creation: **Adding a report**; [budget-design.md](budget-design.md): Budget vs Actual in *Later* moved to done; README: Budget vs Actual; [todo.md](todo.md): R5 ticked |
| R6 (done) | plugin-creation: `shell.print`, `writeFile` and `PrintArea` (*Printing and writing files*), printing in *Using reports from another plugin*; README: printing, PDF and CSV, and `shell.print`; [todo.md](todo.md): R6 ticked, printing on Windows still to check, *Printing from any view* added, atomic writes done |

## Definition of done

For every phase:
- [ ] `npm test` green, including the architecture boundaries
- [ ] No new errors from `npx tsc --noEmit -p plugins` (and `-p tests` when tests are touched)
- [ ] Every disposable pushed onto `context.subscriptions`
- [ ] The invariants hold: every counted transaction in one row; the identities across sources; no figure changed by
      an archive
- [ ] Checked by hand in `npm run dev`, in light and dark themes, including from an archive file opened read-only
      (from R3)
- [ ] The phase's results recorded here, and `todo.md` ticked

## Phases

| Phase | Delivers | Size |
|---|---|---|
| R0 | Spike: totals by payee, balance history and archived payees at 100,000 transactions; the chart library; printing; the engine at its limits. **Done** ([results](#phase-r0-results)); question 4 (MUI X Charts) answered in R3: it fits | S |
| R1 | `accounts.service`: totals by payee, `payees.get`, `balanceHistory`, archived totals (with payees) kept and `archivedTotals`; the shared scope rule (`@tessera/accounts-api` 1.15). The ledger's year start and *File › Ledger Properties…*, used by archiving and New Budget. **Built** ([results](#phase-r1-results)); its renderer and pipeline tests pass (run in R3); `npm run dev` still to run | M |
| R2 | `@tessera/reports-api` (specs, periods, the engine); the `reports` plugin's domain: the flows and balances sources, seven definitions, sub-ledgers side by side, `reports.service`, saved reports; no UI. **Built** ([results](#phase-r2-results)); its pipeline test passes (run in R3) | L |
| R3 | Charts in `@tessera/ui` 1.6 (MUI X Charts, as `@tessera/ui/charts`); the Reports tab, the report view, Show Transactions, the Reports menu; read-only; kept current. **Built** ([results](#phase-r3-results)), tested in jsdom and in headless Chromium; `npm run dev` still to run | L |
| R4 | Customise Report…, saved reports (Save, Save As, Rename, Duplicate, Delete), the Reports page, remembered choices. **Built** ([results](#phase-r4-results)); `npm run dev` still to run | M |
| R5 | Budget vs Actual, contributed by the budget plugin; the guide's *Adding a report*. **Built** ([results](#phase-r5-results)); `npm run dev` still to run | S |
| R6 | `shell.print` and atomic writes; Print, Save as PDF, Export to CSV. **Built** ([results](#phase-r6-results)), printed to PDF in headless Chromium; Electron and Windows still to check | M |
| Later | The report designer (its own note), home view widgets, contributed renderers, the budget on `accounts`' archived totals, and more ([Later](#later)) | — |
