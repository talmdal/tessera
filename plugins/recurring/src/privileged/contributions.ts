// What the recurring plugin adds to the shell, as plain data: its items in the Accounts menu, the Recurring view,
// its dialogs, the overdue warning on the bottom bar, the row action in the register, and the navigator's row.
import { DIALOGS_EXTENSION_POINT, type BorderItemContribution, type DialogContribution } from '@tessera/types'
import { BOOK_CONTEXT_KEYS } from '@tessera/book-api'
import {
  ACCOUNTS_MENU, NAVIGATOR_ITEMS_POINT, REGISTER_FIGURES_POINT, TRANSACTION_ACTIONS_POINT,
  type NavigatorItemContribution, type RegisterFigureContribution, type TransactionActionContribution
} from '@tessera/accounts-api'
import {
  DEFAULT_HORIZON_DAYS, RECURRING_COMMANDS as C, RECURRING_CONTEXT_KEYS as K, RECURRING_DIALOGS, RECURRING_EVENTS,
  RECURRING_VIEWS
} from '@tessera/recurring-api'

const VIEW_MENU = 'shell.view'
const WRITABLE = `${BOOK_CONTEXT_KEYS.isOpen} && !${BOOK_CONTEXT_KEYS.isReadOnly}`

export const MENUS = [
  {
    kind: 'item', id: 'recurring.menu.manage', label: 'Recurring &Transactions',
    parent: ACCOUNTS_MENU.id, group: ACCOUNTS_MENU.groups.recurring, command: C.open
  },
  {
    kind: 'item', id: 'recurring.menu.new', label: 'New &Recurring Transaction…',
    parent: ACCOUNTS_MENU.id, group: ACCOUNTS_MENU.groups.recurring, command: C.new
  },
  {
    kind: 'item', id: 'recurring.menu.enterDue', label: 'Enter &Due Transactions…',
    parent: ACCOUNTS_MENU.id, group: ACCOUNTS_MENU.groups.recurring, command: C.enterDue
  },
  {
    kind: 'item', id: 'recurring.menu.holidays', label: '&Holidays…',
    parent: ACCOUNTS_MENU.id, group: ACCOUNTS_MENU.groups.recurring, command: C.holidays
  },
  { kind: 'item', id: 'recurring.view.list', label: '&Recurring', parent: VIEW_MENU, command: C.open }
] as const

export const VIEWS = [
  {
    id: RECURRING_VIEWS.list, title: 'Recurring', slot: 'shell.main', module: './RecurringView',
    icon: 'CalendarToday', order: -40, when: BOOK_CONTEXT_KEYS.isOpen
  },
  // What falls due over the next few weeks, beside whatever the main area shows
  {
    id: RECURRING_VIEWS.upcoming, title: 'Upcoming', slot: 'shell.right', module: './UpcomingPanel',
    icon: 'CalendarToday', order: -50, when: BOOK_CONTEXT_KEYS.isOpen
  }
] as const

export const DIALOGS: DialogContribution[] = [
  { id: RECURRING_DIALOGS.series, title: 'New Recurring Transaction', module: './SeriesDialog', size: 'md' },
  { id: RECURRING_DIALOGS.enter, title: 'Enter in Register', module: './EnterDialog', size: 'md' },
  { id: RECURRING_DIALOGS.holidays, title: 'Holidays', module: './HolidaysDialog', size: 'sm' }
]

/** The projected balance above a register, through `accounts.register.figures`. */
export const REGISTER_FIGURES: RegisterFigureContribution[] = [
  {
    id: 'recurring.projected',
    label: `Projected (${DEFAULT_HORIZON_DAYS} days)`,
    command: C.projectBalance,
    refreshOn: RECURRING_EVENTS.snapshot,
    description: `The balance after everything scheduled for the next ${DEFAULT_HORIZON_DAYS} days`
  }
]

/** The overdue warning on the bottom bar. A count of 0 is falsy, which is how `when` tests it. */
export const BAR_ITEMS: BorderItemContribution[] = [
  {
    kind: 'text', id: 'recurring.status.overdue', slot: 'shell.bottom', align: 'end',
    icon: 'Warning', text: `{${K.overdueSummary}}`, command: C.open,
    tooltip: 'Show the recurring transactions that are overdue',
    when: K.overdueCount
  }
]

/** "Make Recurring…" in a register row's context menu — the first consumer of `accounts.transaction.actions`. */
export const TRANSACTION_ACTIONS: TransactionActionContribution[] = [
  {
    id: 'recurring.fromTransaction',
    label: 'Make Recurring…',
    command: C.fromTransaction,
    icon: 'Repeat',
    singleOnly: true,
    description: 'Schedule this transaction to repeat'
  }
]

/** The Recurring row in the Accounts navigator, badged with the overdue count. */
export const NAVIGATOR_ITEMS: NavigatorItemContribution[] = [
  {
    id: 'recurring.navigator.list',
    label: 'Recurring',
    command: C.open,
    icon: 'Repeat',
    placement: 'bottom',
    badgeKey: K.overdueCount,
    badgeTone: 'error',
    description: 'Payments and deposits that repeat'
  }
]

/** Enablement shared by the commands that change something. */
export const WRITABLE_WHEN = WRITABLE

/** Every contribution, as `[point, id, impl]`. */
export function contributions(): [string, string, unknown][] {
  const as = (point: string) => (c: { id: string }): [string, string, unknown] => [point, c.id, c]
  return [
    ...MENUS.map(as('shell.menus')),
    ...VIEWS.map(as('shell.views')),
    ...DIALOGS.map(as(DIALOGS_EXTENSION_POINT)),
    ...BAR_ITEMS.map(as('shell.bar.items')),
    ...TRANSACTION_ACTIONS.map(as(TRANSACTION_ACTIONS_POINT)),
    ...REGISTER_FIGURES.map(as(REGISTER_FIGURES_POINT)),
    ...NAVIGATOR_ITEMS.map(as(NAVIGATOR_ITEMS_POINT))
  ]
}
