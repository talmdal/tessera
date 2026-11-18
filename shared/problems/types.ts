// shared/problems/types.ts — the wire contract for the Problems display: what the framework and its plugins
// reported as warnings and errors, shown to the user rather than left in the terminal.
import { channelFor } from '@tessera/types'
import { SHELL_CONTRIBUTOR_ID } from '../plugins/manifest'

const shell = (event: string) => channelFor(SHELL_CONTRIBUTOR_ID, event)

/** Request, renderer → main: → `ProblemEntry[]`, oldest first. */
export const PROBLEMS_LIST = shell('problems.list')
/** Request, renderer → main: forget them all. */
export const PROBLEMS_CLEAR = shell('problems.clear')
/** Request, renderer → main: `ProblemReport`. Something went wrong in a window: an uncaught error, a rejection. */
export const PROBLEMS_REPORT = shell('problems.report')
/** Push event, main → renderer: `ProblemTotals`. The list changed; ask for it again if it is on screen. */
export const PROBLEMS_CHANGED = shell('problems.changed')

export const PROBLEMS_COMMANDS = {
  show: 'shell.problems.show',
  clear: 'shell.problems.clear'
} as const

/** Context keys: unset rather than zero when there are none, so a bare `when` on them is false. */
export const PROBLEMS_KEYS = {
  count: 'shell.problems.count',
  errors: 'shell.problems.errors'
} as const

export const PROBLEMS_DIALOG = 'shell.problems'
export const PROBLEMS_DIALOG_MODULE = './Problems'

export interface ProblemEntry {
  id: number
  time: string
  level: 'warning' | 'error'
  source: string
  message: string
  detail?: string
  count: number
}

export interface ProblemTotals {
  total: number
  errors: number
  warnings: number
}

export interface ProblemReport {
  level?: 'warning' | 'error'
  message: string
  detail?: string
}

/** The most a window may report in one message, so a runaway error loop cannot flood the log with megabytes. */
export const REPORT_LIMIT = 4_000
