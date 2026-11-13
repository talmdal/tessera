// The `accounts.transaction.actions` extension point: items other plugins add to a register row's context menu.
// Contributions are plain data; each names a command, run with `TransactionActionArgs`.
//
// Transaction-scope `accounts.reconcile.actions` contributions are resolved into the same list, after these, so
// nothing written against the older point breaks. New contributions should use this one.
import type { CommandRegistry, ExtensionRegistry, Logger } from '@tessera/types'
import {
  TRANSACTION_ACTIONS_POINT,
  type AccountType, type ResolvedTransactionAction, type TransactionActionContribution
} from '@tessera/accounts-api'
import type { ReconcileActions } from './reconcileActions'
import { checkCommonFields, collect } from './points'

function problemWith(raw: unknown, contributor: string): string | undefined {
  const common = checkCommonFields(raw, contributor, 'row action')
  if (common) return common
  const a = raw as Record<string, unknown>
  if (a.singleOnly !== undefined && typeof a.singleOnly !== 'boolean') return `Row action "${a.id}" has an invalid singleOnly`
  if (a.needsEditable !== undefined && typeof a.needsEditable !== 'boolean') return `Row action "${a.id}" has an invalid needsEditable`
  return undefined
}

/** What the register's selection looks like when the menu opens. */
export interface RowContext {
  type: AccountType
  /** The account is closed, so its transactions can't be changed. */
  closed: boolean
  /** How many rows are selected; at least 1 when a row menu is open. */
  count: number
}

export class TransactionActions {
  private readonly warned = new Set<string>()

  constructor(
    private readonly extensions: Pick<ExtensionRegistry, 'getContributions'>,
    private readonly commands: Pick<CommandRegistry, 'isEnabled' | 'has'>,
    private readonly log: Pick<Logger, 'warn'>,
    /** Transaction-scope reconcile actions, appended for compatibility. */
    private readonly reconcile: Pick<ReconcileActions, 'for'>
  ) {}

  /** Valid contributions, by order then as contributed. Invalid ones are skipped with one warning each. */
  all(): TransactionActionContribution[] {
    return collect<TransactionActionContribution>(
      this.extensions, TRANSACTION_ACTIONS_POINT, problemWith, this.log, this.warned, 'row action')
  }

  /** The items for this selection, each enabled exactly when its command is. */
  for({ type, closed, count }: RowContext): ResolvedTransactionAction[] {
    const own = this.all()
      .filter(action => action.accountTypes === undefined || action.accountTypes.includes(type))
      .filter(action => (action.needsEditable ?? true) ? !closed : true)
      .filter(action => action.singleOnly === true ? count === 1 : true)
      .map(({ id, label, command, icon, description }): ResolvedTransactionAction => ({
        id, label, command, enabled: this.commands.has(command) && this.commands.isEnabled(command),
        ...(icon !== undefined && { icon }),
        ...(description !== undefined && { description })
      }))

    // Deprecated: a reconciler's transaction-scope options, which the register has always shown here
    const inherited = closed ? [] : this.reconcile.for(type, 'transaction')
      .map(({ id, label, command, icon, description, enabled }): ResolvedTransactionAction => ({
        id, label, command, enabled, ...(icon !== undefined && { icon }), ...(description !== undefined && { description })
      }))

    const seen = new Set(own.map(a => a.id))
    return [...own, ...inherited.filter(a => !seen.has(a.id))]
  }
}
