// The `accounts.reconcile.actions` extension point: reconciliation options other plugins add to the register (its
// Reconcile menu, and a row's menu). Contributions are plain data; each names a command, which does the work.
//
// A transaction-scope contribution still appears in a row's context menu, but `accounts.transaction.actions` is the
// point to use for anything that is not reconciliation; see ./rowActions.ts.
import type { CommandRegistry, ExtensionRegistry, Logger } from '@tessera/types'
import {
  RECONCILE_ACTIONS_POINT,
  type AccountType, type ReconcileActionContribution, type ResolvedReconcileAction
} from '@tessera/accounts-api'
import { checkCommonFields, collect } from './points'

function problemWith(raw: unknown, contributor: string): string | undefined {
  const common = checkCommonFields(raw, contributor, 'reconcile action')
  if (common) return common
  const a = raw as Record<string, unknown>
  if (a.scope !== 'account' && a.scope !== 'transaction') return `Reconcile action "${a.id}" needs a scope of "account" or "transaction"`
  return undefined
}

export class ReconcileActions {
  private readonly warned = new Set<string>()

  constructor(
    private readonly extensions: Pick<ExtensionRegistry, 'getContributions'>,
    private readonly commands: Pick<CommandRegistry, 'isEnabled' | 'has'>,
    private readonly log: Pick<Logger, 'warn'>
  ) {}

  /** Valid contributions, by order then as contributed. Invalid ones are skipped with one warning each. */
  all(): ReconcileActionContribution[] {
    return collect<ReconcileActionContribution>(
      this.extensions, RECONCILE_ACTIONS_POINT, problemWith, this.log, this.warned, 'reconcile action')
  }

  /** The actions for an account of this type, in this scope, each enabled exactly when its command is. */
  for(type: AccountType, scope: 'account' | 'transaction'): ResolvedReconcileAction[] {
    return this.all()
      .filter(action => action.scope === scope && (action.accountTypes === undefined || action.accountTypes.includes(type)))
      .map(({ id, label, scope, command, icon, description }) => ({
        id, label, scope, command, enabled: this.commands.has(command) && this.commands.isEnabled(command),
        ...(icon !== undefined && { icon }),
        ...(description !== undefined && { description })
      }))
  }
}
