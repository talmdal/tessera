// The Accounts menu's commands. Each takes an optional `{ id }` (a context menu acting on a row) and otherwise acts
// on the navigator's selection. Sub-ledger commands hand over to the ledger's, so its rules and confirmations apply.
import type { Disposable, PluginContext, ShellPrompts } from '@tessera/types'
import { LEDGER_COMMANDS, LEDGER_CONTEXT_KEYS } from '@tessera/ledger-api'
import {
  ACCOUNTS_COMMANDS, ACCOUNTS_CONTEXT_KEYS, ACCOUNTS_DIALOGS, ACCOUNTS_EVENTS, ACCOUNTS_VIEWS, accountNameKey, categoryLabel,
  formatAmount, isAccountsError, isLiability,
  STATEMENT_RECONCILER,
  type Account, type AccountDialogInput, type Chart, type ItemArgs, type MoveDialogInput, type NewAccountArgs,
  type Category, type ReconcileActionArgs, type ReconcileDialogInput, type StatementInput
} from '@tessera/accounts-api'
import type { AccountsServiceImpl } from './AccountsServiceImpl'
import type { RegisterState } from './register'
import { local, type SelectionState } from './selection'

const K = ACCOUNTS_CONTEXT_KEYS
const WRITABLE = `${LEDGER_CONTEXT_KEYS.isOpen} && !${LEDGER_CONTEXT_KEYS.isReadOnly}`
const ACCOUNT = `${WRITABLE} && ${K.selectionKind} == 'account'`
const SUB_LEDGER = `${WRITABLE} && ${K.selectionKind} == 'subLedger'`
const ACCOUNT_OR_REGISTER = `${LEDGER_CONTEXT_KEYS.isOpen} && ${K.selectionKind} == 'account'`

