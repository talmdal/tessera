// The Budget page (Tools › Options… › Budget): the user's preferences, application-wide, in the `budget` namespace, on
// a page the shell draws. What belongs to a budget (its scope, currency and year start) is in the ledger with it.
// See docs/budget-design.md, "The Budget page".
import { SETTINGS_PAGES_EXTENSION_POINT } from '@tessera/types'
import type { SettingsDefinition, SettingsPageContribution } from '@tessera/types'
import {
  BUDGET_SETTINGS_DEFAULTS, BUDGET_SETTINGS_PAGE, HISTORY_MONTHS_MIN, ROUND_TO_CHOICES, STATUS_MONTHS_MAX, WARN_AT_PERCENT_MIN,
  type BudgetSettings
} from '@tessera/budget-api'

const whole = (value: unknown, min: number, max: number) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max
const flag = (value: unknown) => typeof value === 'boolean'

/** The checkboxes' labels: on the page, and in what validation says. */
const LABELS = {
  showBars: 'Show a bar beside each line',
  showEmptyLines: 'Show lines with nothing in the period',
  statusBar: 'Show lines over budget in the status bar'
} as const

export const BUDGET_SETTINGS: SettingsDefinition<BudgetSettings> = {
  defaults: { ...BUDGET_SETTINGS_DEFAULTS },
  validate: s => [
    ...(whole(s.warnAtPercent, WARN_AT_PERCENT_MIN, 100) ? [] : [`Warn at a share from ${WARN_AT_PERCENT_MIN} to 100 %.`]),
    ...(whole(s.historyMonths, HISTORY_MONTHS_MIN, STATUS_MONTHS_MAX) ? [] : [`Look at ${HISTORY_MONTHS_MIN} to ${STATUS_MONTHS_MAX} months of history.`]),
    ...((ROUND_TO_CHOICES as readonly unknown[]).includes(s.roundTo) ? [] : [`Round to one of ${ROUND_TO_CHOICES.join(', ')}.`]),
    ...(['showBars', 'showEmptyLines', 'statusBar'] as const).flatMap(key => flag(s[key]) ? [] : [`Say whether to ${LABELS[key].toLowerCase()} with a tick.`])
  ]
}

export const SETTINGS_PAGE: SettingsPageContribution = {
  id: BUDGET_SETTINGS_PAGE,
  title: 'Budget',
  description: 'How budgets are shown, when a line warns that it is near its budget, and what Fill from History suggests.',
  keywords: ['budget', 'warn', 'warning', 'amber', 'over', 'bars', 'history', 'round', 'status bar', 'planning'],
  fields: [
    {
      kind: 'number', key: 'warnAtPercent', label: 'Warn at', min: WARN_AT_PERCENT_MIN, max: 100, integer: true, unit: '% of the budget',
      description: 'An expense line turns amber once its spending reaches this share of its budget, and red once it is over.'
    },
    { kind: 'boolean', key: 'showBars', label: LABELS.showBars, description: 'How much of each line’s budget has been spent, or has come in.' },
    {
      kind: 'boolean', key: 'showEmptyLines', label: LABELS.showEmptyLines,
      description: 'Lines with neither a budget nor a transaction in the month or year shown. Off, they are left out until they have one.'
    },
    {
      kind: 'boolean', key: 'statusBar', label: LABELS.statusBar,
      description: '“Budget: 2 lines over” while the budget shown has expense lines over their budget this month. Click it to see the budget.'
    },
    {
      kind: 'number', key: 'historyMonths', label: 'Fill from History looks at', min: HISTORY_MONTHS_MIN, max: STATUS_MONTHS_MAX, integer: true, unit: 'months',
      description: 'The whole months before the lines start that suggestions are averaged over.'
    },
    {
      kind: 'choice', key: 'roundTo', label: 'Fill from History rounds to',
      description: 'In whole units of the budget’s currency: 10 is 10.00 in dollars. Spending is rounded up and income down.',
      options: ROUND_TO_CHOICES.map(value => ({ value, label: String(value) }))
    }
  ]
}

export const settingsContribution = (): [string, string, unknown] => [SETTINGS_PAGES_EXTENSION_POINT, SETTINGS_PAGE.id, SETTINGS_PAGE]
