// The `accounts.reconcile.actions` extension point: reconciliation options other plugins add to the register (its
// Reconcile menu, and a row's menu). Contributions are plain data; each names a command, which does the work.
import type { CommandRegistry, ExtensionRegistry, Logger } from '@tessera/types'
import {
  ACCOUNT_TYPES, RECONCILE_ACTIONS_POINT,
  type AccountType, type ReconcileActionContribution, type ResolvedReconcileAction
} from '@tessera/accounts-api'

function problemWith(raw: unknown, contributor: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return `A reconcile action from "${contributor}" is not an object`
  const a = raw as Record<string, unknown>
  const text = (v: unknown) => typeof v === 'string' && v.trim() !== ''
  if (!text(a.id) || !(a.id as string).startsWith(`${contributor}.`)) return `A reconcile action from "${contributor}" needs an id starting with "${contributor}."`
  if (!text(a.label)) return `Reconcile action "${a.id}" needs a label`
  if (a.scope !== 'account' && a.scope !== 'transaction') return `Reconcile action "${a.id}" needs a scope of "account" or "transaction"`
  if (!text(a.command)) return `Reconcile action "${a.id}" needs a command`
  if (a.accountTypes !== undefined && (!Array.isArray(a.accountTypes) || a.accountTypes.some(t => !(ACCOUNT_TYPES as readonly unknown[]).includes(t)))) {
    return `Reconcile action "${a.id}" names an unknown account type`
  }
  if (a.order !== undefined && (typeof a.order !== 'number' || !Number.isFinite(a.order))) return `Reconcile action "${a.id}" has an invalid order`
  if (a.icon !== undefined && !text(a.icon)) return `Reconcile action "${a.id}" has an invalid icon`
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
    const valid: { action: ReconcileActionContribution, seq: number }[] = []
    const seen = new Set<string>()
    this.extensions.getContributions(RECONCILE_ACTIONS_POINT).forEach(({ contributor, impl }, seq) => {
      const problem = problemWith(impl, contributor) ?? (seen.has((impl as { id: string }).id) ? `Duplicate reconcile action "${(impl as { id: string }).id}" ignored` : undefined)
      if (problem) {
        if (!this.warned.has(problem)) { this.warned.add(problem); this.log.warn(`[accounts] ${problem}`) }
        return
      }
      const action = impl as ReconcileActionContribution
      seen.add(action.id)
      valid.push({ action, seq })
    })
    return valid.sort((a, b) => (a.action.order ?? 0) - (b.action.order ?? 0) || a.seq - b.seq).map(v => v.action)
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