/** The currency most accounts in the ledger use; for a ledger with none, the locale's guess, else CAD. */
export function usualCurrency(chart: Chart, fallback = 'CAD'): string {
  const counts = new Map<string, number>()
  for (const { account } of chart.accounts) counts.set(account.currency, (counts.get(account.currency) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? fallback
}

/**
 * The categories the statement dialog suggests, by label, when the ledger has them: Bank fees for a service charge;
 * Interest for interest earned, and Interest paid (else Bank fees) for interest a liability charges.
 */
export function chargeCategories(categories: Category[], liability: boolean): ReconcileDialogInput['defaultCategories'] {
  const named = (...labels: string[]) => {
    for (const label of labels) {
      const found = categories.find(c => accountNameKey(categoryLabel(categories, c.id) ?? '') === accountNameKey(label))
      if (found) return found.id
    }
    return undefined
  }
  const serviceCharge = named('Bank fees')
  const interest = liability ? named('Interest paid', 'Bank fees') : named('Interest')
  return { ...(serviceCharge && { serviceCharge }), ...(interest && { interest }) }
}

export function registerCommands(
  context: PluginContext,
  service: AccountsServiceImpl,
  selection: SelectionState,
  register: RegisterState,
  prompts: ShellPrompts
): Disposable[] {
  const attempt = async <T>(doing: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work()
    } catch (err) {
      if (!isAccountsError(err)) context.logger.error(`[accounts] ${doing} failed`, err)
      await prompts.message({ kind: 'error', message: `Could not ${doing}.`, detail: err instanceof Error ? err.message : String(err) })
      return undefined
    }
  }

  /** The account a command acts on: the argument's, else the selected one. */
  const targetAccount = async (args: unknown): Promise<Account | undefined> => {
    const explicit = (args as ItemArgs | undefined)?.id
    const current = selection.get()
    const id = explicit ?? (current.kind === 'account' ? current.id : undefined)
    return id === undefined ? undefined : service.get(id)
  }
  const targetSubLedger = (args: unknown): string | undefined => {
    const explicit = (args as ItemArgs | undefined)?.id
    const current = selection.get()
    return explicit ?? (current.kind === 'subLedger' ? current.id : undefined)
  }

  const dialogBasics = async () => {
    const chart = await service.chart()
    return { chart, basics: { subLedgers: chart.subLedgers, ledgerName: chart.ledger.name, defaultCurrency: usualCurrency(chart) } }
  }

  const reveal = async (viewId: string) => {
    if (context.commands.has('shell.layout.reveal')) await context.commands.execute('shell.layout.reveal', viewId).catch(() => undefined)
  }

  return [
    context.commands.register(ACCOUNTS_COMMANDS.newAccount, async (args?: unknown) => {
      const requested = (args as NewAccountArgs | undefined)?.subLedgerId
      const { basics } = await dialogBasics()
      const subLedgerId = requested !== undefined && (requested === null || basics.subLedgers.some(s => s.id === requested))
        ? requested : await selection.targetSubLedger()
      const input: AccountDialogInput = { ...basics, mode: 'create', subLedgerId }
      const created = await prompts.show<{ id: string }>(ACCOUNTS_DIALOGS.account, input)
      if (created) {
        await selection.set({ kind: 'account', id: created.id }, { announce: true })
        await reveal(ACCOUNTS_VIEWS.navigator)
      }
      return created
    }, { enablement: WRITABLE }),

    context.commands.register(ACCOUNTS_COMMANDS.editAccount, async (args?: unknown) => {
      const account = await targetAccount(args)
      if (!account) return undefined
      if (account.closed) {
        await prompts.message({ message: `“${account.name}” is closed.`, detail: 'Reopen it to change it.' })
        return undefined
      }
      const { basics } = await dialogBasics()
      const input: AccountDialogInput = { ...basics, mode: 'edit', account }
      return prompts.show<{ id: string }>(ACCOUNTS_DIALOGS.account, input, { title: 'Edit Account' })
    }, { enablement: `${ACCOUNT} && !${K.selectionIsClosed}` }),

    context.commands.register(ACCOUNTS_COMMANDS.closeAccount, async (args?: unknown) => {
      const account = await targetAccount(args)
      if (!account || account.closed) return false
      const { current } = await service.balances(account.id)
      const confirmed = await prompts.confirm({
        message: `Close account “${account.name}”?`,
        detail: [
          ...(current !== 0 ? [`Its balance is ${formatAmount(current, account.currency)}, not zero.`] : []),
          'A closed account can’t be changed, and is hidden unless you show closed accounts. Its history stays, it still counts in totals, and you can reopen it.'
        ].join(' '),
        confirmLabel: 'Close Account'
      })
      if (!confirmed) return false
      const closed = await attempt('close the account', () => service.closeAccount(account.id, current !== 0 ? { confirm: ['closeWithBalance'] } : {}))
      if (closed) await selection.refresh()
      return closed !== undefined
    }, { enablement: `${ACCOUNT} && !${K.selectionIsClosed}` }),

    context.commands.register(ACCOUNTS_COMMANDS.reopenAccount, async (args?: unknown) => {
      const account = await targetAccount(args)
      if (!account || !account.closed) return false
      const reopened = await attempt('reopen the account', () => service.reopenAccount(account.id))
      if (reopened) await selection.refresh()
      return reopened !== undefined
    }, { enablement: `${ACCOUNT} && ${K.selectionIsClosed}` }),

    context.commands.register(ACCOUNTS_COMMANDS.deleteAccount, async (args?: unknown) => {
      const account = await targetAccount(args)
      if (!account) return false
      const { transactionCount } = await service.balances(account.id)
      const confirmed = await prompts.confirm({
        message: `Delete account “${account.name}”?`,
        detail: [
          transactionCount === 0 ? 'It has no transactions.' : `Its ${transactionCount} transaction${transactionCount === 1 ? '' : 's'} will be deleted with it; transfers stay in the other accounts.`,
          'This can’t be undone. To keep its history, close it instead.'
        ].join(' '),
        confirmLabel: 'Delete',
        destructive: true
      })
      if (!confirmed) return false
      const deleted = await attempt('delete the account', async () => { await service.deleteAccount(account.id); return true })
      if (deleted) await selection.set({ kind: 'ledger' }, { announce: true })
      return deleted ?? false
    }, { enablement: ACCOUNT }),

    // ---- Sub-ledgers: the ledger's commands, with the selection as their argument

    context.commands.register(ACCOUNTS_COMMANDS.newSubLedger, async () => {
      const parentId = await selection.targetSubLedger()
      const result = await context.commands.execute(LEDGER_COMMANDS.new, { parentId }) as { kind?: string, id?: string } | undefined
      if (result?.kind === 'subLedger' && result.id) await selection.set({ kind: 'subLedger', id: result.id }, { announce: true })
      return result
    }, { enablement: WRITABLE }),

    context.commands.register(ACCOUNTS_COMMANDS.renameSubLedger, async (args?: unknown) => {
      const id = targetSubLedger(args)
      return id === undefined ? undefined : context.commands.execute(LEDGER_COMMANDS.renameSubLedger, { id })
    }, { enablement: SUB_LEDGER }),

    context.commands.register(ACCOUNTS_COMMANDS.deleteSubLedger, async (args?: unknown) => {
      const id = targetSubLedger(args)
      if (id === undefined) return false
      const deleted = await context.commands.execute(LEDGER_COMMANDS.deleteSubLedger, { id })
      if (deleted) await selection.set({ kind: 'ledger' }, { announce: true })
      return deleted
    }, { enablement: SUB_LEDGER }),

    context.commands.register(ACCOUNTS_COMMANDS.move, async (args?: unknown) => {
      const explicit = (args as ItemArgs & { kind?: 'account' | 'subLedger' } | undefined)
      const current = selection.get()
      const kind = explicit?.kind ?? (current.kind === 'ledger' ? undefined : current.kind)
      const id = explicit?.id ?? (current.kind === 'ledger' ? undefined : current.id)
      if (!kind || !id) return undefined

      const { chart, basics } = await dialogBasics()
      let item: MoveDialogInput['item'] | undefined
      if (kind === 'account') {
        const account = chart.accounts.find(s => s.account.id === id)?.account
        if (account) item = { kind, id, name: account.name, parentId: account.subLedgerId }
      } else {
        const sub = chart.subLedgers.find(s => s.id === id)
        if (sub) item = { kind, id, name: sub.name, parentId: sub.parentId }
      }
      if (!item) return undefined
      const input: MoveDialogInput = { item, subLedgers: basics.subLedgers, ledgerName: basics.ledgerName }
      return prompts.show<{ to: string | null }>(ACCOUNTS_DIALOGS.move, input, { title: `Move “${item.name}”` })
    }, { enablement: `${WRITABLE} && (${K.selectionKind} == 'account' || ${K.selectionKind} == 'subLedger')` }),

    context.commands.register(ACCOUNTS_COMMANDS.open, () => reveal(ACCOUNTS_VIEWS.navigator), { enablement: LEDGER_CONTEXT_KEYS.isOpen }),

    // ---- The register

    context.commands.register(ACCOUNTS_COMMANDS.showRegister, async (args?: unknown) => {
      const account = await targetAccount(args)
      if (!account) return false
      await register.show(account.id)
      await reveal(ACCOUNTS_VIEWS.register)
      return true
    }, { enablement: ACCOUNT_OR_REGISTER }),

    context.commands.register(ACCOUNTS_COMMANDS.reconcileStatement, async (args?: unknown) => {
      const accountId = (args as ReconcileActionArgs | undefined)?.accountId ?? register.get()
      const account = accountId === undefined ? undefined : await service.get(accountId)
      if (!account) return false
      if (account.closed) {
        await prompts.message({ message: `“${account.name}” is closed.`, detail: 'Reopen it to reconcile it.' })
        return false
      }
      const current = await service.reconciliation.get(account.id)
      const { reconciled } = await service.balances(account.id)
      const categories = await service.categories.list()
      const input: ReconcileDialogInput = {
        account,
        lastReconciled: { balance: reconciled, ...(account.lastReconciled && { date: account.lastReconciled.date }) },
        ...(current && { current: current.reconciliation }),
        categories,
        defaultCategories: chargeCategories(categories, isLiability(account.type))
      }
      const figures = await prompts.show<StatementInput>(ACCOUNTS_DIALOGS.reconcile, input,
        current ? { title: 'Resume Reconciliation' } : {})
      if (!figures) return false
      const begun = await attempt('start reconciling', () => service.reconciliation.begin(account.id, { ...figures, reconcilerId: STATEMENT_RECONCILER }))
      if (!begun) return false
      await register.show(account.id)
      await register.refresh()
      await reveal(ACCOUNTS_VIEWS.register)
      await reveal(ACCOUNTS_VIEWS.reconcile)
      return true
    }, { enablement: K.registerEditable }),

    context.commands.register(ACCOUNTS_COMMANDS.newTransaction, async () => {
      await reveal(ACCOUNTS_VIEWS.register)
      context.events.emit(local(ACCOUNTS_EVENTS.newTransaction), {})
    }, { enablement: K.registerEditable })
  ]
}
