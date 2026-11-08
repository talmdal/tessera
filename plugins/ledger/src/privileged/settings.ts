// The ledger's settings: what happens at start-up, and how many recent ledgers are listed. Kept by the shell's
// settings framework (namespace `ledger`), edited on a page the shell draws from the fields below.
import { SETTINGS_PAGES_EXTENSION_POINT } from '@tessera/types'
import type { SettingsDefinition, SettingsPageContribution } from '@tessera/types'
import { LEDGER_SETTINGS_PAGE } from '@tessera/ledger-api'

export interface LedgerSettings {
  /** Reopen the ledger that was open when Tessera last quit. Off: start at the start view. */
  reopenLast: boolean
  /** How many recent ledgers are remembered, and listed on the start view. */
  recentLimit: number
}

export const RECENT_LIMIT_MAX = 30

export const LEDGER_SETTINGS: SettingsDefinition<LedgerSettings> = {
  defaults: { reopenLast: true, recentLimit: 10 },
  validate: ({ recentLimit }) =>
    Number.isInteger(recentLimit) && recentLimit >= 1 && recentLimit <= RECENT_LIMIT_MAX
      ? []
      : [`List from 1 to ${RECENT_LIMIT_MAX} recent ledgers.`]
}

export const SETTINGS_PAGE: SettingsPageContribution = {
  id: LEDGER_SETTINGS_PAGE,
  title: 'Ledger',
  description: 'What Tessera opens when it starts, and the ledgers it remembers.',
  keywords: ['start-up', 'startup', 'open', 'recent', 'history'],
  fields: [
    {
      kind: 'boolean', key: 'reopenLast', label: 'Reopen the last ledger when Tessera starts',
      description: 'When this is off, Tessera starts at the start page.'
    },
    { kind: 'number', key: 'recentLimit', label: 'Recent ledgers to list', min: 1, max: RECENT_LIMIT_MAX, integer: true }
  ]
}

/** The page, as a `[point, id, impl]` contribution like the ledger's others. */
export const settingsContribution = (): [string, string, unknown] => [SETTINGS_PAGES_EXTENSION_POINT, SETTINGS_PAGE.id, SETTINGS_PAGE]
